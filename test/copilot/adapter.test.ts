import { copilotSelectionSchema, copilotMessageSchema } from "../../src/copilot/contracts.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { copilotCommandSchema } from "../../src/copilot/index.js";
import { normalizeCallback } from "../../src/copilot/server/callbacks.js";
import { CopilotHistory, historyPort } from "../../src/copilot/server/history.js";
import { copilotRouter } from "../../src/copilot/server/router.js";
import type { Json, Original, RunRef } from "../../src/protocol/index.js";
import { fixture, custody, deferred, scope, tick } from "./fixture.js";
const original = (id: string): Original => ({ scope, id, requestHash: "0".repeat(64) });
test("observed Copilot settings reopen without promoting missing policy facts to defaults", () =>
  fixture(async (value) => {
    const first = await value.open();
    const observed = await value.adapter.read(first.run, { type: "selection" });
    assert.equal(observed.nativeProviderId, "native-route");
    await value.adapter.native.stop(first.capsule);
    await tick();
    const base = {
      opening: { scope, generation: 2, operationId: "observed-reopen" },
      cwd: value.directory,
      mode: "reopen" as const,
      selectionSource: "observed" as const,
    };
    const { permissions: _permissions, ...unknownPermission } = observed;
    assert.deepEqual(
      await value.adapter.native.prepare({
        ...base,
        selection: unknownPermission as unknown as typeof observed,
      }),
      { state: "refused", noAllocation: true, code: "INVALID" },
    );
    assert.equal(value.allocations.length, 1);
    const parked = await value.adapter.native.prepare({ ...base, selection: observed });
    assert(!("state" in parked));
    const reopened = await value.adapter.native.open({
      ...base,
      capsule: { opening: parked.opening, identity: parked.identity },
      nativeSession: first.run.nativeSession,
      selection: observed,
      commitBinding(run) {
        assert.equal(run.nativeSession, first.run.nativeSession);
      },
    });
    assert.equal(reopened.kind, "reopened");
    assert.equal(reopened.selection.nativeProviderId, observed.nativeProviderId);
    const resumed = value.clients.at(-1)!;
    assert.equal(resumed.resumes, 1);
    assert.equal(resumed.creates, 0);
    assert.equal(
      resumed.calls.some((call) => call.method === "permissions.setMode"),
      false,
    );
    assert.equal(
      resumed.calls.some((call) => call.method === "mode.set"),
      false,
    );
  }));

test("parked native ownership, observed settings and enqueue/immediate/abort differ from Stop", () =>
  fixture(async (value) => {
    assert.equal(value.allocations.length, 0);
    const { run, capsule, client, bindings } = await value.open();
    assert.deepEqual(bindings, [run]);
    assert.equal(client.starts, 1);
    assert.equal(client.creates, 1);
    assert.equal(client.resumes, 0);
    assert.equal(client.config!.onPermissionRequest().kind, "no-result");
    assert.equal(client.config!.provider, undefined);
    assert.equal(
      ((await value.adapter.read(run, { type: "selection" })) as Record<string, Json>)
        .nativeProviderId,
      "native-route",
    );
    const sent = await value.adapter.native.send({
      run,
      capsule,
      originalId: "send",
      message: copilotMessageSchema.parse({ text: "hello" }),
    });
    assert.equal(sent.state, "succeeded");
    await value.adapter.native.command({
      run,
      capsule,
      originalId: "steer",
      original: original("steer"),
      command: { type: "steer", message: { text: "follow", files: [] } },
    });
    assert.deepEqual(
      client.calls.filter((call) => call.method === "send").map((call) => call.input!.mode),
      ["enqueue", "immediate"],
    );
    await value.adapter.native.command({
      run,
      capsule,
      originalId: "abort",
      original: original("abort"),
      command: { type: "abort" },
    });
    assert.equal(value.allocations[0]!.sealed, false);
    assert.equal(value.adapter.native.readiness().ready, false);
    const stop = await value.adapter.native.stop(capsule);
    assert.equal(stop.noAutomaticContinuation, true);
    assert.equal(value.allocations[0]!.sealed, true);
    await tick();
    assert.equal(value.adapter.native.readiness().ready, true);
    await assert.rejects(
      value.adapter.native.send({
        run,
        capsule,
        originalId: "late",
        message: copilotMessageSchema.parse({ text: "late" }),
      }),
      /RUN_FENCED/,
    );
    assert.throws(() => copilotCommandSchema.parse({ type: "continue" }));
    assert.throws(() => copilotCommandSchema.parse({ type: "goal.clear" }));
  }));
