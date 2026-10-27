import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHost } from "../../v8-lifecycle-default/src/assembly.js";
import { deferred, scriptedHost, until } from "./fixture.js";
import { HistoryClient } from "../../v8-history/src/client/history-client.js";
import type { AcquisitionBatch } from "../../v8-history/src/acquisition/types.js";
import type { CodexScope, Scope } from "../../v8-history/src/contracts/types.js";
import type { HostHistory } from "../src/contracts.js";

test("cold stopped history prepares once under the existing read owner and releases before explicit Resume", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-stopped-recovery-"));
  const scope = { connection: "stopped", principal: "owner", host: "codex", session: "logical" };
  const driver = scriptedHost("codex", { cwd: directory }), gate = deferred<void>();
  let prepared = false, preparations = 0, pages = 0, releases = 0;
  const history: HostHistory = {
    async prepare() { preparations++; await gate.promise; prepared = true; },
    async release() { if (prepared) { prepared = false; releases++; } },
    port: (_run, attached) => ({ scope: attached, context: prepared ? "exact-persisted-reader" : "inactive-before-preparation",
      mode: prepared ? "persisted" : "active", async read() {
        assert.equal(prepared, true); pages++;
        return { scope: attached, status: "ok", records: [{ id: "saved-answer", kind: "assistant", lifecycle: "completed",
          body: { kind: "complete", text: "saved native text", evidence: "nativeFullBody" }, native: {} }], gaps: [], hasMore: false, nextCursor: null };
      } }),
  };
  const options = { directory, cwd: directory, scope, controller: driver.controller, history,
    policy: { kind: "codex" as const, provider: "copilot-only" as const, access: { approval: "on-request" as const, sandbox: "danger-full-access" as const } } };
  let host = await openHost(options);
  try {
    await host.session.submit({ scope, id: "create", generation: 0, command: { type: "create" } });
    await until(async () => (await host.session.snapshot(scope)).phase === "running");
    assert.equal(preparations, 0); assert.equal(pages, 0);
    await host.session.submit({ scope, id: "stop", generation: 1, command: { type: "stop" } });
    await until(async () => (await host.session.snapshot(scope)).phase === "stopped");
    await until(() => host.updateReadiness().ready);
    await host.close(); host = await openHost(options);
    const binding = (await host.binding())!, watch = host.history.watch(binding.history);
    await watch.next(); await watch.return();
    assert.equal(preparations, 0, "cold mount and retained observation must not acquire a native reader");
    assert.deepEqual(await host.history.recover(binding.history, { timeoutMs: 0 }), { state: "waitingExpired" });
    await until(() => preparations === 1);
    assert.equal(host.updateReadiness().ready, false, "expired observer retains actual preparation capacity");
    assert.equal((await host.session.submit({ scope, id: "archive-held-reader", generation: 1, command: { type: "archive" } })).state, "refused");
    assert.equal((await host.session.snapshot(scope)).archive, undefined, "busy history has not permanently sealed the session");
    const recovery = host.history.recover(binding.history);
    gate.resolve(); assert.deepEqual(await recovery, { state: "value", value: { status: "ready" } });
    assert.equal(preparations, 1); assert.equal(pages, 1);
    assert.equal(host.history.snapshot(binding.history).rows[0]!.body.kind, "complete");
    // Native end-of-page is not a captured start-coverage certificate. Repeating
    // the same exception joins its result without another allocation/body read.
    assert.deepEqual(await host.history.recover(binding.history), { state: "value", value: { status: "ready" } });
    assert.equal(preparations, 1); assert.equal(pages, 1);
    await host.session.submit({ scope, id: "explicit-resume", generation: 1, command: { type: "resume" } });
    await until(async () => (await host.session.snapshot(scope)).generation === 2);
    assert.equal(releases, 1); assert.equal(driver.counts.resumes, 1);
    assert.equal(driver.counts.opens, 1); assert.equal(driver.counts.sends, 0);
    await host.session.submit({ scope, id: "cleanup-stop", generation: 2, command: { type: "stop" } });
    await until(async () => (await host.session.snapshot(scope)).phase === "stopped");
  } finally { gate.resolve(); await host.terminate(); await rm(directory, { recursive: true, force: true }); }
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "v8-child-admission-"));
  const scope = { connection: "admission", principal: "owner", host: "codex", session: "logical" };
  const driver = scriptedHost("codex", { cwd: directory }), gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const proofs: string[] = [], pages: string[] = [];
  let reject = "";
  const host = await openHost({ directory, cwd: directory, scope, controller: driver.controller,
    policy: { kind: "codex", provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } },
    history: {
      authorize: async (_run, target, assertCurrent) => {
        assert.equal(target.kind, "codex"); const id = (target as CodexScope).threadId;
        proofs.push(id); await gates.get(id)?.promise; assertCurrent();
        if (id === reject) throw new Error("Scripted ancestry rejected");
      },
      port: (_run, target) => ({ scope: target, context: "scripted-exact-reader", mode: "active", read: async () => {
        const id = (target as CodexScope).threadId; pages.push(id);
        return { scope: target, status: "ok", records: [{ id: `baseline-${id}`, kind: "user", lifecycle: "completed",
          body: { kind: "complete", text: `prior ${id}`, evidence: "nativeFullBody" }, native: {} }], hasMore: false, nextCursor: null, gaps: [] } satisfies AcquisitionBatch;
      } }),
    },
  });
  await host.session.submit({ scope, id: "create", generation: 0, command: { type: "create" } });
  await until(async () => (await host.session.snapshot(scope)).phase === "running");
  const root = (await host.binding())!.history as CodexScope;
  const child = (id: string): CodexScope => ({ ...root, threadId: id });
  const hold = (id: string) => { const gate = deferred<void>(); gates.set(id, gate); return gate; };
  return { host, driver, scope, root, child, hold, proofs, pages, reject: (id: string) => { reject = id; },
    async close() { for (const gate of gates.values()) gate.resolve(); await host.terminate(); await rm(directory, { recursive: true, force: true }); },
  };
}

