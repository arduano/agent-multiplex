import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formErrors,
  parseForm,
  validateAnswer,
  validatePrompt,
  validateForm,
  formValue,
  InteractionError,
  type Answer,
  type AnswerFor,
  type Prompt,
} from "../../src/interactions/index.js";
import { question } from "./fixture.js";

test("all nine callback kinds retain their offered native choices and exact answer types", () => {
  const fixtures: readonly [Prompt, Answer][] = [
    [
      {
        type: "codex.command",
        title: "Command",
        decisions: [{ id: "allow-policy", label: "Allow the offered policy" }],
        detail: {},
      },
      { type: "codex.command", decisionId: "allow-policy" },
    ],
    [
      {
        type: "codex.file",
        title: "Files",
        decisions: [{ id: "decline", label: "Decline" }],
        detail: {},
      },
      { type: "codex.file", decisionId: "decline" },
    ],
    [
      { type: "codex.permission", title: "Permissions", requested: { network: { enabled: true } } },
      { type: "codex.permission", grant: "turn" },
    ],
    [question, { type: "codex.question", answers: { one: { values: ["Yes"], extraInfo: "Yes" } } }],
    [
      {
        type: "codex.elicitation",
        title: "Form",
        message: "Required input",
        mode: "form",
        form: { fields: { accepted: { type: "boolean" } }, required: ["accepted"] },
      },
      { type: "codex.elicitation", action: "accept", content: { accepted: false } },
    ],
    [
      {
        type: "copilot.permission",
        title: "Permission",
        request: { kind: "shell" },
        managedApprovalRequired: true,
      },
      { type: "copilot.permission", kind: "reject", feedback: "Declined" },
    ],
    [
      {
        type: "copilot.question",
        title: "Question",
        question: "Which?",
        options: ["A"],
        freeform: true,
      },
      { type: "copilot.question", answer: "A", wasFreeform: false, extraInfo: "Keep context" },
    ],
    [
      {
        type: "copilot.plan",
        title: "Plan",
        summary: "Summary",
        plan: null,
        actions: ["approve-and-exit"],
        recommendedAction: "approve-and-exit",
      },
      { type: "copilot.plan", approved: true, selectedAction: "approve-and-exit" },
    ],
    [
      {
        type: "copilot.elicitation",
        title: "Verification",
        message: "Verify",
        mode: "url",
        verificationOrigin: "https://example.test",
      },
      { type: "copilot.elicitation", action: "accept" },
    ],
  ];
  assert.equal(new Set(fixtures.map(([prompt]) => prompt.type)).size, 9);
  for (const [prompt, answer] of fixtures) {
    assert.deepEqual(validatePrompt(prompt), prompt);
    assert.deepEqual(validateAnswer(prompt, answer), answer);
  }
  const exact: AnswerFor<Extract<Prompt, { type: "codex.command" }>> = {
    type: "codex.command",
    decisionId: "one",
  };
  void exact;
  const wrong: AnswerFor<Extract<Prompt, { type: "codex.command" }>> = {
    // @ts-expect-error File approval is not a command approval capability.
    type: "codex.file",
    decisionId: "one",
  };
  void wrong;
  assert.throws(
    () => validateAnswer(fixtures[0]![0], { type: "codex.command", decisionId: "invented-grant" }),
    /INVALID/,
  );
  assert.throws(
    () => validateAnswer(fixtures[7]![0], { type: "copilot.plan", approved: true }),
    /INVALID/,
  );
  assert.throws(
    () =>
      validateAnswer(fixtures[5]![0], {
        type: "copilot.permission",
        kind: "approve-once",
        feedback: "not allowed",
      }),
    /INVALID/,
  );
});

test("missing, empty and false answers are distinct; extra context belongs to its exact question", () => {
  const prompt = {
    ...question,
    questions: [...question.questions, { ...question.questions[0]!, id: "two", other: true }],
  };
  const answer = {
    type: "codex.question",
    answers: {
      one: { values: ["Yes"], extraInfo: "same words" },
      two: { values: ["custom"], extraInfo: "separate words" },
    },
  } as const;
  assert.deepEqual(validateAnswer(prompt, answer), answer);
  assert.throws(
    () => validateAnswer(prompt, { ...answer, answers: { one: answer.answers.one } }),
    /INVALID/,
  );
  assert.throws(
    () =>
      validateAnswer(prompt, { ...answer, answers: { ...answer.answers, one: { values: [] } } }),
    /INVALID/,
  );
  assert.throws(
    () =>
      validateAnswer(question, {
        type: "codex.question",
        answers: { one: { values: ["not offered"] } },
      }),
    /INVALID/,
  );
  const form = parseForm({
    type: "object",
    properties: {
      choice: { type: "string", enum: ["", "set"] },
      enabled: { type: "boolean" },
      count: { type: "integer", minimum: 0 },
    },
    required: ["choice", "enabled"],
  });
  assert.deepEqual({ ...formErrors(form, { choice: "", enabled: false, count: 0 }) }, {});
  assert.equal(formErrors(form, {}).enabled, "This field is required.");
  assert.equal(
    formErrors(form, { choice: "", enabled: false, extra: true }).extra,
    "This field is not requested.",
  );
  assert.equal(
    formErrors({ fields: { word: { type: "string", minLength: 2 } }, required: [] }, { word: "🙂" })
      .word,
    "Text length is outside the requested limits.",
  );
});

