import test from "node:test";
import assert from "node:assert/strict";
import type { RunRef } from "../src/contracts/types.js";
import { SelectionOwner } from '../../v8-harness-defaults/src/selection.js';

const run: RunRef = { scope: { connection: "test", principal: "owner", host: "host", session: "root" }, generation: 1, nativeSession: "native-root" };

test("newer native selection fences older paired read while ACK settles independently without changing observed selection", () => {
  const owner = new SelectionOwner("copilot", run, { kind: "copilot", model: "A", providerId: "one", effort: "low" });
  const old = owner.fence(); owner.observe({ kind: "copilot", model: "B", providerId: "two", effort: "max" });
  assert.equal(owner.acceptRead(old, { kind: "copilot", model: "A", effort: "low" }), false);
  const snapshot = owner.snapshot(); owner.acknowledge({ status: "applied", detail: { requestedModel: "A" } });
  assert.deepEqual(owner.snapshot(), snapshot);
  const beforeChange = owner.fence(); owner.beginChange(); assert.equal(owner.acceptRead(beforeChange, { kind: "copilot", model: "A" }), false);
});

test("paired observation preserves unknown effort and catalog disappearance cannot erase current native model", () => {
  const owner = new SelectionOwner("codex", run, { kind: "codex", model: "native-extension", effort: "ultra" });
  owner.setCatalog({ available: false, choices: [] }); assert.equal(owner.snapshot().selection.model, "native-extension");
  owner.observe({ kind: "codex", model: "new" }); assert.ok(!("effort" in owner.snapshot().selection));
  assert.equal(owner.snapshot().nativePreferences.effort, "ultra");
  owner.observe({ kind: "codex", model: "new", effort: null }); assert.equal(owner.snapshot().selection.effort, null);
});

test("Copilot .19 provider-only model change, omission and deselection retain independent preference without stale effective selection", () => {
  const owner = new SelectionOwner("copilot", run, { kind: "copilot", model: "same", providerId: "a", effort: "high", mode: "plan" });
  owner.copilotEvent({ type: "session.model_change", data: { newModel: "same", previousModel: "same", previousProviderId: "a", providerId: "b" } });
  assert.deepEqual(owner.snapshot().selection, { kind: "copilot", model: "same", providerId: "b", mode: "plan" });
  assert.equal(owner.snapshot().nativePreferences.effort, "high");
  owner.copilotEvent({ type: "session.model_change", data: { newModel: "next", providerId: "b", reasoningEffort: null } });
  assert.equal(owner.snapshot().selection.effort, null); assert.equal(owner.snapshot().nativePreferences.effort, null);
  owner.copilotEvent({ type: "session.model_deselected", data: { previousModel: "next", reason: "provider_withdrawn" } });
  assert.deepEqual(owner.snapshot().selection, { kind: "copilot", mode: "plan" }); assert.equal(owner.snapshot().nativePreferences.effort, null);
});

test("child and private/unknown native events cannot overwrite root selection or execute ignored getters", () => {
  const owner = new SelectionOwner("copilot", run, { kind: "copilot", model: "root" }); let read = false;
  assert.equal(owner.copilotEvent({ type: "session.model_change", agentId: "child", get data() { read = true; throw new Error("child body"); } }), null);
  assert.equal(owner.copilotEvent({ type: "system.message", get data() { read = true; throw new Error("private"); } }), null);
  assert.equal(read, false); assert.equal(owner.snapshot().selection.model, "root");
  assert.equal(owner.copilotEvent({ type: "session.model_change", data: { parentToolCallId: "child-tool", newModel: "child" } }), null);
  owner.copilotEvent({ type: "session.permissions_changed", data: { mode: "assisted" } }); assert.equal(owner.snapshot().selection.permissions, "assisted");
});

test("Codex native settings preserve coherent mode/model/instructions and outside-vocabulary policy becomes unknown", () => {
  const owner = new SelectionOwner("codex", run, { kind: "codex", model: "old", access: { approval: "on-request", sandbox: "danger-full-access" } });
  const child = { method: "thread/settings/updated", params: { threadId: "child", get threadSettings() { throw new Error("unowned child"); } } };
  assert.equal(owner.codexEvent(child), null);
  owner.codexEvent({ method: "thread/settings/updated", params: { threadId: run.nativeSession, threadSettings: { model: "m", effort: "high", collaborationMode: { mode: "plan", settings: { model: "m", reasoning_effort: "high", developer_instructions: "custom" } }, approvalPolicy: "on-request", sandboxPolicy: { type: "dangerFullAccess" }, activePermissionProfile: null } } });
  assert.deepEqual(owner.snapshot().selection.collaboration, { mode: "plan", model: "m", effort: "high", instructions: "custom" });
  assert.deepEqual(owner.snapshot().selection.access, { approval: "on-request", sandbox: "danger-full-access" });
  owner.codexEvent({ method: "thread/settings/updated", params: { threadId: run.nativeSession, threadSettings: { model: "m", approvalPolicy: { granular: { mcp_elicitations: true } }, sandboxPolicy: { type: "externalSandbox", networkAccess: "enabled" } } } });
  assert.ok(!("access" in owner.snapshot().selection));
});

test("reattachment invalidates previous read token and cannot carry foreign session native preferences", () => {
  const owner = new SelectionOwner("copilot", run, { kind: "copilot", model: "m", effort: "high" }), token = owner.fence();
  owner.rebind({ ...run, generation: 2 }, { kind: "copilot", model: "resumed" }); assert.equal(owner.acceptRead(token, { kind: "copilot", model: "stale" }), false);
  assert.equal(owner.snapshot().nativePreferences.effort, "high");
  owner.rebind({ ...run, scope: { ...run.scope, session: "foreign" }, nativeSession: "other", generation: 3 }, { kind: "copilot" });
  assert.deepEqual(owner.snapshot().nativePreferences, {});
});
