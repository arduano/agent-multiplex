import { afterEach, describe, expect, it, vi } from "vitest";
import { adapterScopeIdSchema, newRuntimeEpoch, type HarnessCommand, type JsonValue, type NativeHistoryRequest, type SessionRuntimeStatus } from "@arduano/agent-multiplex-protocol";
import { AdapterInputNotSubmittedError, AdapterOperationPendingError, type AgentAdapter } from "@arduano/agent-multiplex-runtime-node-core";
import { HostService, RootService, V7Store, NativeOperationError, nativePortForAdapter, requestHash, type AdapterEvent, type AdapterSession,
  type ExecuteInput, type HostApi, type HostEvent, type NativePort, type RootServiceOptions } from "../dist/index.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {}); return { promise, resolve, reject };
}
class Native implements AdapterSession {
  readonly harness = "codex" as const;
  readonly adapterScopeId = adapterScopeIdSchema.parse("isolated");
  readonly runtimeEpoch = newRuntimeEpoch(); readonly cwd = "/isolated";
  readonly listeners = new Set<(event: AdapterEvent) => void>();
  status = vi.fn((): SessionRuntimeStatus => "idle"); stop = vi.fn(async () => {});
  settings = vi.fn(() => ({ model: "isolated" }));
  execute = vi.fn(async (_command: HarnessCommand, _context?: { requestId: string }): Promise<JsonValue | undefined> => ({ accepted: true }));
  readNativeHistory = vi.fn(async (_request: NativeHistoryRequest) => ({ harness: this.harness, vendorSessionId: this.vendorSessionId, payload: {} }));
  constructor(readonly vendorSessionId: string) {}
  subscribe(listener: (event: AdapterEvent) => void) {
    this.listeners.add(listener);
    listener({ kind: "lifecycle", fact: { type: "interactionsHydrated", complete: true, items: [] } });
    return () => this.listeners.delete(listener);
  }
  emit(event: AdapterEvent) { for (const listener of this.listeners) listener(event); }
}
async function fixture(options: Partial<ConstructorParameters<typeof HostService>[0]> = {}, identity = { hostId: "host", sessionId: "one" }) {
  const handles: Native[] = [];
  const port: NativePort = { harness: "codex", adapterScopeId: "isolated", models: async () => [], close: async () => {},
    create: async () => { const handle = new Native(`native-${handles.length}`); handles.push(handle); return handle; },
    resume: async binding => { const handle = new Native(binding.vendorSessionId); handles.push(handle); return handle; } };
  const store = await V7Store.open({ filename: ":memory:", role: "host", instanceId: identity.hostId });
  const host = new HostService({ store, hostId: identity.hostId, name: "Isolated", native: port, ...options });
  const cleanup = () => host.close(); cleanups.push(cleanup);
  await host.create({ requestId: "create", sessionId: identity.sessionId, options: { harness: "codex", cwd: "/isolated" } });
  return { host, store, handles, port, cleanup };
}
const send = (requestId: string): ExecuteInput => ({ requestId, sessionId: "one", command: { harness: "codex", command: { type: "send", input: "In-memory only" } } });
function hostApi(host: HostService): HostApi {
  return { descriptor: () => host.descriptor(), list: () => host.list(), models: () => host.models(), create: input => host.create(input),
    resume: input => host.resume(input), stop: input => host.stop(input), recover: input => host.recover(input), archive: input => host.archive(input),
    execute: input => host.execute(input), resolve: input => host.resolve(input), receipt: id => host.receipt(id),
    history: input => host.history(input), nativeState: input => host.nativeState(input), interactions: id => host.interactions(id),
    watchSession: input => host.watchSession(input) };
}
async function rootFixture(options: Partial<RootServiceOptions> = {}, identity = { hostId: "host", sessionId: "one" }) {
  const f = await fixture({}, identity), store = await V7Store.open({ filename: ":memory:", role: "root", instanceId: "root" });
  await store.reserveMetadata({ sessionId: identity.sessionId, hostId: identity.hostId, title: "Isolated", pinned: false, metadata: {},
    createdAt: store.now(), archived: false, metadataRevision: 0 });
  const root = new RootService({ store, rootId: "root", ...options }), rootCleanup = () => root.close(); cleanups.push(rootCleanup);
  const api = hostApi(f.host), token = root.attachHost({ descriptor: f.host.descriptor(), api, sessions: f.host.list() });
  return { ...f, root, rootStore: store, api, token, rootCleanup };
}

