import type { RunRef, SessionScope } from "../protocol/index.js";

export type Placement = "shared" | "dedicated";
export type OpeningRef = Readonly<{ scope: SessionScope; generation: number; operationId: string }>;
export type OpeningIdentity = Readonly<{
  attachment: string;
  process: string;
  containment: string;
  placement: Placement;
}>;
export type OpeningCapsule = Readonly<{ opening: OpeningRef; identity: OpeningIdentity }>;
export type OpeningStopProof = OpeningCapsule &
  Readonly<{
    state: "stopped";
    scope: "nativeTree";
    noAutomaticContinuation: true;
    acquisitionSealed: true;
  }>;
export type ParentStopProof = Readonly<{
  identity: OpeningIdentity;
  state: "stopped";
  scope: "nativeTree";
  noAutomaticContinuation: true;
  acquisitionSealed: true;
}>;
export type ParentCustody = Readonly<{
  identity: OpeningIdentity;
  inspect(identity: OpeningIdentity): Promise<ParentStopProof | null>;
}>;
export type NativeOpening = OpeningCapsule & Readonly<{ stop(): Promise<OpeningStopProof> }>;

/** A read helper owns a native process, but cannot continue an agent. Its one
 * capsule belongs in the same session journal before its launcher is admitted. */
export type ReaderCustody =
  | Readonly<{ state: "none" | "unconfirmed" }>
  | Readonly<{ state: "allocating"; run: RunRef; opening: OpeningRef }>
  | Readonly<{ state: "owned"; run: RunRef; capsule: OpeningCapsule }>;
export interface ReaderCustodyPort {
  read(): Promise<ReaderCustody>;
  begin(run: RunRef, opening: OpeningRef): Promise<void>;
  owned(run: RunRef, capsule: OpeningCapsule): Promise<void>;
  released(proof: OpeningStopProof): Promise<void>;
}

/** Native resource custody only. SessionHost still owns lifecycle and originals. */
export type NativeAllocationOptions = Readonly<{
  directory: string;
  binary: string;
  packageRoot: string;
  home: string;
  cwd: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
  reference: string;
  kind: "agent" | "reader";
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
  inspectOpening(
    capsule: OpeningCapsule,
    kind?: "agent" | "reader",
  ): Promise<NativeOpening | OpeningStopProof | null>;
}>;
