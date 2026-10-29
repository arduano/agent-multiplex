import {
  HistoryWindow,
  type HistoryRecord,
  type HistoryScope,
  type NativePage,
  type RowKind,
} from "../../history/index.js";
import { optionalQuestions } from "../../interactions/index.js";
import type { Json, RunRef } from "../../protocol/index.js";
import type { CodexDiagnostic } from "../contracts.js";
import { proveLineage, threadMetadata, type ThreadMetadata } from "./lineage.js";
import type { Notification } from "../node-contracts.js";
import { CodexMedia, withCodexAssets } from "./media.js";
import type { CodexAsset } from "../contracts.js";
import { body, check, json, object, text } from "./validation.js";

const terminal = (value: unknown): HistoryRecord["lifecycle"] =>
  value === "completed"
    ? "completed"
    : value === "failed"
      ? "failed"
      : value === "interrupted"
        ? "interrupted"
        : "running";
function compareIds(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
/** The same completed-item projection is used by live and explicit pages.
 * Unsupported bodies stay explicit; parent-turn completion does not finish an item. */
export function codexItem(
  threadId: string,
  turnId: string,
  raw: unknown,
  completed: boolean,
  assets: readonly CodexAsset[] = [],
): HistoryRecord {
  const item = object(raw),
    id = text(item.id),
    type = text(item.type);
  check(item.threadId === undefined || item.threadId === threadId, "FOREIGN_HISTORY_THREAD");
  check(item.turnId === undefined || item.turnId === turnId, "FOREIGN_HISTORY_TURN");
  if (completed)
    check(
      item.status === undefined ||
        ["completed", "failed", "declined", "interrupted"].includes(String(item.status)),
      "ITEM_COMPLETION_CONFLICT",
    );
  let kind: RowKind = "tool",
    content: string | undefined;
  const native: Record<string, Json> = {
    family: "codex",
    type,
    threadId,
    turnId,
    itemId: id,
    completed,
  };
  if (type === "userMessage" && typeof item.clientUserMessageId === "string")
    native.originalId = text(item.clientUserMessageId);
  if (type === "agentMessage" || type === "plan") {
    kind = "assistant";
    content = body(item.text ?? "");
    native.plan = type === "plan";
    if (typeof item.phase === "string") native.phase = text(item.phase);
    if (type === "agentMessage") {
      const optional = optionalQuestions(item.questions);
      if (optional.questions.length) native.questions = json(optional.questions, 12288);
      if (optional.omitted) native.questionsOmitted = optional.omitted;
    }
  } else if (type === "commandExecution") {
    content = typeof item.aggregatedOutput === "string" ? body(item.aggregatedOutput) : undefined;
    if (typeof item.command === "string") native.command = body(item.command, 8192);
    if (typeof item.processId === "string") native.processId = text(item.processId);
  } else if (type === "reasoning") {
    kind = "reasoning";
    content = body(
      [
        ...(Array.isArray(item.summary) ? item.summary : []),
        ...(Array.isArray(item.content) ? item.content : []),
      ]
        .filter((value) => typeof value === "string")
        .join("\n"),
    );
  } else if (
    [
      "userMessage",
      "message",
      "mcpToolCall",
      "dynamicToolCall",
      "functionCallOutput",
      "fileChange",
      "webSearch",
      "imageView",
      "imageGeneration",
    ].includes(type)
  ) {
    kind = type === "userMessage" ? "user" : type === "message" ? "assistant" : "tool";
    const result = item.result && typeof item.result === "object" ? object(item.result) : {};
    const parts =
      type === "mcpToolCall"
        ? result.content
        : type === "dynamicToolCall"
          ? item.contentItems
          : type === "functionCallOutput"
            ? item.output
            : item.content;
    if (Array.isArray(parts)) {
      content = body(
        parts
          .map((value) => {
            const part = object(value);
            return ["text", "inputText", "input_text", "output_text"].includes(String(part.type)) &&
              typeof part.text === "string"
              ? part.text
              : "";
          })
          .filter(Boolean)
          .join("\n"),
      );
      const media = parts.filter((value) =>
        ["image", "image_url", "inputImage", "input_image", "localImage"].includes(
          String(object(value).type),
        ),
      );
      if (media.length && !assets.length) native.mediaOmitted = media.length; // Actual file bytes need the injected file owner.
    } else if (typeof item.output === "string") content = body(item.output);
    if (type === "fileChange" && Array.isArray(item.changes))
      native.paths = item.changes.slice(0, 32).map((value) => text(object(value).path, 4096));
  } else if (type === "contextCompaction") {
    kind = "notice";
    native.compaction = true;
  } else if (type === "subAgentActivity" || type === "collabAgentToolCall") {
    kind = "delegation";
    if (type === "subAgentActivity") {
      native.agentThreadId = text(item.agentThreadId);
      native.agentKind = text(item.kind);
    } else if (Array.isArray(item.receiverThreadIds))
      native.receiverThreadIds = item.receiverThreadIds.slice(0, 32).map((value) => text(value));
  } else {
    native.unsupported = true;
  }
  return {
    id: `${threadId}:${id}`,
    kind,
    lifecycle: completed
      ? terminal(
          item.status === "failed"
            ? "failed"
            : item.status === "interrupted" || item.status === "declined"
              ? "interrupted"
              : "completed",
        )
      : "running",
    body:
      content === undefined
        ? {
            kind: "unavailable",
            reason: [
              "contextCompaction",
              "subAgentActivity",
              "collabAgentToolCall",
              "imageView",
              "imageGeneration",
            ].includes(type)
              ? "nativeOmitted"
              : "unsupported",
          }
        : completed
          ? { kind: "complete", text: content, evidence: "native" }
          : { kind: "partial", text: content, missing: ["final"] },
    native: withCodexAssets(native, assets),
  };
}
export function codexError(
  threadId: string,
  turnId: string,
  error: unknown,
  retry: boolean,
): HistoryRecord {
  const value = typeof error === "string" ? error : object(error).message;
  return {
    id: `${threadId}:${turnId}:error:${retry ? "retry" : "final"}`,
    kind: "notice",
    lifecycle: retry ? "running" : "failed",
    body: { kind: "complete", text: body(value, 16384), evidence: "native" },
    native: { family: "codex", type: "error", threadId, turnId, retry },
  };
}
type Node = {
  metadata?: ThreadMetadata;
  parent: string | null;
  closed: boolean;
  holds: number;
  window: HistoryWindow;
  items: Map<string, HistoryRecord>;
  turns: Set<string>;
  current: string | null;
};
export class CodexHistory {
  readonly #nodes = new Map<string, Node>();
  readonly #blocked = new Set<string>();
  readonly #waiting: Notification[] = [];
  #ancestryFailed = false;
  constructor(
    readonly run: RunRef,
    readonly attachment: string,
    readonly diagnostic: (value: CodexDiagnostic) => void = () => {},
    knownEmpty = false,
    readonly media?: CodexMedia,
  ) {
    this.#nodes.set(run.nativeSession, this.#make(run.nativeSession, null, knownEmpty));
  }
  #make(thread: string, parent: string | null, knownEmpty = false): Node {
    if (this.#nodes.size >= 64)
      for (const [id, node] of this.#nodes) {
        if (
          id !== this.run.nativeSession &&
          node.closed &&
          !node.holds &&
          !node.window.subscriberCount &&
          ![...this.#nodes.values()].some((child) => child.parent === id)
        ) {
          node.window.close();
          this.#nodes.delete(id);
          break;
        }
      }
    check(this.#nodes.size < 64, "HISTORY_SCOPE_CAPACITY");
    return {
      parent,
      closed: false,
      holds: 0,
      window: new HistoryWindow(
        { run: this.run, attachment: this.attachment, stream: thread },
        {},
        knownEmpty,
      ),
      items: new Map(),
      turns: new Set(),
      current: null,
    };
  }
  scopes(): readonly HistoryScope[] {
    return [...this.#nodes.values()].map((value) => value.window.scope);
  }
  get observed(): boolean {
    return [...this.#nodes.values()].some(
      (node) => node.holds > 0 || node.window.subscriberCount > 0,
    );
  }
  close(): void {
    for (const node of this.#nodes.values()) node.window.close();
    this.#waiting.length = 0;
  }
  window(thread = this.run.nativeSession): HistoryWindow {
    const node = this.#nodes.get(thread);
    check(node && !this.#blocked.has(thread), "UNPROVED_THREAD");
    return node.window;
  }
  owner(
    thread: string,
    includeClosed = false,
  ): Readonly<{ nativeAgent: string; relation: "root" | "child" }> | null {
    const node = this.#nodes.get(thread);
    return node &&
      (includeClosed || !node.closed) &&
      !this.#blocked.has(thread) &&
      (thread === this.run.nativeSession || !this.#ancestryFailed)
      ? { nativeAgent: thread, relation: thread === this.run.nativeSession ? "root" : "child" }
      : null;
  }
  protect(thread: string, includeClosed = false): () => void {
    const node = this.#nodes.get(thread);
    check(node && this.owner(thread, includeClosed), "UNPROVED_THREAD");
    node.holds++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        node.holds--;
      }
    };
  }
  activity(): Readonly<{
    state: "working" | "idle" | "unknown" | "failed";
    turnId: string | null;
  }> {
    return this.window().getSnapshot().activity;
  }
  terminalTurn(turnId: string): boolean {
    return this.#nodes.get(this.run.nativeSession)!.turns.has(turnId);
  }
  lost(): void {
    for (const node of this.#nodes.values())
      node.window.update({
        gaps: [{ id: "codex:capture-lost", kind: "captureLost" }],
        activity: { state: "unknown", turnId: node.current },
      });
  }
  ingest(value: Notification): void {
    try {
      if (value.method === "thread/started") {
        if (!this.#metadata(threadMetadata(object(value.params).thread))) {
          this.#queue(value);
          return;
        }
        this.#drain();
        return;
      }
      const params = object(value.params),
        thread = typeof params.threadId === "string" ? params.threadId : null;
      if (!thread || this.#blocked.has(thread)) return;
      const node = this.#nodes.get(thread);
      if (!node) {
        this.#queue(value);
        return;
      }
      this.#apply(node, thread, value.method, params);
      this.#drain();
    } catch (error) {
      this.diagnostic({
        stage: "codec",
        code: error instanceof Error && "code" in error ? String(error.code) : "REJECTED",
      });
      this.window().update({ gaps: [{ id: "codex:rejected", kind: "unsupported" }] });
    }
  }
  #queue(value: Notification): void {
    check(
      this.#waiting.length < 8 &&
        Buffer.byteLength(JSON.stringify([...this.#waiting, value])) < 262144,
      "ANCESTRY_BUFFER_CAPACITY",
    );
    this.#waiting.push(value);
  }
  #quarantine(id: string): void {
    const blocked = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [child, node] of this.#nodes)
        if (node.parent && blocked.has(node.parent) && !blocked.has(child)) {
          blocked.add(child);
          changed = true;
        }
    }
    for (const child of blocked)
      if (child !== this.run.nativeSession) {
        if (this.#blocked.size >= 64) this.#ancestryFailed = true;
        else this.#blocked.add(child);
      }
  }
  #metadata(metadata: ThreadMetadata): boolean {
    const existing = this.#nodes.get(metadata.id);
    if (
      this.#blocked.has(metadata.id) ||
      (metadata.id !== this.run.nativeSession && this.#ancestryFailed)
    )
      return true;
    if (metadata.id === this.run.nativeSession) {
      if (
        metadata.parent !== null ||
        (existing?.metadata && existing.metadata.context !== metadata.context)
      ) {
        this.#ancestryFailed = true;
        check(false, "ROOT_METADATA_CONFLICT");
      }
      this.#nodes.get(metadata.id)!.metadata = metadata;
      return true;
    }
    if (
      existing &&
      (existing.parent !== metadata.parent ||
        (existing.metadata && existing.metadata.context !== metadata.context))
    ) {
      this.#quarantine(metadata.id);
      check(false, "ANCESTRY_CONFLICT");
    }
    const parent = metadata.parent && this.#nodes.get(metadata.parent);
    if (!parent || parent.closed) return false;
    const ancestors: ThreadMetadata[] = [metadata],
      seen = new Set([metadata.id]);
    let node: Node | undefined = parent;
    while (node) {
      if (!node.metadata) return false;
      check(!seen.has(node.metadata.id) && seen.size < 33, "ANCESTRY_CYCLE");
      seen.add(node.metadata.id);
      ancestors.push(node.metadata);
      node = node.parent ? this.#nodes.get(node.parent) : undefined;
    }
    try {
      proveLineage(
        this.run.nativeSession,
        metadata.id,
        ancestors.map((item) => ({
          id: item.id,
          sessionId: item.context,
          parentThreadId: item.parent,
        })),
      );
    } catch (error) {
      this.#quarantine(metadata.id);
      throw error;
    }
    const child = existing ?? this.#make(metadata.id, metadata.parent);
    child.metadata = metadata;
    this.#nodes.set(metadata.id, child);
    return true;
  }
  #drain(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (let index = 0; index < this.#waiting.length;) {
        const value = this.#waiting[index]!,
          params = object(value.params),
          id =
            value.method === "thread/started" ? threadMetadata(params.thread).id : params.threadId;
        let consumed = false;
        try {
          if (value.method === "thread/started" && this.#metadata(threadMetadata(params.thread))) {
            this.#waiting.splice(index, 1);
            changed = true;
          } else if (
            value.method !== "thread/started" &&
            typeof id === "string" &&
            (this.#nodes.has(id) || this.#blocked.has(id))
          ) {
            this.#waiting.splice(index, 1);
            consumed = true;
            if (!this.#blocked.has(id)) this.#apply(this.#nodes.get(id)!, id, value.method, params);
            changed = true;
          } else index++;
        } catch {
          if (!consumed) this.#waiting.splice(index, 1);
          changed = true;
          this.diagnostic({ stage: "ancestry", code: "BUFFERED_ANCESTRY_REJECTED" });
          this.window().update({ gaps: [{ id: "codex:rejected", kind: "unsupported" }] });
        }
      }
    }
  }
  #apply(node: Node, thread: string, method: string, params: Record<string, unknown>): void {
    if (method === "thread/closed") {
      node.closed = true;
      return;
    }
    if (method === "thread/reverted") {
      node.window.invalidateReads("Native thread history changed");
      return;
    }
    if (method === "turn/started" || method === "turn/completed") {
      const turn = object(params.turn),
        id = text(turn.id),
        status = text(turn.status);
      if (method === "turn/started") {
        if (node.turns.has(id)) return;
        node.current = id;
        node.window.update({ activity: { state: "working", turnId: id } });
      } else {
        check(["completed", "failed", "interrupted"].includes(status), "TURN_STATUS");
        node.turns.add(id);
        while (node.turns.size > 128) node.turns.delete(node.turns.values().next().value!);
        const rows = turn.error == null ? [] : [codexError(thread, id, turn.error, false)];
        if (node.current === id || node.current === null) {
          node.current = null;
          node.window.update({
            rows,
            activity: { state: status === "failed" ? "failed" : "idle", turnId: null },
          });
        } else if (rows.length) node.window.update({ rows });
      }
      return;
    }
    if (method === "thread/status/changed") {
      const status = object(params.status).type;
      if (status === "idle" && node.current === null)
        node.window.update({ activity: { state: "idle", turnId: null } });
      else if (status === "active")
        node.window.update({ activity: { state: "working", turnId: node.current } });
      return;
    }
    const turnId = typeof params.turnId === "string" ? params.turnId : null;
    if (method === "error") {
      check(turnId);
      node.window.update({
        rows: [codexError(thread, turnId, params.error, params.willRetry === true)],
      });
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      check(turnId);
      const raw = object(params.item),
        completed = method === "item/completed",
        row = codexItem(thread, turnId, raw, completed, this.media?.project(thread, turnId, raw));
      node.items.set(text(raw.id), row);
      node.window.update({ rows: [row] });
      if (raw.type === "subAgentActivity" && raw.kind === "started") {
        const child = text(raw.agentThreadId),
          previous = this.#nodes.get(child);
        check(
          child !== this.run.nativeSession &&
            child !== thread &&
            (!previous || previous.parent === thread),
          "ANCESTRY_CONFLICT",
        );
        if (!previous) this.#nodes.set(child, this.#make(child, thread));
      }
      const completedItems = [...node.items.entries()].filter(
        ([, item]) => item.lifecycle !== "running",
      );
      for (const [id] of completedItems.slice(0, Math.max(0, node.items.size - 128)))
        node.items.delete(id);
      check(node.items.size <= 256, "UNFINISHED_ITEM_CAPACITY");
      return;
    }
    const deltaKind =
      method === "item/agentMessage/delta" || method === "item/plan/delta"
        ? "assistant"
        : method === "item/commandExecution/outputDelta"
          ? "tool"
          : ["item/reasoning/summaryTextDelta", "item/reasoning/textDelta"].includes(method)
            ? "reasoning"
            : null;
    if (!deltaKind) return;
    check(turnId);
    const id = text(params.itemId),
      previous = node.items.get(id);
    if (previous && previous.lifecycle !== "running") return;
    const content = body(
      (previous?.body.kind === "partial" ? previous.body.text : "") + body(params.delta),
    );
    check(previous || node.items.size < 256, "UNFINISHED_ITEM_CAPACITY");
    const row: HistoryRecord = {
      id: `${thread}:${id}`,
      kind: deltaKind,
      lifecycle: "running",
      body: {
        kind: "partial",
        text: content,
        missing:
          previous?.body.kind === "partial"
            ? previous.body.missing
            : previous
              ? ["final"]
              : ["prefix", "final"],
      },
      native: previous?.native ?? {
        family: "codex",
        type: deltaKind,
        threadId: thread,
        turnId,
        itemId: id,
      },
    };
    node.items.set(id, row);
    node.window.update({ rows: [row] });
  }
}

/** Pinned native timeline pages retain failed itemless turns and item completion.
 * Native ascending entry order is preserved, never guessed from IDs/time. */
export function codexTimelinePage(
  scope: HistoryScope,
  raw: unknown,
  media?: CodexMedia,
): NativePage {
  const page = object(raw);
  check(Array.isArray(page.data) && page.data.length <= 128, "HISTORY_PAGE_BOUND");
  check(page.threadId === undefined || page.threadId === scope.stream, "FOREIGN_HISTORY_THREAD");
  const rows: HistoryRecord[] = [],
    gaps: NonNullable<Extract<NativePage, { status: "page" }>["gaps"]>[number][] = [];
  let previous: readonly [number, number, string] | undefined;
  for (const entry of page.data) {
    const value = object(entry);
    check(
      value.threadId === undefined || value.threadId === scope.stream,
      "FOREIGN_HISTORY_THREAD",
    );
    const rank =
      value.type === "turnStarted"
        ? 0
        : value.type === "item"
          ? 1
          : value.type === "realtime"
            ? 2
            : value.type === "turnCompleted"
              ? 3
              : -1;
    check(
      Number.isSafeInteger(value.position) && (value.position as number) >= 0 && rank >= 0,
      "TIMELINE_ORDER",
    );
    const id = text(
        value.type === "item" || value.type === "realtime" ? object(value.item).id : value.turnId,
      ),
      key = [value.position as number, rank, id] as const;
    check(
      !previous ||
        key[0] > previous[0] ||
        (key[0] === previous[0] &&
          (key[1] > previous[1] ||
            (key[1] === previous[1] && compareIds(key[2], previous[2]) > 0))),
      "TIMELINE_ORDER",
    );
    previous = key;
    if (value.type === "item")
      rows.push(
        codexItem(
          scope.stream,
          text(value.turnId),
          value.item,
          true,
          media?.view(scope.stream, text(value.turnId), value.item),
        ),
      );
    else if (value.type === "turnCompleted") {
      check(["completed", "failed", "interrupted"].includes(String(value.status)), "TURN_STATUS");
      if (value.error != null)
        rows.push(codexError(scope.stream, text(value.turnId), value.error, false));
    } else if (value.type === "realtime" && !gaps.length)
      gaps.push({ id: "codex:history:unsupported:realtime", kind: "unsupported" });
  }
  check(page.nextCursor === null || typeof page.nextCursor === "string", "HISTORY_CURSOR");
  return {
    status: "page",
    scope,
    rows,
    placement: "before",
    nextCursor: page.nextCursor as string | null,
    gaps,
  };
}
