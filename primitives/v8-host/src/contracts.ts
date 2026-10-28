import type { NativeProtocol } from "../../v8-session/src/contracts/native-protocol.js";
import type { Scope as HistoryScope, CapturePort, NativeCodec, CaptureDiagnostic } from "../../v8-history/src/contracts/types.js";
import type { AcquisitionPort } from "../../v8-history/src/acquisition/types.js";
import type { AcquisitionLimits } from "../../v8-history/src/acquisition/owner.js";
import type { NativeMediaHandler } from "../../v8-history/src/contracts/media.js";
import type { NativeMcpReadPort } from "../../v8-mcp/src/contracts.js";
import type { InteractionOwner } from "../../v8-interactions/src/owner.js";
import type { Capabilities, Catalog, NativeRead, NativeReadResult, McpLoginLink, Activity, NativeStart, NativeOpening, OpeningCapsule, OpeningStopProof, ParentCustody, ReaderCustodyPort, RunRef, Selection } from "../../v8-session/src/contracts/types.js";
import type { RuntimeHalt, RuntimeIdentity, RuntimeOwnershipPort } from "../../v8-runtime/src/contracts.js";
import type { UpdateReadiness } from "../../v8-plugins/src/contracts.js";

/** Finite native metadata reads share one Host-owned custody boundary. A
 * failed helper retirement remains visible until explicit retirement succeeds. */
export interface HostModelCatalog {
  read(): Promise<Catalog>;
  retire(): Promise<void>;
  readiness(): UpdateReadiness;
  close(): Promise<void>;
}

export type HostBinding = Readonly<{ run: RunRef; history: HistoryScope }>;
/** Trusted read-only native binding. Resolving never activates/resumes or reads
 * history. Actual drivers supply stable port.context per attachment/read lease;
 * legacy context-less ports cannot qualify same-run reader replacement. */
export type HostHistory = Readonly<{
  port(run: RunRef, scope: HistoryScope, media?: NativeMediaHandler): AcquisitionPort;
  /** Explicit stopped-history exception, admitted by the Host's existing read
   * coordinator. Preparing a port never creates/resumes a native conversation. */
  prepare?(run: RunRef, scope: HistoryScope, custody?: ReaderCustodyPort): Promise<void>;
  /** Releases only the optional sessionless reader, never the native agent. */
  release?(custody?: ReaderCustodyPort): Promise<void>;
  /** Explicit cold child selection only. Metadata proof grants read scope, never control. */
  authorize?(run: RunRef, scope: HistoryScope, assertCurrent: () => void): Promise<void>;
  /** Trusted native metadata only. Never activates a native agent or creates a
   * reader; the existing Host read owner bounds and fences the request. */
  pathContext?(run: RunRef, scope: HistoryScope, assertCurrent: () => void): Promise<Readonly<{ cwd: string; dialect: "posix" | "win32" }>>;
  limits?: AcquisitionLimits;
}>;
export type ControllerBinding = Readonly<{ run: RunRef; identity: RuntimeIdentity; selection: Selection; fresh: boolean }>;
export type NativeCapture = Readonly<{ kind: "binding"; binding: ControllerBinding }> |
  Readonly<{ kind: "mcpChanged"; run: RunRef }> |
  /** Transcript/metadata loss is not evidence of a lost reverse callback. */
  Readonly<{ kind: "historyGap"; run: RunRef; diagnostic?: CaptureDiagnostic }> |
  Readonly<{ kind: "codex" | "copilot"; run: RunRef; value: unknown }>;
export type OpeningObservation = Readonly<{ run: RunRef; callbacksComplete: boolean; continuous: boolean; activity?: Activity }> &
  (Readonly<{ kind: "created"; noAutomaticContinuation: true }> | Readonly<{ kind: "reopened" }>);
/** Private, trusted native containment. The library neither launches nor kills a process.
 * Capability declarations and certificates are obligations to qualify, not proofs
 * inferred from disconnect, process leader exit, empty callbacks or native idle. */
export interface TrustedContainment {
  readonly placement: "shared" | "dedicated";
  readonly capabilities: Pick<Capabilities, "fullStop" | "reopen" | "createAndWait">;
  readonly parentCustody?: ParentCustody | undefined;
  /** Capture a stopped allocation before native launch; await durable custody. */
  prepareOpening?(input: NativeStart): Promise<NativeOpening>;
  inspectOpening?(capsule: OpeningCapsule): Promise<NativeOpening | OpeningStopProof | null>;
  identity(run: RunRef): RuntimeIdentity;
  /** Initialization facts, not a claim that a reopened native agent is idle. */
  observeOpening(input: NativeStart, run: RunRef): Promise<OpeningObservation>;
  /** Retained owner evidence only. Never start, attach, Resume or replay Stop. */
  inspect(run: RunRef): Promise<"owned" | RuntimeHalt | null>;
  stopTree(identity: RuntimeIdentity): Promise<RuntimeHalt>;
  onHalt?(listener: (halt: RuntimeHalt) => void): () => void;
}
export interface HostHistoryFacet {
  scope(run: RunRef, attachment: string): HistoryScope;
  codec(scope: HistoryScope, capture: CapturePort, knownStart: boolean, media?: NativeMediaHandler): NativeCodec;
}
export interface HostController extends RuntimeOwnershipPort {
  readonly historyFacet: HostHistoryFacet;
  readonly protocol: NativeProtocol;
  current(): ControllerBinding | null;
  observe(listener: (capture: NativeCapture) => void): () => void;
  interactions(run: RunRef): InteractionOwner;
  nativeMcp(run: RunRef): NativeMcpReadPort;
  read?(run: RunRef, request: NativeRead): Promise<NativeReadResult>;
  mcpLoginLink?(run: RunRef, originalId: string): Promise<McpLoginLink>;
  /** Release only library listeners after exact halt; never closes transport/native. */
  dispose(): void;
}
