import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import {
  AlertTriangle,
  CircleStop,
  Eye,
  Keyboard,
  LoaderCircle,
  LockKeyhole,
  Play,
  RefreshCw,
  RotateCcw,
  TerminalSquare,
  UnlockKeyhole,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import {
  acquireTerminalKeyboard,
  terminalBase64ToBytes,
  watchTerminal,
  type TerminalKeyboardHandle,
  type TerminalKeyboardState,
} from "@arduano/agent-multiplex-client/browser";
import {
  newTerminalClientId,
  type SessionRecord,
  type TerminalDescriptor,
  type TerminalDimensions,
  type TerminalLeaseId,
  type TerminalLeaseSummary,
  type TerminalOpenResult,
  type TerminalTarget,
} from "@arduano/agent-multiplex-protocol";

import { errorMessage, useApi } from "./api.js";
import {
  mergeTerminalLease,
  reconcileTerminalDescriptor,
  shouldQueryTerminal,
  type TerminalSideChannelCapability,
} from "./terminal-state.js";
import { Badge, Button, Dialog, EmptyState, classes } from "./ui.js";
import "@xterm/xterm/css/xterm.css";

const initialDimensions: TerminalDimensions = { columns: 100, rows: 30 };
const terminalStyleNonceMetaName = "agent-multiplex-style-nonce";

type Confirmation =
  | {
      readonly kind: "open";
      readonly reason: Extract<TerminalOpenResult, { status: "confirmationRequired" }>["reason"];
      readonly terminal: TerminalDescriptor;
    }
  | { readonly kind: "terminate" };

export function TerminalPanel({ session, capability }: {
  readonly session: SessionRecord;
  readonly capability: TerminalSideChannelCapability | null | undefined;
}) {
  const { client, connectionKey } = useApi();
  const queryClient = useQueryClient();
  const [terminalClientId] = useState(newTerminalClientId);
  const [streamTerminal, setStreamTerminal] = useState<TerminalDescriptor | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [action, setAction] = useState<"open" | "terminate" | null>(null);
  const [actionError, setActionError] = useState("");
  const target = useMemo<TerminalTarget>(() => ({
    sessionId: session.sessionId,
    runtimeNodeId: session.runtimeNodeId,
    bindingRevision: session.bindingRevision,
  }), [session.bindingRevision, session.runtimeNodeId, session.sessionId]);
  const queryKey = useMemo(
    () => ["terminal", connectionKey, session.sessionId, session.bindingRevision] as const,
    [connectionKey, session.bindingRevision, session.sessionId],
  );
  const active = session.availability === "active";
  const terminalQuery = useQuery({
    queryKey,
    enabled: shouldQueryTerminal(active, capability),
    retry: false,
    queryFn: () => client.terminals.get.query(target),
  });
  const queriedTerminal = terminalQuery.data ?? null;
  const terminal = reconcileTerminalDescriptor(queriedTerminal, streamTerminal);

  useEffect(() => {
    setStreamTerminal(null);
    setConfirmation(null);
    setActionError("");
  }, [queryKey]);

  const updateTerminal = useCallback((next: TerminalDescriptor | null) => {
    setStreamTerminal(next);
    queryClient.setQueryData(queryKey, next);
  }, [queryClient, queryKey]);

  // Lease mutations carry only lease state. Merge that field into the newest
  // streamed descriptor instead of spreading a render-time descriptor that
  // may already be behind output, resize, or exit events.
  const updateTerminalLease = useCallback((
    terminalId: TerminalDescriptor["terminalId"],
    lease: TerminalLeaseSummary | null,
  ) => {
    const cached = queryClient.getQueryData<TerminalDescriptor | null>(queryKey) ?? null;
    setStreamTerminal((current) => mergeTerminalLease(
      current ?? (cached?.terminalId === terminalId ? cached : null),
      terminalId,
      lease,
    ));
    queryClient.setQueryData<TerminalDescriptor | null>(queryKey, (current) =>
      mergeTerminalLease(current ?? null, terminalId, lease)
    );
  }, [queryClient, queryKey]);

  async function openTerminal(confirmed?: Extract<Confirmation, { kind: "open" }>): Promise<void> {
    setAction("open");
    setActionError("");
    try {
      const result = await client.terminals.open.mutate({
        ...target,
        terminalClientId,
        dimensions: terminal?.dimensions ?? initialDimensions,
        ...(confirmed ? {
          expectedTerminalId: confirmed.terminal.terminalId,
          confirmForegroundSwitch: confirmed.reason === "foregroundSwitch",
        } : {}),
      });
      if (result.status === "confirmationRequired") {
        setConfirmation({
          kind: "open",
          reason: result.reason,
          terminal: result.terminal,
        });
        // A foreground-switch receipt describes the *other* session's shared
        // Copilot terminal. Never project that descriptor onto this session.
        if (result.reason === "restart") updateTerminal(result.terminal);
        return;
      }
      setConfirmation(null);
      updateTerminal(result.terminal);
    } catch (error) {
      setActionError(`${terminal?.state === "exited" ? "Restart" : "Open"} failed: ${errorMessage(error)}`);
    } finally {
      setAction(null);
    }
  }

  async function terminateTerminal(): Promise<void> {
    if (!terminal) return;
    setAction("terminate");
    setActionError("");
    try {
      const next = await client.terminals.terminate.mutate({
        ...target,
        terminalId: terminal.terminalId,
        terminalClientId,
        expectedTerminalId: terminal.terminalId,
      });
      updateTerminal(next);
      setConfirmation(null);
    } catch (error) {
      setActionError(`Terminate failed: ${errorMessage(error)}`);
    } finally {
      setAction(null);
    }
  }

  if (!active) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="terminal-panel">
        <EmptyState
          icon={TerminalSquare}
          title="Resume before opening a terminal"
          body="Native terminals attach only to active harness sessions. Resume this agent from the session controls first."
        />
      </div>
    );
  }

  if (capability === null) {
    const copilot = session.harness === "copilot";
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="terminal-panel">
        {copilot ? <CopilotWarning terminal={null} /> : null}
        <EmptyState
          icon={LockKeyhole}
          title={copilot ? "Experimental Copilot TUI is off" : "Native terminal is not enabled"}
          body={copilot
            ? "Enable the worker's experimental Copilot UI-server mode and reconnect it before opening a native terminal. Structured chat remains available."
            : "This runtime did not advertise the managed terminal side channel. Restart it with a Codex terminal provider to use the stock TUI here."}
        />
      </div>
    );
  }

  if (terminalQuery.isPending && !terminal) {
    return <div className="flex min-h-0 flex-1 flex-col" data-testid="terminal-panel"><TerminalLoading /></div>;
  }

  if (terminalQuery.isError && !terminal) {
    return (
      <div className="flex min-h-0 flex-1 flex-col" data-testid="terminal-panel">
        {session.harness === "copilot" ? <CopilotWarning terminal={null} /> : null}
        <EmptyState
          icon={LockKeyhole}
          title="Native terminal unavailable"
          body={`${errorMessage(terminalQuery.error)} Check that this runtime supports terminals and that your gateway token includes terminal-view.`}
          action={<Button icon={RefreshCw} onClick={() => void terminalQuery.refetch()}>Try again</Button>}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--surface-canvas)]" data-testid="terminal-panel">
      {session.harness === "copilot" ? <CopilotWarning terminal={terminal} /> : null}
      {!terminal ? (
        <EmptyState
          icon={TerminalSquare}
          title="No native terminal is open"
          body="Opening starts a managed stock harness TUI. It does not replace the structured chat or reconstruct session history."
          action={(
            <Button
              tone="primary"
              icon={action === "open" ? LoaderCircle : Play}
              className={action === "open" ? "[&_svg]:animate-spin" : undefined}
              disabled={action !== null}
              onClick={() => void openTerminal()}
              data-testid="terminal-open-button"
            >
              Open terminal
            </Button>
          )}
        />
      ) : (
        <LiveTerminal
          key={terminal.terminalId}
          target={target}
          terminal={terminal}
          terminalClientId={terminalClientId}
          onTerminal={updateTerminal}
          onLease={updateTerminalLease}
          onRestart={() => void openTerminal()}
          onConfirmTerminate={() => setConfirmation({ kind: "terminate" })}
          actionPending={action !== null}
        />
      )}
      {actionError ? (
        <p className="border-t border-[var(--status-error)]/20 bg-[var(--status-error)]/[0.06] px-4 py-2 text-xs text-[var(--status-error)]" role="alert" data-testid="terminal-error">
          {actionError}
        </p>
      ) : null}
      <TerminalConfirmationDialog
        confirmation={confirmation}
        harness={session.harness}
        busy={action !== null}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => {
          if (confirmation?.kind === "open") void openTerminal(confirmation);
          if (confirmation?.kind === "terminate") void terminateTerminal();
        }}
      />
    </div>
  );
}

