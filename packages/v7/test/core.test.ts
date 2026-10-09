import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adapterScopeIdSchema, newRuntimeEpoch,
  type HarnessCommand, type JsonValue, type NativeHistoryRequest, type NativeStateRequest,
} from "@arduano/agent-multiplex-protocol";
import { AdapterPreparationError, type AgentAdapter } from "@arduano/agent-multiplex-runtime-node-core";
import {
  HostService, RootService, V7Store, NativeOperationError, nativePortForAdapter, V7_STORE_MAX_PENDING_CALLS,
  type AdapterEvent, type AdapterSession, type NativePort,
} from "../dist/index.js";

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
async function fixture(options: Partial<ConstructorParameters<typeof HostService>[0]> = {}) {
  const handles: NativeFixture[] = [];
  const port: NativePort = {
    harness: "copilot", adapterScopeId: "fixture", models: vi.fn(async () => []), close: vi.fn(async () => {}),
    create: vi.fn(async () => { const h = new NativeFixture(`native-${handles.length}`); handles.push(h); return h; }),
    resume: vi.fn(async binding => { const h = new NativeFixture(binding.vendorSessionId); handles.push(h); return h; }),
  };
  const store = options.store ?? await V7Store.open({ filename: ":memory:", role: "host", instanceId: "host" });
  const host = new HostService({ store, hostId: "host", name: "Fixture", native: port, ...options });
  cleanup.push(() => host.close());
  return { handles, port, store, host };
}
const create = (sessionId: string) => ({ requestId: `create-${sessionId}`, sessionId, options: { harness: "copilot" as const, cwd: "/disposable" } });
const send = (requestId: string, sessionId = "one", prompt = "fixture") => ({ requestId, sessionId,
  command: { harness: "copilot" as const, command: { type: "send" as const, prompt, mode: "enqueue" as const } } });
async function rootFixture() {
  const store = await V7Store.open({ filename: ":memory:", role: "root", instanceId: "root" });
  const root = new RootService({ store, rootId: "root" }); cleanup.push(() => root.close()); return { root, store };
}
async function eventDrained() { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); }

