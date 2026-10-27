import type { Json } from "../../contracts/types.js";

export type CodexOptionalQuestion = Readonly<{ title: string; options: readonly string[] }>;
export type CodexOptionalQuestions = Readonly<{ questions: readonly CodexOptionalQuestion[]; omitted: number }>;

const encoder = new TextEncoder();
const empty: CodexOptionalQuestions = Object.freeze({ questions: Object.freeze([]), omitted: 0 });

/** Optional native presentation, never a reverse-request capability. Keep full
 * accepted strings; unusable questions cannot discard the assistant body. */
export function codexOptionalQuestions(value: unknown): CodexOptionalQuestions {
  if (value === undefined || value === null) return empty;
  if (!Array.isArray(value)) return Object.freeze({ ...empty, omitted: 1 });
  const questions: CodexOptionalQuestion[] = [];
  let omitted = Math.max(0, value.length - 8);
  for (const raw of value.slice(0, 8)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { omitted++; continue; }
    const { title, options } = raw as Record<string, unknown>;
    if (typeof title !== "string" || !title.trim() || title.length > 500 ||
        options != null && (!Array.isArray(options) || options.length > 8 || !options.every((option: unknown) => typeof option === "string" && option.trim().length > 0 && option.length <= 200))) {
      omitted++; continue;
    }
    const question: CodexOptionalQuestion = Object.freeze({ title, options: Object.freeze(options == null ? [] : [...options as string[]]) });
    // Reserve the largest possible omitted count while fitting presentation.
    if (encoder.encode(JSON.stringify({ questions: [...questions, question], omitted: value.length })).byteLength > 12 * 1024) { omitted++; continue; }
    questions.push(question);
  }
  return Object.freeze({ questions: Object.freeze(questions), omitted });
}
/** Both native paths fit presentation within the existing lower live metadata
 * bound. The caller includes row identity; maximum timestamps reserve the
 * native-page envelope even when this observation came from the live stream. */
export function codexOptionalQuestionMetadata(value: unknown, native: Readonly<Record<string, Json>>): Readonly<Record<string, Json>> {
  const optional = codexOptionalQuestions(value), questions = [...optional.questions];
  let omitted = optional.omitted;
  const metadata = () => ({ questions, questionsOmitted: omitted });
  const fits = () => encoder.encode(JSON.stringify({ ...native, startedAtMs: Number.MAX_SAFE_INTEGER, completedAtMs: Number.MAX_SAFE_INTEGER, ...metadata() })).byteLength <= 8_192;
  while (questions.length && !fits()) { questions.pop(); omitted++; }
  // Optional presentation cannot make already-full native metadata reject text.
  return fits() ? metadata() : {};
}