function LiveTerminal({
  target,
  terminal,
  terminalClientId,
  onTerminal,
  onLease,
  onRestart,
  onConfirmTerminate,
  actionPending,
}: {
  readonly target: TerminalTarget;
  readonly terminal: TerminalDescriptor;
  readonly terminalClientId: ReturnType<typeof newTerminalClientId>;
  readonly onTerminal: (terminal: TerminalDescriptor) => void;
  readonly onLease: (
    terminalId: TerminalDescriptor["terminalId"],
    lease: TerminalLeaseSummary | null,
  ) => void;
  readonly onRestart: () => void;
  readonly onConfirmTerminate: () => void;
  readonly actionPending: boolean;
}) {
  const { client } = useApi();
  const [keyboardState, setKeyboardState] = useState<TerminalKeyboardState>({ state: "released" });
  const [keyboardBusy, setKeyboardBusy] = useState(false);
  const [terminalError, setTerminalError] = useState("");
  const [terminalStreamState, setTerminalStreamState] = useState("connecting");
  const [takeoverLeaseId, setTakeoverLeaseId] = useState<TerminalLeaseId | null>(null);
  const keyboardRef = useRef<TerminalKeyboardHandle | null>(null);
  const keyboardActive = keyboardState.state === "active" || keyboardState.state === "renewing";
  const occupied = terminal.lease !== null && !keyboardActive;
  const canTakeKeyboard = terminal.state === "running" && terminal.capabilities.write;

  const releaseKeyboard = useCallback(async () => {
    const keyboard = keyboardRef.current;
    keyboardRef.current = null;
    if (!keyboard) return;
    setKeyboardBusy(true);
    try {
      await keyboard.release();
      onLease(terminal.terminalId, null);
    } catch (error) {
      setTerminalError(`Release failed: ${errorMessage(error)} The lease will expire automatically.`);
    } finally {
      setKeyboardState({ state: "released" });
      setKeyboardBusy(false);
    }
  }, [onLease, terminal.terminalId]);

  const takeKeyboard = useCallback(async (forceTerminalLeaseId?: TerminalLeaseId) => {
    setKeyboardBusy(true);
    setTerminalError("");
    try {
      const keyboard = await acquireTerminalKeyboard(client.terminals, {
        target,
        terminalId: terminal.terminalId,
        terminalClientId,
        ...(forceTerminalLeaseId ? { forceTerminalLeaseId } : {}),
        renewIntervalMs: 5_000,
        onStateChange: (next) => {
          setKeyboardState(next);
          if (next.state === "failed") {
            keyboardRef.current = null;
            setTerminalError(`Keyboard lease lost: ${errorMessage(next.error)} Take the keyboard again to continue.`);
          }
        },
      });
      keyboardRef.current = keyboard;
      setKeyboardState(keyboard.state);
      if (keyboard.lease) onLease(terminal.terminalId, keyboard.lease);
    } catch (error) {
      setTerminalError(`Could not take the keyboard: ${errorMessage(error)}`);
      setKeyboardState({ state: "released" });
    } finally {
      setKeyboardBusy(false);
    }
  }, [client.terminals, onLease, target, terminal.terminalId, terminalClientId]);

  useEffect(() => () => {
    const keyboard = keyboardRef.current;
    keyboardRef.current = null;
    if (keyboard) void keyboard.release().catch(() => undefined);
  }, []);

  useEffect(() => {
    const keyboard = keyboardRef.current;
    const leaseId = keyboard?.lease?.terminalLeaseId;
    if (!keyboard || !leaseId) return;
    if (terminal.state === "running" && terminal.lease?.terminalLeaseId === leaseId) return;
    keyboardRef.current = null;
    setKeyboardState({ state: "released" });
    setTerminalError(
      terminal.state === "running"
        ? "Keyboard taken over by another viewer. You are still watching read-only."
        : "Keyboard released because the terminal stopped.",
    );
    // The descriptor stream is authoritative: the runtime has already
    // revoked this credential, so a release RPC can only race into a fenced
    // response. Stop renewal locally without sending a stale mutation.
    keyboard.abandon();
  }, [terminal.lease?.terminalLeaseId, terminal.state]);

  return (
    <>
      <div className="flex min-h-12 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-shell)] px-3 py-2 sm:px-4" data-testid="terminal-toolbar">
        <div className="mr-auto flex min-w-0 items-center gap-2">
          <TerminalSquare aria-hidden="true" className="size-4 shrink-0 text-[var(--text-muted)]" />
          <span className="truncate text-xs font-medium text-[var(--text-primary)]">Native {terminalBackendName(terminal)}</span>
          <TerminalStateBadge terminal={terminal} />
          <span className="hidden truncate font-mono text-xs text-[var(--text-muted)] lg:inline" title={terminal.terminalId}>
            {terminal.terminalId.slice(0, 8)}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {keyboardActive ? (
            <Button
              icon={UnlockKeyhole}
              className="h-8 min-h-8 px-2.5 py-1 text-xs"
              disabled={keyboardBusy}
              onClick={() => void releaseKeyboard()}
              data-testid="terminal-release-keyboard"
            >
              Release keyboard
            </Button>
          ) : canTakeKeyboard ? (
            <Button
              tone="primary"
              icon={keyboardBusy ? LoaderCircle : Keyboard}
              className={classes("h-8 min-h-8 px-2.5 py-1 text-xs", keyboardBusy && "[&_svg]:animate-spin")}
              disabled={keyboardBusy}
              onClick={() => {
                if (terminal.lease) setTakeoverLeaseId(terminal.lease.terminalLeaseId);
                else void takeKeyboard();
              }}
              data-testid="terminal-take-keyboard"
            >
              {occupied ? "Take over" : "Take keyboard"}
            </Button>
          ) : null}
          {terminal.state === "exited" || terminal.state === "error" ? (
            <Button
              icon={RotateCcw}
              className="h-8 min-h-8 px-2.5 py-1 text-xs"
              disabled={actionPending || !terminal.capabilities.restart}
              onClick={onRestart}
              data-testid="terminal-restart-button"
            >
              Restart
            </Button>
          ) : terminal.capabilities.terminate ? (
            <Button
              tone="danger"
              icon={CircleStop}
              className="h-8 min-h-8 px-2.5 py-1 text-xs"
              disabled={actionPending}
              onClick={onConfirmTerminate}
              data-testid="terminal-terminate-button"
            >
              Terminate
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-2 sm:p-3">
        <div className={classes(
          "relative min-h-0 flex-1 overflow-hidden rounded-md border bg-[#080a0d]",
          keyboardActive ? "border-[var(--accent)]/45" : "border-[var(--border-subtle)]",
        )}>
          <TerminalViewport
            target={target}
            terminal={terminal}
            keyboardRef={keyboardRef}
            keyboardActive={keyboardActive}
            onTerminal={onTerminal}
            onError={setTerminalError}
            onStreamState={setTerminalStreamState}
          />
          {!keyboardActive ? (
            <div className="pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-md border border-[var(--border-subtle)] bg-[var(--surface-shell)]/95 px-2 py-1 text-xs text-[var(--text-secondary)]">
              <Eye aria-hidden="true" className="size-3.5" />
              Read only
            </div>
          ) : null}
        </div>
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 pt-2 text-xs text-[var(--text-muted)]">
          <span role="status" data-testid="terminal-stream-status">
            Stream {terminalStreamState} · {keyboardActive
              ? keyboardState.state === "renewing" ? "Renewing keyboard lease…" : "Keyboard active · raw input goes directly to the TUI"
              : terminal.lease
                ? "Read only · another viewer holds the keyboard"
                : "Read only · take the keyboard to interact"}
          </span>
          <span className="font-mono" data-testid="terminal-dimensions">
            {terminal.dimensions.columns}×{terminal.dimensions.rows}
          </span>
        </div>
        {terminalError ? <p className="px-1 pt-1 text-xs text-[var(--status-error)]" role="alert" data-testid="terminal-viewport-error">{terminalError}</p> : null}
      </div>
      <TakeoverDialog
        open={takeoverLeaseId !== null}
        onOpenChange={(open) => { if (!open) setTakeoverLeaseId(null); }}
        onConfirm={() => {
          const leaseId = takeoverLeaseId;
          setTakeoverLeaseId(null);
          if (leaseId) void takeKeyboard(leaseId);
        }}
      />
    </>
  );
}

function TerminalViewport({
  target,
  terminal,
  keyboardRef,
  keyboardActive,
  onTerminal,
  onError,
  onStreamState,
}: {
  readonly target: TerminalTarget;
  readonly terminal: TerminalDescriptor;
  readonly keyboardRef: RefObject<TerminalKeyboardHandle | null>;
  readonly keyboardActive: boolean;
  readonly onTerminal: (terminal: TerminalDescriptor) => void;
  readonly onError: (message: string) => void;
  readonly onStreamState: (state: string) => void;
}) {
  const { client } = useApi();
  const hostRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XtermTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const lastDimensions = useRef<TerminalDimensions>(terminal.dimensions);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [streamState, setStreamState] = useState("connecting");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const emulator = new XtermTerminal({
      cols: terminal.dimensions.columns,
      rows: terminal.dimensions.rows,
      cursorBlink: false,
      cursorInactiveStyle: "outline",
      disableStdin: true,
      documentOverride: terminalDocumentOverride(),
      fontFamily: '"Geist Mono Variable", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      minimumContrastRatio: 4.5,
      screenReaderMode: true,
      scrollback: 5_000,
      theme: {
        background: "#080a0d",
        foreground: "#dce1e7",
        cursor: "#46b8ff",
        cursorAccent: "#071018",
        selectionBackground: "#2a7199",
        black: "#14181e",
        brightBlack: "#7f8996",
        red: "#f06e78",
        brightRed: "#ff8b94",
        green: "#47c98b",
        brightGreen: "#72dcaa",
        yellow: "#e6ad52",
        brightYellow: "#f1c475",
        blue: "#46b8ff",
        brightBlue: "#79cbff",
        magenta: "#b89cff",
        brightMagenta: "#cdb9ff",
        cyan: "#51c7ce",
        brightCyan: "#78dce2",
        white: "#dce1e7",
        brightWhite: "#f3f4f6",
      },
    });
    const fit = new FitAddon();
    emulator.loadAddon(fit);
    emulator.open(host);
    const textarea = host.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    if (textarea) textarea.setAttribute("aria-label", "Native agent terminal input");
    xtermRef.current = emulator;
    fitRef.current = fit;

    const input = emulator.onData((data) => {
      const keyboard = keyboardRef.current;
      if (!keyboard || (keyboard.state.state !== "active" && keyboard.state.state !== "renewing")) return;
      void keyboard.write(data).catch((error: unknown) => {
        onError(`Terminal input failed: ${errorMessage(error)}`);
      });
    });
    const resize = emulator.onResize(({ cols, rows }) => {
      lastDimensions.current = { columns: cols, rows };
      if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
      resizeTimer.current = setTimeout(() => {
        resizeTimer.current = null;
        const keyboard = keyboardRef.current;
        if (!keyboard || (keyboard.state.state !== "active" && keyboard.state.state !== "renewing")) return;
        void keyboard.resize(lastDimensions.current).catch((error: unknown) => {
          onError(`Terminal resize failed: ${errorMessage(error)}`);
        });
      }, 100);
    });

    return () => {
      if (resizeTimer.current !== null) clearTimeout(resizeTimer.current);
      resizeTimer.current = null;
      resize.dispose();
      input.dispose();
      emulator.dispose();
      xtermRef.current = null;
      fitRef.current = null;
    };
  }, [terminal.terminalId]);

  useEffect(() => {
    const emulator = xtermRef.current;
    if (!emulator) return;
    emulator.options.disableStdin = !keyboardActive;
    emulator.options.cursorBlink = keyboardActive;
    if (!keyboardActive) {
      if (
        emulator.cols !== terminal.dimensions.columns ||
        emulator.rows !== terminal.dimensions.rows
      ) emulator.resize(terminal.dimensions.columns, terminal.dimensions.rows);
      return;
    }
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!fit || !host) return;
    const fitNow = () => {
      try { fit.fit(); } catch { /* The viewport may be between layouts. */ }
    };
    const frame = requestAnimationFrame(() => {
      fitNow();
      emulator.focus();
    });
    const observer = new ResizeObserver(fitNow);
    observer.observe(host);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [keyboardActive, terminal.dimensions.columns, terminal.dimensions.rows]);

  useEffect(() => {
    const emulator = xtermRef.current;
    if (!emulator) return;
    let active = true;
    const write = (bytes: Uint8Array): Promise<void> => new Promise((resolve) => {
      if (!active) { resolve(); return; }
      emulator.write(bytes, resolve);
    });
    const watcher = watchTerminal(client.terminals.attach, {
      target,
      terminalId: terminal.terminalId,
      maxPendingItems: 2_048,
      onStateChange: (state) => {
        if (!active) return;
        setStreamState(state.state);
        onStreamState(state.state);
        if (state.state === "failed") onError(`Terminal stream stopped: ${errorMessage(state.error)} Reopen this view to retry.`);
      },
      onItem: async (item) => {
        if (!active) return;
        if (item.kind === "reset") {
          emulator.reset();
          emulator.clear();
          onTerminal(item.terminal);
          await write(terminalBase64ToBytes(item.screenBase64));
          // A reset is the authoritative current screen for a newly attached
          // or recovered viewer. xterm can leave a serialized scrollback
          // snapshot at its oldest viewport position, which makes fresh live
          // output appear missing even though it was delivered. Start at the
          // live edge once; subsequent user scrolling keeps normal xterm
          // follow semantics and is never forced back to the bottom here.
          if (active) emulator.scrollToBottom();
          return;
        }
        if (item.kind === "output") {
          await write(terminalBase64ToBytes(item.dataBase64));
          return;
        }
        if (item.kind === "changed") onTerminal(item.terminal);
      },
    });
    return () => {
      active = false;
      watcher.stop();
    };
  }, [client.terminals.attach, onError, onStreamState, onTerminal, target, terminal.terminalId]);

  return (
    <div className="h-full min-h-0 w-full overflow-auto p-2" data-stream-state={streamState} data-testid="terminal-viewport">
      <div ref={hostRef} className="terminal-xterm h-full min-h-[180px] min-w-max" />
      <span className="sr-only" aria-live="polite">Terminal stream {streamState}</span>
    </div>
  );
}

