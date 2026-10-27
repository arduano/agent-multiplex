import type { NativeOpening, OpeningCapsule, OpeningIdentity, OpeningRef, OpeningStopProof, ParentCustody } from "../../../v8-session/src/contracts/types.js";

/** Native resource custody only. SessionHost still owns lifecycle and originals. */
export type NativeAllocationOptions = Readonly<{
  directory: string; binary: string; packageRoot: string; home: string; cwd: string;
  args: readonly string[]; environment: Readonly<Record<string, string>>;
  reference: string; kind: "agent" | "reader";
}>;
export interface NativeAllocation {
  readonly identity: OpeningIdentity | null;
  readonly sealed: boolean;
  prepare(): Promise<Readonly<{ launcher: string; identity: OpeningIdentity }>>;
  opening(opening: OpeningRef): Promise<NativeOpening>;
  assertLaunchable(): void;
  inspect(): Promise<"created" | "running" | "gone">;
  stop(): Promise<OpeningIdentity>;
}
export type NativeAllocationBackend = Readonly<{
  parentCustody?: ParentCustody;
  allocate(options: NativeAllocationOptions): NativeAllocation;
  /** Read-only exact capsule inspection; never attach, launch or Resume. */
  inspectOpening(capsule: OpeningCapsule, kind?: "agent" | "reader"): Promise<NativeOpening | OpeningStopProof | null>;
}>;
