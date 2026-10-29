import type {
  CodexWire,
  CodexWireFactory,
  Notification,
  ReverseRequest,
} from "../node-contracts.js";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { CODEX_VERSION } from "../contracts.js";
import { check, CodexError, object } from "./validation.js";

/** Only open calls this factory. Ending its attachment is not native Stop. */
export const spawnCodexWire: CodexWireFactory = (input) => {
  const child = spawn(input.node, [input.launcher, "app-server", "--stdio"], {
    cwd: input.cwd,
    env: { ...input.environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const data = new Set<(value: string) => void>(),
    closes = new Set<() => void>(),
    decoder = new StringDecoder("utf8");
  let ended = false,
    closing: Promise<void> | undefined;
  const exit = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const end = () => {
    if (ended) return;
    ended = true;
    for (const listener of closes)
      try {
        listener();
      } catch {}
  };
  child.on("error", end);
  child.stdin.on("error", end);
  child.stdout.once("end", end);
  child.once("exit", end);
  child.stdout.on("data", (chunk: Buffer) => {
    const value = decoder.write(chunk);
    for (const listener of data) listener(value);
  });
  child.stderr.resume(); // No raw private native diagnostics are printed or retained.
  return {
    write: (line) =>
      new Promise((resolve, reject) => {
        if (ended) {
          reject(new CodexError("WIRE_LOST"));
          return;
        }
        child.stdin.write(line, (error) =>
          error ? reject(new CodexError("WRITE_UNKNOWN")) : resolve(),
        );
      }),
    onData(listener) {
      data.add(listener);
      return () => {
        data.delete(listener);
      };
    },
    onClose(listener) {
      closes.add(listener);
      if (ended) listener();
      return () => {
        closes.delete(listener);
      };
    },
    close() {
      return (closing ??= (async () => {
        child.stdin.end();
        end();
        const wait = async (ms: number) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              exit.then(() => true),
              new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), ms);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        };
        if (await wait(4000)) return;
        child.kill("SIGKILL");
        check(await wait(1000), "ATTACHMENT_CLEANUP_UNKNOWN");
      })());
    },
  };
};

type Pending = {
  method: string;
  empty: boolean;
  resolve(value: unknown): void;
  reject(error: unknown): void;
};
type Reverse = {
  capability: object;
  responded: boolean;
  ambiguous: boolean;
  resolve(): void;
  reject(error: unknown): void;
};
/** One connection, no reconnect or retry. Limits apply to frames/pending work,
 * not to accumulated lifetime message counts. Reverse IDs are incarnations. */
