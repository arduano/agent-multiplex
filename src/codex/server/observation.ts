import type { RunRef, Json } from "../../protocol/index.js";
import { canonicalJson, cloneJson } from "../../protocol/index.js";
import type {
  CodexCaptureCursor,
  CodexCaptureEvent,
  CodexCaptureFrame,
  CodexCaptureSnapshot,
  CodexNotification,
} from "../native-contracts.js";
import { notificationSchema } from "./native-validation.js";
import { check, object, text } from "./validation.js";
import { threadMetadata, type ThreadMetadata } from "./lineage.js";
import { CodexCapture } from "../capture.js";

type Observer = { push(frame: CodexCaptureFrame): void; close(): void };
type ThreadOwner = { parent: string | null; metadata?: ThreadMetadata; closed: boolean };
// The published bridge's logical control frame is 1 MiB. Retained native state
// and its raw replay suffix each get 256 KiB, leaving room for the DTO envelope.
const captureBytes = 262_144;
const frameBytes = 786_432;
const dtoFrame = (value: unknown): CodexCaptureFrame =>
  cloneJson(value as Json, frameBytes) as CodexCaptureFrame;

/** One attachment's bounded native observation. It does not fetch, normalize
 * transcript rows, own native effects, or claim an atomic native watermark. */
export class CodexObservation {
  private revision = 0;
  private earlierOmitted = false;
  private events: { value: CodexCaptureEvent; bytes: number }[] = [];
  private bytes = 0;
  private readonly observers = new Set<Observer>();
  private readonly threads = new Map<string, ThreadOwner>();
  private readonly blocked = new Set<string>();
  private readonly waiting: CodexNotification[] = [];
  private waitingBytes = 0;
  private closed = false;
  private readonly state: CodexCapture;
  readonly limits: Readonly<{
    maxEvents: number;
    maxBytes: number;
    maxObservers: number;
    maxQueued: number;
  }>;
  constructor(
    readonly run: RunRef,
    readonly attachment: string,
    limits = {
      maxEvents: 128,
      maxBytes: captureBytes,
      maxObservers: 32,
      maxQueued: 16,
    },
    readonly openedAs: CodexCaptureSnapshot["coverage"]["openedAs"] = "unknown",
  ) {
    this.run = structuredClone(run);
    this.limits = Object.freeze({ ...limits });
    for (const value of Object.values(this.limits))
      check(Number.isSafeInteger(value) && value > 0 && value <= 1_048_576, "OBSERVATION_LIMIT");
    check(
      limits.maxEvents <= 1024 &&
        limits.maxBytes <= captureBytes &&
        limits.maxObservers <= 64 &&
        limits.maxQueued <= 128,
      "OBSERVATION_LIMIT",
    );
    this.state = new CodexCapture(
      this.run,
      Math.min(512, this.limits.maxEvents * 4),
      this.limits.maxBytes,
    );
    this.threads.set(run.nativeSession, { parent: null, closed: false });
  }
  owner(
    thread: string,
    includeClosed = false,
  ): Readonly<{ nativeAgent: string; relation: "root" | "child" }> | null {
    const value = this.threads.get(thread);
    return value && !this.blocked.has(thread) && (includeClosed || !value.closed)
      ? { nativeAgent: thread, relation: thread === this.run.nativeSession ? "root" : "child" }
      : null;
  }
  private quarantine(thread: string): void {
    const affected = new Set([thread]);
    for (let changed = true; changed;) {
      changed = false;
      for (const [id, owner] of this.threads)
        if (owner.parent && affected.has(owner.parent) && !affected.has(id)) {
          affected.add(id);
          changed = true;
        }
    }
    for (const id of affected) this.blocked.add(id);
    this.gap();
  }
  private grant(parent: string, child: string): boolean {
    if (
      !this.owner(parent) ||
      child === this.run.nativeSession ||
      child === parent ||
      this.blocked.has(child)
    )
      return false;
    const prior = this.threads.get(child);
    if (prior) {
      if (prior.parent !== parent) this.quarantine(child);
      return prior.parent === parent && !this.blocked.has(child);
    }
    if (this.threads.size >= 64) {
      this.gap();
      return false;
    }
    this.threads.set(child, { parent, closed: false });
    return true;
  }
  private metadata(raw: unknown): boolean {
    const value = threadMetadata(raw),
      existing = this.threads.get(value.id);
    if (value.id === this.run.nativeSession) {
      if (
        value.parent !== null ||
        (existing?.metadata && existing.metadata.context !== value.context)
      ) {
        this.gap();
        return false;
      }
      this.threads.get(value.id)!.metadata = value;
      return true;
    }
    if (!value.parent || !this.owner(value.parent)) return false;
    if (!this.grant(value.parent, value.id)) return false;
    const contexts = new Set([value.id]);
    let current: string | null = value.parent;
    for (let depth = 0; current && depth < 64; depth++) {
      const parent = this.threads.get(current);
      if (!parent) return false;
      contexts.add(current);
      if (parent.metadata) contexts.add(parent.metadata.context);
      current = parent.parent;
    }
    if (
      !contexts.has(value.context) ||
      (existing?.metadata && existing.metadata.context !== value.context)
    ) {
      this.quarantine(value.id);
      return false;
    }
    this.threads.get(value.id)!.metadata = value;
    return true;
  }
  observe(raw: unknown): void {
    if (this.closed) return;
    const parsed = notificationSchema.safeParse(raw);
    if (!parsed.success) {
      const method = raw && typeof raw === "object" ? object(raw).method : null;
      if (typeof method === "string" && /^(?:item|turn|thread)\//.test(method)) this.gap();
      return;
    }
    const value = cloneJson(
      parsed.data as unknown as Json,
      262_144,
    ) as unknown as CodexNotification;
    if (!this.accept(value)) {
      const size = canonicalJson(value as unknown as Json, 262_144).bytes;
      if (this.waiting.length >= 64 || this.waitingBytes + size > 131_072) {
        this.gap();
        return;
      }
      this.waiting.push(value);
      this.waitingBytes += size;
    }
    for (let changed = true; changed;) {
      changed = false;
      for (let i = 0; i < this.waiting.length;) {
        const pending = this.waiting[i]!;
        if (this.accept(pending)) {
          this.waiting.splice(i, 1);
          this.waitingBytes -= canonicalJson(pending as unknown as Json, 262_144).bytes;
          changed = true;
        } else i++;
      }
    }
  }
  private accept(value: CodexNotification): boolean {
    const params = object(value.params),
      thread =
        value.method === "thread/started" ? text(object(params.thread).id) : text(params.threadId);
    if (this.blocked.has(thread)) return true;
    if (value.method === "thread/started") {
      if (!this.metadata(params.thread)) return false;
    } else if (!this.owner(thread, true)) return false;
    if (value.method === "thread/closed") this.threads.get(thread)!.closed = true;
    if (value.method === "item/started" || value.method === "item/completed") {
      const item = object(params.item);
      if (item.type === "subAgentActivity" && item.kind === "started")
        this.grant(thread, text(item.agentThreadId));
    }
    this.append(value);
    return true;
  }
  private append(notification: CodexNotification): void {
    check(this.revision < Number.MAX_SAFE_INTEGER, "OBSERVATION_REVISION_EXHAUSTED");
    const value: CodexCaptureEvent = {
      cursor: { attachment: this.attachment, revision: ++this.revision },
      notification,
    };
    this.state.ingest(value);
    const bytes = canonicalJson(value as unknown as Json, 524_288).bytes;
    this.events.push({ value, bytes });
    this.bytes += bytes;
    while (this.events.length > this.limits.maxEvents || this.bytes > this.limits.maxBytes) {
      this.bytes -= this.events.shift()!.bytes;
      this.earlierOmitted = true;
    }
    for (const observer of this.observers)
      observer.push(dtoFrame({ kind: "notification", run: this.run, event: value }));
  }
  snapshot(): CodexCaptureSnapshot {
    const state = this.state.snapshot();
    return cloneJson(
      {
        run: this.run,
        attachment: this.attachment,
        revision: this.revision,
        source: "host-capture",
        coverage: {
          kind: "bounded-observation",
          nativeContinuity: "unproved",
          openedAs: this.openedAs,
          earlierOmitted: this.earlierOmitted || this.waiting.length > 0 || state.omitted,
        },
        events: this.events.map((event) => event.value),
        state,
      } as unknown as Json,
      frameBytes,
    ) as unknown as CodexCaptureSnapshot;
  }
  gap(): void {
    if (this.closed) return;
    this.earlierOmitted = true;
    // Retire local replay at loss; a cursor from before this revision cannot
    // appear continuous merely because later notifications were captured.
    this.events = [];
    this.bytes = 0;
    this.revision++;
    this.state.markGap();
    for (const observer of this.observers)
      observer.push(dtoFrame({ kind: "gap", snapshot: this.snapshot() }));
  }
  watch(after?: CodexCaptureCursor): AsyncIterableIterator<CodexCaptureFrame> {
    check(!this.closed && this.observers.size < this.limits.maxObservers, "OBSERVATION_CAPACITY");
    let frames: CodexCaptureFrame[];
    const first = this.events[0]?.value.cursor.revision;
    if (
      after &&
      after.attachment === this.attachment &&
      after.revision <= this.revision &&
      (after.revision === this.revision || (first !== undefined && after.revision >= first - 1))
    )
      frames = this.events
        .filter((event) => event.value.cursor.revision > after.revision)
        .map((event) => dtoFrame({ kind: "notification", run: this.run, event: event.value }));
    else frames = [dtoFrame({ kind: after ? "gap" : "snapshot", snapshot: this.snapshot() })];
    // An already-current cursor still needs a positive Host checkpoint. Quiet
    // thinking must not leave a successfully restored observer "unavailable".
    if (!frames.length) frames = [dtoFrame({ kind: "snapshot", snapshot: this.snapshot() })];
    let ended = false,
      waiter: ((part: IteratorResult<CodexCaptureFrame>) => void) | undefined;
    const observer: Observer = {
      push: (frame) => {
        if (ended) return;
        if (waiter) {
          const ready = waiter;
          waiter = undefined;
          ready({ done: false, value: structuredClone(frame) });
        } else if (frames.length >= this.limits.maxQueued)
          frames = [dtoFrame({ kind: "gap", snapshot: this.snapshot() })];
        else frames.push(structuredClone(frame));
      },
      close: () => {
        ended = true;
        frames = [];
        this.observers.delete(observer);
        waiter?.({ done: true, value: undefined });
        waiter = undefined;
      },
    };
    if (frames.length > this.limits.maxQueued)
      frames = [dtoFrame({ kind: "gap", snapshot: this.snapshot() })];
    this.observers.add(observer);
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => {
        check(!waiter, "CONCURRENT_OBSERVATION_NEXT");
        const value = frames.shift();
        if (value) return { done: false, value: structuredClone(value) };
        if (ended) return { done: true, value: undefined };
        return new Promise((resolve) => {
          waiter = resolve;
        });
      },
      return: async () => {
        observer.close();
        return { done: true, value: undefined };
      },
    };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const observer of [...this.observers]) observer.close();
  }
}
