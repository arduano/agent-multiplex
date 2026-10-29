import { createHash } from "node:crypto";
import {
  HistoryWindow,
  type HistoryScope,
  type HistoryReadPort,
  type HistoryRecord,
  type NativePage,
  type Update,
} from "../../history/index.js";
import { canonicalJson, type Json, type RunRef } from "../../protocol/index.js";
import { check, json, object, text } from "./validation.js";
import type { Event } from "../sdk-contracts.js";
export function event(raw: unknown): Event {
  const value = object(raw),
    data = object(value.data);
  text(value.id, 1024);
  text(value.type, 256);
  const envelope = value.agentId,
    legacy = data.agentId;
  if (value.parentId !== undefined && value.parentId !== null) text(value.parentId, 1024);
  if (envelope !== undefined) text(envelope, 1024);
  if (legacy !== undefined) text(legacy, 1024);
  check(envelope === undefined || legacy === undefined || envelope === legacy, "CHILD_ID_CONFLICT");
  return {
    id: value.id as string,
    type: value.type as string,
    data,
    ...(envelope === undefined && legacy === undefined
      ? {}
      : { agentId: (envelope ?? legacy) as string }),
    ...(value.ephemeral === true ? { ephemeral: true } : {}),
    ...(value.parentId === undefined ? {} : { parentId: value.parentId as string | null }),
  };
}
const rowId = (stream: string, kind: string, id: string): string =>
  JSON.stringify(["copilot", stream, kind, id]);
