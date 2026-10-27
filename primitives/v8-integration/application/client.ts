import { createElement as h, StrictMode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { GatewayClient } from "../../v8-gateway/src/client/coordinator.js";
import { HttpGatewayTransport } from "../../v8-gateway/src/client/http.js";
import type { GatewayTarget } from "../../v8-gateway/src/contracts/types.js";
import { ownerKey } from "../../v8-gateway/src/contracts/types.js";
import { IndexedDbDraftPersistence, type DraftPersistence } from "../../v8-files/src/client/persistence.js";
import { svgInputToPng } from "../../v8-files/src/client/svg.js";
import { imageType } from "../../v8-files/src/contracts/content.js";
import { FileError, type ArtifactRef } from "../../v8-files/src/contracts/types.js";
import type { ResourceLease } from "../../v8-files/src/client/resource-cache.js";
import type { CatalogScope } from "../../v8-catalog/src/contracts/types.js";
import type { SessionScope } from "../../v8-session/src/contracts/types.js";
import type { FormHandle } from "../../v8-interactions/src/client.js";
import { PromptDialog } from './prompts.js';
import { AgentControls } from './controls.js';
import { NativeActions } from './native-actions.js';
import { rowMedia } from '../../v8-history/src/contracts/media.js';
import { MultiplexWorkspace } from "../../v8-workspace/src/index.js";
import { useAgent } from "../../v8-workspace/src/react.js";
import type { CreationControl, CreationStatus, WorkspaceView } from "../../v8-workspace/src/contracts.js";
import type { OperationStatus } from "../../v8-workspace/src/contracts.js";

const actionStatus = (operation: OperationStatus): string => {
  if (operation.outcome?.sendDispatched === false) return 'Message not sent';
  if (operation.state !== 'acknowledged') return operation.state;
  const status = operation.outcome?.status;
  return status === 'accepted' ? 'accepted' : status === 'confirmationRequired' ? 'confirmation required' : status === 'targetUnavailable' ? 'target unavailable' : status === 'acknowledged' || status === undefined ? 'request acknowledged' : status;
};

type Configuration = Readonly<{ scope: CatalogScope; targets: readonly GatewayTarget[] }>;
const configuration = await fetch("/configuration").then(response => response.json()) as Configuration;
let dropReply = false;
const originalFetch = globalThis.fetch.bind(globalThis);
const lossyFetch: typeof fetch = async (input, init) => {
  const response = await originalFetch(input, init);
  if (!response.ok) {
    const body = await response.clone().json().catch(() => null) as { error?: unknown } | null;
    diagnosticFailures.push(`HTTP ${response.status}: ${typeof body?.error === "string" ? body.error : "request failed"}`);
  }
  if (dropReply && typeof init?.body === "string" && JSON.parse(init.body).op === "submit") {
    dropReply = false; await response.arrayBuffer(); throw Error("The connection closed before the reply was observed");
  }
  return response;
};
let gateway: GatewayClient;
const openedViews = new Map<string, WorkspaceView>();
const diagnosticFailures: string[] = [];
const persistence: DraftPersistence = await IndexedDbDraftPersistence.open('multiplex-v8-drafts').catch(() => ({
  // The view/Stop path remains available, but every durable composer or file
  // write refuses. An in-memory fallback must never claim reload protection.
  list: async () => [], get: async () => undefined,
  put: async () => { throw new FileError('IO', 'Browser storage is unavailable'); },
  getComposer: async () => { throw new FileError('IO', 'Browser storage is unavailable'); }, close() {},
}));
const workspace = new MultiplexWorkspace({ scope: configuration.scope, persistence,
  connect: ({ history, onFence, onConnection, onObservation, onReady }) => {
    const transport = new HttpGatewayTransport({ url: new URL("/v8", location.href).href, authorization: "", fetch: lossyFetch, onUnauthenticated: onFence });
    gateway = new GatewayClient({ transport, history, targets: configuration.targets, onFence, onConnection, onObservation, onReady });
    const target = (scope: SessionScope): GatewayTarget => {
      const found = configuration.targets.find(value => value.session === scope.session && value.host === scope.host && value.connection === scope.connection && value.principal === scope.principal);
      if (!found) throw Error("No authenticated route for this conversation"); return found;
    };
    // This disposable reference server grants all five actions to its sole
    // authenticated fixture account; production embedders project their DTO.
    return { session: gateway, catalog: gateway.catalogPort(), access: scope => { target(scope); return { read: true, control: true, fileWrite: true, mcpRefresh: true, catalogWrite: true }; }, binding: scope => transport.binding(target(scope)), receiptOwner: scope => ownerKey(target(scope)),
      filePort: scope => transport.filePort(target(scope)), interactionPort: scope => gateway.interactionPort(scope),
      mcpPort: scope => gateway.mcpPort(scope), observeHistory: (scope, native) => gateway.observeHistory(scope, native),
      older: (scope, native, cursor, generation) => gateway.older(scope, native, cursor, generation),
      recover: (scope, native, observation) => gateway.recover(scope, native, observation), controlCatalog: scope => gateway.controlCatalog(scope),
      close: () => gateway.close(), disconnect: () => gateway.disconnect(), reconnect: () => gateway.reconnect() };
  },
});

function Conversation({ view, sessionId }: Readonly<{ view: WorkspaceView; sessionId: string }>) {
  const snapshot = useAgent(view), [error, setError] = useState(""), [dialog, setDialog] = useState<Readonly<{ id: string; form: FormHandle }> | null>(null);
  const [composer] = useState(() => workspace.composer(sessionId));
  const composerState = useSyncExternalStore(composer.subscribe, composer.getSnapshot, composer.getSnapshot);
  const [preview, setPreview] = useState<ResourceLease | null>(null), heldPreview = useRef<ResourceLease | null>(null);
  const lifetime = useRef<symbol | null>(null), previewRequest = useRef(0);
  const historyElement = useRef<HTMLDivElement | null>(null), previousScroll = useRef(0), programmaticScroll = useRef(false);
  const attemptedBinding = useRef<number | null>(null);
  const observedReadyGeneration = snapshot.kind !== "disposed" && snapshot.session.requiresRebind && snapshot.session.native?.phase === "running" ? snapshot.session.native.generation : null;
  const historyStamp = snapshot.kind === "disposed" ? "disposed" : snapshot.history.rows.map(row => `${row.id}:${row.version}`).join("|");
  const fileInput = useRef<HTMLInputElement | null>(null);
  useEffect(() => { const token = Symbol("committed-view"); lifetime.current = token; return () => { if (lifetime.current === token) lifetime.current = null; heldPreview.current?.release(); heldPreview.current = null; }; }, []);
  useEffect(() => {
    if (snapshot.kind !== "disposed") return;
    lifetime.current = null; previewRequest.current++; heldPreview.current?.release(); heldPreview.current = null; setPreview(null); setDialog(null); setError("");
  }, [snapshot.kind]);
  useEffect(() => {
    if (observedReadyGeneration === null || attemptedBinding.current === observedReadyGeneration) return;
    attemptedBinding.current = observedReadyGeneration;
    // Observing a new ready native run permits read-only attachment. It does
    // not settle or repeat the original Resume, whose receipt stays separate.
    void workspace.rebind(sessionId).catch(() => {});
  }, [observedReadyGeneration, sessionId]);
  useLayoutEffect(() => {
    if (snapshot.kind === "disposed") return; const element = historyElement.current; if (!element) return;
    const maximum = element.scrollHeight - element.clientHeight;
    programmaticScroll.current = true;
    if (snapshot.history.viewport.intent === "followingLive") element.scrollTop = view.viewport.tailPosition(element.scrollTop, maximum, document.activeElement?.id === "message");
    else if (snapshot.history.viewport.anchor) {
      const anchor = snapshot.history.viewport.anchor, row = [...element.querySelectorAll<HTMLElement>("[data-row]")].find(value => value.dataset.row === anchor.rowId);
      if (row) { const token = view.viewport.beginRestore(); if (token) element.scrollTop = view.viewport.correct(token, { rowTop: row.getBoundingClientRect().top, viewportTop: element.getBoundingClientRect().top, scrollTop: element.scrollTop, maximum }).scrollTop; }
    }
    previousScroll.current = element.scrollTop; requestAnimationFrame(() => { programmaticScroll.current = false; });
  }, [view, historyStamp]);
  const work = (operation: () => Promise<unknown>) => { setError(""); void Promise.resolve().then(operation).catch(() => { if (lifetime.current) setError("This view could not observe the result."); }); };
  if (snapshot.kind === "disposed") return h("p", { role: "status" }, "Workspace closed");
  if (snapshot.kind === "unavailable") return h("p", { role: "status" }, "Waiting for session observation");
  const pending = snapshot.confirmations?.items.find(item => item.state === "pending");
  const dialogItem = snapshot.confirmations?.items.find(item => item.state === "pending" && item.prompt.id === dialog?.id);
  const submittedResponses = snapshot.confirmations?.items.filter(item => item.state === "responseSubmitted" || item.state === "responseUnknown").length ?? 0;
  const sends = snapshot.operations.filter(operation => operation.type === "send"), latest = sends.at(-1);
  const latestControl = snapshot.operations.filter(operation => !['send', 'answer', 'create', 'resume', 'stop'].includes(operation.type)).at(-1);
  const unobserved = (state: string) => ["unobserved", "sending", "admitted", "dispatched", "outcomeUnknown"].includes(state);
  const visibleOperations = snapshot.operations.filter(operation => unobserved(operation.state) || operation === latest || operation === latestControl || operation.outcome?.sendDispatched === false || ['confirmationRequired', 'deferred', 'refused', 'targetUnavailable'].includes(operation.outcome?.status ?? ''));
  const connection = !snapshot.session.connected ? "offline" : snapshot.observation.session === "live" ? "connected" : snapshot.observation.session === "unavailable" ? "connection interrupted" : "connecting";
  const draft = composerState.value.text;
  const actions = snapshot.actions;
  const rebind = async () => {
    try { await workspace.rebind(sessionId); }
    catch (error) {
      const current = view.getSnapshot();
      if (current.kind !== "disposed" && current.kind !== "unavailable" && current.bindingTransition?.state === "unavailable") return;
      throw error;
    }
  };
  const openPreview = async (artifact: ArtifactRef | string) => {
    const token = lifetime.current, request = ++previewRequest.current;
    const lease = await (typeof artifact === 'string' ? workspace.previewCapturedFile(sessionId, artifact) : workspace.previewFile(sessionId, artifact));
    if (!token || lifetime.current !== token || request !== previewRequest.current) { lease.release(); return; }
    heldPreview.current?.release(); heldPreview.current = lease; setPreview(lease);
  };
  const preparing = snapshot.sendPreparation.state === 'preparing';
  const preparationError = snapshot.sendPreparation.state === 'failed'
    ? snapshot.sendPreparation.code === 'UNSUPPORTED' ? 'This host cannot send that attachment. Detach it or choose a supported file.'
      : snapshot.sendPreparation.code === 'FENCED' ? 'This preparation is no longer available. Your draft is retained.'
      : 'Send could not be prepared. Your draft is retained.' : '';
  const sendDraft = () => { setError(''); try { void view.sendDraft().catch(() => {}); } catch { setError('Send could not be prepared. Your draft is retained.'); } };
  return h("section", { className: "conversation", "aria-label": snapshot.logical.entry?.metadata.name ?? sessionId },
    h("header", { className: "conversation-heading" }, h("div", null,
      h("h2", null, snapshot.logical.entry?.metadata.name ?? sessionId),
      h("p", { id: "session-status", role: "status" }, `${snapshot.kind} · ${snapshot.session.native?.phase ?? "unknown"} · ${connection}`)),
      h("button", { id: "pin", "aria-pressed": snapshot.logical.pinned, onClick: () => workspace.setPinned(sessionId, !snapshot.logical.pinned) }, snapshot.logical.pinned ? "Unpin" : "Pin")),
    h(AgentControls, { view, snapshot, run: work }),
    h(NativeActions, { snapshot, text: draft, hasFiles: composerState.value.fileIds.length > 0, run: work }),
    snapshot.session.native?.issue ? h('p', { role: 'status', id: 'native-control-issue' }, snapshot.session.native.issue === 'storageUnavailable' ? 'Host storage is unavailable. Send is paused; Stop remains available.' : 'Native control ownership is unconfirmed. Send is paused; the agent has not been proved stopped.') : null,
    snapshot.observation.history === "unavailable" ? h("p", { role: "status" }, "History connection interrupted. Your loaded conversation is retained.") : null,
    snapshot.bindingTransition ? h("p", { id: "binding-status", role: "status" }, snapshot.bindingTransition.state === "preparing" ? "Connecting the resumed session. Your loaded conversation is retained." : "The resumed session is available; its view could not finish connecting.",
      snapshot.bindingTransition.state === "unavailable" ? h("button", { onClick: () => work(rebind) }, "Retry view connection") : null) : null,
    !snapshot.bindingTransition && observedReadyGeneration !== null ? h("p", { role: "status" }, "The native session resumed. Connect its retained view.", h("button", { onClick: () => work(rebind) }, "Retry view connection")) : null,
    snapshot.history.current && snapshot.history.olderEdge.state === "unknown" ? h("p", { role: "status" }, "The earlier history boundary is unknown. Captured conversation updates remain available.",
      h("button", { onClick: () => work(async () => {
        const result = await view.recoverHistory();
        if (result.state === "value" && result.value.status === "unsupported") setError("Earlier history is unavailable from this native host.");
      }) }, "Check missing history")) : null,
    snapshot.history.olderEdge.state === "available" ? h("button", { onClick: () => work(() => view.loadOlder()) }, "Load earlier history") : null,
    h("div", { id: "history", ref: historyElement, className: "history", "aria-label": "Conversation history", onScroll: () => {
      const element = historyElement.current; if (!element || programmaticScroll.current) return;
      const atTail = element.scrollHeight - element.clientHeight - element.scrollTop < 2, direction = element.scrollTop < previousScroll.current ? "earlier" : "later";
      view.viewport.userScroll(direction, atTail); previousScroll.current = element.scrollTop;
      const top = element.getBoundingClientRect().top, row = [...element.querySelectorAll<HTMLElement>("[data-row]")].find(value => value.getBoundingClientRect().bottom > top);
      if (row?.dataset.row) view.viewport.report({ rowId: row.dataset.row, offsetPx: top - row.getBoundingClientRect().top });
    } }, ...snapshot.history.rows.map(row => h("article", { key: row.id, "data-row": row.id, "data-kind": row.kind }, h("small", null, row.kind), h("pre", null, row.body.kind === "unavailable" ? "Content unavailable" : row.body.text),
      ...rowMedia(row).map(media => h('div', { key: media.id, 'data-media': media.id },
        media.state === 'available' && media.artifactId ? h('button', { onClick: () => work(() => openPreview(media.artifactId!)) }, 'Preview agent image') : h('small', null, `Agent image · ${media.state}`)))))),
    h("div", { className: "files" }, ...snapshot.files.map(file => h("div", { key: file.key },
      h("span", null, `${file.manifest.name} · ${file.phase}`), file.artifact ? h("button", { onClick: () => work(() => openPreview(file.artifact!)) }, "Preview") : null,
      composerState.value.fileIds.includes(file.manifest.id) ? h('button', { onClick: () => { const latest = composer.getSnapshot().value; composer.edit({ ...latest, fileIds: latest.fileIds.filter(id => id !== file.manifest.id) }); } }, `Detach ${file.manifest.name}`)
        : h('button', { onClick: () => { try { const latest = composer.getSnapshot().value; composer.edit({ ...latest, fileIds: [...latest.fileIds, file.manifest.id] }); } catch { setError('The composer attachment limit is full.'); } } }, `Attach ${file.manifest.name}`),
      h('button', { disabled: composerState.value.fileIds.includes(file.manifest.id) || file.operationIds.length > 0, onClick: () => work(() => workspace.clearFile(sessionId, file.manifest.id, file.revision)) }, `Clear local ${file.manifest.name}`)))),
    preview ? h("aside", { "aria-label": "File preview", id: "file-preview" }, preview.preview.kind === "text" ? h("pre", null, preview.preview.text) : preview.preview.kind === "image" ? h("img", { src: preview.preview.url, alt: preview.artifact.name }) : h("p", null, "File available for download")) : null,
    pending ? h("button", { id: "confirmation", onClick: () => { try { setDialog({ id: pending.prompt.id, form: view.form(pending.prompt) }); } catch { setError('This native request is no longer pending.'); } } }, "Agent needs confirmation") : null,
    submittedResponses ? h("p", { role: "status" }, `${submittedResponses} response${submittedResponses === 1 ? "" : "s"} handed to the native client; native completion is not yet confirmed.`) : null,
    dialogItem && dialog ? h(PromptDialog, { key: dialog.id, prompt: dialogItem.prompt, form: dialog.form, disabled: !snapshot.session.connected || snapshot.confirmationsStale, respond: view.respond, onLater: () => setDialog(null),
      onResult: (capability, result) => { void result.catch(() => {}).then(() => setDialog(current => current?.id === capability ? null : current)); } }) : null,
    h("form", { onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); void sendDraft(); } },
      h("label", { htmlFor: "message" }, "Message"),
      h("textarea", { id: "message", value: draft, disabled: composerState.state === 'loading' || composerState.state === 'disposed', onChange: (event: { currentTarget: HTMLTextAreaElement }) => composer.edit({ ...composer.getSnapshot().value, text: event.currentTarget.value }), placeholder: "Message this agent" }),
      composerState.state === 'unavailable' ? h('p', { role: 'status', id: 'composer-storage' }, 'Browser draft storage is unavailable. Your current draft is retained; Send is paused.') : h('p', { role: 'status', id: 'composer-storage' }, preparing ? 'Preparing your message and attachments…' : composerState.state === 'saving' || composerState.state === 'dirty' ? 'Saving draft…' : 'Draft saved'),
      h("div", { className: "composer-actions" }, h("button", { id: "send", type: "submit", disabled: !!snapshot.session.native?.issue || preparing || composerState.state === 'unavailable' || composerState.state === 'loading' || !actions.send || !draft.trim() && !composerState.value.fileIds.length || !snapshot.session.connected }, "Send"),
        h("input", { id: "file-input", ref: fileInput, type: "file", "aria-label": "Choose a file", onChange: () => work(async () => {
          const file = fileInput.current?.files?.[0]; if (!file) return;
          let blob: Blob = file, name = file.name, mediaType = file.type;
          if (imageType(new Uint8Array(await file.arrayBuffer())) === 'image/svg+xml') { const converted = await svgInputToPng(file); blob = converted.blob; name = `${file.name.replace(/\.svg$/i, '')}.png`; mediaType = 'image/png'; }
          const record = await workspace.saveFile(sessionId, { name, mediaType, blob }); await workspace.uploadFile(sessionId, record.manifest.id);
          const latest = composer.getSnapshot().value; composer.edit({ ...latest, fileIds: [...latest.fileIds, record.manifest.id] }); await composer.flush();
        }) }),
        h("button", { id: "stop", type: "button", disabled: !snapshot.session.connected, onClick: () => { setError(""); try { void actions.stop().result.catch(() => {}); } catch { setError("Stop is unavailable in this view."); } } }, "Stop"),
        h("button", { id: "resume", type: "button", disabled: snapshot.session.native?.phase !== "stopped", onClick: () => { setError(""); try { void actions.resume().result.catch(() => {}); } catch { setError("Resume is unavailable in this view."); } } }, "Resume"))),
    ...visibleOperations.map(operation => h("div", { key: operation.id, id: operation === latest ? "latest-action" : undefined, className: "original-action", role: "status" }, `${operation === latest ? "Latest send" : operation.type === "send" ? "Earlier send" : `${operation.type} request`}: ${actionStatus(operation)}`,
      operation.outcome?.completedSubsteps?.length ? h('details', null, h('summary', null, 'Applied settings'), h('ul', null, ...operation.outcome.completedSubsteps.map(step => h('li', { key: step }, step.replace('copilot.', ''))))) : null,
      unobserved(operation.state) ? h("button", { onClick: () => work(() => workspace.checkReceipt(sessionId, operation.id)) }, `Check original ${operation.type}`) : null)),
    error || preparationError ? h("p", { key: "view-error", role: "alert" }, error || preparationError) : null,
    h("details", { key: "tools" }, h("summary", null, "Tools"), h("button", { id: "refresh-mcp", onClick: () => work(() => workspace.refreshMcp(sessionId)) }, "Refresh tool connections"),
      h("p", { id: "mcp-status" }, snapshot.mcp ? `${snapshot.mcp.servers.length} configured servers · ${snapshot.mcp.freshness}` : "Not observed")));
}

