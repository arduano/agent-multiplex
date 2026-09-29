import { describe, expect, it } from "vitest";
import {
  commandObservationView,
  initialLifecycle,
  LIFECYCLE_VERSION,
  newCommandId,
  newRuntimeEpoch,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  reduceLifecycle,
  type CommandRecord,
  type LifecycleFact,
  type LifecycleState,
} from "../src/index.js";

const timestamp = "2026-09-23T00:00:00.000Z";

function step(state: LifecycleState, fact: LifecycleFact): LifecycleState {
  return reduceLifecycle(state, {
    version: LIFECYCLE_VERSION,
    fence: state.fence,
    sequence: state.nextSequence,
    fact,
  });
}

describe("command observation continuation", () => {
  it("enriches an accepted receipt with a later exact native ID without downgrading admission", () => {
    const commandId = newCommandId(), sessionId = newSessionId(), runtimeNodeId = newRuntimeNodeId();
    const receipt: CommandRecord = { commandId, payloadHash: "late-native-id", sessionId, runtimeNodeId, state: "succeeded",
      request: { request: { harness: "codex", command: { type: "steer", input: "fixture" } } }, createdAt: timestamp, updatedAt: timestamp };
    let state = initialLifecycle({ sessionId, runtimeNodeId, runtimeNodeBootId: newRuntimeNodeBootId(), runtimeEpoch: newRuntimeEpoch(), bindingRevision: 1 });
    state = step(state, { type: "commandPrepared", commandId, payloadHash: "late-native-id", kind: "steer" });
    state = step(state, { type: "commandReceipt", commandId, payloadHash: "late-native-id", admission: "accepted" });
    state = step(state, { type: "messageConsumed", owner: "root", messageId: "native-late" });
    state = step(state, { type: "commandReceipt", commandId, payloadHash: "late-native-id", admission: "accepted", messageId: "native-late" });
    expect(commandObservationView(receipt, state)).toMatchObject({ delivery: "consumed", continuation: "complete" });
    expect(() => step(state, { type: "commandReceipt", commandId, payloadHash: "late-native-id", admission: "accepted", messageId: "another-id" })).toThrow("identity conflict");
  });

  it.each(["send", "steer"] as const)("ends automatic delivery observation when a successful %s has no exact native message ID", (kind) => {
    const commandId = newCommandId();
    const sessionId = newSessionId();
    const runtimeNodeId = newRuntimeNodeId();
    const payloadHash = "same-payload";
    const receipt: CommandRecord = {
      commandId,
      payloadHash,
      sessionId,
      runtimeNodeId,
      state: "succeeded",
      request: { request: { harness: "copilot", command: { type: kind, prompt: "hello" } } },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    let state = initialLifecycle({ sessionId, runtimeNodeId, runtimeNodeBootId: newRuntimeNodeBootId(),
      runtimeEpoch: newRuntimeEpoch(), bindingRevision: 1 });
    state = step(state, { type: "commandPrepared", commandId, payloadHash, kind });
    state = step(state, { type: "commandReceipt", commandId, payloadHash, admission: "accepted" });

    expect(commandObservationView(receipt)).toMatchObject({ delivery: "accepted", continuation: "complete" });
    expect(commandObservationView(receipt, state)).toMatchObject({ delivery: "accepted", continuation: "complete" });
    state = step(state, { type: "messageDisplayed", owner: "root", messageId: "unrelated" });
    expect(commandObservationView(receipt, state)).toMatchObject({ delivery: "accepted", continuation: "complete" });

    let exact = initialLifecycle(state.fence);
    exact = step(exact, { type: "commandPrepared", commandId, payloadHash, kind });
    exact = step(exact, { type: "commandReceipt", commandId, payloadHash, admission: "dispatched" });
    exact = step(exact, { type: "messageDisplayed", owner: "root", messageId: "exact" });
    exact = step(exact, { type: "commandReceipt", commandId, payloadHash, admission: "accepted", messageId: "exact" });
    expect(commandObservationView(receipt, exact)).toMatchObject({ delivery: "displayed", continuation: "observeDelivery" });
    exact = step(exact, { type: "messageConsumed", owner: "root", messageId: "exact" });
    expect(commandObservationView(receipt, exact)).toMatchObject({ delivery: "consumed", continuation: "complete" });
  });
});
