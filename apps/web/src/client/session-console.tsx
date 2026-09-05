import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowDown,
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Code2,
  CornerDownRight,
  History,
  ImagePlus,
  LoaderCircle,
  MessageSquareText,
  Radio,
  Send,
  Settings2,
  Sparkles,
  TerminalSquare,
  UserRound,
  X,
} from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import * as Tabs from "@radix-ui/react-tabs";
import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type UIEvent,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  sessionCommand,
  imageMessage,
  imageTarget,
  uploadImage,
  watchAccess,
  type AccessClient,
} from "@arduano/agent-multiplex-client/browser";
import type {
  AccessStreamItem,
  CommandRecord,
  CommandEnvelope,
  ImageDescriptor,
  ImageMediaType,
  HarnessCommand,
  HarnessSessionSettings,
  SessionRecord,
} from "@arduano/agent-multiplex-protocol";

import {
  appliedSettingsSummary,
  createSettingDraft,
  editSettingDraft,
  preferredModel,
  reconcileSettingDraft,
  type SettingDraft,
} from "./agent-settings.js";
import { errorMessage, useApi } from "./api.js";
import { ImageSessionProvider, TranscriptImagePreview, prepareImageFile, isLocalImagePath, modelImageLimits } from "./image-media.js";
import { pendingInteractionRefetchInterval } from "./interaction-refresh.js";
import { InteractionCards } from "./interactions.js";
import {
  advanceNativeHistorySignal,
  nativeHistoryInitiallyReady,
  retryNativeHistory,
  sessionBindingIdentity,
  type NativeHistorySignal,
} from "./native-history.js";
import {
  applyNativeEvent,
  entriesFromHistory,
  mergeTimeline,
  type TimelineEntry,
} from "./transcript.js";
import type { TerminalSideChannelCapability } from "./terminal-state.js";
import { Badge, Button, EmptyState, Select, Textarea, classes } from "./ui.js";

const TerminalPanel = lazy(async () => {
  const module = await import("./terminal-panel.js");
  return { default: module.TerminalPanel };
});

interface CommandAction {
  readonly request: HarnessCommand;
  readonly success: string;
  readonly optimistic?: TimelineEntry;
  readonly images?: CommandEnvelope["images"];
  readonly envelope?: CommandEnvelope;
}

interface DraftImage { id: string; file: File; url: string; descriptor?: ImageDescriptor; }

export function SessionConsole({ session, terminalCapability }: {
  readonly session: SessionRecord | null;
  readonly terminalCapability: TerminalSideChannelCapability | null | undefined;
}) {
  const { connectionKey } = useApi();
  const bindingIdentity = session ? sessionBindingIdentity(session) : "no-session";
  return (
    <BoundSessionConsole
      key={`${connectionKey}:${bindingIdentity}`}
      session={session}
      bindingIdentity={bindingIdentity}
      terminalCapability={terminalCapability}
    />
  );
}

