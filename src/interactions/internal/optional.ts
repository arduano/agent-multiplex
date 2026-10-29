import { frozen, json } from "./validation.js";

export type OptionalQuestion = Readonly<{ title: string; options: readonly string[] }>;
/** Recorded structured suggestions are draft helpers, never callback capabilities. */
export function optionalQuestions(
  input: unknown,
): Readonly<{ questions: readonly OptionalQuestion[]; omitted: number }> {
  if (input == null) return frozen({ questions: [], omitted: 0 });
  if (!Array.isArray(input)) return frozen({ questions: [], omitted: 1 });
  try {
    json(input);
  } catch {
    return frozen({ questions: [], omitted: input.length });
  }
  const questions: OptionalQuestion[] = [];
  let omitted = Math.max(0, input.length - 8);
  for (const value of input.slice(0, 8)) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.title !== "string" ||
      !value.title.trim() ||
      value.title.length > 500 ||
      (value.options != null &&
        (!Array.isArray(value.options) ||
          value.options.length > 8 ||
          !value.options.every(
            (option: unknown) =>
              typeof option === "string" && !!option.trim() && option.length <= 200,
          )))
    ) {
      omitted++;
      continue;
    }
    const question: OptionalQuestion = { title: value.title, options: value.options ?? [] };
    try {
      json({ questions: [...questions, question], omitted: input.length }, 12288);
      questions.push(question);
    } catch {
      omitted++;
    }
  }
  return frozen({ questions, omitted });
}
export type ProposedPlan = Readonly<{ before: string; plan: string; after: string }>;
/** Explicit standalone markers outside code fences only. Recognition grants
 * display structure, never native plan-mode authority or permission to Send. */
export function proposedPlan(markdown: string): ProposedPlan | null {
  if (typeof markdown !== "string" || new TextEncoder().encode(markdown).byteLength > 65536)
    return null;
  const lines = markdown.split("\n");
  let fence: string | undefined,
    opening = -1,
    closing = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    const code = /^(`{3,}|~{3,})/.exec(line);
    if (code) {
      if (!fence) fence = code[1]!;
      else if (code[1]![0] === fence[0] && code[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    if (line === "<proposed_plan>") {
      if (opening !== -1 || closing !== -1) return null;
      opening = index;
    }
    if (line === "</proposed_plan>") {
      if (opening === -1 || closing !== -1) return null;
      closing = index;
    }
  }
  if (
    opening < 0 ||
    closing <= opening ||
    !lines
      .slice(opening + 1, closing)
      .join("\n")
      .trim()
  )
    return null;
  return frozen({
    before: lines.slice(0, opening).join("\n"),
    plan: lines.slice(opening + 1, closing).join("\n"),
    after: lines.slice(closing + 1).join("\n"),
  });
}
