import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  activateHost,
  defineHost,
  defaultLifecycle,
  existingDirectoryWorkspace,
} from "../../src/host/index.js";
import type { NativeObservation } from "../../src/host/index.js";
import { OriginalJournal } from "../../src/storage/index.js";
import { codexRouter } from "../../src/codex/server/router.js";
import { CodexObservation } from "../../src/codex/server/observation.js";
import type { CodexObservedSelection } from "../../src/codex/contracts.js";
import type { RunRef } from "../../src/protocol/index.js";
import { fixture, scope, selection, type Handler } from "./fixtures.js";
import { nativeHandler, nativeMessage, nativeThread, nativeTurn } from "./native-fixtures.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function setup(handler: Handler = nativeHandler) {
  let observe = (_: NativeObservation<CodexObservedSelection>) => {};
  const f = await fixture({ observe: (value) => observe(value) }, handler),
    journal = new OriginalJournal({ filename: join(f.directory, "native-originals.sqlite") });
  const route = { authority: "root", host: scope.host, owner: "owner", routeEpoch: "epoch" };
  const host = await activateHost(
    defineHost({
      contract: { id: "codex.native-api-test", version: 1 },
      harness: {
        identity: f.adapter.identity,
        nativeKind: "codex",
        capabilities: ["native.codex"],
      },
      lifecycle: () =>
        defaultLifecycle({
          journal,
          native: f.adapter,
          workspace: existingDirectoryWorkspace(),
          selection,
        }),
      native: ({ sessions }) => {
        observe = (value) => sessions.observe(value.run.scope, value);
        return codexRouter(sessions, f.adapter);
      },
    }),
    {
      route,
      authenticate: (call) => ({
        route,
        ...(call.session ? { session: call.session } : {}),
        identity: {
          connection: scope.connection,
          principal: scope.principal,
          actions: ["read", "control"],
        },
      }),
    },
  );
  await host.sessions.create(scope, "create", { cwd: f.directory });
  const state = host.sessions.state(scope);
  assert.equal(state.phase, "running");
  if (state.phase !== "running") throw Error("Expected native run");
  const context = await host.context({
    expected: host.manifest,
    proof: null,
    session: { id: scope.session, generation: state.generation },
  });
  return {
    f,
    host,
    journal,
    run: state.run,
    context,
    caller: host.router.createCaller(context),
    async cleanup() {
      const current = host.sessions.state(scope);
      if (current.mayRun) await host.sessions.stop(scope, "test-cleanup-stop", current.generation);
      await tick();
      await host.close();
      journal.close();
      await f.cleanup();
    },
  };
}

test("actual native tRPC procedures preserve DTOs and use the existing durable original exactly once", async () => {
  const s = await setup();
  try {
    const params = {
      threadId: s.run.nativeSession,
      input: [{ type: "text" as const, text: "scripted original", text_elements: [] }],
      parentTurnId: "parent-turn",
      rootTurnId: "root-turn",
      serviceTierForTurn: "default",
      outputSchema: { type: "object" },
      additionalContext: { selected: { kind: "untrusted" as const, value: "explicit context" } },
    };
    const request = { originalId: "original-native-send", run: s.run, params };
    const result = await s.caller.native.turn.start(request);
    assert.equal(result.state, "succeeded");
    if (result.state !== "succeeded") throw Error("Expected native response");
    assert.equal(result.result.turn.itemsView, "full");
    assert.equal(result.result.turn.rootTurnId, result.result.turn.id);
    assert.deepEqual(await s.caller.native.turn.start(request), result);
    assert.equal(s.journal.read(scope, request.originalId)?.requestHash, result.requestHash);
    const native = s.f.wires[0]!.requests.filter((value) => value.method === "turn/start");
    assert.equal(native.length, 1);
    assert.deepEqual(native[0]!.params, { ...params, clientUserMessageId: request.originalId });
    const models = await s.caller.native.model.list({
      run: s.run,
      params: { includeHidden: true, limit: 32 },
    });
    assert.equal(models.data[0]!.id, "fixture-model-id");
    assert.deepEqual(models.data[0]!.inputModalities, ["text", "image"]);
    const queued = await s.caller.native.thread.queue.add({
      originalId: "queue-native",
      run: s.run,
      params: {
        threadId: s.run.nativeSession,
        clientUserMessageId: "queue-native",
        input: params.input,
      },
    });
    assert.equal(queued.state, "succeeded");
    if (queued.state === "succeeded")
      assert.deepEqual(queued.result.queuedSubmission.input, params.input);
    const denied = await s.caller.native.turn.interrupt({
      originalId: "foreign-child-effect",
      run: s.run,
      params: { threadId: "unowned-child", turnId: "child-turn" },
    });
    assert.equal(denied.state, "refused");
    assert.equal(
      s.f.wires[0]!.requests.some((value) => value.method === "turn/interrupt"),
      false,
    );
    if (false as boolean) {
      // @ts-expect-error The removed public super-command is not a native procedure.
      await s.caller.native.command({});
      // @ts-expect-error Copilot's controls cannot be called on the inferred Codex router.
      await s.caller.native.session.setMode({ mode: "interactive" });
      await s.caller.native.turn.interrupt({
        originalId: "bad",
        run: s.run,
        // @ts-expect-error The real native interrupt requires its exact thread and turn.
        params: { turnId: "turn" },
      });
    }
  } finally {
    await s.cleanup();
  }
});