const body = (text: string): HistoryRecord["body"] => ({
  kind: "complete",
  text,
  evidence: "native",
});
/** Optional native detail cannot invalidate otherwise valid transcript facts. */
export function boundedMetadata(input: Readonly<Record<string, unknown>>): Record<string, Json> {
  const result: Record<string, Json> = {};
  const omitted: string[] = [];
  for (const [key, raw] of Object.entries(input)) {
    if (key === "assets" && Array.isArray(raw)) {
      const assets: Json[] = [];
      for (const item of raw.slice(0, 32)) {
        try {
          const value = json(item, 6144);
          json({ ...result, assets: [...assets, value] }, 6144);
          assets.push(value);
        } catch {
          omitted.push("assets");
          try {
            const value = object(item);
            const fallback: Json = {
              id: text(value.id, 1024),
              name: "Attachment",
              mediaType: "application/octet-stream",
              state: "unavailable",
              reason: "capacity",
            };
            json({ ...result, assets: [...assets, fallback] }, 6144);
            assets.push(fallback);
          } catch {
            /* The omission marker remains authoritative. */
          }
        }
      }
      if (raw.length > 32) omitted.push("assets");
      result.assets = assets;
      continue;
    }
    try {
      const value = json(raw, 6144);
      json({ ...result, [key]: value }, 6144);
      result[key] = value;
    } catch {
      omitted.push(key);
    }
  }
  if (omitted.length) result.omittedFields = [...new Set(omitted)].slice(0, 32);
  return result;
}
function record(input: Event, stream: string, prior?: HistoryRecord): HistoryRecord | null {
  const data = input.data;
  let kind: HistoryRecord["kind"];
  let logical: string;
  let lifecycle: HistoryRecord["lifecycle"] = "completed";
  let content: HistoryRecord["body"] = { kind: "unavailable", reason: "nativeOmitted" };
  const delta =
    input.type === "assistant.message_delta" || input.type === "assistant.reasoning_delta";
  if (input.type.startsWith("assistant.message")) {
    kind = "assistant";
    logical = text(data.messageId, 1024);
  } else if (input.type.startsWith("assistant.reasoning")) {
    kind = "reasoning";
    logical = text(data.reasoningId, 1024);
  } else if (input.type === "user.message") {
    kind = "user";
    logical = typeof data.messageId === "string" ? text(data.messageId, 1024) : input.id;
  } else if (input.type.startsWith("tool.execution_") || input.type === "tool.shell_output") {
    kind = "tool";
    logical = text(data.toolCallId, 1024);
    lifecycle = "running";
  } else if (
    input.type === "session.error" ||
    input.type === "session.compaction_start" ||
    input.type === "session.compaction_complete"
  ) {
    kind = "notice";
    logical = input.id;
  } else if (input.type.startsWith("subagent.")) {
    kind = "delegation";
    logical = text(data.toolCallId ?? input.agentId, 1024);
  } else return null;
  if (delta) {
    const previous = prior?.body;
    const initial = previous && previous.kind !== "unavailable" ? previous.text : "";
    content = {
      kind: "partial",
      text: initial + text(data.deltaContent, 65536),
      missing: previous ? ["final"] : ["prefix", "final"],
    };
    lifecycle = "running";
  } else if (input.type === "assistant.message_start") {
    content = { kind: "partial", text: "", missing: ["final"] };
    lifecycle = "running";
  } else if (["assistant.message", "assistant.reasoning", "user.message"].includes(input.type)) {
    check(typeof data.content === "string", "MESSAGE_CONTENT");
    content = body(data.content);
  } else if (input.type === "tool.execution_start") {
    content = { kind: "partial", text: "", missing: ["final"] };
  } else if (input.type === "tool.shell_output") {
    check(
      Number.isSafeInteger(data.sequence) &&
        (data.sequence as number) >= 0 &&
        typeof data.text === "string",
      "SHELL_CHUNK",
    );
    const sequence = data.sequence as number,
      previous = prior?.native.shellSequence;
    if (typeof previous === "number" && sequence <= previous) return prior!;
    const before = prior?.body;
    const missing = new Set<"prefix" | "interior" | "final" | "truncated">(
      before?.kind === "partial" ? before.missing : ["final"],
    );
    if (previous === undefined && sequence > 0) missing.add("prefix");
    if (typeof previous === "number" && sequence !== previous + 1) missing.add("interior");
    content = {
      kind: "partial",
      text: (before && before.kind !== "unavailable" ? before.text : "") + data.text,
      missing: [...missing],
    };
  } else if (input.type === "tool.execution_partial_result") {
    check(typeof data.partialOutput === "string");
    content = { kind: "partial", text: data.partialOutput, missing: ["prefix", "final"] };
  } else if (input.type === "tool.execution_progress") {
    content = prior?.body ?? content;
  } else if (input.type === "tool.execution_complete") {
    check(typeof data.success === "boolean");
    lifecycle = data.success ? "completed" : "failed";
    const result = data.result === undefined ? null : object(data.result),
      error = data.error === undefined ? null : object(data.error);
    if (typeof result?.content === "string") content = body(result.content);
    else if (typeof error?.message === "string") content = body(error.message);
  } else if (input.type === "session.error") {
    content = body(text(data.message, 65536));
    lifecycle = "failed";
  } else if (input.type === "session.compaction_start") {
    content = body("Compacting context");
    lifecycle = "running";
  } else if (input.type === "session.compaction_complete") {
    content = body("Context compaction completed");
  } else if (kind === "delegation") {
    content = body(typeof data.agentDisplayName === "string" ? data.agentDisplayName : "Agent");
    lifecycle =
      input.type === "subagent.started" || input.type === "subagent.configured"
        ? "running"
        : input.type === "subagent.failed"
          ? "failed"
          : "completed";
  }
  const native: Record<string, Json> = { eventId: input.id, type: input.type };
  for (const key of [
    "messageId",
    "reasoningId",
    "toolCallId",
    "toolName",
    "originatingMessageId",
    "turnId",
    "phase",
    "newModel",
    "model",
    "explicitModelOverride",
    "configuredModelPreference",
    "firstDispatchedModel",
    "agentName",
    "agentDisplayName",
    "errorCode",
    "errorType",
    "arguments",
    "toolRequests",
    "attachments",
    "progressMessage",
  ]) {
    if (data[key] !== undefined) native[key] = data[key] as Json;
  }
  if (Array.isArray(data._assets)) native.assets = data._assets as Json[];
  if (input.type === "tool.shell_output") native.shellSequence = data.sequence as number;
  if (input.agentId) native.agentId = input.agentId;
  if (input.parentId !== undefined) native.parentId = input.parentId;
  return {
    id: rowId(stream, kind, logical),
    kind,
    lifecycle,
    body: content,
    native: boundedMetadata(native),
  };
}
/** One exact SDK attachment; root and proved children never share row identity. */
export class CopilotHistory {
  private readonly windows = new Map<string, HistoryWindow>();
  private readonly children = new Map<string, string>();
  private readonly active = new Map<string, string>();
  private readonly holds = new Map<string, number>();
  private readonly seen = new Map<string, string>();
  private lost = false;
  constructor(
    readonly run: RunRef,
    readonly attachment: string,
    knownEmpty = false,
  ) {
    this.windows.set(
      "root",
      new HistoryWindow({ run, attachment, stream: "root" }, {}, knownEmpty),
    );
  }
  root(): HistoryWindow {
    return this.windows.get("root")!;
  }
  private ensureChild(child: string): void {
    check(child !== this.run.nativeSession, "CHILD_ROOT_ALIAS");
    if (this.children.has(child)) return;
    if (this.children.size >= 31) {
      const victim = [...this.children.keys()].find(
        (id) =>
          !this.active.has(id) &&
          !this.holds.has(id) &&
          this.windows.get(id)!.subscriberCount === 0,
      );
      check(victim !== undefined, "CHILD_CAPACITY");
      this.windows.get(victim)!.close();
      this.windows.delete(victim);
      this.children.delete(victim);
    }
    this.children.set(child, "");
    this.windows.set(
      child,
      new HistoryWindow({ run: this.run, attachment: this.attachment, stream: child }),
    );
  }
  protect(stream: string): () => void {
    check(this.windows.has(stream), "UNPROVED_CHILD");
    this.holds.set(stream, (this.holds.get(stream) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = this.holds.get(stream)!;
      if (count === 1) this.holds.delete(stream);
      else this.holds.set(stream, count - 1);
    };
  }
  streams(): readonly string[] {
    return [...this.windows.keys()];
  }
  window(stream: string): HistoryWindow {
    const value = this.windows.get(stream);
    check(value, "UNPROVED_CHILD");
    return value;
  }
  owner(input: Event): Readonly<{
    nativeAgent: string;
    relation: "root" | "child";
  }> {
    if (input.agentId) {
      check(this.children.has(input.agentId), "UNPROVED_CHILD");
      return { nativeAgent: input.agentId, relation: "child" };
    }
    check(input.data.parentToolCallId === undefined, "LEGACY_CHILD_UNPROVED");
    return { nativeAgent: this.run.nativeSession, relation: "root" };
  }
  rootCallbackOwner(): Readonly<{
    nativeAgent: string;
    relation: "root";
  }> {
    check(!this.lost && this.active.size === 0, "CALLBACK_OWNER_UNPROVED");
    return { nativeAgent: this.run.nativeSession, relation: "root" };
  }
  gap(code: string): void {
    if (this.lost) return;
    this.lost = true;
    for (const window of this.windows.values())
      window.update({
        gaps: [{ id: `copilot:${code}`, kind: "captureLost" }],
        activity: { state: "unknown", turnId: null },
      });
  }
  observe(raw: unknown): Event | null {
    const input = event(raw);
    if (this.lost) return null;
    // Exclude private system/developer/configuration payloads from identity data.
    const selected =
      /^(assistant\.(message|reasoning)|user\.message|tool\.(execution_|shell_output)|subagent\.|session\.(error|compaction_))/.test(
        input.type,
      );
    const { _assets, ...nativeData } = input.data;
    const fingerprint = createHash("sha256")
      .update(
        canonicalJson(
          selected
            ? ({ ...input, data: nativeData } as unknown as Json)
            : { id: input.id, type: input.type, agent: input.agentId ?? null },
          8 * 1024 * 1024,
        ).json,
      )
      .digest("hex");
    const previous = this.seen.get(input.id);
    if (previous !== undefined) {
      check(previous === fingerprint, "EVENT_ID_CONFLICT");
      return null;
    }
    // One SDK attachment is an ordered notification stream, not a replay source.
    // Recent duplicate protection is bounded; delta bodies remain partial until
    // an absolute native result arrives. A lifetime counter must not end capture.
    this.seen.set(input.id, fingerprint);
    while (this.seen.size > 1024) this.seen.delete(this.seen.keys().next().value!);
    const control = [
      "permission.requested",
      "permission.completed",
      "assistant.turn_start",
      "session.idle",
    ].includes(input.type);
    if (!selected && !control) return input;
    if (input.agentId) this.ensureChild(input.agentId);
    if (input.type === "subagent.started") {
      const child = text(input.agentId, 1024),
        tool = text(input.data.toolCallId, 1024);
      check(child !== this.run.nativeSession, "CHILD_ROOT_ALIAS");
      check(
        !this.active.has(child) ||
          this.active.get(child) === tool ||
          this.active.get(child) === "<unobserved-task>",
        "CHILD_TASK_OVERLAP",
      );
      this.children.set(child, tool);
      this.active.set(child, tool);
    }
    if (input.type === "subagent.completed" || input.type === "subagent.failed") {
      const child = text(input.agentId, 1024);
      check(this.children.has(child), "UNPROVED_CHILD");
      const tool = text(input.data.toolCallId, 1024),
        known = this.children.get(child);
      if (known && known !== tool) return input;
      this.children.set(child, tool);
      this.active.delete(child);
    }
    if (
      input.agentId &&
      !this.active.has(input.agentId) &&
      /^(assistant\.(message|reasoning|turn_start)|tool\.execution_start|permission\.requested)/.test(
        input.type,
      )
    )
      this.active.set(input.agentId, "<unobserved-task>");
    const owner = this.owner(input);
    const stream = owner.relation === "root" ? "root" : owner.nativeAgent;
    const window = this.window(stream);
    let projected = input;
    if (input.type === "subagent.configured") {
      const task = this.children.get(text(input.agentId, 1024));
      if (task) projected = { ...input, data: { ...input.data, toolCallId: task } };
    }
    const current = window.getSnapshot();
    let candidate = record(projected, stream);
    if (candidate) {
      const prior = current.rows.find((row) => row.id === candidate!.id);
      candidate = record(projected, stream, prior);
      if (candidate) window.update({ rows: [candidate] });
    }
    if (input.type.startsWith("subagent.")) {
      const delegate = record(projected, "root");
      if (delegate) this.root().update({ rows: [delegate] });
    }
    let update: Update | undefined;
    if (input.type === "session.idle") {
      if (input.agentId) this.active.delete(input.agentId);
      else this.active.clear();
      update = { activity: { state: "idle", turnId: null } };
    } else if (input.type === "assistant.turn_start")
      update = {
        activity: {
          state: "working",
          turnId: typeof input.data.turnId === "string" ? input.data.turnId : null,
        },
      };
    else if (input.type === "session.error")
      update = { activity: { state: "failed", turnId: null } };
    if (update) window.update(update);
    return input;
  }
  close(): void {
    for (const window of this.windows.values()) window.close();
  }
}
/** Persisted SDK cursors are single-use capabilities, never safe retry tokens. */
export function historyPort(
  scope: HistoryScope,
  mode: "active" | "persisted",
  read: (request: Readonly<Record<string, unknown>>) => Promise<unknown>,
  project?: (input: Event) => Promise<Event>,
): HistoryReadPort {
  const consumed = new Set<string>();
  return {
    scope,
    mode: mode === "persisted" ? "singleUse" : "repeatable",
    async read(input, assertCurrent): Promise<NativePage> {
      check(
        Number.isSafeInteger(input.count) && input.count > 0 && input.count <= 128,
        "HISTORY_COUNT",
      );
      if (input.cursor !== null) text(input.cursor, 8192);
      const cursor = input.cursor ?? "<initial>";
      if (mode === "persisted") {
        check(consumed.size < 4096, "HISTORY_CURSOR_CAPACITY");
        if (consumed.has(cursor)) return { status: "expired" };
        consumed.add(cursor);
      }
      assertCurrent();
      const response = object(
        await read({
          ...(mode === "persisted"
            ? { sessionId: scope.run.nativeSession }
            : scope.stream === "root"
              ? { agentScope: "primary", includeEphemeral: false }
              : { agentIds: [scope.stream], includeEphemeral: false }),
          ...(input.cursor === null ? {} : { cursor: input.cursor }),
          max: input.count,
          direction: "backward",
        }),
      );
      assertCurrent();
      check(
        Array.isArray(response.events) && response.events.length <= input.count,
        "HISTORY_PAGE",
      );
      check(
        typeof response.cursor === "string" &&
          response.cursor.length <= 8192 &&
          typeof response.hasMore === "boolean",
        "HISTORY_CURSOR",
      );
      if (response.cursorStatus === "expired") return { status: "expired" };
      check(response.cursorStatus === "ok", "HISTORY_STATUS");
      check(
        !response.hasMore || (response.cursor !== input.cursor && response.cursor.length > 0),
        "HISTORY_CURSOR_STALLED",
      );
      const rows = new Map<string, HistoryRecord>();
      for (const raw of response.events) {
        let item = event(raw);
        check(!item.ephemeral, "HISTORY_EPHEMERAL");
        const stream =
          item.agentId ?? (item.data.parentToolCallId === undefined ? "root" : "<legacy>");
        const primaryDelegation = scope.stream === "root" && item.type.startsWith("subagent.");
        if (stream !== scope.stream && !primaryDelegation) {
          check(mode === "persisted", "HISTORY_FOREIGN_CHILD");
          continue;
        }
        if (project) item = await project(item);
        assertCurrent();
        const candidate = record(item, scope.stream);
        if (candidate) rows.set(candidate.id, record(item, scope.stream, rows.get(candidate.id))!);
      }
      return {
        status: "page",
        scope,
        rows: [...rows.values()],
        placement: "before",
        nextCursor: response.hasMore ? response.cursor : null,
      };
    },
  };
}
