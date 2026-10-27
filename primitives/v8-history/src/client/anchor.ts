import type { Anchor, ViewportIntent } from "../contracts/types.js";

export type ViewportState = Readonly<{
  intent: ViewportIntent;
  anchor: Anchor | null;
  readGeneration: number;
  loadingOlder: boolean;
  restoringAnchor: boolean;
}>;
export type RestoreToken = Readonly<{ id: number; gesture: number }>;
export type Correction = Readonly<{ kind: "adjust" | "settled" | "limited" | "stale"; scrollTop: number }>;

/** Geometry only. offsetPx = viewport top minus anchored row/segment top. */
export class AnchorController {
  #intent: ViewportIntent = "followingLive";
  #anchor: Anchor | null = null;
  #readGeneration = 0;
  #loadingOlder = false;
  #restore: RestoreToken | null = null;
  #gesture = 0;
  #nextRestore = 0;
  #passes = 0;
  readonly #maxPasses: number;
  readonly #changed: () => void;

  constructor(options: Readonly<{ maxRestorePasses?: number; changed?: () => void }> = {}) {
    this.#maxPasses = options.maxRestorePasses ?? 3;
    if (!Number.isSafeInteger(this.#maxPasses) || this.#maxPasses < 1) throw new RangeError("Restore passes must be positive");
    this.#changed = options.changed ?? (() => {});
  }
  get state(): ViewportState {
    return Object.freeze({ intent: this.#intent, anchor: this.#anchor, readGeneration: this.#readGeneration,
      loadingOlder: this.#loadingOlder, restoringAnchor: this.#restore !== null });
  }
  report(anchor: Anchor): void {
    if (!anchor.rowId || anchor.rowId.length > 4096 || (anchor.segmentId !== undefined && (!anchor.segmentId || anchor.segmentId.length > 4096)) || !Number.isFinite(anchor.offsetPx)) throw new TypeError("Invalid viewport anchor");
    if (this.#anchor && (anchor.rowId !== this.#anchor.rowId || anchor.segmentId !== this.#anchor.segmentId || anchor.offsetPx !== this.#anchor.offsetPx)) this.#restore = null;
    this.#anchor = Object.freeze({ ...anchor });
    this.#changed();
  }
  userScroll(direction: "earlier" | "later" | "unknown", atTail: boolean): void {
    this.#gesture += 1; this.#restore = null;
    this.#intent = direction !== "earlier" && atTail ? "followingLive" : "readingHistory";
    this.#changed();
  }
  followLatest(): void {
    this.#gesture += 1; this.#restore = null; this.#anchor = null; this.#intent = "followingLive";
    this.#changed();
  }
  /** One deferred follow; a newer gesture always wins, including one that did
   * not move the physical scroll position. Calling twice is harmless. */
  captureFollow(): () => void {
    const gesture = this.#gesture;
    return () => { if (this.#gesture === gesture) this.followLatest(); };
  }
  /** A DOM/reporting update does not itself change user intent. */
  tailPosition(scrollTop: number, maximum: number, editingPrompt = false): number {
    if (![scrollTop, maximum].every(Number.isFinite) || maximum < 0) throw new TypeError("Invalid scroll geometry");
    return this.#intent === "followingLive" && !editingPrompt ? maximum : scrollTop;
  }
  beginRestore(): RestoreToken | null {
    if (!this.#anchor) return null;
    const token = Object.freeze({ id: ++this.#nextRestore, gesture: this.#gesture });
    this.#restore = token; this.#passes = 0; this.#changed(); return token;
  }
  correct(token: RestoreToken, geometry: Readonly<{ rowTop: number; viewportTop: number; scrollTop: number; maximum?: number }>): Correction {
    if (!Object.values(geometry).every(Number.isFinite)) throw new TypeError("Invalid scroll geometry");
    if (token !== this.#restore || token.gesture !== this.#gesture || !this.#anchor) return { kind: "stale", scrollTop: geometry.scrollTop };
    const delta = geometry.rowTop - geometry.viewportTop + this.#anchor.offsetPx;
    if (Math.abs(delta) <= 0.5) { this.#restore = null; this.#changed(); return { kind: "settled", scrollTop: geometry.scrollTop }; }
    if (this.#passes >= this.#maxPasses) { this.#restore = null; this.#changed(); return { kind: "limited", scrollTop: geometry.scrollTop }; }
    this.#passes += 1;
    const maximum = geometry.maximum ?? Number.MAX_SAFE_INTEGER;
    const next = Math.max(0, Math.min(maximum, geometry.scrollTop + delta));
    if (next === geometry.scrollTop) { this.#restore = null; this.#changed(); return { kind: "limited", scrollTop: next }; }
    return { kind: "adjust", scrollTop: next };
  }
  beginOlderRead(): number {
    this.#readGeneration += 1; this.#loadingOlder = true; this.#changed(); return this.#readGeneration;
  }
  endOlderRead(generation: number): void {
    if (generation !== this.#readGeneration) return;
    this.#loadingOlder = false; this.#changed();
  }
  retireRead(): void {
    this.#readGeneration += 1; this.#loadingOlder = false; this.#changed();
  }
}
