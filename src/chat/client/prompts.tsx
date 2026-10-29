import { useId, useRef, useState, type ReactNode } from "react";
import {
  formErrors,
  validateAnswer,
  type Answer,
  type CapabilityRef,
  type Field as NativeField,
  type FormValue,
  type Interaction,
  type Prompt,
} from "../../interactions/index.js";
import type { ChatActions, NativeFormProps, NativeFormValues } from "../contracts.js";
import { Button, Dialog, Field, Input, Select, Textarea } from "./primitives.js";

export const capabilityKey = (reference: CapabilityRef): string =>
  JSON.stringify([
    reference.run.scope,
    reference.run.generation,
    reference.run.nativeSession,
    reference.attachment,
    reference.incarnation,
  ]);
type Values = NativeFormValues;
function SchemaField({
  name,
  field,
  value,
  set,
  error,
}: Readonly<{
  name: string;
  field: NativeField;
  value: Values[string] | undefined;
  set(value: Values[string] | undefined): void;
  error?: string;
}>) {
  return (
    <Field
      label={field.title ?? name}
      {...(field.description ? { hint: field.description } : {})}
      {...(error ? { error } : {})}
    >
      {(props) => {
        if (field.type === "boolean")
          return (
            <Select
              {...props}
              value={value === undefined ? "unset" : String(value)}
              onValueChange={(next) => set(next === "unset" ? undefined : next === "true")}
              options={[
                { value: "unset", label: "Choose…" },
                { value: "true", label: "True" },
                { value: "false", label: "False" },
              ]}
            />
          );
        if (field.enum && field.type === "string")
          return (
            <Select
              {...props}
              value={value === undefined ? "unset" : `item:${field.enum.indexOf(String(value))}`}
              onValueChange={(next) =>
                set(next === "unset" ? undefined : field.enum![Number(next.slice(5))])
              }
              options={[
                { value: "unset", label: "Choose…" },
                ...field.enum.map((item, index) => ({
                  value: `item:${index}`,
                  label: item || "(empty text)",
                })),
              ]}
            />
          );
        if (field.type === "array")
          return (
            <div
              id={props.id}
              role="group"
              aria-labelledby={props["aria-labelledby"]}
              aria-describedby={props["aria-describedby"]}
              aria-invalid={props["aria-invalid"]}
            >
              {field.enum?.map((item) => (
                <label className="mpx-choice" key={item}>
                  <input
                    type="checkbox"
                    checked={Array.isArray(value) && value.includes(item)}
                    onChange={(event) =>
                      set(
                        event.currentTarget.checked
                          ? [...(Array.isArray(value) ? value : []), item]
                          : (Array.isArray(value) ? value : []).filter((entry) => entry !== item),
                      )
                    }
                  />
                  {item || "(empty text)"}
                </label>
              ))}
              <Button onClick={() => set(value === undefined ? [] : undefined)}>
                {value === undefined ? "Use empty list" : "Omit field"}
              </Button>
            </div>
          );
        if (field.type === "integer" || field.type === "number")
          return (
            <Input
              {...props}
              type="number"
              step={field.type === "integer" ? 1 : "any"}
              value={value === undefined ? "" : String(value)}
              onChange={(event) =>
                set(
                  event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value),
                )
              }
            />
          );
        return (
          <>
            <Input
              {...props}
              value={typeof value === "string" ? value : ""}
              onChange={(event) => set(event.currentTarget.value)}
            />
            <Button onClick={() => set(value === undefined ? "" : undefined)}>
              {value === undefined ? "Use empty text" : "Omit field"}
            </Button>
          </>
        );
      }}
    </Field>
  );
}
export function NativeForm({ form, values, onChange, errors }: NativeFormProps) {
  return (
    <>
      {Object.entries(form.fields).map(([name, field]) => (
        <SchemaField
          key={name}
          name={name}
          field={field}
          value={values[name]}
          set={(value) => {
            const next = { ...values };
            if (value === undefined) delete next[name];
            else next[name] = value;
            onChange(next);
          }}
          {...(errors[name] ? { error: errors[name] } : {})}
        />
      ))}
    </>
  );
}
/** All nine forms produce domain answers and pass the SAME strict validator as
 * their callback owner. No generic native wire encoding lives in this module. */
