import {
  codexSelectionSchema,
  codexMessageSchema,
  type CodexObservedSelection,
} from "../../src/codex/contracts.js";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { NativeObservation } from "../../src/host/index.js";
import {
  activateHost,
  defineHost,
  defaultLifecycle,
  existingDirectoryWorkspace,
} from "../../src/host/index.js";
import { HistoryAcquisition, ReadBudget } from "../../src/history/index.js";
import { InteractionOwner } from "../../src/interactions/index.js";
import { OriginalJournal, OriginalReader } from "../../src/storage/index.js";
import {
  CodexHistory,
  codexItem,
  codexTimelinePage,
  codexRouter,
  codexCommandSchema,
} from "../../src/codex/node.js";
import { defaultHandler, fixture, opening, scope, selection } from "./fixtures.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("positive native binding survives lost initial-settings reply in the actual durable lifecycle", async () => {
  let lostInitialSettings = false;
  let observe = (_: NativeObservation<CodexObservedSelection>) => {},
    callbacks: InteractionOwner | undefined;
  const f = await fixture(
    {
      observe: (value) => observe(value),
      interactions: (run, attachment) => (callbacks = new InteractionOwner(run, attachment)),
    },
    async (request, wire) => {
      if (request.method === "thread/settings/update" && !lostInitialSettings) {
        lostInitialSettings = true;
        await wire.close();
        return undefined;
      }
      return defaultHandler(request, wire);
    },
  );
  const filename = join(f.directory, "originals.sqlite"),
    journal = new OriginalJournal({ filename });
  const route = { authority: "root", host: scope.host, owner: "owner", routeEpoch: "epoch" };
  const definition = defineHost({
    contract: { id: "test.codex-composed", version: 1 },
    harness: {
      identity: f.adapter.identity,
      nativeKind: "codex" as const,
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
  });
  const host = await activateHost(definition, {
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
  });
  try {
    const created = await host.sessions.create(
      scope,
      "create",
      { cwd: f.directory },
      { ...selection, effort: "high" },
    );
    assert.equal(created.state, "unknown");
    assert.equal(host.sessions.state(scope).phase, "uncertain");
    const reader = new OriginalReader(filename);
    try {
      const checkpoint = reader.checkpoint(scope) as Record<string, unknown>;
      assert.equal(checkpoint.nativeSession, "native-root");
      assert.equal((checkpoint.selection as Record<string, unknown>).model, "fixture-luna");
      assert.equal(reader.read(scope, "create")!.state, "unknown");
    } finally {
      reader.close();
    }
    assert.equal(f.wires[0]!.requests.filter((value) => value.method === "thread/start").length, 1);
    assert.equal((await host.sessions.stop(scope, "stop", 1)).state, "succeeded");
    await new Promise<void>((done) => setImmediate(done));
    assert.equal((await host.sessions.reopen(scope, "reopen", 1)).state, "succeeded");
    const running = host.sessions.state(scope);
    assert.equal(running.phase, "running");
    if (running.phase !== "running") return;
    assert.equal(f.adapter.observation(running.run).coverage.openedAs, "resumed");
    const caller = host.router.createCaller(
      await host.context({
        expected: host.manifest,
        proof: null,
        session: { id: scope.session, generation: 2 },
      }),
    );
    const models = await caller.native.model.list({ run: running.run, params: {} });
    assert.equal(models.data[0]!.model, "fixture-luna");
    const activeHistory = f.adapter.history(running.run).window(),
      acquisition = new HistoryAcquisition(
        activeHistory,
        f.adapter.historyRead(running.run),
        new ReadBudget(1),
      );
    assert.deepEqual(await acquisition.baseline().settled, { state: "ready" });
    assert(
      activeHistory
        .getSnapshot()
        .rows.some((row) => row.body.kind === "complete" && row.body.text === "retained history"),
    );
    f.wires[1]!.emit({
      id: "real-answer",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "native-root",
        turnId: "turn",
        itemId: "question",
        isBlocking: true,
        questions: [
          {
            id: "q",
            header: "Choose",
            question: "Proceed?",
            isSecret: false,
            isOther: true,
            options: null,
          },
        ],
      },
    });
    const reference = callbacks!.getSnapshot().items[0]!.reference;
    const reply = {
      id: "durable-answer",
      run: running.run,
      input: {
        reference,
        answer: {
          type: "codex.question" as const,
          answers: { q: { values: ["yes"], extraInfo: "details" } },
        },
      },
    };
    const answered = await host.sessions.command(
      scope,
      reply.id,
      { type: "answer", ...reply.input },
      running.run,
    );
    assert.equal(answered.state, "succeeded");
    assert.equal(callbacks!.getSnapshot().items[0]!.original!.requestHash, answered.requestHash);
    assert.deepEqual(
      await host.sessions.command(scope, reply.id, { type: "answer", ...reply.input }, running.run),
      answered,
    );
    assert.equal(
      f.wires[1]!.written.filter((value) => value.id === "real-answer" && value.result).length,
      1,
    );
    f.wires[1]!.emit({ method: "serverRequest/resolved", params: { requestId: "real-answer" } });
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(callbacks!.getSnapshot().items[0]!.accepted, true);
    const sent = await host.sessions.send(scope, "send", { text: "one original" }, running.run);
    assert.equal(sent.state, "succeeded");
    assert.equal(host.sessions.state(scope).activity, "working");
    const turnId = (sent.result as { turnId: string }).turnId;
    f.wires[1]!.emit({
      method: "turn/completed",
      params: { threadId: "native-root", turn: { id: turnId, status: "completed" } },
    });
    assert.equal(host.sessions.state(scope).activity, "idle");
    await host.sessions.stop(scope, "stop-again", 2);
    await new Promise<void>((done) => setImmediate(done));
    await host.sessions.reopen(scope, "reopen-again", 2);
    assert.deepEqual(
      await host.sessions.send(scope, "send", { text: "one original" }, running.run),
      sent,
    );
    assert.equal(
      f.wires.flatMap((value) => value.requests).filter((value) => value.method === "turn/start")
        .length,
      1,
    );
    assert.equal(
      (
        await caller.native.turn.interrupt({
          originalId: "stale-route",
          run: running.run,
          params: { threadId: running.run.nativeSession, turnId },
        })
      ).state,
      "refused",
    );
    if (false as boolean) {
      // @ts-expect-error Copilot commands are absent from this inferred Codex router.
      await caller.native.setMode({ mode: "interactive" });
      await caller.native.thread.settings.update({
        originalId: "x",
        run: running.run,
        params: {
          threadId: running.run.nativeSession,
          collaborationMode: {
            // @ts-expect-error A native mode cannot accept arbitrary future strings.
            mode: "copilot",
            settings: {
              model: "fixture-luna",
              reasoning_effort: null,
              developer_instructions: null,
            },
          },
        },
      });
    }
    await host.sessions.stop(scope, "final-stop", 3);
    await new Promise<void>((done) => setImmediate(done));
    assert.equal((await host.readiness()).ready, true);
    await host.close();
  } finally {
    await f.cleanup();
    journal.close();
  }
});

