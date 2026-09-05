import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Group,
  Panel,
  Separator,
  usePanelRef,
  type Layout,
} from "react-resizable-panels";
import {
  PanelLeftOpen,
  PanelRightOpen,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { createPortal } from "react-dom";

import { IconButton, classes } from "./ui.js";

const LAYOUT_STORAGE_KEY = "agent-multiplex.ui.layout.v1";
const LEFT_DEFAULT_PX = 288;
const LEFT_MIN_PX = 240;
const LEFT_MAX_PX = 420;
const RIGHT_DEFAULT_PX = 360;
const RIGHT_MIN_PX = 320;
const RIGHT_MAX_PX = 520;
const CENTER_MIN_PX = 520;
const COLLAPSED_PX = 40;

type ViewportMode = "desktop" | "compact" | "mobile";

interface LayoutPreferences {
  readonly leftPx: number;
  readonly rightPx: number;
  readonly leftCollapsed: boolean;
  readonly rightCollapsed: boolean;
}

export interface PaneActions {
  readonly collapse?: () => void;
  readonly close?: () => void;
}

export interface WorkspaceShellProps {
  readonly left: (actions: PaneActions) => ReactNode;
  readonly center: ReactNode;
  readonly inspector: (actions: PaneActions) => ReactNode;
  readonly selectedLabel: string;
}

const DEFAULT_LAYOUT: LayoutPreferences = {
  leftPx: LEFT_DEFAULT_PX,
  rightPx: RIGHT_DEFAULT_PX,
  leftCollapsed: false,
  rightCollapsed: false,
};

export function WorkspaceShell({ left, center, inspector, selectedLabel }: WorkspaceShellProps) {
  const mode = useViewportMode();
  // Keep the conversation mounted when responsive shells change. Uploads,
  // uncertain command IDs, and drafts belong to the session, not a viewport.
  const [conversationHost] = useState(() => {
    const host = document.createElement("div");
    host.className = "flex min-h-0 min-w-0 flex-1 flex-col";
    return host;
  });
  const mount = <ConversationMount host={conversationHost} />;
  const [layout, setLayout] = useState<LayoutPreferences>(readLayoutPreferences);

  function updateLayout(update: Partial<LayoutPreferences>): void {
    setLayout((current) => {
      const next = validateLayout({ ...current, ...update });
      writeLayoutPreferences(next);
      return next;
    });
  }

  const workspace = mode === "desktop"
    ? <DesktopWorkspace layout={layout} onLayout={updateLayout} left={left} center={mount} inspector={inspector} />
    : mode === "compact"
      ? <CompactWorkspace layout={layout} onLayout={updateLayout} left={left} center={mount} inspector={inspector} selectedLabel={selectedLabel} />
      : <MobileWorkspace left={left} center={mount} inspector={inspector} selectedLabel={selectedLabel} />;
  return <>{workspace}{createPortal(center, conversationHost)}</>;
}

function ConversationMount({ host }: { host: HTMLDivElement }) {
  const container = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    container.current?.append(host);
    return () => { host.remove(); };
  }, [host]);
  return <div ref={container} className="flex min-h-0 min-w-0 flex-1 flex-col" />;
}