/**
 * xterm creates its dimension and theme styles at runtime. Give only those
 * elements the server-issued CSP nonce while preserving real Document
 * identity, which xterm checks with `instanceof Document`.
 */
function terminalDocumentOverride(): Document {
  const nonce = document.querySelector<HTMLMetaElement>(
    `meta[name="${terminalStyleNonceMetaName}"]`,
  )?.content;
  if (!nonce) return document;

  const createElement = ((tagName: string, options?: ElementCreationOptions) => {
    const element = document.createElement(tagName, options);
    if (tagName.toLowerCase() === "style") element.setAttribute("nonce", nonce);
    return element;
  }) as Document["createElement"];

  return new Proxy(document, {
    get(target, property) {
      if (property === "createElement") return createElement;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function"
        ? (value as (...args: readonly unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

function TerminalConfirmationDialog({ confirmation, harness, busy, onCancel, onConfirm }: {
  readonly confirmation: Confirmation | null;
  readonly harness: SessionRecord["harness"];
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const restarting = confirmation?.kind === "open" && confirmation.reason === "restart";
  const switching = confirmation?.kind === "open" && confirmation.reason === "foregroundSwitch";
  const terminating = confirmation?.kind === "terminate";
  const title = restarting
    ? "Restart native terminal?"
    : switching
      ? "Switch the shared Copilot TUI?"
      : "Terminate native terminal?";
  const description = restarting
    ? "The exited terminal will be replaced with a fresh managed TUI. Its previous screen buffer is ephemeral."
    : switching
      ? "Copilot exposes one experimental TUI per runtime scope. Switching foreground will revoke its current keyboard lease and disconnect viewers of the previous session."
      : `This stops the managed ${harness === "codex" ? "Codex TUI only; structured chat stays available" : "native TUI"}.`;
  return (
    <DialogPrimitive.Root open={Boolean(confirmation)} onOpenChange={(open) => { if (!open) onCancel(); }}>
      <Dialog title={title} description={description} testId="terminal-confirm-dialog">
        <div className="flex flex-col-reverse gap-2 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
          <DialogPrimitive.Close asChild><Button disabled={busy}>Cancel</Button></DialogPrimitive.Close>
          <Button tone={terminating ? "danger" : "primary"} disabled={busy} onClick={onConfirm}>
            {busy ? "Working…" : restarting ? "Restart" : switching ? "Switch foreground" : "Terminate"}
          </Button>
        </div>
      </Dialog>
    </DialogPrimitive.Root>
  );
}

function TakeoverDialog({ open, onOpenChange, onConfirm }: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <Dialog
        title="Take over the keyboard?"
        description="Another viewer holds raw terminal input. Taking over revokes their lease immediately; they can continue watching read-only."
        testId="terminal-takeover-dialog"
      >
        <div className="flex flex-col-reverse gap-2 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
          <DialogPrimitive.Close asChild><Button>Cancel</Button></DialogPrimitive.Close>
          <Button tone="primary" icon={Keyboard} onClick={onConfirm}>Take over</Button>
        </div>
      </Dialog>
    </DialogPrimitive.Root>
  );
}

function CopilotWarning({ terminal }: { readonly terminal: TerminalDescriptor | null }) {
  return (
    <div className="flex items-start gap-2 border-b border-[var(--status-waiting)]/20 bg-[var(--status-waiting)]/[0.05] px-4 py-2 text-xs leading-5 text-[var(--status-waiting)]" role="note" data-testid="copilot-terminal-warning">
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Experimental Copilot TUI{terminal?.sharing === "adapterScope" ? " · shared by this runtime" : ""}. It may be unavailable unless explicitly enabled on the worker, and switching sessions changes its single foreground.
      </span>
    </div>
  );
}

function TerminalStateBadge({ terminal }: { readonly terminal: TerminalDescriptor }) {
  const tone = terminal.state === "running"
    ? "good"
    : terminal.state === "starting"
      ? "warn"
      : terminal.state === "error"
        ? "bad"
        : "neutral";
  return <Badge tone={tone}>{terminal.state}</Badge>;
}

function TerminalLoading() {
  return (
    <div className="grid min-h-52 flex-1 place-items-center px-6 text-center" role="status">
      <div>
        <LoaderCircle aria-hidden="true" className="mx-auto size-5 animate-spin text-[var(--accent)]" />
        <p className="mt-3 text-sm font-medium text-[var(--text-primary)]">Checking native terminal</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">Nothing will be started automatically.</p>
      </div>
    </div>
  );
}

function terminalBackendName(terminal: TerminalDescriptor): string {
  if (terminal.backend === "codex-remote") return "Codex TUI";
  if (terminal.backend === "copilot-ui-server") return "Copilot TUI";
  return "mock terminal";
}
