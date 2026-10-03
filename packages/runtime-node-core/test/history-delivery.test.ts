import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adapterScopeIdSchema, newCommandId, newLaunchId, newRuntimeEpoch,
  newRuntimeNodeBootId, newRuntimeNodeId, newSessionId,
  type Harness, type HarnessCommand, type JsonValue, type LifecycleFact,
  type NativeHistoryRequest, type NativeStateRequest,
} from "@arduano/agent-multiplex-protocol";
import {
  RuntimeLifecycleJournal, RuntimeNodeService, RuntimeNodeStore,
  type AdapterEvent, type AdapterNativeHistoryResult, type AdapterSession, type AgentAdapter,
} from "../src/index.js";
import { copilotHistoryDeliveryFacts } from "../../adapter-copilot/src/lifecycle.js";
import { codexHistoryDeliveryFacts } from "../../adapter-codex/src/history-delivery.js";

class HistorySession implements AdapterSession {
  readonly adapterScopeId = adapterScopeIdSchema.parse("history-delivery-fixture");
  readonly vendorSessionId = "native-history-delivery";
  runtimeEpoch = newRuntimeEpoch();
  readonly listeners = new Set<(event: AdapterEvent) => void>();
  stopped = false;
  read: (request: NativeHistoryRequest) => Promise<AdapterNativeHistoryResult>;
  execute = vi.fn(async (_command: HarnessCommand): Promise<JsonValue> => ({ messageId: "exact-message" }));
  constructor(readonly harness: Harness, readonly cwd: string) {
    this.read = async () => ({ harness, vendorSessionId: this.vendorSessionId, payload: [], complete: true });
  }
  status() { return this.stopped ? "stopped" as const : "idle" as const; }
  subscribe(listener: (event: AdapterEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(fact: LifecycleFact) { for (const listener of this.listeners) listener({ kind: "lifecycle", fact }); }
  readNativeHistory(request: NativeHistoryRequest) { return this.read(request); }
  async readNativeState(request: NativeStateRequest) {
    return { harness: this.harness, vendorSessionId: this.vendorSessionId,
      payload: request.view === "tasks" ? { tasks: [] } : { items: [], steeringMessages: [], inFlightSteeringCount: 0 } };
  }
  async stop() { this.stopped = true; }
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function fixture(harness: Harness) {
  const cwd = mkdtempSync(join(tmpdir(), "multiplex-history-delivery-"));
  const store = new RuntimeNodeStore(":memory:");
  const runtimeNodeId = newRuntimeNodeId();
  const session = new HistorySession(harness, cwd);
  const adapter: AgentAdapter = {
    harness, adapterScopeId: session.adapterScopeId,
    describe: async () => ({ harness, adapterScopeId: session.adapterScopeId, available: true, capabilities: [] }),
    listModels: async () => [], listSessions: async () => [],
    spawn: async () => session, resume: async () => { session.stopped = false; session.runtimeEpoch = newRuntimeEpoch(); return session; },
    close: async () => undefined,
  };
  const service = new RuntimeNodeService({ store, adapters: [adapter], runtimeNodeId, runtimeNodeBootId: newRuntimeNodeBootId(),
    name: "history delivery fixture", allowedRoots: [cwd] });
  cleanup.push(async () => { await service.close(); store.close(); rmSync(cwd, { recursive: true, force: true }); });
  const profile = service.launchProfiles()[0]!;
  const launch = { launchId: newLaunchId(), sessionId: newSessionId(), runtimeNodeId, payloadHash: "history-delivery-launch",
    profile: { providerId: profile.providerId, profileId: profile.profileId, contractVersion: profile.contractVersion, requestSchemaHash: profile.requestSchemaHash },
    harness, input: { cwd } };
  service.createLaunch(launch);
  await vi.waitFor(() => expect(service.getLaunch(launch.launchId)?.state).toBe("succeeded"));
  if (harness === "copilot") {
    session.emit({ type: "interactionsHydrated", items: [], complete: true });
    session.emit({ type: "childrenHydrated", items: [], complete: true });
    session.emit({ type: "rootIdle", aborted: false });
    await vi.waitFor(async () => expect((await service.readLifecycle(launch.sessionId)).view.actions.send.available).toBe(true));
  }
  const journal = new RuntimeLifecycleJournal(store);
  const state = () => store.getLifecycle(launch.sessionId)!;
  const history = () => service.readNativeHistory(launch.sessionId, { harness, includeTurns: true, limit: 100,
    ...(harness === "copilot" ? { native: { view: "primary" } } : {}) });
  const deliveries = async () => (await service.readNativeState(launch.sessionId, { harness, view: "messageDeliveries" })).payload.json;
  const send = (id = "exact-message", identified = true) => service.execute({ commandId: newCommandId(), payloadHash: `history-message-${id}`,
    sessionId: launch.sessionId, runtimeNodeId, bindingRevision: 1,
    request: harness === "copilot" ? { harness, command: { type: "send", prompt: "fixture prompt", mode: "enqueue" } }
      : { harness, command: { type: "send", input: "fixture prompt", ...(identified ? { native: { clientUserMessageId: id } } : {}) } } });
  const setPage = (events: JsonValue, complete = true) => {
    session.read = async () => ({ harness, vendorSessionId: session.vendorSessionId, payload: events, complete,
      messageDeliveryFacts: harness === "copilot" ? copilotHistoryDeliveryFacts(events as JsonValue[])
        : codexHistoryDeliveryFacts(events, session.vendorSessionId) });
  };
  return { store, service, session, journal, state, launch, history, deliveries, send, setPage };
}

const userEvent = (messageId = "exact-message", data: Record<string, JsonValue> = {}, extra: Record<string, JsonValue> = {}) => ({
  id: "historical-user-event", type: "user.message", data: { content: "fixture prompt", messageId, turnId: "exact-turn", ...data }, ...extra,
});
const itemPage = (clientId = "exact-message", extra: Record<string, JsonValue> = {}) => ({ data: [{
  turnId: "exact-turn", item: { type: "userMessage", id: "native-item", clientId, content: [] }, ...extra,
}], nextCursor: null, backwardsCursor: null });
const consumedPage = (harness: Harness) => harness === "copilot" ? [userEvent()] : itemPage();

describe("exact delivery repair from native history", () => {
  it.each(["copilot", "codex"] as const)("repairs %s consumption once and retains immutable admission", async harness => {
    const f = await fixture(harness);
    const receipt = await f.send();
    expect(receipt.state).toBe("succeeded");
    expect(f.service.observeCommand(receipt.commandId)).toMatchObject({ delivery: "accepted", continuation: "observeDelivery" });
    expect(await f.deliveries()).toMatchObject({ items: [{ commandId: receipt.commandId }] });
    f.setPage(consumedPage(harness), false);
    const result = await f.history();
    expect(f.service.observeCommand(receipt.commandId)).toMatchObject({ delivery: "consumed", continuation: "complete" });
    expect(result).not.toHaveProperty("messageDeliveryFacts");
    expect(await f.deliveries()).toMatchObject({ items: [] });
    const sequence = f.state().nextSequence;
    await f.history();
    expect(f.state().nextSequence).toBe(sequence);
    expect(f.service.getCommand(receipt.commandId)).toEqual(receipt);
    expect(f.session.execute).toHaveBeenCalledOnce();
  });

  it("preserves the Windows absent-ID case and refuses child, text or no-turn consumption", async () => {
    const f = await fixture("copilot");
    const receipt = await f.send();
    f.setPage([userEvent("another-message"), userEvent("exact-message", {}, { agentId: "child" }),
      userEvent("exact-message", { parentToolCallId: "child-tool" }),
      { type: "user.message", id: "exact-message", data: { content: "fixture prompt", turnId: "exact-turn" } }]);
    await f.history();
    expect(f.service.observeCommand(receipt.commandId)).toMatchObject({ delivery: "accepted", continuation: "observeDelivery" });
    f.setPage([userEvent("exact-message", { turnId: "" })]);
    await f.history();
    expect(f.service.observeCommand(receipt.commandId)).toMatchObject({ delivery: "displayed", continuation: "observeDelivery" });
    expect(await f.deliveries()).toMatchObject({ items: [{ commandId: receipt.commandId, state: "displayed" }] });
  });

  it("keeps Linux legacy admissions complete and exact-ID gaps unresolved", async () => {
    const f = await fixture("codex");
    f.session.execute.mockImplementation(async () => ({ ok: true }));
    const legacy = await f.send("legacy", false);
    const exact = await f.send();
    f.setPage({ data: [{ ...((itemPage().data)[0]), turnId: "" },
      ...itemPage("another-id").data], nextCursor: null, backwardsCursor: null });
    await f.history();
    expect(f.service.observeCommand(legacy.commandId)).toMatchObject({ delivery: "accepted", continuation: "complete" });
    expect(f.service.observeCommand(exact.commandId)).toMatchObject({ delivery: "accepted", continuation: "observeDelivery" });
    expect(await f.deliveries()).toMatchObject({ items: [{ commandId: exact.commandId }] });
  });

  it("cannot replay historical lifecycle to heal a genuine Copilot recovery gap", async () => {
    const f = await fixture("copilot");
    await f.send();
    f.session.emit({ type: "gap" });
    await f.service.readLifecycle(f.launch.sessionId);
    const before = f.state();
    f.setPage([userEvent(), { id: "old-start", type: "assistant.turn_start", data: {} },
      { id: "old-idle", type: "session.idle", data: { aborted: false } },
      { id: "old-queue", type: "pending_messages.modified", data: {} }]);
    await f.history();
    const after = f.state();
    expect(after).toMatchObject({ continuity: "gap", root: before.root, children: before.children,
      interactions: before.interactions, compaction: before.compaction });
    expect(after.commands[0]).toMatchObject({ consumed: true });
  });

  it.each(["copilot", "codex"] as const)("links %s history arriving before native acknowledgement", async harness => {
    const f = await fixture(harness);
    f.setPage(consumedPage(harness));
    await f.history();
    const receipt = await f.send();
    expect(f.service.observeCommand(receipt.commandId)).toMatchObject({ delivery: "consumed", continuation: "complete" });
  });

  it.each(["harness", "nativeId", "binding", "epoch"] as const)("fences a delayed history read when %s changes", async changed => {
    const f = await fixture("copilot");
    const receipt = await f.send();
    let release!: (value: AdapterNativeHistoryResult) => void;
    const gate = new Promise<AdapterNativeHistoryResult>(resolve => { release = resolve; });
    let started = false;
    f.session.read = async () => { started = true; return gate; };
    const reading = f.history();
    await vi.waitFor(() => expect(started).toBe(true));
    if (changed === "binding") {
      const { lifecycle: _lifecycle, ...row } = f.store.getSession(f.launch.sessionId)!;
      f.store.putSession({ ...row, bindingRevision: row.bindingRevision + 1 });
    }
    if (changed === "epoch") f.session.runtimeEpoch = newRuntimeEpoch();
    release({ harness: changed === "harness" ? "codex" : "copilot",
      vendorSessionId: changed === "nativeId" ? "another-native-session" : f.session.vendorSessionId,
      payload: [userEvent()], messageDeliveryFacts: copilotHistoryDeliveryFacts([userEvent()]) });
    await expect(reading).rejects.toMatchObject({ code: "FENCED" });
    expect(f.store.getLifecycle(f.launch.sessionId)?.commands[0]?.consumed).toBe(false);
    expect(f.service.getCommand(receipt.commandId)).toEqual(receipt);
  });

  it.each(["copilot", "codex"] as const)("retains %s exact delivery through a new native epoch", async harness => {
    const f = await fixture(harness);
    const receipt = await f.send();
    f.setPage(consumedPage(harness));
    await f.history();
    const fence = f.state().fence;
    const renewed = { ...fence, runtimeNodeBootId: newRuntimeNodeBootId(), runtimeEpoch: newRuntimeEpoch() };
    const next = f.journal.read(renewed);
    expect(next.commands[0]).toMatchObject({ consumed: true, messageId: "exact-message" });
    expect(next.tasks.observation.state).toBe("pending");
    expect(next.queue.observation.state).toBe("pending");
    expect(f.journal.command(receipt.commandId, renewed)).toMatchObject({ delivery: "consumed", continuation: "complete" });
  });

  it.each(["copilot", "codex"] as const)("a temporary %s history attachment cannot write an active delivery ledger", async harness => {
    const f = await fixture(harness);
    const receipt = await f.send();
    await f.service.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "temporary-history-stop",
      sessionId: f.launch.sessionId, runtimeNodeId: f.launch.runtimeNodeId, bindingRevision: 1 });
    f.setPage(consumedPage(harness));
    const result = await f.history();
    expect(result).not.toHaveProperty("messageDeliveryFacts");
    expect(f.store.getSession(f.launch.sessionId)).toMatchObject({ availability: "resumable", runtimeStatus: "stopped", runtimeEpoch: null });
    expect(f.store.getLifecycle(f.launch.sessionId)?.commands[0]?.consumed).toBe(false);
    await f.service.resume({ operation: "resume", commandId: newCommandId(), payloadHash: "temporary-history-resume",
      sessionId: f.launch.sessionId, runtimeNodeId: f.launch.runtimeNodeId, bindingRevision: 1 });
    await f.history();
    expect(f.service.observeCommand(receipt.commandId)).toMatchObject({ delivery: "consumed", continuation: "complete" });
    expect(f.session.execute).toHaveBeenCalledOnce();
  });

  it("does not consume explicitly omitted history or a failed/expired read", async () => {
    const f = await fixture("copilot");
    const receipt = await f.send();
    f.session.read = async () => ({ harness: "copilot", vendorSessionId: f.session.vendorSessionId, payload: [], complete: true,
      unavailableItem: { reason: "exceedsWireLimit", nativeItemId: "exact-message", nativeType: "user.message" } });
    await f.history();
    f.session.read = async () => { throw new Error("Copilot history cursor expired; reload the conversation"); };
    await expect(f.history()).rejects.toThrow("cursor expired");
    expect(f.service.observeCommand(receipt.commandId)).toMatchObject({ delivery: "accepted", continuation: "observeDelivery" });
    expect(await f.deliveries()).toMatchObject({ items: [{ commandId: receipt.commandId }] });
  });

  it("rejects historical work facts atomically instead of applying a valid prefix", async () => {
    const f = await fixture("copilot");
    const receipt = await f.send();
    f.session.read = async () => ({ harness: "copilot", vendorSessionId: f.session.vendorSessionId, payload: [],
      messageDeliveryFacts: [{ type: "messageConsumed", messageId: "exact-message", owner: "root" },
        { type: "rootIdle", aborted: false }] as AdapterNativeHistoryResult["messageDeliveryFacts"] });
    await expect(f.history()).rejects.toThrow("unsupported delivery evidence");
    expect(f.service.observeCommand(receipt.commandId)).toMatchObject({ delivery: "accepted" });
  });
});
