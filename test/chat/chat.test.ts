import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { RetainedWorkspace } from "../../src/client/index.js";
import {
  Chat,
  FilePreview,
  RequestArea,
  RequestEditor,
  Select,
  focalOffset,
  readPreviewBytes,
  type ChatActions,
} from "../../src/chat/index.js";
import type { FileReadPort, StoredFile } from "../../src/files/index.js";
import { HistoryWindow, type Row } from "../../src/history/index.js";
import {
  validateAnswer,
  type Answer,
  type Interaction,
  type Prompt,
} from "../../src/interactions/index.js";
import { deferred, fixture, receipt, runFor, runKey, scope, until } from "../client/fixture.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The closed Select only owns a typeahead timer here. No DOM/keyboard claim.
(globalThis as { window?: unknown }).window = { clearTimeout, setTimeout };
const text = (node: ReactTestRenderer) => JSON.stringify(node.toJSON());
const file: StoredFile = {
  kind: "stored",
  scope,
  id: "explicit-file",
  name: "image.png",
  bytes: 3,
  sha256: "a".repeat(64),
  mediaType: "image/png",
  origin: "capture",
  retention: "session",
};
const interaction = (prompt: Prompt, incarnation = 1): Interaction => ({
  reference: { run: runFor(), attachment: "callbacks", incarnation },
  owner: { nativeAgent: "native-session", relation: "root" },
  nativeRequestId: "1",
  prompt,
  state: "pending",
  original: null,
  accepted: null,
  issue: null,
});
const question: Prompt = {
  type: "codex.question",
  title: "Choose the details",
  blocking: true,
  questions: [
    {
      id: "q",
      header: "First",
      question: "Which?",
      secret: false,
      other: true,
      options: [{ label: "__free", description: "An actual offered label" }, { label: "Second" }],
    },
    {
      id: "r",
      header: "Second",
      question: "Where?",
      secret: false,
      other: false,
      options: [{ label: "Here" }],
    },
  ],
};
const button = (node: ReactTestRenderer, label: string) =>
  node.root
    .findAllByType("button")
    .find((item) =>
      item.children.some((child) => typeof child === "string" && child.includes(label)),
    )!;

test("actual composer admits once, follows before ACK, preserves a newer draft and never follows failed local validation", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    view = workspace.view(scope),
    ack = deferred<ReturnType<typeof receipt>>();
  f.feed.dispatchResult = () => ack.promise;
  let n = 0,
    invalid = false;
  const actions: ChatActions = {
    draft(value, snapshot) {
      if (invalid) throw Error();
      return {
        id: `send-${++n}`,
        kind: "send",
        run: snapshot.state!.run!,
        payload: { text: value },
        optimisticText: value,
      };
    },
  };
  let node!: ReactTestRenderer;
  await act(async () => {
    node = create(h(Chat, { view, actions }));
  });
  assert.equal(f.observations.connections.size, 3);
  await act(async () => {
    await view.entry.setDraft("first");
  });
  await act(async () => view.anchor.read({ rowId: "old", offset: 0 }));
  const durable = deferred<void>();
  f.persistence.barrier = durable.promise;
  await act(async () => {
    const submit = node.root.findByType("form").props.onSubmit;
    submit({ preventDefault() {} });
    submit({ preventDefault() {} });
  });
  assert.equal(f.feed.dispatches.length, 0);
  assert.equal(view.anchor.getSnapshot().mode, "readingHistory");
  let draft!: Promise<void>;
  await act(async () => {
    draft = view.entry.setDraft("newer");
  });
  await act(async () => {
    durable.resolve();
    await draft;
    await until(() => f.feed.dispatches.length === 1);
  });
  assert.equal(n, 1);
  assert.equal(view.entry.getSnapshot().draft, "newer");
  assert.equal(view.anchor.getSnapshot().mode, "followingLive");
  assert.match(text(node), /Awaiting native confirmation/);
  await act(async () => view.anchor.read({ rowId: "older", offset: 2 }));
  await act(async () => {
    ack.resolve(receipt("send-1"));
  });
  assert.equal(view.anchor.getSnapshot().mode, "readingHistory");
  invalid = true;
  await act(async () => {
    node.root.findByType("form").props.onSubmit({ preventDefault() {} });
  });
  assert.equal(view.entry.getSnapshot().draft, "newer");
  assert.equal(view.anchor.getSnapshot().mode, "readingHistory");
  assert.equal(f.feed.dispatches.length, 1);
  assert.match(text(node), /not locally admitted/);
  await act(async () => node.unmount());
  await workspace.settled();
  assert.equal(f.observations.connections.size, 0);
  await workspace.close();
});

