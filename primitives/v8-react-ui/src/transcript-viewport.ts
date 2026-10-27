import { useLayoutEffect, useRef, type KeyboardEvent, type PointerEvent, type TouchEvent, type WheelEvent } from 'react';
import type { ViewSnapshot } from '../../v8-history/src/client/history-client.js';
import type { TranscriptView } from './transcript.js';

/** DOM geometry only. The retained viewport owns intent and the exact anchor. */
export function useTranscriptViewport(view: TranscriptView, history: ViewSnapshot) {
  const element = useRef<HTMLDivElement | null>(null), boundaryElement = useRef<HTMLDivElement | null>(null), footerElement = useRef<HTMLDivElement | null>(null);
  const current = useRef<Readonly<{ refresh(): void; beforeHistoryRead(): void; wheel(event: WheelEvent<HTMLDivElement>): void; touchStart(event: TouchEvent<HTMLDivElement>): void; touchMove(event: TouchEvent<HTMLDivElement>): void; touchEnd(): void; pointer(event: PointerEvent<HTMLDivElement>): void; key(event: KeyboardEvent<HTMLDivElement>): void; scroll(): void }> | null>(null);
  const stamp = history.rows.map(row => `${row.id}:${row.version}`).join('|');
  useLayoutEffect(() => {
    const container = element.current; if (!container) return;
    let previous = container.scrollTop, programmatic = false, pendingGesture = false, gestureFrames = 0, direction: 'earlier' | 'later' | 'unknown' = 'unknown', frame: number | null = null, touchY: number | null = null;
    const atTail = () => container.scrollHeight - container.clientHeight - container.scrollTop < 24;
    const captureAnchor = () => {
      const top = container.getBoundingClientRect().top;
      const row = [...container.querySelectorAll<HTMLElement>('[data-row]')].find(value => value.getBoundingClientRect().bottom > top);
      return row?.dataset.row ? { rowId: row.dataset.row, offsetPx: top - row.getBoundingClientRect().top } : null;
    };
    const report = () => {
      const anchor = captureAnchor(); if (anchor) view.viewport.report(anchor);
      previous = container.scrollTop;
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(settle); };
    const align = () => {
      if (pendingGesture) return;
      const snapshot = view.getSnapshot(); if (snapshot.kind === 'disposed' || !snapshot.history) return;
      const viewport = snapshot.history.viewport, maximum = Math.max(0, container.scrollHeight - container.clientHeight);
      let next = container.scrollTop;
      if (viewport.intent === 'followingLive') next = view.viewport.tailPosition(next, maximum, false);
      else if (viewport.anchor) {
        const row = [...container.querySelectorAll<HTMLElement>('[data-row]')].find(value => value.dataset.row === viewport.anchor!.rowId), token = row ? view.viewport.beginRestore() : null;
        if (row && token) next = view.viewport.correct(token, { rowTop: row.getBoundingClientRect().top, viewportTop: container.getBoundingClientRect().top, scrollTop: next, maximum }).scrollTop;
      }
      if (Math.abs(next - container.scrollTop) > 0.5) { programmatic = true; container.scrollTop = next; previous = container.scrollTop; schedule(); }
    };
    function settle() {
      frame = null;
      if (pendingGesture && --gestureFrames > 0) { schedule(); return; }
      if (pendingGesture) { report(); pendingGesture = false; if (direction !== 'earlier') view.viewport.userScroll(direction, atTail()); }
      programmatic = false; align();
    }
    const gesture = (next: 'earlier' | 'later' | 'unknown', commit = true) => {
      programmatic = false; pendingGesture = true; gestureFrames = 2;
      direction = next;
      if (commit) view.viewport.userScroll(next, atTail());
      schedule();
    };
    const scrollsInside = (target: EventTarget | null, delta: number) => {
      for (let node = target instanceof Element ? target : null; node && node !== container; node = node.parentElement) {
        if (node instanceof HTMLElement && /auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight && (delta < 0 ? node.scrollTop > 0 : node.scrollTop < node.scrollHeight - node.clientHeight)) return true;
      }
      return false;
    };
    const interactive = (target: EventTarget | null) => target instanceof Element && !!target.closest('button,input,textarea,select,a,[contenteditable=true],[role=combobox],[role=button]');
    const resize = new ResizeObserver(align);
    const controls = {
      refresh() {
        resize.disconnect(); resize.observe(container);
        for (const node of [boundaryElement.current, footerElement.current, ...container.querySelectorAll<HTMLElement>('[data-row]')]) if (node) resize.observe(node);
        align();
      },
      beforeHistoryRead() {
        const anchor = captureAnchor(); if (!anchor) return;
        programmatic = false; pendingGesture = false;
        view.viewport.userScroll('earlier', false); view.viewport.report(anchor);
        previous = container.scrollTop;
      },
      wheel(event: WheelEvent<HTMLDivElement>) { if (!event.defaultPrevented && event.deltaY && !scrollsInside(event.target, event.deltaY)) gesture(event.deltaY < 0 ? 'earlier' : 'later'); },
      touchStart(event: TouchEvent<HTMLDivElement>) { touchY = event.touches[0]?.clientY ?? null; gesture('unknown', false); },
      touchMove(event: TouchEvent<HTMLDivElement>) {
        const next = event.touches[0]?.clientY ?? null;
        if (next !== null && touchY !== null && next !== touchY && !scrollsInside(event.target, touchY - next)) gesture(next > touchY ? 'earlier' : 'later');
        touchY = next;
      },
      touchEnd() { touchY = null; },
      pointer(event: PointerEvent<HTMLDivElement>) { if (event.pointerType !== 'touch' && !interactive(event.target)) gesture('unknown'); },
      key(event: KeyboardEvent<HTMLDivElement>) {
        if (event.defaultPrevented || interactive(event.target)) return;
        if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || event.key === ' ' && event.shiftKey) gesture('earlier');
        else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) gesture('later');
      },
      scroll() {
        if (programmatic) return;
        if (pendingGesture) { gestureFrames = 2; schedule(); }
        else {
          const top = container.scrollTop, maximum = Math.max(0, container.scrollHeight - container.clientHeight);
          // Consuming a tall draft enlarges history and clamps its old bottom.
          // That layout event (or a delayed notification of our own position)
          // is geometry, not a request to stop following subsequent messages.
          const clamped = previous > maximum + 0.5 && Math.abs(top - maximum) <= 0.5;
          if (Math.abs(top - previous) > 0.5 && !clamped) view.viewport.userScroll(top < previous ? 'earlier' : 'later', atTail());
        }
        report();
      },
    };
    current.current = controls;
    return () => { resize.disconnect(); if (frame !== null) cancelAnimationFrame(frame); if (current.current === controls) current.current = null; };
  }, [view]);
  useLayoutEffect(() => { current.current?.refresh(); }, [view, stamp, history.viewport.intent]);
  return { element, boundaryElement, footerElement,
    beforeHistoryRead: () => current.current?.beforeHistoryRead(),
    onWheel: (event: WheelEvent<HTMLDivElement>) => current.current?.wheel(event),
    onTouchStart: (event: TouchEvent<HTMLDivElement>) => current.current?.touchStart(event),
    onTouchMove: (event: TouchEvent<HTMLDivElement>) => current.current?.touchMove(event),
    onTouchEnd: () => current.current?.touchEnd(), onTouchCancel: () => current.current?.touchEnd(),
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => current.current?.pointer(event),
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => current.current?.key(event), onScroll: () => current.current?.scroll(),
  };
}
