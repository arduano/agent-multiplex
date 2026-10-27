import type { NativeProtocol } from "./native-protocol.js";
import type { ArtifactRef, DiskRef } from "../../../v8-files/src/contracts/types.js";
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Harness = "codex" | "copilot";
export type Placement = "shared" | "dedicated";
/** Logical authenticated identity; run generations fence native execution separately. */
export type SessionScope = Readonly<{ connection: string; principal: string; host: string; session: string }>;
export type RunRef = Readonly<{ scope: SessionScope; generation: number; nativeSession: string }>;
/** Custody before a native session ID exists. Never a synthetic RunRef. */
export type OpeningRef = Readonly<{ scope: SessionScope; generation: number; operationId: string }>;
export type OpeningIdentity = Readonly<{ attachment: string; process: string; containment: string; placement: Placement }>;
/** Private journal capsule: opaque owned resources, never configuration or credentials. */
export type OpeningCapsule = Readonly<{ opening: OpeningRef; identity: OpeningIdentity }>;
export type OpeningStopProof = OpeningCapsule & Readonly<{ state: "stopped"; scope: "nativeTree"; noAutomaticContinuation: true; acquisitionSealed: true }>;
/** Exact enclosing Host invocation retirement, independently inspected by the
 * trusted backend. A changed invocation name alone cannot construct this proof. */
export type ParentStopProof = Readonly<{ identity: OpeningIdentity; state: "stopped"; scope: "nativeTree"; noAutomaticContinuation: true; acquisitionSealed: true }>;
export type ParentCustody = Readonly<{ identity: OpeningIdentity; inspect(identity: OpeningIdentity): Promise<ParentStopProof | null> }>;
export type NativeOpening = OpeningCapsule & Readonly<{ stop(): Promise<OpeningStopProof> }>;
/** One private auxiliary reader slot, persisted by the existing session writer. */
export type ReaderCustody = Readonly<{ state: "none" | "unconfirmed" }> |
  Readonly<{ state: "allocating"; run: RunRef; opening: OpeningRef }> |
  Readonly<{ state: "owned"; run: RunRef; capsule: OpeningCapsule }>;
export interface ReaderCustodyPort {
  read(): Promise<ReaderCustody>;
  begin(run: RunRef, opening: OpeningRef): Promise<void>;
  owned(run: RunRef, capsule: OpeningCapsule): Promise<void>;
  released(proof: OpeningStopProof): Promise<void>;
}
export type Phase = "starting" | "running" | "stopping" | "stopped";
export type Activity = "idle" | "working" | "waiting" | "unknown";
/** Last root cumulative native accounting checkpoint, never inferred token cost. */
export type CopilotUsage = Readonly<{ nativeSession: string; totalNanoAiu: number; reportedAt: string; observedAt: string }>;
/** Positive root work observation, separate from native lifetime and callbacks.
 * Unknown preserves a known cycle whose evidence became incomplete. */
export type AttentionSignal = Readonly<{
  state: "working" | "retrying" | "background" | "finished" | "error" | "interrupted" | "unknown";
  cause: Readonly<{ source: "codex.turn" | "copilot.event"; id: string }>;
}>;
/** Existing writer revision at acceptance, not a new event counter. Retained
 * provenance never makes a prior generation current after Stop/Resume/reopen. */
export type SessionAttention = AttentionSignal & Readonly<{ nativeSession: string; generation: number; epoch: number; revision: number }>;
export type CodexAccess = Readonly<{ approval: "on-request" | "untrusted" | "never" } & (
  { sandbox: "danger-full-access" | "workspace-write" | "read-only"; profile?: never } |
  { profile: string; sandbox?: never }
)>;
export type CodexSelection = Readonly<{
  kind: "codex"; model?: string; effort?: string | null;
  collaboration?: Readonly<{ mode: "plan" | "default"; model: string; effort: string | null; instructions?: string | null }>;
  access?: CodexAccess;
}>;
export type CopilotSelection = Readonly<{
  kind: "copilot"; model?: string;
  /** Authorized framework route; an adapter translates native catalog IDs. */
  providerId?: string;
  effort?: string | null;
  mode?: "interactive" | "plan" | "autopilot";
  permissions?: "manual" | "assisted" | "allow-all";
}>;
export type Selection = CodexSelection | CopilotSelection;
export type SelectionFor<K extends Harness> = Extract<Selection, { kind: K }>;
/** Private Host construction policy, never a browser-provided provider escape hatch. */
export type ManagedPolicy = Readonly<{ kind: "codex"; access: CodexAccess; provider: "copilot-only" | "configured" }> |
  Readonly<{ kind: "copilot"; permissions: "manual" | "allow-all"; provider: "copilot-only" | "configured" }>;