export class CodexRpc {
  readonly #pending = new Map<number, Pending>();
  readonly #reverse = new Map<string, Reverse>();
  readonly #release: readonly (() => void)[];
  #buffer = "";
  #bytes = 0;
  #next = 0;
  #failed = false;
  #turnStarts = 0;
  #itemStarts = 0;
  constructor(
    readonly wire: CodexWire,
    readonly notification: (value: Notification) => void,
    readonly reverse: (value: ReverseRequest) => void,
    readonly lost: () => void,
  ) {
    this.#release = [wire.onData((value) => this.#data(value)), wire.onClose(() => this.#fail())];
  }
  get observation() {
    return {
      connected: !this.#failed,
      pending: this.#pending.size,
      reverse: this.#reverse.size,
      turnStarts: this.#turnStarts,
      itemStarts: this.#itemStarts,
    };
  }
  async initialize(): Promise<void> {
    const response = object(
      await this.request("initialize", {
        clientInfo: { name: "agent_multiplex", title: "Agent Multiplex", version: "0.8.0" },
        capabilities: { experimentalApi: true },
      }),
    );
    check(
      typeof response.userAgent === "string" &&
        response.userAgent.split(/\s/)[0]?.endsWith(`/${CODEX_VERSION}`),
      "VERSION_MISMATCH",
    );
    await this.wire.write(JSON.stringify({ method: "initialized" }) + "\n");
  }
  request(method: string, params: unknown): Promise<unknown> {
    check(!this.#failed && this.#pending.size < 32, "REQUEST_CAPACITY");
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, {
        method,
        empty:
          method === "turn/start" &&
          Array.isArray((params as { input?: unknown })?.input) &&
          (params as { input: unknown[] }).input.length === 0,
        resolve,
        reject,
      });
      void this.wire
        .write(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }) + "\n")
        .catch(() => this.#fail());
    });
  }
  #data(value: string): void {
    if (this.#failed) return;
    try {
      for (let start = 0; start < value.length;) {
        const end = value.indexOf("\n", start),
          part = value.slice(start, end < 0 ? value.length : end);
        this.#bytes += Buffer.byteLength(part);
        check(this.#bytes <= 32 * 1024 * 1024, "FRAME_BOUND");
        this.#buffer += part;
        if (end < 0) return;
        const line = this.#buffer;
        this.#buffer = "";
        this.#bytes = 0;
        start = end + 1;
        if (line.trim()) this.#message(object(JSON.parse(line)));
      }
    } catch {
      this.#fail();
    }
  }
  #message(value: Record<string, unknown>): void {
    if (typeof value.method === "string" && value.id !== undefined) {
      check(typeof value.id === "string" || Number.isSafeInteger(value.id));
      const id = value.id as string | number,
        key = JSON.stringify(id),
        previous = this.#reverse.get(key);
      check(previous || this.#reverse.size < 64, "REVERSE_CAPACITY");
      previous?.reject(new CodexError("REVERSE_ID_REUSED"));
      let resolve!: () => void, reject!: (error: unknown) => void;
      const settled = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void settled.catch(() => {});
      const held: Reverse = {
        capability: Object.freeze({}),
        responded: false,
        ambiguous: !!previous,
        resolve,
        reject,
      };
      this.#reverse.set(key, held);
      this.reverse({
        id,
        method: value.method,
        params: value.params,
        capability: held.capability,
        settled,
        reply: async (result) => {
          check(
            !this.#failed && this.#reverse.get(key) === held && !held.responded && !held.ambiguous,
            "REVERSE_FENCED",
          );
          held.responded = true;
          await this.wire.write(JSON.stringify({ id, result }) + "\n");
        },
      });
      return;
    }
    if (value.id !== undefined) {
      if (typeof value.id !== "number") return;
      const held = this.#pending.get(value.id);
      if (!held) return;
      this.#pending.delete(value.id);
      if (value.error !== undefined) {
        const error = object(value.error);
        const known =
          held.empty &&
          error.code === -32603 &&
          error.message === "failed to submit turn input: EmptyInput"
            ? "ALREADY_WORKING"
            : held.method === "turn/steer" &&
                error.code === -32600 &&
                error.message === "no active turn to steer"
              ? "NO_ACTIVE_TURN"
              : held.method === "thread/queue/add" &&
                  (error.code === -32601 ||
                    (error.code === -32600 &&
                      error.message === "user message queue is unavailable"))
                ? "QUEUE_UNAVAILABLE"
                : "NATIVE_REQUEST_REJECTED";
        held.reject(new CodexError(known));
      } else held.resolve(value.result);
      return;
    }
    if (typeof value.method !== "string") return;
    if (value.method === "turn/started") this.#turnStarts++;
    if (value.method === "item/started") this.#itemStarts++;
    if (value.method === "serverRequest/resolved") {
      const key = JSON.stringify(object(value.params).requestId),
        held = this.#reverse.get(key);
      if (held && !held.ambiguous) {
        this.#reverse.delete(key);
        if (held.responded) held.resolve();
        else held.reject(new CodexError("REVERSE_WITHDRAWN"));
      }
    }
    this.notification({ method: value.method, params: value.params });
  }
  #fail(): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#buffer = "";
    this.#bytes = 0;
    for (const held of this.#pending.values()) held.reject(new CodexError("WIRE_LOST"));
    this.#pending.clear();
    for (const held of this.#reverse.values()) held.reject(new CodexError("WIRE_LOST"));
    this.#reverse.clear();
    this.lost();
  }
  async close(): Promise<void> {
    this.#fail();
    for (const release of this.#release) release();
    await this.wire.close();
  }
}
