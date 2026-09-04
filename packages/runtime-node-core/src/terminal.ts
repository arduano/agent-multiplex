import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { createRequire } from "node:module";

import {
  TERMINAL_MAX_FRAME_BYTES,
  TERMINAL_MAX_SCREEN_BYTES,
  newTerminalId,
  newTerminalLeaseId,
  type AdapterScopeId,
  type Harness,
  type RuntimeNodeBootId,
  type SessionId,
  type TerminalAttachInput,
  type TerminalDescriptor,
  type TerminalDimensions,
  type TerminalInput,
  type TerminalInputResult,
  type TerminalLeaseAcquireInput,
  type TerminalLeaseAcquireResult,
  type TerminalLeaseReleaseInput,
  type TerminalLeaseReleaseResult,
  type TerminalLeaseRenewInput,
  type TerminalLeaseRenewResult,
  type TerminalOpenInput,
  type TerminalOpenResult,
  type TerminalStreamItem,
  type TerminalTarget,
  type TerminalTerminateInput,
} from "@arduano/agent-multiplex-protocol";
import type { IPty } from "node-pty";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";

const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminalConstructor } = require("@xterm/headless") as {
  Terminal: typeof import("@xterm/headless").Terminal;
};
const { SerializeAddon } = require("@xterm/addon-serialize") as {
  SerializeAddon: new () => {
    serialize(options?: { scrollback?: number }): string;
    dispose(): void;
  };
};

const DEFAULT_DIMENSIONS = { columns: 100, rows: 30 } as const;
const DEFAULT_REPLAY_ITEMS = 4_096;
const DEFAULT_REPLAY_BYTES = 1_024 * 1_024;
const DEFAULT_SUBSCRIBER_ITEMS = 512;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_LEASE_TTL_MS = 15_000;
const DEFAULT_TERMINAL_LIMIT = 32;
const INPUT_RECEIPT_LIMIT = 1_024;
const ACQUIRE_RECEIPT_LIMIT = 4_096;
const STARTUP_OUTPUT_LIMIT = TERMINAL_MAX_SCREEN_BYTES;

const now = (): string => new Date().toISOString();

export class TerminalBrokerError extends Error {
  public constructor(
    public readonly code: "NOT_FOUND" | "CONFLICT" | "FENCED" | "UNSUPPORTED" | "RESOURCE_EXHAUSTED",
    message: string,
  ) {
    super(message);
    this.name = "TerminalBrokerError";
  }
}

export class TerminalSubscriberOverflowError extends Error {
  public constructor(public readonly capacity: number) {
    super(`terminal subscriber exceeded its ${capacity}-item buffer`);
    this.name = "TerminalSubscriberOverflowError";
  }
}

export interface TerminalProcessExit {
  exitCode: number | null;
  signal: number | null;
  message?: string;
}

/** Opaque native PTY. The broker never interprets output as agent history. */
export interface TerminalProcess {
  onData(listener: (data: string) => void): () => void;
  onExit(listener: (exit: TerminalProcessExit) => void): () => void;
  write(data: string): void;
  resize(dimensions: TerminalDimensions): void;
  kill(): void;
}

export interface TerminalProviderOpenRequest {
  readonly target: TerminalTarget;
  readonly harness: Harness;
  readonly adapterScopeId: AdapterScopeId;
  readonly vendorSessionId: string;
  readonly cwd: string;
  readonly dimensions: TerminalDimensions;
  readonly foregroundSwitch: boolean;
}

/** Harness-specific process creation, deliberately separate from AgentAdapter. */
export interface TerminalProvider {
  readonly harness: Harness;
  readonly adapterScopeId: AdapterScopeId;
  readonly backend: TerminalDescriptor["backend"];
  readonly sharing: TerminalDescriptor["sharing"];
  readonly capabilities: TerminalDescriptor["capabilities"];
  open(request: TerminalProviderOpenRequest): Promise<TerminalProcess>;
  close(): Promise<void>;
}

export interface TerminalBinding {
  readonly target: TerminalTarget;
  readonly harness: Harness;
  readonly adapterScopeId: AdapterScopeId;
  readonly vendorSessionId: string;
  readonly cwd: string;
}

export interface TerminalBrokerOptions {
  runtimeNodeBootId: RuntimeNodeBootId;
  providers?: readonly TerminalProvider[];
  maxRunningTerminals?: number;
  replayItemLimit?: number;
  replayByteLimit?: number;
  subscriberItemLimit?: number;
  heartbeatMs?: number;
  leaseTtlMs?: number;
}

