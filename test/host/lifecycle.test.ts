import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { OriginalJournal, OriginalReader } from "../../src/storage/index.js";
import { DefaultLifecycle, defaultLifecycle } from "../../src/host/index.js";
import { activateHost, defineHost, hostRouter } from "../../src/host/index.js";
import type { NativePort } from "../../src/host/contracts.js";
import type { WorkspaceStrategy } from "../../src/host/contracts.js";
import type { Json, SessionScope } from "../../src/protocol/index.js";
import type { OpeningCapsule, OpeningStopProof } from "../../src/runtime/contracts.js";

const scope: SessionScope = {
  connection: "connection",
  principal: "owner",
  host: "scripted",
  session: "one",
};
const route = { authority: "root", host: "scripted", owner: "owner", routeEpoch: "epoch" };
const context = { route };
const run = (lifecycle: {
  state(scope: SessionScope): import("../../src/host/contracts.js").SessionState<unknown, unknown>;
}) => {
  const state = lifecycle.state(scope);
  assert.equal(state.phase, "running");
  return (state as Extract<typeof state, { phase: "running" }>).run;
};
const commandInput = z.object({ kind: z.literal("continue") });
type ScriptedNative = NativePort<typeof commandInput, z.ZodType, z.ZodType, z.ZodType>;
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function proof(capsule: OpeningCapsule): OpeningStopProof {
  return {
    ...capsule,
    state: "stopped",
    scope: "nativeTree",
    acquisitionSealed: true,
    noAutomaticContinuation: true,
  };
}

