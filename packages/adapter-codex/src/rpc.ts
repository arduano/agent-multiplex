import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { createConnection } from "node:net";

import { toJsonValue, type JsonValue } from "@arduano/agent-multiplex-protocol";
import {
  AdapterOutcomeUnknownError,
  NativeChildProcessOwner,
  NativeOwnerTerminationError,
} from "@arduano/agent-multiplex-runtime-node-core";
import WebSocket, { type RawData } from "ws";

interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export interface CodexNotification {
  method: string;
  params: JsonValue;
}

export interface CodexServerRequest extends CodexNotification {
  id: number | string;
  respond(result: JsonValue): Promise<void>;
  reject(code: number, message: string, data?: JsonValue): Promise<void>;
}

export interface CodexRpcClientOptions {
  binary?: string;
  args?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  clientVersion?: string;
  spawnProcess?: () => ChildProcessWithoutNullStreams;
  /** Async native-runtime preparation performed before the RPC transport starts. */
  prepareProcess?: () => Promise<void>;
  /** Alternate framed transport used by a shared app-server runtime. */
  createConnection?: () => CodexRpcConnection;
  /** Caller observation only; exact pending native IDs remain retained. */
  requestTimeoutMs?: number;
  pendingRequestLimit?: number;
  pendingRequestBytes?: number;
  controlRequestLimit?: number;
  controlRequestBytes?: number;
}

/**
 * One message-framed Codex app-server connection. Implementations own framing:
 * stdio uses JSONL while WebSocket transports use one JSON value per text frame.
 */
export interface CodexRpcConnection {
  start(): Promise<void>;
  send(message: string): Promise<void>;
  close(): Promise<void>;
  onMessage(listener: (message: string) => void): () => void;
  onExit(listener: (error: Error) => void): () => void;
  onDiagnostic?(listener: (message: string) => void): () => void;
}

type Pending = {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  dispatched: boolean;
  lane: "normal" | "control";
  bytes: number;
};

/** Leave room for the published ten-image input envelope, while bounding all
 * admitted native calls. Controls retain independent small reservations. */
export const CODEX_RPC_ADMISSION_LIMITS = Object.freeze({
  pendingRequestLimit: 32, pendingRequestBytes: 160 * 1024 * 1024,
  controlRequestLimit: 8, controlRequestBytes: 1024 * 1024,
});

export class CodexRpcError extends Error {
  public constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown,
    public readonly phase?: "beforeDispatch" | "response",
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

export class CodexRpcPendingError extends AdapterOutcomeUnknownError {
  public constructor(public readonly settlement: Promise<unknown>, public readonly method: string) {
    super("Codex native acknowledgement is pending");
    this.name = "CodexRpcPendingError";
    void settlement.catch(() => {});
  }
}

/** A minimal stdio JSON-RPC client for the native Codex app-server protocol. */
export class CodexRpcClient {
  readonly #options: CodexRpcClientOptions;
  readonly #notifications = new Set<(notification: CodexNotification) => void>();
  readonly #serverRequests = new Set<(request: CodexServerRequest) => void>();
  readonly #exits = new Set<(error: Error) => void>();
  readonly #pending = new Map<number, Pending>();
  readonly #connectionClosures = new WeakMap<CodexRpcConnection, Promise<void>>();
  readonly #retiringConnections = new Map<CodexRpcConnection, Promise<void>>();
  readonly #retired: Promise<void>;
  readonly #retire: () => void;
  #connection: CodexRpcConnection | undefined;
  #connectionDisposers: Array<() => void> = [];
  #nextId = 1;
  #starting: { native: Promise<void>; caller: Promise<void> } | undefined;
  #closing: Promise<void> | undefined;
  #ready = false;
  #closed = false;
  #retirementError: Error | undefined;
  readonly #requestTimeoutMs: number;
  #nativeVersion: string | undefined;
  readonly #admission: Readonly<Record<keyof typeof CODEX_RPC_ADMISSION_LIMITS, number>>;
  readonly #pendingBytes = { normal: 0, control: 0 };

