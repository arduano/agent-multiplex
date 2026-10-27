import type { Catalog } from "../../v8-session/src/contracts/types.js";
import { requireThat } from "../../v8-runtime/src/validation.js";
import { validateCatalog } from "../../v8-session/src/native/validation.js";

/** rust-v0.162.1 app-server-protocol/src/protocol/v2/model.rs. These are
 * native model identifiers/reasoning values, never a provider's fallback list. */
export type CodexModelListParams = Readonly<{ cursor: string | null; limit: number; includeHidden: false }>;
export const unavailableCodexModels = (): Catalog => ({ available: false, choices: [] });
const record = (value: unknown): Record<string, unknown> => {
  requireThat(value && typeof value === "object" && !Array.isArray(value), "Native model metadata is unavailable");
  return value as Record<string, unknown>;
};
function text(value: unknown, maximum = 256): asserts value is string {
  requireThat(typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value), "Native model metadata is unavailable");
}

/** One complete bounded native list. A partial page, ambiguous identity or
 * repeated opaque cursor cannot become a successful list of writable choices. */
export async function readCodexModels(request: (params: CodexModelListParams) => Promise<unknown>, assertCurrent: () => void = () => {}): Promise<Catalog> {
  const choices: unknown[] = [], models = new Set<string>(), cursors = new Set<string>();
  let cursor: string | null = null, rows = 0;
  for (let page = 0; page < 8; page++) {
    assertCurrent(); const result = record(await request({ cursor, limit: 64, includeHidden: false })); assertCurrent();
    requireThat(Array.isArray(result.data) && result.data.length <= 64, "Native model page exceeds its bound");
    rows += result.data.length; requireThat(rows <= 512);
    for (const input of result.data) {
      const model = record(input); text(model.model);
      requireThat(typeof model.hidden === "boolean" && Array.isArray(model.supportedReasoningEfforts) && model.supportedReasoningEfforts.length <= 16);
      const efforts = model.supportedReasoningEfforts.map(input => { const option = record(input); text(option.reasoningEffort); return option.reasoningEffort; });
      requireThat(new Set(efforts).size === efforts.length, "Native reasoning choices are ambiguous");
      if (model.hidden) continue;
      requireThat(!models.has(model.model), "Native model choices are ambiguous"); models.add(model.model);
      // Project only declared catalog metadata. Never spread native rows: they
      // may contain unrelated configuration or future private fields.
      choices.push({ model: model.model, efforts,
        ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
        ...(model.description === undefined ? {} : { description: model.description }),
        ...(model.defaultReasoningEffort === undefined ? {} : { defaultEffort: model.defaultReasoningEffort }),
        ...(model.inputModalities === undefined ? {} : { inputModalities: model.inputModalities }),
      });
      requireThat(choices.length <= 128, "Native model choices exceed the catalog bound");
    }
    if (result.nextCursor === null) return validateCatalog({ available: true, choices });
    text(result.nextCursor, 4096); requireThat(!cursors.has(result.nextCursor), "Native model cursor repeated");
    cursors.add(result.nextCursor); cursor = result.nextCursor;
  }
  throw Error("Native model page bound exceeded");
}
