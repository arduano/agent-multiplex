import { createElement as h, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ResourceLease } from '../../v8-files/src/client/resource-cache.js';
import { ImageVisual } from './preview-image.js';

/** One committed visual lease over the existing verified ResourceCache. The
 * caller supplies exact occurrence identity and file authority; no cache,
 * native read, path fallback or retry owner lives here. */
export function InlineMedia({ identity, load, label, disabled = false }: Readonly<{ identity: string; load(): Promise<ResourceLease>; label: string; disabled?: boolean }>) {
  const element = useRef<HTMLSpanElement>(null), loader = useRef(load);
  const [visible, setVisible] = useState(false), [open, setOpen] = useState(false);
  const [state, setState] = useState<Readonly<{ identity: string; lease?: ResourceLease; failed?: boolean }> | null>(null);
  useLayoutEffect(() => { loader.current = load; }, [load]);
  useLayoutEffect(() => { setOpen(false); }, [identity, disabled]);
  useEffect(() => {
    const node = element.current; if (!node || disabled) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => { for (const entry of entries) if (entry.target === node) setVisible(entry.isIntersecting); }, { rootMargin: '160px' });
    observer.observe(node); return () => observer.disconnect();
  }, [disabled]);
  useEffect(() => {
    setState(null); if (disabled || !visible && !open) return;
    let current = true, lease: ResourceLease | undefined;
    void Promise.resolve().then(() => current ? loader.current() : undefined).then(value => {
      if (!value) return;
      if (!current) { value.release(); return; }
      lease = value; setState({ identity, lease: value });
    }, () => { if (current) setState({ identity, failed: true }); });
    return () => { current = false; lease?.release(); };
  }, [identity, disabled, visible || open]);
  const current = !disabled && state?.identity === identity ? state : null, image = current?.lease?.preview;
  return h('span', { ref: element, className: 'mpx-chat__inline-media', 'data-media-state': disabled ? 'retired' : image?.kind === 'image' ? 'ready' : current?.failed || image ? 'unavailable' : visible ? 'loading' : 'deferred' },
    image?.kind === 'image' ? h(ImageVisual, { url: image.url, name: label, width: image.width, height: image.height, onOpenChange: setOpen }) :
      h('span', { className: 'mpx-chat__media-placeholder', role: visible ? 'status' : undefined }, disabled ? `${label} · resource access retired` : current?.failed || image ? `${label} · preview unavailable` : visible ? `Loading ${label}…` : label));
}
