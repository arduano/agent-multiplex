import { codexSelectionSchema, codexMessageSchema } from "../../src/codex/contracts.js";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { InteractionOwner } from "../../src/interactions/index.js";
import {
  CodexRpc,
  normalizeCallback,
  codexTimelinePage,
  CodexHistory,
  spawnCodexWire,
  codexCommandSchema,
  codexConfig,
} from "../../src/codex/node.js";
import {
  defaultHandler,
  fixture,
  opening,
  scope,
  ScriptedWire,
  selection,
  stopProof,
} from "./fixtures.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("real allocator reference contract, inert construction and exact parked-before-open ownership", async () => {
  const f = await fixture();
  try {
    assert.equal(f.allocations.length, 0);
    assert.equal(f.wires.length, 0);
    const prepared = await f.prepare({ opening, cwd: f.directory });
    assert.equal(f.wires.length, 0);
    const config = await readFile(join(f.allocations[0]!.home, "config.toml"), "utf8");
    assert(config.includes('approval_policy = "on-request"'));
    assert(config.includes('sandbox_mode = "danger-full-access"'));
    assert(config.includes("request_max_retries = 0"));
    assert(!config.includes("openai.com"));
    const opened = await f.adapter.open({
      capsule: prepared,
      cwd: f.directory,
      mode: "create",
      nativeSession: null,
      selectionSource: "requested",
      selection: codexSelectionSchema.parse(selection),
      commitBinding() {},
    });
    assert.equal(opened.kind, "created");
    assert.equal(opened.activity, "idle");
    assert.equal(f.wires.length, 1);
    assert.equal(f.wires[0]!.requests.filter((value) => value.method === "thread/start").length, 1);
    assert.equal(f.wires[0]!.requests.filter((value) => value.method === "turn/start").length, 0);
    await f.adapter.stop(prepared);
    await f.adapter.close();
  } finally {
    await f.cleanup();
  }
});

test("native command matrix uses actual distinct methods and original IDs; ACKs do not complete work", async () => {
  const f = await fixture();
  try {
    const { capsule, result } = await f.open(),
      run = result.run;
    const send = await f.adapter.send({
      capsule,
      run,
      originalId: "send-once",
      message: codexMessageSchema.parse({ text: "hello" }),
    });
    assert.equal(send.state, "succeeded");
    assert.equal(f.adapter.history(run).activity().state, "working");
    const turnId = (send.result as { turnId: string }).turnId;
    const commands = [
      { type: "steer", expectedTurnId: turnId, message: { text: "follow up", attachments: [] } },
      { type: "queue", message: { text: "queued", attachments: [] } },
      { type: "interrupt", turnId },
      { type: "compact" },
      { type: "turnSettings", turnId, model: "fixture-luna", effort: "high" },
      { type: "goal.set", objective: "finite work", status: "active" },
      { type: "goal.clear" },
      { type: "terminal.terminate", processId: "process-1" },
      { type: "terminals.clean" },
      { type: "mcp.reload" },
    ];
    for (let index = 0; index < commands.length; index++)
      assert.equal(
        (
          await f.adapter.command({
            capsule,
            run,
            originalId: `cmd-${index}`,
            original: { scope, id: `cmd-${index}`, requestHash: "0".repeat(64) },
            command: codexCommandSchema.parse(commands[index]),
          })
        ).state,
        "succeeded",
      );
    assert.equal(
      (
        await f.adapter.command({
          capsule,
          run,
          originalId: "busy-continue",
          original: { scope, id: "busy-continue", requestHash: "0".repeat(64) },
          command: { type: "continue" },
        })
      ).state,
      "refused",
    );
    f.wires[0]!.emit({
      method: "turn/completed",
      params: {
        threadId: run.nativeSession,
        turn: { id: turnId, status: "failed", error: { message: "Intermittent network failure" } },
      },
    });
    assert.equal(
      (
        await f.adapter.command({
          capsule,
          run,
          originalId: "continue",
          original: { scope, id: "continue", requestHash: "0".repeat(64) },
          command: { type: "continue" },
        })
      ).state,
      "succeeded",
    );
    const request = f.wires[0]!.requests.find((value) => value.method === "thread/queue/add")!;
    assert.equal(request.params!.clientUserMessageId, "cmd-1");
    const resumes = f.wires[0]!.requests.filter(
      (value) =>
        value.method === "turn/start" &&
        Array.isArray(value.params?.input) &&
        value.params.input.length === 0,
    );
    assert.equal(resumes.length, 1);
    assert(
      f.adapter
        .history(run)
        .window()
        .getSnapshot()
        .rows.some(
          (row) =>
            row.kind === "notice" &&
            row.body.kind === "complete" &&
            row.body.text.includes("network failure"),
        ),
    );
  } finally {
    await f.cleanup();
  }
});

