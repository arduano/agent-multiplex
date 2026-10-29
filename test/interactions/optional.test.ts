import assert from "node:assert/strict";
import { test } from "node:test";
import { optionalQuestions, proposedPlan } from "../../src/interactions/index.js";

test("only bounded structured optional questions become draft suggestions; ordinary prose creates no requests", () => {
  const positive = { title: "Choose a path", options: ["First", "Second"] };
  assert.deepEqual(optionalQuestions([positive]).questions, [positive]);
  const result = optionalQuestions([
    positive,
    { title: "too long".repeat(100), options: [] },
    { title: "No choices" },
  ]);
  assert.equal(result.omitted, 1);
  assert.equal(result.questions.length, 2);
  assert.deepEqual(result.questions[1]!.options, []);
  assert.equal(optionalQuestions("Would you like A or B?").questions.length, 0);
  assert.equal(optionalQuestions(Array.from({ length: 10 }, () => positive)).omitted, 2);
  let invoked = false;
  assert.equal(
    optionalQuestions([
      {
        get title() {
          invoked = true;
          return "getter";
        },
        options: [],
      },
    ]).questions.length,
    0,
  );
  assert.equal(invoked, false);
});

test("explicit proposed-plan markers are display-only, outside code fences, complete and unambiguous", () => {
  assert.deepEqual(proposedPlan("Before\n<proposed_plan>\nDo this\n</proposed_plan>\nAfter"), {
    before: "Before",
    plan: "Do this",
    after: "After",
  });
  for (const value of [
    "An ordinary plan",
    "```xml\n<proposed_plan>\nExample\n</proposed_plan>\n```",
    "<proposed_plan>\nUnfinished",
    "<proposed_plan>\n</proposed_plan>",
    "<proposed_plan enabled>\nDo\n</proposed_plan>",
    "<proposed_plan>\nOne\n</proposed_plan>\n<proposed_plan>\nTwo\n</proposed_plan>",
  ])
    assert.equal(proposedPlan(value), null);
  assert.equal(
    proposedPlan("<proposed_plan>\n```xml\n</proposed_plan>\n```\nDone\n</proposed_plan>")!.plan,
    "```xml\n</proposed_plan>\n```\nDone",
  );
});