describe("V7 native input ownership", () => {
  it("passes stable command identity out of band without changing native input", async () => {
    const f = await fixture(), request = send("stable-command"); await f.host.execute(request);
    expect(f.handles[0]!.execute).toHaveBeenCalledExactlyOnceWith(request.command, { requestId: request.requestId });
    expect((await f.host.receipt(request.requestId))?.request).toEqual(request);
  });
  it("normalizes only proven native not-submitted errors and retains all other ambiguity", async () => {
    const handle = new Native("native");
    const adapter = { harness: "codex", adapterScopeId: "isolated", spawn: async () => handle, resume: async () => handle,
      close: async () => {}, listModels: async () => [] } as unknown as AgentAdapter;
    const port = nativePortForAdapter(adapter), f = await fixture({ native: port });
    handle.execute.mockRejectedValueOnce(new AdapterInputNotSubmittedError("steer", "noActiveTurn"));
    expect(await f.host.execute(send("not-submitted"))).toMatchObject({ state: "failed", error: { code: "INPUT_NOT_SUBMITTED_noActiveTurn" } });
    handle.execute.mockRejectedValueOnce(Object.assign(new Error("Unclassified JSON-RPC failure"), { code: -32600 }));
    expect(await f.host.execute(send("unknown"))).toMatchObject({ state: "outcomeUnknown" });
  });
  it("bounds ACK observation while retaining the lane, then settles one late ACK", async () => {
    const f = await fixture({ nativeAckTimeoutMs: 20 }), done = deferred<JsonValue>();
    f.handles[0]!.execute.mockImplementationOnce(() => done.promise);
    const unknown = await f.host.execute(send("held")); expect(unknown.state).toBe("outcomeUnknown");
    expect(await f.host.execute(send("different"))).toMatchObject({ state: "failed", error: { code: "SESSION_BUSY" } });
    expect(await f.host.execute(send("held"))).toMatchObject({ state: "outcomeUnknown" });
    expect(f.handles[0]!.execute).toHaveBeenCalledTimes(1);
    done.resolve({ turn: { id: "turn" } });
    await vi.waitFor(async () => expect(await f.host.receipt("held")).toMatchObject({ state: "succeeded" }));
    expect(await f.host.execute(send("next"))).toMatchObject({ state: "succeeded" });
  });
  it("retains typed adapter pending settlement through the Host observation deadline", async () => {
    const f = await fixture({ nativeAckTimeoutMs: 20 }), done = deferred<JsonValue | undefined>();
    f.handles[0]!.execute.mockRejectedValueOnce(new AdapterOperationPendingError(done.promise, "send"));
    expect(await f.host.execute(send("typed-pending"))).toMatchObject({ state: "outcomeUnknown" });
    done.reject(new AdapterInputNotSubmittedError("send", "serverDraining"));
    await vi.waitFor(async () => expect(await f.host.receipt("typed-pending")).toMatchObject({ state: "failed", error: { code: "INPUT_NOT_SUBMITTED_serverDraining" } }));
  });
  it("fences a late preparation before dispatch after the caller deadline", async () => {
    const prepared = deferred<ExecuteInput["command"]>();
    const f = await fixture({ nativeAckTimeoutMs: 20, prepareCommand: () => prepared.promise });
    const request = send("late-preparation");
    expect(await f.host.execute(request)).toMatchObject({ state: "failed", error: { code: "ACK_TIMEOUT" } });
    prepared.resolve(request.command);
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    expect(f.handles[0]!.execute).not.toHaveBeenCalled();
    expect(await f.host.receipt(request.requestId)).toMatchObject({ state: "failed" });
  });
  it("never crosses native dispatch when its observation deadline expired during the dispatch-record write", async () => {
    const f = await fixture({ nativeAckTimeoutMs: 20 }), write = deferred<void>(), transition = f.store.transition.bind(f.store);
    const entered = deferred<void>();
    vi.spyOn(f.store, "transition").mockImplementation(async (id, state, outcome) => {
      const recorded = await transition(id, state, outcome);
      if (id === "gated-dispatch" && state === "dispatched") { entered.resolve(); await write.promise; }
      return recorded;
    });
    const work = f.host.execute(send("gated-dispatch")); await entered.promise;
    expect(await work).toMatchObject({ state: "failed" });
    write.resolve();
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    expect(f.handles[0]!.execute).not.toHaveBeenCalled();
    expect(await f.host.receipt("gated-dispatch")).toMatchObject({ state: "failed" });
  });
  it("does not start a later native step after an expired multi-step Recover", async () => {
    const finished = deferred<void>();
    const f = await fixture({ nativeAckTimeoutMs: 20, diagnostic: event => {
      if (event.requestId === "late-multistep-recover" && event.code === "nativeOwnershipSettled") finished.resolve();
    } }), stopped = deferred<void>(), entered = deferred<void>();
    f.handles[0]!.stop.mockImplementationOnce(() => { entered.resolve(); return stopped.promise; });
    const work = f.host.recover({ requestId: "late-multistep-recover", sessionId: "one" }); await entered.promise;
    expect(await work).toMatchObject({ state: "outcomeUnknown" }); stopped.resolve();
    await finished.promise;
    expect(f.host.list()[0]!.attachmentId).toBe(null);
    expect(f.handles).toHaveLength(1);
    expect(await f.host.receipt("late-multistep-recover")).toMatchObject({ state: "outcomeUnknown" });
  });
  it("retains partial-effect uncertainty when a later lifecycle step is definitely rejected", async () => {
    const f = await fixture();
    f.port.resume = async () => { throw new NativeOperationError("SECOND_STAGE_REJECTED", "Synthetic later-stage rejection", "failed"); };
    const attachment = f.host.list()[0]!.attachmentId!;
    expect(await f.host.recover({ requestId: "partial-recover", sessionId: "one", expectedAttachmentId: attachment }))
      .toMatchObject({ state: "outcomeUnknown", error: { code: "SECOND_STAGE_REJECTED" } });
    expect(f.handles[0]!.stop).toHaveBeenCalledTimes(1); expect(f.handles).toHaveLength(1);
  });
  it("preserves unknown certainty if terminal receipt persistence fails after a native ACK", async () => {
    const f = await fixture(), transition = f.store.transition.bind(f.store);
    vi.spyOn(f.store, "transition").mockImplementation(async (id, state, outcome) => {
      if (id === "ack-write-failure" && state === "succeeded") throw new Error("Synthetic terminal write failure");
      return transition(id, state, outcome);
    });
    expect(await f.host.execute(send("ack-write-failure"))).toMatchObject({ state: "outcomeUnknown" });
    expect(f.handles[0]!.execute).toHaveBeenCalledTimes(1);
    expect(await f.host.execute(send("ack-write-failure"))).toMatchObject({ state: "outcomeUnknown" });
    expect(f.handles[0]!.execute).toHaveBeenCalledTimes(1);
  });
  it("permits only an exact-attachment explicit-turn interrupt past a pending send", async () => {
    const f = await fixture({ nativeAckTimeoutMs: 20 }), done = deferred<JsonValue>(), native = f.handles[0]!;
    native.execute.mockImplementation(command => command.command.type === "interrupt" ? Promise.resolve({ interrupted: true }) : done.promise);
    const pending = f.host.execute(send("held"));
    await vi.waitFor(() => expect(native.execute).toHaveBeenCalledTimes(1));
    const attachment = f.host.list()[0]!.attachmentId!;
    expect(await f.host.execute({ requestId: "unfenced", sessionId: "one", command: { harness: "codex", command: { type: "interrupt", turnId: "turn" } } }))
      .toMatchObject({ state: "failed", error: { code: "SESSION_BUSY" } });
    expect(await f.host.execute({ requestId: "stale", sessionId: "one", expectedAttachmentId: "retired", command: { harness: "codex", command: { type: "interrupt", turnId: "turn" } } }))
      .toMatchObject({ state: "failed", error: { code: "STALE_ATTACHMENT" } });
    expect(await f.host.execute({ requestId: "interrupt", sessionId: "one", expectedAttachmentId: attachment, command: { harness: "codex", command: { type: "interrupt", turnId: "turn" } } }))
      .toMatchObject({ state: "succeeded" });
    done.resolve({ accepted: true }); await pending;
  });
  it("recovers only an expired owned attachment and retains a new-attachment guard until its late settlement", async () => {
    const f = await fixture({ nativeAckTimeoutMs: 20 }), done = deferred<JsonValue>(), entered = deferred<void>(), original = f.handles[0]!;
    original.execute.mockImplementationOnce(() => { entered.resolve(); return done.promise; });
    const oldListener = [...original.listeners][0]!, oldAttachment = f.host.list()[0]!.attachmentId!;
    const pending = f.host.execute(send("held"));
    await entered.promise;
    expect(await f.host.recover({ requestId: "early", sessionId: "one", expectedAttachmentId: oldAttachment }))
      .toMatchObject({ state: "failed", error: { code: "SESSION_BUSY" } });
    await pending;
    expect(await f.host.recover({ requestId: "recover", sessionId: "one", expectedAttachmentId: oldAttachment })).toMatchObject({ state: "succeeded" });
    const current = f.host.list()[0]!; expect(current.attachmentId).not.toBe(oldAttachment); expect(current.recoveryRequired).toBe(true);
    oldListener({ kind: "lifecycle", fact: { type: "gap" } });
    expect(await f.host.execute(send("during-retirement"))).toMatchObject({ state: "failed", error: { code: "SESSION_BUSY" } });
    done.resolve({ accepted: true });
    await vi.waitFor(() => expect(f.host.list()[0]).toMatchObject({ attachmentId: current.attachmentId, recoveryRequired: false }));
    expect(await f.host.receipt("held")).toMatchObject({ state: "succeeded" }); expect(f.handles).toHaveLength(2);
  });
  it("does not clear incomplete interaction hydration when the old pending operation finally settles", async () => {
    const f = await fixture({ nativeAckTimeoutMs: 20 }), done = deferred<JsonValue>();
    f.handles[0]!.execute.mockImplementationOnce(() => done.promise);
    const attachment = f.host.list()[0]!.attachmentId!; await f.host.execute(send("held"));
    await f.host.recover({ requestId: "recover", sessionId: "one", expectedAttachmentId: attachment });
    f.handles[1]!.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", complete: false, items: [] } });
    done.resolve({ accepted: true });
    await vi.waitFor(async () => expect(await f.host.receipt("held")).toMatchObject({ state: "succeeded" }));
    expect(f.host.list()[0]!.recoveryRequired).toBe(true);
  });
  it("keeps callback ownership until an awaited reverse-response write actually settles", async () => {
    const f = await fixture({ nativeAckTimeoutMs: 20 }), nativeDone = deferred<JsonValue>(), reply = deferred<JsonValue | undefined>();
    f.handles[0]!.execute.mockImplementationOnce(() => nativeDone.promise);
    const pending = f.host.execute(send("held")); await vi.waitFor(() => expect(f.handles[0]!.execute).toHaveBeenCalledTimes(1));
    const resolve = vi.fn(async () => { throw new AdapterOperationPendingError(reply.promise, "resolve"); });
    f.handles[0]!.emit({ kind: "interaction", nativeRequestId: "1", requestType: "approval", payload: {}, ephemeral: false, resolve });
    await vi.waitFor(() => expect(f.host.interactions("one")).toHaveLength(1));
    const callback = f.host.interactions("one")[0]!, attachment = f.host.list()[0]!.attachmentId!;
    const response = { requestId: "reply", sessionId: "one", expectedAttachmentId: attachment, interactionId: callback.interactionId, response: { decision: "accept" } };
    expect(await f.host.resolve(response)).toMatchObject({ state: "outcomeUnknown" }); expect(f.host.interactions("one")).toHaveLength(1);
    reply.resolve(undefined);
    await vi.waitFor(async () => expect(await f.host.receipt("reply")).toMatchObject({ state: "succeeded" }));
    expect(f.host.interactions("one")).toHaveLength(0); expect(resolve).toHaveBeenCalledTimes(1);
    nativeDone.resolve({ accepted: true }); await pending;
  });
  it("settles a retired callback's receipt without publishing its completion under a new attachment", async () => {
    const f = await fixture({ nativeAckTimeoutMs: 1_000 }), stopped = deferred<void>(), stopping = deferred<void>(), reply = deferred<void>();
    const original = f.handles[0]!, attachment = f.host.list()[0]!.attachmentId!, events: HostEvent[] = [];
    f.host.subscribe(event => events.push(event));
    original.stop.mockImplementationOnce(() => { stopping.resolve(); return stopped.promise; });
    const recovering = f.host.recover({ requestId: "recover-during-reply", sessionId: "one", expectedAttachmentId: attachment }); await stopping.promise;
    original.emit({ kind: "interaction", nativeRequestId: "1", requestType: "approval", payload: {}, ephemeral: false, resolve: () => reply.promise });
    await vi.waitFor(() => expect(f.host.interactions("one")).toHaveLength(1));
    const interaction = f.host.interactions("one")[0]!;
    const responding = f.host.resolve({ requestId: "retired-reply", sessionId: "one", expectedAttachmentId: attachment,
      interactionId: interaction.interactionId, response: {} });
    await vi.waitFor(async () => expect(await f.host.receipt("retired-reply")).toMatchObject({ state: "dispatched" }));
    stopped.resolve(); expect(await recovering).toMatchObject({ state: "succeeded" });
    const replacement = f.host.list()[0]!.attachmentId!; expect(replacement).not.toBe(attachment);
    reply.resolve(); expect(await responding).toMatchObject({ state: "succeeded" });
    expect(events.some(value => value.kind === "event" && value.event.kind === "interactionSettled" && value.event.attachmentId === replacement)).toBe(false);
    expect(f.host.interactions("one")).toHaveLength(0);
  });
  it("requires a positive Codex interaction baseline even with an empty exposed callback map", async () => {
    const native = new Native("unknown-baseline"); native.status.mockReturnValue("waitingForInput");
    vi.spyOn(native, "subscribe").mockImplementation(listener => { native.listeners.add(listener); return () => native.listeners.delete(listener); });
    const port: NativePort = { harness: "codex", adapterScopeId: "isolated", create: async () => native, resume: async () => native,
      models: async () => [], close: async () => {} };
    const f = await fixture({ native: port });
    expect(f.host.interactions("one")).toHaveLength(0); expect(f.host.list()[0]!.recoveryRequired).toBe(true);
    expect(await f.host.execute(send("no-hydration"))).toMatchObject({ state: "failed", error: { code: "INTERACTION_UNCERTAIN" } });
    native.emit({ kind: "lifecycle", fact: { type: "interactionsHydrated", complete: true, items: [] } });
    expect(f.host.list()[0]!.recoveryRequired).toBe(false);
  });
  it("drains actual expired operation ownership and its durable terminal receipt before closing the writer", async () => {
    const f = await fixture({ nativeAckTimeoutMs: 20 }), done = deferred<JsonValue>();
    f.handles[0]!.execute.mockImplementationOnce(() => done.promise);
    await f.host.execute(send("late-close"));
    f.port.close = async () => { done.resolve({ accepted: true }); };
    const close = f.store.close.bind(f.store), states: string[] = [];
    vi.spyOn(f.store, "close").mockImplementation(async () => { states.push((await f.store.receipt("late-close"))!.state); await close(); });
    await f.host.close(); expect(states).toEqual(["succeeded"]);
  });
  it("bounds a cleanup observer without discarding the owner or closing its writer prematurely", async () => {
    const f = await fixture({ nativeAckTimeoutMs: 20, closeTimeoutMs: 20 }), done = deferred<JsonValue>(), nativeClosed = deferred<void>();
    f.handles[0]!.execute.mockImplementationOnce(() => done.promise);
    await f.host.execute(send("late-cleanup"));
    f.port.close = () => nativeClosed.promise;
    const close = f.store.close.bind(f.store), states: string[] = [];
    const closeSpy = vi.spyOn(f.store, "close").mockImplementation(async () => { states.push((await f.store.receipt("late-cleanup"))!.state); await close(); });
    await expect(f.host.close()).rejects.toMatchObject({ code: "CLEANUP_PENDING", certainty: "outcomeUnknown" });
    expect(closeSpy).not.toHaveBeenCalled();
    await expect(f.host.execute(send("closed-new-work"))).rejects.toMatchObject({ code: "CLOSED" });
    nativeClosed.resolve(); await new Promise(resolve => setImmediate(resolve)); expect(closeSpy).not.toHaveBeenCalled();
    done.resolve({ accepted: true });
    await vi.waitFor(() => expect(states).toEqual(["succeeded"]));
    cleanups.splice(cleanups.indexOf(f.cleanup), 1); // Exact late cleanup already owns and completes writer close.
  });
});