function DesktopWorkspace({ layout, onLayout, left, center, inspector }: {
  readonly layout: LayoutPreferences;
  readonly onLayout: (update: Partial<LayoutPreferences>) => void;
  readonly left: WorkspaceShellProps["left"];
  readonly center: ReactNode;
  readonly inspector: WorkspaceShellProps["inspector"];
}) {
  const leftRef = usePanelRef();
  const rightRef = usePanelRef();
  const groupElement = useRef<HTMLDivElement | null>(null);
  const initialLeftSize = useRef(layout.leftCollapsed ? COLLAPSED_PX : layout.leftPx);
  const initialRightSize = useRef(layout.rightCollapsed ? COLLAPSED_PX : layout.rightPx);
  const latestLeftPixels = useRef(layout.leftPx);
  const latestRightPixels = useRef(layout.rightPx);
  const [leftCollapsed, setLeftCollapsed] = useState(layout.leftCollapsed);
  const [rightCollapsed, setRightCollapsed] = useState(layout.rightCollapsed);

  function commitLayout(nextLayout: Layout): void {
    const groupWidth = groupElement.current?.getBoundingClientRect().width ?? 0;
    const leftPixels = layoutPixels(nextLayout, "agents-pane", groupWidth, latestLeftPixels.current);
    const rightPixels = layoutPixels(nextLayout, "inspector-pane", groupWidth, latestRightPixels.current);
    const leftIsCollapsed = leftPixels <= COLLAPSED_PX + 1;
    const rightIsCollapsed = rightPixels <= COLLAPSED_PX + 1;
    onLayout({
      leftCollapsed: leftIsCollapsed,
      rightCollapsed: rightIsCollapsed,
      ...(!leftIsCollapsed ? { leftPx: leftPixels } : {}),
      ...(!rightIsCollapsed ? { rightPx: rightPixels } : {}),
    });
  }

  function toggleLeft(): void {
    const collapsed = leftRef.current?.isCollapsed() ?? leftCollapsed;
    if (collapsed) {
      leftRef.current?.resize(layout.leftPx);
      onLayout({ leftCollapsed: false });
    } else {
      const pixels = leftRef.current?.getSize().inPixels;
      if (pixels !== undefined) latestLeftPixels.current = pixels;
      leftRef.current?.collapse();
      onLayout({ leftCollapsed: true, ...(pixels !== undefined ? { leftPx: pixels } : {}) });
    }
  }

  function toggleRight(): void {
    const collapsed = rightRef.current?.isCollapsed() ?? rightCollapsed;
    if (collapsed) {
      rightRef.current?.resize(layout.rightPx);
      onLayout({ rightCollapsed: false });
    } else {
      const pixels = rightRef.current?.getSize().inPixels;
      if (pixels !== undefined) latestRightPixels.current = pixels;
      rightRef.current?.collapse();
      onLayout({ rightCollapsed: true, ...(pixels !== undefined ? { rightPx: pixels } : {}) });
    }
  }

  return (
    <Group
      id="desktop-workspace"
      elementRef={groupElement}
      orientation="horizontal"
      className="min-h-0 flex-1"
      resizeTargetMinimumSize={{ coarse: 24, fine: 10 }}
      onLayoutChanged={(nextLayout, metadata) => {
        if (metadata.isUserInteraction) commitLayout(nextLayout);
      }}
    >
      <Panel
        id="agents-pane"
        panelRef={leftRef}
        defaultSize={initialLeftSize.current}
        minSize={LEFT_MIN_PX}
        maxSize={LEFT_MAX_PX}
        collapsedSize={COLLAPSED_PX}
        collapsible
        onResize={(size) => {
          const collapsed = size.inPixels <= COLLAPSED_PX + 1;
          setLeftCollapsed(collapsed);
          if (!collapsed) latestLeftPixels.current = size.inPixels;
        }}
      >
        {leftCollapsed ? (
          <CollapsedRail side="left" onExpand={toggleLeft} />
        ) : (
          left({ collapse: toggleLeft })
        )}
      </Panel>
      <WorkspaceSeparator id="agents-resize-handle" />
      <Panel id="conversation-pane" minSize={CENTER_MIN_PX}>
        <div className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--surface-canvas)]">{center}</div>
      </Panel>
      <WorkspaceSeparator id="inspector-resize-handle" />
      <Panel
        id="inspector-pane"
        panelRef={rightRef}
        defaultSize={initialRightSize.current}
        minSize={RIGHT_MIN_PX}
        maxSize={RIGHT_MAX_PX}
        collapsedSize={COLLAPSED_PX}
        collapsible
        onResize={(size) => {
          const collapsed = size.inPixels <= COLLAPSED_PX + 1;
          setRightCollapsed(collapsed);
          if (!collapsed) latestRightPixels.current = size.inPixels;
        }}
      >
        {rightCollapsed ? (
          <CollapsedRail side="right" onExpand={toggleRight} />
        ) : (
          inspector({ collapse: toggleRight })
        )}
      </Panel>
    </Group>
  );
}

