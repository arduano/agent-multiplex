import type { CatalogEntry, CatalogPort, CatalogScope, Creation, NativeBinding } from '../../v8-catalog/src/contracts/types.js';
import type { LogicalView } from '../../v8-catalog/src/client/workspace.js';
import type { ArtifactRef, FileInputs, FilePort } from '../../v8-files/src/contracts/types.js';
import type { ResourceLease } from '../../v8-files/src/client/resource-cache.js';
import type { DraftPersistence, DraftRecord, ComposerValue } from '../../v8-files/src/client/persistence.js';
import type { Scope, HistoryPage, ApplyResult } from '../../v8-history/src/contracts/types.js';
import type { HistoryObservation, HistoryRecovery } from '../../v8-history/src/acquisition/types.js';
import type { AnchorController } from '../../v8-history/src/client/anchor.js';
import type { ViewSnapshot } from '../../v8-history/src/client/history-client.js';
import type { HistoryWorkspace } from '../../v8-history/src/client/workspace.js';
import type { AnswerFor, InteractionPort, InteractionSnapshot, Prompt } from '../../v8-interactions/src/contracts.js';
import type { McpPort, McpSnapshot } from '../../v8-mcp/src/contracts.js';
import type { PinStorage, PinWrite } from '../../v8-organization/src/pins.js';
import type { SessionPort, SessionScope, RunRef, Receipt, Catalog, NativeOutcome } from '../../v8-session/src/contracts/types.js';
import type { CodexAgent, CopilotAgent, SessionView } from '../../v8-session/src/client/workspace.js';
import type { ComposerSnapshot } from './composer.js';
import type { FormHandle, ResponseOperation } from '../../v8-interactions/src/client.js';
import type { OperationHandle } from '../../v8-session/src/client/workspace.js';
import type { AgentSummary } from './agent-summary.js';
import type { DraftAction, SendPreparationSnapshot } from './send.js';
import type { GoalEditor, GoalFormSnapshot } from './goal-form.js';
import type { PlanAction, PlanOriginal } from './plan-action.js';

export type Binding = Readonly<{ run: RunRef; history: Scope }>;
/** Original Create observation only; no launch payload or private native configuration. */
export type CreationStatus = Readonly<{ id: string; session: string; state: Creation['state']; publication: Creation['publication']; binding: NativeBinding | null }>;
export type ObservationState = 'unobserved' | 'connecting' | 'live' | 'unavailable' | 'disconnected';
/** Trusted composition's exact-scope projection of the existing Gateway grants.
 * Native capability facts remain separate; the server authorizes every call. */
export type WorkspaceAccess = Readonly<{ read: boolean; control: boolean; fileWrite: boolean; mcpRefresh: boolean; catalogWrite: boolean }>;
/** Transport evidence only; neither native phase nor canonical history state. */
export type WorkspaceObservation = (Readonly<{ scope: SessionScope; kind: 'session' | 'history' | 'interactions'; history?: Scope }> | Readonly<{ scope: SessionScope; kind: 'mcp'; run: RunRef }> | Readonly<{ scope: CatalogScope; kind: 'catalog' }>) & Readonly<{ state: Exclude<ObservationState, 'unobserved'> }>;
export type WorkspacePorts = Readonly<{
  session: SessionPort; catalog: CatalogPort;
  /** Pure current authenticated configuration lookup. No grant cache or IO. */
  access(scope: SessionScope): WorkspaceAccess;
  /** Durable request domain (ownerKey), never the replaceable route epoch. */
  receiptOwner?(scope: SessionScope): string;
  /** Positive authenticated Host binding, never client/fixture-generated attachment metadata. */
  binding(scope: SessionScope): Promise<Binding | null>;
  filePort(scope: SessionScope): FilePort;
  interactionPort(scope: SessionScope): InteractionPort;
  mcpPort(scope: SessionScope): McpPort;
  observeHistory(scope: SessionScope, history: Scope): Readonly<{ release(): void }>;
  historyScopes?(scope: SessionScope): Promise<readonly Scope[]>;
  older?(scope: SessionScope, history: Scope, cursor: string, generation?: string, retryToken?: string): Promise<HistoryPage>;
  recover?(scope: SessionScope, history: Scope, observation?: HistoryObservation, retryToken?: string): Promise<HistoryRecovery>;
  controlCatalog?(scope: SessionScope): Promise<Catalog>;
  close(): void; disconnect?(): void; reconnect?(): void;
}>;
export type WorkspaceOptions = Readonly<{
  scope: CatalogScope;
  connect(context: Readonly<{ history: HistoryWorkspace; onFence(): void; onConnection(connected: boolean): void; onObservation(observation: WorkspaceObservation): void; onReady(observation: WorkspaceObservation): Promise<void> }>): WorkspacePorts;
  persistence: DraftPersistence; pinStorage?: PinStorage;
  maxSessions?: number; maxViewsPerSession?: number; maxOperations?: number; maxPins?: number;
}>;
/** Closed native results needed to distinguish a changed action from a no-op.
 * Private native details and effect identities remain in the original owner. */
export type NativeActionResult = Readonly<{ type: 'copilot.compact'; success: boolean; tokensRemoved: number; messagesRemoved: number }> |
  Readonly<{ type: 'copilot.queue.promote'; steered: boolean }> |
  Readonly<{ type: 'copilot.task.cancel'; cancelled: boolean }> |
  Readonly<{ type: 'copilot.task.promote'; promoted: boolean }> |
  Readonly<{ type: 'codex.goal.clear'; cleared: boolean }> |
  Readonly<{ type: 'codex.terminal.terminate'; terminated: boolean }>;