test("idle read helpers are ready to retire, while an actual read blocks readiness until settled", async () => {
  const reading = deferred<void>(),
    finish = deferred<void>();
  const f = await fixture({}, async (request, wire) => {
    if (request.method === "model/list") {
      reading.resolve();
      await finish.promise;
    }
    return defaultHandler(request, wire);
  });
  try {
    let released = 0;
    const reader = await f.adapter.reader({
      opening,
      async begin() {},
      async owned() {},
      async released() {
        released++;
      },
    });
    assert.equal(f.adapter.readiness().ready, true);
    const pending = reader.request("model/list", { limit: 64, cursor: null });
    await reading.promise;
    assert.equal(f.adapter.readiness().ready, false);
    finish.resolve();
    await pending;
    assert.equal(f.adapter.readiness().ready, true);
    await f.adapter.close();
    assert.equal(released, 1);
    assert(f.wires.every((value) => value.closed));
  } finally {
    finish.resolve();
    await f.cleanup();
  }
});

test("a known predispatch selection refusal releases prepared inputs and model patches preserve known instructions", async () => {
  let releases = 0;
  const f = await fixture({
    prepareInputs: async () => ({
      inputs: [{ type: "localImage", path: "/owned/image" }],
      async release() {
        releases++;
      },
    }),
  });
  try {
    const { capsule, result } = await f.open();
    const refused = await f.adapter.send({
      capsule,
      run: result.run,
      originalId: "refused",
      message: codexMessageSchema.parse({
        attachments: [{ id: "owned" }],
        selection: { model: "another" },
      }),
    });
    assert.equal(refused.state, "refused");
    assert.equal(releases, 1);
    assert.equal(f.wires[0]!.requests.filter((value) => value.method === "turn/start").length, 0);
    const parsed = codexCommandSchema.parse({
      type: "settings",
      patch: {
        collaboration: {
          mode: "default",
          model: "fixture-luna",
          effort: "high",
          instructions: "preserve me",
        },
      },
    });
    assert.equal(
      (
        await f.adapter.command({
          capsule,
          run: result.run,
          originalId: "known-mode",
          original: { scope, id: "known-mode", requestHash: "0".repeat(64) },
          command: parsed,
        })
      ).state,
      "succeeded",
    );
    assert.equal(
      (
        await f.adapter.command({
          capsule,
          run: result.run,
          originalId: "model-patch",
          original: { scope, id: "model-patch", requestHash: "0".repeat(64) },
          command: { type: "settings", patch: { model: "another" } },
        })
      ).state,
      "succeeded",
    );
    const last = f.wires[0]!.requests.at(-1)!.params!;
    assert.equal(
      (last.collaborationMode as { settings: { developer_instructions: string } }).settings
        .developer_instructions,
      "preserve me",
    );
    await f.adapter.stop(capsule);
    await new Promise<void>((done) => setImmediate(done));
    const reopen = { ...opening, generation: 2, operationId: "reopen-settings" };
    assert.deepEqual(
      await f.adapter.prepare({
        opening: reopen,
        cwd: f.directory,
        mode: "reopen",
        selectionSource: "requested",
        selection: codexSelectionSchema.parse({ ...selection, effort: "high" }),
      }),
      { state: "refused", noAllocation: true, code: "UNSUPPORTED" },
    );
    assert.equal(f.allocations.length, 1);
    const requested = codexSelectionSchema.parse({
      ...selection,
      effort: "high",
      collaboration: {
        mode: "default",
        model: "fixture-luna",
        effort: "high",
        instructions: "preserve me",
      },
    });
    const prepared = await f.adapter.prepare({
      opening: reopen,
      cwd: f.directory,
      mode: "reopen",
      selectionSource: "requested",
      selection: requested,
    });
    assert(!("state" in prepared));
    await f.adapter.open({
      capsule: prepared,
      cwd: f.directory,
      mode: "reopen",
      nativeSession: result.run.nativeSession,
      selectionSource: "requested",
      selection: requested,
      commitBinding() {},
    });
    const applied = f.wires[1]!.requests.find(
      (value) => value.method === "thread/settings/update",
    )!;
    assert.equal(applied.params!.effort, "high");
    assert.deepEqual(applied.params!.collaborationMode, {
      mode: "default",
      settings: {
        model: "fixture-luna",
        reasoning_effort: "high",
        developer_instructions: "preserve me",
      },
    });
  } finally {
    await f.cleanup();
  }
});