function CompactWorkspace({ layout, onLayout, left, center, inspector, selectedLabel }: {
  readonly layout: LayoutPreferences;
  readonly onLayout: (update: Partial<LayoutPreferences>) => void;
  readonly left: WorkspaceShellProps["left"];
  readonly center: ReactNode;
  readonly inspector: WorkspaceShellProps["inspector"];
  readonly selectedLabel: string;
}) {
  const leftRef = usePanelRef();
  const groupElement = useRef<HTMLDivElement | null>(null);
  const initialLeftSize = useRef(layout.leftCollapsed ? COLLAPSED_PX : layout.leftPx);
  const latestLeftPixels = useRef(layout.leftPx);
  const [leftCollapsed, setLeftCollapsed] = useState(layout.leftCollapsed);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  function commitLayout(nextLayout: Layout): void {
    const groupWidth = groupElement.current?.getBoundingClientRect().width ?? 0;
    const pixels = layoutPixels(nextLayout, "compact-agents-pane", groupWidth, latestLeftPixels.current);
    const collapsed = pixels <= COLLAPSED_PX + 1;
    onLayout({
      leftCollapsed: collapsed,
      ...(!collapsed ? { leftPx: pixels } : {}),
    });
  }

  function toggleLeft(): void {
    const collapsed = leftRef.current?.isCollapsed() ?? leftCollapsed;
    if (collapsed) {
      leftRef.current?.resize(layout.leftPx);
      onLayout({ leftCollapsed: false });
    } else {
      const pixels = leftRef.current?.getSize().inPixels;
      if (pixels !== undefined) latestLeftPixels.current = pixels;
      leftRef.current?.collapse();
      onLayout({ leftCollapsed: true, ...(pixels !== undefined ? { leftPx: pixels } : {}) });
    }
  }

  return (
    <DialogPrimitive.Root open={inspectorOpen} onOpenChange={setInspectorOpen}>
      <Group
        id="compact-workspace"
        elementRef={groupElement}
        orientation="horizontal"
        className="min-h-0 flex-1"
        resizeTargetMinimumSize={{ coarse: 24, fine: 10 }}
        onLayoutChanged={(nextLayout, metadata) => {
          if (metadata.isUserInteraction) commitLayout(nextLayout);
        }}
      >
        <Panel
          id="compact-agents-pane"
          panelRef={leftRef}
          defaultSize={initialLeftSize.current}
          minSize={LEFT_MIN_PX}
          maxSize={LEFT_MAX_PX}
          collapsedSize={COLLAPSED_PX}
          collapsible
          onResize={(size) => {
            const collapsed = size.inPixels <= COLLAPSED_PX + 1;
            setLeftCollapsed(collapsed);
            if (!collapsed) latestLeftPixels.current = size.inPixels;
          }}
        >
          {leftCollapsed ? (
            <CollapsedRail side="left" onExpand={toggleLeft} />
          ) : (
            left({ collapse: toggleLeft })
          )}
        </Panel>
        <WorkspaceSeparator id="compact-agents-resize-handle" />
        <Panel id="compact-conversation-pane" minSize={CENTER_MIN_PX}>
          <div className="flex h-full min-h-0 min-w-0 flex-col bg-[var(--surface-canvas)]">
            <CompactToolbar
              selectedLabel={selectedLabel}
            />
            {center}
          </div>
        </Panel>
      </Group>
      <WorkspaceSheetContent
        side="right"
        title="Inspector"
      >
        {inspector({ close: () => setInspectorOpen(false) })}
      </WorkspaceSheetContent>
    </DialogPrimitive.Root>
  );
}

function MobileWorkspace({ left, center, inspector, selectedLabel }: WorkspaceShellProps) {
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  return (
    <DialogPrimitive.Root open={agentsOpen} onOpenChange={setAgentsOpen}>
      <main className="flex min-h-0 flex-1 flex-col bg-[var(--surface-canvas)]">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--surface-shell)] px-2">
          <DialogPrimitive.Trigger asChild>
            <IconButton
              icon={PanelLeftOpen}
              label="Open agents and fleet"
              tone="ghost"
              className="min-h-10 min-w-10"
              data-testid="agents-sheet-button"
            />
          </DialogPrimitive.Trigger>
          <span className="min-w-0 flex-1 truncate text-center text-xs text-[var(--text-secondary)]">{selectedLabel}</span>
          <DialogPrimitive.Root open={inspectorOpen} onOpenChange={setInspectorOpen}>
            <DialogPrimitive.Trigger asChild>
              <IconButton
                icon={PanelRightOpen}
                label="Open inspector"
                tone="ghost"
                className="min-h-10 min-w-10"
                data-testid="inspector-sheet-button"
              />
            </DialogPrimitive.Trigger>
            <WorkspaceSheetContent side="right" title="Inspector">
              {inspector({ close: () => setInspectorOpen(false) })}
            </WorkspaceSheetContent>
          </DialogPrimitive.Root>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{center}</div>
      </main>
      <WorkspaceSheetContent side="left" title="Agents & fleet">
        {left({ close: () => setAgentsOpen(false) })}
      </WorkspaceSheetContent>
    </DialogPrimitive.Root>
  );
}

