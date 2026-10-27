/* Adapted from shadcn/ui (MIT). Exact source and license: ../../build/shadcn. */
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from './utils.js';

export interface DataAttributes { [key: `data-${string}`]: string | number | boolean | undefined }

export const buttonVariants = cva('mpx-ui-button inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium', {
  variants: {
    variant: { default: 'mpx-ui-button--primary', secondary: 'mpx-ui-button--secondary', outline: 'mpx-ui-button--outline', ghost: 'mpx-ui-button--ghost', destructive: 'mpx-ui-button--destructive', link: 'mpx-ui-button--link' },
    size: { default: 'mpx-ui-button--default', sm: 'mpx-ui-button--small', icon: 'mpx-ui-button--icon' },
  }, defaultVariants: { variant: 'default', size: 'default' },
});
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants>, DataAttributes { asChild?: boolean }
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button({ className, variant, size, asChild = false, type = 'button', ...props }, ref) {
  const Component = asChild ? Slot : 'button';
  return <Component ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
export const IconButton = React.forwardRef<HTMLButtonElement, ButtonProps & {label: string}>(function IconButton({label, variant = 'ghost', ...props}, ref) {
  return <Button ref={ref} size="icon" variant={variant} aria-label={label} title={label} {...props} />;
});
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & DataAttributes>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn('mpx-ui-control mpx-ui-input', className)} {...props} />;
});
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement> & DataAttributes>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cn('mpx-ui-control mpx-ui-textarea', className)} {...props} />;
});
export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement> & DataAttributes>(function Label({className, ...props}, ref) {
  return <label ref={ref} className={cn('mpx-ui-label', className)} {...props} />;
});
export function Field({label, hint, error, children, className}: {label: React.ReactNode; hint?: React.ReactNode; error?: React.ReactNode; children: React.ReactNode; className?: string}) {
  return <label className={cn('mpx-ui-field', className)}><span className="mpx-ui-label">{label}</span>{children}{hint ? <span className="mpx-ui-hint">{hint}</span> : null}{error ? <span className="mpx-ui-field-error" role="alert">{error}</span> : null}</label>;
}
export function Separator({orientation = 'horizontal', className, ...props}: React.HTMLAttributes<HTMLDivElement> & {orientation?: 'horizontal'|'vertical'}) {
  return <div role="separator" aria-orientation={orientation} className={cn('mpx-ui-separator', className)} {...props} />;
}