test("native questions retain offered labels, descriptions and separate per-question extra information; submit never implies confirmed", async () => {
  const item = interaction(question),
    replies: { ref: unknown; answer: Answer }[] = [],
    hold = deferred<void>();
  let node!: ReactTestRenderer;
  await act(async () => {
    node = create(
      h(RequestEditor, {
        interaction: item,
        actions: {
          async respond(ref, answer) {
            validateAnswer(question, answer);
            replies.push({ ref, answer });
            await hold.promise;
          },
        },
      }),
    );
  });
  assert.match(text(node), /An actual offered label/);
  await act(async () => {
    button(node, "Send answers").props.onClick();
  });
  assert.equal(replies.length, 0);
  assert.equal(node.root.findAllByProps({ role: "alert" }).length, 2);
  const radios = node.root.findAllByProps({ type: "radio" });
  await act(async () => {
    radios[0]!.props.onChange();
    radios[2]!.props.onChange();
  });
  const fields = node.root.findAllByType("textarea");
  await act(async () => {
    fields[0]!.props.onChange({ currentTarget: { value: "first context" } });
    fields[1]!.props.onChange({ currentTarget: { value: "second context" } });
  });
  await act(async () => {
    const send = button(node, "Send answers").props.onClick;
    send();
    send();
  });
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0]!.ref, item.reference);
  assert.deepEqual(replies[0]!.answer, {
    type: "codex.question",
    answers: {
      q: { values: ["__free"], extraInfo: "first context" },
      r: { values: ["Here"], extraInfo: "second context" },
    },
  });
  assert.match(text(node), /not yet confirmed/);
  await act(async () => {
    hold.resolve();
  });
  await act(async () => node.unmount());
});

test("elicitation associates field errors, rejects missing fields, preserves false, zero, empty text and empty list", async () => {
  const prompt: Prompt = {
      type: "codex.elicitation",
      title: "Exact values",
      message: "Fill form",
      mode: "form",
      form: {
        fields: {
          flag: { type: "boolean" },
          count: { type: "integer" },
          empty: { type: "string" },
          list: { type: "array", enum: ["A"] },
        },
        required: ["flag", "count", "empty", "list"],
      },
    },
    answers: Answer[] = [];
  let node!: ReactTestRenderer;
  await act(async () => {
    node = create(
      h(RequestEditor, {
        interaction: interaction(prompt),
        actions: {
          async respond(_ref, answer) {
            answers.push(answer);
          },
        },
      }),
    );
  });
  await act(async () => button(node, "Accept").props.onClick());
  assert.equal(answers.length, 0);
  assert.equal(node.root.findAllByProps({ role: "alert" }).length, 4);
  const input = node.root.findByProps({ type: "number" });
  assert.ok(input.props["aria-describedby"]);
  assert.equal(input.props["aria-invalid"], true);
  await act(async () => {
    node.root.findByType(Select).props.onValueChange("false");
  });
  await act(async () => {
    input.props.onChange({ currentTarget: { value: "0" } });
  });
  await act(async () => {
    button(node, "Use empty text").props.onClick();
  });
  await act(async () => button(node, "Use empty list").props.onClick());
  await act(async () => button(node, "Accept").props.onClick());
  assert.deepEqual(answers, [
    {
      type: "codex.elicitation",
      action: "accept",
      content: { flag: false, count: 0, empty: "", list: [] },
    },
  ]);
  await act(async () => node.unmount());
});