describe("V7 Root receipt ownership", () => {
  it("durably rejects a fresh original execute without any Host/native call", async () => {
    const f = await rootFixture(), request = send("preflight");
    expect(await f.root.rejectExecute(request, "CODEX_STEER_UNAVAILABLE")).toMatchObject({ state: "failed", operation: "execute", request });
    expect(f.handles[0]!.execute).not.toHaveBeenCalled();
    expect((await f.rootStore.receiptEvents(request.requestId)).map(value => value.state)).toEqual(["admitted", "failed"]);
    expect(await f.root.execute(request)).toMatchObject({ state: "failed" }); expect(f.handles[0]!.execute).not.toHaveBeenCalled();
  });
  it("reconciles a dispatched Root from a terminal Host and keeps settlement monotonic against a late forward failure", async () => {
    const f = await rootFixture(), reply = deferred<Awaited<ReturnType<HostService["execute"]>>>(), entered = deferred<void>();
    f.api.execute = async input => { await f.host.execute(input); entered.resolve(); return reply.promise; };
    const request = send("held-host-reply"), work = f.root.execute(request); await entered.promise;
    expect(await f.root.receipt(request.requestId)).toMatchObject({ state: "succeeded" });
    reply.reject(new Error("Late transport failure")); expect(await work).toMatchObject({ state: "succeeded" });
    expect((await f.rootStore.receiptEvents(request.requestId)).map(value => value.state)).toEqual(["admitted", "dispatched", "succeeded"]);
    expect(f.handles[0]!.execute).toHaveBeenCalledTimes(1);
  });
  it("coalesces bounded receipt observers without multiplying underlying hung reads", async () => {
    const f = await rootFixture({ receiptReadTimeoutMs: 10 }), reply = deferred<Awaited<ReturnType<HostService["execute"]>>>(), receipt = deferred<Awaited<ReturnType<HostService["receipt"]>>>(), entered = deferred<void>();
    f.api.execute = async input => { await f.host.execute(input); entered.resolve(); return reply.promise; };
    f.api.receipt = vi.fn(() => receipt.promise);
    const request = send("coalesced"), work = f.root.execute(request); await entered.promise;
    await Promise.all([expect(f.root.receipt(request.requestId)).rejects.toMatchObject({ code: "RECEIPT_TIMEOUT" }),
      expect(f.root.receipt(request.requestId)).rejects.toMatchObject({ code: "RECEIPT_TIMEOUT" })]);
    await expect(f.root.receipt(request.requestId)).rejects.toMatchObject({ code: "RECEIPT_TIMEOUT" });
    expect(f.api.receipt).toHaveBeenCalledTimes(1);
    const known = (await f.host.receipt(request.requestId))!; receipt.resolve(known);
    await vi.waitFor(async () => expect(await f.root.receipt(request.requestId)).toMatchObject({ state: "succeeded" }));
    reply.resolve(known); await work;
  });
  it("bounds outstanding original-ID read owners and refuses false absence when the bound is occupied", async () => {
    const f = await rootFixture({ receiptReadTimeoutMs: 10, maxPendingReceiptReads: 1 }), receipt = deferred<Awaited<ReturnType<HostService["receipt"]>>>();
    const response = deferred<Awaited<ReturnType<HostService["execute"]>>>(), entered = deferred<void>();
    f.api.execute = async input => { await f.host.execute(input); entered.resolve(); return response.promise; };
    f.api.receipt = () => receipt.promise;
    const input = send("bounded-read"), work = f.root.execute(input); await entered.promise;
    await expect(f.root.receipt(input.requestId)).rejects.toMatchObject({ code: "RECEIPT_TIMEOUT" });
    await expect(f.root.receipt("another-original-id")).rejects.toMatchObject({ code: "RECEIPT_BUSY" });
    const known = (await f.host.receipt(input.requestId))!; receipt.resolve(known); response.resolve(known); await work;
  });
  it("does not accept a late receipt from a retired Host connection", async () => {
    const f = await rootFixture({ receiptReadTimeoutMs: 30 }), response = deferred<Awaited<ReturnType<HostService["execute"]>>>(), entered = deferred<void>();
    const receipt = deferred<Awaited<ReturnType<HostService["receipt"]>>>();
    f.api.execute = async input => { await f.host.execute(input); entered.resolve(); return response.promise; };
    f.api.receipt = () => receipt.promise;
    const input = send("retired-connection"), work = f.root.execute(input); await entered.promise;
    const read = f.root.receipt(input.requestId);
    await vi.waitFor(async () => expect(await f.rootStore.receipt(input.requestId)).toMatchObject({ state: "dispatched" }));
    f.root.detachHost(f.token);
    const known = (await f.host.receipt(input.requestId))!; receipt.resolve(known);
    expect(await read).toMatchObject({ state: "dispatched" });
    response.resolve(known); expect(await work).toMatchObject({ state: "outcomeUnknown" });
  });
  it("returns unknown at its caller deadline and records the original late terminal ACK without replay", async () => {
    const f = await rootFixture({ nativeAckTimeoutMs: 10 }), reply = deferred<Awaited<ReturnType<HostService["execute"]>>>();
    f.api.execute = () => reply.promise;
    const request = send("root-deadline"); expect(await f.root.execute(request)).toMatchObject({ state: "outcomeUnknown" });
    reply.resolve(await f.host.execute(request));
    await vi.waitFor(async () => expect(await f.root.receipt(request.requestId)).toMatchObject({ state: "succeeded" }));
    expect(f.handles[0]!.execute).toHaveBeenCalledTimes(1);
  });
  it("retains its writer until late forward ownership persists the original terminal receipt", async () => {
    const f = await rootFixture({ nativeAckTimeoutMs: 10, closeTimeoutMs: 20 }), reply = deferred<Awaited<ReturnType<HostService["execute"]>>>();
    f.api.execute = () => reply.promise;
    const request = send("root-late-close"); expect(await f.root.execute(request)).toMatchObject({ state: "outcomeUnknown" });
    const close = f.rootStore.close.bind(f.rootStore), states: string[] = [];
    const closeSpy = vi.spyOn(f.rootStore, "close").mockImplementation(async () => { states.push((await f.rootStore.receipt(request.requestId))!.state); await close(); });
    await expect(f.root.close()).rejects.toMatchObject({ code: "CLEANUP_PENDING" }); expect(closeSpy).not.toHaveBeenCalled();
    await expect(f.root.execute(send("closed-root"))).rejects.toMatchObject({ code: "CLOSED" });
    reply.resolve(await f.host.execute(request));
    await vi.waitFor(() => expect(states).toEqual(["succeeded"]));
    cleanups.splice(cleanups.indexOf(f.rootCleanup), 1);
  });
  it("retains timed-out original-ID reconciliation ownership while closing", async () => {
    const f = await rootFixture({ nativeAckTimeoutMs: 10, receiptReadTimeoutMs: 10, closeTimeoutMs: 20 });
    const reply = deferred<Awaited<ReturnType<HostService["execute"]>>>(), receipt = deferred<Awaited<ReturnType<HostService["receipt"]>>>();
    f.api.execute = () => reply.promise; f.api.receipt = () => receipt.promise;
    const request = send("root-read-close"); await f.root.execute(request);
    await expect(f.root.receipt(request.requestId)).rejects.toMatchObject({ code: "RECEIPT_TIMEOUT" });
    const close = f.rootStore.close.bind(f.rootStore), states: string[] = [];
    const closeSpy = vi.spyOn(f.rootStore, "close").mockImplementation(async () => { states.push((await f.rootStore.receipt(request.requestId))!.state); await close(); });
    await expect(f.root.close()).rejects.toMatchObject({ code: "CLEANUP_PENDING" });
    const known = await f.host.execute(request); reply.resolve(known);
    await vi.waitFor(async () => expect(await f.rootStore.receipt(request.requestId)).toMatchObject({ state: "succeeded" }));
    expect(closeSpy).not.toHaveBeenCalled(); receipt.resolve(known);
    await vi.waitFor(() => expect(states).toEqual(["succeeded"]));
    cleanups.splice(cleanups.indexOf(f.rootCleanup), 1);
  });
  it("reserves finite Root control ownership independently of saturated normal forwards", async () => {
    const f = await rootFixture({ maxPendingReceiptReads: 1, maxPendingControlForwards: 1, nativeAckTimeoutMs: 1_000 });
    const sent = deferred<JsonValue>(), interrupted = deferred<JsonValue>(), native = f.handles[0]!;
    native.execute.mockImplementation(command => command.command.type === "interrupt" ? interrupted.promise : sent.promise);
    const original = f.root.execute(send("held-normal")); await vi.waitFor(() => expect(native.execute).toHaveBeenCalledTimes(1));
    const command = { harness: "codex" as const, command: { type: "interrupt" as const, turnId: "turn" } };
    expect(await f.root.execute({ requestId: "unfenced-root", sessionId: "one", command })).toMatchObject({ state: "failed", error: { code: "ROOT_BUSY" } });
    const attachment = f.host.list()[0]!.attachmentId!;
    const control = f.root.execute({ requestId: "held-control", sessionId: "one", expectedAttachmentId: attachment, command });
    await vi.waitFor(() => expect(native.execute).toHaveBeenCalledTimes(2));
    expect(await f.root.execute({ requestId: "second-control", sessionId: "one", expectedAttachmentId: attachment, command }))
      .toMatchObject({ state: "failed", error: { code: "ROOT_BUSY" } });
    expect(native.execute).toHaveBeenCalledTimes(2);
    interrupted.resolve({ interrupted: true }); expect(await control).toMatchObject({ state: "succeeded" });
    sent.resolve({ accepted: true }); expect(await original).toMatchObject({ state: "succeeded" });
  });
  it("reserves exact MCP callback replies independently of a saturated normal Root lane", async () => {
    const f = await rootFixture({ maxPendingReceiptReads: 1 }), sent = deferred<JsonValue>(), resolve = vi.fn(async () => {});
    f.handles[0]!.execute.mockImplementationOnce(() => sent.promise);
    const original = f.root.execute(send("held-normal")); await vi.waitFor(() => expect(f.handles[0]!.execute).toHaveBeenCalledTimes(1));
    f.handles[0]!.emit({ kind: "interaction", nativeRequestId: "1", requestType: "approval", payload: {}, ephemeral: false, resolve });
    await vi.waitFor(() => expect(f.host.interactions("one")).toHaveLength(1));
    const interaction = f.host.interactions("one")[0]!, attachment = f.host.list()[0]!.attachmentId!;
    expect(await f.root.resolve({ requestId: "unfenced-reply", sessionId: "one", interactionId: interaction.interactionId, response: {} }))
      .toMatchObject({ state: "failed", error: { code: "ROOT_BUSY" } });
    expect(await f.root.resolve({ requestId: "reply", sessionId: "one", expectedAttachmentId: attachment, interactionId: interaction.interactionId, response: {} }))
      .toMatchObject({ state: "succeeded" }); expect(resolve).toHaveBeenCalledTimes(1);
    sent.resolve({ accepted: true }); await original;
  });
  it("returns the original enriched executing command to a simultaneous preflight rejection without overwriting it", async () => {
    const id = "01900000-0000-7000-8000-000000000001", sid = "01900000-0000-7000-8000-000000000002", hid = "01900000-0000-7000-8000-000000000003";
    const f = await rootFixture({}, { hostId: hid, sessionId: sid }), done = deferred<JsonValue>();
    f.handles[0]!.execute.mockImplementationOnce(() => done.promise);
    const body = { sessionId: sid, runtimeNodeId: hid, bindingRevision: 1,
      request: { harness: "codex" as const, command: { type: "steer" as const, input: "In-memory only" } } };
    const command = { ...body, commandId: id, payloadHash: requestHash(body) };
    const raw: ExecuteInput = { requestId: id, sessionId: sid, command: command.request, context: { ...command, commandId: id } as unknown as JsonValue };
    const enriched: ExecuteInput = { ...raw, command: { harness: "codex", command: { type: "steer", input: "In-memory only", expectedTurnId: "turn" } } };
    const work = f.root.execute(enriched); await vi.waitFor(() => expect(f.handles[0]!.execute).toHaveBeenCalledTimes(1));
    expect(await f.root.rejectExecute(raw, "CODEX_STEER_UNAVAILABLE")).toMatchObject({ state: "dispatched" });
    const forged: ExecuteInput = { ...raw, command: { harness: "codex", command: { type: "steer", input: "Different effect" } } };
    await expect(f.root.rejectExecute(forged, "CODEX_STEER_UNAVAILABLE")).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    done.resolve({ accepted: true }); expect(await work).toMatchObject({ state: "succeeded" });
    expect(await f.root.rejectExecute(raw, "TARGET_CHANGED")).toMatchObject({ state: "succeeded" });
    expect(f.handles[0]!.execute).toHaveBeenCalledTimes(1);
  });
});

