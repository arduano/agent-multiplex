import type { Json, Original, RunRef } from "../protocol/index.js";

/** Relation/ancestry is proved by the concrete adapter, never by request IDs. */
export type CallbackOwner = Readonly<{ nativeAgent: string; relation: "root" | "child" }>;
export type CapabilityRef = Readonly<{ run: RunRef; attachment: string; incarnation: number }>;
export type Field = Readonly<{
  type: "string" | "number" | "integer" | "boolean" | "array";
  title?: string;
  description?: string;
  enum?: readonly string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
}>;
export type Form = Readonly<{
  fields: Readonly<Record<string, Field>>;
  required: readonly string[];
}>;
export type Question = Readonly<{
  id: string;
  header: string;
  question: string;
  secret: boolean;
  other: boolean;
  options: readonly Readonly<{ label: string; description?: string }>[];
}>;
type Common = Readonly<{ title: string }>;
type Approval = Common &
  Readonly<{ decisions: readonly Readonly<{ id: string; label: string }>[]; detail: Json }>;
type Elicitation = Common &
  Readonly<{ message: string }> &
  (
    | Readonly<{ mode: "form"; form: Form }>
    | Readonly<{ mode: "url"; verificationOrigin: string }>
    | Readonly<{ mode: "unsupported"; reason: string }>
  );
/** Exactly nine native callback classes. Native wire encoding stays in adapters. */
export type Prompt =
  | (Approval & Readonly<{ type: "codex.command" }>)
  | (Approval & Readonly<{ type: "codex.file" }>)
  | (Common & Readonly<{ type: "codex.permission"; requested: Json }>)
  | (Common &
      Readonly<{ type: "codex.question"; questions: readonly Question[]; blocking: boolean }>)
  | (Elicitation & Readonly<{ type: "codex.elicitation" }>)
  | (Common &
      Readonly<{ type: "copilot.permission"; request: Json; managedApprovalRequired: boolean }>)
  | (Common &
      Readonly<{
        type: "copilot.question";
        question: string;
        options: readonly string[];
        freeform: boolean;
      }>)
  | (Common &
      Readonly<{
        type: "copilot.plan";
        summary: string;
        plan: string | null;
        actions: readonly string[];
        recommendedAction: string;
      }>)
  | (Elicitation & Readonly<{ type: "copilot.elicitation" }>);
export type FormValue = Readonly<Record<string, string | number | boolean | readonly string[]>>;
type ElicitationAnswer =
  Readonly<{ action: "accept"; content?: FormValue }> | Readonly<{ action: "decline" | "cancel" }>;
type AnswerFields = {
  "codex.command": Readonly<{ decisionId: string }>;
  "codex.file": Readonly<{ decisionId: string }>;
  "codex.permission": Readonly<{ grant: "deny" | "turn" | "session" }>;
  "codex.question": Readonly<{
    answers: Readonly<Record<string, Readonly<{ values: readonly string[]; extraInfo?: string }>>>;
  }>;
  "codex.elicitation": ElicitationAnswer;
  "copilot.elicitation": ElicitationAnswer;
  "copilot.permission": Readonly<{
    kind: "approve-once" | "reject" | "user-not-available";
    feedback?: string;
  }>;
  "copilot.question": Readonly<{ answer: string; wasFreeform: boolean; extraInfo?: string }>;
  "copilot.plan": Readonly<{ approved: boolean; selectedAction?: string; feedback?: string }>;
};
export type Answer = {
  [K in keyof AnswerFields]: Readonly<{ type: K }> & AnswerFields[K];
}[keyof AnswerFields];
export type AnswerFor<P extends Prompt> = Extract<Answer, { type: P["type"] }>;
export type Delivery =
  Readonly<{ kind: "submitted" }> | Readonly<{ kind: "confirmed"; accepted: boolean }>;
export type ResponseState =
  "pending" | "submitting" | "submitted" | "unknown" | "confirmed" | "retired";
export type Interaction = Readonly<{
  reference: CapabilityRef;
  owner: CallbackOwner;
  nativeRequestId: string | null;
  prompt: Prompt;
  state: ResponseState;
  original: Original | null;
  accepted: boolean | null;
  issue: "idReuse" | "disconnected" | "deliveryUnknown" | null;
}>;
export type InteractionSnapshot = Readonly<{
  run: RunRef;
  attachment: string;
  revision: number;
  baseline: "complete" | "partial";
  issue: "nativeGap" | "capacity" | "idReuse" | "stopped" | null;
  items: readonly Interaction[];
}>;
/** Private adapter input. Opaque callbacks/objects never appear in public DTOs. */
export type Capture<P extends Prompt = Prompt> = Readonly<{
  run: RunRef;
  attachment: string;
  owner: CallbackOwner;
  nativeRequestId: string | null;
  capability: object;
  prompt: P;
  reply: (answer: AnswerFor<P>) => Promise<Delivery>;
}>;
export type StopConfirmation = Readonly<{ run: RunRef; attachment: string; confirmed: true }>;
/** Harnesses depend on this structural sink, not the concrete owner. */
export interface CallbackSink {
  capture<P extends Prompt>(input: Capture<P>): CapabilityRef;
  confirm(run: RunRef, attachment: string, capability: object, accepted: boolean): void;
  disconnected(): void;
  nativeGap(): void;
  confirmedStopped(proof: StopConfirmation): void;
}

/** Response dispatch consumes the existing lifecycle admitted original. */
export interface CallbackDispatcher {
  dispatch(reference: CapabilityRef, admitted: Original, answer: Answer): Promise<Interaction>;
}

/** Private startup descriptors, not browser DTOs; exports do not execute them. */
export type PrivateMcpServer = Readonly<{
  name: string;
  enabled: boolean;
  tools: "enabled" | "disabled" | readonly string[];
  transport:
    | Readonly<{
        type: "stdio";
        command: string;
        args: readonly string[];
        env: Readonly<Record<string, string>>;
        cwd?: string;
      }>
    | Readonly<{ type: "http"; url: string; headers: Readonly<Record<string, string>> }>;
}>;
export type McpServer = Readonly<{
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  tools: "enabled" | "disabled" | readonly string[];
  serverConfirmations: "surface";
}>;
export type McpOperation = Readonly<{
  original: Original;
  kind: "reload" | "login";
  state: "running" | "submitted" | "unknown" | "confirmed" | "retired";
  accepted: boolean | null;
}>;
export type McpContext = Readonly<{ run: RunRef; attachment: string; original: Original }>;
/** Each adapter supplies its own input types; these are not universal commands. */
export interface McpManagementPort<Reload extends Json, Login extends Json> {
  readonly adapter: string;
  reload?(input: Reload, context: McpContext): Promise<Delivery>;
  login?(input: Login, context: McpContext): Promise<Delivery>;
}

export type InteractionOptions = Readonly<{
  baseline?: "complete" | "partial";
  maxPending?: number;
  maxRecent?: number;
  maxListeners?: number;
}>;

export type McpHandle = Readonly<{
  getSnapshot(): McpOperation;
  /** Wait observes this one submission; expiry/abort never repeats or cancels it. */
  observe(
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<McpOperation | Readonly<{ state: "waitingExpired" }>>;
}>;

export type McpOptions = Readonly<{
  maxPending?: number;
  maxRecent?: number;
  maxListeners?: number;
}>;
