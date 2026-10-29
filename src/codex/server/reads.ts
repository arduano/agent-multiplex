import type {
  CodexGoal,
  CodexMcpStatus,
  CodexModels,
  CodexRead,
  CodexReadResult,
  CodexReadResultFor,
  CodexTerminals,
} from "../contracts.js";
import type { CodexRequestPort } from "../node-contracts.js";
import { body, check, json, object, text } from "./validation.js";
export function readGoal(value: unknown, threadId: string): CodexGoal | null {
  const raw = object(value).goal;
  if (raw === null) return null;
  const goal = object(raw);
  check(goal.threadId === threadId, "GOAL_THREAD");
  check(
    ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(
      String(goal.status),
    ),
    "GOAL_STATUS",
  );
  check(
    goal.tokenBudget === null ||
      (Number.isSafeInteger(goal.tokenBudget) && Number(goal.tokenBudget) >= 0),
    "GOAL_BUDGET",
  );
  for (const key of ["tokensUsed", "timeUsedSeconds", "createdAt", "updatedAt"])
    check(Number.isSafeInteger(goal[key]) && Number(goal[key]) >= 0, "GOAL_USAGE");
  return {
    threadId,
    objective: body(goal.objective, 16384),
    status: text(goal.status),
    tokenBudget: goal.tokenBudget as number | null,
    tokensUsed: goal.tokensUsed as number,
    timeUsedSeconds: goal.timeUsedSeconds as number,
    createdAt: goal.createdAt as number,
    updatedAt: goal.updatedAt as number,
  };
}
/** Finite complete native model catalog; duplicate identity or cursor is not a
 * successful partial list. No provider fallback/model alias table exists. */
export async function readModels(rpc: CodexRequestPort, current: () => void): Promise<CodexModels> {
  const choices: CodexModels["choices"][number][] = [],
    seen = new Set<string>(),
    cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 8; page++) {
    current();
    const value = object(
      await rpc.request("model/list", { cursor, limit: 64, includeHidden: false }),
    );
    current();
    check(Array.isArray(value.data) && value.data.length <= 64, "MODEL_PAGE");
    for (const raw of value.data) {
      const row = object(raw),
        model = text(row.model);
      check(
        typeof row.hidden === "boolean" &&
          Array.isArray(row.supportedReasoningEfforts) &&
          row.supportedReasoningEfforts.length <= 16,
        "MODEL_SHAPE",
      );
      const efforts = row.supportedReasoningEfforts.map((value) =>
        text(object(value).reasoningEffort),
      );
      check(new Set(efforts).size === efforts.length, "MODEL_EFFORT_DUPLICATE");
      if (row.hidden) continue;
      check(!seen.has(model), "MODEL_DUPLICATE");
      seen.add(model);
      choices.push({
        model,
        efforts,
        ...(typeof row.displayName === "string"
          ? { displayName: row.displayName.slice(0, 1024) }
          : {}),
        ...(typeof row.description === "string"
          ? { description: row.description.slice(0, 8192) }
          : {}),
        ...(row.defaultReasoningEffort === undefined
          ? {}
          : {
              defaultEffort:
                row.defaultReasoningEffort === null ? null : text(row.defaultReasoningEffort),
            }),
        ...(Array.isArray(row.inputModalities)
          ? { inputModalities: row.inputModalities.slice(0, 16).map((value) => text(value)) }
          : {}),
      });
      check(choices.length <= 128, "MODEL_CAPACITY");
    }
    if (value.nextCursor === null) return { choices };
    const next = text(value.nextCursor, 4096);
    check(!cursors.has(next), "MODEL_CURSOR_CYCLE");
    cursors.add(next);
    cursor = next;
  }
  throw new Error("Codex model page limit");
}
export function readCodex<Request extends CodexRead>(
  rpc: CodexRequestPort,
  threadId: string,
  request: Request,
  current: () => void,
): Promise<CodexReadResultFor<Request>>;
export async function readCodex(
  rpc: CodexRequestPort,
  threadId: string,
  request: CodexRead,
  current: () => void,
): Promise<CodexReadResult> {
  current();
  if (request.type === "models") return readModels(rpc, current);
  if (request.type === "goal") {
    const raw = await rpc.request("thread/goal/get", { threadId });
    current();
    return readGoal(raw, threadId);
  }
  if (request.type === "terminals") {
    const limit = request.limit ?? 100;
    check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100, "TERMINAL_LIMIT");
    const raw = object(
      await rpc.request("thread/backgroundTerminals/list", {
        threadId,
        cursor: request.cursor ?? null,
        limit,
      }),
    );
    current();
    check(
      Array.isArray(raw.data) &&
        raw.data.length <= limit &&
        (raw.nextCursor === null || typeof raw.nextCursor === "string"),
      "TERMINAL_PAGE",
    );
    const data = raw.data.map((value) => {
      const row = object(value);
      check(row.osPid === null || (Number.isSafeInteger(row.osPid) && Number(row.osPid) > 0));
      check(
        row.cpuPercent === null ||
          (typeof row.cpuPercent === "number" &&
            Number.isFinite(row.cpuPercent) &&
            row.cpuPercent >= 0),
      );
      check(row.rssKb === null || (Number.isSafeInteger(row.rssKb) && Number(row.rssKb) >= 0));
      return {
        itemId: text(row.itemId),
        processId: text(row.processId),
        command: body(row.command, 8192),
        cwd: body(row.cwd, 4096),
        osPid: row.osPid as number | null,
        cpuPercent: row.cpuPercent as number | null,
        rssKb: row.rssKb as number | null,
      };
    });
    check(new Set(data.map((value) => value.processId)).size === data.length, "TERMINAL_DUPLICATE");
    return { data, nextCursor: raw.nextCursor as string | null } satisfies CodexTerminals;
  }
  const results: CodexMcpStatus[] = [],
    seen = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 8; page++) {
    const raw = object(await rpc.request("mcpServerStatus/list", { cursor, limit: 64 }));
    current();
    check(Array.isArray(raw.data) && raw.data.length <= 64, "MCP_PAGE");
    for (const value of raw.data) {
      const row = object(value),
        name = text(row.name);
      check(!seen.has(name), "MCP_DUPLICATE");
      seen.add(name);
      results.push({
        name,
        tools: Object.keys(object(row.tools ?? {})).map((value) => text(value)),
        ...(typeof row.status === "string" ? { status: text(row.status) } : {}),
      });
      check(results.length <= 128, "MCP_CAPACITY");
    }
    if (raw.nextCursor === null) return results;
    const next = text(raw.nextCursor, 4096);
    check(!seen.has(`cursor:${next}`), "MCP_CURSOR_CYCLE");
    seen.add(`cursor:${next}`);
    cursor = next;
  }
  json(results);
  throw new Error("Codex MCP page limit");
}
