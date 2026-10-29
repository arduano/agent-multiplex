import type {
  CodexCaptureCursor,
  CodexCaptureEvent,
  CodexCaptureFrame,
  CodexCaptureSnapshot,
  Thread,
  ThreadItem,
  ThreadSettings,
  Turn,
} from "./native-contracts.js";
import { canonicalJson, type Json, type RunRef } from "../protocol/index.js";

import type { CodexCapturedItem, CodexCapturedState } from "./capture-contracts.js";
export type { CodexCapturedItem, CodexCapturedState } from "./capture-contracts.js";
export function immutable<T>(value: T): T {
  const copy = structuredClone(value);
  const freeze = (part: unknown): void => {
    if (part && typeof part === "object") {
      for (const child of Object.values(part)) freeze(child);
      Object.freeze(part);
    }
  };
  freeze(copy);
  return copy;
}
export const key = (value: unknown): string => canonicalJson(value as Json, 4 * 1024 * 1024).json;
const itemKey = (thread: string, turn: string, item: string) => key([thread, turn, item]);
/** Native shapes stay native. Stored pages never become delta bases, and a
 * Host sequence describes only this capture, never a native read watermark. */
export class CodexCapture {
  #capture: Omit<CodexCaptureSnapshot, "state"> | null = null;
  #threads = new Map<string, Thread>();
  #settings = new Map<string, ThreadSettings>();
  #turns = new Map<string, { threadId: string; turn: Turn }>();
  #items = new Map<string, CodexCapturedItem>();
  #invalidated = new Map<string, CodexCaptureCursor>();
  #unbased: CodexCaptureEvent[] = [];
  #omitted = false;
  constructor(
    readonly run: RunRef,
    readonly maximumItems = 512,
    readonly maximumBytes = 4 * 1024 * 1024,
  ) {}
  get cursor(): CodexCaptureCursor | undefined {
    return this.#capture
      ? { attachment: this.#capture.attachment, revision: this.#capture.revision }
      : undefined;
  }
  snapshot(): CodexCapturedState {
    return immutable({
      threads: Object.fromEntries(this.#threads),
      settings: Object.fromEntries(this.#settings),
      turns: [...this.#turns.values()],
      items: [...this.#items.values()],
      invalidatedThreads: Object.fromEntries(this.#invalidated),
      unbased: this.#unbased,
      omitted: this.#omitted,
    });
  }
  get capture(): Omit<CodexCaptureSnapshot, "state"> | null {
    return this.#capture;
  }
  /** Hydrate a Host checkpoint atomically. Its raw replay suffix is not applied
   * again over the already assembled native state. */
  apply(frame: CodexCaptureFrame): readonly string[] {
    const incomingRun = frame.kind === "notification" ? frame.run : frame.snapshot.run;
    if (key(incomingRun) !== key(this.run)) throw Error("CODEX_RUN_FENCED");
    if (frame.kind === "notification") {
      if (
        !this.#capture ||
        this.#capture.attachment !== frame.event.cursor.attachment ||
        frame.event.cursor.revision > this.#capture.revision + 1
      )
        throw Error("CODEX_CAPTURE_SNAPSHOT_REQUIRED");
      return this.ingest(frame.event);
    }
    const incoming = immutable(frame.snapshot);
    if (
      this.#capture?.attachment === incoming.attachment &&
      incoming.revision < this.#capture.revision
    )
      return [];
    const { state, ...header } = incoming;
    this.#threads = new Map(Object.entries(state.threads));
    this.#settings = new Map(Object.entries(state.settings));
    this.#turns = new Map(state.turns.map((part) => [key([part.threadId, part.turn.id]), part]));
    this.#items = new Map(
      state.items.map((part) => [itemKey(part.threadId, part.turnId, part.item.id), part]),
    );
    const invalidated = Object.entries(state.invalidatedThreads)
      .filter(([thread, cursor]) => {
        const prior = this.#invalidated.get(thread);
        return (
          !prior || prior.attachment !== cursor.attachment || prior.revision !== cursor.revision
        );
      })
      .map(([thread]) => thread);
    this.#invalidated = new Map(Object.entries(state.invalidatedThreads));
    this.#unbased = [...state.unbased];
    this.#omitted = state.omitted;
    this.#capture = header;
    this.#bound();
    return invalidated;
  }
  /** Host native-capture ingestion. This is not an app-server history reader or
   * durable transcript: native gaps and bounded omission stay explicit. */
  ingest(value: CodexCaptureEvent): readonly string[] {
    const event = immutable(value),
      prior = this.#capture;
    if (prior?.attachment === event.cursor.attachment && event.cursor.revision <= prior.revision)
      return [];
    if (
      prior &&
      (prior.attachment !== event.cursor.attachment || event.cursor.revision !== prior.revision + 1)
    )
      this.markGap();
    const invalidated: string[] = [];
    this.#event(event, invalidated);
    const events = [...(prior?.attachment === event.cursor.attachment ? prior.events : []), event];
    this.#capture = {
      run: this.run,
      attachment: event.cursor.attachment,
      revision: event.cursor.revision,
      source: "host-capture",
      coverage: {
        kind: "bounded-observation",
        nativeContinuity: "unproved",
        openedAs: prior?.coverage.openedAs ?? "unknown",
        earlierOmitted: (prior?.coverage.earlierOmitted ?? false) || events.length > 128,
      },
      events: events.slice(-128),
    };
    this.#bound();
    return invalidated;
  }
  markGap(): void {
    this.#omitted = true;
    for (const [id, item] of this.#items)
      if (!item.completed) this.#items.set(id, { ...item, continuity: "partial" });
  }
  #bound(): void {
    // Exact native bodies are evicted, never silently truncated. No event-count
    // lifetime cap poisons a long-running attachment.
    for (const map of [
      this.#items,
      this.#turns,
      this.#threads,
      this.#settings,
      this.#invalidated,
    ]) {
      while (map.size > this.maximumItems) {
        map.delete(map.keys().next().value!);
        this.#omitted = true;
      }
    }
    const size = () =>
      new TextEncoder().encode(
        JSON.stringify({
          capture: this.#capture,
          threads: [...this.#threads],
          settings: [...this.#settings],
          turns: [...this.#turns],
          items: [...this.#items],
          unbased: this.#unbased,
          invalidated: [...this.#invalidated],
        }),
      ).byteLength;
    while (size() > this.maximumBytes) {
      if (this.#capture?.events.length)
        this.#capture = {
          ...this.#capture,
          coverage: { ...this.#capture.coverage, earlierOmitted: true },
          events: this.#capture.events.slice(1),
        };
      else {
        this.#omitted = true;
        if (this.#turns.size) this.#turns.delete(this.#turns.keys().next().value!);
        else if (this.#items.size) this.#items.delete(this.#items.keys().next().value!);
        else if (this.#threads.size) this.#threads.delete(this.#threads.keys().next().value!);
        else if (this.#settings.size) this.#settings.delete(this.#settings.keys().next().value!);
        else if (this.#unbased.length) this.#unbased.shift();
        else if (this.#invalidated.size)
          this.#invalidated.delete(this.#invalidated.keys().next().value!);
        else break;
      }
    }
  }
  #put(
    threadId: string,
    turnId: string,
    item: ThreadItem,
    event: CodexCaptureEvent,
    source: "started" | "snapshot" | "completed",
  ) {
    const id = itemKey(threadId, turnId, item.id);
    const prior = this.#items.get(id);
    if (prior?.completed && source === "started") return;
    const unbased = this.#unbased.some((part) => {
      const params = part.notification.params;
      return (
        "threadId" in params &&
        "turnId" in params &&
        "itemId" in params &&
        params.threadId === threadId &&
        params.turnId === turnId &&
        params.itemId === item.id
      );
    });
    const completed = source === "completed" || !!prior?.completed;
    this.#items.set(id, {
      threadId,
      turnId,
      item: immutable(item),
      attachment: event.cursor.attachment,
      revision: event.cursor.revision,
      completed,
      continuity:
        source === "completed" || source === "snapshot"
          ? "captured"
          : unbased
            ? "partial"
            : "captured",
    });
    this.#unbased = this.#unbased.filter((part) => {
      const params = part.notification.params;
      return !(
        "threadId" in params &&
        "turnId" in params &&
        "itemId" in params &&
        params.threadId === threadId &&
        params.turnId === turnId &&
        params.itemId === item.id
      );
    });
  }
  #event(event: CodexCaptureEvent, invalidated: string[]) {
    const note = event.notification;
    switch (note.method) {
      case "thread/started":
        this.#threads.set(note.params.thread.id, note.params.thread);
        return;
      case "thread/status/changed": {
        const prior = this.#threads.get(note.params.threadId);
        if (prior) this.#threads.set(prior.id, { ...prior, status: note.params.status });
        return;
      }
      case "thread/settings/updated":
        this.#settings.set(note.params.threadId, note.params.threadSettings);
        return;
      case "thread/reverted": {
        const thread = note.params.threadId;
        this.#invalidated.set(thread, event.cursor);
        invalidated.push(thread);
        for (const [id, item] of this.#items) if (item.threadId === thread) this.#items.delete(id);
        for (const [id, turn] of this.#turns) if (turn.threadId === thread) this.#turns.delete(id);
        this.#unbased = this.#unbased.filter(
          (part) =>
            !("threadId" in part.notification.params) ||
            part.notification.params.threadId !== thread,
        );
        return;
      }
      case "turn/started":
      case "turn/completed": {
        const { threadId, turn } = note.params;
        this.#turns.set(key([threadId, turn.id]), { threadId, turn });
        // A terminal turn can still have independently running tools/children.
        // Keep its exact item snapshots without inventing item/completed.
        for (const item of turn.items) this.#put(threadId, turn.id, item, event, "snapshot");
        return;
      }
      case "item/started":
      case "item/completed":
        this.#put(
          note.params.threadId,
          note.params.turnId,
          note.params.item,
          event,
          note.method === "item/completed" ? "completed" : "started",
        );
        return;
    }
    const params = note.params;
    if (!("threadId" in params && "turnId" in params && "itemId" in params)) return;
    const id = itemKey(params.threadId, params.turnId, params.itemId),
      prior = this.#items.get(id);
    if (prior?.completed && note.method !== "item/fileChange/patchUpdated") return;
    if (!prior || prior.attachment !== event.cursor.attachment) {
      this.#unbased.push(event);
      if (this.#unbased.length > 32) {
        this.#unbased.shift();
        this.#omitted = true;
      }
      return;
    }
    const item = structuredClone(prior.item);
    if (note.method === "item/agentMessage/delta" && item.type === "agentMessage")
      item.text += note.params.delta;
    else if (note.method === "item/plan/delta" && item.type === "plan")
      item.text += note.params.delta;
    else if (
      note.method === "item/commandExecution/outputDelta" &&
      item.type === "commandExecution"
    )
      item.aggregatedOutput = (item.aggregatedOutput ?? "") + note.params.delta;
    else if (note.method === "item/fileChange/patchUpdated" && item.type === "fileChange")
      item.changes = immutable(note.params.changes);
    else if (
      (note.method === "item/reasoning/summaryTextDelta" ||
        note.method === "item/reasoning/textDelta" ||
        note.method === "item/reasoning/summaryPartAdded") &&
      item.type === "reasoning"
    ) {
      const index =
        note.method !== "item/reasoning/textDelta"
          ? note.params.summaryIndex
          : note.params.contentIndex;
      if (!Number.isSafeInteger(index) || index < 0 || index > 1024) {
        this.#items.set(id, { ...prior, continuity: "partial" });
        this.#unbased = [...this.#unbased, event].slice(-32);
        this.#omitted = true;
        return;
      }
      const lane = note.method !== "item/reasoning/textDelta" ? item.summary : item.content;
      while (lane.length <= index) lane.push("");
      if (note.method !== "item/reasoning/summaryPartAdded") lane[index] += note.params.delta;
    } else return;
    this.#items.set(id, { ...prior, item, revision: event.cursor.revision });
  }
}
