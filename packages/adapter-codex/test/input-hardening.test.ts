import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterInputNotSubmittedError, AdapterOperationPendingError, AdapterOutcomeUnknownError,
  type AdapterEvent } from "@arduano/agent-multiplex-runtime-node-core";
import type { HarnessCommand } from "@arduano/agent-multiplex-protocol";
import { CodexAdapter } from "../src/adapter.js";
import { CodexRpcClient, CodexRpcError, CodexRpcPendingError, type CodexRpcConnection } from "../src/rpc.js";
import { codexInputNotSubmitted } from "../src/input.js";

type Message = { method?: string; id?: number; params?: Record<string, unknown>; result?: unknown };
class MemoryConnection implements CodexRpcConnection {
  readonly messages: Message[] = [];
  readonly listeners = new Set<(line: string) => void>();
  readonly exits = new Set<(error: Error) => void>();
  handler: (message: Message) => unknown = message => {
    if (message.method === "initialize") return { userAgent: "agent_multiplex/0.162.1 (synthetic platform)" };
    if (message.method === "thread/start" || message.method === "thread/resume") return {
      thread: { id: "bound-thread", cwd: "/synthetic", status: { type: this.threadStatus, activeFlags: this.activeFlags }, updatedAt: 1 },
      model: "fixture", reasoningEffort: "high",
    };
    if (message.method === "turn/start") return { turn: { id: "turn-a" } };
    if (message.method === "turn/steer") return { turnId: "turn-a" };
    return {};
  };
  threadStatus = "idle";
  activeFlags: string[] | undefined = [];
  replyWrite: Promise<void> = Promise.resolve();
  startCalls = 0;
  async start() { this.startCalls += 1; }
  async send(line: string) {
    const message = JSON.parse(line) as Message;
    this.messages.push(message);
    if (!message.method) { await this.replyWrite; return; }
    if (message.id !== undefined) {
      const value = this.handler(message);
      if (value !== pending) this.reply(message, value);
    }
  }
  reply(message: Message, result: unknown) {
    this.emit({ id: message.id, ...(result instanceof CodexRpcError
      ? { error: { code: result.code, message: result.message, data: result.data } } : { result }) });
  }
  emit(value: unknown) { for (const listener of this.listeners) listener(JSON.stringify(value)); }
  notify(method: string, params: unknown) { this.emit({ method, params }); }
  onMessage(listener: (line: string) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onExit(listener: (error: Error) => void) { this.exits.add(listener); return () => this.exits.delete(listener); }
  async close() { for (const listener of this.exits) listener(new Error("synthetic transport closed")); }
  methods() { return this.messages.map(row => row.method).filter(Boolean); }
}
const pending = Symbol("native reply deliberately pending");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())); vi.useRealTimers(); });
const send = (native: Record<string, string> = { clientUserMessageId: "original-message" }): HarnessCommand =>
  ({ harness: "codex", command: { type: "send", input: "synthetic input", native } });