describe("V7 minimal durable request ownership", () => {
  it("treats omitted optional members consistently across direct and serialized requests", async () => {
    const f = await fixture(), input = create("one");
    await f.host.create({ ...input, options: { ...input.options, model: undefined } } as unknown as typeof input);
    expect(await f.host.create(input)).toMatchObject({ state: "succeeded" }); expect(f.port.create).toHaveBeenCalledOnce();
  });
  it("refuses V6 or unrelated databases without adding V7 schema tables", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v7-foreign-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const filename = join(dir, "state.sqlite"), database = new DatabaseSync(filename);
    database.exec("CREATE TABLE vendor_state(value TEXT); INSERT INTO vendor_state VALUES('untouched');"); database.close();
    await expect(V7Store.open({ filename, role: "host", instanceId: "host" })).rejects.toThrow("not fresh V7");
    const check = new DatabaseSync(filename); expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())
      .toEqual([{ name: "vendor_state" }]); check.close();
  });
  it("deduplicates concurrent and terminal native requests and refuses changed payloads", async () => {
    const f = await fixture(); await f.host.create(create("one"));
    const native = f.handles[0]!, wait = deferred<JsonValue>(); native.execute.mockImplementationOnce(() => wait.promise);
    const request = send("input"); const first = f.host.execute(request), second = f.host.execute(request);
    await vi.waitFor(() => expect(native.execute).toHaveBeenCalledOnce());
    expect((await f.host.receipt("input"))?.state).toBe("dispatched");
    expect(native.execute).toHaveBeenCalledOnce(); wait.resolve({ accepted: true });
    expect(await first).toEqual(await second);
    expect(await f.host.execute(request)).toMatchObject({ state: "succeeded", request });
    await expect(f.host.execute(send("input", "one", "different"))).rejects.toThrow("different immutable operation");
    expect(native.execute).toHaveBeenCalledOnce();
    expect((await f.store.receiptEvents("input")).map(row => row.state)).toEqual(["admitted", "dispatched", "succeeded"]);
  });
  it("classifies explicit native failures and uncertain dispatch without retry", async () => {
    const f = await fixture(); await f.host.create(create("one"));
    f.handles[0]!.execute.mockRejectedValueOnce(new NativeOperationError("REFUSED", "refused", "failed"));
    expect(await f.host.execute(send("failed"))).toMatchObject({ state: "failed", error: { code: "REFUSED" } });
    f.handles[0]!.execute.mockRejectedValueOnce(new Error("Disconnected after dispatch"));
    expect(await f.host.execute(send("unknown"))).toMatchObject({ state: "outcomeUnknown" });
    expect(await f.host.execute(send("unknown"))).toMatchObject({ state: "outcomeUnknown" });
    expect(f.handles[0]!.execute).toHaveBeenCalledTimes(2);
  });
  it("releases a returned native handle after a binding write fails without replaying its uncertain creation", async () => {
    const diagnostics: Array<{ code: string }> = [], f = await fixture({ diagnostic: event => diagnostics.push(event) });
    const native = new NativeFixture("returned-before-write");
    native.stop.mockRejectedValueOnce(new Error("Native cleanup failed"));
    vi.mocked(f.port.create).mockImplementationOnce(async () => { f.handles.push(native); return native; });
    vi.spyOn(f.store, "putBinding").mockRejectedValueOnce(new Error("Binding write failed"));
    const receipt = await f.host.create(create("one"));
    expect(receipt).toMatchObject({ state: "outcomeUnknown", error: { message: "Binding write failed" } });
    expect(native.stop).toHaveBeenCalledOnce(); expect(native.listeners.size).toBe(0);
    expect(f.host.list()).toEqual([]); expect(diagnostics).toContainEqual(expect.objectContaining({ code: "nativeCleanupFailed" }));
    expect(await f.host.create(create("one"))).toEqual(receipt);
    expect(f.port.create).toHaveBeenCalledOnce(); expect(native.stop).toHaveBeenCalledOnce();
  });
  it("retires a partially installed attachment when native subscription fails", async () => {
    const f = await fixture(); await f.host.create(create("one")); await f.host.stop({ requestId: "stop", sessionId: "one" });
    const native = new NativeFixture(f.handles[0]!.vendorSessionId);
    vi.spyOn(native, "subscribe").mockImplementationOnce(() => { throw new Error("Native subscription failed"); });
    vi.mocked(f.port.resume).mockImplementationOnce(async () => { f.handles.push(native); return native; });
    expect(await f.host.resume({ requestId: "resume", sessionId: "one" })).toMatchObject({ state: "outcomeUnknown" });
    expect(native.stop).toHaveBeenCalledOnce();
    expect(f.host.list()).toMatchObject([{ sessionId: "one", attachmentId: null, status: "stopped" }]);
    expect(await f.host.execute(send("not-attached"))).toMatchObject({ state: "failed", error: { code: "SESSION_STOPPED" } });
    expect(native.execute).not.toHaveBeenCalled();
  });
  it("closes observers and its durable writer even when native shutdown fails", async () => {
    const f = await fixture(); await f.host.create(create("one"));
    const watcher = f.host.watchSession({ sessionId: "one" })[Symbol.asyncIterator](); await watcher.next();
    const waiting = watcher.next(), closeStore = vi.spyOn(f.store, "close");
    vi.mocked(f.port.close).mockRejectedValueOnce(new Error("Native shutdown failed"));
    await expect(f.host.close()).rejects.toThrow("V7 Host cleanup failed");
    expect(await waiting).toEqual({ done: true, value: undefined });
    expect(f.handles[0]!.listeners.size).toBe(0); expect(closeStore).toHaveBeenCalledOnce();
    await expect(f.store.receipt("create-one")).rejects.toMatchObject({ code: "CLOSED" });
  });
  it("never runs a durable Host prompt queue; queue indicators come from native state", async () => {
    const f = await fixture(); await f.host.create(create("one"));
    await f.host.execute(send("sent"));
    expect((await f.host.nativeState({ sessionId: "one", request: { harness: "copilot", view: "pendingMessages" } })).payload.json)
      .toEqual({ pendingMessages: [{ id: "native-0", prompt: "fixture" }] });
    f.handles[0]!.pendingMessages.length = 0;
    expect((await f.host.nativeState({ sessionId: "one", request: { harness: "copilot", view: "pendingMessages" } })).payload.json)
      .toEqual({ pendingMessages: [] });
    expect((await f.host.receipt("sent"))?.state).toBe("succeeded");
  });
  it("fails busy session mutations immediately instead of keeping a second queued prompt", async () => {
    const f = await fixture(); await f.host.create(create("one")); const wait = deferred<JsonValue>();
    f.handles[0]!.execute.mockImplementationOnce(() => wait.promise);
    const first = f.host.execute(send("first"));
    expect(await f.host.execute(send("second"))).toMatchObject({ state: "failed", error: { code: "SESSION_BUSY" } });
    wait.resolve(null); await first; expect(f.handles[0]!.execute).toHaveBeenCalledOnce();
  });
  it("restarts into stopped bindings without attaching, inventory, history or prompts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v7-restart-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const filename = join(dir, "state.sqlite");
    let store = await V7Store.open({ filename, role: "host", instanceId: "host" });
    await store.putBinding({ sessionId: "old", hostId: "host", harness: "copilot", adapterScopeId: "fixture",
      vendorSessionId: "original-native", cwd: "/disposable", createdAt: store.now(), archived: false });
    await store.admit("before-dispatch", "old", "execute", { input: "never sent" });
    await store.admit("after-dispatch", "old", "execute", { input: "may have sent" }); await store.transition("after-dispatch", "dispatched"); await store.close();
    store = await V7Store.open({ filename, role: "host", instanceId: "host" });
    const f = await fixture({ store });
    expect(f.host.list()).toMatchObject([{ sessionId: "old", status: "stopped", attachmentId: null }]);
    expect(f.port.resume).not.toHaveBeenCalled(); expect(f.port.create).not.toHaveBeenCalled();
    expect((await f.host.receipt("before-dispatch"))?.state).toBe("failed");
    expect((await f.host.receipt("after-dispatch"))?.state).toBe("outcomeUnknown");
    await f.host.resume({ requestId: "explicit", sessionId: "old" });
    expect(f.port.resume).toHaveBeenCalledOnce(); expect(f.handles[0]!.execute).not.toHaveBeenCalled();
  }, 60_000);
  it("releases the SQLite writer lease after process death without stale lock recovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v7-death-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const filename = join(dir, "state.sqlite"), module = new URL("../dist/store.js", import.meta.url).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      `import { V7Store } from ${JSON.stringify(module)}; const s=await V7Store.open({filename:${JSON.stringify(filename)},role:'host',instanceId:'host'}); await s.admit('crash','session','send',{});await s.transition('crash','dispatched');process.stdout.write('ready\\n');setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "pipe"] });
    cleanup.push(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", () => reject(Error("Fixture exited early"))); });
    await expect(V7Store.open({ filename, role: "host", instanceId: "host" })).rejects.toThrow("already owned");
    const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
    const store = await V7Store.open({ filename, role: "host", instanceId: "host" }); cleanup.push(() => store.close());
    expect((await store.receipt("crash"))?.state).toBe("outcomeUnknown");
  }, 60_000);
});

