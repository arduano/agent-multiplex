/* Adapted from shadcn/ui (MIT). Exact source and license: ../../build/shadcn. */
import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import type { DataAttributes } from './controls.js';
import { cn } from './utils.js';

export type SelectOption = Readonly<{ value: string; label: string; disabled?: boolean }>;
export interface SelectProps extends React.AriaAttributes, DataAttributes {
  value: string;
  onValueChange(value: string): void;
  options: readonly SelectOption[];
  disabled?: boolean;
  title?: string;
  id?: string;
  className?: string;
}

// Radix reserves ''. Prefix every domain value, rather than inventing an empty
// sentinel that could collide with a caller's real value.
const encoded = (value: string) => `value:${value}`;
const Chevron = ({ up = false }: { up?: boolean }) => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden><path d={up ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} /></svg>;

/** Controlled presentation only. Portal ownership stays with the nearest actual
 * dialog or themed scope, outside an implicit label's native click forwarding.
 * There is no document.body fallback. */
export const Select = React.forwardRef<HTMLButtonElement, SelectProps>(function Select({ value, onValueChange, options, disabled, className, ...props }, ref) {
  const [mount, setMount] = React.useState<HTMLSpanElement | null>(null);
  const container = mount?.closest<HTMLElement>('dialog,[role=dialog],.multiplex-chat,.mpx-ui');
  return <span className="mpx-ui-select-root" ref={setMount}>
    <SelectPrimitive.Root value={encoded(value)} onValueChange={next => onValueChange(next.slice('value:'.length))} {...(disabled === undefined ? {} : { disabled })}>
      <SelectPrimitive.Trigger ref={ref} type="button" className={cn('mpx-ui-control mpx-ui-select-trigger', className)} {...props} data-value={value}>
        <SelectPrimitive.Value>{options.find(option => option.value === value)?.label ?? value}</SelectPrimitive.Value>
        <SelectPrimitive.Icon><Chevron /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      {container ? <SelectPrimitive.Portal container={container}>
        <SelectPrimitive.Content className="mpx-ui-select-content" position="popper" sideOffset={4} collisionPadding={8} collisionBoundary={container}>
          <SelectPrimitive.ScrollUpButton className="mpx-ui-select-scroll"><Chevron up /></SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="mpx-ui-select-viewport">
            {options.map(option => <SelectPrimitive.Item key={option.value} value={encoded(option.value)} data-value={option.value} className="mpx-ui-select-option" {...(option.disabled === undefined ? {} : { disabled: option.disabled })}>
              <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              <SelectPrimitive.ItemIndicator aria-hidden>✓</SelectPrimitive.ItemIndicator>
            </SelectPrimitive.Item>)}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="mpx-ui-select-scroll"><Chevron /></SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal> : null}
    </SelectPrimitive.Root>
  </span>;
});