test("current controls, actual queue/tasks and safe MCP surfaces preserve semantic receipts", () =>
  fixture(
    async (value) => {
      const { run, capsule, client } = await value.open();
      for (const command of [
        { type: "model", model: "m", effort: "low" },
        { type: "mode", mode: "plan" },
        { type: "permissions", mode: "manual" },
        { type: "queue.promote", id: "q" },
        { type: "task.cancel", id: "t" },
        { type: "task.promote", id: "t" },
        { type: "compact" },
        { type: "mcp.restart", server: "tools" },
        { type: "mcp.login", server: "tools" },
      ] as const)
        await value.adapter.native.command({
          run,
          capsule,
          originalId: command.type,
          original: original(command.type),
          command,
        });
      assert.deepEqual(await value.adapter.read(run, { type: "queue" }), {
        items: [{ id: "q", text: "queued", kind: "user", agentMode: "interactive" }],
        steeringMessages: ["steer"],
      });
      assert.equal(
        JSON.stringify(await value.adapter.read(run, { type: "tasks" })).includes(
          '"resolvedModel":"actual"',
        ),
        true,
      );
      assert.deepEqual(await value.adapter.read(run, { type: "mcp" }), [
        { name: "tools", enabled: true, status: "connected" },
      ]);
      const link = value.adapter.loginLink(run, "mcp.login");
      assert.equal(link.state, "ready");
      assert.equal(
        JSON.stringify(await value.adapter.read(run, { type: "models" })).includes("TEST_SECRET"),
        false,
      );
      const compact = await value.adapter.native.command({
        run,
        capsule,
        originalId: "compact2",
        original: original("compact2"),
        command: { type: "compact" },
      });
      assert.equal(JSON.stringify(compact).includes("private summary"), false);
      const before = client.calls.length;
      await assert.rejects(
        value.adapter.native.command({
          run,
          capsule,
          originalId: "wrong",
          original: original("wrong"),
          command: { type: "model", model: "not-authorized" },
        }),
        /MODEL_UNAVAILABLE/,
      );
      assert.equal(client.calls.length, before);
    },
    {
      sessionOptions: {
        mcpServers: {
          tools: {
            type: "http",
            url: "https://private.invalid/mcp",
            headers: { Authorization: "private" },
          },
        },
        mcpOAuthTokenStorage: "in-memory",
      },
    },
  ));
test("exact permission events and closure callbacks have distinct native acknowledgement", () =>
  fixture(async (value) => {
    const { run, client, owner } = await value.open();
    client.emit("permission.requested", {
      requestId: "r",
      permissionRequest: { kind: "mcp", managedApprovalRequired: true, toolName: "confirm" },
    });
    const permission = owner.getSnapshot().items[0]!;
    assert.equal(permission.prompt.type, "copilot.permission");
    await owner.dispatch(
      permission.reference,
      { scope, id: "answer1", requestHash: "0".repeat(64) },
      { type: "copilot.permission", kind: "approve-once" },
    );
    assert.equal(owner.getSnapshot().items[0]!.state, "confirmed");
    const pending = client.config!.onUserInputRequest(
      { question: "Pick", choices: ["A", "B"], allowFreeform: true },
      { sessionId: run.nativeSession },
    );
    const question = owner.getSnapshot().items.at(-1)!;
    await owner.dispatch(
      question.reference,
      { scope, id: "answer2", requestHash: "1".repeat(64) },
      { type: "copilot.question", answer: "A", wasFreeform: false, extraInfo: "details" },
    );
    assert.deepEqual(await pending, { answer: "A\n\nAdditional info: details", wasFreeform: true });
    assert.equal(owner.getSnapshot().items.at(-1)!.state, "submitted");
    client.emit(
      "subagent.started",
      { toolCallId: "child-task", agentDisplayName: "Child" },
      "child",
    );
    assert.deepEqual(
      value.adapter
        .historyScopes(run)
        .map((value) => value.stream)
        .sort(),
      ["child", "root"],
    );
    await assert.rejects(
      client.config!.onExitPlanModeRequest(
        { summary: "Plan", actions: ["implement"], recommendedAction: "implement" },
        { sessionId: run.nativeSession },
      ),
      /CALLBACK_OWNER_UNPROVED/,
    );
    assert.equal(owner.getSnapshot().issue, "nativeGap");
    client.emit("session.error", { message: "visible after rejected callback" });
    assert.equal(
      value.adapter
        .history(run)
        .getSnapshot()
        .rows.some(
          (row) =>
            row.body.kind === "complete" && row.body.text === "visible after rejected callback",
        ),
      true,
    );
  }));
