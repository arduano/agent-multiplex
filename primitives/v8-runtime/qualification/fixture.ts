import { codexProtocol } from "../../v8-harness-codex/src/protocol.js";
import { copilotProtocol } from "../../v8-harness-copilot/src/protocol.js";
import type { Catalog, ControlCommand, Harness, NativeOutcome, NativeStart, Placement, RunRef, SessionScope } from "../../v8-session/src/contracts/types.js";
import type { OwnedAttachment, RuntimeEvent, RuntimeHalt, RuntimeIdentity, RuntimeObservation, RuntimeOwnershipPort } from "../src/contracts.js";

export const runtimeScope: SessionScope = { connection: "runtime-fixture", principal: "owner", host: "host", session: "root" };
export const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) { if (Date.now() >= deadline) throw new Error("Runtime fixture condition timed out"); await new Promise(done => setTimeout(done, 2)); }
}
/** Scripted trusted adapter only: no processes, SDKs, native calls or models. */
export class ScriptedRuntimeOwnership implements RuntimeOwnershipPort {
  get protocol() { return this.kind === "codex" ? codexProtocol : copilotProtocol; }
  readonly capabilities = { fullStop: true, createAndWait: true, reopen: true, commands: ["send", "answer", "codex.defaults", "codex.turn", "codex.interrupt", "copilot.model", "copilot.mode", "copilot.permissions", "copilot.abort"] as const };
  readonly opens: NativeStart[] = []; readonly inspections: RunRef[] = []; readonly calls: ControlCommand[] = [];
  stopCalls = 0; catalogCalls = 0;
  openGate: Promise<void> | undefined; stopGate: Promise<RuntimeHalt> | undefined;
  overrideOpen: OwnedAttachment | undefined; inspection: OwnedAttachment | RuntimeHalt | null | undefined;
  beforeReturn: ((attachment: OwnedAttachment, emit: (event: RuntimeEvent) => void) => void) | undefined;
  attachment: OwnedAttachment | undefined; emit: (event: RuntimeEvent) => void = () => {};
  readonly emissions: ((event: RuntimeEvent) => void)[] = [];
  constructor(readonly kind: Harness = "codex", readonly placement: Placement = "shared") {}
  owned(run: RunRef): OwnedAttachment {
    const identity: RuntimeIdentity = { run, attachment: `attachment-${run.generation}`, process: "owned-process-capability", containment: this.placement === "shared" ? "shared-owned-container" : `dedicated-${run.generation}`, placement: this.placement };
    return { identity, native: { run, selection: this.kind === "codex" ? { kind: "codex", model: "scripted-model", access: { approval: "on-request", sandbox: "danger-full-access" } } : { kind: "copilot", model: "scripted-model", providerId: "selected-provider", permissions: "manual" }, interactionsComplete: true, interactions: [], invoke: async command => { this.calls.push(command); return { status: "acknowledged" } satisfies NativeOutcome; } },
      observation: { controller: "connected", transport: "connected", leader: "present" },
      stopTree: async () => { this.stopCalls++; return this.stopGate ?? this.proof(identity); } };
  }
  proof(identity = this.attachment!.identity): RuntimeHalt {
    return { identity, proof: { run: identity.run, state: "stopped", scope: "nativeTree", noAutomaticContinuation: true }, boundary: this.placement === "shared" ? { kind: "shared", peersPreserved: true } : { kind: "dedicated", containmentRetired: true } };
  }
  async open(input: NativeStart, emit: (event: RuntimeEvent) => void): Promise<OwnedAttachment> {
    this.opens.push(input); this.emit = emit; this.emissions.push(emit);
    const owned = this.overrideOpen ?? this.owned({ scope: input.scope, generation: input.generation, nativeSession: input.nativeSession ?? "native-scripted-root" });
    this.attachment = owned; this.beforeReturn?.(owned, emit); await this.openGate; return owned;
  }
  async inspect(run: RunRef, emit: (event: RuntimeEvent) => void): Promise<OwnedAttachment | RuntimeHalt | null> {
    this.inspections.push(run); this.emit = emit; return this.inspection === undefined ? this.attachment ?? null : this.inspection;
  }
  async catalog(): Promise<Catalog> { this.catalogCalls++; return { available: true, choices: [{ model: "scripted-model", efforts: ["low"] }] }; }
  observe(observation: RuntimeObservation): void { this.emit({ type: "observation", identity: this.attachment!.identity, observation }); }
}