test("Stop wins during async attachment preparation; late preparation cannot dispatch a native Send", async () => {
  const prepared = deferred<void>(),
    entered = deferred<void>();
  let releases = 0;
  const f = await fixture({
    prepareInputs: async () => {
      entered.resolve();
      await prepared.promise;
      return {
        inputs: [{ type: "localImage", path: "/private-owned-cache/image.png" }],
        async release() {
          releases++;
        },
      };
    },
  });
  try {
    const { capsule, result } = await f.open();
    const sent = f.adapter.send({
      capsule,
      run: result.run,
      originalId: "image",
      message: codexMessageSchema.parse({ text: "inspect", attachments: [{ id: "owned-file" }] }),
    });
    await entered.promise;
    await f.adapter.stop(capsule);
    const nextOpening = { ...opening, generation: 2, operationId: "reopen-after-inputs" };
    assert.deepEqual(
      await f.adapter.prepare({
        opening: nextOpening,
        cwd: f.directory,
        mode: "reopen",
        selectionSource: "requested",
        selection: codexSelectionSchema.parse(selection),
      }),
      { state: "refused", noAllocation: true, code: "BUSY" },
    );
    assert.equal(f.allocations.length, 1);
    prepared.resolve();
    await assert.rejects(sent, /FENCED/);
    const next = await f.adapter.prepare({
      opening: nextOpening,
      cwd: f.directory,
      mode: "reopen",
      selectionSource: "requested",
      selection: codexSelectionSchema.parse(selection),
    });
    assert(!("state" in next));
    assert.equal(f.allocations.length, 2);
    assert.equal(f.wires[0]!.requests.filter((value) => value.method === "turn/start").length, 0);
    assert.equal(releases, 1);
  } finally {
    await f.cleanup();
  }
});