test("SDK-returned native binding survives later settings failure and remains explicitly stoppable", () =>
  fixture(async (value) => {
    const held = await value.adapter.native.prepare({
      opening: { scope, generation: 1, operationId: "failed-open" },
      cwd: value.directory,
      mode: "create",
      selectionSource: "requested",
      selection: copilotSelectionSchema.parse({ model: "m" }),
    });
    if ("state" in held) throw Error("Unexpected prepare refusal");
    const bindings: RunRef[] = [];
    // Configure the scripted client before its create response reaches adapter initialization.
    const capsule = { opening: held.opening, identity: held.identity };
    const opened = value.adapter.native.open({
      capsule,
      cwd: value.directory,
      mode: "create",
      nativeSession: null,
      selectionSource: "requested",
      selection: copilotSelectionSchema.parse({ model: "m" }),
      commitBinding(observation) {
        bindings.push(observation);
        value.clients[0]!.modeFailure = true;
      },
    });
    await assert.rejects(opened, /scripted mode failure/);
    assert.equal(bindings.length, 1);
    assert.equal(value.adapter.native.readiness().ready, false);
    assert.equal(value.allocations[0]!.sealed, false);
    await value.adapter.native.stop(capsule);
    await tick();
    assert.equal(value.adapter.native.readiness().ready, true);
  }));
test("file input custody survives enqueue ACK and early completion; Stop wins late preparation", async () => {
  let release = 0;
  const preparing = deferred<
    Readonly<{
      attachments: readonly Json[];
      release(): Promise<void>;
    }>
  >();
  await fixture(
    async (value) => {
      const { run, capsule, client } = await value.open();
      const sending = value.adapter.native.send({
        run,
        capsule,
        originalId: "with-file",
        message: copilotMessageSchema.parse({ text: "image", files: ["f"] }),
      });
      await tick();
      await value.adapter.native.stop(capsule);
      preparing.resolve({
        attachments: [],
        async release() {
          release++;
        },
      });
      await assert.rejects(sending, /RUN_FENCED/);
      assert.equal(client.calls.filter((call) => call.method === "send").length, 0);
      assert.equal(release, 1);
    },
    { prepareInputs: () => preparing.promise },
  );
  release = 0;
  await fixture(
    async (value) => {
      const { run, capsule, client } = await value.open();
      const ack = deferred<string>();
      client.sendHook = async () => {
        client.emit("user.message", { messageId: "native", content: "image" });
        client.emit("session.idle", {});
        return ack.promise;
      };
      const pending = value.adapter.native.send({
        run,
        capsule,
        originalId: "early",
        message: copilotMessageSchema.parse({ text: "image", files: ["f"] }),
      });
      await tick();
      assert.equal(release, 0);
      ack.resolve("native");
      await pending;
      await tick();
      assert.equal(release, 1);
    },
    {
      prepareInputs: async () => ({
        attachments: [],
        async release() {
          release++;
        },
      }),
    },
  );
});
test("passive stopped history uses a bounded single-use reader and never Create or Resume", () =>
  fixture(async (value) => {
    const run: RunRef = { scope, generation: 4, nativeSession: "persisted" };
    const lease = custody();
    const reader = await value.adapter.coldHistory(run, lease);
    const client = value.clients[0]!;
    assert.equal(client.creates, 0);
    assert.equal(client.resumes, 0);
    assert.equal(value.allocations[0]!.options.kind, "reader");
    client.pages = [
      {
        events: [
          { id: "e", type: "assistant.message", data: { messageId: "m", content: "saved" } },
        ],
        cursor: "next",
        hasMore: true,
        cursorStatus: "ok",
      },
    ];
    const page = await reader.port.read({ cursor: null, count: 100 }, () => {});
    assert.equal(page.status, "page");
    assert.equal(client.calls[0]!.input!.max, 100);
    assert.deepEqual(await reader.port.read({ cursor: null, count: 100 }, () => {}), {
      status: "expired",
    });
    assert.equal(client.calls.length, 1);
    assert.equal(value.adapter.native.readiness().ready, true);
    await value.adapter.native.close();
    assert.deepEqual(lease.log, ["begin", "owned", "released"]);
    assert.equal(value.allocations[0]!.sealed, true);
    await assert.rejects(
      reader.port.read({ cursor: "next", count: 100 }, () => {}),
      /READER_RETIRED/,
    );
  }));
