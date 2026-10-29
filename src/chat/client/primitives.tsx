import {
  createContext,
  forwardRef,
  useContext,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from "react";
import type { SelectProps } from "../contracts.js";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as DialogPrimitive from "@radix-ui/react-dialog";

/** Explicit embed-owned portal. Absence never falls back to document.body. */
export const PortalScope = createContext<HTMLElement | null>(null);
/** Theme/portal host for standalone shared controls or the conversation list. */
export function ThemeScope({
  theme = "light",
  className = "",
  ...props
}: HTMLAttributes<HTMLDivElement> & { theme?: "light" | "dark" }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  return (
    <PortalScope.Provider value={root}>
      <div
        {...props}
        ref={setRoot}
        data-theme={theme}
        className={`mpx-chat mpx-theme-scope ${className}`}
      />
    </PortalScope.Provider>
  );
}
export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "danger";
  }
>(function Button({ variant = "secondary", className = "", type = "button", ...props }, ref) {
  return (
    <button
      {...props}
      type={type}
      ref={ref}
      className={`mpx-button mpx-button--${variant} ${className}`}
    />
  );
});
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...props }, ref) {
    return <input {...props} ref={ref} className={`mpx-input ${className}`} />;
  },
);
export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className = "", ...props }, ref) {
  return <textarea {...props} ref={ref} className={`mpx-input ${className}`} />;
});
// Radix reserves ''. Every domain value is encoded, including real empty values.
export const selectValue = (value: string): string => `value:${value}`;
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  { value, onValueChange, options, disabled = false, className = "", ...props },
  ref,
) {
  const scope = useContext(PortalScope);
  return (
    <SelectPrimitive.Root
      value={selectValue(value)}
      onValueChange={(next) => onValueChange(next.slice(6))}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        {...props}
        ref={ref}
        type="button"
        className={`mpx-input mpx-select ${className}`}
        data-value={value}
      >
        <SelectPrimitive.Value>
          {options.find((option) => option.value === value)?.label ?? value}
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon aria-hidden>⌄</SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      {scope && (
        <SelectPrimitive.Portal container={scope}>
          <SelectPrimitive.Content
            position="popper"
            sideOffset={4}
            collisionBoundary={scope}
            collisionPadding={8}
            className="mpx-select-popup"
          >
            <SelectPrimitive.ScrollUpButton className="mpx-select-scroll">
              ⌃
            </SelectPrimitive.ScrollUpButton>
            <SelectPrimitive.Viewport>
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={selectValue(option.value)}
                  disabled={option.disabled ?? false}
                  data-value={option.value}
                  className="mpx-select-option"
                >
                  <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator aria-hidden>✓</SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.Viewport>
            <SelectPrimitive.ScrollDownButton className="mpx-select-scroll">
              ⌄
            </SelectPrimitive.ScrollDownButton>
          </SelectPrimitive.Content>
        </SelectPrimitive.Portal>
      )}
    </SelectPrimitive.Root>
  );
});
export function Field({
  label,
  hint,
  error,
  children,
}: Readonly<{
  label: string;
  hint?: string;
  error?: string;
  children: (props: {
    id: string;
    "aria-labelledby": string;
    "aria-describedby"?: string;
    "aria-invalid"?: boolean;
  }) => ReactNode;
}>) {
  const id = useId(),
    description = `${id}-description`;
  return (
    <div className="mpx-field">
      <label id={`${id}-label`} htmlFor={id}>
        {label}
      </label>
      {children({
        id,
        "aria-labelledby": `${id}-label`,
        ...(hint || error ? { "aria-describedby": description } : {}),
        ...(error ? { "aria-invalid": true } : {}),
      })}
      {(hint || error) && (
        <p
          id={description}
          className={error ? "mpx-error" : "mpx-hint"}
          {...(error ? { role: "alert" } : {})}
        >
          {error ?? hint}
        </p>
      )}
    </div>
  );
}
export function Dialog({
  title,
  description,
  trigger,
  children,
  open,
  onOpenChange,
}: Readonly<{
  title: string;
  description?: string;
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?(open: boolean): void;
}>) {
  const scope = useContext(PortalScope),
    [content, setContent] = useState<HTMLDivElement | null>(null),
    triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <DialogPrimitive.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <DialogPrimitive.Trigger ref={triggerRef} asChild>
        {trigger}
      </DialogPrimitive.Trigger>
      {scope && (
        <DialogPrimitive.Portal container={scope}>
          <DialogPrimitive.Overlay className="mpx-dialog-overlay" />
          <DialogPrimitive.Content
            ref={setContent}
            className="mpx-dialog"
            {...(description ? {} : { "aria-describedby": undefined })}
            onCloseAutoFocus={(event) => {
              if (!triggerRef.current?.isConnected && scope.isConnected) {
                event.preventDefault();
                scope
                  .querySelector<HTMLElement>('[tabindex="0"],button:not(:disabled),textarea')
                  ?.focus({ preventScroll: true });
              }
            }}
          >
            <header>
              <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description>{description}</DialogPrimitive.Description>
              )}
              <DialogPrimitive.Close asChild>
                <Button aria-label="Close dialog">×</Button>
              </DialogPrimitive.Close>
            </header>
            <div className="mpx-dialog-body">
              <PortalScope.Provider value={content ?? scope}>{children}</PortalScope.Provider>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      )}
    </DialogPrimitive.Root>
  );
}
