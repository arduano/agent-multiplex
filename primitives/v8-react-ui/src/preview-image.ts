import { createElement as h, useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { Button, Dialog, DialogTrigger, DialogContent, DialogTitle, DialogClose } from './ui/index.js';

type Point = Readonly<{ x: number; y: number }>;
type Position = Point & Readonly<{ scale: number }>;
const fit: Position = { scale: 1, x: 0, y: 0 };
const bound = (value: number) => Math.max(1, Math.min(8, value));

/** One visual transform, with the fit image as its base. Bytes, file authority
 * and transcript scroll remain with their existing owners. */
export function ImagePreview({ url, name, width = 0, height = 0 }: Readonly<{ url: string; name: string; width?: number; height?: number }>) {
  const viewport = useRef<HTMLDivElement>(null), points = useRef(new Map<number, Point>()), wheel = useRef<(event: WheelEvent) => void>(() => {});
  const [natural, setNatural] = useState({ width, height }), [size, setSize] = useState({ width: 0, height: 0 }), [position, setPosition] = useState<Position>(fit);
  useLayoutEffect(() => { setPosition(fit); setNatural({ width, height }); points.current.clear(); }, [url, width, height]);
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const resize = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    const onWheel = (event: WheelEvent) => wheel.current(event);
    element.addEventListener('wheel', onWheel, { passive: false });
    resize(); const observer = new ResizeObserver(resize); observer.observe(element);
    return () => { observer.disconnect(); element.removeEventListener('wheel', onWheel); };
  }, []);
  const ratio = natural.width && natural.height ? Math.min(size.width / natural.width, size.height / natural.height) : 0;
  const base = { width: natural.width * ratio, height: natural.height * ratio };
  const clamp = (value: Position): Position => {
    const scale = bound(value.scale), x = Math.max(0, (base.width * scale - size.width) / 2), y = Math.max(0, (base.height * scale - size.height) / 2);
    return { scale, x: Math.max(-x, Math.min(x, value.x)), y: Math.max(-y, Math.min(y, value.y)) };
  };
  // Keep the same image point under the gesture, including a moving pinch centre.
  const zoom = (factor: number, from: Point = { x: 0, y: 0 }, to = from) => setPosition(previous => {
    const next = bound(previous.scale * factor), actual = next / previous.scale;
    return clamp({ scale: next, x: to.x - (from.x - previous.x) * actual, y: to.y - (from.y - previous.y) * actual });
  });
  const point = (event: { clientX: number; clientY: number }): Point => {
    const rect = viewport.current!.getBoundingClientRect(); return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  };
  useLayoutEffect(() => { wheel.current = event => { event.preventDefault(); zoom(event.deltaY < 0 ? 1.25 : 0.8, point(event)); }; });
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const old = points.current.get(event.pointerId); if (!old) return;
    const before = [...points.current.values()], next = point(event); points.current.set(event.pointerId, next);
    const after = [...points.current.values()];
    if (before.length === 2 && after.length === 2) {
      const [a, b] = before as [Point, Point], [c, d] = after as [Point, Point], distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance > 0) zoom(Math.hypot(c.x - d.x, c.y - d.y) / distance, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 });
    } else setPosition(previous => clamp({ ...previous, x: previous.x + next.x - old.x, y: previous.y + next.y - old.y }));
  };
  const release = (event: PointerEvent<HTMLDivElement>) => { points.current.delete(event.pointerId); };
  return h('div', { className: 'mpx-chat__image-preview' },
    h('div', { className: 'mpx-chat__visual-controls' }, h(Button, { variant: 'ghost', type: 'button', onClick: () => zoom(0.8), disabled: position.scale === 1, 'aria-label': 'Zoom image out' }, '−'), h('span', { role: 'status' }, `${Math.round(position.scale * 100)}%`), h(Button, { variant: 'ghost', type: 'button', onClick: () => zoom(1.25), disabled: position.scale === 8, 'aria-label': 'Zoom image in' }, '+'), h(Button, { variant: 'outline', type: 'button', onClick: () => setPosition(fit) }, 'Fit image')),
    h('div', { ref: viewport, className: 'mpx-chat__image-viewport', tabIndex: 0, role: 'region', 'aria-label': 'Image preview. Use plus, minus or zero to zoom; arrow keys to pan.',
      onKeyDown: (event: { key: string; preventDefault(): void }) => {
        if (['+', '=', '-', '0', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          if (event.key === '0') setPosition(fit);
          else if (event.key.startsWith('Arrow')) setPosition(previous => clamp({ ...previous, x: previous.x + (event.key === 'ArrowLeft' ? 32 : event.key === 'ArrowRight' ? -32 : 0), y: previous.y + (event.key === 'ArrowUp' ? 32 : event.key === 'ArrowDown' ? -32 : 0) }));
          else zoom(event.key === '-' ? 0.8 : 1.25);
        }
      },
      onDoubleClick: (event: { clientX: number; clientY: number }) => position.scale > 1 ? setPosition(fit) : zoom(2, point(event)),
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => { if (points.current.size >= 2) return; points.current.set(event.pointerId, point(event)); event.currentTarget.setPointerCapture(event.pointerId); }, onPointerMove: move,
      onPointerUp: release, onPointerCancel: release, onLostPointerCapture: release },
      h('img', { src: url, alt: name, draggable: false, onLoad: (event: { currentTarget: HTMLImageElement }) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }), style: { width: base.width || undefined, height: base.height || undefined, transform: `translate(${clamp(position).x}px, ${clamp(position).y}px) scale(${position.scale})` } })));
}

/** Opening a completed image or diagram acquires no second resource and never
 * rerenders a diagram. The nearest scoped surface owns the portal. */
export function ImageVisual({ url, name, width, height, onOpenChange }: Readonly<{ url: string; name: string; width: number; height: number; onOpenChange?(open: boolean): void }>) {
  const trigger = useRef<HTMLButtonElement>(null), [open, setOpen] = useState(false);
  const change = (value: boolean) => { setOpen(value); onOpenChange?.(value); };
  return h(Dialog, { open, onOpenChange: change },
    h(DialogTrigger, { asChild: true }, h('button', { type: 'button', ref: trigger, className: 'mpx-chat__visual-trigger', 'aria-label': `Expand ${name}` }, h('img', { src: url, alt: name, width, height, draggable: false }))),
    open ? h(DialogContent, { container: trigger.current?.closest<HTMLElement>('dialog, [role="dialog"], .multiplex-chat, .mpx-ui') ?? null, className: 'mpx-chat__visual-dialog', 'aria-describedby': undefined },
      h(DialogTitle, null, name), h(ImagePreview, { url, name, width, height }),
      h('footer', { className: 'mpx-chat__visual-controls' }, h(DialogClose, { asChild: true }, h(Button, { type: 'button', variant: 'outline' }, 'Close image')))) : null);
}
