import { adapterScopeIdSchema, newRuntimeNodeBootId, newRuntimeNodeId,
  newCommandId, newLaunchId, newRuntimeEpoch, newSessionId, newTerminalClientId,
  newTerminalLeaseId, newTerminalLeaseRequestId,
  type AdapterScopeId, type Harness, type SessionId, type TerminalStreamItem } from "@arduano/agent-multiplex-protocol";
import {
  RuntimeNodeService,
  RuntimeNodeStore,
  TerminalBroker,
  TerminalSubscriberOverflowError,
  sanitizedTerminalEnvironment,
  terminalProcessFromPty,
  type AdapterSession,
  type AgentAdapter,
  type TerminalBinding,
  type TerminalProcess,
  type TerminalProcessExit,
  type TerminalProvider,
  type TerminalProviderOpenRequest,
} from "@arduano/agent-multiplex-runtime-node-core";
import type { IDisposable, IPty } from "node-pty";
import { Terminal as HeadlessTerminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";

class FakeProcess implements TerminalProcess {
  // This fake installs no native source before the broker's listener, so it
  // can explicitly prove that there is no missing startup output.
  readonly startupOutputComplete = true;
  readonly writes: string[] = [];
  readonly resizes: Array<{ columns: number; rows: number }> = [];
  readonly dataListeners = new Set<(data: string) => void>();
  readonly exitListeners = new Set<(exit: TerminalProcessExit) => void>();
  kills = 0;

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (exit: TerminalProcessExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  write(data: string): void { this.writes.push(data); }
  resize(dimensions: { columns: number; rows: number }): void {
    this.resizes.push(dimensions);
  }
  kill(): void { this.kills += 1; }
  emit(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
  exit(exit: TerminalProcessExit = { exitCode: 0, signal: null }): void {
    for (const listener of [...this.exitListeners]) listener(exit);
  }
}

class HandoffFakeProcess extends FakeProcess {
  readonly #pending: string[] = [];

  public override onData(listener: (data: string) => void): () => void {
    const dispose = super.onData(listener);
    for (const data of this.#pending.splice(0)) listener(data);
    return dispose;
  }

  public override emit(data: string): void {
    if (this.dataListeners.size === 0) {
      this.#pending.push(data);
      return;
    }
    super.emit(data);
  }
}

class FakeProvider implements TerminalProvider {
  readonly harness = "codex" as const;
  readonly backend = "mock" as const;
  readonly sharing = "session" as const;
  readonly capabilities = {
    write: true,
    resize: true,
    terminate: true,
    restart: true,
    foregroundSwitch: false,
  } as const;
  readonly opened: FakeProcess[] = [];

  constructor(readonly adapterScopeId: AdapterScopeId) {}

  async open(): Promise<TerminalProcess> {
    const process = new FakeProcess();
    this.opened.push(process);
    return process;
  }

  async close(): Promise<void> {}
}

function fixture(options: { subscriberItemLimit?: number; leaseTtlMs?: number;
  maxRunningTerminals?: number; replayByteLimit?: number; replayItemLimit?: number } = {}) {
  const adapterScopeId = adapterScopeIdSchema.parse("codex:test");
  const provider = new FakeProvider(adapterScopeId);
  const runtimeNodeId = newRuntimeNodeId();
  const broker = new TerminalBroker({
    runtimeNodeBootId: newRuntimeNodeBootId(),
    providers: [provider],
    ...options,
  });
  const binding = bindingFor(newSessionId(), runtimeNodeId, adapterScopeId);
  return { broker, provider, binding, runtimeNodeId, adapterScopeId };
}

function bindingFor(
  sessionId: SessionId,
  runtimeNodeId: ReturnType<typeof newRuntimeNodeId>,
  adapterScopeId: AdapterScopeId,
): TerminalBinding {
  return bindingForHarness("codex", sessionId, runtimeNodeId, adapterScopeId);
}

function bindingForHarness(
  harness: Harness,
  sessionId: SessionId,
  runtimeNodeId: ReturnType<typeof newRuntimeNodeId>,
  adapterScopeId: AdapterScopeId,
): TerminalBinding {
  return {
    target: { sessionId, runtimeNodeId, bindingRevision: 1 },
    harness,
    adapterScopeId,
    vendorSessionId: `native-${sessionId}`,
    cwd: "/tmp",
  };
}

async function applyTerminalItem(
  terminal: HeadlessTerminal,
  item: TerminalStreamItem,
): Promise<void> {
  if (item.kind === "replayStart") {
    terminal.reset();
    terminal.resize(item.initialDimensions.columns, item.initialDimensions.rows);
    return;
  }
  if (item.kind === "reset") {
    terminal.reset();
    terminal.resize(item.terminal.dimensions.columns, item.terminal.dimensions.rows);
    await writeTerminal(terminal, Buffer.from(item.screenBase64, "base64"));
    return;
  }
  if (item.kind === "output") {
    await writeTerminal(terminal, Buffer.from(item.dataBase64, "base64"));
    return;
  }
  if (item.kind === "resize") {
    terminal.resize(item.dimensions.columns, item.dimensions.rows);
    return;
  }
  if (item.kind === "changed") {
    terminal.resize(item.terminal.dimensions.columns, item.terminal.dimensions.rows);
  }
}

function writeTerminal(terminal: HeadlessTerminal, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve) => terminal.write(bytes, resolve));
}

function terminalState(terminal: HeadlessTerminal) {
  const snapshotBuffer = (buffer: typeof terminal.buffer.active) => ({
    type: buffer.type,
    cursor: { x: buffer.cursorX, y: buffer.cursorY },
    baseY: buffer.baseY,
    viewportY: buffer.viewportY,
    length: buffer.length,
    lines: Array.from({ length: buffer.length }, (_, lineIndex) => {
      const line = buffer.getLine(lineIndex);
      return line === undefined ? null : {
        isWrapped: line.isWrapped,
        length: line.length,
        cells: Array.from({ length: line.length }, (_, cellIndex) => {
          const cell = line.getCell(cellIndex);
          return cell === undefined ? null : {
            chars: cell.getChars(),
            width: cell.getWidth(),
            code: cell.getCode(),
            foreground: [cell.getFgColorMode(), cell.getFgColor()],
            background: [cell.getBgColorMode(), cell.getBgColor()],
            styles: [
              cell.isBold(), cell.isItalic(), cell.isDim(), cell.isUnderline(),
              cell.isBlink(), cell.isInverse(), cell.isInvisible(),
              cell.isStrikethrough(), cell.isOverline(),
            ],
          };
        }),
      };
    }),
  });
  return {
    dimensions: { columns: terminal.cols, rows: terminal.rows },
    activeBuffer: terminal.buffer.active.type,
    normal: snapshotBuffer(terminal.buffer.normal),
    alternate: snapshotBuffer(terminal.buffer.alternate),
    modes: {
      applicationCursorKeysMode: terminal.modes.applicationCursorKeysMode,
      applicationKeypadMode: terminal.modes.applicationKeypadMode,
      bracketedPasteMode: terminal.modes.bracketedPasteMode,
      insertMode: terminal.modes.insertMode,
      mouseTrackingMode: terminal.modes.mouseTrackingMode,
      originMode: terminal.modes.originMode,
      reverseWraparoundMode: terminal.modes.reverseWraparoundMode,
      sendFocusMode: terminal.modes.sendFocusMode,
      synchronizedOutputMode: terminal.modes.synchronizedOutputMode,
      wraparoundMode: terminal.modes.wraparoundMode,
    },
  };
}

describe("TerminalBroker", () => {
  it("supports many viewers and one retry-safe keyboard lease", async () => {
    const { broker, provider, binding } = fixture();
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");
    const terminalId = opened.terminal.terminalId;
    const first = broker.attach({ ...binding.target, terminalId })[Symbol.asyncIterator]();
    const second = broker.attach({ ...binding.target, terminalId })[Symbol.asyncIterator]();
    expect((await first.next()).value?.kind).toBe("replayStart");
    expect((await second.next()).value?.kind).toBe("replayStart");
    expect((await first.next()).value?.kind).toBe("replayEnd");
    expect((await second.next()).value?.kind).toBe("replayEnd");

    provider.opened[0]!.emit("hello\r\n");
    expect(await first.next()).toMatchObject({ value: { kind: "output" }, done: false });
    expect(await second.next()).toMatchObject({ value: { kind: "output" }, done: false });

    const terminalClientId = newTerminalClientId();
    const requestId = newTerminalLeaseRequestId();
    const acquisition = { ...binding.target, terminalId, terminalClientId, requestId };
    const lease = broker.acquire(acquisition);
    expect(broker.acquire(acquisition)).toEqual(lease);
    expect(() => broker.acquire({ ...acquisition, terminalClientId: newTerminalClientId() }))
      .toThrow("request ID was reused");

    const input = {
      ...binding.target,
      terminalId,
      terminalClientId,
      credential: lease.credential,
      inputSequence: 0,
      kind: "write" as const,
      dataBase64: Buffer.from("typed once").toString("base64"),
    };
    const receipt = broker.input(input);
    expect(broker.input(input)).toEqual(receipt);
    expect(provider.opened[0]!.writes).toEqual(["typed once"]);
    expect(() => broker.input({
      ...input,
      inputSequence: 1,
      dataBase64: Buffer.from([0xf0, 0x9f]).toString("base64"),
    })).toThrow("valid UTF-8 text");
    expect(provider.opened[0]!.writes).toEqual(["typed once"]);
    expect(() => broker.input({
      ...input,
      inputSequence: 1,
      // Exercise the runtime boundary as an untyped JavaScript caller. Node's
      // Buffer.from silently accepts this unless the broker checks first.
      dataBase64: new Uint8Array([0x41, 0x41, 0x3d, 0x3d]),
    } as unknown as Parameters<TerminalBroker["input"]>[0])).toThrow("base64 string");
    expect(provider.opened[0]!.writes).toEqual(["typed once"]);
    expect(() => broker.input({
      ...input,
      dataBase64: Buffer.from("different").toString("base64"),
    })).toThrow("sequence was reused");

    expect(broker.renew({
      ...binding.target,
      terminalId,
      terminalClientId,
      credential: lease.credential,
    }).nextInputSequence).toBe(1);
    expect(broker.release({
      ...binding.target,
      terminalId,
      terminalClientId,
      credential: lease.credential,
    })).toEqual({ released: true });
    expect(() => broker.renew({
      ...binding.target,
      terminalId,
      terminalClientId,
      credential: lease.credential,
    })).toThrow("absent or expired");

    await first.return?.();
    await second.return?.();
    await broker.close();
  });

  it("reconstructs a late viewer from exact raw output before incremental fanout", async () => {
    const { broker, provider, binding } = fixture();
    const dimensions = { columns: 10, rows: 5 };
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
      dimensions,
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");
    const terminalId = opened.terminal.terminalId;
    const earlyTerminal = new HeadlessTerminal({
      cols: dimensions.columns,
      rows: dimensions.rows,
      scrollback: 100,
      allowProposedApi: true,
    });
    const lateTerminal = new HeadlessTerminal({
      cols: dimensions.columns,
      rows: dimensions.rows,
      scrollback: 100,
      allowProposedApi: true,
    });
    const early = broker.attach({
      ...binding.target,
      terminalId,
    })[Symbol.asyncIterator]();
    await applyTerminalItem(earlyTerminal, (await early.next()).value!);
    expect(await early.next()).toMatchObject({
      value: { kind: "replayEnd", cursor: { sequence: 0 } },
      done: false,
    });

    // This cursor-positioning sequence is not reproduced faithfully by
    // SerializeAddon. A raw opening-state replay must preserve it exactly.
    provider.opened[0]!.emit("abcdefghij\x1b[5;9H");
    await applyTerminalItem(earlyTerminal, (await early.next()).value!);
    expect(earlyTerminal.buffer.active.cursorX).toBe(8);

    const late = broker.attach({
      ...binding.target,
      terminalId,
    })[Symbol.asyncIterator]();
    const replayStart = await late.next();
    expect(replayStart).toMatchObject({
      done: false,
      value: {
        kind: "replayStart",
        cursor: { terminalId, sequence: 0 },
        initialDimensions: dimensions,
        terminal: { terminalId, sequence: 1, dimensions },
      },
    });
    await applyTerminalItem(lateTerminal, replayStart.value!);
    await applyTerminalItem(lateTerminal, (await late.next()).value!);
    expect(await late.next()).toMatchObject({
      value: { kind: "replayEnd", cursor: { sequence: 1 } },
      done: false,
    });
    expect(lateTerminal.buffer.active.cursorX).toBe(8);
    expect(terminalState(lateTerminal)).toEqual(terminalState(earlyTerminal));

    provider.opened[0]!.emit("Z");
    await applyTerminalItem(earlyTerminal, (await early.next()).value!);
    await applyTerminalItem(lateTerminal, (await late.next()).value!);
    expect(terminalState(lateTerminal)).toEqual(terminalState(earlyTerminal));

    // Exercise modes, styled cells, the alternate buffer, and an ordered
    // resize, then reconstruct those independently in a third emulator.
    const terminalClientId = newTerminalClientId();
    const lease = broker.acquire({
      ...binding.target,
      terminalId,
      terminalClientId,
      requestId: newTerminalLeaseRequestId(),
    });
    await applyTerminalItem(earlyTerminal, (await early.next()).value!);
    await applyTerminalItem(lateTerminal, (await late.next()).value!);
    const resized = { columns: 12, rows: 6 };
    broker.input({
      ...binding.target,
      terminalId,
      terminalClientId,
      credential: lease.credential,
      inputSequence: 0,
      kind: "resize",
      dimensions: resized,
    });
    await applyTerminalItem(earlyTerminal, (await early.next()).value!);
    await applyTerminalItem(lateTerminal, (await late.next()).value!);
    provider.opened[0]!.emit(
      "\x1b[?1049h\x1b[2J\x1b[H\x1b[1;38;2;12;34;56mwide界\x1b[?2004h",
    );
    await applyTerminalItem(earlyTerminal, (await early.next()).value!);
    await applyTerminalItem(lateTerminal, (await late.next()).value!);

    const replayedTerminal = new HeadlessTerminal({
      cols: dimensions.columns,
      rows: dimensions.rows,
      scrollback: 100,
      allowProposedApi: true,
    });
    const replayed = broker.attach({
      ...binding.target,
      terminalId,
    })[Symbol.asyncIterator]();
    const resizedReplayStart = await replayed.next();
    expect(resizedReplayStart).toMatchObject({
      done: false,
      value: {
        kind: "replayStart",
        cursor: { terminalId, sequence: 0 },
        initialDimensions: dimensions,
        terminal: { terminalId, sequence: 5, dimensions: resized },
      },
    });
    await applyTerminalItem(replayedTerminal, resizedReplayStart.value!);
    await applyTerminalItem(replayedTerminal, (await replayed.next()).value!);
    const replayResize = await replayed.next();
    expect(replayResize).toMatchObject({
      value: { kind: "resize", cursor: { sequence: 4 }, dimensions: resized },
      done: false,
    });
    await applyTerminalItem(replayedTerminal, replayResize.value!);
    await applyTerminalItem(replayedTerminal, (await replayed.next()).value!);
    expect(await replayed.next()).toMatchObject({
      value: { kind: "replayEnd", cursor: { sequence: 5 } },
      done: false,
    });
    expect(terminalState(replayedTerminal)).toEqual(terminalState(earlyTerminal));
    expect(terminalState(lateTerminal)).toEqual(terminalState(earlyTerminal));

    await early.return?.();
    await late.return?.();
    await replayed.return?.();
    earlyTerminal.dispose();
    lateTerminal.dispose();
    replayedTerminal.dispose();
    await broker.close();
  });

  it("requires an exact lease CAS for takeover and expires leases", async () => {
    const { broker, binding } = fixture({ leaseTtlMs: 20 });
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");
    const terminalId = opened.terminal.terminalId;
    const owner = newTerminalClientId();
    const first = broker.acquire({
      ...binding.target, terminalId, terminalClientId: owner,
      requestId: newTerminalLeaseRequestId(),
    });
    const contender = newTerminalClientId();
    expect(() => broker.acquire({
      ...binding.target, terminalId, terminalClientId: contender,
      requestId: newTerminalLeaseRequestId(),
    })).toThrow("already leased");
    expect(() => broker.acquire({
      ...binding.target, terminalId, terminalClientId: contender,
      requestId: newTerminalLeaseRequestId(), forceTerminalLeaseId: newTerminalLeaseId(),
    })).toThrow("already leased");
    const replacement = broker.acquire({
      ...binding.target, terminalId, terminalClientId: contender,
      requestId: newTerminalLeaseRequestId(),
      forceTerminalLeaseId: first.lease.terminalLeaseId,
    });
    expect(() => broker.renew({
      ...binding.target, terminalId, terminalClientId: owner, credential: first.credential,
    })).toThrow("stale or invalid");
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(() => broker.renew({
      ...binding.target, terminalId, terminalClientId: contender,
      credential: replacement.credential,
    })).toThrow("absent or expired");
    expect(broker.acquire({
      ...binding.target, terminalId, terminalClientId: owner,
      requestId: newTerminalLeaseRequestId(),
    }).lease.terminalClientId).toBe(owner);
    await broker.close();
  });

  it("replays cursors, resets stale viewers, and disconnects slow viewers", async () => {
    const { broker, provider, binding } = fixture({ subscriberItemLimit: 1 });
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");
    const terminalId = opened.terminal.terminalId;
    provider.opened[0]!.emit("one");
    provider.opened[0]!.emit("two");

    const replay = broker.attach({
      ...binding.target,
      terminalId,
      cursor: { terminalId, sequence: 1 },
    })[Symbol.asyncIterator]();
    expect(await replay.next()).toMatchObject({ value: { kind: "output", cursor: { sequence: 2 } } });

    const slow = broker.attach({ ...binding.target, terminalId })[Symbol.asyncIterator]();
    expect((await slow.next()).value?.kind).toBe("replayStart");
    expect(await slow.next()).toMatchObject({
      value: { kind: "output", cursor: { sequence: 2 } },
      done: false,
    });
    expect(await slow.next()).toMatchObject({
      value: { kind: "replayEnd", cursor: { sequence: 2 } },
      done: false,
    });
    provider.opened[0]!.emit("fills buffer");
    provider.opened[0]!.emit("overflow");
    expect((await slow.next()).value?.kind).toBe("output");
    await expect(slow.next()).rejects.toBeInstanceOf(TerminalSubscriberOverflowError);

    await replay.return?.();
    await broker.close();
  });

  it("delivers retained cursor catch-up without consuming the live subscriber mailbox", async () => {
    const { broker, provider, binding } = fixture({
      subscriberItemLimit: 1,
      replayItemLimit: 16,
    });
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");
    const terminalId = opened.terminal.terminalId;
    for (let sequence = 1; sequence <= 12; sequence += 1) {
      provider.opened[0]!.emit(String(sequence % 10));
    }

    const catchUp = broker.attach({
      ...binding.target,
      terminalId,
      cursor: { terminalId, sequence: 0 },
    })[Symbol.asyncIterator]();
    const sequences: number[] = [];
    for (let count = 0; count < 12; count += 1) {
      const item = await catchUp.next();
      expect(item.done).toBe(false);
      sequences.push(item.value!.cursor.sequence);
    }
    expect(sequences).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));

    provider.opened[0]!.emit("live");
    await expect(catchUp.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "output", cursor: { sequence: 13 } },
    });
    await catchUp.return?.();
    await broker.close();
  });

  it("resets a stale cursor when one oversized replay item evicts itself", async () => {
    const { broker, provider, binding } = fixture({ replayByteLimit: 1 });
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");
    const terminalId = opened.terminal.terminalId;
    provider.opened[0]!.emit("output larger than the replay byte budget");

    const stale = broker.attach({
      ...binding.target,
      terminalId,
      cursor: { terminalId, sequence: 0 },
    })[Symbol.asyncIterator]();
    expect(await stale.next()).toMatchObject({
      done: false,
      value: {
        kind: "reset",
        reason: "cursorExpired",
        cursor: { terminalId, sequence: 1 },
      },
    });

    await stale.return?.();
    await broker.close();
  });

  it("fails closed to synthesized recovery when a process omits startup proof", async () => {
    const adapterScopeId = adapterScopeIdSchema.parse("codex:unproven-startup");
    const runtimeNodeId = newRuntimeNodeId();
    const binding = bindingFor(newSessionId(), runtimeNodeId, adapterScopeId);
    const process = new FakeProcess();
    // Exercise the runtime boundary against an outdated/untyped provider. The
    // TypeScript contract requires an explicit boolean, but runtime fidelity
    // still fails closed if a JavaScript implementation omits the proof.
    const unprovenProcess = process as FakeProcess & {
      startupOutputComplete?: boolean;
    };
    delete unprovenProcess.startupOutputComplete;
    const provider: TerminalProvider = {
      harness: "codex",
      adapterScopeId,
      backend: "mock",
      sharing: "session",
      capabilities: {
        write: true,
        resize: true,
        terminate: true,
        restart: true,
        foregroundSwitch: false,
      },
      open: async () => unprovenProcess as TerminalProcess,
      close: async () => undefined,
    };
    const broker = new TerminalBroker({
      runtimeNodeBootId: newRuntimeNodeBootId(),
      providers: [provider],
    });
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");

    const stream = broker.attach({
      ...binding.target,
      terminalId: opened.terminal.terminalId,
    })[Symbol.asyncIterator]();
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: {
        kind: "reset",
        reason: "initial",
        fidelity: "synthesized",
      },
    });

    await stream.return?.();
    await broker.close();
  });

  it("uses synthesized recovery when the PTY startup buffer dropped opening bytes", async () => {
    const adapterScopeId = adapterScopeIdSchema.parse("codex:truncated-startup");
    const runtimeNodeId = newRuntimeNodeId();
    const binding = bindingFor(newSessionId(), runtimeNodeId, adapterScopeId);
    const pty = new FakePty();
    const process = terminalProcessFromPty(pty as unknown as IPty);
    const startupChunk = "x".repeat(600 * 1_024);
    pty.emitData(startupChunk);
    pty.emitData(startupChunk);
    expect(process.startupOutputComplete).toBe(false);
    const provider: TerminalProvider = {
      harness: "codex",
      adapterScopeId,
      backend: "mock",
      sharing: "session",
      capabilities: {
        write: true,
        resize: true,
        terminate: true,
        restart: true,
        foregroundSwitch: false,
      },
      open: async () => process,
      close: async () => undefined,
    };
    const broker = new TerminalBroker({
      runtimeNodeBootId: newRuntimeNodeBootId(),
      providers: [provider],
    });
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");

    const stream = broker.attach({
      ...binding.target,
      terminalId: opened.terminal.terminalId,
    })[Symbol.asyncIterator]();
    await expect(stream.next()).resolves.toMatchObject({
      done: false,
      value: {
        kind: "reset",
        reason: "initial",
        fidelity: "synthesized",
      },
    });

    await stream.return?.();
    await broker.close();
  });

  it("includes current control-only state in an exact replay preamble", async () => {
    const { broker, binding } = fixture();
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");
    const terminalId = opened.terminal.terminalId;
    broker.acquire({
      ...binding.target,
      terminalId,
      terminalClientId: newTerminalClientId(),
      requestId: newTerminalLeaseRequestId(),
    });

    const stream = broker.attach({ ...binding.target, terminalId })[Symbol.asyncIterator]();
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        kind: "replayStart",
        cursor: { sequence: 0 },
        terminal: { sequence: 1, lease: { terminalClientId: expect.any(String) } },
      },
      done: false,
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        kind: "replayEnd",
        cursor: { sequence: 1 },
        terminal: { sequence: 1, lease: { terminalClientId: expect.any(String) } },
      },
      done: false,
    });
    await stream.return?.();
    await broker.close();
  });

  it("settles lease expiry before capturing one coherent reset sequence", async () => {
    const { broker, binding } = fixture({ leaseTtlMs: 10 });
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");
    broker.acquire({
      ...binding.target,
      terminalId: opened.terminal.terminalId,
      terminalClientId: newTerminalClientId(),
      requestId: newTerminalLeaseRequestId(),
    });

    const originalNow = Date.now;
    Date.now = () => originalNow() + 1_000;
    try {
      const stream = broker.attach({
        ...binding.target,
        terminalId: opened.terminal.terminalId,
      })[Symbol.asyncIterator]();
      await expect(stream.next()).resolves.toMatchObject({
        done: false,
        value: {
          kind: "replayStart",
          cursor: { sequence: 0 },
          terminal: { sequence: 2, lease: null },
        },
      });
      await expect(stream.next()).resolves.toMatchObject({
        done: false,
        value: {
          kind: "replayEnd",
          cursor: { sequence: 2 },
          terminal: { sequence: 2, lease: null },
        },
      });
      await stream.return?.();
    } finally {
      Date.now = originalNow;
      await broker.close();
    }
  });

  it("fences replacement bindings, invalidates streams, and enforces process limits", async () => {
    const { broker, provider, binding, runtimeNodeId, adapterScopeId } = fixture({
      maxRunningTerminals: 1,
    });
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");
    const terminalId = opened.terminal.terminalId;
    expect(() => broker.get({ ...binding.target, bindingRevision: 2 }))
      .toThrow("binding was replaced");

    const other = bindingFor(newSessionId(), runtimeNodeId, adapterScopeId);
    await expect(broker.open(other, {
      ...other.target,
      terminalClientId: newTerminalClientId(),
    })).rejects.toMatchObject({ code: "RESOURCE_EXHAUSTED" });

    const stream = broker.attach({ ...binding.target, terminalId })[Symbol.asyncIterator]();
    expect((await stream.next()).value?.kind).toBe("replayStart");
    expect((await stream.next()).value?.kind).toBe("replayEnd");
    broker.invalidateSession(binding.target.sessionId, "binding retired");
    expect(await stream.next()).toMatchObject({ value: { kind: "changed", terminal: {
      state: "exited", exit: { message: "binding retired" },
    } } });
    expect((await stream.next()).done).toBe(true);
    expect(broker.get(binding.target)).toBeNull();
    expect(provider.opened[0]!.kills).toBe(1);

    await expect(broker.open(other, {
      ...other.target,
      terminalClientId: newTerminalClientId(),
    })).resolves.toMatchObject({ status: "opened" });
    await broker.close();
  });

  it("reserves capacity across concurrent opens on different session locks", async () => {
    const adapterScopeId = adapterScopeIdSchema.parse("codex:open-reservation");
    const provider = new GateProvider(adapterScopeId);
    const runtimeNodeId = newRuntimeNodeId();
    const broker = new TerminalBroker({
      runtimeNodeBootId: newRuntimeNodeBootId(),
      providers: [provider],
      maxRunningTerminals: 1,
    });
    const firstBinding = bindingFor(newSessionId(), runtimeNodeId, adapterScopeId);
    const secondBinding = bindingFor(newSessionId(), runtimeNodeId, adapterScopeId);
    const first = broker.open(firstBinding, {
      ...firstBinding.target,
      terminalClientId: newTerminalClientId(),
    });
    await provider.entered;

    await expect(broker.open(secondBinding, {
      ...secondBinding.target,
      terminalClientId: newTerminalClientId(),
    })).rejects.toMatchObject({ code: "RESOURCE_EXHAUSTED" });
    provider.release();
    await expect(first).resolves.toMatchObject({ status: "opened" });
    await broker.close();
  });

  it("does not install a native process that finishes opening after broker close", async () => {
    const adapterScopeId = adapterScopeIdSchema.parse("codex:open-close-race");
    const provider = new GateProvider(adapterScopeId);
    const binding = bindingFor(newSessionId(), newRuntimeNodeId(), adapterScopeId);
    const broker = new TerminalBroker({
      runtimeNodeBootId: newRuntimeNodeBootId(),
      providers: [provider],
    });
    const opening = broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    await provider.entered;
    const rejected = expect(opening).rejects.toThrow("closed while the native terminal was opening");
    const closing = broker.close();
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    provider.release();

    await Promise.all([closing, rejected]);
    expect(provider.opened[0]?.kills).toBe(1);
    expect(broker.get(binding.target)).toBeNull();
  });

  it("fences and disposes an adapter-scoped foreground before reusing its process", async () => {
    const adapterScopeId = adapterScopeIdSchema.parse("copilot:shared-foreground");
    const provider = new SharedFakeProvider(adapterScopeId);
    const runtimeNodeId = newRuntimeNodeId();
    const broker = new TerminalBroker({
      runtimeNodeBootId: newRuntimeNodeBootId(),
      providers: [provider],
      maxRunningTerminals: 1,
    });
    const firstBinding = bindingForHarness(
      "copilot",
      newSessionId(),
      runtimeNodeId,
      adapterScopeId,
    );
    const secondBinding = bindingForHarness(
      "copilot",
      newSessionId(),
      runtimeNodeId,
      adapterScopeId,
    );
    const first = await broker.open(firstBinding, {
      ...firstBinding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (first.status !== "opened") throw new Error("expected first foreground to open");
    const firstStream = broker.attach({
      ...firstBinding.target,
      terminalId: first.terminal.terminalId,
    })[Symbol.asyncIterator]();
    expect((await firstStream.next()).value?.kind).toBe("replayStart");
    expect((await firstStream.next()).value?.kind).toBe("replayEnd");

    await expect(broker.open(secondBinding, {
      ...secondBinding.target,
      terminalClientId: newTerminalClientId(),
    })).resolves.toMatchObject({
      status: "confirmationRequired",
      reason: "foregroundSwitch",
      terminal: { sessionId: firstBinding.target.sessionId },
    });
    const second = await broker.open(secondBinding, {
      ...secondBinding.target,
      terminalClientId: newTerminalClientId(),
      confirmForegroundSwitch: true,
      expectedTerminalId: first.terminal.terminalId,
    });
    if (second.status !== "opened") throw new Error("expected second foreground to open");
    expect(second.terminal.terminalId).not.toBe(first.terminal.terminalId);
    expect(provider.opens).toHaveLength(2);
    expect(provider.opens[1]).toMatchObject({ foregroundSwitch: true });
    expect(provider.foregroundSwitchListenerCounts).toEqual([0]);
    expect(await firstStream.next()).toMatchObject({
      value: {
        kind: "changed",
        terminal: {
          state: "exited",
          exit: { message: "terminal foreground moved to another session" },
        },
      },
    });
    expect((await firstStream.next()).done).toBe(true);
    expect(broker.get(firstBinding.target)).toBeNull();
    expect(broker.get(secondBinding.target)?.foregroundSessionId)
      .toBe(secondBinding.target.sessionId);
    const secondStream = broker.attach({
      ...secondBinding.target,
      terminalId: second.terminal.terminalId,
    })[Symbol.asyncIterator]();
    const handoff = await secondStream.next();
    expect(handoff).toMatchObject({
      value: { kind: "reset", reason: "initial", fidelity: "synthesized" },
      done: false,
    });
    if (handoff.value?.kind !== "reset") throw new Error("expected synthesized handoff reset");
    expect(Buffer.from(handoff.value.screenBase64, "base64").toString("utf8"))
      .toContain("foreground transition redraw");
    provider.process.emit("shared process remains attached");
    expect(await secondStream.next()).toMatchObject({
      value: { kind: "output" },
      done: false,
    });
    await secondStream.return?.();

    await broker.close();
    expect(provider.process.kills).toBe(0);
    expect(provider.closes).toBe(1);
  });

  it("rejects an adapter-scoped foreground switch that replaces its native process", async () => {
    const adapterScopeId = adapterScopeIdSchema.parse("copilot:replacement-foreground");
    const provider = new ReplacingSharedFakeProvider(adapterScopeId);
    const runtimeNodeId = newRuntimeNodeId();
    const broker = new TerminalBroker({
      runtimeNodeBootId: newRuntimeNodeBootId(),
      providers: [provider],
      maxRunningTerminals: 1,
    });
    const firstBinding = bindingForHarness(
      "copilot",
      newSessionId(),
      runtimeNodeId,
      adapterScopeId,
    );
    const secondBinding = bindingForHarness(
      "copilot",
      newSessionId(),
      runtimeNodeId,
      adapterScopeId,
    );
    const first = await broker.open(firstBinding, {
      ...firstBinding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (first.status !== "opened") throw new Error("expected first foreground to open");

    await expect(broker.open(secondBinding, {
      ...secondBinding.target,
      terminalClientId: newTerminalClientId(),
      confirmForegroundSwitch: true,
      expectedTerminalId: first.terminal.terminalId,
    })).rejects.toThrow("returned another native process");
    expect(provider.process.dataListeners.size).toBe(1);
    expect(provider.replacement.kills).toBe(0);
    expect(broker.get(firstBinding.target)?.terminalId).toBe(first.terminal.terminalId);
    expect(broker.get(secondBinding.target)).toBeNull();

    await broker.close();
  });

  it("invalidates exact replay when a failed foreground switch truncates PTY handoff", async () => {
    const adapterScopeId = adapterScopeIdSchema.parse("copilot:failed-truncated-handoff");
    const runtimeNodeId = newRuntimeNodeId();
    const pty = new FakePty();
    const process = terminalProcessFromPty(pty as unknown as IPty);
    const transitionChunk = "x".repeat(600 * 1_024);
    const provider: TerminalProvider = {
      harness: "copilot",
      adapterScopeId,
      backend: "mock",
      sharing: "adapterScope",
      capabilities: {
        write: true,
        resize: true,
        terminate: false,
        restart: false,
        foregroundSwitch: true,
      },
      open: async (request) => {
        if (!request.foregroundSwitch) return process;
        // The current logical owner is paused while the provider switches. The
        // real PTY wrapper retains a bounded tail and marks the opening state
        // incomplete when this transition exceeds it.
        pty.emitData(transitionChunk);
        pty.emitData(transitionChunk);
        throw new Error("native foreground switch failed");
      },
      close: async () => undefined,
    };
    const broker = new TerminalBroker({
      runtimeNodeBootId: newRuntimeNodeBootId(),
      providers: [provider],
      maxRunningTerminals: 1,
    });
    const firstBinding = bindingForHarness(
      "copilot",
      newSessionId(),
      runtimeNodeId,
      adapterScopeId,
    );
    const secondBinding = bindingForHarness(
      "copilot",
      newSessionId(),
      runtimeNodeId,
      adapterScopeId,
    );
    const first = await broker.open(firstBinding, {
      ...firstBinding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (first.status !== "opened") throw new Error("expected first foreground to open");

    const before = broker.attach({
      ...firstBinding.target,
      terminalId: first.terminal.terminalId,
    })[Symbol.asyncIterator]();
    expect((await before.next()).value?.kind).toBe("replayStart");
    expect((await before.next()).value?.kind).toBe("replayEnd");
    await before.return?.();

    await expect(broker.open(secondBinding, {
      ...secondBinding.target,
      terminalClientId: newTerminalClientId(),
      confirmForegroundSwitch: true,
      expectedTerminalId: first.terminal.terminalId,
    })).rejects.toThrow("native foreground switch failed");
    expect(process.startupOutputComplete).toBe(false);
    expect(broker.get(firstBinding.target)?.terminalId).toBe(first.terminal.terminalId);

    const after = broker.attach({
      ...firstBinding.target,
      terminalId: first.terminal.terminalId,
    })[Symbol.asyncIterator]();
    await expect(after.next()).resolves.toMatchObject({
      done: false,
      value: {
        kind: "reset",
        reason: "initial",
        fidelity: "synthesized",
      },
    });
    await after.return?.();
    await broker.close();
  });
});

describe("RuntimeNodeService terminal lifecycle", () => {
  it.each(["codex", "copilot"] as const)(
    "retires a managed %s terminal when the structured session stops",
    async (harness) => {
      const runtimeNodeId = newRuntimeNodeId();
      const runtimeNodeBootId = newRuntimeNodeBootId();
      const sessionId = newSessionId();
      const adapterScopeId = adapterScopeIdSchema.parse(`${harness}:terminal-test`);
      const adapter = stoppingAdapter(harness, adapterScopeId);
      const provider = new HarnessFakeProvider(
        harness,
        adapterScopeId,
        harness === "codex",
      );
      const store = new RuntimeNodeStore(":memory:");
      const service = new RuntimeNodeService({
        store,
        runtimeNodeId,
        runtimeNodeBootId,
        name: `${harness} terminal test`,
        allowedRoots: ["/tmp"],
        adapters: [adapter],
        terminalProviders: [provider],
      });
      const profile = service.listLaunchProfiles()[0]!;
      const launchId = newLaunchId();
      service.createLaunch({
        launchId,
        payloadHash: `${harness}-terminal-spawn`,
        sessionId,
        runtimeNodeId,
        profile: {
          profileId: profile.profileId,
          providerId: profile.providerId,
          contractVersion: profile.contractVersion,
          requestSchemaHash: profile.requestSchemaHash,
        },
        harness,
        input: { cwd: "/tmp" },
      });
      while (service.getLaunch(launchId)?.state !== "succeeded") {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const target = { sessionId, runtimeNodeId, bindingRevision: 1 };
      const opened = await service.terminalOpen({
        ...target,
        terminalClientId: newTerminalClientId(),
      });
      if (opened.status !== "opened") throw new Error("expected terminal to open");
      const stream = service.terminalAttach({
        ...target,
        terminalId: opened.terminal.terminalId,
      })[Symbol.asyncIterator]();
      expect((await stream.next()).value?.kind).toBe("replayStart");
      expect((await stream.next()).value?.kind).toBe("replayEnd");

      await expect(service.stop({
        operation: "stop",
        commandId: newCommandId(),
        payloadHash: `${harness}-terminal-stop`,
        sessionId,
        runtimeNodeId,
        bindingRevision: 1,
      })).resolves.toMatchObject({ state: "succeeded" });
      await expect(stream.next()).resolves.toMatchObject({
        value: {
          kind: "changed",
          terminal: {
            state: "exited",
            exit: { message: `structured ${harness} session was stopped` },
          },
        },
      });
      expect((await stream.next()).done).toBe(true);
      expect(service.terminalGet(target)).toBeNull();
      expect(provider.opened[0]?.kills).toBe(harness === "codex" ? 1 : 0);

      await service.close();
      store.close();
    },
  );
});

describe("terminalProcessFromPty", () => {
  it("buffers startup output and an early exit until the broker listeners attach", async () => {
    const pty = new FakePty();
    const process = terminalProcessFromPty(pty as unknown as IPty);
    pty.emitData("startup");
    pty.emitExit({ exitCode: 7, signal: 0 });
    const output: string[] = [];
    const exits: TerminalProcessExit[] = [];
    process.onData((data) => output.push(data));
    process.onExit((exit) => exits.push(exit));
    expect(output).toEqual(["startup"]);
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(exits).toEqual([{ exitCode: 7, signal: 0 }]);
  });

  it("keeps the PTY source attached across sequential foreground listeners", () => {
    const pty = new FakePty();
    const process = terminalProcessFromPty(pty as unknown as IPty);
    const first: string[] = [];
    const dispose = process.onData((data) => first.push(data));
    pty.emitData("first");
    dispose();
    pty.emitData("between");
    const second: string[] = [];
    process.onData((data) => second.push(data));
    pty.emitData("second");
    expect(first).toEqual(["first"]);
    expect(second).toEqual(["between", "second"]);
  });
});

describe("sanitizedTerminalEnvironment", () => {
  it("keeps native harness configuration but removes the entire Multiplex namespace", () => {
    expect(sanitizedTerminalEnvironment({
      PATH: "/bin",
      CODEX_HOME: "/native-auth",
      AGENT_MULTIPLEX_SHARED_SECRET: "secret",
      AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID: "transport-identity",
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_API_KEY_FILE: "/run/secrets/key",
    })).toEqual({ PATH: "/bin", CODEX_HOME: "/native-auth" });
  });
});

class FakePty {
  readonly pid = 123;
  readonly process = "fake";
  readonly cols = 80;
  readonly rows = 24;
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(event: { exitCode: number; signal?: number }) => void>();
  onData(listener: (data: string) => void): IDisposable {
    this.#data.add(listener);
    return { dispose: () => this.#data.delete(listener) };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): IDisposable {
    this.#exit.add(listener);
    return { dispose: () => this.#exit.delete(listener) };
  }
  write(): void {}
  resize(): void {}
  clear(): void {}
  pause(): void {}
  resume(): void {}
  kill(): void {}
  emitData(data: string): void { for (const listener of this.#data) listener(data); }
  emitExit(event: { exitCode: number; signal?: number }): void {
    for (const listener of this.#exit) listener(event);
  }
}

class HarnessFakeProvider implements TerminalProvider {
  public readonly backend = "mock" as const;
  public readonly sharing = "session" as const;
  public readonly capabilities;
  public readonly opened: FakeProcess[] = [];

  public constructor(
    public readonly harness: Harness,
    public readonly adapterScopeId: AdapterScopeId,
    terminate: boolean,
  ) {
    this.capabilities = {
      write: true,
      resize: true,
      terminate,
      restart: terminate,
      foregroundSwitch: false,
    };
  }

  public async open(): Promise<TerminalProcess> {
    const process = new FakeProcess();
    this.opened.push(process);
    return process;
  }

  public async close(): Promise<void> {}
}

class SharedFakeProvider implements TerminalProvider {
  public readonly harness = "copilot" as const;
  public readonly backend = "mock" as const;
  public readonly sharing = "adapterScope" as const;
  public readonly capabilities = {
    write: true,
    resize: true,
    terminate: false,
    restart: false,
    foregroundSwitch: true,
  } as const;
  public readonly process = new HandoffFakeProcess();
  public readonly opens: TerminalProviderOpenRequest[] = [];
  public readonly foregroundSwitchListenerCounts: number[] = [];
  public closes = 0;

  public constructor(public readonly adapterScopeId: AdapterScopeId) {}

  public async open(request: TerminalProviderOpenRequest): Promise<TerminalProcess> {
    this.opens.push(request);
    if (request.foregroundSwitch) {
      this.foregroundSwitchListenerCounts.push(this.process.dataListeners.size);
      this.process.emit("foreground transition redraw");
    }
    return this.process;
  }

  public async close(): Promise<void> { this.closes += 1; }
}

class ReplacingSharedFakeProvider extends SharedFakeProvider {
  public readonly replacement = new FakeProcess();

  public override async open(request: TerminalProviderOpenRequest): Promise<TerminalProcess> {
    if (!request.foregroundSwitch) return super.open(request);
    this.opens.push(request);
    return this.replacement;
  }
}

class GateProvider extends FakeProvider {
  readonly entered: Promise<void>;
  readonly #markEntered: () => void;
  readonly #gate: Promise<void>;
  readonly #release: () => void;

  public constructor(adapterScopeId: AdapterScopeId) {
    super(adapterScopeId);
    let markEntered = (): void => undefined;
    let release = (): void => undefined;
    this.entered = new Promise((resolve) => { markEntered = resolve; });
    this.#gate = new Promise((resolve) => { release = resolve; });
    this.#markEntered = markEntered;
    this.#release = release;
  }

  public override async open(): Promise<TerminalProcess> {
    this.#markEntered();
    await this.#gate;
    return super.open();
  }

  public release(): void { this.#release(); }
}

function stoppingAdapter(harness: Harness, adapterScopeId: AdapterScopeId): AgentAdapter {
  const session: AdapterSession = {
    harness,
    adapterScopeId,
    vendorSessionId: `${harness}-native-session`,
    cwd: "/tmp",
    runtimeEpoch: newRuntimeEpoch(),
    status: () => "idle",
    subscribe: () => () => undefined,
    execute: async () => ({}),
    readNativeHistory: async (request) => ({
      harness: request.harness,
      vendorSessionId: `${harness}-native-session`,
      payload: [],
      nextCursor: null,
      complete: true,
    }),
    stop: async () => undefined,
  };
  return {
    harness,
    adapterScopeId,
    describe: async () => ({
      harness,
      adapterScopeId,
      available: true,
      capabilities: [],
    }),
    listModels: async () => [],
    listSessions: async () => [],
    spawn: async () => session,
    resume: async () => session,
    close: async () => undefined,
  };
}