test("turn completion overtaking Send ACK releases exact input lease without waiting for Stop", async () => {
  let releases = 0;
  const f = await fixture(
    {
      prepareInputs: async () => ({
        inputs: [{ type: "localImage", path: "/private-owned-cache/image.png" }],
        async release() {
          releases++;
        },
      }),
    },
    (request, wire) => {
      if (request.method === "turn/start") {
        wire.emit({
          method: "turn/started",
          params: { threadId: "native-root", turn: { id: "overtaking", status: "inProgress" } },
        });
        wire.emit({
          method: "turn/completed",
          params: { threadId: "native-root", turn: { id: "overtaking", status: "completed" } },
        });
        return { turn: { id: "overtaking", status: "completed" } };
      }
      return defaultHandler(request, wire);
    },
  );
  try {
    const { capsule, result } = await f.open();
    await f.adapter.send({
      capsule,
      run: result.run,
      originalId: "image",
      message: codexMessageSchema.parse({ text: "inspect", attachments: [{ id: "owned-file" }] }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(releases, 1);
    assert.equal(
      (
        await f.adapter.send({
          capsule,
          run: result.run,
          originalId: "unsafe",
          message: {
            text: "inspect",
            inputs: [{ type: "localImage", path: "/arbitrary/file" }],
          } as unknown as import("../../src/codex/contracts.js").CodexMessage,
        })
      ).state,
      "refused",
    );
  } finally {
    await f.cleanup();
  }
});

test("native reverse question preserves per-question extra info and requires actual resolution before confirmation", async () => {
  let interactions: InteractionOwner | undefined;
  const f = await fixture({
    interactions: (run, attachment) =>
      (interactions = new InteractionOwner(run, attachment, { baseline: "complete" })),
  });
  try {
    const { result } = await f.open(),
      wire = f.wires[0]!;
    wire.emit({
      id: "question-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "native-root",
        turnId: "turn",
        itemId: "item",
        isBlocking: true,
        questions: [
          {
            id: "q",
            header: "Context\nmore",
            question: "Choose\nplease",
            isSecret: false,
            isOther: false,
            options: [{ label: "Choice", description: "Details\nmore" }],
          },
        ],
      },
    });
    const prompt = interactions!.getSnapshot().items[0]!;
    assert.equal(prompt.prompt.type, "codex.question");
    const response = await interactions!.dispatch(
      prompt.reference,
      { scope, id: "answer", requestHash: "0".repeat(64) },
      { type: "codex.question", answers: { q: { values: ["Choice"], extraInfo: "Choice" } } },
    );
    assert.equal(response.state, "submitted");
    const reply = wire.written.find((value) => value.id === "question-1" && value.result)!;
    assert.deepEqual(reply.result, { answers: { q: { answers: ["Choice", "Choice"] } } });
    wire.emit({ method: "serverRequest/resolved", params: { requestId: "question-1" } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(interactions!.getSnapshot().items[0]!.state, "confirmed");
    assert.equal(result.run.nativeSession, "native-root");
  } finally {
    await f.cleanup();
  }
});

test("timeline native order/completion and out-of-order child ancestry stay exact", () => {
  const run = { scope, generation: 1, nativeSession: "root" },
    history = new CodexHistory(run, "attachment", () => {}, false);
  const thread = (id: string, parent: string | null) => ({
    method: "thread/started",
    params: { thread: { id, sessionId: "root", parentThreadId: parent } },
  });
  history.ingest(thread("grandchild", "child"));
  history.ingest(thread("child", "root"));
  history.ingest(thread("root", null));
  assert.equal(history.owner("grandchild")?.relation, "child");
  history.ingest(thread("child", "foreign"));
  assert.equal(history.owner("child"), null);
  assert.equal(history.owner("grandchild"), null);
  const scopeRef = { run, attachment: "attachment", stream: "root" };
  const page = {
    threadId: "root",
    data: [
      {
        position: 1,
        type: "item",
        turnId: "t",
        item: { id: "a", type: "agentMessage", text: "one" },
      },
      { position: 2, type: "item", turnId: "t", item: { id: "b", type: "contextCompaction" } },
      {
        position: 3,
        type: "turnCompleted",
        turnId: "t",
        status: "failed",
        error: { message: "Visible failure" },
      },
    ],
    nextCursor: null,
  };
  const parsed = codexTimelinePage(scopeRef, page);
  assert.equal(parsed.status, "page");
  if (parsed.status !== "page") return;
  assert.deepEqual(
    parsed.rows.map((value) => value.id),
    ["root:a", "root:b", "root:t:error:final"],
  );
  assert(parsed.rows.every((value) => value.lifecycle !== "running"));
  assert.throws(
    () => codexTimelinePage(scopeRef, { ...page, data: [...page.data].reverse() }),
    /ORDER/,
  );
  assert.throws(() => codexTimelinePage(scopeRef, { ...page, threadId: "foreign" }), /FOREIGN/);
});

test("explicit sessionless reader fetches cold stopped history and models without Resume; closed leases recycle", async () => {
  const f = await fixture();
  let owned = 0,
    released = 0;
  const lease = (id: string) => ({
    opening: { ...opening, operationId: id },
    async begin() {},
    async owned() {
      owned++;
    },
    async released() {
      released++;
    },
  });
  try {
    const run = { scope, generation: 1, nativeSession: "native-root" };
    const reader = await f.adapter.reader(lease("reader"));
    const page = await reader
      .history({ run, attachment: "reader", stream: "native-child" })
      .read({ count: 100, cursor: null }, () => {});
    assert.equal(page.status, "page");
    await reader.close();
    for (let index = 0; index < 3; index++)
      assert.equal(
        (await f.adapter.models(lease(`models-${index}`))).choices[0]!.model,
        "fixture-luna",
      );
    assert.equal(owned, 4);
    assert.equal(released, 4);
    assert(
      f.wires
        .flatMap((value) => value.requests)
        .every((value) => !["thread/start", "thread/resume", "turn/start"].includes(value.method)),
    );
  } finally {
    await f.cleanup();
  }
});

test("same logical scope admits one cold reader before awaits and releases capacity only after exact close", async () => {
  const f = await fixture(),
    beginGate = deferred<void>(),
    began = deferred<void>();
  let released = 0;
  let capsule: Parameters<typeof stopProof>[0] | undefined;
  const lease = (operationId: string) => ({
    opening: { ...opening, operationId },
    async begin() {
      began.resolve();
      await beginGate.promise;
    },
    async owned(value: Parameters<typeof stopProof>[0]) {
      capsule = value;
    },
    async released(proof: ReturnType<typeof stopProof>) {
      assert.equal(proof.opening.operationId, operationId);
      released++;
    },
  });
  const first = f.adapter.reader(lease("first-reader"));
  try {
    await assert.rejects(
      f.adapter.reader({
        ...lease("simultaneous"),
        opening: { ...opening, generation: 2, operationId: "simultaneous" },
      }),
      /BUSY/,
    );
    await began.promise;
    assert.equal(f.allocations.length, 0);
    beginGate.resolve();
    const reader = await first;
    assert.equal(f.allocations.length, 1);
    assert.ok(capsule);
    await assert.rejects(f.adapter.reader({ ...lease("live-handover"), prior: capsule }), /BUSY/);
    assert.equal(released, 0);
    assert.equal(f.allocations.length, 1);
    assert.equal(
      (
        (await reader.request("model/list", { cursor: null, limit: 64 })) as {
          data: { model: string }[];
        }
      ).data[0]!.model,
      "fixture-luna",
    );
    await reader.close();
    assert.equal(released, 1);
    const next = await f.adapter.reader(lease("after-close"));
    assert.equal(f.allocations.length, 2);
    await next.close();
    assert.equal(released, 2);
  } finally {
    beginGate.resolve();
    await (await first.catch(() => undefined))?.close().catch(() => {});
    await f.cleanup();
  }
});

test("lost native write has one dispatch and no retry; reverse ID reuse stays fenced", async () => {
  const wire = new ScriptedWire((request, current) =>
      request.method === "initialize" ? defaultHandler(request, current) : undefined,
    ),
    requests: unknown[] = [];
  const rpc = new CodexRpc(
    wire,
    () => {},
    (value) => {
      requests.push(value);
    },
    () => {},
  );
  await rpc.initialize();
  const pending = rpc.request("turn/start", { threadId: "root", input: [] });
  await wire.close();
  await assert.rejects(pending, /WIRE_LOST/);
  assert.equal(wire.requests.filter((value) => value.method === "turn/start").length, 1);
  const other = new ScriptedWire(defaultHandler),
    captures: import("../../src/codex/node.js").ReverseRequest[] = [],
    client = new CodexRpc(
      other,
      () => {},
      (value) => captures.push(value),
      () => {},
    );
  await client.initialize();
  other.emit({ id: 7, method: "request", params: {} });
  other.emit({ id: 7, method: "request", params: {} });
  await assert.rejects(captures[0]!.reply({}), /FENCED/);
  await assert.rejects(captures[1]!.reply({}), /FENCED/);
  await client.close();
  await rpc.close();
});

test("actual owned Node stdio framing starts only on explicit wire creation and its child is reaped", async () => {
  const f = await fixture();
  try {
    const file = join(f.directory, "wire-fixture.js");
    await writeFile(
      file,
      "import{createInterface}from'node:readline';const r=createInterface({input:process.stdin});r.on('line',s=>{const m=JSON.parse(s);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{userAgent:'codex/0.162.1 fixture'}})+'\\n')});r.on('close',()=>process.exit(0));\n",
      { mode: 0o600 },
    );
    const wire = spawnCodexWire({
        node: process.execPath,
        launcher: file,
        cwd: f.directory,
        environment: {},
      }),
      rpc = new CodexRpc(
        wire,
        () => {},
        () => {},
        () => {},
      );
    await rpc.initialize();
    await rpc.close();
    assert.equal(rpc.observation.connected, false);
  } finally {
    await f.cleanup();
  }
});

test("unsupported elicitation stays explicit and private policy rejects route fallback", () => {
  const raw = {
    id: 1,
    method: "mcpServer/elicitation/request",
    params: {
      threadId: "root",
      serverName: "tool",
      message: "Confirm\nplease",
      mode: "future",
      requestedSchema: { type: "object", properties: {} },
    },
    capability: {},
    settled: Promise.resolve(),
    async reply() {},
  };
  const callback = normalizeCallback(raw, "root");
  assert.equal(callback.prompt.type, "codex.elicitation");
  if (callback.prompt.type === "codex.elicitation")
    assert.equal(callback.prompt.mode, "unsupported");
  const config = codexConfig({
    model: "fixture-luna",
    provider: {
      id: "fixture",
      baseUrl: "https://provider.invalid/v1",
      environmentKey: "FIXTURE_KEY",
      copilotOnly: true,
    },
    mcpServers: {
      local: {
        type: "stdio",
        command: "/fixture/mcp",
        args: [],
        env: { FIXTURE: "value" },
        toolApproval: "auto",
      },
    },
  });
  assert(
    config.indexOf('default_tools_approval_mode = "auto"') <
      config.indexOf("[mcp_servers.local.env]"),
  );
});

test("closed proved child history keeps actual read residency through churn without granting callback ownership", async () => {
  const gate = deferred<unknown>(),
    entered = deferred<void>();
  const f = await fixture({}, (request, wire) => {
    if (request.method === "thread/timeline/list") {
      entered.resolve();
      return gate.promise;
    }
    return defaultHandler(request, wire);
  });
  try {
    const { result } = await f.open(),
      run = result.run,
      wire = f.wires[0]!,
      history = f.adapter.history(run);
    const child = (id: string) => {
      wire.emit({
        method: "thread/started",
        params: { thread: { id, parentThreadId: run.nativeSession, sessionId: run.nativeSession } },
      });
      wire.emit({ method: "thread/closed", params: { threadId: id } });
    };
    child("saved-child");
    assert.equal(history.owner("saved-child"), null);
    const pending = f.adapter
      .historyRead(run, "saved-child")
      .read({ cursor: null, count: 100 }, () => {});
    await entered.promise;
    for (let n = 0; n < 70; n++) child(`child-${n}`);
    assert.equal(history.window("saved-child").scope.stream, "saved-child");
    gate.resolve({ threadId: "saved-child", data: [], nextCursor: null });
    const page = await pending;
    assert.equal(page.status, "page");
    assert.equal(history.owner("saved-child"), null);
    child("later-child");
    assert.throws(() => history.window("saved-child"), /UNPROVED_THREAD/);
  } finally {
    gate.resolve({ threadId: "saved-child", data: [], nextCursor: null });
    await f.cleanup();
  }
});
