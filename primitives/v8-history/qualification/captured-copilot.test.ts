import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import type { CopilotScope, Json, Row } from "../src/contracts/types.js";
import { HistoryWorkspace } from "../src/client/index.js";
import { HistoryHub } from "../src/host/history-owner.js";
import { createCopilotCodec } from "../src/native/copilot/index.js";

// Public, reduced captures only: original prompts/instructions, inventories and diagnostic
// bodies are omitted. Each case pins its original scrubbed trace digest. No SDK/native port.
interface NativeEvent { id: string; type: string; data: Record<string, unknown> }
interface Captured {
  name: string;
  knownStart: boolean;
  expectedFinal: string | null;
  provenance: { rawTraceSha256: string; originalNotifications: number; retainedNotifications: number };
  events: NativeEvent[];
}
const fixture = JSON.parse(await readFile(new URL("../../qualification/fixtures/copilot-live-20261023.json", import.meta.url), "utf8")) as { cases: Captured[] };
const body = (row: Row): string => row.body.kind === "unavailable" ? "" : row.body.text;
const START = "V8_COPILOT_TERMINAL_OK", END = "V8_COPILOT_TERMINAL_DONE";
const occurrences = (value: string, marker: string): number => value.split(marker).length - 1;

for (const [index, captured] of fixture.cases.entries()) test(`captured real Copilot stream: ${captured.name}`, async () => {
  assert.match(captured.provenance.rawTraceSha256, /^[a-f0-9]{64}$/);
  assert.equal(captured.events.length, captured.provenance.retainedNotifications);
  const origin = { connection: "captured-proof", principal: "owner", host: "copilot-fixture", nativeSession: `case-${index}`, attachment: "owned-capture" };
  const scope: CopilotScope = { kind: "copilot", origin, agentId: null };
  // Default limits reproduce the original GAP_CAPACITY failure boundary (128 gaps).
  const hub = new HistoryHub(), codec = createCopilotCodec({ origin, capture: hub, knownStart: captured.knownStart });
  const workspace = new HistoryWorkspace({ connection: origin.connection, principal: origin.principal });
  const retained = workspace.session(scope); retained.setPinned(true);
  let left = retained.mount("left"), right = retained.mount("right"), stream = hub.watch(scope);
  let detached = false, partialSeen = false;
  let cursor: { generation: string; revision: number } | undefined;
  const consume = () => { for (const frame of stream.drain()) assert.notEqual(retained.client.apply(frame), "needsSnapshot"); };
  consume();
  try {
    for (const event of captured.events) {
      codec.observe(event);
      const tool: Row | undefined = hub.snapshot(scope).rows.find(row => row.kind === "tool");
      if (tool?.body.kind === "partial" && body(tool).includes(START)) {
        partialSeen = true;
        assert.equal(occurrences(body(tool), START), 1, "merged partial output must replace its prior snapshot");
      }
      if (!detached) {
        consume();
        assert.deepEqual(left.view.getSnapshot().rows, right.view.getSnapshot().rows);
      }
      // The successful excerpt tests native capture continuing with both consumers absent.
      if (captured.expectedFinal && event.type === "tool.execution_start") {
        const current = retained.client.current!;
        cursor = { generation: current.generation, revision: current.revision };
        left.release(); right.release(); await stream.return(); detached = true;
        assert.equal(retained.mountedReferences, 0); assert.equal(retained.observationReferences, 1);
      }
    }
    const snapshot = hub.snapshot(scope);
    assert.ok(partialSeen);
    assert.equal(codec.diagnostics().failed, false);
    assert.equal(codec.diagnostics().seenEvents, captured.events.length);
    const features = snapshot.coverage.gaps.map(gap => {
      assert.equal(gap.kind, "unsupported");
      const identity = JSON.parse(gap.id) as string[]; assert.deepEqual(identity.slice(0, 2), ["copilot", "unsupported"]); return identity[2];
    }).sort();
    assert.deepEqual(features, captured.expectedFinal ? ["model.messages_snapshot", "model.response"] : ["assistant.tool_call_delta", "sandbox.decision"]);
    if (!captured.expectedFinal) {
      assert.ok(captured.events.length > 128, "the recorded event burst exceeds the old per-delivery gap capacity");
      assert.notEqual(snapshot.activity.state, "idle", "a finished tool does not certify the unfinished root turn");
    }

    const tool = snapshot.rows.find(row => row.kind === "tool")!;
    assert.ok(tool);
    assert.deepEqual(tool.body, { kind: "complete", text: `${START}\n${END}\n<shellId: 0 completed with exit code 0>`, evidence: "nativeFullBody" });
    assert.equal(occurrences(body(tool), START), 1); assert.equal(occurrences(body(tool), END), 1);
    const start = captured.events.find(event => event.type === "tool.execution_start")!;
    assert.deepEqual(tool.native.arguments, start.data.arguments);
    const toolMessage = snapshot.rows.find(row => row.kind === "assistant" && row.native.toolRequests)!;
    const requests = toolMessage.native.toolRequests as readonly { readonly [key: string]: Json }[];
    assert.equal(requests[0]!.toolCallId, tool.native.toolCallId);
    assert.deepEqual(requests[0]!.arguments, tool.native.arguments);
    assert.deepEqual(toolMessage.body, { kind: "complete", text: "", evidence: "nativeFullBody" });
    const user = snapshot.rows.find(row => row.kind === "user")!;
    assert.equal(toolMessage.native.originatingMessageId, user.native.messageId);

    if (captured.expectedFinal) {
      assert.equal(snapshot.activity.state, "idle");
      const final = snapshot.rows.find(row => row.kind === "assistant" && body(row) === captured.expectedFinal)!;
      assert.ok(final); assert.equal(final.native.originatingMessageId, user.native.messageId);
      assert.equal(final.body.kind, "complete");
      assert.ok(!retained.client.current!.rows.some(row => body(row) === captured.expectedFinal));
      stream = hub.watch(scope, cursor); consume();
      left = retained.mount("left"); right = retained.mount("right");
      assert.deepEqual(left.view.getSnapshot().rows, right.view.getSnapshot().rows);
      assert.ok(left.view.getSnapshot().rows.some(row => body(row) === captured.expectedFinal));
    }
    assert.deepEqual(retained.client.current, snapshot);
    const revision = snapshot.revision;
    for (const event of captured.events) codec.observe(event);
    assert.equal(hub.snapshot(scope).revision, revision, "exact redelivery must not append or republish captured bytes");
    assert.equal(stream.drain().length, 0);
  } finally { left.release(); right.release(); await stream.return(); }
});
