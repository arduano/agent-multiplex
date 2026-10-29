import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RetainedWorkspace, type EntrySnapshot } from "../../src/client/index.js";
import {
  Chat,
  ChatMarkdown,
  FilePreview,
  HistoryRow,
  RequestEditor,
  Select,
  ThemeScope,
  safeLink,
} from "../../src/chat/index.js";
import type { FileReadPort, StoredFile } from "../../src/files/index.js";
import type { Row, Snapshot } from "../../src/history/index.js";
import type { Interaction, Prompt } from "../../src/interactions/index.js";
import { fixture, runFor, scope } from "../client/fixture.js";

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

test("actual Chat SSR is inert; safe Markdown never fetches private paths, remote images or raw HTML", () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    view = workspace.view(scope);
  let acquisitions = 0;
  const reader: FileReadPort = {
    async acquire() {
      acquisitions++;
      throw Error();
    },
  };
  const markup = renderToStaticMarkup(
    h(Chat, { view, actions: {}, files: reader, title: "Embedded chat" }),
  );
  assert.match(markup, /Embedded chat/);
  assert.match(markup, /History has not been observed/);
  renderToStaticMarkup(h(FilePreview, { descriptor: { kind: "image", file }, reader }));
  assert.equal(acquisitions, 0);
  assert.equal(
    f.observations.opened + f.persistence.saves + f.feed.dispatches.length + f.feed.baselineReads,
    0,
  );
  const markdown = renderToStaticMarkup(
    h(ChatMarkdown, {
      text: "<script>secret()</script>\n\n![remote](https://example.org/a.png) [private](/tmp/private) [bad](javascript:alert) [web](https://example.org/)\n\n<proposed_plan>\n- a plan\n</proposed_plan>",
    }),
  );
  assert.doesNotMatch(markdown, /<script|<img|href="\/tmp|javascript:|Implement plan/);
  assert.match(markdown, /external image/);
  assert.match(markdown, /Proposed plan/);
  assert.equal(safeLink("file:///etc/passwd"), undefined);
  assert.equal(safeLink("https://user:pass@example.org"), undefined);
  assert.equal(safeLink("//example.org"), undefined);
});

function snapshotFor(row: Row): EntrySnapshot {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    empty = workspace.entry(scope).getSnapshot(),
    run = runFor();
  const current: Snapshot = {
    scope: { run, attachment: "capture", stream: run.nativeSession },
    generation: 2,
    revision: 1,
    readEpoch: 1,
    residencyOmitted: false,
    rows: [row],
    olderEdge: { state: "unknown", reason: "Prior boundary unestablished" },
    gaps: [],
    activity: { state: "working", turnId: "turn" },
  };
  return {
    ...empty,
    freshness: "current",
    historyFreshness: "current",
    state: { scope, run, phase: "running", activity: "working", selection: {} },
    history: {
      current,
      rows: [row],
      origins: { [row.id]: { scope: current.scope, generation: current.generation } },
      residencyOmitted: false,
    },
  };
}
test("compaction, errors and partials preserve provenance; only complete exact root plan receives consumer action", () => {
  const row: Row = {
      id: "row",
      version: 1,
      kind: "notice",
      lifecycle: "running",
      body: { kind: "unavailable", reason: "nativeOmitted" },
      native: { type: "contextCompaction", turnId: "turn" },
    },
    snapshot = snapshotFor(row),
    actions = {};
  const render = (value = row, state = snapshot) =>
    renderToStaticMarkup(h(HistoryRow, { row: value, snapshot: state, props: { actions } }));
  assert.match(render(), /Compacting context…/);
  assert.doesNotMatch(render(), /text not captured/);
  assert.match(render({ ...row, lifecycle: "completed" }), /Last observed/);
  assert.doesNotMatch(render({ ...row, lifecycle: "completed" }), /mpx-spinner/);
  assert.match(
    render({ ...row, lifecycle: "completed", native: { ...row.native, completed: true } }),
    /Context compacted/,
  );
  assert.doesNotMatch(render(row, { ...snapshot, freshness: "unavailable" }), /mpx-spinner/);
  const error: Row = {
    ...row,
    lifecycle: "failed",
    body: { kind: "complete", text: "Native failure", evidence: "native" },
    native: { type: "error" },
  };
  assert.match(render(error), /Agent error.*Native failure/);
  const partial: Row = {
    ...row,
    kind: "tool",
    body: { kind: "partial", text: "", missing: ["prefix", "final"] },
    native: { type: "commandExecution" },
  };
  const output = render(partial);
  assert.match(output, /Tool output not captured/);
  assert.match(output, /prefix, final/);
  assert.doesNotMatch(output, /<pre/);
  const plan: Row = {
      ...row,
      kind: "assistant",
      lifecycle: "completed",
      body: { kind: "complete", text: "Native full plan", evidence: "native" },
      native: { type: "plan" },
    },
    policy = { available: () => true, async invoke() {} };
  const planHtml = (value = plan, state = snapshotFor(plan)) =>
    renderToStaticMarkup(
      h(HistoryRow, { row: value, snapshot: state, props: { actions: { implementPlan: policy } } }),
    );
  assert.match(planHtml(), /Implement plan/);
  assert.doesNotMatch(
    planHtml({ ...plan, body: { kind: "partial", text: "Excerpt", missing: ["truncated"] } }),
    /Implement plan/,
  );
  assert.doesNotMatch(
    planHtml(plan, { ...snapshotFor(plan), historyFreshness: "unavailable" }),
    /Implement plan/,
  );
  const child = snapshotFor(plan);
  assert.doesNotMatch(
    planHtml(plan, {
      ...child,
      history: {
        ...child.history,
        current: {
          ...child.history.current!,
          scope: { ...child.history.current!.scope, stream: "child" },
        },
      },
    }),
    /Implement plan/,
  );
});

test("all nine forms render explicit typed controls without visible native selects", () => {
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
  for (const prompt of prompts) {
    const markup = renderToStaticMarkup(
      h(RequestEditor, { interaction: interaction(prompt), actions: { async respond() {} } }),
    );
    assert.ok(markup.includes("button"));
    assert.doesNotMatch(markup, /<select(?! aria-hidden="true")|<option/);
  }
});

test("empty Select domain value stays controlled without a visible native popup", () => {
  const html = renderToStaticMarkup(
    h(
      ThemeScope,
      null,
      h(Select, {
        value: "",
        onValueChange() {
          throw Error("render is inert");
        },
        options: [
          { value: "", label: "Keep current" },
          { value: "value:", label: "Other" },
        ],
      }),
    ),
  );
  assert.match(html, /role="combobox"/);
  assert.match(html, /data-value=""/);
  assert.match(html, /Keep current/);
  assert.doesNotMatch(html, /<select(?! aria-hidden="true")|role="option"/);
});