describe("V7 independent native session coordination", () => {
  it("keeps the adapter port thin and uses noncontinuing Copilot resume", async () => {
    const native = new NativeFixture("original"), resume = vi.fn(async () => native);
    const adapter: AgentAdapter = { harness: "copilot", adapterScopeId: native.adapterScopeId,
      describe: vi.fn(async () => ({ harness: "copilot", adapterScopeId: native.adapterScopeId, available: true, capabilities: [] })),
      listModels: vi.fn(async () => []), listSessions: vi.fn(async () => []), spawn: vi.fn(async () => native), resume, close: vi.fn(async () => {}) };
    const port = nativePortForAdapter(adapter);
    await port.resume({ sessionId: "logical", hostId: "host", harness: "copilot", adapterScopeId: "fixture", vendorSessionId: "original",
      cwd: null, createdAt: "fixture", archived: false });
    expect(resume).toHaveBeenCalledExactlyOnceWith({ harness: "copilot", vendorSessionId: "original", continuePendingWork: false });
    expect(adapter.listSessions).not.toHaveBeenCalled(); expect(adapter.listModels).not.toHaveBeenCalled();
    resume.mockRejectedValueOnce(new AdapterPreparationError("Preparation refused before native dispatch"));
    await expect(port.resume({ sessionId: "logical", hostId: "host", harness: "copilot", adapterScopeId: "fixture", vendorSessionId: "original",
      cwd: null, createdAt: "fixture", archived: false })).rejects.toMatchObject({ certainty: "failed" });
  });
  it("bounds a blocked event lane by bytes while peer native streams continue", async () => {
    const wait = deferred<import("../src/protocol.js").NativePayload>();
    const f = await fixture({ pendingEventBytes: 1024, externalize: async (binding, payload) => binding.sessionId === "blocked"
      ? wait.promise : { encoding: "native-json-images-v1", json: payload, images: [] } });
    await f.host.create(create("blocked")); await f.host.create(create("peer"));
    for (let i = 0; i < 12; i++) f.handles[0]!.emit({ kind: "native", nativeType: "chunk", payload: { text: "x".repeat(300) }, ephemeral: true });
    f.handles[1]!.emit({ kind: "native", nativeType: "chunk", payload: { text: "peer" }, ephemeral: true });
    await eventDrained(); expect(f.host.list().find(s => s.sessionId === "blocked")?.recoveryRequired).toBe(true);
    expect(f.host.list().find(s => s.sessionId === "peer")?.recoveryRequired).toBe(false);
    expect(await f.host.execute(send("peer", "peer"))).toMatchObject({ state: "succeeded" });
    wait.resolve({ encoding: "native-json-images-v1", json: {}, images: [] }); await eventDrained();
  });
  it("explicit Resume replaces a natively stopped handle after proving local cleanup", async () => {
    const f = await fixture(); await f.host.create(create("one"));
    f.handles[0]!.status.mockReturnValue("stopped" as "idle");
    expect(await f.host.resume({ requestId: "resume", sessionId: "one" })).toMatchObject({ state: "succeeded" });
    expect(f.handles[0]!.stop).toHaveBeenCalledOnce(); expect(f.port.resume).toHaveBeenCalledOnce();
    expect(f.host.list()[0]!.status).toBe("idle");
  });
  it("isolates malformed events, broken session observations and failing diagnostics", async () => {
    const f = await fixture({ diagnostic: () => { throw Error("Log disk failed"); } });
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
    const f = await fixture(); await f.host.create(create("slow")); await f.host.create(create("peer"));
    const wait = deferred<Awaited<ReturnType<NativeFixture["readNativeHistory"]>>>();
    f.handles[0]!.readNativeHistory.mockImplementationOnce(() => wait.promise);
    const pending = f.host.history({ sessionId: "slow", request: { harness: "copilot", limit: 10 } });
    expect(f.host.list()).toHaveLength(2);
    expect(await f.host.execute(send("peer-send", "peer"))).toMatchObject({ state: "succeeded" });
    wait.resolve({ harness: "copilot", vendorSessionId: f.handles[0]!.vendorSessionId, payload: { history: [] } }); await pending;
  });
  it("fences late history against replacement and never replaces native callbacks", async () => {
    const f = await fixture(); await f.host.create(create("one"));
    const wait = deferred<Awaited<ReturnType<NativeFixture["readNativeHistory"]>>>();
    f.handles[0]!.readNativeHistory.mockImplementationOnce(() => wait.promise);
    const old = f.host.history({ sessionId: "one", request: { harness: "copilot", limit: 10 } });
    const rejection = expect(old).rejects.toThrow("retired attachment");
    await f.host.recover({ requestId: "recover", sessionId: "one" });
    wait.resolve({ harness: "copilot", vendorSessionId: f.handles[0]!.vendorSessionId, payload: {} }); await rejection;
    const resolve = vi.fn(async () => {});
    f.handles[1]!.emit({ kind: "interaction", nativeRequestId: "native-question", requestType: "userInput", payload: { question: "Fixture?" }, ephemeral: false, resolve });
    await eventDrained(); const question = f.host.interactions("one")[0]!;
    expect(question).toMatchObject({ nativeRequestId: "native-question" });
    expect(await f.host.resolve({ requestId: "reply", sessionId: "one", interactionId: question.interactionId, response: "answer" })).toMatchObject({ state: "succeeded" });
    expect(resolve).toHaveBeenCalledExactlyOnceWith("answer"); expect(f.host.interactions("one")).toEqual([]);
  });
  it("requires recovery for native uncertainty but a missing observer replay is just a view gap", async () => {
    const f = await fixture({ eventBufferSize: 2 }); await f.host.create(create("one"));
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
  it("fences native request ID reuse across recovered attachments", async () => {
    const f = await fixture(); await f.host.create(create("one")); const first = vi.fn(async () => {}), second = vi.fn(async () => {});
    f.handles[0]!.emit({ kind: "interaction", nativeRequestId: "1", requestType: "approval", payload: {}, ephemeral: false, resolve: first });
    await eventDrained(); const retiredId = f.host.interactions("one")[0]!.interactionId;
    await f.host.recover({ requestId: "recover", sessionId: "one" });
    f.handles[1]!.emit({ kind: "interaction", nativeRequestId: "1", requestType: "approval", payload: {}, ephemeral: false, resolve: second });
    await eventDrained(); expect(f.host.interactions("one")[0]!.interactionId).not.toBe(retiredId);
    expect(await f.host.resolve({ requestId: "old-reply", sessionId: "one", interactionId: retiredId, response: "allow" }))
      .toMatchObject({ state: "failed", error: { code: "INTERACTION_STALE" } });
    expect(second).not.toHaveBeenCalled(); expect(first).not.toHaveBeenCalled();
  });
  it("preserves genuine partial interaction hydration and accepts an exact native certificate", async () => {
    const f = await fixture(); await f.host.create(create("one")); const native = f.handles[0]!;
    native.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: false } });
    await eventDrained(); expect(f.host.list()[0]!.recoveryRequired).toBe(true);
    native.emit({ kind: "status", status: "idle" }); await eventDrained();
    expect(f.host.list()[0]!.recoveryRequired).toBe(true);
    native.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: true } });
    await eventDrained(); expect(f.host.list()[0]!.recoveryRequired).toBe(false);
    native.emit({ kind: "lifecycle", fact: { type: "gap" } });
    native.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: true } });
    await eventDrained(); expect(f.host.list()[0]!.recoveryRequired).toBe(true);
  });
});