  public constructor(options: CodexRpcClientOptions = {}) {
    this.#options = options;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? (process.platform === "win32" ? 60_000 : 15_000);
    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs < 1 || this.#requestTimeoutMs > 600_000)
      throw new RangeError("Codex request observation budget is invalid");
    this.#admission = Object.freeze({
      pendingRequestLimit: options.pendingRequestLimit ?? CODEX_RPC_ADMISSION_LIMITS.pendingRequestLimit,
      pendingRequestBytes: options.pendingRequestBytes ?? CODEX_RPC_ADMISSION_LIMITS.pendingRequestBytes,
      controlRequestLimit: options.controlRequestLimit ?? CODEX_RPC_ADMISSION_LIMITS.controlRequestLimit,
      controlRequestBytes: options.controlRequestBytes ?? CODEX_RPC_ADMISSION_LIMITS.controlRequestBytes,
    });
    for (const value of Object.values(this.#admission))
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("Codex pending admission limits must be positive integers");
    let retire!: () => void;
    this.#retired = new Promise<void>((resolve) => { retire = resolve; });
    this.#retire = retire;
  }

  public get closing(): boolean { return this.#closed; }
  public get nativeVersion(): string | undefined { return this.#nativeVersion; }
  public get pendingObservation(): { normalCount: number; normalBytes: number; controlCount: number; controlBytes: number } {
    return { normalCount: [...this.#pending.values()].filter(row => row.lane === "normal").length,
      normalBytes: this.#pendingBytes.normal,
      controlCount: [...this.#pending.values()].filter(row => row.lane === "control").length,
      controlBytes: this.#pendingBytes.control };
  }

  public onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.#notifications.add(listener);
    return () => this.#notifications.delete(listener);
  }

  public onServerRequest(listener: (request: CodexServerRequest) => void): () => void {
    this.#serverRequests.add(listener);
    return () => this.#serverRequests.delete(listener);
  }

  public onExit(listener: (error: Error) => void): () => void {
    this.#exits.add(listener);
    return () => this.#exits.delete(listener);
  }

  public async start(): Promise<void> {
    this.#assertOpen();
    if (this.#ready) return;
    if (!this.#starting) {
      const native = this.#start();
      const caller = Promise.race([
        native,
        this.#retired.then(() => { throw this.#retirementError; }),
      ]);
      const starting = { native, caller };
      this.#starting = starting;
      // Caller retirement cannot release a still-pending startup owner.
      void native.then(
        () => { if (this.#starting === starting) this.#starting = undefined; },
        () => { if (this.#starting === starting) this.#starting = undefined; },
      );
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CodexRpcError("Native initialization is still pending before input dispatch",
        undefined, undefined, "beforeDispatch")), this.#requestTimeoutMs);
      timer.unref();
      void this.#starting!.caller.then(() => { clearTimeout(timer); resolve(); }, error => { clearTimeout(timer); reject(error); });
    });
  }

  async #start(): Promise<void> {
    // A disconnected transport can still own a live app-server. Do not
    // construct its replacement before that exact transport proves cleanup.
    await Promise.all(this.#retiringConnections.values());
    this.#assertOpen();
    await this.#options.prepareProcess?.();
    this.#assertOpen();
    const connection = this.#options.createConnection?.() ?? new StdioCodexRpcConnection(() =>
      this.#options.spawnProcess?.() ??
        spawn(this.#options.binary ?? "codex", [...(this.#options.args ?? ["app-server"])], {
          cwd: this.#options.cwd,
          env: this.#options.environment ?? process.env,
          stdio: ["pipe", "pipe", "pipe"],
        }));
    this.#connection = connection;
    this.#connectionDisposers = [
      connection.onMessage((message) => this.#receive(message, connection)),
      connection.onExit((error) => this.#didExit(connection, error)),
      connection.onDiagnostic?.((message) => {
        if (message) {
          for (const listener of this.#notifications) {
            listener({ method: "agent-multiplex/codex-stderr", params: message });
          }
        }
      }) ?? (() => undefined),
    ];
    try {
      await connection.start();
      this.#assertConnection(connection);
      const initialized = await this.#request<{ userAgent?: string }>(connection, "initialize", {
        clientInfo: {
          name: "agent_multiplex",
          title: "Agent Multiplex",
          version: this.#options.clientVersion ?? "0.1.0",
        },
        capabilities: { experimentalApi: true },
      }, false);
      // Initialize returns originator/<CARGO_PKG_VERSION>, not the client version.
      this.#nativeVersion = /^[^/\s]+\/(\d+\.\d+\.\d+)(?:\s|$)/.exec(initialized?.userAgent ?? "")?.[1];
      this.#assertConnection(connection);
      await connection.send(JSON.stringify({ method: "initialized" }));
      this.#assertConnection(connection);
      this.#ready = true;
    } catch (error) {
      this.#disconnect(connection, asError(error));
      try {
        await this.#closeConnection(connection);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Codex RPC startup cleanup failed");
      }
      throw error;
    }
  }

  public async request<T = unknown>(method: string, params: unknown = {},
    admission?: { beforeDispatch?: () => void }): Promise<T> {
    try {
      await this.start();
    } catch (error) {
      // An uncertain handshake does not make this as-yet undispatched request
      // uncertain. In particular, shutdown must not mark a queued native
      // command outcomeUnknown when it never reached the transport.
      this.#assertOpen();
      if (error instanceof AdapterOutcomeUnknownError) {
        throw new CodexRpcError("Codex RPC initialization failed before request dispatch", undefined, undefined, "beforeDispatch");
      }
      throw error;
    }
    const connection = this.#connection;
    this.#assertOpen();
    admission?.beforeDispatch?.();
    if (!connection || !this.#ready) {
      throw new CodexRpcError("codex app-server is not writable", undefined, undefined, "beforeDispatch");
    }
    return this.#request<T>(connection, method, params);
  }

  #request<T = unknown>(connection: CodexRpcConnection, method: string, params: unknown, observe = true): Promise<T> {
    this.#assertConnection(connection);
    const id = this.#nextId;
    let message: string;
    try { message = JSON.stringify({ method, id, params }); }
    catch { throw new CodexRpcError("Native input cannot be serialized before dispatch", -32600, undefined, "beforeDispatch"); }
    const bytes = Buffer.byteLength(message, "utf8");
    const data = params && typeof params === "object" && !Array.isArray(params) ? params as Record<string, unknown> : undefined;
    const lane = method === "initialize" || method === "turn/interrupt" || method === "thread/unsubscribe" ||
      method === "thread/turns/list" && data?.itemsView === "notLoaded" && data.limit === 1 && data.cursor === null
      ? "control" : "normal";
    const count = [...this.#pending.values()].filter(row => row.lane === lane).length;
    const maximumCount = lane === "control" ? this.#admission.controlRequestLimit : this.#admission.pendingRequestLimit;
    const maximumBytes = lane === "control" ? this.#admission.controlRequestBytes : this.#admission.pendingRequestBytes;
    if (count >= maximumCount || this.#pendingBytes[lane] + bytes > maximumBytes)
      throw new CodexRpcError("Native request capacity is occupied; input was not dispatched", undefined, undefined, "beforeDispatch");
    this.#nextId += 1;
    this.#pendingBytes[lane] += bytes;
    const result = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        dispatched: false,
        lane, bytes,
      });
    });
    const pending = this.#pending.get(id)!;
    // Once handed to the transport, a close can race its write callback. Treat
    // that interval as dispatched rather than claiming the native effect failed.
    pending.dispatched = true;
    const failed = (error: unknown) => {
      if (this.#releasePending(id)) {
        const cause = asError(error);
        pending.reject(new AdapterOutcomeUnknownError("Codex RPC write failed after transport dispatch", { cause }));
      }
    };
    try {
      void connection.send(message).catch(failed);
    } catch (error) {
      failed(error);
    }
    return observe ? this.#observe(result, method) : result;
  }

  #observe<T>(settlement: Promise<T>, method: string): Promise<T> {
    void settlement.catch(() => {});
    const observed = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new CodexRpcPendingError(settlement, method)), this.#requestTimeoutMs);
      timer.unref();
      void settlement.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    // Native auto-rejection callers may intentionally discard their observer.
    // Awaiting consumers still receive its actual rejection.
    void observed.catch(() => {});
    return observed;
  }

