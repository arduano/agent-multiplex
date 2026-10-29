import { z } from "zod";
import type { StoredFile } from "../files/contracts.js";
import { canonicalJson } from "../protocol/index.js";
import type { Answer } from "../interactions/contracts.js";
import type { Json } from "../protocol/index.js";
import { codexNativeEffectSchema, codexNativeAnswerSchema } from "./native-contracts.js";

export const CODEX_VERSION = "0.162.1";
const name = z.string().min(1).max(256);
export const codexAccessSchema = z.union([
  z
    .object({
      approval: z.enum(["on-request", "never", "untrusted"]),
      sandbox: z.enum(["danger-full-access", "workspace-write", "read-only"]),
    })
    .strict(),
  z.object({ approval: z.enum(["on-request", "never", "untrusted"]), profile: name }).strict(),
]);
export const codexCollaborationSchema = z
  .object({
    mode: z.enum(["default", "plan"]),
    model: name,
    effort: name.nullable(),
    instructions: z.string().max(4096).nullable(),
  })
  .strict();
export const codexSelectionSchema = z
  .object({
    kind: z.literal("codex").default("codex"),
    model: name,
    effort: name.nullable().optional(),
    access: codexAccessSchema.default({ approval: "on-request", sandbox: "danger-full-access" }),
    collaboration: codexCollaborationSchema.optional(),
  })
  .strict();
export type CodexSelection = z.output<typeof codexSelectionSchema>;
export const codexObservedSelectionSchema = codexSelectionSchema
  .extend({ model: name.optional(), access: codexAccessSchema.optional() })
  .strict();
export type CodexObservedSelection = z.output<typeof codexObservedSelectionSchema>;
export const codexPatchSchema = codexSelectionSchema.omit({ kind: true }).partial().strict();
export type CodexPatch = z.output<typeof codexPatchSchema>;
export const codexInputSchema = z.union([
  z
    .object({
      type: z.literal("text"),
      text: z.string().max(65536),
      text_elements: z.array(z.never()).default([]),
    })
    .strict(),
  z.object({ type: z.literal("localImage"), path: z.string().min(1).max(4096) }).strict(),
  z
    .object({
      type: z.literal("image"),
      url: z
        .string()
        .min(1)
        .max(32 * 1024 * 1024),
    })
    .strict(),
  z.object({ type: z.literal("mention"), name, path: z.string().min(1).max(4096) }).strict(),
]);
export type CodexInput = z.output<typeof codexInputSchema>;
export const codexMessageSchema = z
  .object({
    text: z.string().max(65536).default(""),
    attachments: z
      .array(z.object({ id: name }).strict())
      .max(32)
      .default([]),
    selection: codexPatchSchema.optional(),
  })
  .strict();
export type CodexMessage = z.output<typeof codexMessageSchema>;
export type CodexAnswer = Extract<Answer, { type: `codex.${string}` }>;
export const codexAnswerSchema = z.custom<CodexAnswer>((value) => {
  try {
    canonicalJson(value as Json, 16384);
    return (
      !!value &&
      typeof value === "object" &&
      "type" in value &&
      [
        "codex.command",
        "codex.file",
        "codex.permission",
        "codex.question",
        "codex.elicitation",
      ].includes(String(value.type))
    );
  } catch {
    return false;
  }
});
export const codexCallbackReferenceSchema = z
  .object({
    run: z
      .object({
        scope: z.object({ connection: name, principal: name, host: name, session: name }).strict(),
        generation: z.number().int().positive(),
        nativeSession: name,
      })
      .strict(),
    attachment: name,
    incarnation: z.number().int().positive(),
  })
  .strict();
const codexLegacyCommandSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("answer"),
      reference: codexCallbackReferenceSchema,
      answer: codexAnswerSchema,
    })
    .strict(),
  z.object({ type: z.literal("settings"), patch: codexPatchSchema }).strict(),
  z
    .object({
      type: z.literal("turnSettings"),
      turnId: name,
      model: name.optional(),
      effort: name.nullable().optional(),
    })
    .strict(),
  z
    .object({ type: z.literal("steer"), expectedTurnId: name, message: codexMessageSchema })
    .strict(),
  z.object({ type: z.literal("queue"), message: codexMessageSchema }).strict(),
  z.object({ type: z.literal("interrupt"), turnId: name }).strict(),
  z.object({ type: z.literal("continue") }).strict(),
  z.object({ type: z.literal("compact") }).strict(),
  z
    .object({
      type: z.literal("goal.set"),
      objective: z.string().min(1).max(16384).optional(),
      status: z
        .enum(["active", "complete", "paused", "blocked", "usageLimited", "budgetLimited"])
        .optional(),
      tokenBudget: z.number().int().positive().nullable().optional(),
    })
    .strict(),
  z.object({ type: z.literal("goal.clear") }).strict(),
  z.object({ type: z.literal("terminal.terminate"), processId: name }).strict(),
  z.object({ type: z.literal("terminals.clean") }).strict(),
  z.object({ type: z.literal("mcp.reload") }).strict(),
  z.object({ type: z.literal("mcp.login"), serverName: name }).strict(),
]);
/** Internal lifecycle encoding. The public router exposes native procedures. */
export const codexCommandSchema = z.union([
  codexLegacyCommandSchema,
  codexNativeEffectSchema,
  codexNativeAnswerSchema,
]);
export type CodexCommand = z.output<typeof codexCommandSchema>;
export type CodexModel = Readonly<{
  model: string;
  efforts: readonly string[];
  displayName?: string;
  description?: string;
  defaultEffort?: string | null;
  inputModalities?: readonly string[];
}>;
export type CodexModels = Readonly<{ choices: readonly CodexModel[] }>;
export type CodexGoal = Readonly<{
  threadId: string;
  objective: string;
  status: string;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}>;
export type CodexTerminal = Readonly<{
  itemId: string;
  processId: string;
  command: string;
  cwd: string;
  osPid: number | null;
  cpuPercent: number | null;
  rssKb: number | null;
}>;
export type CodexTerminals = Readonly<{
  data: readonly CodexTerminal[];
  nextCursor: string | null;
}>;
export type CodexMcpStatus = Readonly<{ name: string; tools: readonly string[]; status?: string }>;
export type CodexRead =
  | Readonly<{ type: "models" | "goal" | "mcp" }>
  | Readonly<{ type: "terminals"; cursor?: string | null; limit?: number }>;
export type CodexReadResult =
  CodexModels | CodexGoal | null | CodexTerminals | readonly CodexMcpStatus[];
export type CodexReadResultFor<Request extends CodexRead> = {
  models: CodexModels;
  goal: CodexGoal | null;
  terminals: CodexTerminals;
  mcp: readonly CodexMcpStatus[];
}[Request["type"]];
export type CodexDiagnostic = Readonly<{
  stage: "wire" | "codec" | "ancestry" | "callback";
  code: string;
  threadId?: string;
  turnId?: string;
}>;
export type CodexPrivateLoginLink =
  | Readonly<{ state: "ready"; url: string; expiresAt: number }>
  | Readonly<{ state: "expired" | "unknown" | "complete"; success?: boolean }>;
export type CodexNativeItem = Readonly<Record<string, Json>>;

export type CodexAsset = Readonly<{
  id: string;
  name: string;
  mediaType: string;
}> &
  (
    | Readonly<{
        state: "pending";
      }>
    | Readonly<{
        state: "ready";
        file: StoredFile;
      }>
    | Readonly<{
        state: "unavailable";
        reason: string;
      }>
  );