const absent = (host: Awaited<ReturnType<typeof fixture>>["host"], scope: Scope) => {
  assert.throws(() => host.history.snapshot(scope), /UNKNOWN_OR_RETIRED_SCOPE/);
  assert.throws(() => host.history.watch(scope), /UNKNOWN_OR_RETIRED_SCOPE/);
};

test("cold child admission coalesces exact held proof and fetches no history until explicit recovery", async () => {
  const f = await fixture(), child = f.child("cold-child"), gate = f.hold(child.threadId);
  try {
    absent(f.host, child);
    const a = f.host.history.authorize(child), b = f.host.history.authorize(child);
    await until(() => f.proofs.length === 1); absent(f.host, child); assert.equal(f.pages.length, 0);
    assert.equal(f.host.history.snapshot(f.root).scopeInventory!.entries.some(value => value.scope.kind === 'codex' && value.scope.threadId === child.threadId), false);
    gate.resolve(); assert.deepEqual(await a, { state: "value", value: true }); assert.deepEqual(await b, { state: "value", value: true });
    assert.equal(f.proofs.length, 1); assert.equal(f.host.history.snapshot(child).rows.length, 0);
    assert.equal(f.host.history.snapshot(f.root).scopeInventory!.entries.some(value => value.scope.kind === 'codex' && value.scope.threadId === child.threadId), true);
    const stream = f.host.history.watch(child);
    try {
      assert.equal((await stream.next()).value?.kind, "snapshot");
      assert.deepEqual(await f.host.history.recover(child), { state: "value", value: { status: "ready" } });
      assert.equal(f.pages.length, 1); assert.equal(f.host.history.snapshot(child).rows[0]!.id, "baseline-cold-child");
      assert.equal((await stream.next()).value?.kind, "commit");
    } finally { await stream.return(); }
    assert.equal(f.driver.counts.opens, 1); assert.equal(f.driver.counts.resumes, 0); assert.equal(f.driver.counts.sends, 0);
  } finally { await f.close(); }
});