async function fixture(
  overrides: Partial<NativePort<typeof commandInput, z.ZodType, z.ZodType, z.ZodType>> = {},
  workspace?: WorkspaceStrategy<typeof workspaceInput, typeof workspaceData>,
) {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-lifecycle-")),
    filename = join(directory, "journal.sqlite");
  const journal = new OriginalJournal({ filename });
  const calls = { prepare: 0, open: 0, send: 0, command: 0, stop: 0, release: 0 };
  let current: OpeningCapsule | undefined;
  const native: NativePort<typeof commandInput, z.ZodType, z.ZodType, z.ZodType> = {
    identity: { id: "scripted.native", version: 1, recordVersion: 1 },
    commandInput,
    messageInput: z.custom<Json>(),
    selectionInput: z.custom<Json>(),
    selectionOutput: z.custom<Json>(),
    readiness: () => ({ ready: true as const }),
    close() {},
    async prepare({ opening }) {
      calls.prepare++;
      current = {
        opening,
        identity: {
          attachment: `a${opening.generation}`,
          process: `p${opening.generation}`,
          containment: `c${opening.generation}`,
          placement: "dedicated",
        },
      };
      return {
        ...current,
        stop: async () => {
          calls.stop++;
          return proof(current!);
        },
      };
    },
    async open({ capsule, mode, nativeSession, selection }) {
      calls.open++;
      return {
        kind: mode === "create" ? "created" : "reopened",
        ...(mode === "create" ? { quiescent: true as const } : {}),
        run: {
          scope: capsule.opening.scope,
          generation: capsule.opening.generation,
          nativeSession: nativeSession ?? "native-one",
        },
        activity: mode === "create" ? "idle" : "working",
        selection,
      } as Awaited<ReturnType<ScriptedNative["open"]>>;
    },
    async inspect(capsule) {
      return {
        run: {
          scope: capsule.opening.scope,
          generation: capsule.opening.generation,
          nativeSession: "native-one",
        },
        activity: "idle",
        selection: { model: "scripted" },
      };
    },
    async stop(capsule) {
      calls.stop++;
      return proof(capsule);
    },
    async send() {
      calls.send++;
      return { state: "succeeded", result: { accepted: true } };
    },
    async command() {
      calls.command++;
      return { state: "succeeded", result: { accepted: true } };
    },
    ...overrides,
  };
  const selected: WorkspaceStrategy<typeof workspaceInput, typeof workspaceData> = workspace ?? {
    identity: { id: "scripted.workspace", version: 1, recordVersion: 1 },
    input: workspaceInput,
    data: workspaceData,
    async allocate() {
      return { cwd: directory, ownership: "borrowed", data: null };
    },
    async release() {
      calls.release++;
    },
  };
  const options = {
    journal,
    native,
    workspace: selected,
    selection: { model: "scripted" } as Json,
    maxSessions: 1,
  };
  const lifecycle = new DefaultLifecycle(options, context);
  return {
    lifecycle,
    journal,
    native,
    options,
    directory,
    filename,
    calls,
    async cleanup() {
      journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
const workspaceInput = z.object({ cwd: z.string() }),
  workspaceData = z.null();

test("malformed host messages are rejected before original admission or native dispatch", async () => {
  const messageInput = z.object({ text: z.string().min(1), files: z.array(z.string()) }).strict();
  const f = await fixture({ messageInput } as Partial<
    NativePort<typeof commandInput, z.ZodType, z.ZodType, z.ZodType>
  > & {
    messageInput: typeof messageInput;
  });
  try {
    await f.lifecycle.create(scope, "create", { cwd: f.directory });
    assert.throws(() => f.lifecycle.send(scope, "invalid-send", { text: 17 }, run(f.lifecycle)));
    assert.equal(f.journal.read(scope, "invalid-send"), null);
    assert.equal(f.calls.send, 0);
  } finally {
    await f.cleanup();
  }
});

test("requested selection is validated before admission and partial observed facts remain distinct", async () => {
  const entered = deferred<void>(),
    opened = deferred<Awaited<ReturnType<ScriptedNative["open"]>>>();
  const f = await fixture({
    selectionInput: z.object({ model: z.string() }).strict(),
    selectionOutput: z
      .object({ model: z.string().optional(), permission: z.literal("unknown") })
      .strict(),
    async open(input) {
      entered.resolve();
      input.commitBinding({
        scope,
        generation: input.capsule.opening.generation,
        nativeSession: "native-one",
      });
      return opened.promise;
    },
  });
  try {
    assert.throws(() =>
      f.lifecycle.create(scope, "invalid-selection", { cwd: f.directory }, { model: 17 }),
    );
    assert.equal(f.journal.read(scope, "invalid-selection"), null);
    assert.equal(f.calls.prepare, 0);
    const creating = f.lifecycle.create(scope, "create", { cwd: f.directory });
    await entered.promise;
    assert.equal(f.lifecycle.state(scope).selectionSource, "requested");
    assert.deepEqual(f.lifecycle.state(scope).selection, { model: "scripted" });
    opened.resolve({
      kind: "created",
      quiescent: true,
      run: { scope, generation: 1, nativeSession: "native-one" },
      activity: "idle",
      selection: { permission: "unknown" },
    });
    assert.equal((await creating).state, "succeeded");
    const observed = f.lifecycle.state(scope);
    assert.equal(observed.selectionSource, "observed");
    assert.deepEqual(observed.selection, { permission: "unknown" });
    assert.throws(() =>
      f.lifecycle.observe(scope, {
        run: run(f.lifecycle),
        activity: "working",
        selection: { model: "invented", permission: "full" },
      }),
    );
    assert.deepEqual(f.lifecycle.state(scope), observed);
  } finally {
    await f.cleanup();
  }
});

test("Create, Send, command, Stop, explicit Reopen and Archive retain one owner and exact originals", async () => {
  const f = await fixture();
  try {
    const createReceipt = await f.lifecycle.create(scope, "create", { cwd: f.directory });
    assert.equal(createReceipt.state, "succeeded");
    const initialBinding = run(f.lifecycle);
    assert.equal(f.lifecycle.state(scope).phase, "running");
    assert.equal(
      (await f.lifecycle.send(scope, "send", { text: "hello" }, run(f.lifecycle))).state,
      "succeeded",
    );
    assert.equal(
      (await f.lifecycle.command(scope, "continue", { kind: "continue" }, run(f.lifecycle))).state,
      "succeeded",
    );
    assert.equal(
      (await f.lifecycle.send(scope, "send", { text: "hello" }, run(f.lifecycle))).state,
      "succeeded",
    );
    assert.equal(f.calls.send, 1);
    await assert.rejects(
      async () => f.lifecycle.send(scope, "send", { text: "different" }, run(f.lifecycle)),
      /another meaning/,
    );
    assert.equal(
      (await f.lifecycle.archive(scope, "early-archive", f.lifecycle.state(scope).generation))
        .state,
      "refused",
    );
    assert.equal(
      (await f.lifecycle.stop(scope, "stop", f.lifecycle.state(scope).generation)).state,
      "succeeded",
    );
    assert.equal(f.lifecycle.state(scope).phase, "stopped");
    assert.equal(
      (await f.lifecycle.reopen(scope, "reopen", f.lifecycle.state(scope).generation)).state,
      "succeeded",
    );
    const running = f.lifecycle.state(scope);
    assert.equal(running.phase, "running");
    assert.equal(running.generation, 2);
    assert.deepEqual(f.lifecycle.original(scope, "create"), createReceipt);
    assert.deepEqual(createReceipt.result, {
      opened: true,
      run: initialBinding,
      continuationAllowed: false,
    });
    assert.equal(
      (await f.lifecycle.stop(scope, "stop-again", f.lifecycle.state(scope).generation)).state,
      "succeeded",
    );
    assert.equal(
      (await f.lifecycle.archive(scope, "archive", f.lifecycle.state(scope).generation)).state,
      "succeeded",
    );
    assert.equal(f.calls.release, 0); // Borrowed workspace is never deleted.
    const other = { ...scope, session: "two" };
    assert.equal(
      (await f.lifecycle.create(other, "second", { cwd: f.directory })).state,
      "succeeded",
    );
    await f.lifecycle.stop(other, "second-stop", f.lifecycle.state(other).generation);
    await f.lifecycle.close();
  } finally {
    await f.cleanup();
  }
});

test("idle remains running; disconnect and absent inspection never prove Stop", async () => {
  const f = await fixture({ inspect: async () => null });
  try {
    await f.lifecycle.create(scope, "create", { cwd: f.directory });
    assert.equal((await f.lifecycle.inspect(scope)).phase, "running");
    assert.equal(f.lifecycle.readiness().ready, false);
    assert.throws(() => f.lifecycle.close(), /retains native/);
    await f.lifecycle.stop(scope, "stop", f.lifecycle.state(scope).generation);
    await f.lifecycle.close();
  } finally {
    await f.cleanup();
  }
});

test("lost native Send result stays unknown and independent readonly lookup never redispatches", async () => {
  let sends = 0;
  const f = await fixture({
    async send() {
      sends++;
      throw new Error("reply lost");
    },
  });
  try {
    await f.lifecycle.create(scope, "create", { cwd: f.directory });
    assert.equal(
      (await f.lifecycle.send(scope, "uncertain", { text: "once" }, run(f.lifecycle))).state,
      "unknown",
    );
    const reader = new OriginalReader(f.filename);
    try {
      assert.equal(reader.read(scope, "uncertain")?.state, "unknown");
    } finally {
      reader.close();
    }
    assert.equal(
      (await f.lifecycle.send(scope, "uncertain", { text: "once" }, run(f.lifecycle))).state,
      "unknown",
    );
    assert.equal(sends, 1);
    await f.lifecycle.stop(scope, "stop", f.lifecycle.state(scope).generation);
    await f.lifecycle.close();
  } finally {
    await f.cleanup();
  }
});

test("Stop during pending workspace acquisition prevents any native opening and retains actual work", async () => {
  const allocated = deferred<{ cwd: string; ownership: "borrowed"; data: null }>();
  const entered = deferred<void>();
  const workspace: WorkspaceStrategy<typeof workspaceInput, typeof workspaceData> = {
    identity: { id: "slow", version: 1, recordVersion: 1 },
    input: workspaceInput,
    data: workspaceData,
    async allocate() {
      entered.resolve();
      return allocated.promise;
    },
  };
  const f = await fixture({}, workspace);
  try {
    const create = f.lifecycle.create(scope, "create", { cwd: f.directory });
    await entered.promise;
    const stop = f.lifecycle.stop(scope, "stop", f.lifecycle.state(scope).generation);
    assert.equal(f.lifecycle.state(scope).phase, "stopping");
    assert.equal(f.lifecycle.readiness().ready, false);
    allocated.resolve({ cwd: f.directory, ownership: "borrowed", data: null });
    assert.equal((await create).state, "refused");
    assert.equal((await stop).state, "succeeded");
    assert.equal(f.calls.prepare, 0);
    assert.equal(f.calls.open, 0);
    assert.equal(f.lifecycle.state(scope).phase, "stopped");
    await f.lifecycle.close();
  } finally {
    await f.cleanup();
  }
});

test("Stop seals a pending native opening; late open cannot replace Stop or license early Archive/Reopen", async () => {
  const opened = deferred<Awaited<ReturnType<ScriptedNative["open"]>>>(),
    entered = deferred<Parameters<ScriptedNative["open"]>[0]>();
  const f = await fixture({
    async open(input) {
      entered.resolve(input);
      return opened.promise;
    },
  });
  try {
    const create = f.lifecycle.create(scope, "create", { cwd: f.directory });
    const input = await entered.promise;
    assert.equal(
      (await f.lifecycle.stop(scope, "stop", f.lifecycle.state(scope).generation)).state,
      "succeeded",
    );
    assert.equal(f.lifecycle.state(scope).phase, "stopped");
    assert.equal(f.lifecycle.readiness().ready, false);
    assert.equal(
      (await f.lifecycle.archive(scope, "too-soon", f.lifecycle.state(scope).generation)).state,
      "refused",
    );
    opened.resolve({
      kind: "created",
      quiescent: true,
      run: { scope, generation: input.capsule.opening.generation, nativeSession: "native-one" },
      activity: "idle",
      selection: {},
    });
    assert.equal((await create).state, "succeeded");
    assert.equal(f.lifecycle.state(scope).phase, "stopped");
    assert.equal(f.lifecycle.readiness().ready, true);
    await f.lifecycle.close();
  } finally {
    await f.cleanup();
  }
});

test("a mismatched Stop certificate never publishes Stopped and cannot be replayed", async () => {
  const f = await fixture();
  const originalPrepare = f.native.prepare;
  f.native.prepare = async (input) => {
    const prepared = await originalPrepare(input);
    if ("state" in prepared) return prepared;
    return {
      ...prepared,
      stop: async () => ({
        ...proof(prepared),
        identity: { ...prepared.identity, containment: "another-owner" },
      }),
    };
  };
  try {
    await f.lifecycle.create(scope, "create", { cwd: f.directory });
    assert.equal(
      (await f.lifecycle.stop(scope, "bad-stop", f.lifecycle.state(scope).generation)).state,
      "unknown",
    );
    const state = f.lifecycle.state(scope);
    assert.equal(state.phase, "uncertain");
    assert.equal(state.mayRun, true);
    assert.equal(
      (await f.lifecycle.stop(scope, "bad-stop", f.lifecycle.state(scope).generation)).state,
      "unknown",
    );
    assert.equal(f.lifecycle.readiness().ready, false);
  } finally {
    await f.cleanup();
  }
});

test("restart discovery is inert and old running custody becomes uncertain until exact inspection/Stop", async () => {
  const f = await fixture();
  try {
    await f.lifecycle.create(scope, "create", { cwd: f.directory });
    const before = { ...f.calls };
    assert.throws(() => new DefaultLifecycle(f.options, context), /already has a lifecycle owner/);
    const forwarded = {
      writerIdentity: f.journal.writerIdentity,
      read: f.journal.read.bind(f.journal),
      request: f.journal.request.bind(f.journal),
      unresolved: f.journal.unresolved.bind(f.journal),
      admit: f.journal.admit.bind(f.journal),
      markDispatched: f.journal.markDispatched.bind(f.journal),
      settle: f.journal.settle.bind(f.journal),
      checkpoint: f.journal.checkpoint.bind(f.journal),
      checkpoints: f.journal.checkpoints.bind(f.journal),
      saveCheckpoint: f.journal.saveCheckpoint.bind(f.journal),
    };
    assert.deepEqual(forwarded.read(scope, "create"), f.lifecycle.original(scope, "create"));
    assert.throws(
      () =>
        new DefaultLifecycle(
          { ...f.options, native: { ...f.native }, journal: forwarded },
          context,
        ),
      /Original writer already has a lifecycle owner/,
    );
    f.journal.close();
    const writer = new OriginalJournal({ filename: f.filename });
    const restored = new DefaultLifecycle(
      { ...f.options, native: { ...f.native }, journal: writer },
      context,
    );
    assert.equal(restored.state(scope).phase, "uncertain");
    assert.deepEqual(f.calls, before);
    assert.equal((await restored.inspect(scope)).phase, "running");
    await restored.stop(scope, "stop", restored.state(scope).generation);
    await restored.close();
    assert.throws(
      () =>
        new DefaultLifecycle(
          {
            ...f.options,
            journal: writer,
            native: { ...f.native, identity: { ...f.native.identity, recordVersion: 2 } },
          },
          context,
        ),
      /incompatible/,
    );
    const stopped = new DefaultLifecycle(
      { ...f.options, native: { ...f.native }, journal: writer },
      context,
    );
    assert.equal(stopped.state(scope).phase, "stopped");
    await stopped.close();
    writer.close();
  } finally {
    await f.cleanup();
  }
});

test("actual typed Host router uses default lifecycle and separates authenticated principals", async () => {
  const f = await fixture();
  try {
    await f.lifecycle.close();
    const definition = defineHost({
      contract: { id: "scripted.host", version: 1 },
      harness: {
        identity: { id: "scripted", version: 1, recordVersion: 1 },
        nativeKind: "future" as const,
        capabilities: [],
      },
      lifecycle: () => defaultLifecycle(f.options),
      native: () => hostRouter({}),
    });
    const host = await activateHost(definition, {
      ...context,
      authenticate: (call) => ({
        identity: {
          connection: "connection",
          principal: call.proof === "partner" ? "partner" : "owner",
          actions: ["read", "control"],
        },
        route,
      }),
    });
    const owner = host.router.createCaller(
      await host.context({ expected: host.manifest, proof: "owner" }),
    );
    assert.equal(
      (
        await owner.lifecycle.create({
          session: "one",
          id: "create",
          workspace: { cwd: f.directory },
        })
      ).state,
      "succeeded",
    );
    const partner = host.router.createCaller(
      await host.context({ expected: host.manifest, proof: "partner" }),
    );
    assert.deepEqual(await partner.lifecycle.list(), []);
    assert.equal(await partner.lifecycle.original({ session: "one", id: "create" }), null);
    await owner.lifecycle.stop({ session: "one", id: "stop", generation: 1 });
    await host.close();
  } finally {
    await f.cleanup();
  }
});

test("saved exact originals survive Reopen; stale targets and late old inspection cannot change its new lifetime", async () => {
  const observed = deferred<OpeningStopProof>(),
    entered = deferred<OpeningCapsule>();
  const f = await fixture({
    async inspect(capsule) {
      entered.resolve(capsule);
      return observed.promise;
    },
  });
  try {
    const selection = { model: "chosen-model", reasoning: "high" };
    await f.lifecycle.create(scope, "create", { cwd: f.directory }, selection);
    assert.deepEqual(f.lifecycle.state(scope).selection, selection);
    const originalRun = run(f.lifecycle);
    const original = await f.lifecycle.send(
      scope,
      "original-send",
      { text: "exactly once" },
      originalRun,
    );
    const inspection = f.lifecycle.inspect(scope),
      oldCapsule = await entered.promise;
    await f.lifecycle.stop(scope, "stop-one", 1);
    await f.lifecycle.reopen(scope, "reopen", 1);
    observed.resolve(proof(oldCapsule));
    const after = await inspection;
    assert.equal(after.phase, "running");
    assert.equal(after.generation, 2);
    assert.deepEqual(
      await f.lifecycle.send(scope, "original-send", { text: "exactly once" }, originalRun),
      original,
    );
    assert.equal(f.calls.send, 1);
    assert.equal(
      (await f.lifecycle.send(scope, "new-stale-send", { text: "stale" }, originalRun)).state,
      "refused",
    );
    assert.equal((await f.lifecycle.stop(scope, "stop-one", 1)).state, "succeeded");
    assert.equal((await f.lifecycle.stop(scope, "new-stale-stop", 1)).state, "refused");
    assert.equal(f.lifecycle.state(scope).phase, "running");
    await f.lifecycle.stop(scope, "stop-two", 2);
    await f.lifecycle.close();
  } finally {
    await f.cleanup();
  }
});

test("selected native resource custody gates close, seals admission and retains failure", async () => {
  let ready = false,
    closes = 0;
  const closing = deferred<void>();
  const f = await fixture({
    readiness: () =>
      ready ? { ready: true } : { ready: false, reasons: ["Reader still owns I/O"] },
    close() {
      closes++;
      return closing.promise;
    },
  });
  try {
    assert.equal(f.lifecycle.readiness().ready, false);
    assert.throws(() => f.lifecycle.close(), /retains native/);
    assert.equal(closes, 0);
    ready = true;
    const close = f.lifecycle.close();
    assert.equal(close, f.lifecycle.close());
    assert.throws(() => f.lifecycle.create(scope, "after-close", { cwd: f.directory }), /closed/);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closes, 1);
    closing.resolve();
    await close;
    await f.lifecycle.close();
    assert.equal(closes, 1);
  } finally {
    closing.resolve();
    await f.cleanup();
  }
  const failed = await fixture({
    close() {
      throw Error("Cleanup unproved");
    },
  });
  try {
    const close = failed.lifecycle.close();
    await assert.rejects(close, /unproved/);
    assert.equal(failed.lifecycle.close(), close);
    assert.equal(failed.lifecycle.readiness().ready, false);
    assert.throws(() => new DefaultLifecycle(failed.options, context), /already has/);
  } finally {
    await failed.cleanup();
  }
});

test("known native identity commits before initialization and survives a lost settings reply", async () => {
  const f = await fixture({
    async open(input) {
      input.commitBinding({
        scope: input.capsule.opening.scope,
        generation: input.capsule.opening.generation,
        nativeSession: "native-positive",
      });
      assert.equal(f.lifecycle.state(scope).phase, "opening");
      assert.equal(f.lifecycle.state(scope).nativeSession, "native-positive");
      const saved = f.journal.checkpoint(scope) as { nativeSession: string };
      assert.equal(saved.nativeSession, "native-positive");
      assert.deepEqual(
        f.lifecycle.state(scope).selection,
        { model: "scripted" },
        "Binding cannot replace saved opening intent with partial observed facts",
      );
      assert.throws(
        () => input.commitBinding({ scope, generation: 99, nativeSession: "foreign" }),
        /fenced/,
      );
      throw Error("initial settings reply lost");
    },
  });
  try {
    assert.equal(
      (await f.lifecycle.create(scope, "create", { cwd: f.directory })).state,
      "unknown",
    );
    assert.equal(f.lifecycle.state(scope).nativeSession, "native-positive");
    assert.equal(f.lifecycle.state(scope).phase, "uncertain");
    await f.lifecycle.stop(scope, "stop", 1);
    await f.lifecycle.close();
  } finally {
    await f.cleanup();
  }
});

test("positive BUSY Reopen refusal restores exact stopped custody; explicit selection is original-scoped", async () => {
  const f = await fixture();
  try {
    await f.lifecycle.create(scope, "create", { cwd: f.directory });
    await f.lifecycle.stop(scope, "stop", 1);
    const previous = f.journal.checkpoint(scope),
      realPrepare = f.native.prepare,
      requested = { model: "owner-choice", access: "explicit-policy" };
    let busy = true,
      attempts = 0;
    const entered = deferred<void>(),
      release = deferred<void>();
    f.native.prepare = async (input) => {
      attempts++;
      assert.deepEqual(input.selection, requested);
      assert.equal(input.mode, "reopen");
      assert.deepEqual(f.journal.request(scope, input.opening.operationId), {
        type: "reopen",
        generation: 1,
        selection: requested,
      });
      if (busy) {
        entered.resolve();
        await release.promise;
        return { state: "refused", noAllocation: true, code: "BUSY" };
      }
      return realPrepare(input);
    };
    const reopening = f.lifecycle.reopen(scope, "reopen-busy", 1, requested);
    await entered.promise;
    const stopPending = f.lifecycle.stop(scope, "stop-refused-opening", 2);
    release.resolve();
    const refused = await reopening;
    assert.equal((await stopPending).state, "succeeded");
    assert.equal(
      f.calls.stop,
      1,
      "Positive refused acquisition cannot replay the previous native Stop",
    );
    assert.equal(refused.state, "refused");
    assert.deepEqual(f.journal.checkpoint(scope), previous);
    assert.equal(f.calls.open, 1);
    assert.deepEqual(await f.lifecycle.reopen(scope, "reopen-busy", 1, requested), refused);
    assert.equal(attempts, 1);
    await assert.rejects(
      async () => f.lifecycle.reopen(scope, "reopen-busy", 1, { model: "different" }),
      /another meaning/,
    );
    busy = false;
    assert.equal(
      (await f.lifecycle.reopen(scope, "reopen-owner-choice", 1, requested)).state,
      "succeeded",
    );
    assert.equal(attempts, 2);
    assert.equal(f.lifecycle.state(scope).generation, 2);
    assert.deepEqual(f.lifecycle.state(scope).selection, requested);
    assert.deepEqual(await f.lifecycle.reopen(scope, "reopen-busy", 1, requested), refused);
    assert.equal(attempts, 2);
    await f.lifecycle.stop(scope, "final-stop", 2);
    await f.lifecycle.close();
  } finally {
    await f.cleanup();
  }
});

test("positive pre-allocation Create refusal retains workspace and archives without a fabricated Stop proof", async () => {
  const f = await fixture({
    async prepare() {
      return { state: "refused", noAllocation: true, code: "INVALID" };
    },
  });
  try {
    const receipt = await f.lifecycle.create(scope, "create-refused", { cwd: f.directory });
    assert.equal(receipt.state, "refused");
    assert.equal(f.lifecycle.state(scope).phase, "stopped");
    assert.equal(f.lifecycle.state(scope).mayRun, false);
    const saved = f.journal.checkpoint(scope) as Record<string, unknown>;
    assert.equal(saved.nativeAttempted, false);
    assert.equal(saved.generation, 0);
    assert.equal(saved.capsule, null);
    assert.equal(saved.stopProof, null);
    assert(saved.workspace);
    assert.equal((await f.lifecycle.archive(scope, "archive-refused", 0)).state, "succeeded");
    assert.equal(f.calls.stop, 0);
    assert.equal(f.calls.open, 0);
    assert.equal(f.calls.release, 0);
    await f.lifecycle.close();
    const restored = new DefaultLifecycle(f.options, context);
    assert.equal(restored.state(scope).phase, "archived");
    await restored.close();
  } finally {
    await f.cleanup();
  }
  const uncertain = await fixture({
    async prepare() {
      throw Error("arbitrary failed acquisition");
    },
  });
  try {
    assert.equal(
      (await uncertain.lifecycle.create(scope, "create-unknown", { cwd: uncertain.directory }))
        .state,
      "unknown",
    );
    assert.equal(uncertain.lifecycle.state(scope).phase, "uncertain");
    assert.equal(uncertain.lifecycle.state(scope).mayRun, true);
    assert.equal((await uncertain.lifecycle.archive(scope, "archive-unknown", 1)).state, "refused");
  } finally {
    await uncertain.cleanup();
  }
});

test("Create admission is atomic with its no-attempt checkpoint; reconstruction refuses only that exact unused original", async () => {
  const f = await fixture();
  let restored:
    | DefaultLifecycle<
        typeof workspaceInput,
        typeof workspaceData,
        typeof commandInput,
        z.ZodType,
        z.ZodType,
        z.ZodType
      >
    | undefined;
  let writer: OriginalJournal | undefined;
  const fault = new DatabaseSync(f.filename);
  try {
    fault.exec(
      "CREATE TRIGGER refuse_initial_checkpoint BEFORE INSERT ON checkpoints BEGIN SELECT RAISE(ABORT,'initial checkpoint refused'); END",
    );
    assert.throws(
      () => f.lifecycle.create(scope, "no-half-create", { cwd: f.directory }),
      /initial checkpoint refused/,
    );
    assert.equal(f.journal.read(scope, "no-half-create"), null);
    assert.equal(f.journal.checkpoint(scope), null);
    assert.deepEqual(
      f.lifecycle.list({
        identity: { connection: scope.connection, principal: scope.principal, actions: ["read"] },
      }),
      [],
    );
    fault.exec("DROP TRIGGER refuse_initial_checkpoint");
    const mark = f.journal.markDispatched.bind(f.journal);
    f.journal.markDispatched = () => {
      throw Error("simulated crash before dispatch transaction");
    };
    assert.throws(
      () => f.lifecycle.create(scope, "unused-create", { cwd: f.directory }),
      /simulated crash/,
    );
    const checkpoint = f.journal.checkpoint(scope) as Record<string, Json>;
    assert.equal(checkpoint.phase, "preparing");
    assert.equal(checkpoint.workspaceAttempted, false);
    assert.equal(checkpoint.nativeAttempted, false);
    assert.equal(f.journal.read(scope, "unused-create")?.state, "admitted");
    assert.equal(f.calls.prepare, 0);
    assert.equal(f.calls.open, 0);
    f.journal.markDispatched = mark;
    fault.close();
    f.journal.close();
    writer = new OriginalJournal({ filename: f.filename });
    restored = new DefaultLifecycle(
      { ...f.options, journal: writer, native: { ...f.native } },
      context,
    );
    assert.equal(restored.state(scope).phase, "stopped");
    assert.equal(restored.state(scope).mayRun, false);
    const refused = restored.original(scope, "unused-create");
    assert.equal(refused?.state, "refused");
    assert.deepEqual(await restored.create(scope, "unused-create", { cwd: f.directory }), refused);
    assert.equal(f.calls.prepare, 0);
    assert.equal(f.calls.open, 0);
    assert.equal(f.calls.stop, 0);
    await restored.close();
  } finally {
    try {
      fault.close();
    } catch {}
    writer?.close();
    await f.cleanup();
  }
});

test("a synchronous first-Create observer can Stop before workspace/native acquisition without losing its actual owner", async () => {
  let allocations = 0;
  const workspace: WorkspaceStrategy<typeof workspaceInput, typeof workspaceData> = {
    identity: { id: "not-entered", version: 1, recordVersion: 1 },
    input: workspaceInput,
    data: workspaceData,
    async allocate({ input }) {
      allocations++;
      return { cwd: input.cwd, ownership: "borrowed", data: null };
    },
  };
  const f = await fixture({}, workspace);
  let stop: Promise<import("../../src/protocol/index.js").Receipt> | undefined,
    once = false;
  const unsubscribe = f.lifecycle.subscribe(() => {
    if (!once && f.lifecycle.state(scope).phase === "preparing") {
      once = true;
      stop = f.lifecycle.stop(scope, "observer-stop", 0);
    }
  });
  try {
    const receipt = await f.lifecycle.create(scope, "create", { cwd: f.directory });
    assert.equal(receipt.state, "refused");
    assert.equal((await stop)?.state, "succeeded");
    assert.equal(f.lifecycle.state(scope).phase, "stopped");
    assert.equal(allocations, 0);
    assert.equal(f.calls.prepare, 0);
    assert.equal(f.calls.open, 0);
    assert.equal(f.lifecycle.readiness().ready, true);
    await f.lifecycle.close();
  } finally {
    unsubscribe();
    await f.cleanup();
  }
});

test("deferred controls capture immutable originals and a synchronous Stop observer prevents native Send", async () => {
  let delivered: unknown,
    deliveredRun: import("../../src/protocol/index.js").RunRef | undefined,
    commandSeen: unknown;
  const f = await fixture({
    async send(input) {
      delivered = structuredClone(input.message);
      deliveredRun = structuredClone(input.run);
      return { state: "succeeded", result: { accepted: true } };
    },
    async command(input) {
      commandSeen = structuredClone(input.command);
      return { state: "succeeded", result: { accepted: true } };
    },
  });
  let unsubscribe = () => {},
    stopped: Promise<import("../../src/protocol/index.js").Receipt> | undefined;
  try {
    await f.lifecycle.create(scope, "create", { cwd: f.directory });
    const message = { text: "immutable" },
      target = { ...run(f.lifecycle), scope: { ...scope } },
      expected = structuredClone(target);
    const send = f.lifecycle.send(scope, "immutable-send", message, target);
    message.text = "changed";
    target.nativeSession = "changed";
    assert.equal((await send).state, "succeeded");
    assert.deepEqual(delivered, { text: "immutable" });
    assert.deepEqual(deliveredRun, expected);
    const command = { kind: "continue" as const },
      control = f.lifecycle.command(scope, "immutable-command", command, run(f.lifecycle));
    (command as { kind: string }).kind = "changed";
    assert.equal((await control).state, "succeeded");
    assert.deepEqual(commandSeen, { kind: "continue" });
    delivered = undefined;
    let once = false;
    unsubscribe = f.lifecycle.subscribe(() => {
      if (!once && f.lifecycle.original(scope, "stopped-send")?.state === "dispatched") {
        once = true;
        stopped = f.lifecycle.stop(scope, "observer-stop", 1);
      }
    });
    assert.equal(
      (await f.lifecycle.send(scope, "stopped-send", { text: "never sent" }, run(f.lifecycle)))
        .state,
      "refused",
    );
    assert.equal((await stopped)?.state, "succeeded");
    assert.equal(delivered, undefined);
    assert.equal(f.lifecycle.state(scope).phase, "stopped");
    await f.lifecycle.close();
  } finally {
    unsubscribe();
    await f.cleanup();
  }
});

test("unchanged native stream observations perform no checkpoint write or observer publication", async () => {
  const f = await fixture();
  try {
    await f.lifecycle.create(scope, "create", { cwd: f.directory });
    const save = f.journal.saveCheckpoint.bind(f.journal);
    let writes = 0,
      publications = 0;
    f.journal.saveCheckpoint = (...args) => {
      writes++;
      return save(...args);
    };
    const unsubscribe = f.lifecycle.subscribe(() => {
      publications++;
    });
    const observation = {
      run: run(f.lifecycle),
      activity: "idle" as const,
      selection: { model: "scripted" },
    };
    for (let index = 0; index < 100; index++) f.lifecycle.observe(scope, observation);
    assert.equal(writes, 0);
    assert.equal(publications, 0);
    f.lifecycle.observe(scope, { ...observation, activity: "working" });
    assert.equal(writes, 1);
    assert.equal(publications, 1);
    f.lifecycle.observe(scope, { ...observation, activity: "working" });
    assert.equal(writes, 1);
    assert.equal(publications, 1);
    unsubscribe();
    await f.lifecycle.stop(scope, "stop", 1);
    await f.lifecycle.close();
  } finally {
    await f.cleanup();
  }
});
