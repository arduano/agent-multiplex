import type { NativeProtocol } from "../../v8-session/src/contracts/native-protocol.js";
import type { Capabilities, Catalog, Harness, NativeEvent, NativeRun, NativeStart, NativeOpening, OpeningCapsule, OpeningStopProof, ParentCustody, Placement, RunRef, SessionScope, StopProof } from "../../v8-session/src/contracts/types.js";

/** Opaque capabilities captured by the trusted adapter, never a caller-supplied PID. */
export type RuntimeIdentity = Readonly<{
  run: RunRef; attachment: string; process: string; containment: string; placement: Placement;
}>;
/** These are independent observations, not a second execution/lifecycle state. */
export type RuntimeObservation = Readonly<{
  controller: "connected" | "lost" | "unknown";
  transport: "connected" | "lost" | "unknown";
  leader: "present" | "exited" | "unknown";
}>;
/** Supplied only after native root/tools/children/queued continuations are halted.
 * A process leader's exit or controller disconnect cannot construct this proof. */
export type RuntimeHalt = Readonly<{
  identity: RuntimeIdentity; proof: StopProof;
  boundary: Readonly<{ kind: "shared"; peersPreserved: true }> |
    Readonly<{ kind: "dedicated"; containmentRetired: true }>;
}>;
export type RuntimeEvent = Readonly<{ type: "native"; identity: RuntimeIdentity; event: Exclude<NativeEvent, { type: "stopped" }> }> |
  Readonly<{ type: "observation"; identity: RuntimeIdentity; observation: RuntimeObservation }> |
  Readonly<{ type: "halt"; halt: RuntimeHalt }>;
export type OwnedAttachment = Readonly<{
  identity: RuntimeIdentity; native: Omit<NativeRun, "stop">; observation: RuntimeObservation;
  /** One exact tree operation. Never a group-wide fallback for shared placement. */
  stopTree(): Promise<RuntimeHalt>;
}>;
/** Trusted static adapter seam, not a dynamic host registry or process launcher.
 * Inspection must use retained ownership/read-only native evidence: no attach,
 * start, resume, queued continuation, mutation replay or provider substitution. */
export interface RuntimeOwnershipPort {
  readonly protocol: NativeProtocol;
  readonly kind: Harness; readonly placement: Placement; readonly capabilities: Capabilities;
  readonly parentCustody?: ParentCustody | undefined;
  open(input: NativeStart, emit: (event: RuntimeEvent) => void, onOwned?: (attachment: OwnedAttachment) => Promise<void>, onOpening?: (owner: NativeOpening) => Promise<void>): Promise<OwnedAttachment>;
  inspect(run: RunRef, emit: (event: RuntimeEvent) => void): Promise<OwnedAttachment | RuntimeHalt | null>;
  inspectOpening?(capsule: OpeningCapsule): Promise<NativeOpening | OpeningStopProof | null>;
  catalog(): Promise<Catalog>;
}
export type RuntimeSnapshot = Readonly<{
  scope: SessionScope; identity: RuntimeIdentity | null; observation: RuntimeObservation;
  issue?: "ownershipUnconfirmed" | "invalidEvidence";
}>;
