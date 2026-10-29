import { scopeKey } from "../protocol/index.js";
import type {
  OpeningCapsule,
  OpeningStopProof,
  OpeningIdentity,
  ParentStopProof,
} from "./contracts.js";
import { RuntimeError } from "./validation.js";
import { canonical, copy, id, scope } from "./validation.js";

/** Called only at the trusted runtime boundary; no browser accepts these proofs. */
export function openingCapsule(value: OpeningCapsule): OpeningCapsule {
  const fixed = copy(value);
  canonical(fixed, 8192);
  if (
    !fixed ||
    typeof fixed !== "object" ||
    Object.keys(fixed).some((key) => !["opening", "identity"].includes(key))
  )
    throw new RuntimeError("FENCED");
  const ref = fixed.opening,
    owner = fixed.identity;
  if (
    !ref ||
    !owner ||
    Object.keys(ref).some((key) => !["scope", "generation", "operationId"].includes(key)) ||
    Object.keys(owner).some(
      (key) => !["attachment", "process", "containment", "placement"].includes(key),
    )
  )
    throw new RuntimeError("FENCED");
  scope(ref.scope);
  id(ref.operationId);
  if (
    !Number.isSafeInteger(ref.generation) ||
    ref.generation < 1 ||
    !["shared", "dedicated"].includes(owner.placement)
  )
    throw new RuntimeError("FENCED");
  for (const token of [owner.attachment, owner.process, owner.containment])
    if (typeof token !== "string" || !token.length || token.length > 512 || token.includes("\0"))
      throw new RuntimeError("FENCED");
  return fixed;
}
export function sameOpening(a: OpeningCapsule, b: OpeningCapsule): boolean {
  return (
    scopeKey(a.opening.scope) === scopeKey(b.opening.scope) &&
    a.opening.generation === b.opening.generation &&
    a.opening.operationId === b.opening.operationId &&
    canonical(a.identity) === canonical(b.identity)
  );
}
export function openingProof(expected: OpeningCapsule, value: OpeningStopProof): OpeningStopProof {
  const fixed = copy(value);
  canonical(fixed, 8192);
  if (
    Object.keys(fixed).some(
      (key) =>
        ![
          "opening",
          "identity",
          "state",
          "scope",
          "noAutomaticContinuation",
          "acquisitionSealed",
        ].includes(key),
    )
  )
    throw new RuntimeError("FENCED");
  const capsule = openingCapsule({ opening: fixed.opening, identity: fixed.identity });
  if (
    !sameOpening(expected, capsule) ||
    fixed.state !== "stopped" ||
    fixed.scope !== "nativeTree" ||
    fixed.noAutomaticContinuation !== true ||
    fixed.acquisitionSealed !== true
  )
    throw new RuntimeError("FENCED");
  return fixed;
}

/** Opaque trusted parent provenance, never a process/PID lookup from a viewer. */
export function parentIdentity(value: OpeningIdentity): OpeningIdentity {
  const owner = copy(value);
  canonical(owner, 4096);
  if (
    !owner ||
    typeof owner !== "object" ||
    Object.keys(owner).sort().join(",") !== "attachment,containment,placement,process" ||
    !["shared", "dedicated"].includes(owner.placement)
  )
    throw new RuntimeError("FENCED");
  for (const token of [owner.attachment, owner.process, owner.containment])
    if (typeof token !== "string" || !token.length || token.length > 512 || token.includes("\0"))
      throw new RuntimeError("FENCED");
  return owner;
}
export function parentProof(expected: OpeningIdentity, value: ParentStopProof): ParentStopProof {
  const fixed = copy(value);
  canonical(fixed, 8192);
  if (
    !fixed ||
    Object.keys(fixed).sort().join(",") !==
      "acquisitionSealed,identity,noAutomaticContinuation,scope,state" ||
    canonical(parentIdentity(fixed.identity)) !== canonical(parentIdentity(expected)) ||
    fixed.state !== "stopped" ||
    fixed.scope !== "nativeTree" ||
    fixed.noAutomaticContinuation !== true ||
    fixed.acquisitionSealed !== true
  )
    throw new RuntimeError("FENCED");
  return fixed;
}
