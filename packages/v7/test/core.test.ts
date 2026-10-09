import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adapterScopeIdSchema, newRuntimeEpoch,
  type HarnessCommand, type JsonValue, type NativeHistoryRequest, type NativeStateRequest,
} from "@arduano/agent-multiplex-protocol";
import {
  HostService, RootService, V7Store, NativeOperationError, nativePortForAdapter,
  type AdapterEvent, type AdapterSession, type NativePort,
} from "../src/index.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });
function deferred<T>() {
  let resolve!: (result: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { resolve, reject, promise };
}
class NativeFixture implements AdapterSession {
  public readonly harness = "copilot" as const;
  public readonly adapterScopeId = adapterScopeIdSchema.parse("fixture");
  public readonly runtimeEpoch = newRuntimeEpoch();
  public readonly cwd = "/disposable";
  public readonly listeners = new Set<(event: AdapterEvent) => void>();
  public status = vi.fn(() => "idle" as const);
  public stop = vi.fn(async () => {});
  public settings = vi.fn(() => ({ model: "fixture" }));
  public pendingMessages: JsonValue[] = [];
  public execute = vi.fn(async (command: HarnessCommand): Promise<JsonValue> => {
    if (command.harness === "copilot" && command.command.type === "send") {
      this.pendingMessages.push({ id: `native-${this.pendingMessages.length}`, prompt: command.command.prompt });
    }
    return { accepted: true };
  });
  public readNativeHistory = vi.fn(async (_request: NativeHistoryRequest) => ({
    harness: this.harness, vendorSessionId: this.vendorSessionId, payload: { history: [] } as JsonValue,
  }));
  public readNativeState = vi.fn(async (_request: NativeStateRequest) => ({
    harness: this.harness, vendorSessionId: this.vendorSessionId, payload: { pendingMessages: this.pendingMessages } as JsonValue,
  }));
  public constructor(public readonly vendorSessionId: string) {}
  public subscribe(listener: (event: AdapterEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  public emit(event: AdapterEvent) { for (const listener of this.listeners) listener(event); }
}
function fixture(options: Partial<ConstructorParameters<typeof HostService>[0]> = {}) {
  const handles: NativeFixture[] = [];
  const port: NativePort = {
    harness: "copilot", adapterScopeId: "fixture", models: vi.fn(async () => []), close: vi.fn(async () => {}),
    create: vi.fn(async () => { const h = new NativeFixture(`native-${handles.length}`); handles.push(h); return h; }),
    resume: vi.fn(async binding => { const h = new NativeFixture(binding.vendorSessionId); handles.push(h); return h; }),
  };
  const store = new V7Store({ filename: ":memory:", role: "host", instanceId: "host" });
  const host = new HostService({ store, hostId: "host", name: "Fixture", native: port, ...options });
  cleanup.push(() => host.close());
  return { handles, port, store, host };
}
const create = (sessionId: string) => ({ requestId: `create-${sessionId}`, sessionId, options: { harness: "copilot" as const, cwd: "/disposable" } });
const send = (requestId: string, sessionId = "one", prompt = "fixture") => ({ requestId, sessionId,
  command: { harness: "copilot" as const, command: { type: "send" as const, prompt, mode: "enqueue" as const } } });
function rootFixture() {
  const store = new V7Store({ filename: ":memory:", role: "root", instanceId: "root" });
  const root = new RootService({ store, rootId: "root" }); cleanup.push(() => root.close()); return { root, store };
}
async function eventDrained() { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); }

describe("V7 minimal durable request ownership", () => {
  it("deduplicates concurrent and terminal native requests and refuses changed payloads", async () => {
    const f = fixture(); await f.host.create(create("one"));
    const native = f.handles[0]!, wait = deferred<JsonValue>(); native.execute.mockImplementationOnce(() => wait.promise);
    const request = send("input"); const first = f.host.execute(request), second = f.host.execute(request);
    expect(f.host.receipt("input")?.state).toBe("dispatched");
    expect(native.execute).toHaveBeenCalledOnce(); wait.resolve({ accepted: true });
    expect(await first).toEqual(await second);
    expect(await f.host.execute(request)).toMatchObject({ state: "succeeded", request });
    expect(() => f.host.execute(send("input", "one", "different"))).toThrow("different immutable operation");
    expect(native.execute).toHaveBeenCalledOnce();
    expect(f.store.receiptEvents("input").map(row => row.state)).toEqual(["admitted", "dispatched", "succeeded"]);
  });
  it("classifies explicit native failures and uncertain dispatch without retry", async () => {
    const f = fixture(); await f.host.create(create("one"));
    f.handles[0]!.execute.mockRejectedValueOnce(new NativeOperationError("REFUSED", "refused", "failed"));
    expect(await f.host.execute(send("failed"))).toMatchObject({ state: "failed", error: { code: "REFUSED" } });
    f.handles[0]!.execute.mockRejectedValueOnce(new Error("Disconnected after dispatch"));
    expect(await f.host.execute(send("unknown"))).toMatchObject({ state: "outcomeUnknown" });
    expect(await f.host.execute(send("unknown"))).toMatchObject({ state: "outcomeUnknown" });
    expect(f.handles[0]!.execute).toHaveBeenCalledTimes(2);
  });
  it("never runs a durable Host prompt queue; queue indicators come from native state", async () => {
    const f = fixture(); await f.host.create(create("one"));
    await f.host.execute(send("sent"));
    expect((await f.host.nativeState({ sessionId: "one", request: { harness: "copilot", view: "pendingMessages" } })).payload.json)
      .toEqual({ pendingMessages: [{ id: "native-0", prompt: "fixture" }] });
    f.handles[0]!.pendingMessages.length = 0;
    expect((await f.host.nativeState({ sessionId: "one", request: { harness: "copilot", view: "pendingMessages" } })).payload.json)
      .toEqual({ pendingMessages: [] });
    expect(f.host.receipt("sent")?.state).toBe("succeeded");
  });
  it("fails busy session mutations immediately instead of keeping a second queued prompt", async () => {
    const f = fixture(); await f.host.create(create("one")); const wait = deferred<JsonValue>();
    f.handles[0]!.execute.mockImplementationOnce(() => wait.promise);
    const first = f.host.execute(send("first"));
    expect(await f.host.execute(send("second"))).toMatchObject({ state: "failed", error: { code: "SESSION_BUSY" } });
    wait.resolve(null); await first; expect(f.handles[0]!.execute).toHaveBeenCalledOnce();
  });
  it("restarts into stopped bindings without attaching, inventory, history or prompts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v7-restart-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const filename = join(dir, "state.sqlite");
    let store = new V7Store({ filename, role: "host", instanceId: "host" });
    store.putBinding({ sessionId: "old", hostId: "host", harness: "copilot", adapterScopeId: "fixture",
      vendorSessionId: "original-native", cwd: "/disposable", createdAt: store.now(), archived: false });
    store.admit("before-dispatch", "old", "execute", { input: "never sent" });
    store.admit("after-dispatch", "old", "execute", { input: "may have sent" }); store.transition("after-dispatch", "dispatched"); store.close();
    store = new V7Store({ filename, role: "host", instanceId: "host" });
    const f = fixture({ store });
    expect(f.host.list()).toMatchObject([{ sessionId: "old", status: "stopped", attachmentId: null }]);
    expect(f.port.resume).not.toHaveBeenCalled(); expect(f.port.create).not.toHaveBeenCalled();
    expect(f.host.receipt("before-dispatch")?.state).toBe("failed");
    expect(f.host.receipt("after-dispatch")?.state).toBe("outcomeUnknown");
    await f.host.resume({ requestId: "explicit", sessionId: "old" });
    expect(f.port.resume).toHaveBeenCalledOnce(); expect(f.handles[0]!.execute).not.toHaveBeenCalled();
  }, 60_000);
  it("releases the SQLite writer lease after process death without stale lock recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v7-death-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const filename = join(dir, "state.sqlite"), module = new URL("../dist/store.js", import.meta.url).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      `import { V7Store } from ${JSON.stringify(module)}; const s=new V7Store({filename:${JSON.stringify(filename)},role:'host',instanceId:'host'}); s.admit('crash','session','send',{});s.transition('crash','dispatched');process.stdout.write('ready\\n');setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "pipe"] });
    cleanup.push(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", () => reject(Error("Fixture exited early"))); });
    expect(() => new V7Store({ filename, role: "host", instanceId: "host" })).toThrow("already owned");
    const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
    const store = new V7Store({ filename, role: "host", instanceId: "host" }); cleanup.push(() => store.close());
    expect(store.receipt("crash")?.state).toBe("outcomeUnknown");
  }, 60_000);
});

describe("V7 independent native session coordination", () => {
  it("isolates malformed events, broken session observations and failing diagnostics", async () => {
    const f = fixture({ diagnostic: () => { throw Error("Log disk failed"); } });
    await f.host.create(create("poison")); await f.host.create(create("healthy"));
    f.handles[0]!.emit({ kind: "native", nativeType: "bad", payload: { invalid: undefined } as unknown as JsonValue, ephemeral: false });
    f.handles[0]!.status.mockImplementation(() => { throw Error("Broken session"); });
    f.handles[1]!.emit({ kind: "native", nativeType: "message", payload: { text: "healthy" }, ephemeral: false });
    await eventDrained();
    expect(f.host.list()).toMatchObject([{ sessionId: "healthy", status: "idle", recoveryRequired: false },
      { sessionId: "poison", status: "error", recoveryRequired: true }]);
    expect(await f.host.execute(send("healthy-command", "healthy"))).toMatchObject({ state: "succeeded" });
  });
  it("does not serialize a slow history read with peer mutations or Host snapshots", async () => {
    const f = fixture(); await f.host.create(create("slow")); await f.host.create(create("peer"));
    const wait = deferred<Awaited<ReturnType<NativeFixture["readNativeHistory"]>>>();
    f.handles[0]!.readNativeHistory.mockImplementationOnce(() => wait.promise);
    const pending = f.host.history({ sessionId: "slow", request: { harness: "copilot", limit: 10 } });
    expect(f.host.list()).toHaveLength(2);
    expect(await f.host.execute(send("peer-send", "peer"))).toMatchObject({ state: "succeeded" });
    wait.resolve({ harness: "copilot", vendorSessionId: f.handles[0]!.vendorSessionId, payload: { history: [] } }); await pending;
  });
  it("fences late history against replacement and never replaces native callbacks", async () => {
    const f = fixture(); await f.host.create(create("one"));
    const wait = deferred<Awaited<ReturnType<NativeFixture["readNativeHistory"]>>>();
    f.handles[0]!.readNativeHistory.mockImplementationOnce(() => wait.promise);
    const old = f.host.history({ sessionId: "one", request: { harness: "copilot", limit: 10 } });
    const rejection = expect(old).rejects.toThrow("retired attachment");
    await f.host.recover({ requestId: "recover", sessionId: "one" });
    wait.resolve({ harness: "copilot", vendorSessionId: f.handles[0]!.vendorSessionId, payload: {} }); await rejection;
    const resolve = vi.fn(async () => {});
    f.handles[1]!.emit({ kind: "interaction", nativeRequestId: "native-question", requestType: "userInput", payload: { question: "Fixture?" }, ephemeral: false, resolve });
    await eventDrained(); expect(f.host.interactions("one")).toMatchObject([{ interactionId: "native-question" }]);
    expect(await f.host.resolve({ requestId: "reply", sessionId: "one", interactionId: "native-question", response: "answer" })).toMatchObject({ state: "succeeded" });
    expect(resolve).toHaveBeenCalledExactlyOnceWith("answer"); expect(f.host.interactions("one")).toEqual([]);
  });
  it("requires recovery for native uncertainty but a missing observer replay is just a view gap", async () => {
    const f = fixture({ eventBufferSize: 2 }); await f.host.create(create("one"));
    const attached = f.host.list()[0]!;
    for (let i = 0; i < 4; i++) f.handles[0]!.emit({ kind: "native", nativeType: "message", payload: { i }, ephemeral: false });
    await eventDrained();
    const watcher = f.host.watchSession({ sessionId: "one", attachmentId: attached.attachmentId, afterSequence: 0 })[Symbol.asyncIterator]();
    expect((await watcher.next()).value).toMatchObject({ kind: "gap", recoveryRequired: false }); await watcher.return?.();
    expect(f.host.list()[0]!.recoveryRequired).toBe(false);
    f.handles[0]!.emit({ kind: "lifecycle", fact: { type: "gap" } }); await eventDrained();
    expect(await f.host.execute(send("blocked"))).toMatchObject({ state: "failed", error: { code: "INTERACTION_UNCERTAIN" } });
    expect(await f.host.recover({ requestId: "recover", sessionId: "one" })).toMatchObject({ state: "succeeded" });
  });
});

describe("V7 single Root authority", () => {
  it("creates with Root metadata and never waits for native rename", async () => {
    const f = fixture(), { root } = rootFixture(); root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    expect(await root.create({ ...create("one"), hostId: "host", title: "Exact title" })).toMatchObject({ state: "succeeded" });
    expect(root.snapshot().sessions[0]).toMatchObject({ title: "Exact title", native: { sessionId: "one", status: "idle" } });
    expect(f.handles[0]!.execute).not.toHaveBeenCalled();
    await root.rename({ requestId: "rename", sessionId: "one", title: "Changed" }); expect(root.snapshot().sessions[0]!.title).toBe("Changed");
  });
  it("preserves full immutable execute payloads and rejects accidental request reuse", async () => {
    const f = fixture(), { root } = rootFixture(); root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    await root.create({ ...create("one"), hostId: "host", title: "One" });
    await root.execute(send("same")); expect((await root.receipt("same"))?.request).toEqual(send("same"));
    expect(() => root.execute(send("same", "one", "changed"))).toThrow("different immutable operation");
  });
  it("rejects wrong generations and discards only malformed session rows", async () => {
    const f = fixture(), { root, store } = rootFixture();
    expect(() => root.attachHost({ descriptor: { ...f.host.descriptor(), protocolVersion: 6 as 7 }, api: f.host, sessions: [] })).toThrow("other wire generations");
    const first = root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    await root.create({ ...create("one"), hostId: "host", title: "One" });
    store.putMetadata({ sessionId: "bad", hostId: "host", title: "Bad", pinned: false, metadata: {}, createdAt: store.now(), archived: false });
    expect(root.updateHost(first, [...f.host.list(), { ...f.host.list()[0]!, sessionId: "bad", status: "invalid" as "idle" }])).toBe(true);
    expect(root.snapshot()).toMatchObject({ hosts: [{ online: true }], sessions: [{ native: null }, { native: { sessionId: "one" } }] });
    const next = root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: f.host.list() });
    expect(root.detachHost(first)).toBe(false); expect(root.updateHost(first, [])).toBe(false); expect(root.detachHost(next)).toBe(true);
    expect(root.snapshot().sessions.every(session => session.native === null)).toBe(true);
  });
  it("reconciles the original Host receipt after a lost response without a second native send", async () => {
    const f = fixture(), { root } = rootFixture();
    const api = Object.create(f.host) as HostService;
    // Bind concrete methods because Host private slots require its real receiver.
    const port = {
      descriptor: () => f.host.descriptor(), list: () => f.host.list(), models: () => f.host.models(), create: input => f.host.create(input),
      resume: input => f.host.resume(input), stop: input => f.host.stop(input), recover: input => f.host.recover(input), archive: input => f.host.archive(input),
      resolve: input => f.host.resolve(input), history: input => f.host.history(input), nativeState: input => f.host.nativeState(input),
      interactions: id => f.host.interactions(id), receipt: id => f.host.receipt(id), watchSession: input => f.host.watchSession(input),
      execute: async input => { await f.host.execute(input); throw Error("Response lost"); },
    } satisfies import("../src/protocol.js").HostApi;
    void api; root.attachHost({ descriptor: f.host.descriptor(), api: port, sessions: [] });
    await root.create({ ...create("one"), hostId: "host", title: "One" });
    expect(await root.execute(send("lost"))).toMatchObject({ state: "outcomeUnknown" });
    expect(await root.receipt("lost")).toMatchObject({ state: "succeeded" });
    expect(f.handles[0]!.execute).toHaveBeenCalledOnce();
  });
  it("publishes one contiguous snapshot/delta stream with metadata and presence changes", async () => {
    const f = fixture(), { root } = rootFixture(), iterator = root.watch()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ kind: "snapshot", snapshot: { revision: 0 } });
    const token = root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    await root.create({ ...create("one"), hostId: "host", title: "One" }); root.detachHost(token);
    const events = []; for (let i = 0; i < 5; i++) events.push((await iterator.next()).value);
    expect(events.map(event => event.delta.revision)).toEqual([1, 2, 3, 4, 5]); await iterator.return?.();
  });
});
