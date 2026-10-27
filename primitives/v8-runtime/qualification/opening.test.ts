import assert from "node:assert/strict";
import test from "node:test";
import type { NativeOpening, NativeStart, OpeningCapsule, OpeningStopProof } from "../../v8-session/src/contracts/types.js";
import type { OwnedAttachment, RuntimeEvent } from "../src/contracts.js";
import { RuntimeSupervisor } from "../src/supervisor.js";
import { ScriptedRuntimeOwnership, deferred, runtimeScope, until } from "./fixture.js";

test("late old opening inspection cannot free a newer pending opening or replace its captured Stop owner", async () => {
  const inspection = deferred<OpeningStopProof>(), entering = deferred<void>(), release = deferred<void>();
  let capsule: OpeningCapsule | undefined;
  class Ownership extends ScriptedRuntimeOwnership {
    constructor() { super("codex", "dedicated"); }
    override async open(input: NativeStart, emit: (event: RuntimeEvent) => void, onOwned?: (owner: OwnedAttachment) => Promise<void>, onOpening?: (owner: NativeOpening) => Promise<void>): Promise<OwnedAttachment> {
      if (input.generation === 2) { entering.resolve(); await release.promise; }
      const attachment = this.owned({ scope: input.scope, generation: input.generation, nativeSession: input.nativeSession ?? "actual-native" });
      const { run: _run, ...identity } = attachment.identity;
      const current = { opening: { scope: input.scope, generation: input.generation, operationId: input.operationId }, identity };
      capsule = current;
      await onOpening?.({ ...current, stop: async () => ({ ...current, state: "stopped", scope: "nativeTree", noAutomaticContinuation: true, acquisitionSealed: true }) });
      // Retain the fixture's ordinary exact native-tree Stop implementation.
      return super.open(input, emit);
    }
    inspectOpening = async (_capsule: OpeningCapsule) => inspection.promise;
  }
  const ownership = new Ownership(), runtime = new RuntimeSupervisor({ scope: runtimeScope, ownership });
  const input: NativeStart = { scope: runtimeScope, generation: 1, placement: "dedicated", operationId: "create", nativeSession: null, policy: { kind: "codex", provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } };
  const first = await runtime.start(input, () => {}); const old = capsule!;
  const reading = runtime.inspectOpening(old); await first.stop();
  const opening = runtime.start({ ...input, generation: 2, operationId: "resume", nativeSession: first.run.nativeSession }, () => {});
  await entering.promise;
  inspection.resolve({ ...old, state: "stopped", scope: "nativeTree", noAutomaticContinuation: true, acquisitionSealed: true });
  await assert.rejects(reading);
  await assert.rejects(runtime.start({ ...input, generation: 3, operationId: "competing", nativeSession: first.run.nativeSession }, () => {}), { code: "BUSY" });
  assert.equal(ownership.opens.length, 1);
  release.resolve(); const resumed = await opening; await until(() => ownership.opens.length === 2);
  assert.equal(resumed.run.generation, 2); await resumed.stop();
});
