import { TRPCError } from "@trpc/server";
import { serialize } from "node:v8";

import { ControlNodeCoreError, type ControlNodeCoreErrorCode } from "./errors.js";

export const ISOLATED_RPC_LIMITS = Object.freeze({ pending: 256, pendingBytes: 32 * 1024 * 1024, messageBytes: 8 * 1024 * 1024, timeoutMs: 30_000, streams: 128 });
type Failure = { kind: "control"; code: ControlNodeCoreErrorCode; message: string } | { kind: "trpc"; code: TRPCError["code"]; message: string };
type Request = { kind: "request"; id: number; method: string; args: unknown[]; mutation: boolean; deadlineAt?: number };
type Response = { kind: "response"; id: number; result?: unknown; failure?: Failure };
type ResponseAck = { kind: "response.ack"; id: number };
type Pending = { bytes: number; startedAt: number; mutation: boolean; lateResult?: (value: unknown) => void; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | undefined; expired: boolean };
export interface IsolatedMessagePort { postMessage(value: unknown): void; on(event: "message", listener: (message: any) => void): unknown; off(event: "message", listener: (message: any) => void): unknown }
export type IsolatedRpcHandler = (method: string, args: unknown[]) => unknown | Promise<unknown>;

/** Private process-local messages. Callers expose an explicit domain-method allowlist.
 * Timed-out requests retain their slot until actual settlement; no RPC is replayed. */