test("exact native read pages preserve item anchors and cold ancestry without any resume or capture mutation", async () => {
  const s = await setup();
  try {
    const before = s.f.adapter.observation(s.run),
      initialResume = s.f.wires[0]!.requests.filter(
        (value) => value.method === "thread/resume",
      ).length;
    assert.equal(before.coverage.openedAs, "created");
    const params = {
      threadId: "cold-child",
      turnId: "stored-turn",
      cursor: { type: "item" as const, itemId: "exclusive-anchor" },
      sortDirection: "desc" as const,
      limit: 2,
    };
    const page = await s.caller.native.thread.items({ run: s.run, params });
    assert.equal(page.data[0]!.turnId, "stored-turn");
    assert.equal(page.data[0]!.completedAtMs, null);
    assert.equal(page.backwardsCursor, "native-backwards");
    assert.deepEqual(
      s.f.wires[0]!.requests.find((value) => value.method === "thread/items/list")!.params,
      params,
    );
    assert.equal(
      s.f.wires[0]!.requests.filter((value) => value.method === "thread/resume").length,
      initialResume,
    );
    assert.deepEqual(s.f.adapter.observation(s.run), before);
    assert.equal(s.f.adapter.history(s.run).owner("cold-child"), null);
  } finally {
    await s.cleanup();
  }
});

test("native callback custody works without a generic popup owner and never turns submission into acceptance", async () => {
  const s = await setup();
  try {
    const watcher = (await s.caller.native.callbacks.watch({ run: s.run }))[Symbol.asyncIterator]();
    assert.deepEqual((await watcher.next()).value, []);
    const params = {
      kind: "command",
      threadId: s.run.nativeSession,
      turnId: "turn",
      itemId: "command",
      startedAtMs: 1,
      environmentId: null,
      command: "explicit harmless native command",
      availableDecisions: ["decline"],
    };
    s.f.wires[0]!.emit({ id: 9, method: "item/commandExecution/requestApproval", params });
    const next = await watcher.next();
    assert.equal(next.done, false);
    assert.equal(next.value?.length, 1);
    const request = (await s.caller.native.callbacks.pending({ run: s.run }))[0]!;
    assert.deepEqual(request.request.params, params);
    assert.equal(request.reference.requestId, 9);
    const reply = {
      originalId: "answer-native",
      run: s.run,
      reference: request.reference,
      params: {
        method: "item/commandExecution/requestApproval" as const,
        response: { decision: "decline" as const },
      },
    };
    const result = await s.caller.native.callbacks.respond(reply);
    assert.equal(result.state, "succeeded");
    if (result.state === "succeeded") assert.deepEqual(result.result, { submitted: true });
    assert.deepEqual(await s.caller.native.callbacks.respond(reply), result);
    assert.equal(s.f.wires[0]!.written.filter((value) => value.id === 9 && value.result).length, 1);
    assert.equal((await s.caller.native.callbacks.pending({ run: s.run }))[0]!.submitted, true);
    const second = await s.caller.native.callbacks.respond({
      ...reply,
      originalId: "second-answer",
    });
    assert.equal(second.state, "refused");
    s.f.wires[0]!.emit({
      method: "serverRequest/resolved",
      params: { threadId: s.run.nativeSession, requestId: 9 },
    });
    await tick();
    assert.deepEqual(await s.caller.native.callbacks.pending({ run: s.run }), []);
    const readonlyCaller = s.host.router.createCaller({
      ...s.context,
      identity: { ...s.context.identity, actions: ["read"] },
    });
    await assert.rejects(
      readonlyCaller.native.callbacks.pending({ run: s.run }),
      /PRIVATE_CALLBACK_DENIED/,
    );
    await watcher.return?.();
  } finally {
    await s.cleanup();
  }
});