async function fixture({ resume = false, active = false, budget = 1000, flags = [] as string[] } = {}) {
  const connection = new MemoryConnection();
  if (active) connection.threadStatus = "active";
  connection.activeFlags = flags;
  const rpc = new CodexRpcClient({ createConnection: () => connection, requestTimeoutMs: budget });
  const adapter = new CodexAdapter({ rpcClient: rpc, mutationTimeoutMs: budget });
  cleanups.push(() => adapter.close());
  const session = resume ? await adapter.resume({ harness: "codex", vendorSessionId: "bound-thread" })
    : await adapter.spawn({ harness: "codex", cwd: "/synthetic" });
  const events: AdapterEvent[] = [];
  session.subscribe(event => events.push(event));
  return { connection, rpc, adapter, session, events };
}
async function drain() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function gate<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("Codex input ownership and CLI parity", () => {
  it("advertises pure input capabilities without starting a native runtime", () => {
    const connection = new MemoryConnection();
    const adapter = new CodexAdapter({ rpcClient: new CodexRpcClient({ createConnection: () => connection }) });
    cleanups.push(() => adapter.close());
    expect(adapter.inputCapabilities).toEqual(expect.arrayContaining([
      { name: "codex.input.atomic", version: "v1", experimental: false },
      { name: "codex.input.control", version: "v1", experimental: false },
    ]));
    expect(connection.startCalls).toBe(0);
  });

  it.each([false, true])("ordinary input uses native atomic start-or-steer with active=%s and no history preflight", async active => {
    const f = await fixture({ active });
    await expect(f.session.execute(send())).resolves.toMatchObject({ turn: { id: "turn-a" } });
    expect(f.connection.methods().filter(method => method?.startsWith("turn/"))).toEqual(["turn/start"]);
    expect(f.connection.methods()).not.toContain("thread/turns/list");
    expect(f.connection.messages.find(row => row.method === "turn/start")?.params).toMatchObject({ clientUserMessageId: "original-message" });
  });

  it("cold resume reads only bounded control metadata and caches the exact active turn", async () => {
    const f = await fixture({ resume: true, active: true });
    const original = f.connection.handler;
    f.connection.handler = row => row.method === "thread/turns/list"
      ? { data: [{ id: "active-original", status: "inProgress" }] } : original(row);
    await expect(f.session.readNativeState!({ harness: "codex", view: "input" })).resolves.toMatchObject({
      payload: { threadId: "bound-thread", turnId: "active-original", status: "running", canSteer: true },
    });
    await f.session.readNativeState!({ harness: "codex", view: "input" });
    expect(f.connection.messages.filter(row => row.method === "thread/turns/list")).toHaveLength(1);
    expect(f.connection.messages.find(row => row.method === "thread/turns/list")?.params)
      .toEqual({ threadId: "bound-thread", cursor: null, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
    expect(f.connection.methods()).not.toContain("thread/read");
  });

  it("keeps resumed missing approval capabilities uncertain until positive native absence evidence", async () => {
    const f = await fixture({ resume: true, active: true, flags: ["waitingOnApproval"] });
    expect(f.session.status()).toBe("waitingForInput");
    expect(f.events).toContainEqual({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: false } });
    f.connection.notify("serverRequest/resolved", { threadId: "bound-thread", requestId: "unexposed-old-request" });
    expect(f.events.filter(row => row.kind === "lifecycle" && row.fact.type === "interactionsHydrated")).toHaveLength(1);
    f.connection.notify("thread/status/changed", { threadId: "bound-thread", status: { type: "active", activeFlags: [] } });
    expect(f.events).toContainEqual({ kind: "lifecycle", fact: { type: "interactionsHydrated", items: [], complete: true } });
  });

  it("does not treat missing native active flags or a known nonblocking callback as complete hydration", async () => {
    const f = await fixture();
    f.connection.notify("thread/status/changed", { threadId: "bound-thread", status: { type: "active" } });
    expect(f.events.at(-2)).toMatchObject({ kind: "lifecycle", fact: { complete: false } });
    f.connection.emit({ id: 91, method: "item/tool/requestUserInput", params: { threadId: "bound-thread", isBlocking: false } });
    f.connection.notify("thread/status/changed", { threadId: "bound-thread", status: { type: "idle" } });
    expect(f.events.at(-2)).toMatchObject({ kind: "lifecycle", fact: { complete: false } });
  });

  it("rejects exact stale steering definitely without retargeting, retrying or Send fallback", async () => {
    const f = await fixture();
    f.connection.handler = row => row.method === "turn/steer"
      ? new CodexRpcError("expected active turn id `old` but found `new`", -32600) : {};
    await expect(f.session.execute({ harness: "codex", command: { type: "steer", input: "synthetic", expectedTurnId: "old" } }))
      .rejects.toMatchObject({ name: "AdapterInputNotSubmittedError", operation: "steer", reason: "expectedTurnMismatch", actualTurnId: "new" });
    expect(f.connection.methods().filter(row => row?.startsWith("turn/"))).toEqual(["turn/steer"]);
  });

  it("does not upgrade arbitrary native or transport errors to NotSubmitted proof", () => {
    expect(codexInputNotSubmitted(new CodexRpcError("no active turn to steer", -32000), "steer")).toBeUndefined();
    expect(codexInputNotSubmitted(new CodexRpcError("no active turn to steer", -32600), "send")).toBeUndefined();
    expect(codexInputNotSubmitted(new AdapterOutcomeUnknownError("transport lost"), "steer")).toBeUndefined();
    expect(codexInputNotSubmitted(new CodexRpcError("failed to submit turn input: Other", -32603), "send")).toBeUndefined();
  });

  it.each([
    { harness: "codex", command: { type: "send", input: [null] } },
    { harness: "codex", command: { type: "send", input: [{ type: "text", text: 42 }] } },
    { harness: "codex", command: { type: "steer", input: "synthetic", expectedTurnId: "invalid\nturn" } },
    { harness: "codex", command: { type: "interrupt", turnId: "" } },
  ])("classifies only explicit local validation before any native mutation as invalidInput", async invalid => {
    const f = await fixture();
    await expect(f.session.execute(invalid as HarnessCommand)).rejects.toMatchObject({
      name: "AdapterInputNotSubmittedError", reason: "invalidInput",
    });
    expect(f.connection.methods().filter(row => row?.startsWith("turn/"))).toHaveLength(0);
  });

  it("classifies a local serialization refusal without upgrading a similar remote rejection", async () => {
    const f = await fixture(); const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const invalid = { harness: "codex", command: { type: "send", input: "synthetic", native: cyclic } } as unknown as HarnessCommand;
    await expect(f.session.execute(invalid)).rejects.toMatchObject({ name: "AdapterInputNotSubmittedError", reason: "invalidInput" });
    expect(f.connection.methods()).not.toContain("turn/start");
    expect(codexInputNotSubmitted(new CodexRpcError("Native input cannot be serialized before dispatch", -32600, undefined, "response"), "send"))
      .toBeUndefined();
  });

  it.each(["Review", "Compact"])("queues %s input only after native proven rejection, preserving its identity", async kind => {
    const f = await fixture();
    f.connection.handler = row => row.method === "turn/start"
      ? new CodexRpcError(`failed to submit turn input: ActiveTurnNotSteerable { turn_kind: ${kind} }`, -32603)
      : { queuedSubmission: { id: "native-queue-id", input: row.params?.input, clientUserMessageId: row.params?.clientUserMessageId } };
    await expect(f.session.execute(send())).resolves.toMatchObject({ queuedSubmission: {
      id: "native-queue-id", clientUserMessageId: "original-message",
    } });
    expect(f.connection.methods().filter(row => row === "turn/start" || row === "thread/queue/add"))
      .toEqual(["turn/start", "thread/queue/add"]);
  });

  it("does not queue unknown start failures or discard caller turn overrides", async () => {
    const f = await fixture();
    f.connection.handler = () => new CodexRpcError("unexpected native failure", -32603);
    await expect(f.session.execute(send())).rejects.toBeInstanceOf(CodexRpcError);
    f.connection.handler = () => new CodexRpcError("failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }", -32603);
    await expect(f.session.execute(send({ clientUserMessageId: "original-message", model: "override" })))
      .rejects.toBeInstanceOf(AdapterInputNotSubmittedError);
    expect(f.connection.methods()).not.toContain("thread/queue/add");
  });

  it("uses stable Host request identity only when a caller did not supply its native identity", async () => {
    const f = await fixture();
    f.connection.handler = row => row.method === "turn/start"
      ? new CodexRpcError("failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }", -32603)
      : { queuedSubmission: { id: "queue-id", clientUserMessageId: row.params?.clientUserMessageId, input: [] } };
    await expect(f.session.execute(send({}), { requestId: "stable-command-id" })).resolves.toMatchObject({
      queuedSubmission: { clientUserMessageId: "stable-command-id" },
    });
    await expect(f.session.execute(send(), { requestId: "different-command-id" })).resolves.toMatchObject({
      queuedSubmission: { clientUserMessageId: "original-message" },
    });
  });

  it("acknowledges a heavy native queue input echo with bounded metadata, retaining exact native IDs", async () => {
    const f = await fixture();
    f.connection.handler = row => row.method === "turn/start"
      ? new CodexRpcError("failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }", -32603)
      : { queuedSubmission: { id: "queue-id", clientUserMessageId: "original-message", input: [{ image: "x".repeat(2_000_000) }] } };
    const result = await f.session.execute(send());
    expect(result).toEqual({ projection: "codex.input.queue-ack.v1", inputEcho: "omitted",
      queuedSubmission: { id: "queue-id", clientUserMessageId: "original-message" } });
    expect(JSON.stringify(result).length).toBeLessThan(256);
  });

  it("retains uncertainty after native queue storage failure but reports an unavailable queue as not submitted", async () => {
    const f = await fixture();
    let queueError = new CodexRpcError("synthetic storage failed after enqueue", -32603);
    f.connection.handler = row => row.method === "turn/start"
      ? new CodexRpcError("failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }", -32603) : queueError;
    await expect(f.session.execute(send())).rejects.toBeInstanceOf(CodexRpcError);
    queueError = new CodexRpcError("user message queue is unavailable", -32600);
    await expect(f.session.execute(send())).rejects.toMatchObject({ name: "AdapterInputNotSubmittedError", reason: "activeTurnNotSteerable" });
  });

  it("bounds unknown queue ACKs without a second enqueue, and consumes the late original ACK", async () => {
    vi.useFakeTimers(); const f = await fixture({ budget: 20 });
    f.connection.handler = row => row.method === "turn/start"
      ? new CodexRpcError("failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }", -32603) : pending;
    const result = f.session.execute(send()).catch(error => error as AdapterOperationPendingError);
    await drain(); await vi.advanceTimersByTimeAsync(20);
    const error = await result; expect(error).toBeInstanceOf(AdapterOperationPendingError);
    f.connection.reply(f.connection.messages.find(row => row.method === "thread/queue/add")!, {
      queuedSubmission: { id: "late-queue-id", clientUserMessageId: "original-message", input: [] },
    });
    await expect((error as AdapterOperationPendingError).settlement).resolves.toMatchObject({
      projection: "codex.input.queue-ack.v1", queuedSubmission: { id: "late-queue-id" },
    });
    expect(f.connection.methods().filter(row => row === "thread/queue/add")).toHaveLength(1);
  });

  it("bounds an unanswered native ACK and retains exact late settlement without replay", async () => {
    vi.useFakeTimers();
    const f = await fixture({ budget: 20 });
    f.connection.handler = () => pending;
    const result = f.session.execute(send());
    const observed = result.catch(error => error as AdapterOperationPendingError);
    await drain();
    await vi.advanceTimersByTimeAsync(20);
    const error = await observed;
    expect(error).toBeInstanceOf(AdapterOperationPendingError);
    const sent = f.connection.messages.find(row => row.method === "turn/start")!;
    f.connection.reply(sent, { turn: { id: "late-original" } });
    await expect((error as AdapterOperationPendingError).settlement).resolves.toMatchObject({ turn: { id: "late-original" } });
    expect(f.connection.methods().filter(row => row === "turn/start")).toHaveLength(1);
    expect(f.session.status()).toBe("running");
  });

  it("supports exact urgent interruption while a previous ACK remains owned", async () => {
    const f = await fixture();
    const original = f.connection.handler;
    f.connection.handler = row => row.method === "turn/start" ? pending : original(row);
    const sendPending = f.session.execute(send());
    await drain();
    await expect(f.session.execute({ harness: "codex", command: { type: "interrupt", turnId: "exact-active" } })).resolves.toEqual({});
    f.connection.reply(f.connection.messages.find(row => row.method === "turn/start")!, { turn: { id: "exact-active" } });
    await sendPending;
    expect(f.connection.messages.find(row => row.method === "turn/interrupt")?.params).toEqual({ threadId: "bound-thread", turnId: "exact-active" });
  });

  it("does not clear a newer active turn when a stale completion arrives", async () => {
    const f = await fixture();
    f.connection.notify("turn/started", { threadId: "bound-thread", turn: { id: "old" } });
    f.connection.notify("turn/started", { threadId: "bound-thread", turn: { id: "new" } });
    f.connection.notify("turn/completed", { threadId: "bound-thread", turn: { id: "old" } });
    await expect(f.session.readNativeState!({ harness: "codex", view: "input" })).resolves.toMatchObject({ payload: { turnId: "new", canSteer: true } });
    expect(f.session.status()).toBe("running");
  });

  it("does not resurrect a completed turn from a late start ACK or stale control page", async () => {
    const f = await fixture(); const normal = f.connection.handler;
    f.connection.handler = row => row.method === "turn/start" ? pending : row.method === "thread/turns/list"
      ? { data: [{ id: "already-completed", status: "inProgress" }] } : normal(row);
    const result = f.session.execute(send()); await drain();
    f.connection.notify("turn/started", { threadId: "bound-thread", turn: { id: "already-completed" } });
    f.connection.notify("turn/completed", { threadId: "bound-thread", turn: { id: "already-completed" } });
    f.connection.reply(f.connection.messages.find(row => row.method === "turn/start")!, { turn: { id: "already-completed" } });
    await result;
    expect(f.session.status()).toBe("idle");
    f.connection.notify("thread/status/changed", { threadId: "bound-thread", status: { type: "active" } });
    await expect(f.session.readNativeState!({ harness: "codex", view: "input" })).resolves.toMatchObject({ payload: { turnId: null, canSteer: false } });
  });

  it("does not revive a stopped listener when an original input ACK arrives late", async () => {
    const f = await fixture(); const normal = f.connection.handler;
    f.connection.handler = row => row.method === "turn/start" ? pending : normal(row);
    const result = f.session.execute(send()); await drain();
    await f.session.stop();
    f.connection.reply(f.connection.messages.find(row => row.method === "turn/start")!, { turn: { id: "old-accepted" } });
    await expect(result).resolves.toMatchObject({ turn: { id: "old-accepted" } });
    expect(f.session.status()).toBe("stopped");
  });

  it("keeps approval capability pending until its exact response write acknowledgement", async () => {
    vi.useFakeTimers();
    const f = await fixture({ budget: 20 });
    const write = gate<void>(); f.connection.replyWrite = write.promise;
    f.connection.emit({ id: 91, method: "item/commandExecution/requestApproval", params: { threadId: "bound-thread", turnId: "approval-turn" } });
    const interaction = f.events.find(row => row.kind === "interaction");
    if (interaction?.kind !== "interaction") throw new Error("Missing synthetic approval");
    const result = interaction.resolve({ decision: "accept" }).catch(error => error as AdapterOperationPendingError);
    await drain();
    expect(f.session.status()).toBe("waitingForInput");
    await vi.advanceTimersByTimeAsync(20);
    const error = await result;
    expect(error).toBeInstanceOf(AdapterOperationPendingError);
    expect(f.session.status()).toBe("waitingForInput");
    write.resolve();
    await (error as AdapterOperationPendingError).settlement;
    expect(f.connection.messages.filter(row => row.id === 91 && !row.method)).toHaveLength(1);
    expect(f.session.status()).toBe("idle");
  });

  it("rejects a lost response write as uncertain rather than reporting approval success", async () => {
    const f = await fixture();
    const write = gate<void>(); f.connection.replyWrite = write.promise;
    f.connection.emit({ id: 91, method: "item/commandExecution/requestApproval", params: { threadId: "bound-thread" } });
    const interaction = f.events.find(row => row.kind === "interaction");
    if (interaction?.kind !== "interaction") throw new Error("Missing synthetic approval");
    const resolution = interaction.resolve({ decision: "accept" });
    const failed = expect(resolution).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    write.reject(new Error("synthetic lost write"));
    await failed;
  });

  it("does not dispatch a retained approval callback after its session owner stops", async () => {
    const f = await fixture();
    f.connection.emit({ id: 91, method: "item/commandExecution/requestApproval", params: { threadId: "bound-thread" } });
    const interaction = f.events.find(row => row.kind === "interaction");
    if (interaction?.kind !== "interaction") throw new Error("Missing synthetic approval");
    await f.session.stop();
    await expect(interaction.resolve({ decision: "accept" })).rejects.toBeInstanceOf(AdapterOutcomeUnknownError);
    expect(f.connection.messages.filter(row => row.id === 91 && !row.method)).toHaveLength(0);
  });

  it("marks only audited pure display deltas presentation-only", async () => {
    const f = await fixture();
    for (const method of ["item/agentMessage/delta", "item/completed", "turn/completed", "unknown/future"])
      f.connection.notify(method, { threadId: "bound-thread", delta: "synthetic" });
    const rows = f.events.filter(row => row.kind === "native");
    expect(rows.find(row => row.kind === "native" && row.nativeType === "item/agentMessage/delta")).toMatchObject({ continuity: "presentation" });
    expect(rows.filter(row => row.kind === "native" && row.nativeType !== "item/agentMessage/delta").every(row => !Object.hasOwn(row, "continuity"))).toBe(true);
  });

  it("marks pure final assistant/reasoning items while preserving native question and unknown-field continuity", async () => {
    const f = await fixture();
    const items = [
      { type: "agentMessage", id: "pure", text: "synthetic final", phase: "final_answer", questions: null, delivery: null },
      { type: "reasoning", id: "reason", summary: ["synthetic"], content: ["synthetic"] },
      { type: "agentMessage", id: "question", text: "synthetic", questions: [{ id: "native-ask" }] },
      { type: "agentMessage", id: "future", text: "synthetic", futureControl: {} },
    ];
    for (const item of items) f.connection.notify("item/completed", { threadId: "bound-thread", turnId: "exact", item });
    const native = f.events.filter(row => row.kind === "native" && row.nativeType === "item/completed");
    expect(native.slice(0, 2).every(row => row.kind === "native" && row.continuity === "presentation")).toBe(true);
    expect(native.slice(2).every(row => !Object.hasOwn(row, "continuity"))).toBe(true);
  });

  it("retains raw RPC late-ACK ownership when its caller observation expires", async () => {
    vi.useFakeTimers();
    const f = await fixture({ budget: 20 }); f.connection.handler = () => pending;
    const result = f.rpc.request("thread/read", { threadId: "bound-thread", includeTurns: false }).catch(error => error);
    await drain(); await vi.advanceTimersByTimeAsync(20);
    const error = await result; expect(error).toBeInstanceOf(CodexRpcPendingError);
    f.connection.reply(f.connection.messages.find(row => row.method === "thread/read")!, { thread: { id: "bound-thread" } });
    await expect(error.settlement).resolves.toEqual({ thread: { id: "bound-thread" } });
  });

  it("bounds native initialization without dispatching queued input or starting a replacement owner", async () => {
    vi.useFakeTimers();
    const connection = new MemoryConnection(); const normal = connection.handler;
    connection.handler = row => row.method === "initialize" ? pending : normal(row);
    const rpc = new CodexRpcClient({ createConnection: () => connection, requestTimeoutMs: 20 });
    cleanups.push(() => rpc.close());
    const first = rpc.request("turn/start", { threadId: "bound-thread", input: [] }).catch(error => error);
    await drain(); await vi.advanceTimersByTimeAsync(20);
    expect(await first).toMatchObject({ name: "CodexRpcError", phase: "beforeDispatch" });
    expect(connection.methods()).toEqual(["initialize"]);
    connection.reply(connection.messages.find(row => row.method === "initialize")!, { userAgent: "agent_multiplex/0.162.1" });
    await drain(); await rpc.start();
    expect(connection.startCalls).toBe(1);
    expect(connection.methods()).not.toContain("turn/start");
  });

  it("bounds held read admission while exact controls retain their own finite slots", async () => {
    vi.useFakeTimers();
    const connection = new MemoryConnection();
    const rpc = new CodexRpcClient({ createConnection: () => connection, requestTimeoutMs: 20,
      pendingRequestLimit: 2, pendingRequestBytes: 1000, controlRequestLimit: 1, controlRequestBytes: 500 });
    cleanups.push(() => rpc.close()); await rpc.start(); connection.handler = () => pending;
    const first = rpc.request("thread/read", { threadId: "one" }).catch(error => error);
    const second = rpc.request("thread/read", { threadId: "two" }).catch(error => error);
    await drain();
    const normalBefore = rpc.pendingObservation;
    await expect(rpc.request("thread/read", { threadId: "third" })).rejects.toMatchObject({ phase: "beforeDispatch" });
    const control = rpc.request("turn/interrupt", { threadId: "one", turnId: "exact" }).catch(error => error);
    await drain();
    await expect(rpc.request("thread/unsubscribe", { threadId: "one" })).rejects.toMatchObject({ phase: "beforeDispatch" });
    expect(rpc.pendingObservation).toMatchObject({ normalCount: 2, normalBytes: normalBefore.normalBytes, controlCount: 1 });
    expect(connection.methods().filter(row => row === "thread/read")).toHaveLength(2);
    expect(connection.methods().filter(row => row === "turn/interrupt")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(20);
    const observers = await Promise.all([first, second, control]);
    expect(observers.every(error => error instanceof CodexRpcPendingError)).toBe(true);
    expect(rpc.pendingObservation).toMatchObject({ normalCount: 2, controlCount: 1 });
    for (const row of connection.messages.filter(row => row.method === "thread/read" || row.method === "turn/interrupt")) connection.reply(row, {});
    await Promise.all(observers.map(error => error.settlement));
    expect(rpc.pendingObservation).toEqual({ normalCount: 0, normalBytes: 0, controlCount: 0, controlBytes: 0 });
  });

  it("refuses oversized admission before any write and releases exact reservation on retirement", async () => {
    const connection = new MemoryConnection();
    const rpc = new CodexRpcClient({ createConnection: () => connection, pendingRequestBytes: 200 });
    cleanups.push(() => rpc.close()); await rpc.start(); connection.handler = () => pending;
    await expect(rpc.request("turn/start", { threadId: "bound", input: "x".repeat(201) })).rejects.toMatchObject({ phase: "beforeDispatch" });
    expect(connection.methods()).not.toContain("turn/start");
    const held = rpc.request("thread/read", { threadId: "bound" }).catch(error => error);
    await drain(); expect(rpc.pendingObservation.normalBytes).toBeGreaterThan(0);
    await rpc.close(); await held;
    expect(rpc.pendingObservation).toEqual({ normalCount: 0, normalBytes: 0, controlCount: 0, controlBytes: 0 });
  });
});