describe("V7 single Root authority", () => {
  it("owns full Host descriptors at attachment and across public snapshots", async () => {
    const f = await fixture({ capabilities: [{ name: "terminal.side-channel", version: "v1", experimental: false }] }), { root } = await rootFixture();
    const descriptor = f.host.descriptor();
    expect(() => root.attachHost({ descriptor: { ...descriptor, capabilities: [] }, api: f.host, sessions: [] })).toThrow("differs");
    root.attachHost({ descriptor, api: f.host, sessions: [] });
    descriptor.capabilities![0]!.name = "mutated-input";
    const snapshot = root.snapshot(); snapshot.hosts[0]!.capabilities![0]!.name = "mutated-output";
    expect(root.snapshot().hosts[0]!.capabilities![0]!.name).toBe("terminal.side-channel");
  });
  it("reads original receipts without optional filters and rejects a foreign native state owner", async () => {
    const f = await fixture(); await f.host.create(create("one"));
    expect(await f.store.receipts()).toHaveLength(1);
    expect(await f.store.receipts("one")).toHaveLength(1);
    f.handles[0]!.readNativeState.mockImplementationOnce(async () => ({ harness: "copilot", vendorSessionId: "another-native-session", payload: {} }));
    await expect(f.host.nativeState({ sessionId: "one", request: { harness: "copilot", kind: "queue" } })).rejects.toMatchObject({ code: "STATE_OWNER" });
  });
  it("advertises only supplied Host capabilities and does not leak mutable descriptors", async () => {
    const f = await fixture({ capabilities: [{ name: "terminal.side-channel", version: "v1", experimental: false }] });
    const descriptor = f.host.descriptor(); descriptor.capabilities![0]!.name = "mutated";
    expect(f.host.descriptor().capabilities?.[0]?.name).toBe("terminal.side-channel");
    expect((await fixture()).host.descriptor().capabilities).toBeUndefined();
  });
  it("archives a definite failed creation reservation without replaying native create", async () => {
    const f = await fixture(), { root } = await rootFixture();
    (f.port.create as ReturnType<typeof vi.fn>).mockRejectedValue(new NativeOperationError("REJECTED", "Definitely not created", "failed"));
    root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    expect(await root.create({ ...create("one"), hostId: "host", title: "Failed creation" })).toMatchObject({ state: "failed" });
    expect(root.snapshot().sessions[0]).toMatchObject({ native: null, archived: false });
    expect(await root.archive({ requestId: "archive", sessionId: "one" })).toMatchObject({ state: "succeeded" });
    expect(root.snapshot().sessions[0]).toMatchObject({ native: null, archived: true });
    expect(f.port.create).toHaveBeenCalledOnce(); expect(f.port.resume).not.toHaveBeenCalled();
  });
  it("keeps an unknown native creation visible until its original outcome is inspected", async () => {
    const f = await fixture(), { root } = await rootFixture();
    (f.port.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Disconnected after native dispatch"));
    root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    expect(await root.create({ ...create("one"), hostId: "host", title: "Unknown creation" })).toMatchObject({ state: "outcomeUnknown" });
    expect(await root.archive({ requestId: "archive", sessionId: "one" })).toMatchObject({ state: "failed", error: { code: "CREATION_UNCERTAIN" } });
    expect(root.snapshot().sessions[0]).toMatchObject({ native: null, archived: false });
    expect(f.port.create).toHaveBeenCalledOnce();
  });
  it("creates with Root metadata and never waits for native rename", async () => {
    const f = await fixture(), { root } = await rootFixture(); root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    expect(await root.create({ ...create("one"), hostId: "host", title: "Exact title" })).toMatchObject({ state: "succeeded" });
    expect(root.snapshot().sessions[0]).toMatchObject({ title: "Exact title", native: { sessionId: "one", status: "idle" } });
    expect(f.handles[0]!.execute).not.toHaveBeenCalled();
    await root.rename({ requestId: "rename", sessionId: "one", title: "Changed" }); expect(root.snapshot().sessions[0]!.title).toBe("Changed");
  });
  it("preserves full immutable execute payloads and rejects accidental request reuse", async () => {
    const f = await fixture(), { root } = await rootFixture(); root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    await root.create({ ...create("one"), hostId: "host", title: "One" });
    await root.execute(send("same")); expect((await root.receipt("same"))?.request).toEqual(send("same"));
    await expect(root.execute(send("same", "one", "changed"))).rejects.toThrow("different immutable operation");
  });
  it("retains opaque caller context through both admission edges without native interpretation", async () => {
    const f = await fixture(), { root } = await rootFixture(); root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    const context = { browserOperation: "launch", callerId: "original-browser-request" };
    await root.create({ ...create("one"), hostId: "host", title: "One", context });
    expect((await root.receipt("create-one"))?.request).toMatchObject({ context });
    expect((await f.host.receipt("create-one"))?.request).toMatchObject({ context });
    expect(f.port.create).toHaveBeenCalledExactlyOnceWith(create("one").options);
  });
  it("applies concurrent metadata patches and naming changes atomically at the Root", async () => {
    const f = await fixture(), { root } = await rootFixture(); root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    await root.create({ ...create("one"), hostId: "host", title: "One" });
    await root.updateMetadata({ requestId: "base", sessionId: "one", metadata: { keep: 1, remove: true } });
    await Promise.all([
      root.updateMetadata({ requestId: "first", sessionId: "one", title: "Renamed", pinned: true, metadata: { first: 2 }, remove: ["remove"] }),
      root.updateMetadata({ requestId: "second", sessionId: "one", metadata: { second: 3 } }),
    ]);
    expect(root.snapshot().sessions[0]).toMatchObject({ title: "Renamed", pinned: true, metadata: { keep: 1, first: 2, second: 3 } });
    expect(root.snapshot().sessions[0]!.metadata).not.toHaveProperty("remove");
    expect(f.handles[0]!.execute).not.toHaveBeenCalled();
  });
  it("rejects wrong generations and discards only malformed session rows", async () => {
    const f = await fixture(), { root, store } = await rootFixture();
    expect(() => root.attachHost({ descriptor: { ...f.host.descriptor(), protocolVersion: 6 as 7 }, api: f.host, sessions: [] })).toThrow("other wire generations");
    const first = root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    await root.create({ ...create("one"), hostId: "host", title: "One" });
    await store.putMetadata({ sessionId: "bad", hostId: "host", title: "Bad", pinned: false, metadata: {}, createdAt: store.now(), archived: false, metadataRevision: 0 });
    expect(root.updateHost(first, [...f.host.list(), { ...f.host.list()[0]!, sessionId: "bad", status: "invalid" as "idle" }])).toBe(true);
    expect(root.snapshot()).toMatchObject({ hosts: [{ online: true }], sessions: [{ native: null }, { native: { sessionId: "one" } }] });
    const next = root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: f.host.list() });
    expect(root.detachHost(first)).toBe(false); expect(root.updateHost(first, [])).toBe(false); expect(root.detachHost(next)).toBe(true);
    expect(root.snapshot().sessions.every(session => session.native === null)).toBe(true);
  });
  it("reconciles the original Host receipt after a lost response without a second native send", async () => {
    const f = await fixture(), { root } = await rootFixture();
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
    expect(await root.execute(send("lost"))).toMatchObject({ state: "outcomeUnknown" });
    expect(await Promise.all([root.receipt("lost"), root.receipt("lost")])).toMatchObject([{ state: "succeeded" }, { state: "succeeded" }]);
    expect(await root.execute(send("lost"))).toMatchObject({ state: "succeeded" });
    expect(f.handles[0]!.execute).toHaveBeenCalledOnce();
  });
  it("publishes one contiguous snapshot/delta stream with metadata and presence changes", async () => {
    const f = await fixture(), { root } = await rootFixture(), iterator = root.watch()[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ kind: "snapshot", snapshot: { revision: 0 } });
    const token = root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    await root.create({ ...create("one"), hostId: "host", title: "One" }); root.detachHost(token);
    const events = []; for (let i = 0; i < 5; i++) events.push((await iterator.next()).value);
    expect(events.map(event => event.delta.revision)).toEqual([1, 2, 3, 4, 5]); await iterator.return?.();
  });
  it("retains archived Root registry state when the Host disconnects", async () => {
    const f = await fixture(), { root } = await rootFixture();
    const token = root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    await root.create({ ...create("one"), hostId: "host", title: "One" });
    expect(await root.archive({ requestId: "archive", sessionId: "one" })).toMatchObject({ state: "succeeded" });
    root.detachHost(token); expect(root.snapshot().sessions[0]).toMatchObject({ archived: true, native: null });
  });
});

