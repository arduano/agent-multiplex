import type { CodexNotification, CodexReverseRequest } from "./controller.js";
/** Exact owned stdio only. Closing this wire is NOT native-tree Stop proof. */
export interface CodexWire {
  write(line: string): Promise<void>;
  onData(listener: (text: string) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): Promise<void>;
  observation?(): Readonly<{ state: "opening" | "open" | "closed"; exitCode: number | null; signal: string | null; spawnError: "ENOENT" | "EACCES" | "other" | null; stderrBytes: number }>;
}
export type CodexWireFactory = (input: Readonly<{ launcher: string; cwd: string; environment: Readonly<Record<string, string>> }>) => CodexWire;
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { NativeInputRefused } from "../../v8-session/src/contracts/types.js";
import { requireThat } from "../../v8-runtime/src/validation.js";
import { projectCodexMediaNotification, projectCodexMediaResult } from "../../v8-host/src/native-media.js";
/** Optional trusted private diagnostic sink: first 4 KiB only, never durable here. */
export function spawnCodexWire(input: Parameters<CodexWireFactory>[0], privateStderr?: (bytes: Uint8Array) => void): CodexWire {
    const child = spawn(process.execPath, [input.launcher, "app-server", "--stdio"], { cwd: input.cwd, env: { ...input.environment }, stdio: ["pipe", "pipe", "pipe"] });
    // Capture this exact attachment before registering observers. Its exit only
    // settles wire cleanup; it cannot certify the container/native tree halted.
    const exit = new Promise<void>(resolve => child.once("close", () => resolve()));
    const data = new Set<(text: string) => void>(), closed = new Set<() => void>(), decoder = new StringDecoder("utf8");
    let ended = false;
    let state: "opening" | "open" | "closed" = "opening", exitCode: number | null = null, signal: string | null = null, spawnError: "ENOENT" | "EACCES" | "other" | null = null, stderrBytes = 0, privateBytes = 0;
    let closing: Promise<void> | undefined;
    const end = () => { if (ended)
        return; ended = true; for (const listener of closed)
        listener(); };
    child.once("spawn", () => { if (!ended)
        state = "open"; });
    child.on("error", error => { const code = (error as NodeJS.ErrnoException).code; spawnError = code === "ENOENT" || code === "EACCES" ? code : "other"; state = "closed"; end(); });
    child.once("exit", (code, stoppedBy) => { exitCode = code; signal = stoppedBy; state = "closed"; end(); });
    child.stdin.on("error", end);
    child.stdout.once("end", end);
    child.stdout.on("data", (bytes: Buffer) => { const text = decoder.write(bytes); for (const listener of data)
        listener(text); });
    // Never print native stderr, which can contain private native configuration.
    child.stderr.on("data", (bytes: Buffer) => {
        stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, stderrBytes + bytes.length);
        if (privateStderr && privateBytes < 4096) {
            const part = new Uint8Array(bytes.subarray(0, 4096 - privateBytes));
            privateBytes += part.length;
            try {
                privateStderr(part);
            }
            catch { /* A diagnostic observer cannot affect native custody. */ }
        }
    });
    return { write: line => new Promise<void>((resolve, reject) => { if (ended) {
            reject(new Error("Owned Codex wire unavailable"));
            return;
        } child.stdin.write(line, error => error ? reject(new Error("Owned Codex wire write unconfirmed")) : resolve()); }),
        onData: listener => { data.add(listener); return () => data.delete(listener); },
        onClose: listener => { closed.add(listener); if (ended)
            listener(); return () => closed.delete(listener); },
        observation: () => Object.freeze({ state, exitCode, signal, spawnError, stderrBytes }),
        close() {
            return closing ??= (async () => {
                child.stdin.end();
                end();
                const wait = async (ms: number) => { let timer: ReturnType<typeof setTimeout> | undefined; try {
                    return await Promise.race([exit.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
                }
                finally {
                    if (timer)
                        clearTimeout(timer);
                } };
                if (await wait(4000))
                    return;
                // This is the captured Docker-attach child only, never a process group,
                // arbitrary PID or substitute for exact container retirement.
                child.kill("SIGKILL");
                requireThat(await wait(1000), "Owned Codex attachment cleanup remains unconfirmed");
            })();
        } };
}
/** One connection, no lazy reconnect, retry, owner-releasing timeout or auto-answer. */
export class CodexStdioRpc {
    readonly onLoss: () => void;
    #wire: CodexWire;
    #notification: (message: CodexNotification) => void;
    #request: (request: CodexReverseRequest) => void;
    #pending = new Map<number, { method: string; emptyInput: boolean; resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
    #reverse = new Map<string, { token: object; responded: boolean; resolve: () => void; reject: (reason: unknown) => void; ambiguous: boolean }>();
    #next = 0;
    #buffer = "";
    #bufferBytes = 0;
    #failed = false;
    #turnStarts = 0;
    #itemStarts = 0;
    #cleanups: (() => void)[];
    #requests: Record<string, number> = {};
    #responses = 0;
    #failure: "wireLost" | "invalidFrame" | "versionMismatch" | null = null;
    #nativeError: Readonly<{ method: string; code: number | null }> | undefined;
    #initialize: Readonly<{ hasUserAgent: boolean; versionCandidates: readonly string[]; leadingVersion: string | null }> | undefined;
    constructor(wire: CodexWire, notification: (message: CodexNotification) => void, request: (request: CodexReverseRequest) => void, onLoss: () => void = () => { }) {
        this.onLoss = onLoss;
        this.#wire = wire;
        this.#notification = notification;
        this.#request = request;
        this.#cleanups = [wire.onData(text => this.#data(text)), wire.onClose(() => this.#fail())];
    }
    observation() { return Object.freeze({ connected: !this.#failed, pendingReverse: this.#reverse.size, ambiguousReverse: [...this.#reverse.values()].some(value => value.ambiguous), turnStarts: this.#turnStarts, itemStarts: this.#itemStarts }); }
    /** Fixed-field private diagnostics only: never native error text/frames/config. */
    diagnostics() { return Object.freeze({ rpc: { connected: !this.#failed, requests: { ...this.#requests }, responses: this.#responses, failure: this.#failure, ...(this.#nativeError ? { lastNativeError: this.#nativeError } : {}), ...(this.#initialize ? { initialize: this.#initialize } : {}) }, wire: this.#wire.observation?.() ?? null }); }
    async initialize() {
        const result = await this.request("initialize", { clientInfo: { name: "multiplex_v8", title: "Multiplex V8", version: "0.0.0" }, capabilities: { experimentalApi: true } });
        const userAgent = result && typeof result === "object" ? (result as { userAgent?: unknown }).userAgent : undefined;
        const value = typeof userAgent === "string" ? userAgent.slice(0, 4096) : "";
        this.#initialize = Object.freeze({ hasUserAgent: typeof userAgent === "string", versionCandidates: Object.freeze([...new Set(value.match(/\b\d{1,4}\.\d{1,4}\.\d{1,4}\b/g) ?? [])].slice(0, 8)), leadingVersion: /^\S+\/(\d{1,4}\.\d{1,4}\.\d{1,4})(?:\s|$)/.exec(value)?.[1] ?? null });
        if (!/^\S+\/0\.162\.1(?:\s|$)/.test(value)) {
            this.#failure = "versionMismatch";
            requireThat(false, "Pinned Codex version was not observed");
        }
        await this.#wire.write(JSON.stringify({ method: "initialized" }) + "\n");
    }
    request(method: string, params: unknown): Promise<unknown> {
        requireThat(!this.#failed && this.#pending.size < 32, "Owned Codex request unavailable");
        const id = ++this.#next;
        const label = ["initialize", "model/list", "thread/start", "thread/resume", "thread/settings/update", "turn/settings/update", "turn/start", "turn/interrupt", "turn/steer", "thread/queue/add", "thread/compact/start", "thread/goal/get", "thread/goal/set", "thread/goal/clear", "thread/backgroundTerminals/list", "thread/backgroundTerminals/terminate", "thread/backgroundTerminals/clean", "mcpServerStatus/list", "config/mcpServer/reload", "thread/read", "thread/items/list", "thread/timeline/list"].includes(method) ? method : "other";
        this.#requests[label] = (this.#requests[label] ?? 0) + 1;
        return new Promise((resolve, reject) => { this.#pending.set(id, { method: label, emptyInput: method === "turn/start" && !!params && typeof params === "object" && Array.isArray((params as { input?: unknown }).input) && (params as { input: readonly unknown[] }).input.length === 0, resolve, reject }); void this.#wire.write(JSON.stringify({ id, method, params }) + "\n").catch(() => this.#fail()); });
    }
    #data(text: string) {
        if (this.#failed)
            return;
        try {
            // Bound each frame, rather than the sum of independent coalesced frames.
            for (let offset = 0; offset < text.length;) {
                const end = text.indexOf("\n", offset), part = text.slice(offset, end < 0 ? text.length : end);
                this.#bufferBytes += Buffer.byteLength(part);
                requireThat(this.#bufferBytes <= 32 * 1024 * 1024, "Native frame hard bound exceeded");
                this.#buffer += part;
                if (end < 0)
                    break;
                const line = this.#buffer, bytes = this.#bufferBytes;
                this.#buffer = "";
                this.#bufferBytes = 0;
                offset = end + 1;
                if (!line.trim())
                    continue;
                const message = JSON.parse(line);
                if (bytes > 2_000_000) {
                    let projection = null;
                    if (message && typeof message === "object" && !Array.isArray(message)) {
                        if (message.id === undefined)
                            projection = projectCodexMediaNotification(message);
                        else if (typeof message.id === "number" && message.method === undefined && message.error === undefined) {
                            const held = this.#pending.get(message.id), result = held ? projectCodexMediaResult(held.method, message.result) : null;
                            if (result)
                                projection = { ...message, result };
                        }
                    }
                    requireThat(projection && Buffer.byteLength(JSON.stringify(projection)) <= 2_000_000, "Ordinary native frame bound exceeded");
                }
                this.#message(message);
                if (this.#failed)
                    return;
            }
        }
        catch {
            this.#fail("invalidFrame");
        }
    }
    #message(message: Record<string, unknown>) {
        requireThat(message && typeof message === "object" && !Array.isArray(message));
        if (typeof message.method === "string" && message.id !== undefined) {
            requireThat(typeof message.id === "string" || Number.isSafeInteger(message.id));
            const id = message.id as string | number, key = JSON.stringify(id);
            const previous = this.#reverse.get(key);
            requireThat(previous || this.#reverse.size < 64);
            if (previous)
                previous.reject(new Error("Native reverse identity was reused"));
            // A positively resolved incarnation has left this ordered connection's
            // outstanding map. Only overlapping reuse makes raw resolution ambiguous.
            const token = Object.freeze({}), ambiguous = previous !== undefined;
            let resolve!: () => void, reject!: (reason: unknown) => void;
            const settled = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
            void settled.catch(() => undefined);
            const held = { token, responded: false, resolve, reject, ambiguous };
            this.#reverse.set(key, held);
            this.#request({ id, method: message.method as CodexReverseRequest["method"], params: message.params, token, settled,
                respond: async (value) => { requireThat(!this.#failed && this.#reverse.get(key) === held && !held.responded, "Original reverse capability was retired"); held.responded = true; await this.#wire.write(JSON.stringify({ id, result: value }) + "\n"); return { kind: "submitted" }; } });
            return;
        }
        if (message.id !== undefined) {
            if (typeof message.id !== "number")
                return;
            const held = this.#pending.get(message.id);
            if (!held)
                return;
            this.#pending.delete(message.id);
            this.#responses++;
            if (message.error !== undefined) {
                const code = message.error && typeof message.error === "object" ? (message.error as Record<string, unknown>).code : undefined;
                this.#nativeError = Object.freeze({ method: held.method, code: typeof code === "number" && Number.isSafeInteger(code) ? code : null });
                const error = message.error && typeof message.error === "object" ? message.error as Record<string, unknown> : {};
                let refusal: NativeInputRefused | undefined;
                if (held.emptyInput && code === -32603 && error.message === "failed to submit turn input: EmptyInput")
                    refusal = new NativeInputRefused("alreadyWorking");
                if (held.method === "turn/start" && code === -32603 && typeof error.message === "string" && /^failed to submit turn input: ActiveTurnNotSteerable \{ turn_kind: (Review|Compact) \}$/.test(error.message))
                    refusal = new NativeInputRefused("activeTurnNotSteerable");
                if (held.method === "thread/queue/add" && (code === -32601 || code === -32600 && error.message === "user message queue is unavailable"))
                    refusal = new NativeInputRefused("queueUnavailable");
                if (held.method === "turn/steer" && code === -32600) {
                    if (error.message === "no active turn to steer")
                        refusal = new NativeInputRefused("noActiveTurn");
                    else if (error.message === "cannot steer a review turn" || error.message === "cannot steer a compact turn")
                        refusal = new NativeInputRefused("activeTurnNotSteerable");
                    else if (typeof error.message === "string") {
                        const match = /^expected active turn id `([^`\r\n]+)` but found `([^`\r\n]+)`$/.exec(error.message);
                        if (match && match.slice(1).every(value => value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)))
                            refusal = new NativeInputRefused("expectedTurnMismatch");
                    }
                }
                held.reject(refusal ?? new Error("Pinned Codex native request rejected"));
            }
            else
                held.resolve(message.result);
            return;
        }
        if (typeof message.method !== "string")
            return;
        if (message.method === "turn/started")
            this.#turnStarts++;
        if (message.method === "item/started")
            this.#itemStarts++;
        if (message.method === "serverRequest/resolved" && message.params && typeof message.params === "object") {
            const id = (message.params as Record<string, unknown>).requestId, key = JSON.stringify(id), held = this.#reverse.get(key);
            // Overlapping reuse cannot distinguish an old resolution from the
            // replacement's. Keep that incarnation ambiguous until exact halt.
            if (held && !held.ambiguous) {
                this.#reverse.delete(key);
                held.resolve();
            }
        }
        this.#notification({ method: message.method, ...(message.params === undefined ? {} : { params: message.params }) });
    }
    #fail(reason: "wireLost" | "invalidFrame" | "versionMismatch" = "wireLost") {
        if (this.#failed)
            return;
        this.#failed = true;
        this.#failure ??= reason;
        const error = new Error("Owned Codex connection lost; original outcomes unknown");
        this.#buffer = "";
        this.#bufferBytes = 0;
        for (const held of this.#pending.values())
            held.reject(error);
        this.#pending.clear();
        for (const held of this.#reverse.values())
            held.reject(error);
        this.#reverse.clear();
        this.onLoss();
    }
    async close() { this.#fail(); for (const cleanup of this.#cleanups)
        cleanup(); await this.#wire.close(); }
}