interface LeaseState {
  summary: NonNullable<TerminalDescriptor["lease"]>;
  tokenHash: string;
  nextInputSequence: number;
  receipts: Map<number, { hash: string; result: TerminalInputResult }>;
  expiryTimer: ReturnType<typeof setTimeout>;
}

interface AcquireReceipt {
  fingerprint: string;
  lease: TerminalLeaseAcquireResult["lease"];
  terminalLeaseId: TerminalLeaseAcquireResult["credential"]["terminalLeaseId"];
  nextInputSequence: number;
}

interface ReplayEntry {
  item: TerminalStreamItem;
  bytes: number;
}

interface Subscriber {
  queue: AsyncQueue<TerminalStreamItem>;
  close(): void;
}

class ManagedTerminal {
  readonly terminalId = newTerminalId();
  readonly openedAt = now();
  readonly replay: ReplayEntry[] = [];
  readonly subscribers = new Set<Subscriber>();
  readonly emulator: HeadlessTerminal;
  readonly serializer: { serialize(options?: { scrollback?: number }): string; dispose(): void };
  readonly disposeData: () => void;
  readonly disposeExit: () => void;
  state: TerminalDescriptor["state"] = "running";
  updatedAt = this.openedAt;
  dimensions: TerminalDimensions;
  sequence = 0;
  replayBytes = 0;
  lastOutputSequence = 0;
  emulatorSequence = 0;
  readonly emulatorWaiters: Array<{ sequence: number; resolve(): void }> = [];
  disposed = false;
  lease: LeaseState | undefined;
  exit: TerminalDescriptor["exit"] = null;

  public constructor(
    readonly binding: TerminalBinding,
    readonly provider: TerminalProvider,
    readonly process: TerminalProcess,
    dimensions: TerminalDimensions,
    readonly limits: {
      replayItems: number;
      replayBytes: number;
      subscriberItems: number;
      heartbeatMs: number;
      leaseTtlMs: number;
    },
    readonly runtimeNodeBootId: RuntimeNodeBootId,
  ) {
    this.dimensions = { ...dimensions };
    this.emulator = new HeadlessTerminalConstructor({
      cols: dimensions.columns,
      rows: dimensions.rows,
      scrollback: 1_000,
      allowProposedApi: true,
      logLevel: "off",
    });
    this.serializer = new SerializeAddon();
    // The serialize add-on supports the headless terminal at runtime. Its
    // published declaration names the browser Terminal class, which is a
    // packaging-only type mismatch between the two official xterm packages.
    this.emulator.loadAddon(this.serializer as never);
    this.disposeData = process.onData((data) => this.acceptOutput(data));
    this.disposeExit = process.onExit((exit) => this.didExit(exit));
  }

  public descriptor(): TerminalDescriptor {
    return {
      ...this.binding.target,
      runtimeNodeBootId: this.runtimeNodeBootId,
      terminalId: this.terminalId,
      backend: this.provider.backend,
      sharing: this.provider.sharing,
      foregroundSessionId:
        this.provider.sharing === "adapterScope" ? this.binding.target.sessionId : null,
      state: this.state,
      dimensions: this.dimensions,
      sequence: this.sequence,
      lease: this.lease?.summary ?? null,
      capabilities: this.provider.capabilities,
      openedAt: this.openedAt,
      updatedAt: this.updatedAt,
      exit: this.exit,
    };
  }

  public acceptOutput(data: string): void {
    if (this.state !== "running" || data.length === 0) return;
    const bytes = Buffer.from(data, "utf8");
    for (let offset = 0; offset < bytes.byteLength; offset += TERMINAL_MAX_FRAME_BYTES) {
      const frame = bytes.subarray(offset, offset + TERMINAL_MAX_FRAME_BYTES);
      this.updatedAt = now();
      const sequence = ++this.sequence;
      this.lastOutputSequence = sequence;
      // xterm accepts bytes and therefore preserves frame boundaries even if
      // node-pty split a multi-byte code point across callbacks. Parsing is
      // asynchronous in xterm 6, so reset snapshots explicitly wait for this
      // sequence instead of reaching into xterm's private writeSync API.
      this.emulator.write(frame, () => this.didParse(sequence));
      const item: TerminalStreamItem = {
        kind: "output",
        cursor: { terminalId: this.terminalId, sequence },
        dataBase64: frame.toString("base64"),
      };
      this.publish(item, frame.byteLength);
    }
  }

  public changed(): void {
    this.updatedAt = now();
    const sequence = ++this.sequence;
    const item: TerminalStreamItem = {
      kind: "changed",
      cursor: { terminalId: this.terminalId, sequence },
      terminal: { ...this.descriptor(), sequence },
    };
    this.publish(item, 256);
  }

