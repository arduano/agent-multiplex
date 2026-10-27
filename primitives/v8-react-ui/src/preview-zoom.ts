import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';

export const boundedPreviewZoom = (value: number, maximum = 3): number => Number.isFinite(value) ? Math.max(1, Math.min(maximum, value)) : 1;

/** Document geometry only. Native scrolling owns pan; zoom preserves the
 * content under a gesture and never transforms the dialog or browser. */
export function usePreviewZoom({ viewport, identity, maximum = 3, mousePan = false, contentAt }: Readonly<{ viewport: RefObject<HTMLDivElement | null>; identity: unknown; maximum?: number; mousePan?: boolean; contentAt?(x: number, y: number): HTMLElement | null }>) {
  const [zoom, setZoom] = useState(1), zoomRef = useRef(1), renderedZoom = useRef(1);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const anchor = useRef<{ contentX: number; contentY: number; x: number; y: number; element?: HTMLElement } | null>(null);
  const changeZoom = useCallback((value: number, clientX?: number, clientY?: number) => {
    const next = boundedPreviewZoom(value, maximum), element = viewport.current;
    if (next === zoomRef.current) return;
    if (element) {
      const bounds = element.getBoundingClientRect(), x = clientX === undefined ? element.clientWidth / 2 : clientX - bounds.left, y = clientY === undefined ? element.clientHeight / 2 : clientY - bounds.top;
      const screenX = bounds.left + x, screenY = bounds.top + y, content = contentAt?.(screenX, screenY), box = content?.getBoundingClientRect();
      anchor.current = content && box ? { element: content, contentX: (screenX - box.left) / renderedZoom.current, contentY: (screenY - box.top) / renderedZoom.current, x: screenX, y: screenY }
        : { contentX: (element.scrollLeft + x) / renderedZoom.current, contentY: (element.scrollTop + y) / renderedZoom.current, x, y };
    }
    zoomRef.current = next; setZoom(next);
  }, [maximum, viewport, contentAt]);
  const reset = useCallback(() => {
    anchor.current = null; zoomRef.current = 1; setZoom(1);
    if (viewport.current) { viewport.current.scrollLeft = 0; viewport.current.scrollTop = 0; }
  }, [viewport]);
  const clearPointers = useCallback(() => {
    const element = viewport.current;
    for (const id of pointers.current.keys()) if (element?.hasPointerCapture(id)) element.releasePointerCapture(id);
    pointers.current.clear(); pinch.current = null;
  }, [viewport]);
  useLayoutEffect(() => {
    const element = viewport.current, point = anchor.current; renderedZoom.current = zoom;
    if (!element || !point) return;
    if (point.element?.isConnected) {
      const box = point.element.getBoundingClientRect();
      element.scrollLeft += box.left + point.contentX * zoom - point.x;
      element.scrollTop += box.top + point.contentY * zoom - point.y;
    } else if (!point.element) { element.scrollLeft = point.contentX * zoom - point.x; element.scrollTop = point.contentY * zoom - point.y; }
    // A virtualizer can synchronously remeasure this same commit. Keep only
    // this gesture's visual anchor through that layout, then release it.
    const frame = requestAnimationFrame(() => { if (anchor.current === point) anchor.current = null; });
    return () => cancelAnimationFrame(frame);
  });
  useLayoutEffect(() => { clearPointers(); reset(); }, [identity, clearPointers, reset]);
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      changeZoom(zoomRef.current * Math.exp(-delta * 0.002), event.clientX, event.clientY);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { element.removeEventListener('wheel', wheel); clearPointers(); };
  }, [changeZoom, clearPointers, viewport]);
  const pair = () => [...pointers.current.values()].slice(0, 2);
  const distance = () => { const [a, b] = pair(); return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
  const endPointer = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId); pinch.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return { zoom, zoomRef, changeZoom, reset, gestures: {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === 'mouse' && (event.button !== 0 || !mousePan)) return;
      if ((event.target as Element).closest('button,a,input,select,textarea,summary')) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); event.currentTarget.setPointerCapture(event.pointerId);
      if (pointers.current.size === 2) pinch.current = { distance: distance(), zoom: zoomRef.current };
    },
    onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
      const previous = pointers.current.get(event.pointerId); if (!previous) return;
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.current.size === 2 && pinch.current?.distance) {
        const [a, b] = pair(); if (a && b) changeZoom(pinch.current.zoom * distance() / pinch.current.distance, (a.x + b.x) / 2, (a.y + b.y) / 2);
      } else if (pointers.current.size === 1) { event.currentTarget.scrollLeft -= event.clientX - previous.x; event.currentTarget.scrollTop -= event.clientY - previous.y; }
    }, onPointerUp: endPointer, onPointerCancel: endPointer, onLostPointerCapture: endPointer,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget || !['+', '=', '-', '0'].includes(event.key)) return;
      event.preventDefault(); if (event.key === '0') reset(); else changeZoom(zoomRef.current * (event.key === '-' ? 1 / 1.5 : 1.5));
    },
  } };
}

/** Border-box height remains stable when zoomed content gains scrollbars. */
export function usePreviewViewport(viewport: RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ width: 1, height: 1 });
  useLayoutEffect(() => {
    const element = viewport.current; if (!element) return;
    const measure = (entry?: ResizeObserverEntry) => {
      const style = getComputedStyle(element), pixels = (value: string) => Number.parseFloat(value) || 0;
      const width = Math.max(1, Math.floor(entry ? entry.contentRect.width : element.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight) - 1));
      const height = Math.max(1, Math.floor((entry?.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height) - pixels(style.borderTopWidth) - pixels(style.borderBottomWidth) - pixels(style.paddingTop) - pixels(style.paddingBottom)));
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure(); const observer = new ResizeObserver(([entry]) => { if (entry) measure(entry); }); observer.observe(element, { box: 'border-box' }); return () => observer.disconnect();
  }, [viewport]);
  return size;
}