test("same logical scope admits one persisted reader before custody awaits and permits replacement only after close", () =>
  fixture(async (value) => {
    const run: RunRef = { scope, generation: 4, nativeSession: "persisted" },
      lease = custody(),
      gate = deferred<void>(),
      began = deferred<void>();
    const first = value.adapter.coldHistory(run, {
      ...lease,
      async begin(selected, opening) {
        began.resolve();
        await gate.promise;
        return lease.begin(selected, opening);
      },
    });
    try {
      await assert.rejects(value.adapter.coldHistory({ ...run, generation: 5 }, lease), /BUSY/);
      await began.promise;
      assert.equal(value.allocations.length, 0);
      gate.resolve();
      const reader = await first;
      assert.equal(value.allocations.length, 1);
      await assert.rejects(value.adapter.coldHistory(run, lease), /BUSY/);
      assert.equal(value.allocations[0]!.sealed, false);
      assert.deepEqual(lease.log, ["begin", "owned"]);
      assert.equal((await reader.port.read({ cursor: null, count: 100 }, () => {})).status, "page");
      await reader.close();
      assert.deepEqual(lease.log, ["begin", "owned", "released"]);
      const next = await value.adapter.coldHistory({ ...run, generation: 5 }, lease);
      assert.equal(value.allocations.length, 2);
      await next.close();
      assert.deepEqual(lease.log, ["begin", "owned", "released", "begin", "owned", "released"]);
      assert.equal(
        value.clients.every((client) => client.creates === 0 && client.resumes === 0),
        true,
      );
    } finally {
      gate.resolve();
      await (await first.catch(() => undefined))?.close();
    }
  }));