test("MCP login keeps its private link out of receipts and positively observes completion", async () => {
  const f = await fixture({
    mcpServers: { remote: { type: "http", url: "https://mcp.invalid/rpc" } },
  });
  try {
    const { capsule, result } = await f.open();
    const receipt = await f.adapter.command({
      capsule,
      run: result.run,
      originalId: "login",
      original: { scope, id: "login", requestHash: "0".repeat(64) },
      command: { type: "mcp.login", serverName: "remote" },
    });
    assert.equal(receipt.state, "succeeded");
    assert(!JSON.stringify(receipt).includes("auth.invalid"));
    assert.equal(f.adapter.loginLink(result.run, "login").state, "ready");
    // Private OAuth links remain an internal optional UI adapter. The removed
    // public control facade's authorization oracle is replaced by the actual
    // native callback control-only query/stream case in native-api.test.ts.
    f.wires[0]!.emit({
      method: "mcpServer/oauthLogin/completed",
      params: { threadId: "native-root", loginId: "login-1", name: "remote", success: true },
    });
    assert.deepEqual(f.adapter.loginLink(result.run, "login"), {
      state: "complete",
      success: true,
    });
  } finally {
    await f.cleanup();
  }
});

test("unknown native Send retains its exact prepared input until positive Stop", async () => {
  let releases = 0;
  const f = await fixture(
    {
      prepareInputs: async () => ({
        inputs: [{ type: "localImage", path: "/owned/image" }],
        async release() {
          releases++;
        },
      }),
    },
    async (request, wire) => {
      if (request.method === "turn/start") {
        await wire.close();
        return undefined;
      }
      return defaultHandler(request, wire);
    },
  );
  try {
    const { capsule, result } = await f.open();
    await assert.rejects(
      f.adapter.send({
        capsule,
        run: result.run,
        originalId: "unknown",
        message: codexMessageSchema.parse({ attachments: [{ id: "owned" }] }),
      }),
      /WIRE_LOST/,
    );
    assert.equal(releases, 0);
    assert.equal(f.adapter.readiness().ready, false);
    await f.adapter.stop(capsule);
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(releases, 1);
    assert.equal(f.adapter.readiness().ready, true);
  } finally {
    await f.cleanup();
  }
});