export type OperationStatus = Readonly<{
  id: string; type: string; generation: number;
  /** One rendered status per original ID; delivery does not imply completed agent work. */
  state: Receipt['state'] | 'sending' | 'unobserved';
  outcome?: Readonly<{ status: NativeOutcome['status']; sendDispatched?: boolean; completedSubsteps?: readonly string[]; result?: NativeActionResult }>;
}>;
/** Read-only association from the existing response-original owner. No answer
 * values or private form fields enter this presentation. */
export type ConfirmationResponse = ResponseOperation;
/** Lifecycle observation before transcript binding. No private command bodies,
 * answers or selection drafts; null is the disposed authentication namespace. */
export type CreationControl = Readonly<{
  getSnapshot(): (Omit<SessionView, 'draft' | 'operations'> & Readonly<{ operations: readonly OperationStatus[] }>) | null;
  subscribe(listener: () => void): () => void;
}>;
export type SharedView = Readonly<{
  sessionId: string; viewKey: string; logical: Omit<LogicalView, 'draft'>;
  session: Omit<SessionView, 'operations'>;
  access: WorkspaceAccess;
  composer: ComposerSnapshot;
  /** Derived native Send admission for this exact binding, not connection
   * health or draft/file readiness. Rechecked when preparing an original. */
  sendReady: boolean;
  sendPreparation: SendPreparationSnapshot;
  draftActions: Readonly<Record<DraftAction, boolean>>;
  modelCatalog: Readonly<{ state: 'unobserved' | 'loading' | 'available' | 'unavailable'; value: Catalog | null }>;
  history: ViewSnapshot; files: readonly DraftRecord[];
  /** Pure display facts from the current Host inventory and retained native rows. */
  agents: readonly AgentSummary[];
  historyScopes: Readonly<{ supported: boolean; state: 'unobserved' | 'observed' | 'unavailable'; scopes: readonly Scope[] }>;
  confirmations: InteractionSnapshot | null; confirmationsStale: boolean;
  confirmationResponses: readonly ConfirmationResponse[];
  mcp: McpSnapshot | null; mcpStale: boolean;
  operations: readonly OperationStatus[];
  observation: Readonly<{ session: ObservationState; history: ObservationState }>;
  /** Client-domain preparation only; actual native phase remains session.native.phase. */
  bindingTransition: Readonly<{ state: 'preparing' | 'unavailable'; run: RunRef }> | null;
}>;
export type AgentSnapshot = SharedView & (
  Readonly<{ kind: 'codex'; goalForm: GoalFormSnapshot; planActions: readonly PlanAction[]; actions: Omit<CodexAgent['actions'], 'answer'> & Readonly<{ goalEditor?: GoalEditor }> }> |
  Readonly<{ kind: 'copilot'; actions: Omit<CopilotAgent['actions'], 'answer'> }> |
  Readonly<{ kind: 'unavailable' }>
) | Readonly<{ kind: 'disposed' }>;
export type WorkspaceView = Readonly<{
  getSnapshot(): AgentSnapshot; getServerSnapshot(): AgentSnapshot;
  subscribe(listener: () => void): () => void;
  /** Acquired only after React commit; release never stops or destroys conversation state. */
  observe(): Readonly<{ release(): void }>;
  /** All session operations close over this prepared owner. Renderers never
   * pair this view with a separately supplied workspace or logical ID. */
  setPinned(pinned: boolean): PinWrite;
  rebind(): Promise<WorkspaceView>;
  checkReceipt(originalId: string): Promise<Receipt | null>;
  publishArchive(originalId: string, generation: number): Promise<CatalogEntry>;
  refreshMcp(): Promise<void>;
  refreshHistoryScopes(): Promise<readonly Scope[]>;
  historyView(scope: Scope, viewKey?: string): import('./history-view.js').ReadonlyHistoryView;
  saveFile(input: Readonly<{ name: string; mediaType: string; blob: Blob; id?: string }>): Promise<DraftRecord>;
  uploadFile(fileId: string): Promise<ArtifactRef>;
  clearFile(fileId: string, expectedRevision: number): Promise<void>;
  captureFile(input: Omit<FileInputs['capture'], 'scope' | 'historyScope'>, historyScope?: Scope): Promise<ArtifactRef>;
  previewFile(artifact: ArtifactRef): Promise<ResourceLease>;
  previewCapturedFile(artifactId: string): Promise<ResourceLease>;
  viewport: Pick<AnchorController, 'report' | 'userScroll' | 'followLatest' | 'captureFollow' | 'tailPosition' | 'beginRestore' | 'correct'>;
  setExpanded(rowId: string, expanded: boolean): void;
  /** Explicit exception only; hook/scroll/layout never calls it automatically. */
  loadOlder(retryToken?: string): Promise<ApplyResult>;
  /** Explicit cold/gap exception; baseline bodies arrive through the retained stream. */
  recoverHistory(observation?: HistoryObservation, retryToken?: string): Promise<HistoryRecovery>;
  /** Explicit optional configured-choice read; render never performs discovery. */
  refreshControls(): Promise<Catalog>;
  /** Explicit private RAM handle. Values never enter the composite snapshot. */
  form(prompt: Prompt): FormHandle;
  setDraft(value: string | ComposerValue): void;
  /** Retained preparation; navigation never releases this job or changes its run.
   * isCurrent guards only the initiating view's follow, never native admission. */
  submitDraft(action: DraftAction, isCurrent?: () => boolean): Promise<OperationHandle>;
  sendDraft(): Promise<OperationHandle>;
  /** Explicit completed root-plan action. Uses one ordinary Send original;
   * never consumes the message draft/files or creates a child control port. */
  implementPlan(rowId: string): Promise<PlanOriginal>;
  respond<P extends Prompt>(prompt: P, answer: AnswerFor<NoInfer<P>>, id?: string): Readonly<{ id: string; result: Promise<Receipt> }>;
}>;