function BoundSessionConsole({ session, bindingIdentity, terminalCapability }: {
  readonly session: SessionRecord | null;
  readonly bindingIdentity: string;
  readonly terminalCapability: TerminalSideChannelCapability | null | undefined;
}) {
  const { client, connectionKey } = useApi();
  const queryClient = useQueryClient();
  const [history, setHistory] = useState<TimelineEntry[]>([]);
  const [live, setLive] = useState<TimelineEntry[]>([]);
  const [local, setLocal] = useState<TimelineEntry[]>([]);
  const [streamState, setStreamState] = useState("stopped");
  const [historyState, setHistoryState] = useState(
    session ? (nativeHistoryInitiallyReady(session) ? "loading" : "waiting") : "idle",
  );
  const [historyError, setHistoryError] = useState("");
  const [historySignal, setHistorySignal] = useState<NativeHistorySignal | null>(null);
  const [recentEvents, setRecentEvents] = useState<AccessStreamItem[]>([]);
  const [prompt, setPrompt] = useState("");
  const [draftImages, setDraftImages] = useState<DraftImage[]>([]);
  const draftsRef = useRef(draftImages);
  draftsRef.current = draftImages;
  const mounted = useRef(true);
  const preparing = useRef(false);
  const [preparingImages, setPreparingImages] = useState(false);
  const imagePicker = useRef<HTMLInputElement>(null);
  const imageUpload = useRef<AbortController | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uncertain, setUncertain] = useState<CommandEnvelope | null>(null);
  useEffect(() => { mounted.current = true; return () => {
    mounted.current = false;
    imageUpload.current?.abort();
    for (const image of draftsRef.current) URL.revokeObjectURL(image.url);
  }; }, []);
  const [actionStatus, setActionStatus] = useState("");
  const [modelDraft, setModelDraft] = useState<SettingDraft>(() =>
    createSettingDraft(session?.harnessSettings?.model ?? "")
  );
  const [modeDraft, setModeDraft] = useState<SettingDraft>(() =>
    createSettingDraft(
      session?.harnessSettings?.mode ?? "",
      session?.harness === "copilot" ? "interactive" : "default",
    )
  );
  const [effortDraft, setEffortDraft] = useState<SettingDraft>(() =>
    createSettingDraft(session?.harnessSettings?.effort ?? "", "medium")
  );
  const [workspaceView, setWorkspaceView] = useState<"chat" | "terminal">("chat");
  const [unreadCount, setUnreadCount] = useState(0);
  const transcript = useRef<HTMLDivElement>(null);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const nearTranscriptEnd = useRef(true);
  const forceFollow = useRef(true);
  const previousTimelineLength = useRef(0);
  const previousTailSignature = useRef("");
  const historyGeneration = session && historySignal?.bindingIdentity === bindingIdentity
    ? historySignal.generation
    : 0;
  // Codex projects a new logical session slightly before `thread/read` can
  // read that new thread. A summary or terminal native lifecycle event is the
  // first positive signal that the native history endpoint is ready.
  const nativeHistoryReady = Boolean(session) && (
    nativeHistoryInitiallyReady(session!) ||
    (historySignal?.bindingIdentity === bindingIdentity && historySignal.ready)
  );

  const models = useQuery({
    queryKey: ["models", connectionKey, session?.runtimeNodeId, session?.harness],
    enabled: Boolean(session),
    queryFn: () => client.harness.models.query({
      runtimeNodeId: session!.runtimeNodeId,
      harness: session!.harness,
    }),
    staleTime: 30_000,
  });
  const interactions = useQuery({
    queryKey: ["interactions", connectionKey, bindingIdentity],
    enabled: Boolean(session),
    queryFn: () => client.interactions.list.query({
      sessionId: session!.sessionId,
      pendingOnly: true,
    }),
    // Stream invalidation remains the low-latency path. Poll only the selected
    // session as a recovery net for an observer that missed a control event.
    refetchInterval: pendingInteractionRefetchInterval(session?.sessionId),
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    setHistory([]);
    setLive([]);
    setLocal([]);
    setRecentEvents([]);
    setHistorySignal(null);
    setHistoryState(
      session ? (nativeHistoryInitiallyReady(session) ? "loading" : "waiting") : "idle",
    );
    setHistoryError("");
    setStreamState(session ? "connecting" : "stopped");
    setPrompt("");
    setActionStatus("");
    setWorkspaceView("chat");
    setUnreadCount(0);
    nearTranscriptEnd.current = true;
    forceFollow.current = true;
    previousTimelineLength.current = 0;
    previousTailSignature.current = "";
    setModelDraft(createSettingDraft(session?.harnessSettings?.model ?? ""));
    setModeDraft(createSettingDraft(
      session?.harnessSettings?.mode ?? "",
      session?.harness === "copilot" ? "interactive" : "default",
    ));
    setEffortDraft(createSettingDraft(session?.harnessSettings?.effort ?? "", "medium"));
  }, [bindingIdentity, connectionKey]);

  // Establish the native stream before asking the harness for history. The
  // reducer merges stable native IDs, so an event visible in both cannot be lost.
  useEffect(() => {
    if (!session) return;
    const watchedSessionId = session.sessionId;
    const watchedRuntimeEpoch = session.runtimeEpoch;
    const initiallyReady = nativeHistoryInitiallyReady(session);
    let active = true;
    const signalHistory = (cause: "lifecycle" | "reconcile") => {
      if (!active) return;
      setHistorySignal((current) => advanceNativeHistorySignal(
        current,
        bindingIdentity,
        initiallyReady,
        cause,
      ));
    };
    const watcher = watchAccess(client.sessions.watch, {
      sessions: [watchedSessionId],
      includeNative: true,
      maxPendingItems: 2_048,
      onStateChange: (state) => {
        if (!active) return;
        setStreamState(state.state);
        if (state.state === "failed") setActionStatus(errorMessage(state.error));
      },
      onItem: (item) => {
        if (!active) return;
        if (item.kind === "native" && item.sessionId === watchedSessionId) {
          // A logical session may retain its ID across native runtime epochs.
          // Ignore buffered events belonging to another concrete binding.
          if (watchedRuntimeEpoch == null || item.runtimeEpoch !== watchedRuntimeEpoch) return;
          setLive((current) => applyNativeEvent(current, item));
          setRecentEvents((current) => [...current, item].slice(-40));
          // A just-spawned Codex thread cannot provide turn history until its
          // first turn completes. Reconcile at native lifecycle boundaries
          // instead of polling an API that truthfully rejects that window.
          if (item.nativeType === "turn/completed" || item.nativeType === "session.idle") {
            signalHistory("lifecycle");
          }
          return;
        }
        if (item.kind === "nativeGap" && item.sessionId === watchedSessionId) {
          signalHistory("reconcile");
          return;
        }
        if (item.kind === "control") {
          setRecentEvents((current) => [...current, item].slice(-40));
          const change = item.change;
          if (change.type.startsWith("session.")) {
            void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          }
          if (change.type === "interaction.changed" && change.interaction.sessionId === watchedSessionId) {
            void queryClient.invalidateQueries({ queryKey: ["interactions"] });
          }
          if (change.type === "metadata.changed" && change.sessionId === watchedSessionId) {
            void queryClient.invalidateQueries({ queryKey: ["metadata"] });
          }
        }
        if (item.kind === "streamReset") {
          signalHistory("reconcile");
        }
      },
    });
    return () => {
      active = false;
      watcher.stop();
    };
  }, [bindingIdentity, client, connectionKey, queryClient]);

  useEffect(() => {
    if (!session) return;
    if (!nativeHistoryReady) {
      setHistoryState("waiting");
      return;
    }
    let current = true;
    setHistoryState("loading");
    void retryNativeHistory(
      () => loadNativeHistory(client, session),
      { active: () => current },
    )
      .then((entries) => {
        if (!current) return;
        setHistory(entries);
        setHistoryState("loaded");
        setHistoryError("");
      })
      .catch((error: unknown) => {
        if (!current) return;
        setHistoryState("failed");
        setHistoryError(`Native history unavailable: ${errorMessage(error)}`);
      });
    return () => { current = false; };
  }, [bindingIdentity, client, connectionKey, historyGeneration, nativeHistoryReady]);

  useEffect(() => {
    setModelDraft((current) => reconcileSettingDraft(
      current,
      session?.harnessSettings?.model ?? "",
      preferredModel(models.data ?? [])?.id ?? "",
    ));
  }, [models.data, session?.harnessSettings?.model]);

  useEffect(() => {
    setModeDraft((current) => reconcileSettingDraft(
      current,
      session?.harnessSettings?.mode ?? "",
      session?.harness === "copilot" ? "interactive" : "default",
    ));
    setEffortDraft((current) => reconcileSettingDraft(
      current,
      session?.harnessSettings?.effort ?? "",
      "medium",
    ));
  }, [session?.harness, session?.harnessSettings?.effort, session?.harnessSettings?.mode]);

  const mutation = useMutation({
    retry: false,
    mutationFn: async (action: CommandAction) => {
      if (!session) throw new Error("Select a session first");
      const envelope = action.envelope ?? await sessionCommand(session, action.request, action.images);
      setUncertain(envelope);
      if (action.optimistic && !action.envelope) {
        setLocal((current) => [...current, { ...action.optimistic!, id: `local:${envelope.commandId}` }]);
      }
      const record = await client.sessions.execute.mutate(envelope);
      if (record.state !== "outcomeUnknown" && record.state !== "received" && record.state !== "started") setUncertain(null);
      return { action, record };
    },
    onSuccess: ({ action, record }) => {
      setActionStatus(commandStatus(action.success, record));
      if (record.state === "succeeded" && (action.request.command.type === "send" || action.request.command.type === "steer")) {
        setPrompt("");
        for (const image of draftsRef.current) URL.revokeObjectURL(image.url);
        setDraftImages([]);
      }
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
    onError: (error) => setActionStatus(errorMessage(error)),
  });

  const nativeTimeline = useMemo(() => mergeTimeline(history, live), [history, live]);
  const timeline = useMemo(() => {
    const unreconciled = local.filter((candidate) => !nativeTimeline.some((entry) =>
      entry.kind === candidate.kind && entry.body === candidate.body &&
      (candidate.images ?? []).length === (entry.images ?? []).length &&
      (candidate.images ?? []).every((image, index) => image.image && !("unavailable" in image.image) &&
        entry.images?.[index]?.image && !("unavailable" in entry.images[index]!.image!) &&
        image.image.sha256 === (entry.images[index]!.image as ImageDescriptor).sha256),
    ));
    return mergeTimeline(nativeTimeline, unreconciled);
  }, [local, nativeTimeline]);

  useEffect(() => {
    const tail = timeline.at(-1);
    const tailSignature = tail
      ? `${tail.id}:${tail.body.length}:${tail.status ?? ""}:${tail.pending ? "pending" : "settled"}`
      : "";
    const added = Math.max(0, timeline.length - previousTimelineLength.current);
    const tailChanged = Boolean(previousTailSignature.current) && previousTailSignature.current !== tailSignature;
    previousTimelineLength.current = timeline.length;
    previousTailSignature.current = tailSignature;
    if (forceFollow.current || nearTranscriptEnd.current) {
      const frame = requestAnimationFrame(() => {
        transcriptEnd.current?.scrollIntoView({ block: "end" });
        nearTranscriptEnd.current = true;
        forceFollow.current = false;
        setUnreadCount(0);
      });
      return () => cancelAnimationFrame(frame);
    }
    const unreadAdded = added || (tailChanged ? 1 : 0);
    if (unreadAdded > 0) setUnreadCount((current) => current + unreadAdded);
  }, [timeline.length, timeline.at(-1)?.body]);

  if (!session) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center">
        <EmptyState
          icon={MessageSquareText}
          title="Choose an agent"
          body="Select an active or resumable session from the left rail, or launch a new one."
        />
      </div>
    );
  }

  const active = session.availability === "active";
  const running = session.runtimeStatus === "running";
  const pendingInteractions = interactions.data?.filter((item) => item.state === "pending") ?? [];
  const title = sessionTitle(session);
  const settingsSummary = appliedSettingsSummary(
    session.harness,
    session.harnessSettings,
    models.data ?? [],
  );

  const imageLimits = modelImageLimits(session.harnessSettings?.model
    ? (models.data ?? []).find((model) => model.id === session.harnessSettings?.model)
    : preferredModel(models.data ?? []));

  function dispatch(request: HarnessCommand, success: string, optimistic?: TimelineEntry): void {
    if (uncertain || uploading || mutation.isPending) return;
    setActionStatus("Dispatching command once…");
    mutation.mutate({ request, success, ...(optimistic ? { optimistic } : {}) });
  }

  async function attachImages(files: readonly File[]): Promise<void> {
    if (!active || uploading || mutation.isPending || uncertain || preparing.current) return;
    preparing.current = true;
    setPreparingImages(true);
    try {
      if (imageLimits.support === "unsupported") throw new Error("The applied model does not accept images");
      if (draftsRef.current.length + files.length > imageLimits.count) throw new Error(`Attach at most ${imageLimits.count} images for this model`);
      const prepared = await Promise.all(files.map(prepareImageFile));
      if (!mounted.current) return;
      if (prepared.some((file) => file.size > imageLimits.bytes)) throw new Error(`This model accepts images of at most ${Math.floor(imageLimits.bytes / 1024)} KiB`);
      if (imageLimits.mediaTypes && prepared.some((file) => !imageLimits.mediaTypes!.includes(file.type))) throw new Error("This image type is not supported by the applied model");
      if ([...draftsRef.current.map((item) => item.file), ...prepared].reduce((total, file) => total + file.size, 0) > 50 * 1_024 * 1_024) throw new Error("Image attachments exceed 50 MiB");
      const next = [...draftsRef.current, ...prepared.map((file) => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) }))];
      draftsRef.current = next;
      setDraftImages(next);
      setActionStatus(imageLimits.support === "unknown" ? "Image support is unreported for this model" : "");
    } catch (error) { if (mounted.current) setActionStatus(errorMessage(error)); }
    finally { preparing.current = false; if (mounted.current) setPreparingImages(false); }
  }

  async function send(kind: "send" | "steer"): Promise<void> {
    if (!session || (!prompt.trim() && !draftImages.length) || uploading || uncertain || preparing.current) return;
    if (draftImages.length && (imageLimits.support === "unsupported" || draftImages.length > imageLimits.count ||
      draftImages.some((image) => image.file.size > imageLimits.bytes || imageLimits.mediaTypes && !imageLimits.mediaTypes.includes(image.file.type)))) {
      setActionStatus("Attachments exceed the applied model's image capabilities");
      return;
    }
    forceFollow.current = true;
    setUnreadCount(0);
    const body = prompt.trim();
    let request: HarnessCommand = session.harness === "codex"
      ? kind === "send"
        ? { harness: "codex", command: { type: "send", input: body } }
        : { harness: "codex", command: { type: "steer", input: body } }
      : kind === "send"
        ? { harness: "copilot", command: { type: "send", prompt: body, mode: "enqueue" } }
        : { harness: "copilot", command: { type: "steer", prompt: body, mode: "immediate" } };
    let images: CommandEnvelope["images"];
    let descriptors: ImageDescriptor[] = [];
    if (draftImages.length) {
      const controller = new AbortController();
      imageUpload.current = controller;
      setUploading(true);
      try {
        const runtime = (await client.runtimeNodes.list.query()).find((item) => item.runtimeNodeId === session.runtimeNodeId);
        if (!runtime) throw new Error("The session runtime is unavailable");
        const target = imageTarget(session, runtime);
        for (const draft of draftImages) {
          controller.signal.throwIfAborted();
          const descriptor = draft.descriptor ?? await uploadImage(client, target, new Uint8Array(await draft.file.arrayBuffer()), draft.file.type as ImageMediaType, {
            imageId: draft.id,
            signal: controller.signal,
            onProgress: (sent, total) => setActionStatus(`Uploading ${draft.file.name} · ${Math.round(sent / total * 100)}%`),
          });
          descriptors.push(descriptor);
          setDraftImages((current) => current.map((item) => item.id === draft.id ? { ...item, descriptor } : item));
        }
        const message = imageMessage(session.harness, kind, body, descriptors);
        request = message.request;
        images = message.images;
      } catch (error) {
        setActionStatus(controller.signal.aborted ? "Upload cancelled; your draft is retained" : errorMessage(error));
        return;
      } finally { if (mounted.current) setUploading(false); imageUpload.current = null; }
      if (!mounted.current) return;
    }
    setActionStatus("Dispatching command once…");
    mutation.mutate({ request, images, success: kind === "send" ? "Message sent" : "Steering message sent", optimistic: {
      id: "local:pending",
      kind: "user",
      title: kind === "send" ? "You" : "You · steer",
      body,
      timestamp: new Date().toISOString(),
      raw: { local: true, kind },
      sequence: 2_000_000_000 + Date.now(),
      pending: true,
      images: descriptors.map((image) => ({ image })),
    } });
  }

  function keyboardSend(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (!mutation.isPending && !uploading && active && (prompt.trim() || draftImages.length)) void send("send");
  }

  function trackTranscriptPosition(event: UIEvent<HTMLDivElement>): void {
    const element = event.currentTarget;
    const isNearEnd = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    nearTranscriptEnd.current = isNearEnd;
    if (isNearEnd) setUnreadCount(0);
  }

  function jumpToLatest(): void {
    forceFollow.current = false;
    nearTranscriptEnd.current = true;
    setUnreadCount(0);
    transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }

  return (
    <ImageSessionProvider session={session}><Tabs.Root
      className="flex min-h-0 flex-1 flex-col"
      value={workspaceView}
      onValueChange={(value) => setWorkspaceView(value as "chat" | "terminal")}
      data-testid="session-console"
    >
      <header className="flex min-h-[72px] flex-col items-stretch justify-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-shell)] px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3 sm:px-5 [@media(max-height:500px)]:min-h-12 [@media(max-height:500px)]:py-1">
        <div className="min-w-0 sm:flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-sm font-semibold text-[var(--text-primary)]" title={title}>{title}</h1>
            <Badge tone={session.harness === "codex" ? "brand" : "good"}>{session.harness}</Badge>
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-[var(--text-secondary)] [@media(max-height:500px)]:hidden">
            <span className="truncate font-mono" title={session.cwd ?? undefined}>{session.cwd ?? "Workspace unavailable"}</span>
            <span aria-hidden="true">·</span>
            <span className="max-w-40 shrink truncate font-mono" title={session.sessionId} data-testid="selected-session-id">{session.sessionId}</span>
          </div>
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 text-xs text-[var(--text-secondary)] sm:justify-end">
          <Tabs.List
            className="inline-flex h-8 items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-base)] p-0.5"
            aria-label="Session workspace view"
            data-testid="session-view-tabs"
          >
            <Tabs.Trigger
              value="chat"
              className="inline-flex h-7 items-center gap-1.5 rounded-[4px] px-2.5 font-medium text-[var(--text-secondary)] outline-none transition-colors hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] data-[state=active]:bg-[var(--surface-raised)] data-[state=active]:text-[var(--text-primary)]"
              data-testid="session-chat-tab"
            >
              <MessageSquareText aria-hidden="true" className="size-3.5" />
              Chat
            </Tabs.Trigger>
            <Tabs.Trigger
              value="terminal"
              className="inline-flex h-7 items-center gap-1.5 rounded-[4px] px-2.5 font-medium text-[var(--text-secondary)] outline-none transition-colors hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] data-[state=active]:bg-[var(--surface-raised)] data-[state=active]:text-[var(--text-primary)]"
              data-testid="session-terminal-tab"
            >
              <TerminalSquare aria-hidden="true" className="size-3.5" />
              Terminal
            </Tabs.Trigger>
          </Tabs.List>
          <StatusLabel tone={runtimeTone(session.runtimeStatus)}>{humanizeStatus(session.runtimeStatus)}</StatusLabel>
          <span className="inline-flex items-center gap-1.5" title="Live event stream">
            <Radio aria-hidden="true" className={classes("size-3", streamState === "live" ? "text-[var(--status-live)]" : "text-[var(--text-muted)]")} />
            <span data-testid="stream-status">{streamState}</span>
          </span>
          <span className="inline-flex items-center gap-1.5" title="Harness-native history">
            <History aria-hidden="true" className="size-3.5 text-[var(--text-muted)]" />
            <span data-testid="history-status">{historyState}</span>
          </span>
          {running ? (
            <Button
              className="h-8 min-h-8 px-2.5 py-1 text-xs"
              tone="danger"
              icon={CircleStop}
              disabled={!active || mutation.isPending || uploading || preparingImages || Boolean(uncertain)}
              onClick={() => dispatch(
                session.harness === "codex"
                  ? { harness: "codex", command: { type: "interrupt" } }
                  : { harness: "copilot", command: { type: "interrupt" } },
                "Interrupt requested",
              )}
              data-testid="interrupt-button"
            >
              Interrupt
            </Button>
          ) : null}
        </div>
      </header>

      <Tabs.Content value="chat" className="flex min-h-0 flex-1 flex-col outline-none">
      {historyError ? (
        <p
          className="border-b border-[var(--status-waiting)]/15 bg-[var(--status-waiting)]/[0.06] px-4 py-2 text-xs text-[var(--status-waiting)] sm:px-6"
          role="alert"
          data-testid="history-error"
        >
          {historyError}
        </p>
      ) : null}

      <div className="relative min-h-0 flex-1">
        <div
          ref={transcript}
          className="h-full overflow-x-hidden overflow-y-auto overscroll-contain bg-[var(--surface-canvas)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
          onScroll={trackTranscriptPosition}
          role="region"
          aria-label="Agent conversation"
          tabIndex={0}
          data-testid="chat-transcript"
        >
          {timeline.length === 0 && historyState !== "loading" ? (
            <EmptyState
              icon={Sparkles}
              title="Ready for a prompt"
              body="Messages and native tool activity will appear here as the harness streams them."
            />
          ) : (
            <div className="mx-auto grid w-full min-w-0 max-w-[76ch] grid-cols-[minmax(0,1fr)] gap-5 px-4 py-6 sm:px-6">
              {timeline.map((entry) => <TimelineItem entry={entry} key={entry.id} />)}
              <div ref={transcriptEnd} />
            </div>
          )}
        </div>
        {unreadCount > 0 ? (
          <Button
            className="absolute bottom-3 left-1/2 min-h-8 -translate-x-1/2 rounded-full bg-[var(--surface-raised)] px-3 py-1 text-xs shadow-lg"
            icon={ArrowDown}
            onClick={jumpToLatest}
            data-testid="jump-to-latest"
          >
            Jump to latest · {unreadCount} new
          </Button>
        ) : null}
      </div>

      {pendingInteractions.length > 0 ? (
        <div
          className="max-h-[42vh] overflow-y-auto border-t border-[var(--status-waiting)]/15 bg-[var(--surface-shell)] py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
          role="region"
          aria-label="Pending agent interactions"
          tabIndex={0}
        >
          <InteractionCards interactions={pendingInteractions} />
        </div>
      ) : null}

      <div className="border-t border-[var(--border-subtle)] bg-[var(--surface-shell)] px-3 py-3 sm:px-5 [@media(max-height:500px)]:py-2"
        onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); void attachImages([...event.dataTransfer.files]); } }}>
        <div className={classes("mx-auto max-w-[76ch]", draftImages.length > 0 && "[@media(max-height:500px)]:grid [@media(max-height:500px)]:grid-cols-[auto_minmax(0,1fr)] [@media(max-height:500px)]:items-end [@media(max-height:500px)]:gap-x-3")}>
          {draftImages.length > 0 ? <div className="mb-2 flex max-h-28 gap-2 overflow-x-auto [@media(max-height:500px)]:mb-0 [@media(max-height:500px)]:max-w-28" aria-label="Image attachments" data-testid="image-attachments">
            {draftImages.map((image) => <div className="relative shrink-0" key={image.id}>
              <img className="h-20 w-24 [@media(max-height:500px)]:h-10 rounded border border-[var(--border-subtle)] object-contain" src={image.url} alt={image.file.name} />
              <button className="absolute right-0 top-0 grid size-9 place-items-center rounded bg-[var(--surface-shell)]" disabled={uploading || mutation.isPending || Boolean(uncertain)} aria-label={`Remove ${image.file.name}`} onClick={() => { URL.revokeObjectURL(image.url); setDraftImages((current) => current.filter((item) => item.id !== image.id)); }}><X className="size-4" /></button>
            </div>)}
          </div> : null}
          <div className="relative rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)] transition focus-within:border-[var(--accent)]/40 focus-within:ring-2 focus-within:ring-[var(--accent)]/[0.08]">
            <Textarea
              className="min-h-20 [@media(max-height:500px)]:min-h-16 max-h-48 border-0 bg-transparent pb-11 text-sm leading-6 focus:ring-0"
              rows={1}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={keyboardSend}
              onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); void attachImages(files); } }}
              placeholder={active ? "Message this agent…" : "Resume this session before sending a message"}
              disabled={!active || mutation.isPending || uploading || preparingImages || Boolean(uncertain)}
              data-testid="prompt-input"
            />
            <div className="absolute inset-x-2 bottom-2 flex items-center gap-2">
              <input ref={imagePicker} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" multiple className="hidden" onChange={(event) => { void attachImages([...(event.target.files ?? [])]); event.target.value = ""; }} data-testid="image-file-input" />
              <Button icon={ImagePlus} disabled={!active || mutation.isPending || uploading || preparingImages || Boolean(uncertain) || imageLimits.support === "unsupported"} aria-label="Attach images" title={imageLimits.support === "unsupported" ? "The applied model does not accept images" : "Attach images"} onClick={() => imagePicker.current?.click()} data-testid="attach-images-button" />
              <AgentSettings
                session={session}
                active={active}
                busy={mutation.isPending || uploading || preparingImages || Boolean(uncertain)}
                loadingModels={models.isPending}
                models={models.data ?? []}
                appliedSettings={session.harnessSettings}
                settingsSummary={settingsSummary}
                modelDraft={modelDraft.value}
                modeDraft={modeDraft.value}
                effortDraft={effortDraft.value}
                onModelChange={(value) => setModelDraft(editSettingDraft(
                  value,
                  session.harnessSettings?.model ?? "",
                ))}
                onModeChange={(value) => setModeDraft(editSettingDraft(
                  value,
                  session.harnessSettings?.mode ?? "",
                ))}
                onEffortChange={(value) => setEffortDraft(editSettingDraft(
                  value,
                  session.harnessSettings?.effort ?? "",
                ))}
                onApplyModel={() => dispatch(
                  session.harness === "codex"
                    ? { harness: "codex", command: { type: "setModel", model: modelDraft.value } }
                    : { harness: "copilot", command: { type: "setModel", model: modelDraft.value } },
                  `Model changed to ${modelDraft.value}`,
                )}
                onApplyMode={() => dispatch(
                  session.harness === "codex"
                    ? { harness: "codex", command: { type: "setMode", mode: modeDraft.value } }
                    : { harness: "copilot", command: { type: "setMode", mode: modeDraft.value as "interactive" | "plan" | "autopilot" } },
                  `Mode changed to ${modeDraft.value}`,
                )}
                onApplyEffort={() => dispatch(
                  { harness: "codex", command: { type: "setEffort", effort: effortDraft.value } },
                  `Effort changed to ${effortDraft.value}`,
                )}
              />
              <span className="hidden truncate text-xs text-[var(--text-secondary)] md:inline" title={`Applied: ${settingsSummary}`}>
                {settingsSummary}
              </span>
              <div className="ml-auto flex gap-1.5">
                <Button
                  icon={CornerDownRight}
                  disabled={!active || !running || (!prompt.trim() && !draftImages.length) || mutation.isPending || uploading || preparingImages || Boolean(uncertain)}
                  onClick={() => send("steer")}
                  data-testid="steer-button"
                >
                  Steer
                </Button>
                <Button
                  tone="primary"
                  icon={mutation.isPending ? LoaderCircle : Send}
                  className={mutation.isPending ? "[&_svg]:animate-spin" : undefined}
                  disabled={!active || (!prompt.trim() && !draftImages.length) || mutation.isPending || uploading || preparingImages || Boolean(uncertain)}
                  onClick={() => send("send")}
                  data-testid="send-button"
                >
                  Send
                </Button>
              </div>
            </div>
          </div>
          {uploading ? <button className="col-span-full min-h-9 text-xs text-[var(--accent)]" onClick={() => imageUpload.current?.abort()}>Cancel upload</button> : null}
          {uncertain && !mutation.isPending ? <button className="col-span-full min-h-9 text-xs text-[var(--accent)]" onClick={() => mutation.mutate({ request: uncertain.request, envelope: uncertain, success: "Command reconciled" })} data-testid="reconcile-command">Check the original command</button> : null}
          <div className="col-span-full mt-1.5 flex min-h-6 items-center justify-between gap-3 [@media(max-height:500px)]:mt-0 [@media(max-height:500px)]:min-h-0">
            <p className="min-w-0 truncate text-xs text-[var(--text-secondary)]" role="status" title={actionStatus} data-testid="action-status">{actionStatus}</p>
            <span className="hidden shrink-0 text-xs text-[var(--text-secondary)] sm:inline [@media(max-height:500px)]:hidden">Enter to send · Shift+Enter for newline</span>
          </div>
          <details className="group mt-0.5 text-xs text-[var(--text-secondary)] [@media(max-height:500px)]:hidden">
            <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 py-1 hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/60">
              <ChevronRight aria-hidden="true" className="size-3 transition group-open:rotate-90" />
              Activity diagnostics · {recentEvents.length} recent events
            </summary>
            <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-[var(--border-subtle)] bg-[var(--surface-canvas)] p-3 font-mono text-xs leading-4 text-[var(--text-secondary)]" data-testid="native-events">{JSON.stringify(recentEvents, null, 2)}</pre>
          </details>
        </div>
      </div>
      </Tabs.Content>
      <Tabs.Content value="terminal" className="flex min-h-0 flex-1 flex-col outline-none">
        <Suspense fallback={<p className="grid min-h-52 place-items-center text-sm text-[var(--text-muted)]" role="status">Loading terminal controls…</p>}>
          <TerminalPanel session={session} capability={terminalCapability} />
        </Suspense>
      </Tabs.Content>
    </Tabs.Root></ImageSessionProvider>
  );
}

