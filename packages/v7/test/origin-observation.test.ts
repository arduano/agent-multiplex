import { afterEach, describe, expect, it, vi } from "vitest";
import { adapterScopeIdSchema, newRuntimeEpoch, type JsonValue } from "@arduano/agent-multiplex-protocol";
import { HostService, RootService, V7Store, type AdapterEvent, type AdapterSession, type NativePort, type SessionObservation } from "../dist/index.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { vi.useRealTimers(); for (const close of cleanup.splice(0).reverse()) await close(); });
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function fixture(extra: Partial<ConstructorParameters<typeof HostService>[0]> = {}) {
  const listeners = new Set<(event: AdapterEvent) => void>(); let status: "idle" | "running" = "running";
  const native: AdapterSession = { harness: "copilot", adapterScopeId: adapterScopeIdSchema.parse("origin-fixture"), runtimeEpoch: newRuntimeEpoch(), cwd: "/disposable", vendorSessionId: "native-origin",
    status: () => status, stop: vi.fn(async () => {}), execute: vi.fn(async () => { throw new Error("Model use forbidden"); }),
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  const port: NativePort = { harness: "copilot", adapterScopeId: "origin-fixture", create: async () => native, resume: async () => native, models: async () => [], close: async () => {} };
  const store = await V7Store.open({ filename: ":memory:", role: "host", instanceId: "host" });
  const host = new HostService({ store, hostId: "host", name: "Disposable", native: port, ...extra }); cleanup.push(() => host.close());
  expect(await host.create({ requestId: "create", sessionId: "one", options: { harness: "copilot", cwd: "/disposable" } })).toMatchObject({ state: "succeeded" });
  const emit = (event: AdapterEvent) => { for (const listener of listeners) listener(event); };
  return { host, emit, native, idle: () => { status = "idle"; emit({ kind: "status", status: "idle" }); } };
}
async function heartbeat(iterator: AsyncIterator<SessionObservation>) {
  for (let n = 0; n < 20; n++) { const next = await iterator.next(); if (next.done) throw new Error("Unexpected observer end"); if (next.value.kind === "originHeartbeat") return next.value; }
  throw new Error("Expected bounded heartbeat");
}

describe("V7 negotiated origin observation", () => {
  it("sends Host heartbeat with pending watermarks while presentation is blocked and control status completes independently", async () => {
    let release!: (value: JsonValue) => void; const waiting = new Promise<JsonValue>(resolve => { release = resolve; }); let first = true;
    const f = await fixture({ externalize: async (_binding, payload) => ({ encoding: "native-json-images-v1", json: first ? (first = false, await waiting) : payload, images: [] }) });
    vi.useFakeTimers(); const abort = new AbortController(), iterator = f.host.watchSessionObserved!({ sessionId: "one", signal: abort.signal })[Symbol.asyncIterator]();
    expect(await heartbeat(iterator)).toMatchObject({ origin: "host", receivedPresentation: 0, materializedPresentation: 0, pendingPresentations: 0 });
    f.emit({ kind: "native", nativeType: "partial", payload: { n: 1 }, ephemeral: true, continuity: "presentation" });
    f.emit({ kind: "native", nativeType: "final", payload: { n: 2 }, ephemeral: false, continuity: "presentation" });
    await flush(); f.idle(); expect(f.host.list()[0]?.status).toBe("idle");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await heartbeat(iterator)).toMatchObject({ receivedPresentation: 2, materializedPresentation: 0, pendingPresentations: 2, presentationGap: false });
    release({ n: 1 }); await flush(); await vi.advanceTimersByTimeAsync(10_000);
    expect(await heartbeat(iterator)).toMatchObject({ receivedPresentation: 2, materializedPresentation: 2, pendingPresentations: 0, presentationGap: false });
    expect(f.native.execute).not.toHaveBeenCalled(); abort.abort(); expect(vi.getTimerCount()).toBe(0); await iterator.return?.();
  });
  it("keeps a materialization gap explicit rather than claiming a later successful event filled a dropped ordinal", async () => {
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ pendingEventLimit: 1, externalize: async (_binding, payload) => { await waiting; return { encoding: "native-json-images-v1", json: payload, images: [] }; } });
    vi.useFakeTimers(); const abort = new AbortController(), iterator = f.host.watchSessionObserved!({ sessionId: "one", signal: abort.signal })[Symbol.asyncIterator](); await heartbeat(iterator);
    f.emit({ kind: "native", nativeType: "first", payload: null, ephemeral: false, continuity: "presentation" });
    f.emit({ kind: "native", nativeType: "overflow", payload: null, ephemeral: false, continuity: "presentation" });
    release(); await flush(); await vi.advanceTimersByTimeAsync(10_000);
    expect(await heartbeat(iterator)).toMatchObject({ receivedPresentation: 2, materializedPresentation: 0, pendingPresentations: 0, presentationGap: true });
    abort.abort(); await iterator.return?.();
  });
  it("never advances past a failed native materialization even when continuity was safety-critical", async () => {
    let first = true;
    const f = await fixture({ externalize: async (_binding, payload) => {
      if (first) { first = false; throw new Error("fixture rejected payload"); }
      return { encoding: "native-json-images-v1", json: payload, images: [] };
    } });
    vi.useFakeTimers(); const abort = new AbortController(), iterator = f.host.watchSessionObserved!({ sessionId: "one", signal: abort.signal })[Symbol.asyncIterator](); await heartbeat(iterator);
    f.emit({ kind: "native", nativeType: "failed-critical", payload: null, ephemeral: false });
    f.emit({ kind: "native", nativeType: "later-success", payload: null, ephemeral: false });
    await flush(); await vi.advanceTimersByTimeAsync(10_000);
    expect(await heartbeat(iterator)).toMatchObject({ receivedPresentation: 2, materializedPresentation: 0, pendingPresentations: 0, presentationGap: true });
    expect(f.host.list()[0]?.recoveryRequired).toBe(true);
    abort.abort(); await iterator.return?.();
  });
  it("leaves both legacy observer vocabularies unchanged for old Gateway consumers", async () => {
    const f = await fixture(); const rootStore = await V7Store.open({ filename: ":memory:", role: "root", instanceId: "root" });
    const root = new RootService({ store: rootStore, rootId: "root" }); cleanup.push(() => root.close());
    await rootStore.reserveMetadata({ sessionId: "one", hostId: "host", title: "Disposable", pinned: false, metadata: {}, createdAt: new Date().toISOString(), archived: false, metadataRevision: 0 });
    root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: f.host.list() });
    vi.useFakeTimers(); const abort = new AbortController(), legacyRoot = root.watch(abort.signal)[Symbol.asyncIterator](), legacyHost = f.host.watchSession({ sessionId: "one", signal: abort.signal })[Symbol.asyncIterator]();
    expect((await legacyRoot.next()).value?.kind).toBe("snapshot"); expect((await legacyHost.next()).value?.kind).toBe("session");
    let rootTick = false, hostTick = false; const r = legacyRoot.next().then(value => { rootTick = !value.done; }), h = legacyHost.next().then(value => { hostTick = !value.done; });
    await vi.advanceTimersByTimeAsync(60_000); expect(rootTick).toBe(false); expect(hostTick).toBe(false);
    abort.abort(); await Promise.all([r, h]);
  });
  it("Root forwards the genuine Host origin and refuses old Hosts instead of fabricating upstream health", async () => {
    const f = await fixture(), rootStore = await V7Store.open({ filename: ":memory:", role: "root", instanceId: "root" });
    const root = new RootService({ store: rootStore, rootId: "root" }); cleanup.push(() => root.close());
    await rootStore.reserveMetadata({ sessionId: "one", hostId: "host", title: "Disposable", pinned: false, metadata: {}, createdAt: new Date().toISOString(), archived: false, metadataRevision: 0 });
    root.attachHost({ descriptor: f.host.descriptor(), api: f.host, sessions: f.host.list() });
    const abort = new AbortController(), iterator = root.watchSessionObserved!({ sessionId: "one", signal: abort.signal })[Symbol.asyncIterator]();
    expect(await heartbeat(iterator)).toMatchObject({ origin: "host", hostId: "host", bootId: f.host.descriptor().bootId });
    abort.abort(); await iterator.return?.();
    const descriptor = { ...f.host.descriptor(), capabilities: [] };
    const oldPort = new Proxy(f.host, { get(target, key) { if (key === "descriptor") return () => descriptor;
      if (key === "watchSessionObserved") return undefined;
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value; } });
    root.attachHost({ descriptor, api: oldPort, sessions: f.host.list() });
    expect(() => root.watchSessionObserved!({ sessionId: "one" })).toThrow("Host does not support");
  });
});
