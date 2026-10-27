import type { Json, NativeEvent, NativeOutcome, NativeRun, RunRef, SessionPort, SessionScope } from "../../v8-session/src/contracts/types.js";
export type { Json, RunRef, SessionPort, SessionScope };
/** Trusted adapter proves relation. Vendor request ID alone never proves ownership. */
export type CallbackOwner = Readonly<{ nativeAgent: string; relation: "root" | "child" }>;
export type Field = Readonly<{
  type: "string" | "number" | "integer" | "boolean" | "array";
  title?: string; description?: string; enum?: readonly string[];
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number;
  minItems?: number; maxItems?: number;
}>;
export type Form = Readonly<{ fields: Readonly<Record<string, Field>>; required: readonly string[] }>;
export type Question = Readonly<{ id: string; header: string; question: string; secret: boolean; other: boolean; options: readonly string[]; optionDescriptions?: Readonly<Record<string, string>> }>;
type Common = Readonly<{ id: string; run: RunRef; owner: CallbackOwner; nativeRequestId: string | null; title: string }>;
export type CodexApproval = Common & Readonly<{ harness: "codex"; type: "codex.command" | "codex.file"; decisions: readonly Readonly<{ id: string; label: string; decision: Json }>[]; detail: Json }>;
export type CodexPermission = Common & Readonly<{ harness: "codex"; type: "codex.permission"; requested: Json; detail: Json }>;
export type CodexQuestion = Common & Readonly<{ harness: "codex"; type: "codex.question"; questions: readonly Question[]; blocking: boolean }>;
export type Elicitation = Common & Readonly<{ mode: "form" | "url" | "unsupported"; message: string; form: Form | null; url: string | null; unsupportedReason?: string }> & (Readonly<{harness:"codex";type:"codex.elicitation"}>|Readonly<{harness:"copilot";type:"copilot.elicitation"}>);
export type CopilotPermission = Common & Readonly<{ harness: "copilot"; type: "copilot.permission"; request: Json; managedApprovalRequired: boolean }>;
export type CopilotQuestion = Common & Readonly<{ harness: "copilot"; type: "copilot.question"; question: string; options: readonly string[]; freeform: boolean }>;
export type CopilotPlan = Common & Readonly<{ harness: "copilot"; type: "copilot.plan"; summary: string; plan: string | null; actions: readonly string[]; recommendedAction: string }>;
export type Prompt = CodexApproval | CodexPermission | CodexQuestion | Elicitation | CopilotPermission | CopilotQuestion | CopilotPlan;
type ElicitationAnswer = Readonly<{ action: "accept" | "decline" | "cancel"; content?: Readonly<Record<string, string | number | boolean | readonly string[]>> }>;
type AnswerFields = {
  "codex.command": Readonly<{decisionId:string}>;
  "codex.file": Readonly<{decisionId:string}>;
  "codex.permission": Readonly<{grant:"deny"|"turn"|"session"}>;
  "codex.question": Readonly<{answers:Readonly<Record<string,readonly string[]>>}>;
  "codex.elicitation": ElicitationAnswer;
  "copilot.elicitation": ElicitationAnswer;
  "copilot.permission": Readonly<{kind:"approve-once"|"reject"|"user-not-available";feedback?:string}>;
  "copilot.question": Readonly<{answer:string;wasFreeform:boolean}>;
  "copilot.plan": Readonly<{approved:boolean;selectedAction?:string;feedback?:string}>;
};
export type NativeAnswer = {[K in keyof AnswerFields]: Readonly<{type:K}>&AnswerFields[K]}[keyof AnswerFields];
export type AnswerFor<P extends Prompt> = Extract<NativeAnswer,{type:P["type"]}>;
export type Pending = Readonly<{ prompt: Prompt; state: "pending" | "responding" | "responseSubmitted" | "responseUnknown" }>;
export type InteractionSnapshot = Readonly<{
  scope: SessionScope; run: RunRef; epoch: number; revision: number;
  baseline: "complete" | "partial"; items: readonly Pending[];
  issue?: "nativeGap" | "capacity" | "ownershipRetired";
}>;
export interface InteractionPort {
  snapshot(scope: SessionScope): Promise<InteractionSnapshot>;
  subscribe(scope: SessionScope, listener: (snapshot: InteractionSnapshot) => void, onError?: (error: unknown) => void): () => void;
}
/** Callback return is weaker than native acknowledgement; neither means agent work completed. */
export type Delivery = Readonly<{ kind: "submitted" }> | Readonly<{ kind: "ack"; success: boolean }>;
export type BridgeOptions = Readonly<{ run: NativeRun; emit(event: NativeEvent): void }>;
export type NativeControl = (command: Parameters<NativeRun["invoke"]>[0]) => Promise<NativeOutcome>;
