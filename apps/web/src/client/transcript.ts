import type {
  NativeEvent,
  NativeHistoryResult,
} from "@arduano/agent-multiplex-protocol";

export type TimelineKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "plan"
  | "tool"
  | "subagent"
  | "notice"
  | "raw";

export interface TimelineEntry {
  readonly id: string;
  readonly kind: TimelineKind;
  readonly title: string;
  readonly body: string;
  readonly timestamp?: string | undefined;
  readonly status?: string | undefined;
  readonly raw: unknown;
  readonly sequence?: number | undefined;
  readonly pending?: boolean | undefined;
}

type JsonRecord = Record<string, unknown>;

export function entriesFromHistory(result: NativeHistoryResult): TimelineEntry[] {
  return result.harness === "codex"
    ? codexHistory(result.payload)
    : copilotHistory(result.payload);
}

export function mergeTimeline(
  history: readonly TimelineEntry[],
  live: readonly TimelineEntry[],
): TimelineEntry[] {
  const merged = new Map<string, TimelineEntry>();
  for (const entry of [...history, ...live]) {
    const previous = merged.get(entry.id);
    if (!previous) {
      merged.set(entry.id, entry);
      continue;
    }
    // A stale streaming fragment must not replace a terminal item recovered
    // through the harness-native history API after a stream gap.
    const current = previous.pending === false && entry.pending === true
      ? { ...entry, ...previous }
      : { ...previous, ...entry };
    merged.set(entry.id, {
      ...current,
      body: current.body || previous.body,
      raw: current.raw ?? previous.raw,
      pending: current.pending ?? previous.pending,
    });
  }
  return [...merged.values()].sort(compareEntries);
}

export function applyNativeEvent(
  entries: readonly TimelineEntry[],
  event: NativeEvent,
): TimelineEntry[] {
  const next = new Map(entries.map((entry) => [entry.id, entry]));
  if (event.harness === "codex") applyCodexLive(next, event);
  else applyCopilotLive(next, event);
  return [...next.values()].sort(compareEntries).slice(-1_000);
}

function codexHistory(payload: unknown): TimelineEntry[] {
  const thread = record(payload)?.thread;
  const turns = array(record(thread)?.turns);
  const entries: TimelineEntry[] = [];
  for (const [turnIndex, rawTurn] of turns.entries()) {
    const turn = record(rawTurn);
    const startedAt = number(turn?.startedAt);
    for (const [itemIndex, rawItem] of array(turn?.items).entries()) {
      const projected = codexItem(
        rawItem,
        startedAt === undefined
          ? undefined
          : new Date(startedAt * 1_000 + itemIndex).toISOString(),
        `history:${turnIndex}:${itemIndex}`,
      );
      if (projected) entries.push({ ...projected, sequence: turnIndex * 10_000 + itemIndex });
    }
  }
  return entries;
}

function codexItem(rawItem: unknown, timestamp?: string, fallbackId?: string): TimelineEntry | null {
  const item = record(rawItem);
  const type = string(item?.type);
  const nativeId = string(item?.id) ?? fallbackId ?? `${type ?? "item"}:${stablePreview(rawItem)}`;
  const base = { id: `codex:${nativeId}`, timestamp, raw: rawItem };
  switch (type) {
    case "userMessage": {
      const body = array(item?.content)
        .map((part) => string(record(part)?.text))
        .filter((value): value is string => value !== undefined)
        .join("\n");
      return { ...base, kind: "user", title: "You", body };
    }
    case "agentMessage":
      return {
        ...base,
        kind: "assistant",
        title: "Codex",
        body: string(item?.text) ?? "",
        pending: (string(item?.phase) ?? "") !== "final_answer",
      };
    case "reasoning":
      return {
        ...base,
        kind: "reasoning",
        title: "Reasoning",
        body: [...strings(item?.summary), ...strings(item?.content)].join("\n"),
      };
    case "plan":
      return { ...base, kind: "plan", title: "Plan", body: string(item?.text) ?? "" };
    case "commandExecution": {
      const status = string(item?.status);
      return {
        ...base,
        kind: "tool",
        title: string(item?.command) ?? "Shell command",
        body: string(item?.aggregatedOutput) ?? "",
        status,
        pending: status === "inProgress" || status === "running",
      };
    }
    case "fileChange":
      return {
        ...base,
        kind: "tool",
        title: "File changes",
        body: `${array(item?.changes).length} change(s)`,
        status: string(item?.status),
      };
    case "mcpToolCall":
    case "dynamicToolCall":
      return {
        ...base,
        kind: "tool",
        title: [string(item?.server), string(item?.tool)].filter(Boolean).join(" / ") || "Tool call",
        body: pretty(item?.result ?? item?.arguments ?? ""),
        status: string(item?.status),
      };
    case "collabAgentToolCall":
      return {
        ...base,
        kind: "subagent",
        title: `Agent ${string(item?.tool) ?? "activity"}`,
        body: [string(item?.prompt), strings(item?.receiverThreadIds).join(", ")]
          .filter(Boolean)
          .join("\n"),
        status: string(item?.status),
      };
    case "subAgentActivity":
      return {
        ...base,
        kind: "subagent",
        title: string(item?.kind) ?? "Subagent",
        body: [string(item?.agentPath), string(item?.agentThreadId)].filter(Boolean).join(" · "),
      };
    case "webSearch":
    case "imageView":
    case "imageGeneration":
      return { ...base, kind: "tool", title: humanize(type), body: pretty(rawItem) };
    default:
      return type
        ? { ...base, kind: "raw", title: humanize(type), body: "Native item" }
        : null;
  }
}

