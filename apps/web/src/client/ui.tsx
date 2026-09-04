import * as DialogPrimitive from "@radix-ui/react-dialog";
import clsx from "clsx";
import {
  X,
  type LucideIcon,
} from "lucide-react";
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { twMerge } from "tailwind-merge";

export function classes(...values: Array<string | false | null | undefined>): string {
  return twMerge(clsx(values));
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly tone?: "default" | "primary" | "danger" | "ghost";
  readonly icon?: LucideIcon;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  tone = "default",
  icon: Icon,
  className,
  children,
  type = "button",
  ...props
}, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={classes(
        "inline-flex min-h-9 items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/80 disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none",
        tone === "primary" && "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-ink)] hover:border-[var(--accent-hover)] hover:bg-[var(--accent-hover)]",
        tone === "danger" && "border-[var(--status-error)]/30 bg-[var(--status-error)]/10 text-[var(--status-error)] hover:bg-[var(--status-error)]/20",
        tone === "default" && "border-[var(--border-subtle)] bg-[var(--surface-raised)] text-[var(--text-primary)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-hover)]",
        tone === "ghost" && "border-transparent bg-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-raised)] hover:text-[var(--text-primary)]",
        className,
      )}
      {...props}
    >
      {Icon ? <Icon aria-hidden="true" className="size-4 shrink-0" /> : null}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, Omit<ButtonProps, "children"> & {
  readonly label: string;
  readonly icon: LucideIcon;
}>(function IconButton({ label, icon: Icon, className, ...props }, ref) {
  return (
    <Button ref={ref} aria-label={label} title={label} className={classes("size-9 px-0", className)} {...props}>
      <Icon aria-hidden="true" className="size-4" />
    </Button>
  );
});

export function Badge({ children, tone = "neutral", className }: PropsWithChildren<{
  readonly tone?: "neutral" | "good" | "warn" | "bad" | "brand";
  readonly className?: string;
}>) {
  return (
    <span className={classes(
      "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium leading-5",
      tone === "neutral" && "border-[var(--border-subtle)] bg-[var(--surface-raised)] text-[var(--text-secondary)]",
      tone === "good" && "border-[var(--status-live)]/25 bg-[var(--status-live)]/10 text-[var(--status-live)]",
      tone === "warn" && "border-[var(--status-waiting)]/25 bg-[var(--status-waiting)]/10 text-[var(--status-waiting)]",
      tone === "bad" && "border-[var(--status-error)]/25 bg-[var(--status-error)]/10 text-[var(--status-error)]",
      tone === "brand" && "border-[var(--accent)]/25 bg-[var(--accent)]/10 text-[var(--accent-hover)]",
      className,
    )}>{children}</span>
  );
}

export function Field({ label, hint, children, className }: PropsWithChildren<{
  readonly label: string;
  readonly hint?: string;
  readonly className?: string;
}>) {
  return (
    <label className={classes("grid gap-1.5 text-sm", className)}>
      <span className="flex items-baseline justify-between gap-3 font-medium text-[var(--text-primary)]">
        {label}
        {hint ? <span className="text-xs font-normal text-[var(--text-muted)]">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

const controlClass = "w-full rounded-md border border-[var(--border-subtle)] bg-[var(--surface-base)] px-3 py-2 text-sm text-[var(--text-primary)] outline-none transition-colors duration-150 placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]/70 focus:ring-2 focus:ring-[var(--accent)]/10 disabled:opacity-50 motion-reduce:transition-none";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(props, ref) {
  return <input ref={ref} {...props} className={classes(controlClass, props.className)} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(props, ref) {
  return <select ref={ref} {...props} className={classes(controlClass, props.className)} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(props, ref) {
  return <textarea ref={ref} {...props} className={classes(controlClass, "resize-y", props.className)} />;
});

export function Panel({ children, className, ...props }: PropsWithChildren<HTMLAttributes<HTMLElement>>) {
  return (
    <section
      className={classes("rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-base)]", className)}
      {...props}
    >
      {children}
    </section>
  );
}

export function EmptyState({ icon: Icon, title, body, action }: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly body: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="grid min-h-52 place-items-center px-8 py-12 text-center">
      <div className="max-w-sm">
        <span className="mx-auto mb-4 grid size-10 place-items-center rounded-md border border-[var(--border-subtle)] bg-[var(--surface-base)] text-[var(--text-muted)]">
          <Icon aria-hidden="true" className="size-4.5" />
        </span>
        <h3 className="font-medium text-[var(--text-primary)]">{title}</h3>
        <p className="mt-1.5 text-sm leading-6 text-[var(--text-muted)]">{body}</p>
        {action ? <div className="mt-5">{action}</div> : null}
      </div>
    </div>
  );
}

export function Dialog({ title, description, children, testId }: PropsWithChildren<{
  readonly title: string;
  readonly description?: string;
  readonly testId?: string;
}>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-[2px]" />
      <DialogPrimitive.Content
        className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-shell)] shadow-2xl outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        data-testid={testId}
        {...(!description ? { "aria-describedby": undefined } : {})}
      >
        <header className="flex items-start justify-between gap-5 border-b border-[var(--border-subtle)] px-5 py-4 sm:px-6 sm:py-5">
          <div>
            <DialogPrimitive.Title className="text-lg font-semibold tracking-tight text-[var(--text-primary)]">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-1 text-sm leading-6 text-[var(--text-muted)]">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>
          <DialogPrimitive.Close asChild>
            <IconButton icon={X} label="Close dialog" tone="ghost" />
          </DialogPrimitive.Close>
        </header>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