test("history preserves missing prefix, exact terminal status and explicit unsupported timeline evidence", () => {
  const run = { scope, generation: 1, nativeSession: "root" },
    history = new CodexHistory(run, "attachment", () => {}, false);
  for (const delta of ["one", "two"])
    history.ingest({
      method: "item/agentMessage/delta",
      params: { threadId: "root", turnId: "turn", itemId: "message", delta },
    });
  const row = history.window().getSnapshot().rows[0]!;
  assert.equal(row.body.kind, "partial");
  if (row.body.kind === "partial") assert.deepEqual(row.body.missing, ["prefix", "final"]);
  assert.equal(
    codexItem(
      "root",
      "turn",
      {
        id: "tool",
        type: "commandExecution",
        status: "interrupted",
        aggregatedOutput: "partial output",
      },
      true,
    ).lifecycle,
    "interrupted",
  );
  assert.throws(
    () =>
      codexItem(
        "root",
        "turn",
        { id: "tool", type: "commandExecution", status: "inProgress" },
        true,
      ),
    /COMPLETION/,
  );
  assert.throws(
    () =>
      codexItem(
        "root",
        "turn",
        { id: "message", type: "agentMessage", threadId: "foreign", text: "bad" },
        true,
      ),
    /FOREIGN/,
  );
  const page = codexTimelinePage(
    { run, attachment: "attachment", stream: "root" },
    {
      data: [{ position: 1, type: "realtime", item: { id: "unsupported-realtime" } }],
      nextCursor: null,
    },
  );
  assert.equal(page.status, "page");
  if (page.status === "page") assert.equal(page.gaps?.[0]?.kind, "unsupported");
});

test("pinned version mismatch cannot Create a thread and explicit Stop retains cleanup ownership", async () => {
  const f = await fixture({}, (request, wire) =>
    request.method === "initialize"
      ? { userAgent: "codex/999.0.0" }
      : defaultHandler(request, wire),
  );
  try {
    const parked = await f.prepare({ opening, cwd: f.directory });
    await assert.rejects(
      f.adapter.open({
        capsule: parked,
        cwd: f.directory,
        mode: "create",
        nativeSession: null,
        selectionSource: "requested",
        selection: codexSelectionSchema.parse(selection),
        commitBinding() {
          assert.fail("binding without native thread");
        },
      }),
      /VERSION_MISMATCH/,
    );
    assert.equal(f.wires[0]!.requests.filter((value) => value.method === "thread/start").length, 0);
    assert.equal(f.adapter.readiness().ready, false);
    await f.adapter.stop(parked);
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(f.adapter.readiness().ready, true);
  } finally {
    await f.cleanup();
  }
});