/** id names an exact one-response native capability, never a reusable raw vendor request ID. */
export type Interaction = Readonly<{ id: string; owner: string; kind: "approval" | "permission" | "userInput" | "elicitation" | "exitPlan"; choices: readonly string[]; /** Positive native Prompt fact; absent is unproved, not blocking. */ blocking?: boolean }>;
export type Capabilities = Readonly<{ commands: readonly ControlCommand["type"][]; fullStop: boolean; reopen: boolean; createAndWait?: boolean; reads?: readonly NativeRead["type"][] }>;
/** A fresh thread has no interrupted native work to continue. Its separate
 * certificate cannot authorize Resume of an existing native session. */
export const supportsNativeOpening = (capabilities: Pick<Capabilities, "fullStop" | "reopen" | "createAndWait">, nativeSession: string | null): boolean =>
  capabilities.fullStop === true && (nativeSession === null ? capabilities.createAndWait === true : capabilities.reopen === true);
/** Optional native catalog presentation facts. Absence is unknown; modalities
 * are metadata, not proof that an attachment was accepted or understood. */
export type CatalogChoice = Readonly<{
  model: string; providerId?: string; efforts: readonly string[];
  displayName?: string; description?: string; defaultEffort?: string;
  inputModalities?: readonly ("text" | "image" | "audio")[];
}>;
export type Catalog = Readonly<{ available: boolean; choices: readonly CatalogChoice[] }>;

export type SendInputFor<K extends Harness> = K extends "codex" ?
  Readonly<{ type: "image"; artifact: ArtifactRef }> | Readonly<{ type: "localImage"; file: DiskRef }> | Readonly<{ type: "mention"; file: DiskRef; name: string }> :
  Readonly<{ type: "blob"; artifact: ArtifactRef }> | Readonly<{ type: "file"; file: DiskRef; displayName?: string }>;
export type SendInputsFor<K extends Harness> = K extends Harness ? Readonly<{ kind: K; items: readonly SendInputFor<K>[] }> : never;
export type SendCommandFor<K extends Harness> = K extends Harness ? Readonly<{ type: "send"; text: string; selection?: SelectionFor<K>; inputs?: SendInputsFor<K> }> : never;
export type SteerCommandFor<K extends Harness> = K extends "codex" ? Readonly<{ type: "codex.steer"; expectedTurnId: string; text: string; inputs?: SendInputsFor<K> }> : Readonly<{ type: "copilot.steer"; text: string; inputs?: SendInputsFor<K> }>;
export type QueueCommand = Readonly<{ type: "codex.queue.add"; text: string; inputs?: SendInputsFor<"codex"> }>;
/** Closed authoring commands share the same verified attachment owner. */
export type MessageCommandFor<K extends Harness> = SendCommandFor<K> | SteerCommandFor<K> | (K extends "codex" ? QueueCommand : never);
/** Private verified native buffers; never a wire/original-journal command. */
export type NativeInputFor<K extends Harness> = K extends "codex" ?
  Readonly<{ type: "image"; artifact: ArtifactRef; bytes: Uint8Array }> | Readonly<{ type: "localImage"; path: string }> | Readonly<{ type: "mention"; path: string; name: string }> :
  Readonly<{ type: "blob"; artifact: ArtifactRef; bytes: Uint8Array }> | Readonly<{ type: "file"; path: string; displayName?: string }>;
export type NativeSendCommand<K extends Harness = Harness> = K extends Harness ? Readonly<{ type: "send"; text: string; selection?: SelectionFor<K>; clientUserMessageId?: string; nativeInputs: Readonly<{ kind: K; items: readonly NativeInputFor<K>[] }> }> : never;
export type NativeMessageCommand<K extends Harness = Harness> = K extends Harness ?
  (K extends "codex" ? Readonly<{ type: "send"; selection?: CodexSelection; clientUserMessageId?: string }> | Readonly<{ type: "codex.steer"; expectedTurnId: string }> | Readonly<{ type: "codex.queue.add"; clientUserMessageId?: string }> : Readonly<{ type: "send"; selection?: CopilotSelection }> | Readonly<{ type: "copilot.steer" }>) & Readonly<{ text: string; nativeInputs: Readonly<{ kind: K; items: readonly NativeInputFor<K>[] }> }> : never;
