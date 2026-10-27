import test from "node:test";
import assert from "node:assert/strict";
import type { Peer } from "@arduano/p2prpc-core";
import { P2pGatewayTransport, type GatewayP2pRouter } from "../src/node/p2prpc.js";
import type { SessionSnapshot } from "../../v8-session/src/contracts/types.js";
import { FixtureSession, target, scope, historyScope, deferred, until } from "./fixture.js";

test("P2P unary observation cancellation never aborts shared Peer setup and retains the admitted read until actual settlement", async () => {
  type Call = { method: "recover" | "mcpRefresh"; input: unknown; options: { signal?: AbortSignal } | undefined; result: ReturnType<typeof deferred<unknown>> };
  const calls: Call[] = []; let active = 0, quarantined = 0, peerClosed = 0;
  const mutate = (method: Call["method"]) => (input: unknown, options?: { signal?: AbortSignal }): Promise<unknown> => {
    const result = deferred<unknown>(); calls.push({ method, input, options, result }); active++;
    const abort = () => { quarantined++; result.reject(Object.assign(Error("Raw RPC setup cancelled"), { code: "CANCELLED" })); };
    if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener("abort", abort, { once: true });
    return result.promise.finally(() => { active--; options?.signal?.removeEventListener("abort", abort); });
  };
  const peer = { rpc: { recover: { mutate: mutate("recover") }, mcpRefresh: { mutate: mutate("mcpRefresh") } }, close() { peerClosed++; } } as unknown as Peer<GatewayP2pRouter>;
  const transport = new P2pGatewayTransport(peer), run = { scope, generation: 1, nativeSession: "native" };
  const historyAbort = new AbortController(), mcpAbort = new AbortController();
  const history = transport.recover(target, historyScope, { signal: historyAbort.signal, timeoutMs: 17 });
  const mcp = transport.mcpRefresh(target, run, { signal: mcpAbort.signal, timeoutMs: 23 });
  const cancelled = Promise.all([assert.rejects(history, { code: "CANCELLED" }), assert.rejects(mcp, { code: "CANCELLED" })]);
  historyAbort.abort(); mcpAbort.abort(); await cancelled;
  assert.equal(quarantined, 0, "Viewer cancellation cannot reach raw published RPC setup");
  assert.equal(active, 2, "Observer cancellation does not release the admitted work");
  assert.deepEqual(calls.map(call => ({ method: call.method, input: call.input, options: call.options })), [
    { method: "recover", input: { target, scope: historyScope, timeoutMs: 17 }, options: undefined },
    { method: "mcpRefresh", input: { target, run, timeoutMs: 23 }, options: undefined },
  ]);
  const preAborted = AbortSignal.abort();
  await assert.rejects(transport.recover(target, historyScope, { signal: preAborted }), { code: "CANCELLED" });
  await assert.rejects(transport.mcpRefresh(target, run, { signal: preAborted }), { code: "CANCELLED" });
  assert.equal(calls.length, 2, "Pre-aborted observation dispatches nothing and cancellation never retries");
  calls[0]!.result.resolve({ state: "value", value: { status: "unsupported" } });
  calls[1]!.result.reject(Error("Late remote read failure"));
  await until(() => active === 0); transport.close(); assert.equal(peerClosed, 0);
});