test("failed home policy validation acquires no native custody and does not consume reader capacity", async () => {
  const f = await fixture({
    provider: {
      id: "fixture",
      baseUrl: "ftp://provider.invalid",
      environmentKey: "FIXTURE_PROVIDER_KEY",
      copilotOnly: true,
    },
  });
  try {
    for (let index = 0; index < 3; index++)
      await assert.rejects(
        f.adapter.reader({
          opening: { ...opening, operationId: `reader-${index}` },
          async begin() {
            assert.fail("invalid config cannot begin custody");
          },
          async owned() {},
          async released() {},
        }),
        /PROVIDER_URL/,
      );
    assert.deepEqual(
      await f.adapter.prepare({
        opening,
        cwd: f.directory,
        mode: "create",
        selectionSource: "requested",
        selection: codexSelectionSchema.parse(selection),
      }),
      { state: "refused", noAllocation: true, code: "INVALID" },
    );
    assert.equal(f.allocations.length, 0);
    assert.equal(f.wires.length, 0);
    assert.equal(f.adapter.readiness().ready, true);
  } finally {
    await f.cleanup();
  }
});

test("reverse IDs preserve JSON kind and native withdrawal settles only its exact unanswered capability", async () => {
  let interactions: InteractionOwner | undefined;
  const f = await fixture({
    interactions: (run, attachment) =>
      (interactions = new InteractionOwner(run, attachment, { baseline: "complete" })),
  });
  try {
    await f.open();
    const wire = f.wires[0]!;
    const params = {
      threadId: "native-root",
      turnId: "turn",
      itemId: "item",
      isBlocking: true,
      questions: [
        {
          id: "q",
          header: "Question",
          question: "What now?",
          isSecret: false,
          isOther: true,
          options: null,
        },
      ],
    };
    wire.emit({ id: 1, method: "item/tool/requestUserInput", params });
    wire.emit({ id: "1", method: "item/tool/requestUserInput", params });
    const before = interactions!.getSnapshot();
    assert.equal(before.items.length, 2);
    assert(before.items.every((value) => value.state === "pending"));
    assert.notEqual(before.items[0]!.nativeRequestId, before.items[1]!.nativeRequestId);
    wire.emit({ method: "serverRequest/resolved", params: { requestId: 1 } });
    await new Promise<void>((done) => setImmediate(done));
    const after = interactions!.getSnapshot();
    assert.equal(after.items[0]!.state, "confirmed");
    assert.equal(after.items[0]!.accepted, false);
    assert.equal(after.items[1]!.state, "pending");
    await wire.close();
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(interactions!.getSnapshot().items[1]!.accepted, null);
  } finally {
    await f.cleanup();
  }
});

test("unknown observed permissions cannot silently become trusted defaults during Reopen", async () => {
  const f = await fixture();
  try {
    const { capsule, result } = await f.open();
    f.wires[0]!.emit({
      method: "thread/settings/updated",
      params: {
        threadId: result.run.nativeSession,
        threadSettings: {
          approvalPolicy: {
            granular: {
              sandbox_approval: true,
              rules: true,
              skill_approval: true,
              request_permissions: true,
              mcp_elicitations: true,
            },
          },
          sandboxPolicy: { type: "dangerFullAccess" },
        },
      },
    });
    const observed = await f.adapter.inspect(capsule);
    assert(observed && !("state" in observed));
    if (!observed || "state" in observed) return;
    assert.equal((observed.selection as Record<string, unknown>).access, undefined);
    await f.adapter.stop(capsule);
    await new Promise<void>((done) => setImmediate(done));
    const nextOpening = { ...opening, operationId: "reopen", generation: 2 };
    assert.deepEqual(
      await f.adapter.prepare({
        opening: nextOpening,
        cwd: f.directory,
        mode: "reopen",
        selectionSource: "observed",
        selection: observed.selection,
      }),
      { state: "refused", noAllocation: true, code: "INVALID" },
    );
    assert.equal(f.allocations.length, 1);
    const next = await f.adapter.prepare({
      opening: nextOpening,
      cwd: f.directory,
      mode: "reopen",
      selectionSource: "requested",
      selection: codexSelectionSchema.parse(selection),
    });
    assert(!("state" in next));
    const reopened = await f.adapter.open({
      capsule: next,
      cwd: f.directory,
      mode: "reopen",
      nativeSession: result.run.nativeSession,
      selectionSource: "requested",
      selection: codexSelectionSchema.parse(selection),
      commitBinding(run) {
        assert.equal(run.nativeSession, result.run.nativeSession);
      },
    });
    assert.equal(reopened.kind, "reopened");
    assert.equal(f.wires.length, 2);
  } finally {
    await f.cleanup();
  }
});