describe("V7 durable writer and consumer integration", () => {
  it("bounds stalled writer call count and admits close even at saturation", async () => {
    const store = await V7Store.open({ filename: ":memory:", role: "host", instanceId: "bounded-count" });
    const delayed = store.delayWriterForTest(200); await eventDrained();
    const requests = Array.from({ length: V7_STORE_MAX_PENDING_CALLS - 1 }, (_, i) => store.receipt(`bounded-${i}`));
    await expect(store.admit("rejected", "session", "execute", {})).rejects.toMatchObject({ code: "STORE_BUSY" });
    await eventDrained(); // all reserved calls have now crossed postMessage.
    const closed = store.close(); await Promise.all([delayed, ...requests, closed]);
  });
  it("bounds queued bytes and releases capacity after every acknowledged response", async () => {
    const f = await fixture(); await f.host.create(create("one"));
    const delayed = f.store.delayWriterForTest(200); await eventDrained();
    const payload = { text: "x".repeat(850_000) };
    const requests = Array.from({ length: 9 }, (_, i) => f.store.admit(`large-${i}`, "one", "read-fixture", payload));
    await expect(f.store.admit("byte-overflow", "one", "read-fixture", payload)).rejects.toMatchObject({ code: "STORE_BUSY" });
    await expect(f.host.execute(send("no-native-on-overflow", "one", payload.text))).rejects.toMatchObject({ code: "STORE_BUSY" });
    expect(f.handles[0]!.execute).not.toHaveBeenCalled();
    await Promise.all([delayed, ...requests]);
    expect(await f.host.execute(send("after-drain"))).toMatchObject({ state: "succeeded" });
    expect(await f.store.receipt("byte-overflow")).toBeNull();
  });
  it("does not dispatch through a Host replaced during the Root durable boundary", async () => {
    const f = await fixture(), { root, store } = await rootFixture();
    root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    await root.create({ ...create("one"), hostId: "host", title: "One" });
    const transition = store.transition.bind(store), blocked = deferred<import("../src/protocol.js").RequestReceipt>();
    const reached = deferred<void>();
    vi.spyOn(store, "transition").mockImplementation(async (requestId, state, outcome) => {
      const receipt = await transition(requestId, state, outcome);
      if (requestId === "stale-route" && state === "dispatched") { reached.resolve(); return blocked.promise; }
      return receipt;
    });
    const pending = root.execute(send("stale-route")); await reached.promise;
    root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: f.host.list() });
    blocked.resolve((await store.receipt("stale-route"))!);
    expect(await pending).toMatchObject({ state: "failed", error: { code: "HOST_REPLACED_BEFORE_DISPATCH" } });
    expect(f.handles[0]!.execute).not.toHaveBeenCalled();
  });
  it("rejects same-ID operation changes while an identical envelope is in flight", async () => {
    const f = await fixture(), { root } = await rootFixture();
    root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    await root.create({ ...create("one"), hostId: "host", title: "One" });
    const stopped = deferred<void>(); f.handles[0]!.stop.mockImplementationOnce(() => stopped.promise);
    const input = { requestId: "shared-id", sessionId: "one" }, pending = root.stop(input);
    await vi.waitFor(() => expect(f.handles[0]!.stop).toHaveBeenCalledOnce());
    await expect(root.archive(input)).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    await expect(f.host.archive(input)).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    stopped.resolve(); expect(await pending).toMatchObject({ state: "succeeded", operation: "stop" });
    expect(root.snapshot().sessions[0]!.archived).toBe(false);
  });
  it("closes its writer once and rejects new operations without leaving pending promises", async () => {
    const store = await V7Store.open({ filename: ":memory:", role: "host", instanceId: "closing" });
    cleanup.push(() => store.close()); const delayed = store.delayWriterForTest(100); await eventDrained();
    const first = store.close(), second = store.close(); expect(second).toBe(first);
    await expect(store.receipt("later")).rejects.toMatchObject({ code: "CLOSED" });
    await Promise.all([delayed, first, second]);
  });
  it("snapshots caller input before an asynchronous durability boundary", async () => {
    const f = await fixture(); await f.host.create(create("one"));
    const delayed = f.store.delayWriterForTest(100); await eventDrained();
    const input = send("owned-input"), pending = f.host.execute(input);
    input.command.command.prompt = "caller changed this";
    expect(await pending).toMatchObject({ state: "succeeded", request: send("owned-input") });
    expect(f.handles[0]!.execute).toHaveBeenCalledExactlyOnceWith(send("owned-input").command); await delayed;
    const binding = f.store.binding("one")!, write = f.store.putBinding(binding); binding.archived = true;
    await write; expect(f.store.binding("one")!.archived).toBe(false);
  });
  it("keeps presence, committed views and healthy native streams responsive while both writers stall", async () => {
    const f = await fixture(), { root, store } = await rootFixture();
    root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    await root.create({ ...create("blocked"), hostId: "host", title: "Blocked" });
    await root.create({ ...create("peer"), hostId: "host", title: "Peer" });
    const events: import("../src/protocol.js").HostEvent[] = [];
    const unsubscribe = f.host.subscribe(event => events.push(event)); cleanup.push(unsubscribe);
    let heartbeats = 0;
    const timer = setInterval(() => {
      expect(f.host.list()).toHaveLength(2); expect(root.snapshot().hosts[0]!.online).toBe(true); heartbeats += 1;
    }, 5); cleanup.push(() => clearInterval(timer));
    const hostBlocked = f.store.delayWriterForTest(250), rootBlocked = store.delayWriterForTest(250);
    f.handles[0]!.execute.mockImplementationOnce(async () => {
      expect(heartbeats).toBeGreaterThan(0);
      expect((await f.store.receipt("durable"))?.state).toBe("dispatched");
      return { accepted: true };
    });
    const request = root.execute(send("durable", "blocked"));
    f.handles[1]!.emit({ kind: "native", nativeType: "message", payload: { text: "healthy" }, ephemeral: false });
    await eventDrained();
    expect(events.some(event => event.kind === "event" && event.event.kind === "native" && event.event.sessionId === "peer")).toBe(true);
    expect(await root.history({ sessionId: "peer", request: { harness: "copilot", limit: 10 } })).toMatchObject({ payload: { json: { history: [] } } });
    expect(await request).toMatchObject({ state: "succeeded" }); await Promise.all([hostBlocked, rootBlocked]);
  });
  it("retains image descriptors at both receipt edges and refuses preparation before any native dispatch", async () => {
    const prepareCommand = vi.fn(async (input: import("../src/protocol.js").ExecuteInput) => input.command);
    const f = await fixture({ prepareCommand }), { root } = await rootFixture();
    root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    await root.create({ ...create("one"), hostId: "host", title: "One" });
    const images: import("@arduano/agent-multiplex-protocol").CommandImageBinding[] = [{ pointer: "/command/image", representation: "base64", image: {
      imageId: "11111111-1111-4111-8111-111111111111", sessionId: "22222222-2222-4222-8222-222222222222",
      runtimeNodeId: "33333333-3333-4333-8333-333333333333", bindingRevision: 1, sha256: "a".repeat(64), byteLength: 32, mediaType: "image/png",
    } }];
    const input = { ...send("image-send"), images };
    expect(await root.execute(input)).toMatchObject({ state: "succeeded", request: input });
    expect((await f.host.receipt(input.requestId))?.request).toEqual(input);
    expect(prepareCommand).toHaveBeenCalledExactlyOnceWith(input);
    prepareCommand.mockRejectedValueOnce(Error("immutable image missing"));
    const refused = { ...input, requestId: "image-refused" };
    expect(await root.execute(refused)).toMatchObject({ state: "failed", request: refused });
    expect((await f.store.receiptEvents(refused.requestId)).map(row => row.state)).toEqual(["admitted", "failed"]);
    expect(f.handles[0]!.execute).toHaveBeenCalledOnce();
  });
  it("reads stopped and archived native histories without resume and fences late binding responses", async () => {
    const f = await fixture(); await f.host.create(create("one"));
    f.port.history = vi.fn(async binding => ({ harness: "copilot", vendorSessionId: binding.vendorSessionId, payload: { persisted: true } }));
    await f.host.stop({ requestId: "stop", sessionId: "one" });
    expect(await f.host.history({ sessionId: "one", request: { harness: "copilot", limit: 10 } }))
      .toMatchObject({ payload: { json: { persisted: true } } });
    const delayed = deferred<Awaited<ReturnType<NonNullable<NativePort["history"]>>>>();
    vi.mocked(f.port.history).mockImplementationOnce(() => delayed.promise);
    const pending = f.host.history({ sessionId: "one", request: { harness: "copilot", limit: 10 } });
    const rejected = expect(pending).rejects.toMatchObject({ code: "STALE_ATTACHMENT" });
    await f.host.archive({ requestId: "archive", sessionId: "one" });
    delayed.resolve({ harness: "copilot", vendorSessionId: "native-0", payload: { stale: true } }); await rejected;
    expect(await f.host.history({ sessionId: "one", request: { harness: "copilot", limit: 10 } })).toMatchObject({ payload: { json: { persisted: true } } });
    expect(f.port.resume).not.toHaveBeenCalled(); expect(f.handles[0]!.readNativeHistory).not.toHaveBeenCalled();
  });
  it("applies native uncertainty immediately when image presentation is blocked", async () => {
    const delayed = deferred<import("../src/protocol.js").NativePayload>();
    const f = await fixture({ externalize: () => delayed.promise }); await f.host.create(create("one"));
    f.handles[0]!.emit({ kind: "native", nativeType: "image", payload: {}, ephemeral: false });
    f.handles[0]!.emit({ kind: "lifecycle", fact: { type: "gap" } });
    expect(f.host.list()[0]!.recoveryRequired).toBe(true);
    f.handles[0]!.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: true } });
    expect(await f.host.execute(send("unsafe"))).toMatchObject({ state: "failed", error: { code: "INTERACTION_UNCERTAIN" } });
    expect(f.handles[0]!.execute).not.toHaveBeenCalled();
    delayed.resolve({ encoding: "native-json-images-v1", json: {}, images: [] }); await eventDrained();
    expect(f.host.list()[0]!.recoveryRequired).toBe(true);
  });
  it("rejects a native gap arriving during image preparation before any native effect", async () => {
    const prepared = deferred<HarnessCommand>(), f = await fixture({ prepareCommand: () => prepared.promise });
    await f.host.create(create("one")); const input = send("preparing");
    const request = f.host.execute(input); await eventDrained();
    f.handles[0]!.emit({ kind: "lifecycle", fact: { type: "gap" } }); prepared.resolve(input.command);
    expect(await request).toMatchObject({ state: "failed", error: { code: "INTERACTION_UNCERTAIN" } });
    expect(f.handles[0]!.execute).not.toHaveBeenCalled();
  });
  it("uses metadata-only revisions and atomic compare-and-set without heartbeat churn", async () => {
    const f = await fixture(), { root } = await rootFixture();
    const token = root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: [] });
    await root.create({ ...create("one"), hostId: "host", title: "One" });
    const revision = root.snapshot().revision;
    for (let i = 0; i < 10; i++) expect(root.updateHost(token, f.host.list())).toBe(true);
    expect(root.snapshot().revision).toBe(revision); expect(root.snapshot().sessions[0]!.metadataRevision).toBe(0);
    const results = await Promise.all([
      root.updateMetadata({ requestId: "first-cas", sessionId: "one", expectedMetadataRevision: 0, title: "First" }),
      root.updateMetadata({ requestId: "second-cas", sessionId: "one", expectedMetadataRevision: 0, title: "Second" }),
    ]);
    expect(results.map(receipt => receipt.state).sort()).toEqual(["failed", "succeeded"]);
    expect(results.find(receipt => receipt.state === "failed")?.error?.code).toBe("METADATA_CONFLICT");
    expect(root.snapshot().sessions[0]!.metadataRevision).toBe(1);
    await Promise.all([
      root.archive({ requestId: "archive", sessionId: "one" }),
      root.updateMetadata({ requestId: "patch", sessionId: "one", metadata: { concurrent: true }, pinned: true }),
    ]);
    expect(root.snapshot().sessions[0]).toMatchObject({ archived: true, metadata: { concurrent: true }, pinned: true, metadataRevision: 3 });
  });
  it("fences browser mutations to the exact observed attachment", async () => {
    const f = await fixture(); await f.host.create(create("one")); const attachment = f.host.list()[0]!.attachmentId;
    await f.host.recover({ requestId: "recover", sessionId: "one", expectedAttachmentId: attachment });
    expect(await f.host.execute({ ...send("old-browser"), expectedAttachmentId: attachment }))
      .toMatchObject({ state: "failed", error: { code: "STALE_ATTACHMENT" } });
    expect(f.handles[1]!.execute).not.toHaveBeenCalled();
  });
});