export class IsolatedRpc {
  readonly #pending = new Map<number, Pending>();
  readonly #port: IsolatedMessagePort;
  readonly #handler: IsolatedRpcHandler;
  readonly #limits: typeof ISOLATED_RPC_LIMITS;
  #next = 0;
  #bytes = 0;
  #closed = false;
  #incoming = 0;
  #incomingBytes = 0;
  #responseBytes = 0;
  readonly #received = new Map<number, { bytes: number; responseBytes: number }>();
  readonly #receive: (message: Request | Response | ResponseAck) => void;
  constructor(port: IsolatedMessagePort, handler: IsolatedRpcHandler, limits: Partial<typeof ISOLATED_RPC_LIMITS> = {}) {
    this.#port = port; this.#handler = handler; this.#limits = { ...ISOLATED_RPC_LIMITS, ...limits };
    this.#receive = message => {
      if (this.#closed) return;
      if (message.kind === "response") {
        // Release the sender's response budget only once its message has been
        // consumed on this thread, including replies to retired callers.
        this.#port.postMessage({ kind: "response.ack", id: message.id } satisfies ResponseAck);
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id); this.#bytes -= pending.bytes; clearTimeout(pending.timer);
        if (!pending.expired) {
          if (message.failure) pending.reject(message.failure.kind === "trpc" ? new TRPCError({ code: message.failure.code, message: message.failure.message }) : new ControlNodeCoreError(message.failure.code, message.failure.message));
          else pending.resolve(message.result);
        } else if (!message.failure) { try { pending.lateResult?.(message.result); } catch { /* Cleanup cannot change a retired outcome. */ } }
      } else if (message.kind === "request") {
        if (message.deadlineAt !== undefined && Date.now() >= message.deadlineAt) {
          this.#respond(message, undefined, new ControlNodeCoreError("UNAVAILABLE", "control storage request expired before admission")); return;
        }
        let bytes: number;
        try { bytes = serialize(message.args).byteLength; } catch { return; }
        if (bytes > this.#limits.messageBytes || this.#incoming >= this.#limits.pending || this.#incomingBytes + bytes > this.#limits.pendingBytes) { this.#respond(message, undefined, new ControlNodeCoreError("UNAVAILABLE", "control storage request capacity reached before admission")); return; }
        this.#incoming++; this.#incomingBytes += bytes;
        this.#received.set(message.id, { bytes, responseBytes: 0 });
        void Promise.resolve().then(() => this.#handler(message.method, message.args))
          .then(result => this.#respond(message, result), error => this.#respond(message, undefined, error));
      } else if (message.kind === "response.ack") {
        const received = this.#received.get(message.id);
        if (received) { this.#received.delete(message.id); this.#incoming--; this.#incomingBytes -= received.bytes; this.#responseBytes -= received.responseBytes; }
      }
    };
    port.on("message", this.#receive);
  }
  call<T>(method: string, args: unknown[] = [], options: { mutation?: boolean; timeoutMs?: number; lateResult?: (value: unknown) => void } = {}): Promise<T> {
    if (this.#closed) return Promise.reject(new ControlNodeCoreError("UNAVAILABLE", "control storage owner is unavailable"));
    let bytes: number;
    try { bytes = serialize(args).byteLength; } catch { return Promise.reject(new ControlNodeCoreError("UNSUPPORTED", "control storage request is not transferable")); }
    if (bytes > this.#limits.messageBytes || this.#pending.size >= this.#limits.pending || this.#bytes + bytes > this.#limits.pendingBytes) {
      return Promise.reject(new ControlNodeCoreError("UNAVAILABLE", "control storage request capacity reached before admission"));
    }
    const id = ++this.#next;
    return new Promise<T>((resolve, reject) => {
      const pending: Pending = { bytes, startedAt: Date.now(), mutation: options.mutation === true, ...(options.lateResult ? { lateResult: options.lateResult } : {}), resolve: value => resolve(value as T), reject, expired: false,
        timer: options.timeoutMs === 0 ? undefined : setTimeout(() => {
          pending.expired = true;
          reject(new ControlNodeCoreError(options.mutation ? "OUTCOME_UNKNOWN" : "UNAVAILABLE", options.mutation
            ? "control storage response timed out; reconcile the original operation ID"
            : "control storage is not responding"));
        }, options.timeoutMs ?? this.#limits.timeoutMs) };
      pending.timer?.unref(); this.#pending.set(id, pending); this.#bytes += bytes;
      try { this.#port.postMessage({ kind: "request", id, method, args, mutation: pending.mutation,
        ...(options.timeoutMs === 0 ? {} : { deadlineAt: pending.startedAt + (options.timeoutMs ?? this.#limits.timeoutMs) }) } satisfies Request); }
      catch { clearTimeout(pending.timer); this.#pending.delete(id); this.#bytes -= bytes; reject(new ControlNodeCoreError("UNAVAILABLE", "control storage request could not be delivered")); }
    });
  }
  diagnostics() {
    return { pending: this.#pending.size, pendingBytes: this.#bytes, incoming: this.#incoming, incomingBytes: this.#incomingBytes, responseBytes: this.#responseBytes, expired: [...this.#pending.values()].filter(x => x.expired).length,
      oldestMs: this.#pending.size ? Date.now() - Math.min(...[...this.#pending.values()].map(x => x.startedAt)) : 0, closed: this.#closed };
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#port.off("message", this.#receive);
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new ControlNodeCoreError(pending.mutation ? "OUTCOME_UNKNOWN" : "UNAVAILABLE", pending.mutation ? "control storage owner exited; reconcile the original operation ID" : "control storage owner exited")); }
    this.#pending.clear(); this.#bytes = 0;
    this.#received.clear(); this.#incoming = 0; this.#incomingBytes = 0; this.#responseBytes = 0;
  }
  #respond(request: Request, result: unknown, error?: unknown): void {
    if (this.#closed) return;
    let failure: Failure | undefined;
    const uncertain = (message: string): Failure => ({ kind: "control", code: request.mutation ? "OUTCOME_UNKNOWN" : "UNAVAILABLE", message });
    if (error !== undefined) failure = error instanceof TRPCError && !(request.mutation && error.code === "INTERNAL_SERVER_ERROR") ? { kind: "trpc", code: error.code, message: error.message } : error instanceof ControlNodeCoreError
      ? { kind: "control", code: error.code, message: error.message }
      : uncertain("control storage operation failed; reconcile any submitted operation ID");
    try {
      if (failure === undefined) {
        try { if (serialize(result).byteLength > this.#limits.messageBytes) failure = uncertain("control storage response exceeds transfer capacity; reconcile any submitted operation ID"); }
        catch { failure = uncertain("control storage response is not transferable; reconcile any submitted operation ID"); }
      }
      let response: Response = { kind: "response", id: request.id, ...(failure ? { failure } : { result }) };
      let bytes = serialize(response).byteLength;
      if (!failure && this.#responseBytes + bytes > this.#limits.pendingBytes) {
        response = { kind: "response", id: request.id, failure: uncertain("control storage response capacity reached; reconcile any submitted operation ID") };
        bytes = serialize(response).byteLength;
      }
      const received = this.#received.get(request.id);
      if (received) { received.responseBytes = bytes; this.#responseBytes += bytes; }
      this.#port.postMessage(response);
    } catch { this.close(); }
  }
}

/** Pulling requests one item at a time; cancellation never spawns another lane. */
export function isolatedStream<T>(rpc: IsolatedRpc, method: string, args: unknown[], signal?: AbortSignal): AsyncIterable<T> {
  return { async *[Symbol.asyncIterator]() {
    if (signal?.aborted) return;
    let id: number | undefined;
    let closed = false;
    const close = (value: number) => {
      if (closed) return;
      closed = true;
      void rpc.call("stream.close", [value]).catch(() => {});
    };
    const abort = () => { if (id !== undefined) close(id); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      id = await rpc.call<number>("stream.open", [method, args], { lateResult: value => close(Number(value)) });
      if (signal?.aborted) return;
      while (!signal?.aborted) {
        // Idle native streams have no deadline. Their underlying iterator and
        // IPC lane remain occupied until data, cancellation or owner exit.
        const item = await rpc.call<IteratorResult<T>>("stream.next", [id], { timeoutMs: 0 });
        if (item.done || signal?.aborted) return;
        yield item.value;
      }
    } finally { signal?.removeEventListener("abort", abort); if (id !== undefined) close(id); }
  } };
}

type StreamEntry = {
  iterator?: AsyncIterator<unknown>;
  opening?: Promise<void>;
  controller: AbortController;
  pulling: boolean;
  closing?: Promise<void>;
};
export class IsolatedStreams {
  readonly #streams = new Map<number, StreamEntry>();
  #id = 0;
  #closed = false;
  #reserve(): [number, StreamEntry] {
    if (this.#closed || this.#streams.size >= ISOLATED_RPC_LIMITS.streams) throw new ControlNodeCoreError("UNAVAILABLE", "control stream capacity reached or owner closing");
    const id = ++this.#id;
    const stream: StreamEntry = { controller: new AbortController(), pulling: false };
    this.#streams.set(id, stream);
    return [id, stream];
  }
  async openAsync(create: (signal: AbortSignal) => Promise<AsyncIterable<unknown>>): Promise<number> {
    const [id, stream] = this.#reserve();
    stream.opening = Promise.resolve().then(async () => {
      const iterable = await create(stream.controller.signal);
      stream.iterator = iterable[Symbol.asyncIterator]();
    });
    try {
      await stream.opening;
      if (stream.controller.signal.aborted) throw new ControlNodeCoreError("UNAVAILABLE", "control stream owner closed while opening");
      return id;
    } catch (error) {
      if (!stream.closing) void this.close(id).catch(() => {});
      throw error;
    }
  }
  open(create: (signal: AbortSignal) => AsyncIterable<unknown>): number {
    const [id, stream] = this.#reserve();
    try { stream.iterator = create(stream.controller.signal)[Symbol.asyncIterator](); return id; }
    catch (error) { this.#streams.delete(id); throw error; }
  }
  async next(id: number): Promise<IteratorResult<unknown>> {
    const stream = this.#streams.get(id);
    if (!stream || stream.closing) return { done: true, value: undefined };
    if (stream.pulling || !stream.iterator) throw new ControlNodeCoreError("CONFLICT", "control stream already has a pending read or open");
    stream.pulling = true;
    try {
      const item = await stream.iterator.next();
      if (item.done) { stream.controller.abort(); this.#streams.delete(id); }
      return item;
    } finally { stream.pulling = false; }
  }
  close(id: number): Promise<void> {
    const stream = this.#streams.get(id);
    if (!stream) return Promise.resolve();
    if (stream.closing) return stream.closing;
    stream.controller.abort();
    stream.closing = Promise.resolve().then(async () => {
      try { await stream.opening; } catch { /* The opening caller observes its failure. */ }
      try { await stream.iterator?.return?.(); } finally { this.#streams.delete(id); }
    });
    return stream.closing;
  }
  diagnostics() { return { streams: this.#streams.size, closed: this.#closed }; }
  closeAll(): void { this.#closed = true; for (const id of this.#streams.keys()) void this.close(id).catch(() => {}); }
}