test("three independent requests keep unsent edits while switching; unknown never retries", async () => {
  const prompts: Prompt[] = [
    {
      type: "codex.command",
      title: "Command",
      decisions: [{ id: "allow", label: "Allow once" }],
      detail: {},
    },
    {
      type: "codex.file",
      title: "File",
      decisions: [{ id: "deny", label: "Deny file" }],
      detail: {},
    },
    { type: "codex.permission", title: "Permissions", requested: {} },
    question,
    {
      type: "codex.elicitation",
      title: "Verify",
      message: "Go",
      mode: "url",
      verificationOrigin: "https://example.org",
    },
    { type: "copilot.permission", title: "Managed", request: {}, managedApprovalRequired: true },
    {
      type: "copilot.question",
      title: "Question",
      question: "Choose",
      options: ["A"],
      freeform: true,
    },
    {
      type: "copilot.plan",
      title: "Plan callback",
      summary: "Plan",
      plan: "Details",
      actions: ["execute", "revise"],
      recommendedAction: "execute",
    },
    {
      type: "copilot.elicitation",
      title: "Unsupported",
      message: "Ask",
      mode: "unsupported",
      reason: "Unknown native form",
    },
  ];
  let node!: ReactTestRenderer;
  const items = [
    interaction(prompts[6]!, 1),
    interaction(prompts[7]!, 2),
    { ...interaction(question, 3), state: "unknown" as const },
  ];
  await act(async () => {
    node = create(
      h(RequestArea, {
        items,
        available: true,
        actions: {
          async respond() {
            throw Error("must not dispatch");
          },
        },
      }),
    );
  });
  assert.equal(node.root.findAllByType(RequestEditor).length, 3);
  const first = node.root.findAllByType(RequestEditor)[0]!;
  await act(async () => {
    first.findByProps({ type: "radio" }).props.onChange();
  });
  await act(async () => button(node, "Plan callback").props.onClick());
  assert.equal(node.root.findByProps({ "aria-label": "Plan callback" }).props.hidden, false);
  await act(async () => button(node, "Choose the details").props.onClick());
  assert.equal(button(node, "Send answers").props.disabled, true);
  await act(async () => button(node, "Question").props.onClick());
  assert.equal(
    node.root.findAllByType(RequestEditor)[0]!.findByProps({ type: "radio" }).props.checked,
    true,
  );
  await act(async () => node.unmount());
});

test("explicit preview reads are bounded and release actual leases on success and failure; focal math keeps the viewport point", async () => {
  let releases = 0,
    reads = 0;
  const reader: FileReadPort = {
    async acquire() {
      return {
        file,
        async read() {
          reads++;
          return new Uint8Array([1, 2, 3]);
        },
        async release() {
          releases++;
        },
      };
    },
  };
  assert.deepEqual(await readPreviewBytes(reader, file), new Uint8Array([1, 2, 3]));
  assert.equal(releases, 1);
  const broken: FileReadPort = {
    async acquire() {
      return {
        file,
        async read() {
          return new Uint8Array(0);
        },
        async release() {
          releases++;
        },
      };
    },
  };
  await assert.rejects(readPreviewBytes(broken, file), /PREVIEW_INCOMPLETE/);
  assert.equal(releases, 2);
  await assert.rejects(
    readPreviewBytes(reader, { ...file, bytes: 17 * 1024 * 1024 }),
    /PREVIEW_TOO_LARGE/,
  );
  assert.equal(reads, 1);
  assert.equal(focalOffset(100, 50, 1, 2), 250);
});

