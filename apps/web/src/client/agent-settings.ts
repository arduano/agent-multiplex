import type {
  Harness,
  HarnessSessionSettings,
  NativeModel,
} from "@arduano/agent-multiplex-protocol";

export interface SettingDraft {
  readonly value: string;
  readonly edited: boolean;
}

/** Use the harness catalog's declared default without promoting hidden legacy entries. */
export function preferredModel(models: readonly NativeModel[]): NativeModel | undefined {
  return models.find((candidate) => nativeBoolean(candidate.native, "isDefault") === true)
    ?? models.find((candidate) => nativeBoolean(candidate.native, "hidden") !== true)
    ?? models[0];
}

export function createSettingDraft(applied: string, fallback = ""): SettingDraft {
  return { value: applied || fallback, edited: false };
}

export function editSettingDraft(value: string, applied: string): SettingDraft {
  return { value, edited: value !== applied };
}

/**
 * Follow authoritative changes until the operator edits this picker. An edited
 * value remains a draft until the replicated harness setting catches up to it.
 */
export function reconcileSettingDraft(
  draft: SettingDraft,
  applied: string,
  fallback = "",
): SettingDraft {
  if (draft.edited && draft.value !== applied) return draft;
  const value = applied || fallback;
  if (draft.value === value && !draft.edited) return draft;
  return { value, edited: false };
}

export function appliedSettingsSummary(
  harness: Harness,
  settings: HarnessSessionSettings | undefined,
  models: readonly Pick<NativeModel, "id" | "name">[],
): string {
  const model = settings?.model
    ? models.find((candidate) => candidate.id === settings.model)
    : undefined;
  const modelLabel = model?.name ?? model?.id ?? settings?.model ?? "Model unavailable";
  const modeLabel = settings?.mode ? settingLabel(settings.mode) : "Mode unavailable";
  if (harness !== "codex") return `${modelLabel} · ${modeLabel}`;
  const effortLabel = typeof settings?.effort === "string"
    ? settingLabel(settings.effort)
    : settings?.effort === null
      ? "Harness effort"
      : "Effort unavailable";
  return `${modelLabel} · ${modeLabel} · ${effortLabel}`;
}

function nativeBoolean(value: unknown, key: string): boolean | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : undefined;
}

function settingLabel(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replaceAll(/[./_-]+/g, " ")
    .replace(/^\w/, (letter) => letter.toUpperCase());
}