export type PreparedSend = Readonly<{ command: NativeMessageCommand; release(): Promise<void> }>;
export type CodexEncodedInput = Readonly<{ type: "image"; url: string }> | Readonly<{ type: "localImage"; path: string }> | Readonly<{ type: "mention"; path: string; name: string }>;
export type CopilotEncodedAttachment = Readonly<{ type: "blob"; data: string; mimeType: string; displayName?: string }> | Readonly<{ type: "file"; path: string; displayName?: string }>;
type SharedControl = SendCommandFor<Harness> |
  Readonly<{ type: "answer"; interactionId: string; choice: string; value?: Json }>;
export type NativeSendOriginal = Readonly<{ type: "send"; text: string; selection?: CodexSelection; clientUserMessageId: string }>;
export type NativeQueueCommand = Readonly<{ type: "codex.queue.add"; text: string; clientUserMessageId: string }>;
/** Trusted prepare(originalId) only; never accepted from a wire command. */
export type NativeMcpLoginCommand = Readonly<{ type: "codex.mcp.login"; serverName: string; originalId: string }> |
  Readonly<{ type: "copilot.mcp.login"; serverName: string; forceReauth?: boolean; originalId: string }>;
export type McpLoginStatus = "starting" | "initiated" | "reused" | "succeeded" | "failed" | "outcomeUnknown";
/** Ephemeral secret response. Never a native read, event, receipt or persisted view. */
export type McpLoginLink = Readonly<{ state: "available"; status: "initiated"; authorizationUrl: string; expiresInMs: number }> |
  Readonly<{ state: "unavailable"; reason: "notRetained" | "displayExpired" | "nativeRetired"; status?: McpLoginStatus }>;
export type CodexControl = Readonly<{ type: "codex.continue" }> | Readonly<{ type: "codex.defaults"; selection: CodexSelection }> |
  Readonly<{ type: "codex.turn"; turnId: string; selection: CodexSelection }> |
  Readonly<{ type: "codex.interrupt"; turnId: string }> |
  QueueCommand | SteerCommandFor<"codex"> |
  Readonly<{ type: "codex.compact" }> |
  Readonly<{ type: "codex.goal.set"; objective?: string; status?: GoalStatus; tokenBudget?: number | null }> |
  Readonly<{ type: "codex.goal.clear" }> |
  Readonly<{ type: "codex.terminal.terminate"; processId: string }> |
  Readonly<{ type: "codex.terminals.clean" }> |
  Readonly<{ type: "codex.mcp.reload" }> | Readonly<{ type: "codex.mcp.login"; serverName: string }>;
export type CopilotControl = Readonly<{ type: "copilot.continue" }> | Readonly<{ type: "copilot.model"; model: string; providerId?: string; effort?: string | null }> |
  Readonly<{ type: "copilot.mode"; mode: "interactive" | "plan" | "autopilot" }> |
  Readonly<{ type: "copilot.permissions"; mode: "manual" | "allow-all" }> |
  Readonly<{ type: "copilot.abort" }> |
  SteerCommandFor<"copilot"> |
  Readonly<{ type: "copilot.queue.promote"; id: string }> |
  Readonly<{ type: "copilot.compact" }> |
  Readonly<{ type: "copilot.task.cancel"; id: string }> |
  Readonly<{ type: "copilot.task.promote"; id: string }> |
  Readonly<{ type: "copilot.mcp.reconnect"; serverName: string }> | Readonly<{ type: "copilot.mcp.login"; serverName: string; forceReauth?: boolean }>;
/** Native-owned state, explicitly read. No local queue/task/goal authority. */
export type GoalStatus = "active" | "paused" | "blocked" | "usageLimited" | "budgetLimited" | "complete";
export type Goal = Readonly<{ threadId: string; objective: string; status: GoalStatus; tokenBudget: number | null; tokensUsed: number; timeUsedSeconds: number; createdAt: number; updatedAt: number }>;
export type QueueItem = Readonly<{ id: string; messageId?: string; kind: string; displayText: string; agentMode: string }>;
export type Task = Readonly<{ id: string; type: "agent" | "shell" | "client"; description: string; status: "running" | "idle" | "completed" | "failed" | "cancelled" | "orphaned"; startedAt: string; completedAt?: string; executionMode?: "sync" | "background"; canPromoteToBackground?: boolean; canCancel?: boolean; toolCallId?: string; agentType?: string; model?: string | null; resolvedModel?: string; displayName?: string; command?: string;
  /** Bounded native display facts; PID is descriptive, never an effect target.
   * Agent result/response text is distinct from opaque client-owner results. */
  error?: string; latestResponse?: string; result?: string; pid?: number }>;
