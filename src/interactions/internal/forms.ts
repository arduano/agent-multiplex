import { z } from "zod";
import type { Answer, Field, Form, FormValue, Prompt } from "../contracts.js";
import { check, frozen, json } from "./validation.js";

const string = z.string().refine((value) => !value.includes("\0"));
const text = string.max(16384);
const id = text
  .max(256)
  .min(1)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const choice = text.max(4096);
const nonemptyChoice = choice.refine((value) => !!value.trim());
const choices = z
  .array(choice)
  .max(32)
  .refine((values) => new Set(values).size === values.length);
const count = z.number().int().nonnegative();
const description = { title: text.optional(), description: text.optional() };
const length = { minLength: count.optional(), maxLength: count.optional() };
const range = { minimum: z.number().optional(), maximum: z.number().optional() };
const items = { minItems: count.optional(), maxItems: count.optional() };
const ordered = (minimum?: number, maximum?: number) =>
  minimum === undefined || maximum === undefined || minimum <= maximum;
const fieldSchema = z.discriminatedUnion("type", [
  z
    .strictObject({
      type: z.literal("string"),
      ...description,
      ...length,
      enum: choices.optional(),
    })
    .refine((field) => ordered(field.minLength, field.maxLength)),
  z
    .strictObject({ type: z.literal("number"), ...description, ...range })
    .refine((field) => ordered(field.minimum, field.maximum)),
  z
    .strictObject({ type: z.literal("integer"), ...description, ...range })
    .refine((field) => ordered(field.minimum, field.maximum)),
  z.strictObject({ type: z.literal("boolean"), ...description }),
  z
    .strictObject({ type: z.literal("array"), ...description, ...items, enum: choices.optional() })
    .refine((field) => ordered(field.minItems, field.maxItems)),
]);
// Named fields/answers must preserve even an own "__proto__" key. Zod records
// omit that key; decoding entries keeps names exact without mutating prototypes.
const entries = (value: unknown) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value)
    : null;
const formSchema = z
  .strictObject({
    fields: z
      .preprocess(entries, z.array(z.tuple([id, fieldSchema])).max(32))
      .transform((values) => Object.fromEntries(values)),
    required: choices,
  })
  .refine((form) => form.required.every((name) => Object.hasOwn(form.fields, name)));
const nativeFieldSchema = z.strictObject({
  type: z.unknown(),
  ...description,
  ...length,
  ...range,
  ...items,
  enum: choices.optional(),
  items: z.unknown().optional(),
});
const nativeFormSchema = z.strictObject({
  type: z.unknown(),
  properties: z
    .preprocess(entries, z.array(z.tuple([z.string(), nativeFieldSchema])))
    .transform((values) => Object.fromEntries(values)),
  required: choices.optional(),
  $schema: z.unknown().optional(),
  additionalProperties: z.unknown().optional(),
});
const arrayItemsSchema = z.strictObject({ type: z.unknown(), enum: choices.optional() });

export function validateForm(form: Form): Form {
  json(form);
  const result = formSchema.safeParse(form);
  check(result.success);
  for (const field of Object.values(form.fields))
    if (field.type === "array") check(field.enum !== undefined, "UNSUPPORTED");
  return frozen(form);
}
/** Closed primitive schema subset. Unknown constraints are never discarded. */
export function parseForm(schema: unknown): Form {
  json(schema);
  const result = nativeFormSchema.safeParse(schema);
  check(result.success);
  const value = result.data;
  check(
    value.type === "object" &&
      (value.additionalProperties === undefined || value.additionalProperties === false),
    "UNSUPPORTED",
  );
  const fields: Record<string, Field> = Object.create(null) as Record<string, Field>;
  for (const [name, raw] of Object.entries(value.properties)) {
    const { items, ...normalized } = raw;
    if (raw.type === "array") {
      const item = arrayItemsSchema.safeParse(items);
      check(item.success);
      check(item.data.type === "string" && normalized.enum === undefined, "UNSUPPORTED");
      check(item.data.enum !== undefined);
      normalized.enum = item.data.enum;
    } else check(items === undefined, "UNSUPPORTED");
    fields[name] = normalized as Field;
  }
  return validateForm({ fields, required: value.required ?? [] });
}

