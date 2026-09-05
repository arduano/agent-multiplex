import { AdapterOutcomeUnknownError } from "@arduano/agent-multiplex-runtime-node-core";
import { describe, expect, it, vi } from "vitest";

import { CodexRpcClient, CodexRpcError, type CodexRpcConnection } from "../src/rpc.js";

describe("Codex RPC lifecycle", () => {
  it("holds concurrent callers until transport startup and the complete handshake finish", async () => {
    const transport = deferred();
    const initialized = deferred();
    const connection = new FakeConnection({ startGate: transport.promise });
    connection.sendGates.set("initialized", initialized.promise);
    const prepareProcess = vi.fn(async () => undefined);
    const rpc = new CodexRpcClient({ prepareProcess, createConnection: () => connection });
    const starting = rpc.start();
    await connection.started.promise;
    const alsoStarting = rpc.start();
    const first = rpc.request("thread/start");
    const second = rpc.request("model/list");
    expect(connection.sent).toEqual([]);

    transport.resolve();
    await connection.waitForMethod("initialize");
    expect(connection.methods()).toEqual(["initialize"]);
    connection.respond("initialize", {});
    await connection.waitForMethod("initialized");
    expect(connection.methods()).toEqual(["initialize", "initialized"]);
    expect(() => rpc.notify("early-notification")).toThrow("not writable");
    initialized.resolve();

    await Promise.all([starting, alsoStarting, first, second]);
    expect(connection.methods()).toEqual(["initialize", "initialized", "thread/start", "model/list"]);
    expect(prepareProcess).toHaveBeenCalledTimes(1);
    expect(connection.startCalls).toBe(1);
    await rpc.close();
  });

  it("waits for preparation on close and never creates its late transport", async () => {
    const preparation = deferred();
    const createConnection = vi.fn(() => new FakeConnection());
    const rpc = new CodexRpcClient({ prepareProcess: () => preparation.promise, createConnection });
    const starting = rpc.start();
    const rejected = expect(starting).rejects.toThrow("closed");
    const closing = rpc.close();
    expect(rpc.close()).toBe(closing);
    let closed = false;
    void closing.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    preparation.resolve();

    await Promise.all([closing, rejected]);
    expect(createConnection).not.toHaveBeenCalled();
    await expect(rpc.start()).rejects.toThrow("closed");
    await expect(rpc.request("thread/start")).rejects.toThrow("closed");
  });

  it("does not initialize a transport whose startup completes after close", async () => {
    const transport = deferred();
    const connection = new FakeConnection({ startGate: transport.promise });
    const rpc = new CodexRpcClient({ createConnection: () => connection });
    const starting = rpc.start();
    const rejected = expect(starting).rejects.toThrow("closed");
    await connection.started.promise;
    const closing = rpc.close();
    await connection.closing.promise;
    transport.resolve();

    await Promise.all([closing, rejected]);
    expect(connection.sent).toEqual([]);
    expect(connection.closeCalls).toBe(1);
  });

  it("settles initialization and queued callers when closed before the handshake reply", async () => {
    const connection = new FakeConnection();
    const rpc = new CodexRpcClient({ createConnection: () => connection });
    const starting = rpc.start();
    const queued = rpc.request("thread/start");
    const rejections = [
      expect(starting).rejects.toBeInstanceOf(AdapterOutcomeUnknownError),
      expect(queued).rejects.toBeInstanceOf(CodexRpcError),
    ];
    await connection.waitForMethod("initialize");
    await rpc.close();
    await Promise.all(rejections);

    expect(connection.methods()).toEqual(["initialize"]);
    expect(connection.closeCalls).toBe(1);
    connection.respond("initialize", {});
    expect(connection.methods()).toEqual(["initialize"]);
  });

  it("rejects a pending dispatched request on close even while its write callback is pending", async () => {
    const write = deferred();
    const connection = new FakeConnection({ autoInitialize: true });
    connection.sendGates.set("turn/start", write.promise);
    connection.unanswered.add("turn/start");
    const rpc = new CodexRpcClient({ createConnection: () => connection });
    const request = rpc.request("turn/start");
    const rejected = expect(request).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    await connection.waitForMethod("turn/start");

    await rpc.close();
    await rejected;
    write.reject(new Error("write closed"));
    await Promise.resolve();
    expect(connection.closeCalls).toBe(1);
  });

  it("shares close completion and failure across callers", async () => {
    const cleanup = deferred();
    const connection = new FakeConnection({ autoInitialize: true, closeGate: cleanup.promise });
    const rpc = new CodexRpcClient({ createConnection: () => connection });
    await rpc.start();
    const first = rpc.close();
    const second = rpc.close();
    expect(second).toBe(first);
    const rejected = expect(first).rejects.toThrow("cleanup failed");
    await connection.closing.promise;
    cleanup.reject(new Error("cleanup failed"));
    await rejected;
    expect(rpc.close()).toBe(first);
    expect(connection.closeCalls).toBe(1);
  });

  it.each(["transport", "initialize", "initialized"] as const)(
    "can retry after a failed %s startup stage without sending queued requests on the failed connection",
    async (stage) => {
      const broken = new FakeConnection({
        autoInitialize: stage !== "initialize",
        ...(stage === "transport" ? { startError: new Error("startup failed") } : {}),
      });
      if (stage === "initialized") broken.sendErrors.set("initialized", new Error("startup failed"));
      const replacement = new FakeConnection({ autoInitialize: true });
      const createConnection = vi.fn().mockReturnValueOnce(broken).mockReturnValue(replacement);
      const rpc = new CodexRpcClient({ createConnection });
      const first = rpc.request("thread/start");
      const second = rpc.request("model/list");
      const rejections = [
        expect(first).rejects.toThrow("startup failed"),
        expect(second).rejects.toThrow("startup failed"),
      ];
      if (stage === "initialize") {
        await broken.waitForMethod("initialize");
        broken.rejectResponse("initialize", "startup failed");
      }
      await Promise.all(rejections);
      expect(broken.methods()).not.toContain("thread/start");
      expect(broken.methods()).not.toContain("model/list");
      expect(broken.closeCalls).toBe(1);

      await expect(rpc.request("thread/start")).resolves.toEqual({ method: "thread/start" });
      expect(replacement.methods()).toEqual(["initialize", "initialized", "thread/start"]);
      await rpc.close();
    },
  );

  it("can retry preparation after it fails without creating the first connection", async () => {
    const connection = new FakeConnection({ autoInitialize: true });
    const prepareProcess = vi.fn().mockRejectedValueOnce(new Error("preparation failed")).mockResolvedValue(undefined);
    const createConnection = vi.fn(() => connection);
    const rpc = new CodexRpcClient({ prepareProcess, createConnection });
    await expect(rpc.start()).rejects.toThrow("preparation failed");
    expect(createConnection).not.toHaveBeenCalled();
    await rpc.start();
    expect(createConnection).toHaveBeenCalledTimes(1);
    await rpc.close();
  });
});

