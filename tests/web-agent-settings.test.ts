import { describe, expect, it } from "vitest";

import type { NativeModel } from "@arduano/agent-multiplex-protocol";
import {
  appliedSettingsSummary,
  createSettingDraft,
  editSettingDraft,
  preferredModel,
  reconcileSettingDraft,
} from "../apps/web/src/client/agent-settings.js";

const model = (
  id: string,
  native: Record<string, boolean>,
): NativeModel => ({ harness: "codex", id, name: id.toUpperCase(), native });

describe("web agent settings policy", () => {
  it("prefers the native default over an earlier hidden legacy model", () => {
    const models = [
      model("gpt-5.2", { hidden: true, isDefault: false }),
      model("gpt-5.6-terra", { hidden: false, isDefault: false }),
      model("gpt-5.6-sol", { hidden: false, isDefault: true }),
    ];

    expect(preferredModel(models)?.id).toBe("gpt-5.6-sol");
  });

  it("falls back to the first visible model, then the first model", () => {
    expect(preferredModel([
      model("legacy", { hidden: true }),
      model("current", { hidden: false }),
    ])?.id).toBe("current");
    expect(preferredModel([
      model("first-hidden", { hidden: true }),
      model("second-hidden", { hidden: true }),
    ])?.id).toBe("first-hidden");
    expect(preferredModel([])).toBeUndefined();
  });

  it("keeps an edited picker value as a draft until authority acknowledges it", () => {
    const initial = createSettingDraft("gpt-5.6-sol");
    const edited = editSettingDraft("gpt-5.6-terra", "gpt-5.6-sol");

    expect(reconcileSettingDraft(edited, "gpt-5.6-sol", "gpt-5.2")).toBe(edited);
    expect(reconcileSettingDraft(edited, "gpt-5.6-terra", "gpt-5.2")).toEqual({
      value: "gpt-5.6-terra",
      edited: false,
    });
    expect(reconcileSettingDraft(initial, "gpt-5.6-luna", "gpt-5.2")).toEqual({
      value: "gpt-5.6-luna",
      edited: false,
    });
  });

  it("summarizes only acknowledged harness settings", () => {
    const models = [model("gpt-5.6-sol", { isDefault: true })];
    expect(appliedSettingsSummary("codex", {
      model: "gpt-5.6-sol",
      mode: "plan",
      effort: "high",
    }, models)).toBe("GPT-5.6-SOL · Plan · High");
    expect(appliedSettingsSummary("codex", undefined, models)).toBe(
      "Model unavailable · Mode unavailable · Effort unavailable",
    );
  });
});
