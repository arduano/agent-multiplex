import { describe, expect, it } from "vitest";
import { maySettleCommandDraft, type SubmittedDraft } from "../apps/web/src/client/command-draft.js";

const submitted: SubmittedDraft = {
  bindingIdentity: "binding-a",
  prompt: "  exact draft  ",
  imageIds: ["image-a", "image-b"],
};

describe("command draft settlement", () => {
  it("consumes only the exact submitted draft after acceptance", () => {
    expect(maySettleCommandDraft({ ...submitted, imageIds: [...submitted.imageIds] }, submitted, { state: "succeeded" })).toBe(true);
  });

  it.each(["received", "started", "outcomeUnknown", "failed"] as const)("retains a draft after %s", (state) => {
    expect(maySettleCommandDraft(submitted, submitted, { state })).toBe(false);
  });

  it.each([
    { ...submitted, bindingIdentity: "binding-b" },
    { ...submitted, prompt: "new draft" },
    { ...submitted, prompt: submitted.prompt.trim() },
    { ...submitted, imageIds: ["image-a"] },
    { ...submitted, imageIds: ["image-a", "replacement-image"] },
    { ...submitted, imageIds: ["image-b", "image-a"] },
  ])("preserves edits and replacement bindings against late receipts: %j", (current) => {
    expect(maySettleCommandDraft(current, submitted, { state: "succeeded" })).toBe(false);
  });

  it("does not consume a draft for commands without an original submission snapshot", () => {
    expect(maySettleCommandDraft(submitted, undefined, { state: "succeeded" })).toBe(false);
  });
});