test("unsupported form constraints and secret verification URLs never become fabricated generic acceptance", () => {
  assert.throws(
    () => parseForm({ type: "object", properties: { nested: { type: "object", properties: {} } } }),
    /INVALID|UNSUPPORTED/,
  );
  assert.throws(
    () =>
      parseForm({ type: "object", properties: { formatted: { type: "string", pattern: "x+" } } }),
    /INVALID/,
  );
  const prompt: Prompt = {
    type: "codex.elicitation",
    title: "Verification",
    message: "Native schema unsupported",
    mode: "unsupported",
    reason: "Dedicated renderer required",
  };
  assert.throws(
    () => validateAnswer(prompt, { type: "codex.elicitation", action: "accept" }),
    /UNSUPPORTED/,
  );
  validateAnswer(prompt, { type: "codex.elicitation", action: "decline" });
  assert.throws(
    () =>
      validateAnswer(prompt, {
        type: "codex.elicitation",
        action: "cancel",
        content: {},
      } as Answer),
    /INVALID/,
  );
  assert.throws(
    () =>
      validatePrompt({
        type: "codex.elicitation",
        title: "Verify",
        message: "Verify",
        mode: "url",
        verificationOrigin: "https://example.test/verify?secret=value",
      }),
    /INVALID/,
  );
  const form = {
    type: "codex.elicitation",
    title: "Form",
    message: "Input",
    mode: "form",
    form: { fields: {}, required: [] },
  } as const;
  assert.throws(
    () => validateAnswer(form, { type: "codex.elicitation", action: "accept" }),
    /INVALID/,
  );
  validateAnswer(form, { type: "codex.elicitation", action: "accept", content: {} });
});

test("strict form schemas preserve native names, JSON safety and precise answer constraints", () => {
  const form = parseForm(
    JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"boolean"},"tags":{"type":"array","items":{"type":"string","enum":["","x"]},"maxItems":2}},"required":["__proto__"]}',
    ),
  );
  const values = JSON.parse('{"__proto__":false,"tags":[""]}');
  assert.deepEqual(formValue(form, values), values);
  assert.equal(Object.hasOwn(form.fields, "__proto__"), true);
  assert.equal(Object.isFrozen(form.fields.__proto__), true);
  assert.equal(
    formErrors(form, { tags: ["x", "x"] }).tags,
    "Choose offered values without duplicates.",
  );
  assert.equal(formErrors(form, { tags: [""] }).__proto__, "This field is required.");
  assert.equal(
    formErrors(
      { fields: { amount: { type: "integer", maximum: 2 } }, required: [] },
      { amount: 2.5 },
    ).amount,
    "Enter a valid number.",
  );
  assert.deepEqual(
    {
      ...formErrors(
        { fields: { word: { type: "string", minLength: 1, maxLength: 1 } }, required: [] },
        { word: "🙂" },
      ),
    },
    {},
  );
  assert.throws(
    () => validateForm({ fields: { bad: { type: "string", minimum: 0 } }, required: [] }),
    /INVALID/,
  );
  assert.throws(
    () => validateForm({ fields: { bad: { type: "array" } }, required: [] }),
    (error: unknown) => error instanceof InteractionError && error.code === "UNSUPPORTED",
  );
  assert.throws(
    () => parseForm({ type: "object", properties: {}, additionalProperties: true }),
    (error: unknown) => error instanceof InteractionError && error.code === "UNSUPPORTED",
  );
  assert.throws(
    () =>
      validatePrompt({
        type: "codex.command",
        title: "Missing details",
        decisions: [{ id: "allow", label: "Allow" }],
      } as unknown as Prompt),
    /INVALID/,
  );
  assert.throws(
    () =>
      validateAnswer(question, {
        type: "codex.question",
        answers: { one: { values: ["Yes"], extraInfo: "context", ignored: true } },
      } as Answer),
    /INVALID/,
  );
  let accessed = false;
  assert.throws(
    () =>
      formErrors(form, {
        get tags() {
          accessed = true;
          return ["x"];
        },
      }),
    /INVALID/,
  );
  assert.equal(accessed, false);
  const plan: Prompt = {
    type: "copilot.plan",
    title: "Plan",
    summary: "Summary",
    plan: "x".repeat(20000),
    actions: ["implement"],
    recommendedAction: "implement",
  };
  assert.deepEqual(validatePrompt(plan), plan);
});