test("root/child history, missing prefixes, errors and compaction remain separate evidence", () => {
  const run: RunRef = { scope, generation: 1, nativeSession: "root-native" };
  const history = new CopilotHistory(run, "a");
  history.observe({
    id: "a",
    type: "assistant.message_delta",
    data: { messageId: "m", deltaContent: "tail" },
  });
  const partial = history.root().getSnapshot().rows[0]!.body;
  assert.equal(partial.kind, "partial");
  if (partial.kind === "partial") assert.deepEqual(partial.missing, ["prefix", "final"]);
  history.observe({
    id: "b",
    type: "assistant.message",
    data: { messageId: "m", content: "whole" },
  });
  history.observe({
    id: "c",
    type: "subagent.started",
    agentId: "child",
    data: { toolCallId: "t", agentDisplayName: "Child" },
  });
  history.observe({
    id: "d",
    type: "assistant.message",
    agentId: "child",
    data: { messageId: "m", content: "child" },
  });
  assert.equal(history.window("child").getSnapshot().rows[0]!.body.kind, "complete");
  assert.equal(
    history
      .root()
      .getSnapshot()
      .rows.some((row) => row.body.kind === "complete" && row.body.text === "child"),
    false,
  );
  history.observe({ id: "idle-root", type: "session.idle", data: {} });
  assert.equal(history.root().getSnapshot().activity.state, "idle");
  history.observe({
    id: "still-child",
    type: "assistant.turn_start",
    agentId: "child",
    data: { turnId: "child-turn" },
  });
  assert.equal(history.window("child").getSnapshot().activity.state, "working");
  history.observe({
    id: "e",
    type: "session.error",
    data: { message: "provider failure", errorCode: "network" },
  });
  assert.equal(history.root().getSnapshot().activity.state, "failed");
  history.observe({ id: "f", type: "session.compaction_start", data: {} });
  assert.equal(history.root().getSnapshot().rows.at(-1)!.body.kind, "complete");
  history.close();
  const callback = normalizeCallback("elicitation", {
    sessionId: "root-native",
    message: "Verify",
    mode: "url",
    url: "https://example.test/verify?private=token",
  });
  assert.equal(JSON.stringify(callback.prompt).includes("token"), false);
  assert.equal(callback.privateUrl?.includes("token"), true);
});
test("Copilot router routes exact originals/runs through lifecycle and fences foreign scopes", async () => {
  const run: RunRef = { scope, generation: 1, nativeSession: "n" };
  let calls = 0;
  const router = copilotRouter(
    {
      async command(actual, id, command, current) {
        calls++;
        assert.deepEqual(actual, scope);
        assert.equal(id, "original");
        assert.deepEqual(current, run);
        assert.equal(command.type, "abort");
        return {
          scope,
          id,
          requestHash: "0".repeat(64),
          revision: 1,
          state: "succeeded",
          result: { accepted: true },
        };
      },
    },
    async () => ({ choices: [] }),
  );
  const caller = router.createCaller({
    identity: { connection: "c", principal: "p", actions: ["read", "control"] },
    route: { authority: "a", host: "h", owner: "o", routeEpoch: "e" },
    admit: () => () => {},
  });
  await caller.command({ session: "s", id: "original", run, command: { type: "abort" } });
  assert.equal(calls, 1);
  const stale = router.createCaller({
    identity: { connection: "c", principal: "p", actions: ["read", "control"] },
    route: { authority: "a", host: "h", owner: "o", routeEpoch: "e" },
    session: { id: scope.session, generation: 2 },
    admit: () => () => {},
  });
  await assert.rejects(
    stale.command({ session: "s", id: "stale", run, command: { type: "abort" } }),
    /SESSION_FENCED/,
  );
  await assert.rejects(
    stale.read({ session: "s", run, request: { type: "models" } }),
    /SESSION_FENCED/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    caller.command({
      session: "s",
      id: "original",
      run: { ...run, scope: { ...scope, principal: "other" } },
      command: { type: "abort" },
    }),
  );
  assert.equal(calls, 1);
});
test("current Copilot shell chunks use publication sequence and preserve explicit output omissions", () => {
  const run: RunRef = { scope, generation: 1, nativeSession: "shell" };
  const history = new CopilotHistory(run, "attachment");
  history.observe({
    id: "start",
    type: "tool.execution_start",
    data: { toolCallId: "t", toolName: "shell" },
  });
  history.observe({
    id: "chunk0",
    type: "tool.shell_output",
    ephemeral: true,
    data: { toolCallId: "t", sequence: 0, text: "first" },
  });
  history.observe({
    id: "chunk2",
    type: "tool.shell_output",
    ephemeral: true,
    data: { toolCallId: "t", sequence: 2, text: "third" },
  });
  history.observe({
    id: "late0",
    type: "tool.shell_output",
    ephemeral: true,
    data: { toolCallId: "t", sequence: 0, text: "first" },
  });
  const partial = history.root().getSnapshot().rows[0]!.body;
  assert.equal(partial.kind, "partial");
  if (partial.kind === "partial") {
    assert.equal(partial.text, "firstthird");
    assert.deepEqual(partial.missing, ["final", "interior"]);
  }
  history.observe({
    id: "final",
    type: "tool.execution_complete",
    data: { toolCallId: "t", success: true, result: { content: "authoritative full output" } },
  });
  const body = history.root().getSnapshot().rows[0]!.body;
  assert.equal(body.kind === "complete" && body.text, "authoritative full output");
});
test("primary history includes typed child lifecycle without importing child conversation rows", async () => {
  const run: RunRef = { scope, generation: 1, nativeSession: "history" };
  const historyScope = { run, attachment: "a", stream: "root" };
  const events = [
    {
      id: "start",
      type: "subagent.started",
      agentId: "child",
      data: { toolCallId: "t", agentDisplayName: "Helper" },
    },
    { id: "reply", type: "assistant.message", data: { messageId: "m", content: "main" } },
  ];
  const active = historyPort(historyScope, "active", async (request) => {
    assert.equal(request.agentScope, "primary");
    return { events, cursor: "end", hasMore: false, cursorStatus: "ok" };
  });
  const page = await active.read({ cursor: null, count: 100 }, () => {});
  assert.equal(page.status, "page");
  if (page.status === "page") {
    assert.equal(page.rows.length, 2);
    assert.equal(page.rows[0]!.kind, "delegation");
    assert.equal(page.rows[0]!.native.agentId, "child");
    assert.equal(JSON.parse(page.rows[0]!.id)[1], "root");
  }
  const persisted = historyPort(historyScope, "persisted", async () => ({
    events: [
      ...events,
      {
        id: "child-message",
        type: "assistant.message",
        agentId: "child",
        data: { messageId: "cm", content: "child secret stream" },
      },
    ],
    cursor: "end",
    hasMore: false,
    cursorStatus: "ok",
  }));
  const saved = await persisted.read({ cursor: null, count: 100 }, () => {});
  assert.equal(saved.status, "page");
  if (saved.status === "page") assert.equal(saved.rows.length, 2);
});
test("normal long SDK streams stay live beyond old lifetime limits; recent duplicates and terminal weakening remain safe", () => {
  const run: RunRef = { scope, generation: 1, nativeSession: "long" };
  const history = new CopilotHistory(run, "a");
  history.observe({ id: "begin", type: "assistant.message_start", data: { messageId: "m" } });
  for (let index = 0; index < 4200; index++)
    history.observe({
      id: `delta-${index}`,
      type: "assistant.message_delta",
      ephemeral: true,
      parentId: "native-persisted-anchor",
      data: { messageId: "m", deltaContent: "x" },
    });
  const duplicate = {
    id: "delta-4199",
    type: "assistant.message_delta",
    ephemeral: true,
    parentId: "native-persisted-anchor",
    data: { messageId: "m", deltaContent: "x" },
  };
  assert.equal(history.observe(duplicate), null);
  let body = history.root().getSnapshot().rows[0]!.body;
  assert.equal(body.kind === "partial" && body.text.length, 4200);
  assert.equal(history.root().getSnapshot().gaps.length, 0);
  history.observe({
    id: "final",
    type: "assistant.message",
    data: { messageId: "m", content: "native complete" },
  });
  history.observe({
    id: "old-delta",
    type: "assistant.message_delta",
    ephemeral: true,
    data: { messageId: "m", deltaContent: "old" },
  });
  body = history.root().getSnapshot().rows[0]!.body;
  assert.equal(body.kind === "complete" && body.text, "native complete");
  assert.throws(
    () => history.observe({ ...duplicate, data: { messageId: "m", deltaContent: "conflict" } }),
    /EVENT_ID_CONFLICT/,
  );
});
test("successive child lifetimes retire inactive residency, while subscribed children and active lineage stay owned", async () => {
  const run: RunRef = { scope, generation: 1, nativeSession: "children" };
  const history = new CopilotHistory(run, "a");
  history.observe({
    id: "start-0",
    type: "subagent.started",
    agentId: "child-0",
    data: { toolCallId: "t-0", agentDisplayName: "Child" },
  });
  const pinned = history.window("child-0").subscribe();
  history.observe({
    id: "end-0",
    type: "subagent.completed",
    agentId: "child-0",
    data: { toolCallId: "t-0", agentDisplayName: "Child" },
  });
  for (let index = 1; index < 70; index++) {
    history.observe({
      id: `start-${index}`,
      type: "subagent.started",
      agentId: `child-${index}`,
      data: { toolCallId: `t-${index}`, agentDisplayName: "Child" },
    });
    history.observe({
      id: `end-${index}`,
      type: "subagent.completed",
      agentId: `child-${index}`,
      data: { toolCallId: `t-${index}`, agentDisplayName: "Child" },
    });
  }
  assert.equal(history.streams().length, 32);
  assert.equal(history.window("child-0").subscriberCount, 1);
  assert.equal(history.root().getSnapshot().gaps.length, 0);
  history.observe({
    id: "return-old",
    type: "assistant.message",
    agentId: "child-1",
    data: { messageId: "later", content: "late native fact" },
  });
  assert.equal(history.window("child-1").getSnapshot().olderEdge.state, "unknown");
  assert.throws(() => history.rootCallbackOwner(), /CALLBACK_OWNER_UNPROVED/);
  history.observe({ id: "global-idle", type: "session.idle", data: {} });
  assert.equal(history.rootCallbackOwner().nativeAgent, "children");
  await pinned.return();
  history.close();
});
test("explicit incompatible Reopen policy refuses before allocation; model override and native policy preservation stay separate", () =>
  fixture(async (value) => {
    const base = {
      opening: { scope, generation: 2, operationId: "override" },
      cwd: value.directory,
      mode: "reopen" as const,
    };
    const prior = {
      kind: "copilot",
      model: "m",
      mode: "interactive",
      permissions: "allow-all",
    } as const;
    assert.deepEqual(
      await value.adapter.native.prepare({
        ...base,
        selectionSource: "requested",
        selection: copilotSelectionSchema.parse({ ...prior, mode: "plan" }),
        previousSelection: prior,
      }),
      { state: "refused", noAllocation: true, code: "UNSUPPORTED" },
    );
    assert.deepEqual(
      await value.adapter.native.prepare({
        ...base,
        selectionSource: "requested",
        selection: copilotSelectionSchema.parse({ model: "m", permissions: "manual" }),
        previousSelection: {
          model: "m",
        } as unknown as import("../../src/copilot/contracts.js").CopilotObservedSelection,
      }),
      { state: "refused", noAllocation: true, code: "UNSUPPORTED" },
    );
    assert.equal(value.allocations.length, 0);
    const held = await value.adapter.native.prepare({
      ...base,
      selectionSource: "requested",
      selection: copilotSelectionSchema.parse({ model: "m", effort: "low" }),
      previousSelection: prior,
    });
    assert.equal("state" in held, false);
    assert.equal(value.allocations.length, 1);
    if (!("state" in held))
      await value.adapter.native.stop({ opening: held.opening, identity: held.identity });
  }));