function answerField(field: Field): z.ZodType {
  switch (field.type) {
    case "string":
      return z
        .string({ error: "Enter text." })
        .refine(
          (value) =>
            ordered(field.minLength, [...value].length) &&
            ordered([...value].length, field.maxLength),
          "Text length is outside the requested limits.",
        )
        .refine((value) => !field.enum || field.enum.includes(value), "Choose an offered value.");
    case "boolean":
      return z.boolean({ error: "Choose true or false." });
    case "array": {
      const message = "Choose offered values without duplicates.";
      return z
        .array(
          z.string({ error: message }).refine((value) => !!field.enum?.includes(value), message),
          { error: message },
        )
        .refine((values) => new Set(values).size === values.length, message)
        .refine(
          (values) =>
            ordered(field.minItems, values.length) && ordered(values.length, field.maxItems),
          "The number of values is outside the requested limits.",
        );
    }
    default:
      return z
        .number({ error: "Enter a valid number." })
        .refine(
          (value) => field.type !== "integer" || Number.isInteger(value),
          "Enter a valid number.",
        )
        .refine(
          (value) => ordered(field.minimum, value) && ordered(value, field.maximum),
          "The number is outside the requested limits.",
        );
  }
}
const contentSchema = z
  .preprocess(entries, z.array(z.tuple([z.string(), z.unknown()])))
  .transform((values) => Object.fromEntries(values));
/** Same owner for inline validation and final dispatch; messages contain no values. */
export function formErrors(form: Form, content: unknown): Readonly<Record<string, string>> {
  validateForm(form);
  json(content, 16384);
  const result = contentSchema.safeParse(content);
  check(result.success);
  const values = result.data,
    errors: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of Object.keys(values))
    if (!Object.hasOwn(form.fields, name)) errors[name] = "This field is not requested.";
  for (const name of form.required)
    if (!Object.hasOwn(values, name)) errors[name] = "This field is required.";
  for (const [name, value] of Object.entries(values)) {
    if (!Object.hasOwn(form.fields, name)) continue;
    const decoded = answerField(form.fields[name]!).safeParse(value);
    if (!decoded.success) errors[name] = decoded.error.issues[0]!.message;
  }
  return Object.freeze(errors);
}

const decision = z.strictObject({ id, label: text });
const decisions = z
  .array(decision)
  .min(1)
  .max(16)
  .refine((values) => new Set(values.map((value) => value.id)).size === values.length);
const question = z.strictObject({
  id,
  header: text,
  question: text,
  secret: z.boolean(),
  other: z.boolean(),
  options: z
    .array(z.strictObject({ label: nonemptyChoice, description: choice.optional() }))
    .max(16)
    .refine((values) => new Set(values.map((value) => value.label)).size === values.length),
});
const questions = z
  .array(question)
  .min(1)
  .max(8)
  .refine((values) => new Set(values.map((value) => value.id)).size === values.length);