function Opening({ control, sessionId }: Readonly<{ control: CreationControl; sessionId: string }>) {
  const state = useSyncExternalStore(control.subscribe, control.getSnapshot, control.getSnapshot), [error, setError] = useState("");
  if (!state) return h("p", { role: "status" }, "Workspace closed");
  const phase = state.native?.phase;
  const stop = state.operations.filter(value => value.type === "stop").at(-1);
  return h("div", { "aria-label": "Opening agent controls" },
    h("p", { role: "status" }, phase === "stopped" ? "Agent stopped. The original creation outcome is retained separately." : phase === "stopping" ? "Stopping the agent; waiting for the Host's full Stop proof." : phase ? `Agent ${phase}. The original Create is retained.` : "Waiting for Host status. The original Create is retained."),
    h("button", { id: `stop-opening-${sessionId}`, disabled: !state.connected || !state.native || phase === "stopped" || state.native.stopRequested, onClick: () => {
      setError(""); try { void workspace.stopCreation(sessionId).result.catch(() => setError("Stop outcome is not yet observed. Check the original action.")); } catch { setError("The Host's Stop control is not yet available."); }
    } }, "Stop opening agent"),
    stop && !["acknowledged", "refused"].includes(stop.state) ? h("button", { onClick: () => { void workspace.checkReceipt(sessionId, stop.id).catch(() => setError("The original Stop receipt is still unavailable.")); } }, "Check original Stop") : null,
    error ? h("p", { role: "status" }, error) : null);
}