test("aborted child admission observer retains actual metadata capacity until its owned proof settles", async () => {
  const f = await fixture(), a = f.child("held-a"), b = f.child("held-b"), c = f.child("held-c");
  const ga = f.hold(a.threadId), gb = f.hold(b.threadId), abort = new AbortController();
  try {
    const first = f.host.history.authorize(a, { signal: abort.signal }), rejected = assert.rejects(first, { name: "AbortError" });
    await until(() => f.proofs.length === 1); abort.abort(); await rejected;
    assert.deepEqual(await f.host.history.authorize(b, { timeoutMs: 0 }), { state: "waitingExpired" });
    await until(() => f.proofs.length === 2);
    await assert.rejects(f.host.history.authorize(c), /READ_BUSY/); assert.equal(f.proofs.length, 2); absent(f.host, a); absent(f.host, b); absent(f.host, c);
    ga.resolve(); assert.deepEqual(await f.host.history.authorize(a), { state: "value", value: true });
    assert.deepEqual(await f.host.history.authorize(c), { state: "value", value: true });
    gb.resolve(); assert.deepEqual(await f.host.history.authorize(b), { state: "value", value: true });
    assert.equal(f.pages.length, 0); assert.equal(f.driver.counts.sends, 0);
  } finally { ga.resolve(); gb.resolve(); await f.close(); }
});

test("foreign, rejected and Stop-retired child proofs never open a retained history scope", async () => {
  const f = await fixture(), failed = f.child("failed-child"), held = f.child("retired-child"), gate = f.hold(held.threadId);
  try {
    const foreign = { ...failed, origin: { ...failed.origin, principal: "someone-else" } };
    await assert.rejects(f.host.history.authorize(foreign)); absent(f.host, foreign); assert.equal(f.proofs.length, 0);
    f.reject(failed.threadId); assert.deepEqual(await f.host.history.authorize(failed), { state: "failed", code: "READ_FAILED" }); absent(f.host, failed);
    const pending = f.host.history.authorize(held); await until(() => f.proofs.length === 2);
    await f.host.session.submit({ scope: f.scope, id: "stop", generation: 1, command: { type: "stop" } });
    await until(async () => (await f.host.session.snapshot(f.scope)).phase === "stopped");
    gate.resolve(); assert.deepEqual(await pending, { state: "failed", code: "READ_FAILED" }); absent(f.host, held);
    assert.equal(f.host.history.snapshot(f.root).scopeInventory!.entries.some(value => value.scope.kind === 'codex' && value.scope.threadId === held.threadId), false);
    assert.equal(f.pages.length, 0); assert.equal(f.driver.counts.sends, 0); assert.equal(f.driver.counts.resumes, 0);
  } finally { gate.resolve(); await f.close(); }
});

test("live child capture racing cold admission preserves its rows and recovery publishes through the same stream", async () => {
  const f = await fixture(), child = f.child("racing-child"), gate = f.hold(child.threadId);
  let stream: ReturnType<typeof f.host.history.watch> | undefined, pump: Promise<void> | undefined;
  try {
    const proof = f.host.history.authorize(child); await until(() => f.proofs.length === 1);
    f.driver.notify("thread/started", { thread: { id: child.threadId, sessionId: f.root.threadId, parentThreadId: f.root.threadId,
      source: { subAgent: { thread_spawn: { parent_thread_id: f.root.threadId } } } } });
    f.driver.notify("item/completed", { threadId: child.threadId, turnId: "child-turn", item: { id: "live-answer", type: "agentMessage", text: "live child text" } });
    assert.equal(f.host.history.snapshot(child).rows.length, 1);
    const client = new HistoryClient(child); stream = f.host.history.watch(child); pump = (async () => { for await (const frame of stream!) client.apply(frame); })();
    await until(() => client.current?.rows.length === 1); const generation = client.current!.generation;
    gate.resolve(); assert.deepEqual(await proof, { state: "value", value: true });
    assert.equal(f.host.history.snapshot(child).generation, generation); assert.equal(f.host.history.snapshot(child).rows.length, 1);
    assert.deepEqual(await f.host.history.recover(child), { state: "value", value: { status: "ready" } });
    await until(() => client.current!.rows.length === 2);
    assert.equal(client.current!.generation, generation); assert.ok(client.current!.rows.some(row => row.body.kind === "complete" && row.body.text === "live child text"));
    assert.ok(client.current!.rows.some(row => row.id === "baseline-racing-child")); assert.equal(f.pages.length, 1);
    assert.equal(f.driver.counts.sends, 0); assert.equal(f.driver.counts.resumes, 0);
  } finally { gate.resolve(); await stream?.return(); await pump; await f.close(); }
});
