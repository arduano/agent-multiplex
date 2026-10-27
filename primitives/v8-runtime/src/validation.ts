import { SessionError, sameRun, type Placement, type RunRef } from "../../v8-session/src/contracts/types.js";
import { canonical, copy } from "../../v8-session/src/contracts/validation.js";
import { validateRun, validateStopProof } from "../../v8-session/src/native/validation.js";
import type { RuntimeHalt, RuntimeIdentity, RuntimeObservation } from "./contracts.js";

export function requireThat(value: unknown, message = "Invalid runtime ownership evidence"): asserts value {
  if (!value) throw new SessionError("FENCED", message);
}
function keys(value: object, allowed: readonly string[]): void { requireThat(Object.keys(value).every(key => allowed.includes(key))); }
function token(value: unknown): void { requireThat(typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0")); }
export function identity(value: RuntimeIdentity, placement: Placement, expected?: RunRef): RuntimeIdentity {
  const fixed = copy(value); canonical(fixed, 8192);
  requireThat(fixed && typeof fixed === "object"); keys(fixed, ["run", "attachment", "process", "containment", "placement"]);
  const run = validateRun(fixed.run);
  for (const value of [fixed.attachment, fixed.process, fixed.containment]) token(value);
  requireThat(fixed.placement === placement && (!expected || sameRun(expected, run)));
  return copy({ ...fixed, run });
}
export function sameIdentity(a: RuntimeIdentity, b: RuntimeIdentity): boolean {
  return sameRun(a.run, b.run) && a.attachment === b.attachment && a.process === b.process && a.containment === b.containment && a.placement === b.placement;
}
export function observation(value: RuntimeObservation): RuntimeObservation {
  const fixed = copy(value); canonical(fixed, 4096);
  requireThat(fixed && typeof fixed === "object"); keys(fixed, ["controller", "transport", "leader"]);
  requireThat(["connected", "lost", "unknown"].includes(fixed.controller) && ["connected", "lost", "unknown"].includes(fixed.transport) && ["present", "exited", "unknown"].includes(fixed.leader));
  return fixed;
}
export function halt(value: RuntimeHalt, placement: Placement, expected: RunRef, owner?: RuntimeIdentity): RuntimeHalt {
  const fixed = copy(value); canonical(fixed, 16384);
  requireThat(fixed && typeof fixed === "object"); keys(fixed, ["identity", "proof", "boundary"]);
  const exact = identity(fixed.identity, placement, expected);
  requireThat(!owner || sameIdentity(owner, exact));
  const proof = validateStopProof(expected, fixed.proof);
  requireThat(fixed.boundary && typeof fixed.boundary === "object");
  if (placement === "shared") {
    keys(fixed.boundary, ["kind", "peersPreserved"]);
    requireThat(fixed.boundary.kind === "shared" && fixed.boundary.peersPreserved === true);
  } else {
    keys(fixed.boundary, ["kind", "containmentRetired"]);
    requireThat(fixed.boundary.kind === "dedicated" && fixed.boundary.containmentRetired === true);
  }
  return copy({ identity: exact, proof, boundary: fixed.boundary });
}