  public resetItem(
    reason: Extract<TerminalStreamItem, { kind: "reset" }>["reason"],
  ): TerminalStreamItem {
    // Descriptor construction is deliberately side-effect free. Settle a
    // just-expired lease before capturing one coherent reset cursor and
    // descriptor so an expiry cannot recursively publish sequence N+1 while
    // this reset still advertises sequence N.
    this.expireLeaseIfNeeded();
    const sequence = this.sequence;
    const screen = boundedScreenSnapshot(this.serializer.serialize({ scrollback: 1_000 }));
    return {
      kind: "reset",
      reason,
      cursor: { terminalId: this.terminalId, sequence },
      screenBase64: screen.toString("base64"),
      terminal: { ...this.descriptor(), sequence },
    };
  }

  public waitForEmulator(sequence: number): Promise<void> {
    if (this.disposed || this.emulatorSequence >= sequence) return Promise.resolve();
    return new Promise((resolve) => this.emulatorWaiters.push({ sequence, resolve }));
  }

  public retire(
    exit: TerminalProcessExit,
    kill: boolean,
    state: Extract<TerminalDescriptor["state"], "exited" | "error"> = "exited",
  ): void {
    if (this.state === "exited" || this.state === "error") return;
    this.state = state;
    this.exit = exit;
    this.clearLease(false);
    this.changed();
    this.disposeData();
    this.disposeExit();
    for (const subscriber of [...this.subscribers]) subscriber.close();
    // Dispose the exit callback before signalling the child. Some PTY
    // implementations report exit synchronously from kill().
    if (kill) this.process.kill();
  }

  public clearLease(emit = true): void {
    if (!this.lease) return;
    clearTimeout(this.lease.expiryTimer);
    this.lease = undefined;
    if (emit) this.changed();
  }

  public expireLeaseIfNeeded(): void {
    if (this.lease && Date.parse(this.lease.summary.expiresAt) <= Date.now()) {
      this.clearLease();
    }
  }

  private didExit(exit: TerminalProcessExit): void {
    this.retire(exit, false);
  }

  private publish(item: TerminalStreamItem, bytes: number): void {
    this.replay.push({ item, bytes });
    this.replayBytes += bytes;
    while (
      this.replay.length > this.limits.replayItems ||
      this.replayBytes > this.limits.replayBytes
    ) {
      const removed = this.replay.shift();
      if (!removed) break;
      this.replayBytes -= removed.bytes;
    }
    for (const subscriber of this.subscribers) subscriber.queue.push(item);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearLease(false);
    this.disposeData();
    this.disposeExit();
    this.serializer.dispose();
    this.emulator.dispose();
    for (const waiter of this.emulatorWaiters.splice(0)) waiter.resolve();
    for (const subscriber of [...this.subscribers]) subscriber.close();
  }

  private didParse(sequence: number): void {
    this.emulatorSequence = Math.max(this.emulatorSequence, sequence);
    for (let index = this.emulatorWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.emulatorWaiters[index]!;
      if (waiter.sequence > this.emulatorSequence) continue;
      this.emulatorWaiters.splice(index, 1);
      waiter.resolve();
    }
  }
}

export class TerminalBroker {
  readonly #runtimeNodeBootId: RuntimeNodeBootId;
  readonly #providers = new Map<string, TerminalProvider>();
  readonly #bySession = new Map<SessionId, ManagedTerminal>();
  readonly #byScope = new Map<string, ManagedTerminal>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #acquireReceipts = new Map<string, AcquireReceipt>();
  readonly #leaseTokenSecret = randomBytes(32);
  readonly #maxRunningTerminals: number;
  readonly #limits: ManagedTerminal["limits"];
  #pendingProcessOpens = 0;
  #closed = false;