function CompactToolbar({ selectedLabel }: {
  readonly selectedLabel: string;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-[var(--border-subtle)] bg-[var(--surface-shell)] px-3">
      <span className="truncate text-xs text-[var(--text-muted)]">{selectedLabel}</span>
      <DialogPrimitive.Trigger asChild>
        <button
          type="button"
          className="inline-flex min-h-8 shrink-0 items-center gap-2 rounded-md px-2 text-xs font-medium text-[var(--text-secondary)] transition hover:bg-[var(--surface-raised)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          data-testid="inspector-sheet-button"
        >
          <PanelRightOpen aria-hidden="true" className="size-3.5" />
          Inspector
        </button>
      </DialogPrimitive.Trigger>
    </div>
  );
}

function CollapsedRail({ side, onExpand }: {
  readonly side: "left" | "right";
  readonly onExpand: () => void;
}) {
  const isLeft = side === "left";
  return (
    <div className={classes(
      "flex h-full w-full flex-col items-center bg-[var(--surface-shell)] py-2",
      isLeft ? "border-r border-[var(--border-subtle)]" : "border-l border-[var(--border-subtle)]",
    )}>
      <IconButton
        icon={isLeft ? PanelLeftOpen : PanelRightOpen}
        label={isLeft ? "Expand agents pane" : "Expand inspector pane"}
        tone="ghost"
        className="size-9 min-h-9 px-0"
        onClick={onExpand}
        data-testid={isLeft ? "left-pane-toggle" : "right-pane-toggle"}
      />
      <span className="mt-3 text-xs font-medium text-[var(--text-muted)] [writing-mode:vertical-rl]">
        {isLeft ? "Agents" : "Inspector"}
      </span>
    </div>
  );
}

function WorkspaceSeparator({ id }: { readonly id: string }) {
  return (
    <Separator
      id={id}
      className="relative z-10 w-px bg-[var(--border-subtle)] outline-none transition-colors hover:bg-[var(--accent)]/70 focus-visible:bg-[var(--accent)] data-[separator=active]:bg-[var(--accent)]"
    />
  );
}

function WorkspaceSheetContent({ side, title, children }: {
  readonly side: "left" | "right";
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/65 backdrop-blur-[2px]" />
      <DialogPrimitive.Content
        className={classes(
          "fixed inset-y-0 z-50 flex w-[min(92vw,420px)] flex-col border-[var(--border-subtle)] bg-[var(--surface-shell)] pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-2xl outline-none",
          side === "left"
            ? "left-0 border-r pl-[env(safe-area-inset-left)]"
            : "right-0 border-l pr-[env(safe-area-inset-right)]",
        )}
        aria-describedby={undefined}
      >
        <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function useViewportMode(): ViewportMode {
  const [mode, setMode] = useState<ViewportMode>(viewportMode);

  useEffect(() => {
    let animationFrame = 0;
    const update = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => setMode(viewportMode()));
    };
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", update);
    };
  }, []);

  return mode;
}

function viewportMode(): ViewportMode {
  if (typeof window === "undefined") return "desktop";
  if (window.innerWidth < 768 || (window.innerWidth < 960 && window.innerHeight < 500)) {
    return "mobile";
  }
  return window.innerWidth < 1280 ? "compact" : "desktop";
}

function readLayoutPreferences(): LayoutPreferences {
  if (typeof window === "undefined") return DEFAULT_LAYOUT;
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const decoded = JSON.parse(raw) as unknown;
    if (!isRecord(decoded)) return DEFAULT_LAYOUT;
    return validateLayout({
      leftPx: decoded.leftPx,
      rightPx: decoded.rightPx,
      leftCollapsed: decoded.leftCollapsed,
      rightCollapsed: decoded.rightCollapsed,
    });
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function writeLayoutPreferences(layout: LayoutPreferences): void {
  try {
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // A blocked or full localStorage must never prevent using the workspace.
  }
}

function validateLayout(value: Partial<Record<keyof LayoutPreferences, unknown>>): LayoutPreferences {
  return {
    leftPx: finiteBetween(value.leftPx, LEFT_MIN_PX, LEFT_MAX_PX, LEFT_DEFAULT_PX),
    rightPx: finiteBetween(value.rightPx, RIGHT_MIN_PX, RIGHT_MAX_PX, RIGHT_DEFAULT_PX),
    leftCollapsed: typeof value.leftCollapsed === "boolean" ? value.leftCollapsed : false,
    rightCollapsed: typeof value.rightCollapsed === "boolean" ? value.rightCollapsed : false,
  };
}

function finiteBetween(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback;
}

function layoutPixels(
  layout: Layout,
  panelId: string,
  groupPixels: number,
  fallback: number,
): number {
  const percentage = layout[panelId];
  return typeof percentage === "number" && Number.isFinite(percentage) && groupPixels > 0
    ? groupPixels * percentage / 100
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
