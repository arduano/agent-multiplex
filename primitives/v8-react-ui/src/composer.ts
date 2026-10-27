import { createElement as h, useLayoutEffect, useRef, useState, type RefObject, type TextareaHTMLAttributes } from 'react';
import { Textarea, type DataAttributes } from './ui/index.js';

/** Geometry belongs to the embedding chat, not the page or a native owner. */
export function useChatLayout(ref: RefObject<HTMLElement | null>) {
  const [layout, setLayout] = useState<Readonly<{ container: HTMLElement | null; width: number; height: number }>>({ container: null, width: 0, height: 0 });
  useLayoutEffect(() => {
    const container = ref.current?.closest<HTMLElement>('.multiplex-chat');
    if (!container) return;
    const measure = () => {
      const { width, height } = container.getBoundingClientRect();
      setLayout(current => current.container === container && current.width === width && current.height === height ? current : { container, width, height });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(container);
    return () => observer.disconnect();
  }, [ref]);
  return layout;
}

/** One retained textarea. Value restoration, paste and embedding resize all
 * use the same measurement; scrolling remains with the existing viewport. */
export function ComposerTextarea({ chatHeight, chatWidth, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & DataAttributes & Readonly<{ chatHeight: number; chatWidth: number }>) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    const maximum = Math.max(44, Math.min(240, chatHeight * .3));
    input.style.height = '0px';
    const height = Math.max(44, Math.min(maximum, input.scrollHeight));
    input.style.height = `${height}px`;
    input.style.overflowY = input.scrollHeight > height ? 'auto' : 'hidden';
  }, [props.value, chatHeight, chatWidth]);
  return h(Textarea, { ...props, ref, rows: 1 });
}
