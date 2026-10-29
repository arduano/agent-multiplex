import { useEffect, useRef } from "react";
import type { RowAnchor, SessionView, TranscriptViewPort } from "../../client/contracts.js";
import { useSessionView, useTranscriptView, useViewAnchor } from "./hooks.js";

/** Elements carrying data-history-row use exact row IDs. The content ref wraps
 * all row/boundary/footer geometry; no row height estimate participates. */
function useViewport(view: import("../contracts.js").AnchoredViewPort, revision: number) {
  const intent = useViewAnchor(view);
  const scrollerRef = useRef<HTMLElement | null>(null),
    contentRef = useRef<HTMLElement | null>(null);
  const schedule = useRef<(() => void) | null>(null);
  useEffect(() => {
    const element = scrollerRef.current,
      content = contentRef.current;
    if (!element || !content) return;
    let frame = 0,
      tail = 0,
      stableFrame = 0,
      closed = false,
      manual = false,
      moved = false,
      expected: number | undefined;
    let lastTop = element.scrollTop,
      stable = 0,
      frames = 0;
    const priorAnchor = element.style.overflowAnchor;
    element.style.overflowAnchor = "none";
    const rows = () => [...content.querySelectorAll<HTMLElement>("[data-history-row]")];
    const capture = (): RowAnchor | null => {
      const top = element.getBoundingClientRect().top + element.clientTop;
      const row = rows().find((row) => row.getBoundingClientRect().bottom > top);
      const id = row?.getAttribute("data-history-row");
      return row && id ? { rowId: id, offset: row.getBoundingClientRect().top - top } : null;
    };
    const nearBottom = () => element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
    const observeManual = () => view.anchor.observed(capture(), nearBottom());
    const align = () => {
      if (closed || manual) return;
      const desired = view.anchor.getSnapshot();
      if (desired.mode === "followingLive")
        element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
      else if (desired.anchor) {
        const row = rows().find(
          (row) => row.getAttribute("data-history-row") === desired.anchor!.rowId,
        );
        if (row) {
          const offset =
            row.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            element.clientTop;
          element.scrollTop += offset - desired.anchor.offset;
        }
      }
      expected = element.scrollTop;
      // A short transcript cannot preserve an offset requiring negative scroll.
      // Retain its physical clamped anchor, without changing the reading intent.
      if (desired.mode === "readingHistory") view.anchor.observed(capture(), false);
    };
    const enqueue = () => {
      if (manual && view.anchor.getSnapshot().mode === "followingLive") {
        manual = false;
        cancelAnimationFrame(stableFrame);
      }
      if (closed || manual) return;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(tail);
      frame = requestAnimationFrame(() => {
        align();
        tail = requestAnimationFrame(align);
      });
    };
    const endGesture = () => {
      if (!manual) return;
      // No physical motion is still a reading gesture. Keep the captured
      // anchor instead of inferring live-follow from the unchanged bottom.
      if (moved) observeManual();
      manual = false;
      cancelAnimationFrame(stableFrame);
      enqueue();
    };
    const settleFallback = () => {
      if (!manual || closed) return;
      const top = element.scrollTop;
      if (Math.abs(top - lastTop) >= 0.5) moved = true;
      stable = Math.abs(top - lastTop) < 0.5 ? stable + 1 : 0;
      lastTop = top;
      if (++frames >= 120 || stable >= (moved ? 4 : 2)) endGesture();
      else stableFrame = requestAnimationFrame(settleFallback);
    };
    const gesture = () => {
      expected = undefined;
      manual = true;
      view.anchor.gesture();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(tail);
      cancelAnimationFrame(stableFrame);
      moved = false;
      stable = 0;
      frames = 0;
      lastTop = element.scrollTop;
      // Supported scrollend does not fire when the gesture cannot move. This
      // paint-bounded fallback also permits a later touch move to be observed.
      stableFrame = requestAnimationFrame(settleFallback);
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target as HTMLElement).isContentEditable
      )
        return;
      if (event.key === "End") {
        event.preventDefault();
        manual = false;
        cancelAnimationFrame(stableFrame);
        view.anchor.followLatest();
        enqueue();
      } else if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", " "].includes(event.key))
        gesture();
    };
    const pointer = (event: PointerEvent) => {
      if (event.target === element) gesture();
    };
    const scroll = () => {
      if (expected !== undefined && Math.abs(element.scrollTop - expected) < 1) {
        expected = undefined;
        return;
      }
      // A touch may start moving after the no-motion fallback. Unexpected
      // physical scroll is the user's geometry, never a reason to restore an
      // obsolete anchor. Our own exact alignment events were filtered above.
      if (manual && Math.abs(element.scrollTop - lastTop) >= 0.5) moved = true;
      observeManual();
    };
    const releaseCapture = view.anchor.captureGeometry(capture);
    schedule.current = enqueue;
    element.addEventListener("wheel", gesture, { passive: true });
    element.addEventListener("touchstart", gesture, { passive: true });
    element.addEventListener("keydown", key);
    element.addEventListener("pointerdown", pointer);
    element.addEventListener("scroll", scroll, { passive: true });
    element.addEventListener("scrollend", endGesture);
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(enqueue);
    resize?.observe(element);
    resize?.observe(content);
    enqueue();
    return () => {
      closed = true;
      schedule.current = null;
      releaseCapture();
      resize?.disconnect();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(tail);
      cancelAnimationFrame(stableFrame);
      element.style.overflowAnchor = priorAnchor;
      element.removeEventListener("wheel", gesture);
      element.removeEventListener("touchstart", gesture);
      element.removeEventListener("keydown", key);
      element.removeEventListener("pointerdown", pointer);
      element.removeEventListener("scroll", scroll);
      element.removeEventListener("scrollend", endGesture);
    };
  }, [view]);
  useEffect(() => {
    schedule.current?.();
  }, [view, revision, intent.revision]);
  return { intent, scrollerRef, contentRef };
}

export function useTranscriptViewport(view: SessionView) {
  const snapshot = useSessionView(view);
  return { snapshot, ...useViewport(view, snapshot.revision) };
}
export function useReadonlyTranscriptViewport(view: TranscriptViewPort) {
  const snapshot = useTranscriptView(view);
  return { snapshot, ...useViewport(view, snapshot.revision) };
}