  public constructor(options: TerminalBrokerOptions) {
    this.#runtimeNodeBootId = options.runtimeNodeBootId;
    this.#maxRunningTerminals = positiveInteger(
      options.maxRunningTerminals ?? DEFAULT_TERMINAL_LIMIT,
      "maxRunningTerminals",
    );
    this.#limits = {
      replayItems: positiveInteger(options.replayItemLimit ?? DEFAULT_REPLAY_ITEMS, "replayItemLimit"),
      replayBytes: positiveInteger(options.replayByteLimit ?? DEFAULT_REPLAY_BYTES, "replayByteLimit"),
      subscriberItems: positiveInteger(
        options.subscriberItemLimit ?? DEFAULT_SUBSCRIBER_ITEMS,
        "subscriberItemLimit",
      ),
      heartbeatMs: positiveInteger(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, "heartbeatMs"),
      leaseTtlMs: positiveInteger(options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS, "leaseTtlMs"),
    };
    for (const provider of options.providers ?? []) {
      const key = providerKey(provider.harness, provider.adapterScopeId);
      if (this.#providers.has(key)) {
        throw new TerminalBrokerError("CONFLICT", `duplicate terminal provider for ${key}`);
      }
      this.#providers.set(key, provider);
    }
  }

  public hasProvider(harness: Harness, adapterScopeId: AdapterScopeId): boolean {
    return this.#providers.has(providerKey(harness, adapterScopeId));
  }

  public providerBackend(
    harness: Harness,
    adapterScopeId: AdapterScopeId,
  ): TerminalDescriptor["backend"] | undefined {
    return this.#providers.get(providerKey(harness, adapterScopeId))?.backend;
  }

  public get(target: TerminalTarget): TerminalDescriptor | null {
    const terminal = this.#bySession.get(target.sessionId);
    if (!terminal) return null;
    this.#assertTarget(terminal, target);
    terminal.expireLeaseIfNeeded();
    return terminal.descriptor();
  }

  public async open(binding: TerminalBinding, input: TerminalOpenInput): Promise<TerminalOpenResult> {
    this.assertOpen();
    const provider = this.#provider(binding);
    const lockKey = provider.sharing === "adapterScope"
      ? `scope:${providerKey(provider.harness, provider.adapterScopeId)}`
      : `session:${binding.target.sessionId}`;
    return this.#serialize(lockKey, async () => {
      this.assertOpen();
      const current = this.#bySession.get(binding.target.sessionId);
      current?.expireLeaseIfNeeded();
      if (current?.state === "running") return { status: "opened", terminal: current.descriptor() };
      if (current) {
        if (input.expectedTerminalId === undefined) {
          return { status: "confirmationRequired", reason: "restart", terminal: current.descriptor() };
        }
        if (input.expectedTerminalId !== current.terminalId) {
          throw new TerminalBrokerError("FENCED", "terminal restart targets a stale terminal ID");
        }
        if (!provider.capabilities.restart) {
          throw new TerminalBrokerError("UNSUPPORTED", "this terminal backend cannot be restarted");
        }
      }

      const scopeKey = providerKey(provider.harness, provider.adapterScopeId);
      const foreground = provider.sharing === "adapterScope" ? this.#byScope.get(scopeKey) : undefined;
      foreground?.expireLeaseIfNeeded();
      if (foreground && foreground.binding.target.sessionId !== binding.target.sessionId) {
        if (!input.confirmForegroundSwitch) {
          return {
            status: "confirmationRequired",
            reason: "foregroundSwitch",
            terminal: foreground.descriptor(),
          };
        }
        if (input.expectedTerminalId !== foreground.terminalId) {
          throw new TerminalBrokerError(
            "FENCED",
            "foreground switch requires the exact terminal ID that was confirmed",
          );
        }
      } else if (!current && input.expectedTerminalId !== undefined) {
        // expectedTerminalId normally confirms a restart. The only valid
        // cross-session exception is the adapter-scoped foreground checked
        // above; do not mistake that confirmation token for a stale restart.
        throw new TerminalBrokerError("FENCED", "terminal restart target no longer exists");
      }

      const reservesProcess = foreground === undefined;
      if (
        reservesProcess &&
        this.runningCount() + this.#pendingProcessOpens >= this.#maxRunningTerminals
      ) {
        throw new TerminalBrokerError(
          "RESOURCE_EXHAUSTED",
          `runtime node already has ${this.#maxRunningTerminals} running terminals`,
        );
      }
      const dimensions = input.dimensions ?? current?.dimensions ?? foreground?.dimensions ?? DEFAULT_DIMENSIONS;
      if (reservesProcess) this.#pendingProcessOpens += 1;
      let process: TerminalProcess;
      try {
        process = await provider.open({
          ...binding,
          dimensions,
          foregroundSwitch: foreground !== undefined,
        });
      } finally {
        if (reservesProcess) this.#pendingProcessOpens -= 1;
      }
      if (this.#closed) {
        if (provider.capabilities.terminate) process.kill();
        throw new TerminalBrokerError(
          "CONFLICT",
          "terminal broker closed while the native terminal was opening",
        );
      }
      if (foreground) {
        foreground.retire(
          { exitCode: null, signal: null, message: "terminal foreground moved to another session" },
          false,
          "exited",
        );
        this.#bySession.delete(foreground.binding.target.sessionId);
        // Adapter-scoped providers reuse one native process, but each logical
        // foreground owns a separate emulator and serializer. Retiring closes
        // its public stream; disposal releases those private screen resources
        // before the shared PTY is attached to the replacement foreground.
        foreground.dispose();
      }
      current?.dispose();
      const terminal = new ManagedTerminal(
        binding,
        provider,
        process,
        dimensions,
        this.#limits,
        this.#runtimeNodeBootId,
      );
      this.#bySession.set(binding.target.sessionId, terminal);
      if (provider.sharing === "adapterScope") this.#byScope.set(scopeKey, terminal);
      return { status: "opened", terminal: terminal.descriptor() };
    });
  }

  public attach(input: TerminalAttachInput, signal?: AbortSignal): AsyncIterable<TerminalStreamItem> {
    const terminal = this.#terminal(input);
    terminal.expireLeaseIfNeeded();
    const queue = new AsyncQueue<TerminalStreamItem>(
      terminal.limits.subscriberItems,
      () => close(new TerminalSubscriberOverflowError(terminal.limits.subscriberItems)),
    );
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let closed = false;
    const subscriber: Subscriber = {
      queue,
      close: () => close(),
    };
    const close = (failure?: unknown): void => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      terminal.subscribers.delete(subscriber);
      signal?.removeEventListener("abort", abort);
      queue.close(failure);
    };
    const abort = (): void => close();
    if (signal?.aborted) {
      close();
      return queueIterable(queue);
    }

    const subscribe = (): void => {
      if (closed || queue.closed || terminal.disposed) {
        close();
        return;
      }
      terminal.subscribers.add(subscriber);
      heartbeat = setInterval(() => {
        terminal.expireLeaseIfNeeded();
        queue.push({
          kind: "heartbeat",
          cursor: { terminalId: terminal.terminalId, sequence: terminal.sequence },
        });
      }, terminal.limits.heartbeatMs);
      heartbeat.unref();
      signal?.addEventListener("abort", abort, { once: true });
    };
    const wanted = input.cursor?.sequence;
    const first = terminal.replay[0]?.item.cursor.sequence;
    const resetReason = wanted === undefined
      ? "initial" as const
      : wanted > terminal.sequence
        ? "cursorAhead" as const
        : wanted < terminal.sequence &&
            (first === undefined || wanted + 1 < first)
          ? "cursorExpired" as const
          : undefined;
    if (resetReason) {
      // Wait until every byte accepted so far is represented by the screen.
      // New PTY callbacks cannot interleave between the final check, snapshot,
      // and subscription below because that continuation is synchronous.
      // Control-only changes need no parser callback and are incorporated in
      // the descriptor at the reset's current stream sequence.
      const reset = async (): Promise<void> => {
        while (!terminal.disposed) {
          const wantedOutput = terminal.lastOutputSequence;
          await terminal.waitForEmulator(wantedOutput);
          if (terminal.lastOutputSequence === wantedOutput) break;
        }
        if (terminal.disposed) {
          close();
          return;
        }
        queue.push(terminal.resetItem(resetReason));
        subscribe();
      };
      void reset().catch(close);
    } else {
      for (const entry of terminal.replay) {
        if (wanted !== undefined && entry.item.cursor.sequence > wanted) queue.push(entry.item);
      }
      subscribe();
    }
    return queueIterable(queue, close);
  }

  public acquire(input: TerminalLeaseAcquireInput): TerminalLeaseAcquireResult {
    const fingerprint = acquisitionFingerprint(input);
    const prior = this.#acquireReceipts.get(input.requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new TerminalBrokerError(
          "CONFLICT",
          "terminal lease request ID was reused with another acquisition payload",
        );
      }
      return this.#acquireResult(input.requestId, prior);
    }
    const terminal = this.#terminal(input);
    this.#assertRunningWritable(terminal);
    terminal.expireLeaseIfNeeded();
    if (terminal.lease) {
      if (input.forceTerminalLeaseId !== terminal.lease.summary.terminalLeaseId) {
        throw new TerminalBrokerError("CONFLICT", "terminal keyboard is already leased");
      }
      terminal.clearLease(false);
    } else if (input.forceTerminalLeaseId !== undefined) {
      throw new TerminalBrokerError("FENCED", "terminal keyboard lease changed before takeover");
    }
    const token = this.#leaseToken(input.requestId);
    const terminalLeaseId = newTerminalLeaseId();
    const summary = {
      terminalLeaseId,
      terminalClientId: input.terminalClientId,
      expiresAt: new Date(Date.now() + terminal.limits.leaseTtlMs).toISOString(),
    };
    const expiryTimer = setTimeout(() => {
      if (terminal.lease?.summary.terminalLeaseId === terminalLeaseId) terminal.clearLease();
    }, terminal.limits.leaseTtlMs + 1);
    expiryTimer.unref();
    terminal.lease = {
      summary,
      tokenHash: secretHash(token),
      nextInputSequence: 0,
      receipts: new Map(),
      expiryTimer,
    };
    terminal.changed();
    const result = {
      lease: summary,
      credential: { terminalLeaseId, token },
      nextInputSequence: 0,
    } satisfies TerminalLeaseAcquireResult;
    this.#acquireReceipts.set(input.requestId, {
      fingerprint,
      lease: summary,
      terminalLeaseId,
      nextInputSequence: 0,
    });
    while (this.#acquireReceipts.size > ACQUIRE_RECEIPT_LIMIT) {
      const oldest = this.#acquireReceipts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#acquireReceipts.delete(oldest);
    }
    return result;
  }

  public renew(input: TerminalLeaseRenewInput): TerminalLeaseRenewResult {
    const terminal = this.#terminal(input);
    const lease = this.#lease(terminal, input);
    clearTimeout(lease.expiryTimer);
    lease.summary = {
      ...lease.summary,
      expiresAt: new Date(Date.now() + terminal.limits.leaseTtlMs).toISOString(),
    };
    lease.expiryTimer = setTimeout(() => {
      if (terminal.lease === lease) terminal.clearLease();
    }, terminal.limits.leaseTtlMs + 1);
    lease.expiryTimer.unref();
    terminal.changed();
    return { lease: lease.summary, nextInputSequence: lease.nextInputSequence };
  }

  public release(input: TerminalLeaseReleaseInput): TerminalLeaseReleaseResult {
    const terminal = this.#terminal(input);
    this.#lease(terminal, input);
    terminal.clearLease();
    return { released: true };
  }

  public input(input: TerminalInput): TerminalInputResult {
    const terminal = this.#terminal(input);
    this.#assertRunningWritable(terminal);
    const lease = this.#lease(terminal, input);
    if (input.kind === "write" && typeof input.dataBase64 !== "string") {
      throw new TypeError("terminal write data must be a base64 string");
    }
    const payloadHash = inputHash(input);
    if (input.inputSequence < lease.nextInputSequence) {
      const receipt = lease.receipts.get(input.inputSequence);
      if (!receipt || receipt.hash !== payloadHash) {
        throw new TerminalBrokerError("CONFLICT", "terminal input sequence was reused with another payload");
      }
      return receipt.result;
    }
    if (input.inputSequence > lease.nextInputSequence) {
      throw new TerminalBrokerError(
        "CONFLICT",
        `terminal input sequence gap; expected ${lease.nextInputSequence}`,
      );
    }
    if (input.kind === "write") {
      const data = Buffer.from(input.dataBase64, "base64");
      if (!isUtf8(data)) {
        throw new TypeError("terminal write data must be valid UTF-8 text");
      }
      terminal.process.write(data.toString("utf8"));
    } else {
      if (!terminal.provider.capabilities.resize) {
        throw new TerminalBrokerError("UNSUPPORTED", "this terminal backend cannot be resized");
      }
      terminal.process.resize(input.dimensions);
      terminal.emulator.resize(input.dimensions.columns, input.dimensions.rows);
      terminal.dimensions = { ...input.dimensions };
      terminal.changed();
    }
    const result = {
      terminalId: terminal.terminalId,
      inputSequence: input.inputSequence,
      acceptedAt: now(),
    } satisfies TerminalInputResult;
    lease.receipts.set(input.inputSequence, { hash: payloadHash, result });
    lease.nextInputSequence += 1;
    while (lease.receipts.size > INPUT_RECEIPT_LIMIT) {
      const oldest = lease.receipts.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      lease.receipts.delete(oldest);
    }
    return result;
  }

  public terminate(input: TerminalTerminateInput): TerminalDescriptor {
    const terminal = this.#terminal(input);
    if (input.expectedTerminalId !== terminal.terminalId) {
      throw new TerminalBrokerError("FENCED", "terminal termination targets a stale terminal ID");
    }
    if (!terminal.provider.capabilities.terminate) {
      throw new TerminalBrokerError("UNSUPPORTED", "this terminal backend cannot be terminated");
    }
    terminal.retire({ exitCode: null, signal: null }, true);
    return terminal.descriptor();
  }

  public invalidateSession(sessionId: SessionId, reason: string): void {
    const terminal = this.#bySession.get(sessionId);
    if (!terminal) return;
    terminal.retire({ exitCode: null, signal: null, message: reason }, terminal.provider.capabilities.terminate);
    this.#bySession.delete(sessionId);
    const scopeKey = providerKey(terminal.provider.harness, terminal.provider.adapterScopeId);
    if (this.#byScope.get(scopeKey) === terminal) this.#byScope.delete(scopeKey);
    terminal.dispose();
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const processes = new Set<TerminalProcess>();
    for (const terminal of this.#bySession.values()) {
      if (terminal.provider.capabilities.terminate) processes.add(terminal.process);
      terminal.dispose();
    }
    for (const process of processes) process.kill();
    this.#bySession.clear();
    this.#byScope.clear();
    this.#acquireReceipts.clear();
    await Promise.allSettled([...this.#providers.values()].map((provider) => provider.close()));
  }

  #provider(binding: TerminalBinding): TerminalProvider {
    const provider = this.#providers.get(providerKey(binding.harness, binding.adapterScopeId));
    if (!provider) {
      throw new TerminalBrokerError(
        "UNSUPPORTED",
        `${binding.harness} does not expose a managed terminal in adapter scope ${binding.adapterScopeId}`,
      );
    }
    return provider;
  }

  #terminal(input: TerminalTarget & { terminalId: string }): ManagedTerminal {
    const terminal = this.#bySession.get(input.sessionId);
    if (!terminal) throw new TerminalBrokerError("NOT_FOUND", "managed terminal not found");
    if (terminal.terminalId !== input.terminalId) {
      throw new TerminalBrokerError("FENCED", "terminal ID was replaced");
    }
    this.#assertTarget(terminal, input);
    return terminal;
  }

  #assertTarget(terminal: ManagedTerminal, target: TerminalTarget): void {
    const bound = terminal.binding.target;
    if (
      bound.runtimeNodeId !== target.runtimeNodeId ||
      bound.bindingRevision !== target.bindingRevision ||
      bound.sessionId !== target.sessionId
    ) {
      throw new TerminalBrokerError("FENCED", "terminal session binding was replaced");
    }
  }

  #lease(
    terminal: ManagedTerminal,
    input: {
      terminalClientId: string;
      credential: { terminalLeaseId: string; token: string };
    },
  ): LeaseState {
    terminal.expireLeaseIfNeeded();
    const lease = terminal.lease;
    if (!lease) throw new TerminalBrokerError("FENCED", "terminal keyboard lease is absent or expired");
    if (
      lease.summary.terminalLeaseId !== input.credential.terminalLeaseId ||
      lease.summary.terminalClientId !== input.terminalClientId ||
      !safeHashEqual(lease.tokenHash, secretHash(input.credential.token))
    ) {
      throw new TerminalBrokerError("FENCED", "terminal keyboard lease credential is stale or invalid");
    }
    return lease;
  }

  #assertRunningWritable(terminal: ManagedTerminal): void {
    if (terminal.state !== "running") {
      throw new TerminalBrokerError("CONFLICT", "terminal is not running");
    }
    if (!terminal.provider.capabilities.write) {
      throw new TerminalBrokerError("UNSUPPORTED", "this terminal backend is read-only");
    }
  }

  private runningCount(): number {
    return new Set(
      [...this.#bySession.values()]
        .filter((terminal) => terminal.state === "running")
        .map((terminal) => terminal.process),
    ).size;
  }

  private assertOpen(): void {
    if (this.#closed) throw new TerminalBrokerError("CONFLICT", "terminal broker is closed");
  }

  #serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.#locks.set(key, current);
    void current.finally(() => {
      if (this.#locks.get(key) === current) this.#locks.delete(key);
    }).catch(() => undefined);
    return current;
  }

  #leaseToken(requestId: string): string {
    return createHmac("sha256", this.#leaseTokenSecret)
      .update("agent-multiplex-terminal-lease\0")
      .update(requestId)
      .digest("base64url");
  }

  #acquireResult(requestId: string, receipt: AcquireReceipt): TerminalLeaseAcquireResult {
    return {
      lease: receipt.lease,
      credential: {
        terminalLeaseId: receipt.terminalLeaseId,
        token: this.#leaseToken(requestId),
      },
      nextInputSequence: receipt.nextInputSequence,
    };
  }
}