test("a generic presentation rejection cannot hide a valid native item or gate a native control", async () => {
  const s = await setup();
  try {
    s.f.wires[0]!.emit({
      method: "item/completed",
      params: {
        threadId: s.run.nativeSession,
        turnId: "turn",
        completedAtMs: 2,
        item: { id: "native-review-mode", type: "enteredReviewMode", review: "native review text" },
      },
    });
    const capture = await s.caller.native.observation.snapshot({ run: s.run });
    assert.ok(
      capture.events.some(
        (event) =>
          event.notification.method === "item/completed" &&
          event.notification.params.item.id === "native-review-mode",
      ),
    );
    const updated = await s.caller.native.turn.settings.update({
      originalId: "native-turn-settings",
      run: s.run,
      params: {
        threadId: s.run.nativeSession,
        turnId: "turn",
        model: "fixture-luna",
        effort: "low",
      },
    });
    assert.equal(updated.state, "succeeded");
    if (updated.state === "succeeded") assert.deepEqual(updated.result, { status: "applied" });
  } finally {
    await s.cleanup();
  }
});

test("bounded native capture replays local observations and explicit gaps while viewer cleanup leaves capture running", async () => {
  const run: RunRef = { scope, generation: 1, nativeSession: "native-root" },
    capture = new CodexObservation(run, "attachment", {
      maxEvents: 2,
      maxBytes: 65536,
      maxObservers: 4,
      maxQueued: 1,
    });
  capture.observe({ method: "thread/started", params: { thread: nativeThread() } });
  const before = capture.snapshot(),
    stream = capture.watch();
  assert.equal((await stream.next()).value?.kind, "snapshot");
  capture.observe({
    method: "item/completed",
    params: { threadId: "native-root", turnId: "turn", item: nativeMessage(), completedAtMs: 1 },
  });
  const first = await stream.next();
  assert.equal(first.value?.kind, "notification");
  await stream.return?.();
  capture.observe({
    method: "turn/completed",
    params: { threadId: "native-root", turn: nativeTurn("turn", "completed") },
  });
  const after = capture.snapshot();
  assert.ok(after.revision > before.revision);
  assert.equal(after.coverage.earlierOmitted, true);
  assert.equal(after.coverage.nativeContinuity, "unproved");
  const replay = capture.watch({ attachment: "attachment", revision: after.revision - 1 });
  assert.equal((await replay.next()).value?.kind, "notification");
  await replay.return?.();
  const current = capture.watch({ attachment: "attachment", revision: after.revision });
  assert.equal((await current.next()).value?.kind, "snapshot");
  await current.return?.();
  const miss = capture.watch({ attachment: "wrong-attachment", revision: 0 });
  assert.equal((await miss.next()).value?.kind, "gap");
  await miss.return?.();
  capture.close();
});

test("retained native state and replay share enough headroom for the published bridge frame", async () => {
  const run: RunRef = { scope, generation: 1, nativeSession: "native-root" },
    capture = new CodexObservation(run, "attachment");
  assert.throws(
    () =>
      new CodexObservation(run, "too-large", {
        maxEvents: 128,
        maxBytes: 262_145,
        maxObservers: 32,
        maxQueued: 16,
      }),
    /OBSERVATION_LIMIT/,
  );
  capture.observe({ method: "thread/started", params: { thread: nativeThread() } });
  const stream = capture.watch();
  await stream.next();
  for (let i = 0; i < 24; i++)
    capture.observe({
      method: "item/completed",
      params: {
        threadId: "native-root",
        turnId: "turn",
        item: nativeMessage(`large-${i}`, "\u4e2d".repeat(20_000)),
        completedAtMs: i,
      },
    });
  const snapshot = capture.snapshot(),
    bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  assert.ok(snapshot.coverage.earlierOmitted);
  assert.ok(snapshot.state.omitted);
  assert.ok(bytes(snapshot.events) <= 262_144);
  assert.ok(bytes(snapshot.state) <= 262_144);
  assert.ok(bytes(snapshot) > 200_000);
  assert.ok(bytes({ kind: "snapshot", snapshot }) < 786_432);
  // A slow viewer overflows to the same bounded current checkpoint.
  const frame = (await stream.next()).value;
  assert.equal(frame?.kind, "gap");
  assert.ok(bytes(frame) < 786_432);
  await stream.return?.();
  capture.close();
});