function TimelineItem({ entry }: { readonly entry: TimelineEntry }) {
  const Icon = entry.kind === "user"
    ? UserRound
    : entry.kind === "assistant"
      ? Bot
      : entry.kind === "reasoning" || entry.kind === "plan"
        ? BrainCircuit
        : entry.kind === "tool"
          ? TerminalSquare
          : entry.kind === "subagent"
            ? Activity
            : Code2;
  const isConversation = entry.kind === "user" || entry.kind === "assistant";
  const isExecution = entry.kind === "reasoning" || entry.kind === "tool" || entry.kind === "subagent" || entry.kind === "raw";
  const isFailed = entry.status === "failed" || entry.status === "error";
  if (isExecution) {
    return (
      <article
        className="relative ml-3 min-w-0 max-w-full border-l border-[var(--border-subtle)] pl-5"
        data-testid="chat-message"
        data-role={entry.kind}
        data-entry-id={entry.id}
      >
        <span className={classes(
          "absolute -left-1 top-3 size-2 rounded-full border border-[var(--surface-canvas)]",
          entry.pending ? "animate-pulse bg-[var(--accent)]" : isFailed ? "bg-[var(--status-error)]" : "bg-[var(--text-muted)]",
        )} />
        <details className="group min-w-0 max-w-full overflow-hidden rounded-md border border-[var(--border-subtle)] bg-[var(--surface-shell)]" open={entry.pending || isFailed}>
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-[var(--text-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]/60">
            <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-[var(--text-muted)] transition group-open:rotate-90" />
            <Icon aria-hidden="true" className="size-3.5 shrink-0 text-[var(--text-muted)]" />
            <span className="min-w-0 flex-1 truncate">{entry.title}</span>
            {entry.status ? <ExecutionStatus status={entry.status} /> : entry.pending ? <ExecutionStatus status="running" /> : <CheckCircle2 aria-label="Completed" className="size-3.5 text-[var(--text-muted)]" />}
          </summary>
          {entry.kind === "tool" || entry.kind === "raw" ? (
            <pre className="max-h-72 max-w-full overflow-auto border-t border-[var(--border-subtle)] px-3 py-2 font-mono text-xs leading-5 text-[var(--text-secondary)]" data-testid={entry.kind === "tool" ? "command-output" : undefined}>{entry.body || "No output"}</pre>
          ) : (
            <div className="whitespace-pre-wrap break-words border-t border-[var(--border-subtle)] px-3 py-2 text-xs leading-5 text-[var(--text-secondary)]">{entry.body || "No details"}</div>
          )}
        </details>
        {entry.images?.map((image, index) => <TranscriptImagePreview key={index} {...image} sourceKey={`${entry.id}:image:${index}`} />)}
      </article>
    );
  }
  return (
    <article
      className={classes(
        "group flex min-w-0 max-w-full gap-3",
        entry.kind === "user" && "justify-end",
      )}
      data-testid="chat-message"
      data-role={entry.kind}
      data-entry-id={entry.id}
    >
      <div className={classes("min-w-0", isConversation ? "max-w-[88%]" : "flex-1")}>
        <div className={classes("mb-1 flex items-center gap-2", entry.kind === "user" && "justify-end")}>
          {entry.kind !== "user" ? <Icon aria-hidden="true" className="size-3.5 text-[var(--text-muted)]" /> : null}
          <span className="text-xs font-medium text-[var(--text-secondary)]">{entry.title}</span>
          {entry.status ? <Badge tone={entry.status === "failed" ? "bad" : entry.pending ? "warn" : "neutral"}>{entry.status}</Badge> : null}
          {entry.pending ? <span className="size-1.5 animate-pulse rounded-full bg-[var(--accent)]" title="Streaming" /> : null}
        </div>
        <div className={classes(
          "min-w-0 break-words text-sm leading-6",
          entry.kind === "user"
            ? "rounded-lg bg-[var(--accent)]/10 px-3.5 py-2.5 text-[var(--text-primary)]"
            : entry.kind === "assistant"
              ? "text-[var(--text-primary)]"
              : entry.kind === "plan"
                ? "rounded-md border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3.5 py-3 text-[var(--text-primary)]"
                : entry.status === "failed"
                  ? "rounded-md border border-[var(--status-error)]/20 bg-[var(--status-error)]/[0.06] px-3 py-2 text-[var(--status-error)]"
                  : "rounded-md border border-[var(--border-subtle)] bg-[var(--surface-shell)] px-3 py-2 text-[var(--text-secondary)]",
        )}>
          {entry.kind === "user" ? (
            <div className="whitespace-pre-wrap">{entry.body || (entry.images?.length ? "" : "…")}</div>
          ) : (
            <MarkdownBody body={entry.body || (entry.images?.length ? "" : "…")} sourceKey={entry.id} />
          )}
          {entry.images?.map((image, index) => <TranscriptImagePreview key={index} {...image} sourceKey={`${entry.id}:image:${index}`} />)}
        </div>
      </div>
    </article>
  );
}

function AgentSettings({
  session,
  active,
  busy,
  loadingModels,
  models,
  appliedSettings,
  settingsSummary,
  modelDraft,
  modeDraft,
  effortDraft,
  onModelChange,
  onModeChange,
  onEffortChange,
  onApplyModel,
  onApplyMode,
  onApplyEffort,
}: {
  readonly session: SessionRecord;
  readonly active: boolean;
  readonly busy: boolean;
  readonly loadingModels: boolean;
  readonly models: readonly { readonly id: string; readonly name?: string | null | undefined }[];
  readonly appliedSettings: HarnessSessionSettings | undefined;
  readonly settingsSummary: string;
  readonly modelDraft: string;
  readonly modeDraft: string;
  readonly effortDraft: string;
  readonly onModelChange: (value: string) => void;
  readonly onModeChange: (value: string) => void;
  readonly onEffortChange: (value: string) => void;
  readonly onApplyModel: () => void;
  readonly onApplyMode: () => void;
  readonly onApplyEffort: () => void;
}) {
  const modelChanged = modelDraft !== (appliedSettings?.model ?? "");
  const modeChanged = modeDraft !== (appliedSettings?.mode ?? "");
  const effortChanged = effortDraft !== (appliedSettings?.effort ?? "");
  const listedModel = models.some((candidate) => candidate.id === modelDraft);
  const codexModes = ["default", "plan"];
  const copilotModes = ["interactive", "plan", "autopilot"];
  const listedModes = session.harness === "codex" ? codexModes : copilotModes;
  const efforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button className="h-8 min-h-8 max-w-48 px-2.5 py-1 text-xs" icon={Settings2} aria-label="Agent settings" data-testid="agent-settings-button">
          <span className="hidden truncate sm:inline">Agent settings</span>
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          side="top"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Agent settings"
          className="z-50 w-[min(360px,calc(100vw-24px))] rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-raised)] p-3 text-[var(--text-primary)] shadow-2xl outline-none data-[state=open]:animate-in"
          data-testid="agent-settings-popover"
        >
          <div className="mb-3">
            <p className="text-xs font-semibold">Applied settings</p>
            <p
              className="mt-0.5 truncate text-xs text-[var(--text-secondary)]"
              title={settingsSummary}
              data-testid="applied-settings-summary"
            >
              {settingsSummary}
            </p>
          </div>
          <div className="grid gap-3">
            <label className="grid gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
              <SettingDraftLabel label="Model" changed={modelChanged} />
              <div className="flex gap-2">
                <Select
                  className="h-9 min-w-0 flex-1 py-1 text-xs"
                  value={modelDraft}
                  onChange={(event) => onModelChange(event.target.value)}
                  disabled={!active || loadingModels || busy}
                  data-testid="model-select"
                >
                  {!models.length ? <option value="">Harness model</option> : null}
                  {modelDraft && !listedModel ? <option value={modelDraft}>{modelDraft} · unavailable</option> : null}
                  {models.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.name ?? candidate.id}</option>)}
                </Select>
                <Popover.Close asChild>
                  <Button className="h-9 py-1 text-xs" disabled={!active || !modelDraft || !modelChanged || busy} onClick={onApplyModel} data-testid="model-button">Apply</Button>
                </Popover.Close>
              </div>
            </label>
            <label className="grid gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
              <SettingDraftLabel label="Mode" changed={modeChanged} />
              <div className="flex gap-2">
                <Select
                  className="h-9 min-w-0 flex-1 py-1 text-xs"
                  value={modeDraft}
                  onChange={(event) => onModeChange(event.target.value)}
                  disabled={!active || busy}
                  data-testid="mode-select"
                >
                  {modeDraft && !listedModes.includes(modeDraft) ? <option value={modeDraft}>{modeDraft} · unavailable</option> : null}
                  {session.harness === "codex" ? (
                    <>
                      <option value="default">Default</option>
                      <option value="plan">Plan</option>
                    </>
                  ) : (
                    <>
                      <option value="interactive">Interactive</option>
                      <option value="plan">Plan</option>
                      <option value="autopilot">Autopilot</option>
                    </>
                  )}
                </Select>
                <Popover.Close asChild>
                  <Button className="h-9 py-1 text-xs" disabled={!active || !modeChanged || busy} onClick={onApplyMode} data-testid="mode-button">Apply</Button>
                </Popover.Close>
              </div>
            </label>
            {session.harness === "codex" ? (
              <label className="grid gap-1.5 text-xs font-medium text-[var(--text-secondary)]">
                <SettingDraftLabel label="Reasoning effort" changed={effortChanged} />
                <div className="flex gap-2">
                  <Select className="h-9 min-w-0 flex-1 py-1 text-xs" value={effortDraft} onChange={(event) => onEffortChange(event.target.value)} disabled={!active || busy} data-testid="effort-select">
                    {effortDraft && !efforts.includes(effortDraft) ? <option value={effortDraft}>{effortDraft} · unavailable</option> : null}
                    {efforts.map((value) => <option key={value}>{value}</option>)}
                  </Select>
                  <Popover.Close asChild>
                    <Button className="h-9 py-1 text-xs" disabled={!active || !effortChanged || busy} onClick={onApplyEffort} data-testid="effort-button">Apply</Button>
                  </Popover.Close>
                </div>
              </label>
            ) : null}
          </div>
          <p className="mt-3 text-xs leading-4 text-[var(--text-secondary)]">Picker changes are drafts. Apply each setting independently; the summary updates after the harness acknowledges it.</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SettingDraftLabel({ label, changed }: { readonly label: string; readonly changed: boolean }) {
  return (
    <span className="flex items-center justify-between gap-2">
      <span>{label}</span>
      {changed ? <span className="font-normal text-[var(--status-waiting)]">Draft</span> : null}
    </span>
  );
}