/** Small adapter around node-pty used by harness terminal providers. */
export function terminalProcessFromPty(pty: IPty): TerminalProcess {
  let dataListener: ((data: string) => void) | undefined;
  let exitListener: ((exit: TerminalProcessExit) => void) | undefined;
  const startupData: string[] = [];
  let startupBytes = 0;
  let startupExit: TerminalProcessExit | undefined;
  const dataSubscription = pty.onData((data) => {
    if (dataListener) {
      dataListener(data);
      return;
    }
    startupData.push(data);
    startupBytes += Buffer.byteLength(data, "utf8");
    while (startupBytes > STARTUP_OUTPUT_LIMIT && startupData.length > 1) {
      const removed = startupData.shift();
      if (removed !== undefined) startupBytes -= Buffer.byteLength(removed, "utf8");
    }
  });
  const exitSubscription = pty.onExit(({ exitCode, signal }) => {
    const exit = { exitCode, signal: signal ?? null };
    startupExit = exit;
    exitListener?.(exit);
    dataSubscription.dispose();
    exitSubscription.dispose();
  });
  return {
    onData(listener) {
      if (dataListener) throw new Error("terminal PTY data listener is already attached");
      dataListener = listener;
      for (const data of startupData.splice(0)) listener(data);
      startupBytes = 0;
      return () => {
        if (dataListener === listener) dataListener = undefined;
      };
    },
    onExit(listener) {
      if (exitListener) throw new Error("terminal PTY exit listener is already attached");
      exitListener = listener;
      if (startupExit) {
        const exit = startupExit;
        queueMicrotask(() => {
          if (exitListener === listener) listener(exit);
        });
      }
      return () => {
        if (exitListener === listener) exitListener = undefined;
      };
    },
    write: (data) => pty.write(data),
    resize: ({ columns, rows }) => pty.resize(columns, rows),
    kill: () => {
      pty.kill();
      dataSubscription.dispose();
      exitSubscription.dispose();
    },
  };
}

