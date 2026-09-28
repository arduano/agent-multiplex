import { v7 as uuidv7 } from "uuid";
import { z } from "zod";

/** Public messages are fixed protocol text, never native/provider exceptions. */
const messages = {
  NOT_FOUND: "The command target was not found.",
  CONFLICT: "The command conflicts with the current state.",
  FENCED: "The command binding or generation is no longer current.",
  PAYLOAD_MISMATCH: "The command identity was already used with another payload.",
  UNSUPPORTED: "The command is not supported by this binding.",
  RESOURCE_EXHAUSTED: "The command exceeded an available resource limit.",
  UNAVAILABLE: "A command dependency is unavailable.",
  NATIVE_FAILURE: "The native command failed.",
  OUTCOME_UNKNOWN: "The command outcome is unknown; reconcile the original command identity.",
} as const;

export const commandErrorCodeSchema = z.enum(Object.keys(messages) as [keyof typeof messages, ...(keyof typeof messages)[]]);
export type CommandErrorCode = z.infer<typeof commandErrorCodeSchema>;

export const commandErrorSchema = z.object({
  code: commandErrorCodeSchema,
  stage: z.enum(["admission", "dispatch", "native", "recording", "recovery"]),
  certainty: z.enum(["definiteFailure", "outcomeUnknown"]),
  diagnosticId: z.uuid(),
  message: z.string().max(160),
}).strict().refine((value) => value.message === messages[value.code], {
  message: "command error message must be the fixed public text for its code",
}).refine((value) => value.code !== "OUTCOME_UNKNOWN" || value.certainty === "outcomeUnknown", {
  message: "unknown outcome code cannot claim definite failure",
});
export type CommandError = z.infer<typeof commandErrorSchema>;

/**
 * The caller owns certainty and stage. Exception text, stack, cause, name and
 * arbitrary properties never enter a durable receipt. Even allowlisted codes
 * are read only from own data properties on Error instances, without getters.
 */
export function safeCommandError(
  error: unknown,
  context: Pick<CommandError, "stage" | "certainty"> & { code?: CommandErrorCode; diagnosticId?: string },
): CommandError {
  let code = context.code;
  if (code === undefined && error instanceof Error) {
    try {
      const candidate = Object.getOwnPropertyDescriptor(error, "code")?.value;
      const parsed = commandErrorCodeSchema.safeParse(candidate);
      if (parsed.success) code = parsed.data;
    } catch { /* An uninspectable error has no safe public classification. */ }
  }
  code ??= context.certainty === "outcomeUnknown" ? "OUTCOME_UNKNOWN" : "NATIVE_FAILURE";
  // The owner's ambiguity fence is stronger than any supplied native code.
  if (code === "OUTCOME_UNKNOWN" && context.certainty === "definiteFailure") code = "NATIVE_FAILURE";
  return commandErrorSchema.parse({
    code,
    stage: context.stage,
    certainty: context.certainty,
    diagnosticId: context.diagnosticId ?? uuidv7(),
    message: messages[code],
  });
}