describe("V7 proven presentation isolation", () => {
  it.each([false, true])("keeps unannotated or authoritative loss guarded (ephemeral=%s)", async ephemeral => {
    const f = await fixture({ externalize: async () => { throw new Error("Synthetic ENOSPC"); } });
    f.handles[0]!.emit({ kind: "native", nativeType: "item/completed", payload: {}, ephemeral });
    await vi.waitFor(() => expect(f.host.list()[0]!.recoveryRequired).toBe(true));
    expect(await f.host.execute(send("guarded"))).toMatchObject({ state: "failed", error: { code: "INTERACTION_UNCERTAIN" } });
  });
  it("drops only explicitly annotated ephemeral presentation failures without latching the native interaction guard", async () => {
    const f = await fixture({ externalize: async () => { throw new Error("Synthetic ENOSPC"); } });
    const events: unknown[] = []; f.host.subscribe(event => events.push(event));
    f.handles[0]!.emit({ kind: "native", nativeType: "item/agentMessage/delta", payload: {}, ephemeral: true, continuity: "presentation" });
    await vi.waitFor(() => expect(events.some(value => (value as { event?: { kind: string } }).event?.kind === "gap")).toBe(true));
    expect(f.host.list()[0]!.recoveryRequired).toBe(false);
    expect(await f.host.execute(send("after-display-loss"))).toMatchObject({ state: "succeeded" });
  });
  it("accepts explicit adapter structural proof for a pure final assistant presentation item", async () => {
    const f = await fixture({ externalize: async () => { throw new Error("Synthetic ENOSPC"); } });
    const events: unknown[] = []; f.host.subscribe(event => events.push(event));
    f.handles[0]!.emit({ kind: "native", nativeType: "item/completed", payload: { item: { type: "agentMessage", text: "Display only" } }, ephemeral: false, continuity: "presentation" });
    await vi.waitFor(() => expect(events.some(value => (value as { event?: { kind: string } }).event?.kind === "gap")).toBe(true));
    expect(f.host.list()[0]!.recoveryRequired).toBe(false);
    expect(await f.host.execute(send("after-final-display-loss"))).toMatchObject({ state: "succeeded" });
  });
  it("reserves interaction ingress while a presentation externalization is blocked", async () => {
    const display = deferred<{ encoding: "native-json-images-v1"; json: JsonValue; images: [] }>();
    const f = await fixture({ pendingEventLimit: 1, externalize: async (_binding, payload) => {
      if (typeof payload === "object" && payload !== null && "display" in payload) return display.promise;
      return { encoding: "native-json-images-v1", json: payload, images: [] };
    } });
    const native = f.handles[0]!;
    native.emit({ kind: "native", nativeType: "item/agentMessage/delta", payload: { display: true }, ephemeral: true, continuity: "presentation" });
    native.emit({ kind: "native", nativeType: "item/agentMessage/delta", payload: { display: true }, ephemeral: true, continuity: "presentation" });
    native.emit({ kind: "interaction", nativeRequestId: "1", requestType: "approval", payload: {}, ephemeral: false, resolve: async () => {} });
    await vi.waitFor(() => expect(f.host.interactions("one")).toHaveLength(1));
    expect(f.host.list()[0]!.recoveryRequired).toBe(false);
    display.resolve({ encoding: "native-json-images-v1", json: {}, images: [] });
  });
});