const title = text.min(1);
const elicitation = {
  type: z.enum(["codex.elicitation", "copilot.elicitation"]),
  title,
  message: text,
};
const origin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
});
const promptSchema = z.union([
  z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("codex.command"),
      title,
      decisions,
      detail: z.unknown().nonoptional(),
    }),
    z.strictObject({
      type: z.literal("codex.file"),
      title,
      decisions,
      detail: z.unknown().nonoptional(),
    }),
    z.strictObject({
      type: z.literal("codex.permission"),
      title,
      requested: z.unknown().nonoptional(),
    }),
    z.strictObject({ type: z.literal("codex.question"), title, questions, blocking: z.boolean() }),
    z.strictObject({
      type: z.literal("copilot.permission"),
      title,
      request: z.unknown().nonoptional(),
      managedApprovalRequired: z.boolean(),
    }),
    z.strictObject({
      type: z.literal("copilot.question"),
      title,
      question: text,
      options: choices.max(16),
      freeform: z.boolean(),
    }),
    z
      .strictObject({
        type: z.literal("copilot.plan"),
        title,
        summary: text,
        plan: string.max(32768).nullable(),
        actions: choices.min(1).max(16),
        recommendedAction: text,
      })
      .refine((value) => value.actions.includes(value.recommendedAction)),
  ]),
  z.discriminatedUnion("mode", [
    z.strictObject({ ...elicitation, mode: z.literal("form"), form: formSchema }),
    z.strictObject({ ...elicitation, mode: z.literal("url"), verificationOrigin: origin }),
    z.strictObject({ ...elicitation, mode: z.literal("unsupported"), reason: text }),
  ]),
]);
export function validatePrompt(input: Prompt): Prompt {
  const prompt = frozen(input),
    result = promptSchema.safeParse(prompt);
  check(result.success);
  if (
    (prompt.type === "codex.elicitation" || prompt.type === "copilot.elicitation") &&
    prompt.mode === "form"
  )
    validateForm(prompt.form);
  return prompt;
}
const elicitationAnswer = {
  type: z.enum(["codex.elicitation", "copilot.elicitation"]),
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.unknown().optional(),
};
const answerSchema = z.union([
  z.strictObject({ type: z.enum(["codex.command", "codex.file"]), decisionId: id }),
  z.strictObject({
    type: z.literal("codex.permission"),
    grant: z.enum(["deny", "turn", "session"]),
  }),
  z.strictObject({
    type: z.literal("codex.question"),
    answers: z
      .preprocess(
        entries,
        z.array(
          z.tuple([
            id,
            z.strictObject({
              values: z.array(nonemptyChoice).min(1).max(16),
              extraInfo: nonemptyChoice.optional(),
            }),
          ]),
        ),
      )
      .transform((values) => Object.fromEntries(values)),
  }),
  z.strictObject({
    type: z.literal("copilot.permission"),
    kind: z.enum(["approve-once", "reject", "user-not-available"]),
    feedback: text.optional(),
  }),
  z.strictObject({
    type: z.literal("copilot.question"),
    answer: text.refine((value) => !!value.trim()),
    wasFreeform: z.boolean(),
    extraInfo: nonemptyChoice.optional(),
  }),
  z.strictObject({
    type: z.literal("copilot.plan"),
    approved: z.boolean(),
    selectedAction: choice.optional(),
    feedback: text.optional(),
  }),
  z.strictObject(elicitationAnswer),
]);
/** Validation retains selected labels and per-question extra information separately. */
export function validateAnswer(prompt: Prompt, input: Answer): Answer {
  validatePrompt(prompt);
  json(input, 16384);
  const result = answerSchema.safeParse(input);
  check(result.success);
  const answer = result.data;
  check(answer.type === prompt.type);
  switch (answer.type) {
    case "codex.command":
    case "codex.file":
      check(prompt.type === "codex.command" || prompt.type === "codex.file");
      check(prompt.decisions.some((item) => item.id === answer.decisionId));
      break;
    case "codex.question":
      check(prompt.type === "codex.question");
      check(
        Object.keys(answer.answers).length === prompt.questions.length &&
          prompt.questions.every((question) => Object.hasOwn(answer.answers, question.id)),
      );
      for (const question of prompt.questions)
        check(
          question.other ||
            !question.options.length ||
            answer.answers[question.id]!.values.every((selection) =>
              question.options.some((option) => option.label === selection),
            ),
        );
      break;
    case "copilot.permission":
      check(answer.feedback === undefined || answer.kind === "reject");
      break;
    case "copilot.question":
      check(prompt.type === "copilot.question");
      check(answer.wasFreeform ? prompt.freeform : prompt.options.includes(answer.answer));
      check(answer.extraInfo === undefined || prompt.freeform);
      break;
    case "copilot.plan":
      check(prompt.type === "copilot.plan");
      check(answer.selectedAction === undefined || prompt.actions.includes(answer.selectedAction));
      check(!answer.approved || answer.selectedAction !== undefined);
      break;
    case "codex.elicitation":
    case "copilot.elicitation":
      check(prompt.type === "codex.elicitation" || prompt.type === "copilot.elicitation");
      if (answer.action !== "accept") check(!Object.hasOwn(answer, "content"));
      else {
        check(prompt.mode !== "unsupported", "UNSUPPORTED");
        if (prompt.mode === "form")
          check(Object.keys(formErrors(prompt.form, answer.content)).length === 0);
        else check(!Object.hasOwn(answer, "content"));
      }
      break;
  }
  return frozen(input);
}
export function formValue(form: Form, input: unknown): FormValue {
  check(Object.keys(formErrors(form, input)).length === 0);
  return frozen(input) as FormValue;
}