/** Remove fleet credentials before launching a native interactive child. */
export function sanitizedTerminalEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    // The AGENT_MULTIPLEX namespace is reserved for this process's topology,
    // transport, credential locators, and runtime configuration. Native TUI
    // children need none of it: harness-specific credentials/configuration
    // use their native namespaces, and the experimental Copilot provider
    // explicitly lowers only its required values after this sanitization.
    if (/^AGENT_MULTIPLEX_/i.test(name)) continue;
    safe[name] = value;
  }
  return safe;
}

class AsyncQueue<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<{
    resolve(value: IteratorResult<T>): void;
    reject(error: unknown): void;
  }> = [];
  #closed = false;
  #failure: unknown;

  public constructor(
    private readonly capacity: number,
    private readonly overflow: () => void,
  ) {}

  public get closed(): boolean {
    return this.#closed;
  }

  public push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else if (this.#values.length >= this.capacity) this.overflow();
    else this.#values.push(value);
  }

  public close(failure?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = failure;
    for (const waiter of this.#waiters.splice(0)) {
      if (failure === undefined) waiter.resolve({ value: undefined, done: true });
      else waiter.reject(failure);
    }
  }

  public async next(): Promise<IteratorResult<T>> {
    const value = this.#values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.#closed) {
      if (this.#failure !== undefined) throw this.#failure;
      return { value: undefined, done: true };
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
}

function queueIterable<T>(queue: AsyncQueue<T>, close: () => void = () => undefined): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next: () => queue.next(),
        return: async () => {
          close();
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function providerKey(harness: Harness, adapterScopeId: AdapterScopeId): string {
  return `${harness}\0${adapterScopeId}`;
}

function secretHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function acquisitionFingerprint(input: TerminalLeaseAcquireInput): string {
  return createHash("sha256")
    .update(JSON.stringify({
      sessionId: input.sessionId,
      runtimeNodeId: input.runtimeNodeId,
      bindingRevision: input.bindingRevision,
      terminalId: input.terminalId,
      terminalClientId: input.terminalClientId,
      forceTerminalLeaseId: input.forceTerminalLeaseId ?? null,
    }))
    .digest("base64url");
}

function boundedScreenSnapshot(serialized: string): Buffer {
  const screen = Buffer.from(serialized, "utf8");
  if (screen.byteLength <= TERMINAL_MAX_SCREEN_BYTES) return screen;
  const reset = Buffer.from("\u001bc", "utf8");
  const maximumTail = TERMINAL_MAX_SCREEN_BYTES - reset.byteLength;
  let offset = screen.byteLength - maximumTail;
  // Never begin in the middle of a UTF-8 code point.
  while (offset < screen.byteLength && (screen[offset]! & 0xc0) === 0x80) offset += 1;
  // Prefer a serialized line boundary so the tail cannot begin in the middle
  // of a CSI/OSC sequence. If there is no newline, the reset still fences the
  // preceding terminal state and the UTF-8 boundary keeps the frame valid.
  const newline = screen.indexOf(0x0a, offset);
  if (newline >= 0 && newline + 1 < screen.byteLength) offset = newline + 1;
  return Buffer.concat([reset, screen.subarray(offset)]);
}

function inputHash(input: TerminalInput): string {
  return createHash("sha256")
    .update(input.kind)
    .update("\0")
    .update(input.kind === "write" ? input.dataBase64 : JSON.stringify(input.dimensions))
    .digest("base64url");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}
