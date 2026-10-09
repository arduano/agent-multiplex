import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IsolatedRpc, type IsolatedMessagePort } from "@arduano/agent-multiplex-control-node-core";
import { newCommandId, newRuntimeNodeId, newSessionId, type CommandRecord, type ResumeCommand } from "@arduano/agent-multiplex-protocol";
import { createIsolatedAccessRouter, createIsolatedControlRouter } from "../apps/control-node/src/isolated-router.js";
import { isolatedNativeObserver, ISOLATED_NATIVE_MUTATION_OBSERVER_MS } from "../apps/control-node/src/isolated-native-observer.js";

// Deterministic private IPC delivery, with the real IsolatedRpc admission,
// expiry, response credits and retirement behavior on both hops.
class Port extends EventEmitter implements IsolatedMessagePort {
  other!: Port;
  postMessage(message: unknown): void { queueMicrotask(() => this.other.emit("message", structuredClone(message))); }
}
function ports(): [Port, Port] {
  const a = new Port(), b = new Port(); a.other = b; b.other = a; return [a, b];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) };
}
function command(): ResumeCommand {
  return { operation: "resume", commandId: newCommandId(), payloadHash: "fixture-stable-operation-hash",
    sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(), bindingRevision: 1 };
}
function fixture() {
  const [outerClientPort, outerServerPort] = ports(), [reverseClientPort, reverseServerPort] = ports();
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE commands (id TEXT PRIMARY KEY, receipt TEXT NOT NULL)");
  const native = deferred<void>();
  let dispatches = 0;
  const receipt = (id: string): CommandRecord | null => {
    const row = db.prepare("SELECT receipt FROM commands WHERE id=?").get(id);
    return row ? JSON.parse(String(row.receipt)) as CommandRecord : null;
  };
  const save = (record: CommandRecord) => db.prepare("INSERT OR REPLACE INTO commands VALUES (?,?)").run(record.commandId, JSON.stringify(record));
  const reverseServer = new IsolatedRpc(reverseServerPort, async (_method, args) => {
    const [, operation, values] = args as [object, string, unknown[]];
    if (operation === "getCommand") return receipt(String(values[0]));
    const input = values[0] as ResumeCommand;
    const current = receipt(input.commandId);
    if (current) return current;
    dispatches++;
    const started: CommandRecord = { commandId: input.commandId, payloadHash: input.payloadHash, sessionId: input.sessionId,
      runtimeNodeId: input.runtimeNodeId, state: "started", request: input, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    save(started);
    await native.promise;
    const terminal: CommandRecord = { ...started, state: "succeeded", updatedAt: new Date().toISOString() };
    save(terminal); return terminal;
  });
  const reverseClient = new IsolatedRpc(reverseClientPort, () => { throw Error("Unexpected reverse call"); });
  const outerServer = new IsolatedRpc(outerServerPort, async (_method, args) => {
    const [path, input] = args as [string, any];
    if (path === "access.commands.get") return receipt(input);
    if (path === "link.commands.get") return receipt(input.commandId);
    if (path.endsWith("sessions.resume")) {
      return reverseClient.call("reverse.call", [{}, "resume", [path.startsWith("link.") ? input.command : input]], {
        mutation: true, ...isolatedNativeObserver("resume"),
      });
    }
    throw Error("Unexpected fixture procedure");
  });
  const outerClient = new IsolatedRpc(outerClientPort, () => { throw Error("Unexpected outer call"); });
  return { outerClient, reverseClient, native, receipt, dispatches: () => dispatches,
    close: () => { outerClient.close(); outerServer.close(); reverseClient.close(); reverseServer.close(); db.close(); } };
}

afterEach(() => vi.useRealTimers());

describe("durable native mutation IPC observation", () => {
  it("reproduces the old thirty-second outer expiry while the same native mutation is still owned", async () => {
    vi.useFakeTimers(); const f = fixture(), input = command();
    const call = f.outerClient.call("router", ["access.sessions.resume", input, { trustedLocalAccess: true }], { mutation: true });
    const outcome = expect(call).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    try {
      await vi.advanceTimersByTimeAsync(30_000); await outcome;
      expect(f.outerClient.diagnostics()).toMatchObject({ pending: 1, expired: 1 });
      expect(f.reverseClient.diagnostics()).toMatchObject({ pending: 1, expired: 0 });
      expect(f.receipt(input.commandId)).toMatchObject({ state: "started" });
      f.native.resolve(); await vi.advanceTimersByTimeAsync(0);
      expect(f.receipt(input.commandId)).toMatchObject({ state: "succeeded", commandId: input.commandId });
      expect(f.dispatches()).toBe(1);
    } finally { f.close(); }
  });

  it.each(["access", "link"])("accepts a slow %s Resume through both IPC hops with its original identity", async direction => {
    vi.useFakeTimers(); const f = fixture(), input = command();
    const call = direction === "access"
      ? createIsolatedAccessRouter(f.outerClient).createCaller({ trustedLocalAccess: true }).sessions.resume(input)
      : createIsolatedControlRouter(f.outerClient).createCaller({}).link.sessions.resume({ command: input } as never);
    let settled = false; void call.then(() => { settled = true; });
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(settled).toBe(false); expect(f.dispatches()).toBe(1);
      expect(f.outerClient.diagnostics()).toMatchObject({ pending: 1, expired: 0 });
      expect(f.reverseClient.diagnostics()).toMatchObject({ pending: 1, expired: 0 });
      f.native.resolve();
      await expect(call).resolves.toMatchObject({ state: "succeeded", commandId: input.commandId, payloadHash: input.payloadHash });
      expect(f.receipt(input.commandId)).toMatchObject({ state: "succeeded", commandId: input.commandId });
      expect(f.dispatches()).toBe(1);
    } finally { f.close(); }
  });

  it("retains expired native ownership and reconciles the exact durable receipt without another dispatch", async () => {
    vi.useFakeTimers(); const f = fixture(), input = command();
    const access = createIsolatedAccessRouter(f.outerClient).createCaller({ trustedLocalAccess: true });
    const call = access.sessions.resume(input);
    const outcome = expect(call).rejects.toMatchObject({ code: "BAD_GATEWAY" });
    try {
      await vi.advanceTimersByTimeAsync(ISOLATED_NATIVE_MUTATION_OBSERVER_MS);
      await outcome;
      expect(f.reverseClient.diagnostics()).toMatchObject({ pending: 1, expired: 1 });
      expect(f.dispatches()).toBe(1);
      expect(await access.commands.get(input.commandId)).toMatchObject({ state: "started", commandId: input.commandId });
      f.native.resolve(); await vi.advanceTimersByTimeAsync(0);
      expect(await access.commands.get(input.commandId)).toMatchObject({ state: "succeeded", commandId: input.commandId, payloadHash: input.payloadHash });
      expect(f.reverseClient.diagnostics().pending).toBe(0);
      expect(f.dispatches()).toBe(1);
    } finally { f.close(); }
  });

  it("retired IPC does not dispatch a replacement and leaves the original native receipt readable", async () => {
    vi.useFakeTimers(); const f = fixture(), input = command();
    const call = f.reverseClient.call("reverse.call", [{}, "resume", [input]], { mutation: true, ...isolatedNativeObserver("resume") });
    const outcome = expect(call).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    try {
      await vi.advanceTimersByTimeAsync(0); f.reverseClient.close(); await outcome;
      await expect(f.reverseClient.call("reverse.call", [{}, "resume", [input]], { mutation: true, ...isolatedNativeObserver("resume") }))
        .rejects.toMatchObject({ code: "UNAVAILABLE" });
      f.native.resolve(); await vi.advanceTimersByTimeAsync(0);
      expect(f.receipt(input.commandId)).toMatchObject({ state: "succeeded", commandId: input.commandId });
      expect(f.dispatches()).toBe(1);
    } finally { f.close(); }
  });

  it("keeps catalog, enrollment and receipt observers at their ordinary thirty-second limit", async () => {
    vi.useFakeTimers(); const [clientPort, serverPort] = ports();
    const pending = deferred<void>();
    const server = new IsolatedRpc(serverPort, () => pending.promise);
    const client = new IsolatedRpc(clientPort, () => undefined);
    const calls = ["access.sources.snapshot", "access.commands.get", "ingress.gateways.enroll", "getCommand"].map(operation =>
      client.call("read", [], isolatedNativeObserver(operation)).catch(error => error));
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await Promise.all(calls)).map(error => error.code)).toEqual(["UNAVAILABLE", "UNAVAILABLE", "UNAVAILABLE", "UNAVAILABLE"]);
      expect(client.diagnostics()).toMatchObject({ pending: 4, expired: 4 });
      pending.resolve(); await vi.advanceTimersByTimeAsync(0);
      expect(client.diagnostics().pending).toBe(0);
    } finally { client.close(); server.close(); }
  });
});