test("archive unmounts explicit media; late acquisition still releases and cannot publish a new image URL", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    view = workspace.view(scope),
    late = deferred<Awaited<ReturnType<FileReadPort["acquire"]>>>();
  const row: Row = {
    id: "native-image",
    version: 1,
    kind: "tool",
    lifecycle: "completed",
    body: { kind: "unavailable", reason: "nativeOmitted" },
    native: { type: "imageView" },
  };
  f.feed.window().update({ rows: [row] });
  let acquired = 0,
    released = 0;
  const reader: FileReadPort = {
    acquire() {
      acquired++;
      return late.promise;
    },
  };
  let node!: ReactTestRenderer;
  await act(async () => {
    node = create(
      h(Chat, {
        view,
        actions: {},
        files: reader,
        media: () => [{ preview: { kind: "image" as const, file } }],
      }),
      { createNodeMock: (value) => (value.type === "span" ? {} : null) },
    );
  });
  assert.equal(acquired, 1);
  await act(async () => {
    f.feed
      .stateTopic()
      .publish({ ...f.feed.stateTopic().latest, phase: "archived", activity: "idle" });
  });
  assert.equal(node.root.findAllByType(FilePreview).length, 0);
  await act(async () => {
    late.resolve({
      file,
      async read() {
        return new Uint8Array([1, 2, 3]);
      },
      async release() {
        released++;
      },
    });
  });
  assert.equal(released, 1);
  assert.equal(node.root.findAllByType("img").length, 0);
  await act(async () => node.unmount());
  await workspace.settled();
  await workspace.close();
});

test("completed native plan invokes one explicit consumer Send through the retained original owner", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    view = workspace.view(scope),
    nativePlan = "A real completed native plan";
  f.feed.windows.set(
    runKey(runFor()),
    new HistoryWindow({ run: runFor(), attachment: "capture", stream: "root" }),
  );
  f.feed.window().update({
    rows: [
      {
        id: "plan",
        kind: "assistant",
        lifecycle: "completed",
        body: { kind: "complete", text: nativePlan, evidence: "native" },
        native: { type: "plan" },
      },
    ],
  });
  let invocations = 0;
  const actions: ChatActions = {
    implementPlan: {
      available: () => true,
      async invoke(row) {
        invocations++;
        const handle = await view.submit({
          id: "implement-this-occurrence",
          kind: "send",
          run: runFor(),
          payload: { text: row.body.kind === "complete" ? row.body.text : "" },
        });
        await handle.settled;
      },
    },
  };
  let node!: ReactTestRenderer;
  await act(async () => {
    node = create(h(Chat, { view, actions }));
  });
  await act(async () => {
    const click = button(node, "Implement plan").props.onClick;
    click();
    click();
  });
  assert.equal(invocations, 1);
  assert.equal(f.feed.dispatches.length, 1);
  assert.deepEqual(f.feed.dispatches[0]!.command.payload, { text: nativePlan });
  assert.equal(view.entry.getSnapshot().originals[0]!.receipt?.state, "succeeded");
  await act(async () => node.unmount());
  await workspace.settled();
  await workspace.close();
});

test("unavailable observations pause Send while explicit Stop retains its exact known generation", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    view = workspace.view(scope);
  const actions: ChatActions = {
    stop: (snapshot) => ({
      id: "exact-stop",
      kind: "stop",
      run: snapshot.state!.run,
      payload: { generation: snapshot.state!.run!.generation },
    }),
  };
  let node!: ReactTestRenderer;
  await act(async () => {
    node = create(h(Chat, { view, actions }));
  });
  await act(async () => {
    await view.entry.setDraft("keep this draft");
    await f.observations.offline();
  });
  assert.equal(button(node, "Send").props.disabled, true);
  assert.equal(button(node, "Stop").props.disabled, false);
  await act(async () => button(node, "Stop").props.onClick());
  assert.equal(f.feed.dispatches.length, 1);
  assert.deepEqual(f.feed.dispatches[0]!.command, {
    id: "exact-stop",
    kind: "stop",
    run: runFor(),
    payload: { generation: 1 },
  });
  assert.equal(view.entry.getSnapshot().draft, "keep this draft");
  await act(async () => node.unmount());
  await workspace.settled();
  await workspace.close();
});
