import {
  parseForm,
  validateAnswer,
  validatePrompt,
  type Prompt,
  type Answer,
} from "../../interactions/index.js";
import type { Json } from "../../protocol/index.js";
import { check, json, object, text } from "./validation.js";
export type NormalizedCallback = Readonly<{
  prompt: Prompt;
  encode(answer: Answer): Json;
  privateUrl?: string;
}>;
export function normalizeCallback(
  type: "question" | "plan" | "elicitation",
  raw: unknown,
): NormalizedCallback {
  const data = object(raw);
  let prompt: Prompt;
  let encode: (answer: Answer) => Json;
  let privateUrl: string | undefined;
  if (type === "question") {
    check(data.choices === undefined || Array.isArray(data.choices));
    const choices = (data.choices ?? []) as unknown[];
    prompt = {
      type: "copilot.question",
      title: "Agent question",
      question: text(data.question, 16384),
      options: choices.map((value) => text(value, 4096)),
      freeform: data.allowFreeform !== false,
    };
    encode = (answer) => {
      check(answer.type === "copilot.question");
      return {
        answer:
          answer.answer + (answer.extraInfo ? `\n\nAdditional info: ${answer.extraInfo}` : ""),
        wasFreeform: answer.wasFreeform || answer.extraInfo !== undefined,
      };
    };
  } else if (type === "plan") {
    check(Array.isArray(data.actions));
    prompt = {
      type: "copilot.plan",
      title: "Review plan",
      summary: text(data.summary, 16384),
      plan: data.planContent === undefined ? null : text(data.planContent, 32768),
      actions: data.actions.map((value) => text(value, 256)),
      recommendedAction: text(data.recommendedAction, 256),
    };
    encode = (answer) => {
      check(answer.type === "copilot.plan");
      return {
        approved: answer.approved,
        ...(answer.selectedAction === undefined ? {} : { selectedAction: answer.selectedAction }),
        ...(answer.feedback === undefined ? {} : { feedback: answer.feedback }),
      };
    };
  } else {
    const message = text(data.message, 16384);
    if (data.mode === "url") {
      const url = new URL(text(data.url, 8192));
      check(
        ["https:", "http:"].includes(url.protocol) && !url.username && !url.password,
        "ELICITATION_URL",
      );
      privateUrl = url.href;
      prompt = {
        type: "copilot.elicitation",
        title: "Tool confirmation",
        mode: "url",
        message,
        verificationOrigin: url.origin,
      };
    } else if (data.mode === undefined || data.mode === "form") {
      try {
        prompt = {
          type: "copilot.elicitation",
          title: "Tool confirmation",
          mode: "form",
          message,
          form: parseForm(data.requestedSchema),
        };
      } catch {
        prompt = {
          type: "copilot.elicitation",
          title: "Tool confirmation",
          mode: "unsupported",
          message,
          reason: "Unsupported native form schema",
        };
      }
    } else
      prompt = {
        type: "copilot.elicitation",
        title: "Tool confirmation",
        mode: "unsupported",
        message,
        reason: "Unsupported native elicitation mode",
      };
    encode = (answer) => {
      check(answer.type === "copilot.elicitation");
      return {
        action: answer.action,
        ...(answer.action === "accept" && answer.content !== undefined
          ? { content: json(answer.content) }
          : {}),
      };
    };
  }
  const fixed = validatePrompt(prompt);
  return {
    prompt: fixed,
    encode(answer) {
      return encode(validateAnswer(fixed, answer));
    },
    ...(privateUrl === undefined ? {} : { privateUrl }),
  };
}