export function RequestEditor({
  interaction,
  actions,
  modal = false,
}: Readonly<{
  interaction: Interaction;
  actions: Pick<ChatActions, "respond" | "verificationAddress">;
  modal?: boolean;
}>) {
  const prompt = interaction.prompt,
    group = useId(),
    [values, setValues] = useState<Values>({}),
    [extra, setExtra] = useState<Record<string, string>>({}),
    [free, setFree] = useState<Record<string, string>>({}),
    [freeActive, setFreeActive] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({}),
    [issue, setIssue] = useState(""),
    [held, setHeld] = useState(false),
    admitting = useRef(false);
  const disabled = held || interaction.state !== "pending" || !actions.respond;
  const submit = async (answer: Answer) => {
    if (disabled || admitting.current) return;
    setIssue("");
    try {
      validateAnswer(prompt, answer);
    } catch {
      setIssue("Complete the requested fields before sending.");
      return;
    }
    admitting.current = true;
    setHeld(true);
    try {
      await actions.respond!(interaction.reference, answer);
    } catch {
      setIssue(
        "Response completion is unconfirmed. Check the retained original before taking further action.",
      );
    }
  };
  const option = (
    key: string,
    choices: readonly { label: string; description?: string }[],
    other = false,
    secret = false,
  ): ReactNode => (
    <fieldset
      aria-describedby={errors[key] ? `${group}-${key}-error` : undefined}
      aria-invalid={!!errors[key]}
    >
      <legend>Choose an answer</legend>
      {choices.map((item) => (
        <label className="mpx-choice" key={item.label}>
          <input
            type="radio"
            name={`${group}-${key}`}
            value={item.label}
            checked={!freeActive[key] && values[key] === item.label}
            onChange={() => {
              setFreeActive((current) => ({ ...current, [key]: false }));
              setValues((current) => ({ ...current, [key]: item.label }));
            }}
          />
          <span>
            {item.label}
            {item.description && <small>{item.description}</small>}
          </span>
        </label>
      ))}
      {(other || !choices.length) && (
        <Field label={choices.length ? "Other answer" : "Answer"}>
          {(props) => (
            <Input
              {...props}
              type={secret ? "password" : "text"}
              autoComplete="off"
              value={free[key] ?? ""}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setFree((current) => ({ ...current, [key]: value }));
                setFreeActive((current) => ({ ...current, [key]: true }));
              }}
            />
          )}
        </Field>
      )}
      {errors[key] && (
        <p id={`${group}-${key}-error`} className="mpx-error" role="alert">
          {errors[key]}
        </p>
      )}
    </fieldset>
  );
  let content: ReactNode;
  switch (prompt.type) {
    case "codex.command":
    case "codex.file":
      content = (
        <>
          <details>
            <summary>Requested operation</summary>
            <pre>{JSON.stringify(prompt.detail, null, 2)}</pre>
          </details>
          <div className="mpx-actions">
            {prompt.decisions.map((item) => (
              <Button
                key={item.id}
                disabled={disabled}
                onClick={() => void submit({ type: prompt.type, decisionId: item.id })}
              >
                {item.label}
              </Button>
            ))}
          </div>
        </>
      );
      break;
    case "codex.permission":
      content = (
        <>
          <pre>{JSON.stringify(prompt.requested, null, 2)}</pre>
          <div className="mpx-actions">
            {(["deny", "turn", "session"] as const).map((grant) => (
              <Button
                key={grant}
                disabled={disabled}
                onClick={() => void submit({ type: prompt.type, grant })}
              >
                {grant === "deny" ? "Deny" : `Allow for ${grant}`}
              </Button>
            ))}
          </div>
        </>
      );
      break;
    case "copilot.permission":
      content = (
        <>
          <pre>{JSON.stringify(prompt.request, null, 2)}</pre>
          {prompt.managedApprovalRequired && <p>Managed approval is required.</p>}
          <Field label="Feedback if rejected (optional)">
            {(props) => (
              <Textarea
                {...props}
                value={extra.feedback ?? ""}
                onChange={(event) => setExtra({ ...extra, feedback: event.currentTarget.value })}
              />
            )}
          </Field>
          <div className="mpx-actions">
            {(["approve-once", "reject", "user-not-available"] as const).map((kind) => (
              <Button
                key={kind}
                disabled={disabled}
                onClick={() =>
                  void submit({
                    type: prompt.type,
                    kind,
                    ...(kind === "reject" && extra.feedback ? { feedback: extra.feedback } : {}),
                  })
                }
              >
                {kind === "approve-once"
                  ? "Approve once"
                  : kind === "reject"
                    ? "Reject"
                    : "User unavailable"}
              </Button>
            ))}
          </div>
        </>
      );
      break;
    case "codex.question":
      content = (
        <>
          {prompt.questions.map((question) => (
            <section key={question.id}>
              <h4>{question.header}</h4>
              <p>{question.question}</p>
              {option(question.id, question.options, question.other, question.secret)}
              <Field label="Extra information (optional)">
                {(props) => (
                  <Textarea
                    {...props}
                    value={extra[question.id] ?? ""}
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      setExtra((current) => ({
                        ...current,
                        [question.id]: value,
                      }));
                    }}
                  />
                )}
              </Field>
            </section>
          ))}
          <Button
            variant="primary"
            disabled={disabled}
            onClick={() => {
              const answers: Record<string, { values: string[]; extraInfo?: string }> = {};
              const found: Record<string, string> = {};
              for (const question of prompt.questions) {
                const value = freeActive[question.id] ? free[question.id] : values[question.id];
                if (typeof value !== "string" || !value.trim())
                  found[question.id] = "Choose or enter an answer.";
                answers[question.id] = {
                  values: typeof value === "string" && value.trim() ? [value] : [],
                  ...(extra[question.id]?.trim() ? { extraInfo: extra[question.id]! } : {}),
                };
              }
              setErrors(found);
              if (Object.keys(found).length) return;
              void submit({ type: prompt.type, answers });
            }}
          >
            Send answers
          </Button>
        </>
      );
      break;
    case "copilot.question":
      content = (
        <>
          <p>{prompt.question}</p>
          {option(
            "answer",
            prompt.options.map((label) => ({ label })),
            prompt.freeform,
          )}
          {prompt.freeform && (
            <Field label="Extra information (optional)">
              {(props) => (
                <Textarea
                  {...props}
                  value={extra.answer ?? ""}
                  onChange={(event) => setExtra({ ...extra, answer: event.currentTarget.value })}
                />
              )}
            </Field>
          )}
          <Button
            variant="primary"
            disabled={disabled}
            onClick={() => {
              const answer = String(
                freeActive.answer ? (free.answer ?? "") : (values.answer ?? ""),
              );
              setErrors(answer.trim() ? {} : { answer: "Choose or enter an answer." });
              if (answer.trim())
                void submit({
                  type: prompt.type,
                  answer,
                  wasFreeform: !!freeActive.answer,
                  ...(extra.answer?.trim() ? { extraInfo: extra.answer } : {}),
                });
            }}
          >
            Send answer
          </Button>
        </>
      );
      break;
    case "copilot.plan":
      content = (
        <>
          <p>{prompt.summary}</p>
          {prompt.plan && <pre>{prompt.plan}</pre>}
          <Field label="Action">
            {(props) => (
              <Select
                {...props}
                value={typeof values.action === "string" ? values.action : prompt.recommendedAction}
                onValueChange={(action) => setValues({ ...values, action })}
                options={prompt.actions.map((value) => ({
                  value,
                  label: value,
                }))}
              />
            )}
          </Field>
          <Field label="Feedback (optional)">
            {(props) => (
              <Textarea
                {...props}
                value={extra.feedback ?? ""}
                onChange={(event) => setExtra({ ...extra, feedback: event.currentTarget.value })}
              />
            )}
          </Field>
          <div className="mpx-actions">
            <Button
              disabled={disabled}
              variant="primary"
              onClick={() =>
                void submit({
                  type: prompt.type,
                  approved: true,
                  selectedAction: String(values.action ?? prompt.recommendedAction),
                  ...(extra.feedback ? { feedback: extra.feedback } : {}),
                })
              }
            >
              Accept plan
            </Button>
            <Button
              disabled={disabled}
              onClick={() =>
                void submit({
                  type: prompt.type,
                  approved: false,
                  ...(extra.feedback ? { feedback: extra.feedback } : {}),
                })
              }
            >
              Decline
            </Button>
          </div>
        </>
      );
      break;
    case "codex.elicitation":
    case "copilot.elicitation": {
      const accept = () => {
        if (prompt.mode === "form") {
          const found = formErrors(prompt.form, values);
          setErrors(found);
          if (Object.keys(found).length) return;
          void submit({
            type: prompt.type,
            action: "accept",
            content: values as FormValue,
          });
        } else void submit({ type: prompt.type, action: "accept" });
      };
      content = (
        <>
          <p>{prompt.message}</p>
          {prompt.mode === "form" ? (
            <NativeForm form={prompt.form} values={values} onChange={setValues} errors={errors} />
          ) : prompt.mode === "url" ? (
            <>
              <p>Verify with {prompt.verificationOrigin}</p>
              <Button
                disabled={!actions.verificationAddress}
                onClick={() => {
                  // Open synchronously during the gesture; never navigate an unrelated
                  // tab after an asynchronous result. The address remains capability-scoped.
                  const tab = window.open("about:blank", "_blank");
                  if (!tab) {
                    setIssue("Allow a verification window, then try again.");
                    return;
                  }
                  tab.opener = null;
                  void actions.verificationAddress!(interaction.reference)
                    .then((address) => {
                      const url = new URL(address);
                      if (
                        url.origin !== prompt.verificationOrigin ||
                        !["http:", "https:"].includes(url.protocol) ||
                        url.username ||
                        url.password
                      )
                        throw Error();
                      tab.location.replace(url.href);
                    })
                    .catch(() => {
                      tab.close();
                      setIssue("Verification address is unavailable.");
                    });
                }}
              >
                Open verification
              </Button>
            </>
          ) : (
            <p>{prompt.reason}</p>
          )}
          <div className="mpx-actions">
            <Button
              disabled={disabled || prompt.mode === "unsupported"}
              variant="primary"
              onClick={accept}
            >
              Accept
            </Button>
            <Button
              disabled={disabled}
              onClick={() => void submit({ type: prompt.type, action: "decline" })}
            >
              Decline
            </Button>
            <Button
              disabled={disabled}
              onClick={() => void submit({ type: prompt.type, action: "cancel" })}
            >
              Cancel
            </Button>
          </div>
        </>
      );
      break;
    }
  }
  const editor = (
    <div className="mpx-request-editor">
      <fieldset disabled={disabled}>{content}</fieldset>
      {issue && (
        <p className="mpx-error" role="alert">
          {issue}
        </p>
      )}
      {held && !issue && (
        <p role="status">Response submitted; native completion is not yet confirmed.</p>
      )}
    </div>
  );
  // This component owns unsent form edits outside the popup's mount lifetime.
  // Closing a dialog neither erases those edits nor answers the capability.
  return modal ? (
    <Dialog title={prompt.title} trigger={<Button>Review request</Button>}>
      {editor}
    </Dialog>
  ) : (
    editor
  );
}
const sensitive = (prompt: Prompt): boolean =>
  !["codex.question", "copilot.question", "copilot.plan"].includes(prompt.type);