test("P2P adapter close promptly fences its unary observers while another adapter keeps using the same Peer", async () => {
  const held: ReturnType<typeof deferred<unknown>>[] = []; let active = 0, rawAborted = 0, peerClosed = 0, snapshots = 0;
  const mutate = (_input: unknown, options?: { signal?: AbortSignal }): Promise<unknown> => {
    const result = deferred<unknown>(); held.push(result); active++;
    const abort = () => { rawAborted++; result.reject(Error("Raw RPC setup cancelled")); };
    options?.signal?.addEventListener("abort", abort, { once: true });
    return result.promise.finally(() => { active--; options?.signal?.removeEventListener("abort", abort); });
  };
  const session = new FixtureSession(), peer = { rpc: { recover: { mutate }, mcpRefresh: { mutate }, snapshot: { query: async () => { snapshots++; return session.state; } } }, close() { peerClosed++; } } as unknown as Peer<GatewayP2pRouter>;
  const closing = new P2pGatewayTransport(peer), healthy = new P2pGatewayTransport(peer), run = { scope, generation: 1, nativeSession: "native" };
  const history = closing.recover(target, historyScope), mcp = closing.mcpRefresh(target, run);
  const closed = Promise.all([assert.rejects(history, { code: "CLOSED" }), assert.rejects(mcp, { code: "CLOSED" })]);
  closing.close(); await closed;
  assert.equal(rawAborted, 0); assert.equal(active, 2); assert.equal(peerClosed, 0);
  assert.deepEqual(await healthy.snapshot(target), session.state); assert.equal(snapshots, 1);
  held[0]!.resolve({ state: "value", value: { status: "unsupported" } }); held[1]!.reject(Error("Late response after viewer close"));
  await until(() => active === 0);
  await assert.rejects(closing.recover(target, historyScope), { code: "CLOSED" }); assert.equal(held.length, 2);
  healthy.close(); assert.equal(peerClosed, 0);
});

test("P2P early observer cancellation waits for exact onStarted without cancelling shared Peer or a healthy stream; setup terminal owns its cleanup", async () => {
  type Callbacks = { onStarted(): void; onData(value: SessionSnapshot): void; onError(error: unknown): void; onComplete(): void };
  const records: { callbacks: Callbacks; unsubscribed: number }[] = []; let peerClosed = 0, setup: "normal" | "error" | "throw" = "normal";
  const peer = { rpc: { sessionWatch: { subscribe(_input: unknown, callbacks: Callbacks) {
    const record = { callbacks, unsubscribed: 0 }; records.push(record);
    if (setup === "throw") throw Error("local setup failed");
    if (setup === "error") callbacks.onError(Error("published setup failed"));
    return { unsubscribe() { record.unsubscribed++; } };
  } } }, close() { peerClosed++; } } as unknown as Peer<GatewayP2pRouter>;
  const transport = new P2pGatewayTransport(peer), early = new AbortController(), alive = new AbortController();
  const a = transport.watchSession(target, early.signal)[Symbol.asyncIterator](), first = a.next();
  early.abort(); assert.equal((await first).done, true); assert.equal(records[0]!.unsubscribed, 0);
  const b = transport.watchSession(target, alive.signal)[Symbol.asyncIterator](), next = b.next(); records[1]!.callbacks.onStarted(); records[1]!.callbacks.onData(new FixtureSession().state);
  assert.equal((await next).done, false); assert.equal(records[1]!.unsubscribed, 0);
  records[0]!.callbacks.onStarted(); records[0]!.callbacks.onStarted(); assert.equal(records[0]!.unsubscribed, 1);
  const end = b.next(); transport.close(); assert.equal((await end).done, true); assert.equal(records[1]!.unsubscribed, 1); assert.equal(peerClosed, 0);

  const closing = new P2pGatewayTransport(peer), c = closing.watchSession(target, new AbortController().signal)[Symbol.asyncIterator](), pending = c.next(); closing.close();
  assert.equal((await pending).done, true); assert.equal(records[2]!.unsubscribed, 0); records[2]!.callbacks.onStarted(); assert.equal(records[2]!.unsubscribed, 1);
  const terminal = new P2pGatewayTransport(peer); setup = "error";
  await assert.rejects(terminal.watchSession(target, new AbortController().signal)[Symbol.asyncIterator]().next(), /published setup failed/);
  records[3]!.callbacks.onStarted(); terminal.close(); assert.equal(records[3]!.unsubscribed, 0, "native terminal already owns transport cleanup");
  const failed = new P2pGatewayTransport(peer); setup = "throw";
  await assert.rejects(failed.watchSession(target, new AbortController().signal)[Symbol.asyncIterator]().next(), /local setup failed/); failed.close(); assert.equal(records[4]!.unsubscribed, 0);
  assert.equal(peerClosed, 0);
});
