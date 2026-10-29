import type { inferRouterInputs } from "@trpc/server";
import type { CopilotCommand, CopilotSelection } from "../../src/copilot/index.js";
import type { copilotRouter } from "../../src/copilot/server/router.js";
// @ts-expect-error Native factories and private configuration are absent from browser contracts.
import type { createCopilotAdapter as _createCopilotAdapter } from "../../src/copilot/index.js";
type Command = inferRouterInputs<ReturnType<typeof copilotRouter>>["command"]["command"];
const abort: Command = { type: "abort" };
void abort;
// @ts-expect-error Copilot cannot invoke Codex goal controls.
const codex: CopilotCommand = { type: "goal.clear" };
void codex;
// @ts-expect-error An atomic promptless Continue is not supported by this pinned Copilot SDK.
const continuation: Command = { type: "continue" };
void continuation;
const wrong: CopilotSelection = {
  kind: "copilot",
  model: "m",
  // @ts-expect-error Codex permission topology is not a Copilot selection.
  access: { sandbox: "danger-full-access", approval: "on-request" },
};
void wrong;
const wrongAnswer: CopilotCommand = {
  type: "answer",
  reference: {
    run: {
      scope: { connection: "c", principal: "p", host: "h", session: "s" },
      generation: 1,
      nativeSession: "n",
    },
    attachment: "a",
    incarnation: 1,
  },
  // @ts-expect-error Copilot answer commands cannot carry a Codex callback response.
  answer: { type: "codex.question", answers: {} },
};
void wrongAnswer;
