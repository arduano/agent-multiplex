import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { createConnection } from "node:net";

import { toJsonValue, type JsonValue } from "@arduano/agent-multiplex-protocol";
import { AdapterOutcomeUnknownError } from "@arduano/agent-multiplex-runtime-node-core";
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
  respond(result: JsonValue): void;
  reject(code: number, message: string, data?: JsonValue): void;
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
};

export class CodexRpcError extends Error {
  public constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "CodexRpcError";
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
  #connection: CodexRpcConnection | undefined;
  #connectionDisposers: Array<() => void> = [];
  #nextId = 1;
  #starting: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #ready = false;
  #closed = false;

  public constructor(options: CodexRpcClientOptions = {}) {
    this.#options = options;
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
    if (this.#starting) return this.#starting;
    if (this.#ready) return;
    this.#starting = this.#start();
    try {
      await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #start(): Promise<void> {
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
      connection.onMessage((message) => this.#receive(message)),
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
      await this.#request(connection, "initialize", {
        clientInfo: {
          name: "agent_multiplex",
          title: "Agent Multiplex",
          version: this.#options.clientVersion ?? "0.1.0",
        },
        capabilities: { experimentalApi: true },
      });
      this.#assertConnection(connection);
      await connection.send(JSON.stringify({ method: "initialized" }));
      this.#assertConnection(connection);
      this.#ready = true;
    } catch (error) {
      this.#disconnect(connection, asError(error));
      await this.#closeConnection(connection).catch(() => undefined);
      throw error;
    }
  }

  public async request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    try {
      await this.start();
    } catch (error) {
      // An uncertain handshake does not make this as-yet undispatched request
      // uncertain. In particular, shutdown must not mark a queued native
      // command outcomeUnknown when it never reached the transport.
      this.#assertOpen();
      if (error instanceof AdapterOutcomeUnknownError) {
        throw new CodexRpcError("Codex RPC initialization failed before request dispatch");
      }
      throw error;
    }
    const connection = this.#connection;
    this.#assertOpen();
    if (!connection || !this.#ready) {
      throw new CodexRpcError("codex app-server is not writable");
    }
    return this.#request<T>(connection, method, params);
  }

  #request<T = unknown>(connection: CodexRpcConnection, method: string, params: unknown): Promise<T> {
    this.#assertConnection(connection);
    const id = this.#nextId++;
    const message = JSON.stringify({ method, id, params });
    const result = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        dispatched: false,
      });
    });
    const pending = this.#pending.get(id)!;
    // Once handed to the transport, a close can race its write callback. Treat
    // that interval as dispatched rather than claiming the native effect failed.
    pending.dispatched = true;
    const failed = (error: unknown) => {
      if (this.#pending.delete(id)) pending.reject(asError(error));
    };
    try {
      void connection.send(message).catch(failed);
    } catch (error) {
      failed(error);
    }
    return result;
  }

  public notify(method: string, params?: unknown): void {
    this.#assertOpen();
    const connection = this.#connection;
    if (!connection || !this.#ready) throw new CodexRpcError("codex app-server is not writable");
    void connection
      .send(JSON.stringify(params === undefined ? { method } : { method, params }))
      .catch((error: unknown) => this.#didExit(connection, asError(error)));
  }

  public close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    this.#closing = this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    const connection = this.#connection;
    if (connection) this.#disconnect(connection, new CodexRpcError("Codex RPC client is closed"));
    // Close the transport before waiting for startup: its initialize request
    // must be rejected so startup cannot deadlock shutdown.
    const [closed] = await Promise.allSettled([
      connection ? this.#closeConnection(connection) : Promise.resolve(),
      this.#starting,
    ]);
    if (closed.status === "rejected") throw closed.reason;
  }

  #closeConnection(connection: CodexRpcConnection): Promise<void> {
    let closing = this.#connectionClosures.get(connection);
    if (!closing) {
      closing = Promise.resolve().then(() => connection.close());
      this.#connectionClosures.set(connection, closing);
    }
    return closing;
  }

  #assertOpen(): void {
    if (this.#closed) throw new CodexRpcError("Codex RPC client is closed");
  }

  #assertConnection(connection: CodexRpcConnection): void {
    this.#assertOpen();
    if (this.#connection !== connection) throw new CodexRpcError("codex app-server is not writable");
  }

  #receive(line: string): void {
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
      this.#pending.delete(id);
      const response = record as unknown as RpcResponse;
      if (response.error) {
        pending.reject(
          new CodexRpcError(
            response.error.message ?? "Codex app-server request failed",
            response.error.code,
            response.error.data,
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
      let settled = false;
      const request: CodexServerRequest = {
        method: record.method,
        id,
        params,
        respond: (result) => {
          if (settled) return;
          settled = true;
          this.#writeServerResponse({ id, result });
        },
        reject: (code, message, data) => {
          if (settled) return;
          settled = true;
          this.#writeServerResponse({
            id,
            error: { code, message, ...(data === undefined ? {} : { data }) },
          });
        },
      };
      if (this.#serverRequests.size === 0) {
        request.reject(-32601, "No controller is attached to answer this request");
      } else {
        for (const listener of this.#serverRequests) listener(request);
      }
      return;
    }
    const notification = { method: record.method, params };
    for (const listener of this.#notifications) listener(notification);
  }

  #writeServerResponse(response: unknown): void {
    const connection = this.#connection;
    if (!connection) return;
    void connection.send(JSON.stringify(response)).catch((error: unknown) => {
      this.#didExit(connection, asError(error));
    });
  }

  #didExit(connection: CodexRpcConnection, error: Error): void {
    if (!this.#disconnect(connection, error)) return;
    for (const listener of this.#exits) listener(error);
  }

  #disconnect(connection: CodexRpcConnection, error: Error): boolean {
    if (this.#connection !== connection) return false;
    this.#connection = undefined;
    this.#ready = false;
    this.#disposeConnectionListeners();
    for (const pending of this.#pending.values()) {
      pending.reject(
        pending.dispatched
          ? new AdapterOutcomeUnknownError(error.message, { cause: error })
          : error,
      );
    }
    this.#pending.clear();
    return true;
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
  #readline: Interface | undefined;
  #closed = false;

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
      throw new CodexRpcError("codex app-server is not writable");
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${message}\n`, (error) => (error ? reject(error) : resolve()));
    });
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const child = this.#process;
    this.#process = undefined;
    this.#readline?.close();
    this.#readline = undefined;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
        resolve();
      }, 3_000);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #emitExit(error: Error): void {
    if (!this.#process) return;
    this.#process = undefined;
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