export type TaskProgress = Readonly<{ type: "agent" | "shell" | "client"; recentActivity?: readonly Readonly<{ message: string; timestamp: string }>[]; recentOutput?: string; latestIntent?: string; status?: Task["status"]; sequence?: number; updatedAt?: string; percentage?: number; phase?: string; lastMessage?: string }>;
export type BackgroundTerminal = Readonly<{ itemId: string; processId: string; command: string; cwd: string; osPid: number | null; cpuPercent: number | null; rssKb: number | null }>;
export type NativeRead = Readonly<{ type: "codex.goal" }> | Readonly<{ type: "codex.terminals"; cursor?: string | null; limit?: number }> | Readonly<{ type: "copilot.queue" }> | Readonly<{ type: "copilot.tasks" }> | Readonly<{ type: "copilot.task.promotable" }> | Readonly<{ type: "copilot.task.progress"; id: string }>;
export type NativeReadFor<K extends Harness> = K extends "codex" ? Extract<NativeRead, { type: `codex.${string}` }> : Exclude<NativeRead, { type: `codex.${string}` }>;
export type NativeReadResult = Readonly<{ run: RunRef }> & (
  Readonly<{ type: "codex.goal"; goal: Goal | null }> |
  Readonly<{ type: "codex.terminals"; data: readonly BackgroundTerminal[]; nextCursor: string | null }> |
  Readonly<{ type: "copilot.queue"; items: readonly QueueItem[]; steeringMessages: readonly string[]; inFlightSteeringCount?: number }> |
  Readonly<{ type: "copilot.tasks"; tasks: readonly Task[] }> |
  Readonly<{ type: "copilot.task.progress"; id: string; progress: TaskProgress | null }> |
  Readonly<{ type: "copilot.task.promotable"; task: Task | null }>
);
export type ControlCommand = SharedControl | CodexControl | CopilotControl;
export type ControlFor<K extends Harness> = (K extends "codex" ? CodexControl : CopilotControl) |
  SendCommandFor<K> | Extract<SharedControl, { type: "answer" }>;
export type NativeControlCommand = ControlCommand | NativeMessageCommand | NativeSendOriginal | NativeQueueCommand | NativeMcpLoginCommand;
export type LifecycleCommand = Readonly<{ type: "create"; selection?: Selection }> | Readonly<{ type: "resume" }> | Readonly<{ type: "stop" }> | Readonly<{ type: "archive" }>;
export type SessionCommand = LifecycleCommand | ControlCommand;
export type NativeOutcome = Readonly<{
  status: "accepted" | "applied" | "deferred" | "refused" | "targetUnavailable" | "confirmationRequired" | "acknowledged";
  detail?: Json;
}>;
/** Only the trusted native owner supplies these proofs; caller wire data cannot. */
export type StopProof = Readonly<{ run: RunRef; state: "stopped"; scope: "nativeTree"; noAutomaticContinuation: true }>;
export type NativeEvent = Readonly<{ run: RunRef; type: "selection"; selection: Selection }> |
  Readonly<{ run: RunRef; type: "copilot.usage"; totalNanoAiu: number; reportedAt: string }> |
  Readonly<{ run: RunRef; type: "attention"; attention: AttentionSignal }> |
  Readonly<{ run: RunRef; type: "activity"; activity: Activity }> |
  Readonly<{ run: RunRef; type: "controlLost" }> |
  Readonly<{ run: RunRef; type: "nativeState" }> |
  Readonly<{ run: RunRef; type: "interactions"; complete: boolean; items: readonly Interaction[] }> |
  Readonly<{ run: RunRef; type: "stopped"; proof: StopProof }>;