function Application() {
  const [views, setViews] = useState<Readonly<Record<string, WorkspaceView>>>({}), [selected, setSelected] = useState("main"), [error, setError] = useState("");
  const [catalogReady, setCatalogReady] = useState(false);
  const [creations, setCreations] = useState<Readonly<Record<string, string>>>({});
  const [controls, setControls] = useState<Readonly<Record<string, CreationControl>>>({});
  const selectionIntent = useRef("main");
  const openCreated = async (id: string) => {
    const view = await workspace.open(id); openedViews.set(id, view); setViews(previous => ({ ...previous, [id]: view })); if (selectionIntent.current === id) setSelected(id);
  };
  const checkCreation = async (id: string) => {
    setError(""); const result = await workspace.checkCreation(id);
    setCreations(previous => ({ ...previous, [id]: result?.state ?? "outcomeUnknown" }));
    if (result?.binding) await openCreated(id);
  };
  const create = async (id: string) => {
    setError(""); setCreations(previous => ({ ...previous, [id]: "dispatching" }));
    const target = configuration.targets.find(value => value.session === id)!;
    const pending = workspace.create({ scope: configuration.scope, id: `create-${id}`, session: id, target: { host: target.host, owner: target.owner, kind: id === "main" ? "codex" : "copilot", placement: "dedicated" }, metadata: { name: id === "main" ? "Conversation A" : "Conversation B", cwd: null } });
    try { const control = workspace.prepareCreation(id); setControls(previous => ({ ...previous, [id]: control })); } catch { /* Original Create result owns validation. */ }
    const result = await pending;
    setCreations(previous => ({ ...previous, [id]: result.state }));
    if (result.entry.binding) await openCreated(id);
  };
  const refreshConversations = async () => {
    const listing = await workspace.refreshCatalog();
    for (const { entry } of listing.rows) {
      if (!['main', 'peer'].includes(entry.session)) continue;
      if (entry.binding) await openCreated(entry.session);
      else setCreations(previous => ({ ...previous, [entry.session]: 'catalogPending' }));
    }
    setCatalogReady(true);
  };
  const failure = (error: unknown) => { diagnosticFailures.push(String(error)); setError("Session creation or observation did not complete. The original Create is retained."); };
  useEffect(() => {
    let committed = true;
    const releases = ["main", "peer"].map(id => {
      const changed = (status: CreationStatus | null) => {
        if (!committed || !status) return;
        setCreations(previous => previous[id] === status.state ? previous : { ...previous, [id]: status.state });
        if (status.binding && !openedViews.has(id)) void openCreated(id).catch(error => { if (committed) failure(error); });
      };
      const release = workspace.subscribeCreation(id, changed); changed(workspace.creationStatus(id)); return release;
    });
    return () => { committed = false; releases.forEach(release => release()); };
  }, []);
  useEffect(() => { let committed = true; void workspace.refreshCatalog().then(async listing => {
    if (!committed) return;
    for (const { entry } of listing.rows) {
      if (!committed || !['main', 'peer'].includes(entry.session)) continue;
      if (entry.binding) await openCreated(entry.session); else setCreations(previous => ({ ...previous, [entry.session]: 'catalogPending' }));
    }
    if (committed) setCatalogReady(true);
  }).catch(() => { if (committed) setError('The conversation catalog is unavailable. Refresh conversations before creating one.'); }); return () => { committed = false; }; }, []);
  return h("main", null, h("header", { className: "workspace-heading" }, h("div", null, h("h1", null, "Multiplex V8"), h("p", null, "Local workspace · scripted agents")),
    h("nav", { "aria-label": "Connection" }, h("button", { id: "disconnect", onClick: () => workspace.disconnect() }, "Disconnect"), h("button", { id: "reconnect", onClick: () => workspace.reconnect() }, "Reconnect"), h('button', { onClick: () => { void refreshConversations().catch(failure); } }, 'Refresh conversations'))),
    h("div", { className: "layout" }, h("aside", { className: "sessions", "aria-label": "Sessions" }, h("h2", null, "Conversations"),
      ...["main", "peer"].map(id => h("div", { key: id },
        h("button", { id: `session-${id}`, disabled: !catalogReady, "aria-pressed": selected === id && !!views[id], onClick: () => { selectionIntent.current = id; if (views[id]) setSelected(id); else void (creations[id] === 'catalogPending' ? refreshConversations() : creations[id] ? checkCreation(id) : create(id)).catch(failure); } }, views[id] ? id === "main" ? "Conversation A" : "Conversation B" : `${creations[id] ? "Check" : "Create"} ${id === "main" ? "Codex" : "Copilot"} ${creations[id] ? "creation" : "conversation"}`),
        creations[id] && !views[id] ? controls[id] ? h(Opening, { control: controls[id]!, sessionId: id }) : h("p", { role: "status" }, creations[id] === "refused" ? "Creation refused" : "Agent creation remains active or unobserved. Check the original Create.") : null))),
    views[selected] ? h(Conversation, { key: selected, view: views[selected]!, sessionId: selected }) : h("section", null, h("h2", null, "Start a conversation"), h("p", null, "Create a session to begin."))), error ? h("p", { role: "alert" }, error) : null);
}
const element = document.getElementById("app"); if (!element) throw Error("Application root is missing");
const root = createRoot(element); root.render(h(StrictMode, null, h(Application)));
Object.assign(window, { applicationReady: true, applicationTest: {
  snapshot: (id: string) => openedViews.get(id)?.getSnapshot(), dropNextReply: () => { dropReply = true; },
  failures: () => [...diagnosticFailures],
  close: () => { workspace.close(); root.unmount(); }, dispose: () => workspace.close(),
} });