test("typed callback answers consume the exact admitted original and deliver once", () =>
  fixture(async (value) => {
    const { run, capsule, client, owner } = await value.open();
    client.emit("permission.requested", {
      requestId: "request",
      permissionRequest: { kind: "mcp", managedApprovalRequired: true },
    });
    const capability = owner.getSnapshot().items[0]!.reference;
    const admitted = original("answer-command");
    const command = {
      type: "answer" as const,
      reference: capability,
      answer: { type: "copilot.permission" as const, kind: "approve-once" as const },
    };
    const first = await value.adapter.native.command({
      run,
      capsule,
      originalId: admitted.id,
      original: admitted,
      command,
    });
    const second = await value.adapter.native.command({
      run,
      capsule,
      originalId: admitted.id,
      original: admitted,
      command,
    });
    assert.deepEqual(first, second);
    assert.equal(first.state, "succeeded");
    assert.deepEqual(owner.getSnapshot().items[0]!.original, admitted);
    assert.equal(client.calls.filter((call) => call.method === "permission.reply").length, 1);
    assert.throws(() =>
      copilotCommandSchema.parse({
        ...command,
        answer: { type: "codex.permission", grant: "session" },
      }),
    );
  }));

test("actual child history read holds inactive residency until RPC/media work settles", () =>
  fixture(async (value) => {
    const { run, client } = await value.open(),
      gate = deferred<{
        events: never[];
        cursor: string;
        hasMore: boolean;
        cursorStatus: string;
      }>(),
      entered = deferred<void>();
    Object.defineProperty(client.session.rpc.eventLog, "read", {
      value: async () => {
        entered.resolve();
        return gate.promise;
      },
    });
    const child = (id: string) => {
      client.emit("subagent.started", { toolCallId: `task-${id}`, agentDisplayName: id }, id);
      client.emit("subagent.completed", { toolCallId: `task-${id}`, agentDisplayName: id }, id);
    };
    child("held-child");
    const pending = value.adapter
      .historyRead(run, "held-child")
      .read({ cursor: null, count: 100 }, () => {});
    await entered.promise;
    try {
      for (let n = 0; n < 40; n++) child(`child-${n}`);
      assert(value.adapter.historyScopes(run).some((scope) => scope.stream === "held-child"));
    } finally {
      gate.resolve({ events: [], cursor: "end", hasMore: false, cursorStatus: "ok" });
    }
    assert.equal((await pending).status, "page");
    child("later-child");
    assert(!value.adapter.historyScopes(run).some((scope) => scope.stream === "held-child"));
  }));
