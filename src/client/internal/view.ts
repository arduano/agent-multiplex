import type {
  Command,
  OriginalHandle,
  RowAnchor,
  AnchorSnapshot,
  AnchorPort,
  SessionEntryPort,
  SessionViewPort,
  TranscriptSnapshot,
  TranscriptViewPort,
} from "../contracts.js";
import type { SessionEntry } from "./session-entry.js";
import { check, runKey } from "./validation.js";

/** Only view intent and geometry. No transcript/native state is copied here. */
class AnchorController implements AnchorPort {
  #snapshot: AnchorSnapshot = Object.freeze({ mode: "followingLive", anchor: null, revision: 0 });
  #gesture = 0;
  #listeners = new Set<() => void>();
  #capture: (() => RowAnchor | null) | undefined;
  getSnapshot = (): AnchorSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    check(this.#listeners.size < 64, "FULL");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  captureGeometry(capture: () => RowAnchor | null): () => void {
    this.#capture = capture;
    return () => {
      if (this.#capture === capture) this.#capture = undefined;
    };
  }
  gesture(): void {
    this.#gesture++;
    this.#set("readingHistory", this.#capture?.() ?? this.#snapshot.anchor);
  }
  observed(anchor: RowAnchor | null, nearBottom: boolean): void {
    this.#set(nearBottom ? "followingLive" : "readingHistory", nearBottom ? null : anchor);
  }
  read(anchor: RowAnchor | null): void {
    this.#gesture++;
    this.#set("readingHistory", anchor);
  }
  followLatest(): void {
    this.#gesture++;
    this.#set("followingLive", null);
  }
  captureFollow(): () => void {
    const gesture = this.#gesture;
    let used = false;
    return () => {
      if (!used && gesture === this.#gesture) {
        used = true;
        this.#set("followingLive", null);
      }
    };
  }
  #set(mode: AnchorSnapshot["mode"], anchor: RowAnchor | null): void {
    if (
      this.#snapshot.mode === mode &&
      this.#snapshot.anchor?.rowId === anchor?.rowId &&
      this.#snapshot.anchor?.offset === anchor?.offset
    )
      return;
    this.#snapshot = Object.freeze({
      mode,
      anchor: anchor ? Object.freeze({ ...anchor }) : null,
      revision: this.#snapshot.revision + 1,
    });
    for (const listener of [...this.#listeners])
      try {
        listener();
      } catch {}
  }
}
/** Creating a view is inert. A committed UI effect acquires its sole lease;
 * StrictMode effect replay can release/reacquire the same view safely. */
export class SessionView implements SessionViewPort {
  readonly anchor = createAnchor();
  readonly entry: SessionEntryPort;
  readonly #entry: SessionEntry;
  readonly transcript: TranscriptViewPort;
  #leases = 0;
  #commit = 0;
  #closed = false;
  constructor(entry: SessionEntry) {
    this.entry = entry;
    this.#entry = entry;
    let previous: ReturnType<SessionEntry["getSnapshot"]> | undefined;
    let projected: TranscriptSnapshot;
    this.transcript = {
      anchor: this.anchor,
      getSnapshot: () => {
        const snapshot = entry.getSnapshot();
        if (snapshot !== previous) {
          previous = snapshot;
          const current = snapshot.history.current;
          projected = Object.freeze({
            revision: snapshot.revision,
            history: snapshot.history,
            freshness: snapshot.historyFreshness,
            working:
              snapshot.freshness === "current" &&
              snapshot.historyFreshness === "current" &&
              snapshot.state?.phase === "running" &&
              snapshot.state.activity === "working" &&
              !!current &&
              !!snapshot.state.run &&
              runKey(current.scope.run) === runKey(snapshot.state.run),
            retired: snapshot.state?.phase === "archived",
            read: snapshot.historyRead,
          });
        }
        return projected;
      },
      subscribe: entry.subscribe,
      commit: () => this.commit(),
      baseline: () => this.baseline(),
      older: (cursor) => this.older(cursor),
    };
  }
  commit(): () => void {
    check(!this.#closed, "CLOSED");
    const release = this.#entry.acquireView();
    this.#leases++;
    this.#commit++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#leases--;
      this.#commit++;
      release();
    };
  }
  submit(command: Command): Promise<OriginalHandle> {
    return this.#submit(command, false);
  }
  submitDraft(command: Command): Promise<OriginalHandle> {
    return this.#submit(command, true);
  }
  #submit(command: Command, draft: boolean): Promise<OriginalHandle> {
    check(!this.#closed && this.#leases > 0, "FENCED");
    const commit = this.#commit,
      follow = this.anchor.captureFollow();
    const admitted = () => {
      const current = this.entry.getSnapshot().state?.run;
      if (
        !this.#closed &&
        this.#leases > 0 &&
        this.#commit === commit &&
        current &&
        command.kind !== "stop" &&
        runKey(current) === runKey(command.run) &&
        ["send", "steer", "queue"].includes(command.kind)
      )
        follow();
    };
    return draft
      ? this.#entry.submitDraft(command, admitted)
      : this.#entry.submit(command, admitted);
  }
  older(cursor: string) {
    check(!this.#closed && this.#leases > 0, "FENCED");
    this.anchor.gesture();
    return this.#entry.older(cursor);
  }
  baseline() {
    check(!this.#closed && this.#leases > 0, "FENCED");
    if (this.entry.getSnapshot().history.rows.length) this.anchor.gesture();
    return this.#entry.baseline();
  }
  close(): void {
    check(this.#leases === 0, "PENDING_WORK");
    this.#closed = true;
  }
}

export function createAnchor(): AnchorPort {
  return new AnchorController();
}