function MarkdownBody({ body, sourceKey }: { readonly body: string; readonly sourceKey: string }) {
  // ReactMarkdown uses these functions as component types. Keep their identity
  // stable so transcript refreshes preserve image dialogs, blobs, and focus.
  const components = useMemo<Components>(() => ({
    a: ({ node: _node, ...props }) => <a {...props} rel="noreferrer" target="_blank" />,
    img: ({ node, alt, src }) => src && isLocalImagePath(src)
      ? <TranscriptImagePreview path={decodeMarkdownImagePath(src)} alt={alt || "Image"} sourceKey={`${sourceKey}:markdown:${node?.position?.start.offset ?? 0}`} />
      : <span className="inline-flex rounded border border-[var(--border-subtle)] px-2 py-1 text-xs text-[var(--text-secondary)]">{src && /^https?:\/\//i.test(src) ? <a href={src} rel="noreferrer" target="_blank">{alt || "External image"}</a> : alt || "Unsupported image reference"}</span>,
  }), [sourceKey]);
  return (
    <div className="space-y-2 [&_a]:text-[var(--accent)] [&_a]:underline [&_a]:underline-offset-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border-subtle)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-secondary)] [&_code]:rounded [&_code]:bg-[var(--surface-canvas)] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-inherit [&_h1]:mt-4 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_li]:ml-5 [&_li]:pl-1 [&_ol]:list-decimal [&_p]:whitespace-pre-wrap [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-[var(--border-subtle)] [&_pre]:bg-[var(--surface-canvas)] [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:text-xs [&_td]:border [&_td]:border-[var(--border-subtle)] [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-[var(--border-subtle)] [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={components}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}

function decodeMarkdownImagePath(path: string): string {
  try { return decodeURIComponent(path); } catch { return path; }
}

function ExecutionStatus({ status }: { readonly status: string }) {
  const failed = status === "failed" || status === "error";
  const running = status === "running" || status === "inProgress";
  return (
    <span className={classes(
      "shrink-0 text-xs",
      failed ? "text-[var(--status-error)]" : running ? "text-[var(--accent)]" : "text-[var(--text-secondary)]",
    )}>{humanizeStatus(status)}</span>
  );
}

function StatusLabel({ tone, children }: { readonly tone: ReturnType<typeof runtimeTone>; readonly children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={classes(
        "size-1.5 rounded-full",
        tone === "good"
          ? "bg-[var(--status-live)]"
          : tone === "warn"
            ? "bg-[var(--status-waiting)]"
            : tone === "bad"
              ? "bg-[var(--status-error)]"
              : "bg-[var(--text-muted)]",
      )} aria-hidden="true" />
      {children}
    </span>
  );
}

export async function loadNativeHistory(client: AccessClient, session: SessionRecord): Promise<TimelineEntry[]> {
  let cursor: string | undefined;
  let entries: TimelineEntry[] = [];
  const seen = new Set<string>();
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const result = await client.sessions.readNativeHistory.query({
      sessionId: session.sessionId,
      request: session.harness === "codex"
        ? { harness: "codex", includeTurns: true, limit: 100, ...(cursor ? { cursor } : {}) }
        : { harness: "copilot", limit: 100, ...(cursor ? { cursor } : {}) },
    });
    const page = entriesFromHistory(result).map((entry, index) => ({ ...entry, sequence: entries.length + index }));
    entries = mergeTimeline(entries, page);
    if (result.complete || !result.nextCursor) return entries;
    if (seen.has(result.nextCursor)) throw new Error("Native history repeated its cursor");
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw new Error("Native history exceeded the 100-page UI safety limit");
}

function commandStatus(success: string, record: CommandRecord): string {
  if (record.state === "succeeded") return success;
  if (record.state === "outcomeUnknown") {
    return `Outcome unknown for command ${record.commandId}; it will not be retried automatically.`;
  }
  if (record.state === "failed") return `Command failed: ${record.error ?? record.commandId}`;
  return `Command ${record.state}: ${record.commandId}`;
}

function runtimeTone(status: SessionRecord["runtimeStatus"]): "good" | "warn" | "bad" | "neutral" {
  if (status === "idle" || status === "running") return "good";
  if (status === "waitingForInput") return "warn";
  if (status === "error") return "bad";
  return "neutral";
}

function sessionTitle(session: SessionRecord): string {
  const title = session.metadata.values["agent.title"];
  if (typeof title === "string" && title.trim()) return title;
  const summary = record(session.nativeSummary);
  const nativeTitle = summary && (summary.summary ?? summary.title ?? summary.name);
  return typeof nativeTitle === "string" && nativeTitle.trim()
    ? nativeTitle
    : `${session.harness} · ${shortId(session.sessionId)}`;
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function humanizeStatus(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll(/[./_-]+/g, " ")
    .replace(/^\w/, (letter) => letter.toUpperCase());
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
