import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, CircleHelp, ShieldCheck, X } from "lucide-react";
import { useState } from "react";

import type { InteractionRecord, JsonValue } from "@arduano/agent-multiplex-protocol";

import { errorMessage, useApi } from "./api.js";
import { Badge, Button, Input, Select, Textarea } from "./ui.js";

type JsonRecord = Record<string, JsonValue>;
const OTHER_ANSWER = "__agent_multiplex_other_answer__";

export function InteractionCards({ interactions }: {
  readonly interactions: readonly InteractionRecord[];
}) {
  if (interactions.length === 0) return null;
  return (
    <section
      className="mx-auto grid w-full max-w-[76ch] gap-2 px-3 sm:px-5"
      aria-label={`${interactions.length} pending agent ${interactions.length === 1 ? "interaction" : "interactions"}`}
      data-testid="interactions"
    >
      {interactions.map((interaction) => (
        <InteractionCard interaction={interaction} key={interaction.interactionId} />
      ))}
    </section>
  );
}

function InteractionCard({ interaction }: { readonly interaction: InteractionRecord }) {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const [answer, setAnswer] = useState("");
  const [raw, setRaw] = useState(() => JSON.stringify(defaultResponse(interaction), null, 2));
  const [status, setStatus] = useState("");
  const mutation = useMutation({
    mutationFn: (response: JsonValue) => client.interactions.resolve.mutate({
      interactionId: interaction.interactionId,
      sessionId: interaction.sessionId,
      harness: interaction.harness,
      response,
    }),
    onSuccess: () => {
      setStatus("Response sent");
      void queryClient.invalidateQueries({ queryKey: ["interactions"] });
    },
    onError: (error) => setStatus(errorMessage(error)),
  });
  const payload = record(interaction.payload);
  const copilotRequest = record(payload?.request);
  const codexParams = record(payload?.params);
  const codexQuestions = Array.isArray(codexParams?.questions) ? codexParams.questions : [];
  const copilotChoices = Array.isArray(copilotRequest?.choices)
    ? copilotRequest.choices.filter((choice): choice is string => typeof choice === "string")
    : [];
  const question = typeof copilotRequest?.question === "string"
    ? copilotRequest.question
    : codexQuestions.length === 1 && typeof record(codexQuestions[0])?.question === "string"
      ? record(codexQuestions[0])?.question as string
      : null;

  function resolve(response: JsonValue): void {
    setStatus("");
    mutation.mutate(response);
  }

  function resolveRaw(): void {
    try {
      resolve(JSON.parse(raw) as JsonValue);
    } catch (cause) {
      setStatus(`Raw response must be JSON: ${errorMessage(cause)}`);
    }
  }

  const headingId = `interaction-${interaction.interactionId}-heading`;

  return (
    <article
      className="overflow-hidden rounded-lg border border-[var(--status-waiting)]/20 bg-[var(--status-waiting)]/[0.045]"
      aria-labelledby={headingId}
      aria-busy={mutation.isPending}
      data-testid="interaction-card"
      data-interaction-id={interaction.interactionId}
    >
      <header className="flex items-start gap-3 px-3.5 py-3">
        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border border-[var(--status-waiting)]/15 bg-[var(--status-waiting)]/[0.06] text-[var(--status-waiting)]">
          {interaction.requestType === "approval" || interaction.requestType === "permission"
            ? <ShieldCheck className="size-4" aria-hidden="true" />
            : <CircleHelp className="size-4" aria-hidden="true" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={headingId} className="text-sm font-semibold text-[var(--text-primary)]">Agent needs your input</h3>
            <Badge tone="warn">{interaction.requestType}</Badge>
          </div>
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-5 text-[var(--text-secondary)]">
            {question ?? interactionSummary(interaction)}
          </p>
        </div>
      </header>

      {interaction.harness === "copilot" && interaction.requestType === "userInput" ? (
        <div className="flex flex-wrap gap-2 border-t border-[var(--status-waiting)]/10 px-3.5 py-3">
          {copilotChoices.length ? (
            <Select className="min-w-44 flex-1" value={answer} onChange={(event) => setAnswer(event.target.value)} aria-label="Answer" data-testid="interaction-answer">
              <option value="">Choose an answer…</option>
              {copilotChoices.map((choice) => <option key={choice}>{choice}</option>)}
            </Select>
          ) : (
            <Input className="min-w-44 flex-1" value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="Your answer" aria-label="Answer" data-testid="interaction-answer" />
          )}
          <Button tone="primary" icon={Check} disabled={!answer || mutation.isPending} onClick={() => resolve({ answer, wasFreeform: !copilotChoices.includes(answer) })} data-testid="answer-button">Answer</Button>
        </div>
      ) : interaction.requestType === "permission" && interaction.harness === "copilot" ? (
        <div className="flex flex-wrap gap-2 border-t border-[var(--status-waiting)]/10 px-3.5 py-3">
          <Button tone="primary" icon={Check} disabled={mutation.isPending} onClick={() => resolve({ kind: "approve-once", approvedInteractively: true })} data-testid="approval-accept">Approve once</Button>
          <Button tone="danger" icon={X} disabled={mutation.isPending} onClick={() => resolve({ kind: "denied", reason: "Declined in Agent Multiplex" })} data-testid="approval-decline">Decline</Button>
        </div>
      ) : interaction.requestType === "exitPlan" && interaction.harness === "copilot" ? (
        <div className="flex flex-wrap gap-2 border-t border-[var(--status-waiting)]/10 px-3.5 py-3">
          <Button tone="primary" icon={Check} disabled={mutation.isPending} onClick={() => resolve({ approved: true, selectedAction: recommendedAction(interaction) })} data-testid="plan-approve">Approve plan</Button>
          <Button tone="danger" icon={X} disabled={mutation.isPending} onClick={() => resolve({ approved: false, feedback: "Plan declined in Agent Multiplex" })} data-testid="plan-decline">Decline</Button>
        </div>
      ) : interaction.harness === "codex" && interaction.requestType === "userInput" && codexQuestions.length > 0 ? (
        <CodexQuestions interaction={interaction} questions={codexQuestions} busy={mutation.isPending} onResolve={resolve} />
      ) : interaction.harness === "codex" && interaction.requestType === "approval" ? (
        <div className="flex flex-wrap gap-2 border-t border-[var(--status-waiting)]/10 px-3.5 py-3">
          <Button tone="primary" icon={Check} disabled={mutation.isPending} onClick={() => resolve(codexApproval(interaction, "accept"))} data-testid="approval-accept">Approve once</Button>
          <Button disabled={mutation.isPending} onClick={() => resolve(codexApproval(interaction, "session"))} data-testid="approval-session">Approve session</Button>
          <Button tone="danger" icon={X} disabled={mutation.isPending} onClick={() => resolve(codexApproval(interaction, "decline"))} data-testid="approval-decline">Decline</Button>
        </div>
      ) : null}

      <details className="border-t border-[var(--status-waiting)]/10 px-3.5 py-2.5 text-xs text-[var(--text-muted)]">
        <summary className="flex min-h-11 cursor-pointer select-none items-center rounded-sm py-0.5 text-xs hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/60">Advanced · native request and raw response</summary>
        <pre className="mt-3 max-h-56 overflow-auto rounded-md border border-[var(--border-subtle)] bg-[var(--surface-canvas)] p-3 font-mono text-xs leading-5">{JSON.stringify(interaction.payload, null, 2)}</pre>
        <label className="mt-3 grid gap-1.5">
          <span className="text-xs font-medium text-[var(--text-secondary)]">Raw JSON response</span>
          <Textarea className="min-h-28 font-mono text-xs" value={raw} onChange={(event) => setRaw(event.target.value)} spellCheck={false} data-testid="interaction-response" />
        </label>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="min-w-0 flex-1 break-words" role="status" aria-live="polite" data-testid="interaction-status">{status}</span>
          <Button onClick={resolveRaw} disabled={mutation.isPending} data-testid="resolve-button">Resolve raw JSON</Button>
        </div>
      </details>
    </article>
  );
}

function CodexQuestions({ interaction, questions, busy, onResolve }: {
  readonly interaction: InteractionRecord;
  readonly questions: readonly unknown[];
  readonly busy: boolean;
  readonly onResolve: (value: JsonValue) => void;
}) {
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [freeformAnswers, setFreeformAnswers] = useState<Record<string, string>>({});

  function answerFor(rawQuestion: unknown, index: number): string {
    const question = record(rawQuestion);
    const id = typeof question?.id === "string" ? question.id : `question-${index}`;
    const options = Array.isArray(question?.options) ? question.options.map(record).filter(Boolean) : [];
    return options.length > 0 && selections[id] !== OTHER_ANSWER
      ? selections[id] ?? ""
      : freeformAnswers[id] ?? "";
  }

  return (
    <fieldset className="grid gap-3 border-t border-[var(--status-waiting)]/10 px-3.5 py-3">
      <legend className="sr-only">Questions from the agent</legend>
      {questions.map((rawQuestion, index) => {
        const question = record(rawQuestion);
        const id = typeof question?.id === "string" ? question.id : `question-${index}`;
        const options = Array.isArray(question?.options) ? question.options.map(record).filter(Boolean) : [];
        const questionText = typeof question?.question === "string" ? question.question : id;
        const allowsOther = question?.isOther === true;
        return (
          <div className="grid gap-1.5" key={id}>
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-[var(--text-secondary)]">{questionText}</span>
            {options.length ? (
              <Select value={selections[id] ?? ""} onChange={(event) => setSelections((current) => ({ ...current, [id]: event.target.value }))} data-question-id={id} data-testid="interaction-answer">
                <option value="">Choose an answer…</option>
                {options.map((option, optionIndex) => {
                  const label = typeof option?.label === "string" ? option.label : `Option ${optionIndex + 1}`;
                  return <option value={label} key={label}>{label}</option>;
                })}
                {allowsOther ? <option value={OTHER_ANSWER}>Other…</option> : null}
              </Select>
            ) : (
              <Input value={freeformAnswers[id] ?? ""} onChange={(event) => setFreeformAnswers((current) => ({ ...current, [id]: event.target.value }))} data-question-id={id} data-testid="interaction-answer" />
            )}
            </label>
            {options.length > 0 && selections[id] === OTHER_ANSWER ? (
              <Input
                autoFocus
                value={freeformAnswers[id] ?? ""}
                onChange={(event) => setFreeformAnswers((current) => ({ ...current, [id]: event.target.value }))}
                placeholder="Type another answer"
                aria-label={`Other answer for ${questionText}`}
                data-question-id={id}
                data-testid="interaction-other-answer"
              />
            ) : null}
          </div>
        );
      })}
      <Button
        tone="primary"
        icon={Check}
        disabled={busy || questions.some((rawQuestion, index) => {
          return !answerFor(rawQuestion, index).trim();
        })}
        onClick={() => onResolve({
          answers: Object.fromEntries(questions.map((rawQuestion, index) => {
            const question = record(rawQuestion);
            const id = typeof question?.id === "string" ? question.id : `question-${index}`;
            return [id, { answers: [answerFor(rawQuestion, index).trim()] }];
          })),
        })}
        data-testid="answer-button"
      >
        Answer questions
      </Button>
      <span className="sr-only">{interaction.interactionId}</span>
    </fieldset>
  );
}

function defaultResponse(interaction: InteractionRecord): JsonRecord {
  if (interaction.harness === "copilot") {
    if (interaction.requestType === "userInput") return { answer: "", wasFreeform: true };
    if (interaction.requestType === "permission") return { kind: "approve-once", approvedInteractively: true };
    if (interaction.requestType === "exitPlan") return { approved: true, selectedAction: recommendedAction(interaction) };
    if (interaction.requestType === "elicitation") return { action: "accept", content: {} };
  }
  if (interaction.requestType === "userInput") return { answers: {} };
  return codexApproval(interaction, "accept") as JsonRecord;
}

function interactionSummary(interaction: InteractionRecord): string {
  const payload = record(interaction.payload);
  const permission = record(payload?.permissionRequest);
  const request = record(payload?.request);
  if (typeof permission?.intention === "string") return permission.intention;
  if (typeof permission?.fullCommandText === "string") return permission.fullCommandText;
  if (typeof request?.summary === "string") return request.summary;
  const params = record(payload?.params);
  if (typeof params?.reason === "string") return params.reason;
  if (typeof payload?.method === "string") return payload.method;
  return "Review the native request before responding.";
}

function recommendedAction(interaction: InteractionRecord): string {
  const request = record(record(interaction.payload)?.request);
  return typeof request?.recommendedAction === "string" ? request.recommendedAction : "exit_only";
}

function codexApproval(interaction: InteractionRecord, decision: "accept" | "session" | "decline"): JsonValue {
  const method = record(interaction.payload)?.method;
  const normalized = decision === "accept" ? "approved" : decision === "session" ? "approved_for_session" : { denied: { rejection: "Declined in Agent Multiplex" } };
  if (method === "execCommandApproval" || method === "applyPatchApproval") return { decision: normalized };
  return { decision: decision === "accept" ? "accept" : decision === "session" ? "acceptForSession" : "decline" };
}

function record(value: unknown): Record<string, JsonValue> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null;
}