interface Message {
  method: string;
  id?: number;
}

class FakeConnection implements CodexRpcConnection {
  readonly sent: Message[] = [];
  readonly sendGates = new Map<string, Promise<void>>();
  readonly sendErrors = new Map<string, Error>();
  readonly unanswered = new Set<string>();
  readonly started = deferred();
  readonly closing = deferred();
  readonly #messages = new Set<(message: string) => void>();
  readonly #exits = new Set<(error: Error) => void>();
  readonly #waiting = new Map<string, ReturnType<typeof deferred>>();
  startCalls = 0;
  closeCalls = 0;

  constructor(private readonly options: {
    startGate?: Promise<void>;
    closeGate?: Promise<void>;
    startError?: Error;
    autoInitialize?: boolean;
  } = {}) {}

  onMessage(listener: (message: string) => void): () => void {
    this.#messages.add(listener);
    return () => { this.#messages.delete(listener); };
  }

  onExit(listener: (error: Error) => void): () => void {
    this.#exits.add(listener);
    return () => { this.#exits.delete(listener); };
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    this.started.resolve();
    await this.options.startGate;
    if (this.options.startError) throw this.options.startError;
  }

  async send(encoded: string): Promise<void> {
    const message = JSON.parse(encoded) as Message;
    this.sent.push(message);
    this.#waiting.get(message.method)?.resolve();
    await this.sendGates.get(message.method);
    const error = this.sendErrors.get(message.method);
    if (error) throw error;
    if (message.id !== undefined && !this.unanswered.has(message.method) &&
      (message.method !== "initialize" || this.options.autoInitialize)) {
      this.respond(message.method, { method: message.method });
    }
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.closing.resolve();
    await this.options.closeGate;
    for (const listener of this.#exits) listener(new Error("transport closed"));
  }

  methods(): string[] {
    return this.sent.map(({ method }) => method);
  }

  waitForMethod(method: string): Promise<void> {
    if (this.sent.some((message) => message.method === method)) return Promise.resolve();
    let waiting = this.#waiting.get(method);
    if (!waiting) {
      waiting = deferred();
      this.#waiting.set(method, waiting);
    }
    return waiting.promise;
  }

  respond(method: string, result: unknown): void {
    this.#respond(method, { result });
  }

  rejectResponse(method: string, message: string): void {
    this.#respond(method, { error: { code: -32000, message } });
  }

  #respond(method: string, response: object): void {
    const request = this.sent.findLast((message) => message.method === method);
    if (request?.id === undefined) throw new Error(`No pending ${method} request`);
    for (const listener of this.#messages) listener(JSON.stringify({ id: request.id, ...response }));
  }
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