  #releasePending(id: number): Pending | undefined {
    const pending = this.#pending.get(id);
    if (!pending) return undefined;
    this.#pending.delete(id);
    this.#pendingBytes[pending.lane] -= pending.bytes;
    return pending;
  }

  public notify(method: string, params?: unknown): void {
    this.#assertOpen();
    const connection = this.#connection;
    if (!connection || !this.#ready) throw new CodexRpcError("codex app-server is not writable", undefined, undefined, "beforeDispatch");
    void connection
      .send(JSON.stringify(params === undefined ? { method } : { method, params }))
      .catch((error: unknown) => this.#didExit(connection, asError(error)));
  }

  /** Retire admitted caller waits before Runtime drains them. The transport
   * and its exact process owner remain retained for close() to release. */
  public beginClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#retirementError = this.#starting && this.#pending.size > 0
      ? new AdapterOutcomeUnknownError("Codex RPC initialization was retired after dispatch")
      : new CodexRpcError("Codex RPC client is closed", undefined, undefined, "beforeDispatch");
    this.#retire();
    this.#rejectPending(new CodexRpcError("Codex RPC client is closed", undefined, undefined, "beforeDispatch"));
  }

  public close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.beginClose();
    this.#closing = this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    const connection = this.#connection;
    if (connection) this.#disconnect(connection, new CodexRpcError("Codex RPC client is closed", undefined, undefined, "beforeDispatch"));
    // Close the transport before waiting for startup: its initialize request
    // must be rejected so startup cannot deadlock shutdown.
    const results = await Promise.allSettled([
      connection ? this.#closeConnection(connection) : Promise.resolve(),
      this.#starting?.native,
    ]);
    const retirements = await Promise.allSettled(this.#retiringConnections.values());
    const errors = [...results.slice(0, 1), ...retirements]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map(({ reason }) => reason);
    if (errors.length > 0) throw new AggregateError([...new Set(errors)], "Codex RPC cleanup failed");
  }

  #closeConnection(connection: CodexRpcConnection): Promise<void> {
    let closing = this.#connectionClosures.get(connection);
    if (!closing) {
      closing = Promise.resolve().then(() => connection.close()).catch((cause: unknown) => {
        throw new NativeOwnerTerminationError("Codex RPC transport cleanup was not acknowledged", { cause });
      });
      this.#connectionClosures.set(connection, closing);
      this.#retiringConnections.set(connection, closing);
      void closing.then(
        () => this.#retiringConnections.delete(connection),
        () => undefined,
      );
    }
    return closing;
  }

  #assertOpen(): void {
    if (this.#closed) throw new CodexRpcError("Codex RPC client is closed", undefined, undefined, "beforeDispatch");
  }

  #assertConnection(connection: CodexRpcConnection): void {
    this.#assertOpen();
    if (this.#connection !== connection) throw new CodexRpcError("codex app-server is not writable", undefined, undefined, "beforeDispatch");
  }

  #receive(line: string, owner: CodexRpcConnection): void {
    if (this.#connection !== owner) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      for (const listener of this.#notifications) {
        listener({ method: "agent-multiplex/codex-invalid-json", params: line });
      }
      return;
    }
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.id !== undefined && typeof record.method !== "string") {
      const id = Number(record.id);
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#releasePending(id);
      const response = record as unknown as RpcResponse;
      if (response.error) {
        pending.reject(
          new CodexRpcError(
            response.error.message ?? "Codex app-server request failed",
            response.error.code,
            response.error.data,
            "response",
          ),
        );
      } else {
        pending.resolve(response.result);
      }
      return;
    }
    if (typeof record.method !== "string") return;
    const params = toJsonValue(record.params ?? {});
    if (record.id !== undefined) {
      const id = record.id as number | string;
      let response: Promise<void> | undefined;
      let serialized: string | undefined;
      const reply = (value: unknown): Promise<void> => {
        const encoded = JSON.stringify(value);
        if (response) {
          if (encoded !== serialized) return Promise.reject(new CodexRpcError("A different reply already owns this native request"));
          return response;
        }
        serialized = encoded;
        response = this.#observe(this.#writeServerResponse(owner, encoded), "server/requestReply");
        void response.catch(() => {});
        return response;
      };
      const request: CodexServerRequest = {
        method: record.method, id, params,
        respond: result => reply({ id, result }),
        reject: (code, message, data) => reply({ id, error: { code, message, ...(data === undefined ? {} : { data }) } }),
      };
      if (this.#serverRequests.size === 0) {
        void request.reject(-32601, "No controller is attached to answer this request");
      } else {
        for (const listener of this.#serverRequests) listener(request);
      }
      return;
    }
    const notification = { method: record.method, params };
    for (const listener of this.#notifications) listener(notification);
  }

  async #writeServerResponse(owner: CodexRpcConnection, response: string): Promise<void> {
    if (this.#closed || this.#connection !== owner || !this.#ready)
      throw new AdapterOutcomeUnknownError("Native reply belongs to an unavailable transport");
    try {
      await owner.send(response);
      if (this.#connection !== owner || this.#closed)
        throw new AdapterOutcomeUnknownError("Native reply transport changed before write acknowledgement");
    } catch (cause) {
      this.#didExit(owner, asError(cause));
      throw new AdapterOutcomeUnknownError("Native reply write was not acknowledged", { cause });
    }
  }

  #didExit(connection: CodexRpcConnection, error: Error): void {
    if (!this.#disconnect(connection, error)) return;
    void this.#closeConnection(connection).catch(() => undefined);
    for (const listener of this.#exits) listener(error);
  }

  #disconnect(connection: CodexRpcConnection, error: Error): boolean {
    if (this.#connection !== connection) return false;
    this.#connection = undefined;
    this.#ready = false;
    this.#disposeConnectionListeners();
    this.#rejectPending(error);
    return true;
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(
        pending.dispatched
          ? new AdapterOutcomeUnknownError(error.message, { cause: error })
          : error,
      );
    }
    this.#pending.clear();
    this.#pendingBytes.normal = 0;
    this.#pendingBytes.control = 0;
  }

  #disposeConnectionListeners(): void {
    for (const dispose of this.#connectionDisposers.splice(0)) dispose();
  }
}

/** JSONL connection used by the ordinary one-app-server-per-adapter path. */
class StdioCodexRpcConnection implements CodexRpcConnection {
  readonly #messages = new Set<(message: string) => void>();
  readonly #exits = new Set<(error: Error) => void>();
  readonly #diagnostics = new Set<(message: string) => void>();
  #process: ChildProcessWithoutNullStreams | undefined;
  #owner: NativeChildProcessOwner | undefined;
  #readline: Interface | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #exitEmitted = false;

  public constructor(
    private readonly spawnProcess: () => ChildProcessWithoutNullStreams,
  ) {}

  public onMessage(listener: (message: string) => void): () => void {
    this.#messages.add(listener);
    return () => this.#messages.delete(listener);
  }

  public onExit(listener: (error: Error) => void): () => void {
    this.#exits.add(listener);
    return () => this.#exits.delete(listener);
  }

  public onDiagnostic(listener: (message: string) => void): () => void {
    this.#diagnostics.add(listener);
    return () => this.#diagnostics.delete(listener);
  }

  public async start(): Promise<void> {
    if (this.#closed) throw new CodexRpcError("Codex stdio connection is closed");
    if (this.#process) return;
    const child = this.spawnProcess();
    this.#process = child;
    this.#owner = new NativeChildProcessOwner(child);
    this.#readline = createInterface({ input: child.stdout });
    this.#readline.on("line", (line) => {
      for (const listener of this.#messages) listener(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (!message) return;
      for (const listener of this.#diagnostics) listener(message);
    });
    child.once("error", (error) => this.#emitExit(error));
    child.once("exit", (code, signal) => {
      this.#emitExit(new CodexRpcError(
        `codex app-server exited${code === null ? "" : ` with code ${code}`}${signal ? ` (${signal})` : ""}`,
      ));
    });
  }

  public async send(message: string): Promise<void> {
    const child = this.#process;
    if (!child || child.killed || !child.stdin.writable) {
      throw new CodexRpcError("codex app-server is not writable", undefined, undefined, "beforeDispatch");
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${message}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  public close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#readline?.close();
    this.#readline = undefined;
    await this.#owner?.terminate();
    this.#process = undefined;
    this.#owner = undefined;
  }

  #emitExit(error: Error): void {
    if (this.#exitEmitted) return;
    this.#exitEmitted = true;
    this.#readline?.close();
    this.#readline = undefined;
    for (const listener of this.#exits) listener(error);
  }
}

/** WebSocket-over-Unix transport required by `codex app-server --listen unix://...`. */
export class CodexUnixSocketRpcConnection implements CodexRpcConnection {
  readonly #messages = new Set<(message: string) => void>();
  readonly #exits = new Set<(error: Error) => void>();
  #socket: WebSocket | undefined;
  #starting: Promise<void> | undefined;
  #closed = false;
  #exitEmitted = false;

  public constructor(
    private readonly socketPath: string,
    private readonly handshakeTimeoutMs = 10_000,
  ) {}

  public onMessage(listener: (message: string) => void): () => void {
    this.#messages.add(listener);
    return () => this.#messages.delete(listener);
  }

  public onExit(listener: (error: Error) => void): () => void {
    this.#exits.add(listener);
    return () => this.#exits.delete(listener);
  }

  public async start(): Promise<void> {
    if (this.#closed) throw new CodexRpcError("Codex Unix socket connection is closed");
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#starting) return this.#starting;
    const pending = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket("ws://localhost/rpc", {
        createConnection: () => createConnection(this.socketPath),
        handshakeTimeout: this.handshakeTimeoutMs,
        // Codex's Unix listener currently rejects extension negotiation. The
        // protocol carries JSON, so compression is unnecessary on a local UDS.
        perMessageDeflate: false,
      });
      this.#socket = socket;
      let opened = false;
      socket.once("open", () => {
        opened = true;
        resolve();
      });
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) {
          this.#emitExit(new CodexRpcError("Codex app-server sent a binary WebSocket message"));
          socket.terminate();
          return;
        }
        const message = rawDataString(data);
        for (const listener of this.#messages) listener(message);
      });
      socket.once("error", (error) => {
        if (!opened) reject(error);
        else this.#emitExit(error);
      });
      socket.once("close", (code, reason) => {
        this.#socket = undefined;
        const error = new CodexRpcError(
          `Codex app-server WebSocket closed with code ${code}${reason.byteLength ? `: ${reason.toString("utf8")}` : ""}`,
        );
        if (!opened) reject(error);
        else if (!this.#closed) this.#emitExit(error);
      });
    });
    this.#starting = pending;
    try {
      await pending;
    } finally {
      if (this.#starting === pending) this.#starting = undefined;
    }
  }

  public async send(message: string): Promise<void> {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new CodexRpcError("codex app-server WebSocket is not writable");
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(message, (error) => (error ? reject(error) : resolve()));
    });
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    if (socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
      return;
    }
    socket.close(1000, "Agent Multiplex connection closed");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 1_000);
      timer.unref();
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #emitExit(error: Error): void {
    if (this.#closed || this.#exitEmitted) return;
    this.#exitEmitted = true;
    for (const listener of this.#exits) listener(error);
  }
}

function rawDataString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new CodexRpcError(String(error));
}