export type NativeRun = Readonly<{
  run: RunRef;
  /** Optional early-owned seam: false retains Starting through inspection. */
  initializationComplete?: boolean;
  selection: Selection;
  interactionsComplete: boolean;
  interactions: readonly Interaction[];
  /** Strong native stop/kill, NOT controller disconnect or root-turn interrupt. */
  stop(): Promise<StopProof>;
  invoke(command: NativeControlCommand): Promise<NativeOutcome>;
}>;
export type NativeStart = Readonly<{
  scope: SessionScope; generation: number; placement: Placement; operationId: string;
  nativeSession: string | null; selection?: Selection; policy: ManagedPolicy;
}>;
export type NativePort = Readonly<{
  kind: Harness;
  protocol: NativeProtocol;
  placement: Placement;
  capabilities: Capabilities;
  parentCustody?: ParentCustody | undefined;
  /** Fresh creation is quiescent. Explicit reopening may continue native saved
   * work; opening never automatically submits a new promptless context turn. */
  start(input: NativeStart, emit: (event: NativeEvent) => void, onOwned?: (run: NativeRun) => Promise<void>, onOpening?: (owner: NativeOpening) => Promise<void>): Promise<NativeRun>;
  /** Read/reconcile existing ownership only; must never start or resume native work. */
  inspect(run: RunRef, emit: (event: NativeEvent) => void): Promise<NativeRun | StopProof | null>;
  /** Read exact retained custody only; never allocate, attach or resume. */
  inspectOpening?(capsule: OpeningCapsule): Promise<NativeOpening | OpeningStopProof | null>;
  /** Admission is already durable. Native inputs stay private and release only
   * with actual preparation/invocation settlement, never an observer timeout. */
  prepareSend?(request: SendSubmit, run: RunRef, assertCurrent: () => void): Promise<PreparedSend>;
  /** Read only from the exact established run. Never start/Resume or replay. */
  read?(run: RunRef, request: NativeRead): Promise<NativeReadResult>;
  /** Private RAM lookup only; never allocates or forwards another login. */
  mcpLoginLink?(run: RunRef, originalId: string): Promise<McpLoginLink>;
  catalog(): Promise<Catalog>;
}>;
export type OperationState = "admitted" | "dispatched" | "acknowledged" | "refused" | "outcomeUnknown";
export type Receipt = Readonly<{
  scope: SessionScope; id: string; type: SessionCommand["type"]; generation: number;
  state: OperationState; outcome?: NativeOutcome; reason?: string;
}>;
export type SessionSnapshot = Readonly<{
  /** Durable observation epoch advances on Host reopen; native run generation is independent. */
  scope: SessionScope; kind: Harness; placement: Placement; epoch: number; revision: number; generation: number;
  phase: Phase; activity: Activity; nativeSession: string | null; stopRequested: boolean;
  selection: Selection; interactionsComplete: boolean; interactions: readonly Interaction[];
  capabilities: Capabilities; issue?: "stopUnconfirmed" | "ownershipUnconfirmed" | "startUnconfirmed" | "storageUnavailable";
  usage?: CopilotUsage;
  attention?: SessionAttention;
  /** Permanent lifecycle seal; native phase remains positively stopped. */
  archive?: Readonly<{ id: string; state: "pending" | "complete" }>;
}>;
export type Submit = Readonly<{ scope: SessionScope; id: string; generation: number; command: SessionCommand }>;
export type SendSubmit = Omit<Submit, "command"> & Readonly<{ command: MessageCommandFor<Harness> }>;
export function isMessageCommand(command: SessionCommand): command is MessageCommandFor<Harness> { return command.type === "send" || command.type === "codex.steer" || command.type === "copilot.steer" || command.type === "codex.queue.add"; }
/** Browser-safe transport abstraction. Subscribing is read-only, never native attach. */
export interface SessionPort {
  snapshot(scope: SessionScope): Promise<SessionSnapshot>;
  submit(request: Submit): Promise<Receipt>;
  receipt(scope: SessionScope, id: string): Promise<Receipt | null>;
  read?(run: RunRef, request: NativeRead): Promise<NativeReadResult>;
  /** Ephemeral current-run secret lookup; no native-read cache or acquisition. */
  mcpLoginLink?(run: RunRef, originalId: string): Promise<McpLoginLink>;
  /** Exact committed original-receipt notifications. Subscribe before reading to close the join race; no native acquisition. */
  subscribeReceipt?(scope: SessionScope, id: string, listener: (receipt: Receipt) => void): () => void;
  /** Publish current facts at a newer observation revision after final receipt
   * commits too, so retained clients can read exact originals without polling.
   * Receipt progress must never manufacture a native phase/activity change.
   * A remote observation failure ends this subscription, never native work. */
  subscribe(scope: SessionScope, listener: (snapshot: SessionSnapshot) => void, onError?: (error: unknown) => void): () => void;
}
export type SessionErrorCode = "INVALID" | "FENCED" | "CONFLICT" | "BUSY" | "FULL" | "CLOSED" | "UNSUPPORTED" | "IO";
export class SessionError extends Error {
  constructor(readonly code: SessionErrorCode, message: string = code) { super(message); this.name = "SessionError"; }
}
export const scopeKey = (scope: SessionScope): string => JSON.stringify([scope.connection, scope.principal, scope.host, scope.session]);
export const sameRun = (a: RunRef, b: RunRef): boolean => scopeKey(a.scope) === scopeKey(b.scope) && a.generation === b.generation && a.nativeSession === b.nativeSession;

/** Trusted receiver proof from pinned operation-specific native rejection branches. */
export class NativeInputRefused extends Error {
  constructor(readonly reason: "queueUnavailable" | "alreadyWorking" | "noActiveTurn" | "expectedTurnMismatch" | "activeTurnNotSteerable") { super(reason); this.name = "NativeInputRefused"; }
}
