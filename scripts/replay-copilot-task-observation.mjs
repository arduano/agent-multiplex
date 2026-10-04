// Offline replay only: reads retained receipts, never opens an SDK or sends work.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  initialLifecycle, lifecycleProjection, LIFECYCLE_VERSION, reduceLifecycle,
} from "@arduano/agent-multiplex-protocol";
import { copilotLifecycleFacts } from "../packages/adapter-copilot/dist/lifecycle.js";

const [streamPath, snapshotPath] = process.argv.slice(2);
assert.ok(streamPath && snapshotPath, "Usage: node scripts/replay-copilot-task-observation.mjs STREAM.ndjson SNAPSHOT.json");
const streamBytes = readFileSync(streamPath), snapshotBytes = readFileSync(snapshotPath);
assert.ok(streamBytes.length <= 16 * 1024 * 1024 && snapshotBytes.length <= 1024 * 1024, "Receipt bounds exceeded");
const rows = streamBytes.toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
const snapshot = JSON.parse(snapshotBytes);
assert.equal(snapshot.harness, "copilot");
assert.equal(snapshot.runtimeStatus, "idle");
assert.equal(snapshot.lifecycle.status, "unknown");
assert.equal(snapshot.lifecycle.health.state, "recovering");
assert.ok(snapshot.lifecycle.health.issues.some(issue => issue.scope === "tasks" && issue.code === "observationRetrying"));
assert.ok(!rows.some(row => ["nativeGap", "streamGap", "streamReset"].includes(row.kind)), "Replay requires an uninterrupted retained stream");
const native = rows.filter(row => row.kind === "native" && row.sessionId === snapshot.sessionId);
assert.ok(native.length > 0);
assert.ok(native.every(row => row.runtimeEpoch === snapshot.runtimeEpoch));
assert.ok(native.every((row, index) => !index || row.sequence === native[index - 1].sequence + 1), "Native sequence is not continuous");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const step = (state, fact) => reduceLifecycle(state, {
  version: LIFECYCLE_VERSION, fence: state.fence, sequence: state.nextSequence, fact,
});
let state = initialLifecycle({
  sessionId: snapshot.sessionId, runtimeNodeId: snapshot.runtimeNodeId,
  runtimeNodeBootId: "00000000-0000-7000-8000-000000000001",
  runtimeEpoch: snapshot.runtimeEpoch, bindingRevision: snapshot.bindingRevision,
});
// Fresh disposable creation observed callbacks from the beginning. Native task
// and queue payloads are absent from these receipts; empty successful views are
// controlled inputs, never a claim about an unretained native response.
state = step(state, { type: "childrenHydrated", items: [], complete: true });
state = step(state, { type: "interactionsHydrated", items: [], complete: true });
state = step(state, { type: "tasksObserved", revision: 0, items: [] });
state = step(state, { type: "queueObserved", revision: 0, items: [], unidentifiedSteering: 0, inFlightSteering: 0 });
let starts = 0, completions = 0, invalidations = 0, lastInvalidation = -1, lastIdle = -1;
for (const [index, row] of native.entries()) {
  const event = row.payload?.json;
  assert.equal(event?.type, row.nativeType);
  if (row.nativeType === "subagent.started") starts++;
  if (row.nativeType === "subagent.completed") completions++;
  const facts = copilotLifecycleFacts(row.nativeType, event);
  for (const fact of facts) {
    state = step(state, fact);
    if (fact.type === "tasksInvalidated") { invalidations++; lastInvalidation = index; }
    if (fact.type === "rootIdle") lastIdle = index;
  }
}
assert.equal(starts, 2); assert.equal(completions, 2);
assert.ok(lastIdle > lastInvalidation && lastInvalidation >= 0);
assert.deepEqual(state.root, { phase: "idle", cycle: state.root.cycle, outcome: "finished" });
assert.ok(state.children.items.every(child => ["completed", "settled"].includes(child.state)));
// Isolate task observation under a known empty queue. Current-revision failed
// observation is established by the retained public issue; its payload and
// precise failure count were not retained and are deliberately not invented.
state = step(state, { type: "queueObserved", revision: state.queue.revision, items: [], unidentifiedSteering: 0, inFlightSteering: 0 });
state = step(state, { type: "observationFailed", view: "tasks", revision: state.tasks.revision, failures: 1, stalled: false });
assert.equal(lifecycleProjection(state).view.status, "unknown");
assert.deepEqual(lifecycleProjection(state).view.health.issues.map(({ scope, code }) => ({ scope, code })),
  [{ scope: "tasks", code: "observationRetrying" }]);
const failed = state;
const terminalTasks = ["controlled-task-1", "controlled-task-2"].map(id => ({ id, kind: "agent", status: "completed" }));
const observed = step(failed, { type: "tasksObserved", revision: failed.tasks.revision, items: terminalTasks });
assert.equal(lifecycleProjection(observed).view.status, "finished");
assert.equal(lifecycleProjection(observed).view.health.state, "healthy");
const stale = step(failed, { type: "tasksObserved", revision: failed.tasks.revision - 1, items: terminalTasks });
assert.equal(lifecycleProjection(stale).view.status, "unknown");
assert.equal(stale.tasks.observation.state, "retrying");
const waitingTask = step(failed, { type: "tasksObserved", revision: failed.tasks.revision,
  items: [{ id: "controlled-waiting-task", kind: "agent", status: "idle" }] });
assert.equal(lifecycleProjection(waitingTask).view.status, "unknown");
const pendingInput = step(observed, { type: "interactionOpened",
  interaction: { id: "controlled-input", owner: "root", kind: "userInput" } });
assert.equal(lifecycleProjection(pendingInput).view.status, "waitingForInput");
const partialInput = { ...observed, interactions: { completeness: "partial", items: [] } };
assert.equal(lifecycleProjection(partialInput).view.status, "unknown");
console.log(JSON.stringify({ result: "passed", streamSha256: digest(streamBytes), snapshotSha256: digest(snapshotBytes),
  nativeEvents: native.length, childStarts: starts, childCompletions: completions, taskInvalidations: invalidations,
  taskChangesAfterRootIdle: 0, failedObservationStatus: "unknown", controlledTerminalObservationStatus: "finished",
  staleObservationStatus: "unknown", waitingTaskStatus: "unknown", pendingInputStatus: "waitingForInput", partialInputStatus: "unknown",
  modelCalls: 0, sdkAttachments: 0, liveActions: 0,
  limits: "Replays retained native ordering and public task observation failure. Queue emptiness and terminal task payloads are controlled inputs; rejected native task bytes and the precise rejection cause are absent." }));
