import { parseForm, validateAnswer, validatePrompt } from "../../interactions/index.js";
import type { Answer, Prompt } from "../../interactions/contracts.js";
import type { Json } from "../../protocol/index.js";
import type { ReverseRequest } from "../node-contracts.js";
import { body, check, json, object, text } from "./validation.js";

export type NormalizedCallback = Readonly<{
  prompt: Prompt;
  encode(answer: Answer): Json;
  privateUrl?: string;
}>;
/** Native values are captured privately. Public decision IDs and form schemas
 * grant only this exact one-response capability, never a generic approval. */
export function normalizeCallback(
  request: ReverseRequest,
  nativeAgent: string,
): NormalizedCallback {
  const params = object(json(request.params, 65536));
  check(params.threadId === nativeAgent, "CALLBACK_THREAD_FENCED");
  let prompt: Prompt, encode: (answer: Answer) => Json, privateUrl: string | undefined;
  if (
    request.method === "item/commandExecution/requestApproval" ||
    request.method === "item/fileChange/requestApproval"
  ) {
    text(params.turnId);
    text(params.itemId);
    const offered =
      request.method === "item/fileChange/requestApproval"
        ? ["accept", "acceptForSession", "decline", "cancel"]
        : (params.availableDecisions ?? ["accept", "decline", "cancel"]);
    check(
      Array.isArray(offered) && offered.length > 0 && offered.length <= 16,
      "APPROVAL_DECISIONS",
    );
    const decisions = offered.map((value, index) => {
      if (typeof value === "string")
        check(
          ["accept", "acceptForSession", "decline", "cancel"].includes(value),
          "APPROVAL_DECISION",
        );
      else {
        const row = object(value);
        check(
          Object.keys(row).length === 1 &&
            (row.acceptWithExecpolicyAmendment || row.applyNetworkPolicyAmendment),
          "APPROVAL_DECISION",
        );
      }
      return {
        id: `decision:${index}`,
        label: typeof value === "string" ? value : Object.keys(object(value))[0]!,
      };
    });
    const detail: Record<string, Json> = {};
    for (const key of ["command", "cwd", "reason", "networkApprovalContext"])
      if (params[key] != null) detail[key] = json(params[key], 16384);
    prompt = {
      type: request.method === "item/fileChange/requestApproval" ? "codex.file" : "codex.command",
      title:
        request.method === "item/fileChange/requestApproval"
          ? "Review file changes"
          : "Review command",
      decisions,
      detail,
    };
    encode = (answer) => {
      check(answer.type === "codex.command" || answer.type === "codex.file");
      const index = decisions.findIndex((value) => value.id === answer.decisionId);
      check(index >= 0);
      return { decision: json(offered[index]) };
    };
  } else if (request.method === "item/permissions/requestApproval") {
    text(params.turnId);
    text(params.itemId);
    const requested = object(params.permissions);
    check(
      Object.keys(requested).every((key) => ["network", "fileSystem"].includes(key)),
      "PERMISSION_SHAPE",
    );
    prompt = {
      type: "codex.permission",
      title: "Review additional permissions",
      requested: json(requested, 16384),
    };
    encode = (answer) => {
      check(answer.type === "codex.permission");
      return {
        permissions:
          answer.grant === "deny"
            ? {}
            : json(
                Object.fromEntries(Object.entries(requested).filter(([, value]) => value != null)),
              ),
        scope: answer.grant === "session" ? "session" : "turn",
      };
    };
  } else if (request.method === "item/tool/requestUserInput") {
    text(params.turnId);
    text(params.itemId);
    check(
      typeof params.isBlocking === "boolean" && Array.isArray(params.questions),
      "QUESTION_SHAPE",
    );
    const questions = params.questions.map((value) => {
      const row = object(value);
      check(typeof row.isSecret === "boolean" && typeof row.isOther === "boolean");
      check(row.options === null || Array.isArray(row.options));
      return {
        id: text(row.id),
        header: body(row.header, 4096),
        question: body(row.question, 8192),
        secret: row.isSecret,
        other: row.isOther,
        options: (row.options ?? ([] as unknown[])).map((value: unknown) => {
          const option = object(value);
          return {
            label: body(option.label, 4096),
            ...(option.description == null ? {} : { description: body(option.description, 4096) }),
          };
        }),
      };
    });
    prompt = {
      type: "codex.question",
      title: "Agent questions",
      questions,
      blocking: params.isBlocking,
    };
    encode = (answer) => {
      check(answer.type === "codex.question");
      return {
        answers: Object.fromEntries(
          questions.map((question) => {
            const value = answer.answers[question.id]!;
            return [
              question.id,
              {
                answers: [
                  ...value.values,
                  ...(value.extraInfo === undefined ? [] : [value.extraInfo]),
                ],
              },
            ];
          }),
        ),
      };
    };
  } else {
    check(request.method === "mcpServer/elicitation/request", "UNSUPPORTED_REVERSE_METHOD");
    text(params.serverName);
    const message = body(params.message, 16384);
    if (params.mode === "url") {
      const url = new URL(text(params.url, 8192));
      check(["http:", "https:"].includes(url.protocol) && !url.username && !url.password);
      privateUrl = url.href;
      prompt = {
        type: "codex.elicitation",
        title: "Tool confirmation",
        message,
        mode: "url",
        verificationOrigin: url.origin,
      };
    } else if (params.mode === undefined || params.mode === "form") {
      try {
        prompt = {
          type: "codex.elicitation",
          title: "Tool confirmation",
          message,
          mode: "form",
          form: parseForm(params.requestedSchema),
        };
      } catch {
        prompt = {
          type: "codex.elicitation",
          title: "Tool confirmation",
          message,
          mode: "unsupported",
          reason: "Unsupported native form schema",
        };
      }
    } else
      prompt = {
        type: "codex.elicitation",
        title: "Tool confirmation",
        message,
        mode: "unsupported",
        reason: "Unsupported native elicitation mode",
      };
    encode = (answer) => {
      check(answer.type === "codex.elicitation");
      return {
        action: answer.action,
        content: answer.action === "accept" ? json(answer.content ?? null) : null,
        _meta: null,
      };
    };
  }
  const fixed = validatePrompt(prompt);
  return {
    prompt: fixed,
    encode(answer) {
      return encode(validateAnswer(fixed, answer));
    },
    ...(privateUrl ? { privateUrl } : {}),
  };
}