export function RequestArea({
  items,
  actions,
  available,
}: Readonly<{
  items: readonly Interaction[];
  actions: Pick<ChatActions, "respond" | "verificationAddress">;
  available: boolean;
}>) {
  const [selected, setSelected] = useState<string | null>(null),
    active = items.filter((item) => !["confirmed", "retired"].includes(item.state)),
    chosen = active.find((item) => capabilityKey(item.reference) === selected) ?? active[0];
  if (!active.length) return null;
  return (
    <section className="mpx-requests" aria-label="Agent requests">
      <h3>Agent requests</h3>
      <div className="mpx-request-list">
        {active.map((item) => (
          <Button
            key={capabilityKey(item.reference)}
            aria-expanded={item === chosen}
            onClick={() => setSelected(capabilityKey(item.reference))}
          >
            {item.prompt.title}
            <span className="mpx-hint"> · {item.state}</span>
          </Button>
        ))}
      </div>
      {active.map((item) => (
        <section
          key={capabilityKey(item.reference)}
          hidden={item !== chosen}
          aria-label={item.prompt.title}
        >
          <p className="mpx-hint">
            {item.owner.relation === "child" ? "Child agent" : "Agent"} · {item.prompt.type}
          </p>
          <RequestEditor
            key={JSON.stringify([item.reference, item.prompt])}
            interaction={item}
            modal={sensitive(item.prompt)}
            actions={available ? actions : {}}
          />
          {!available && (
            <p className="mpx-hint">Request observations are unavailable. Responses are paused.</p>
          )}
        </section>
      ))}
    </section>
  );
}