function copilotHistory(payload: unknown): TimelineEntry[] {
  return array(payload)
    .map((event, index) => copilotEvent(event, index))
    .filter((entry): entry is TimelineEntry => entry !== null);
}

function copilotEvent(rawEvent: unknown, sequence?: number): TimelineEntry | null {
  const event = record(rawEvent);
  const type = string(event?.type);
  const data = record(event?.data);
  const eventId = string(event?.id) ?? `${type ?? "event"}:${sequence ?? 0}`;
  const messageId = string(data?.messageId);
  const toolCallId = string(data?.toolCallId);
  const base = {
    id: `copilot:${messageId ?? toolCallId ?? eventId}`,
    timestamp: string(event?.timestamp),
    raw: rawEvent,
    sequence,
  };
  switch (type) {
    case "user.message":
      return { ...base, kind: "user", title: "You", body: string(data?.content) ?? "" };
    case "assistant.message": {
      const content = string(data?.content) ?? "";
      if (!content && array(data?.toolRequests).length > 0) return null;
      return { ...base, kind: "assistant", title: "Copilot", body: content };
    }
    case "assistant.reasoning":
    case "assistant.intent":
      return {
        ...base,
        kind: "reasoning",
        title: type === "assistant.intent" ? "Intent" : "Reasoning",
        body: string(data?.content) ?? pretty(data),
      };
    case "session.plan_changed":
      return { ...base, kind: "plan", title: "Plan", body: pretty(data) };
    case "tool.execution_start":
      return {
        ...base,
        kind: "tool",
        title: string(data?.toolName) ?? "Tool call",
        body: pretty(data?.arguments),
        status: "running",
        pending: true,
      };
    case "tool.execution_complete":
      return {
        ...base,
        kind: "tool",
        title: string(data?.toolName) ?? "Tool result",
        body: toolResult(data?.result),
        status: data?.success === false ? "failed" : "completed",
        pending: false,
      };
    case "subagent.started":
    case "subagent.completed":
      return {
        ...base,
        kind: "subagent",
        title: humanize(type),
        body: pretty(data),
        status: type.endsWith("started") ? "running" : "completed",
      };
    case "session.error":
      return { ...base, kind: "notice", title: "Session error", body: pretty(data), status: "failed" };
    default:
      return null;
  }
}

function applyCodexLive(entries: Map<string, TimelineEntry>, event: NativeEvent): void {
  const payload = record(event.payload);
  const item = payload?.item;
  if ((event.nativeType === "item/started" || event.nativeType === "item/completed") && item) {
    const timestampMs = number(
      event.nativeType === "item/started" ? payload?.startedAtMs : payload?.completedAtMs,
    );
    const projected = codexItem(
      item,
      timestampMs === undefined ? undefined : new Date(timestampMs).toISOString(),
      `event:${event.runtimeEpoch}:${event.sequence}`,
    );
    if (projected) {
      entries.set(projected.id, {
        ...projected,
        sequence: event.sequence,
        pending: event.nativeType === "item/started" ? true : false,
      });
    }
    return;
  }
  const itemId = string(payload?.itemId);
  const delta = string(payload?.delta);
  if (itemId && delta !== undefined) {
    const id = `codex:${itemId}`;
    const previous = entries.get(id);
    const isCommand = event.nativeType.includes("commandExecution");
    entries.set(id, {
      id,
      kind: isCommand ? "tool" : event.nativeType.includes("plan") ? "plan" : "assistant",
      title: previous?.title ?? (isCommand ? "Command output" : event.nativeType.includes("plan") ? "Plan" : "Codex"),
      body: `${previous?.body ?? ""}${delta}`,
      raw: event.payload,
      sequence: event.sequence,
      pending: true,
    });
    return;
  }
  if (event.nativeType === "turn/failed" || event.nativeType === "error") {
    entries.set(`codex:event:${event.runtimeEpoch}:${event.sequence}`, {
      id: `codex:event:${event.runtimeEpoch}:${event.sequence}`,
      kind: "notice",
      title: "Codex error",
      body: pretty(event.payload),
      raw: event.payload,
      sequence: event.sequence,
      status: "failed",
    });
  }
}

function applyCopilotLive(entries: Map<string, TimelineEntry>, event: NativeEvent): void {
  const payload = record(event.payload);
  if (event.nativeType === "assistant.message_delta") {
    const data = record(payload?.data);
    const messageId = string(data?.messageId);
    const delta = string(data?.deltaContent);
    if (messageId && delta !== undefined) {
      const id = `copilot:${messageId}`;
      const previous = entries.get(id);
      entries.set(id, {
        id,
        kind: "assistant",
        title: "Copilot",
        body: `${previous?.body ?? ""}${delta}`,
        timestamp: string(payload?.timestamp),
        raw: event.payload,
        sequence: event.sequence,
        pending: true,
      });
    }
    return;
  }
  const projected = copilotEvent(event.payload, event.sequence);
  if (projected) entries.set(projected.id, projected);
}

function compareEntries(left: TimelineEntry, right: TimelineEntry): number {
  if (left.timestamp && right.timestamp) {
    const byTime = left.timestamp.localeCompare(right.timestamp);
    if (byTime !== 0) return byTime;
  }
  return (left.sequence ?? 0) - (right.sequence ?? 0) || left.id.localeCompare(right.id);
}

function toolResult(value: unknown): string {
  const result = record(value);
  return string(result?.content) ?? string(result?.detailedContent) ?? pretty(value);
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown): string[] {
  return array(value).filter((item): item is string => typeof item === "string");
}

function humanize(value: string): string {
  return value.replaceAll(/[./_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stablePreview(value: unknown): string {
  return pretty(value).slice(0, 80);
}
