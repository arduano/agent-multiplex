import { SessionError, sameRun, type Goal, type Harness, type NativeRead, type NativeReadResult, type RunRef, type Task, type TaskProgress } from "../../v8-session/src/contracts/types.js";
import { check, frozen, id } from "../../v8-session/src/contracts/validation.js";
import { nativeStateData, validateRun } from "../../v8-session/src/native/validation.js";

const object = (value: unknown): Record<string, unknown> => { check(value && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; };
const string = (value: unknown, maximum = 8192): string => { check(typeof value === "string" && value.length <= maximum); return value; };
const preview = (value: unknown): string => { check(typeof value === "string"); return value.length > 8192 ? value.slice(0, 8191) + "…" : value; };
const identity = (value: unknown): string => { id(value); check(!/[\u0000-\u001f\u007f]/.test(value)); return value; };
const integer = (value: unknown): number => { check(Number.isSafeInteger(value) && Number(value) >= 0); return value as number; };
const status = (value: unknown): Task["status"] => { check(["running", "idle", "completed", "failed", "cancelled", "orphaned"].includes(String(value))); return value as Task["status"]; };
/** The same bounded plain-data check as native outcomes, before inspecting fields. */
export const nativeObject = (value: unknown): Record<string, unknown> => object(nativeStateData(value));
export function validateNativeRead(kind: Harness, value: unknown): NativeRead {
  const v = nativeObject(value);
  check(typeof v.type === "string" && v.type.startsWith(`${kind}.`));
  check(["codex.goal", "codex.terminals", "copilot.queue", "copilot.tasks", "copilot.task.progress", "copilot.task.promotable"].includes(v.type));
  if (v.type === "codex.terminals") {
    check(Object.keys(v).every(key => ["type", "cursor", "limit"].includes(key)));
    if (v.cursor !== undefined && v.cursor !== null) check(string(v.cursor, 8192).length > 0);
    if (v.limit !== undefined) check(integer(v.limit) >= 1 && Number(v.limit) <= 100);
    return frozen(v) as NativeRead;
  }
  check(Object.keys(v).every(key => key === "type" || key === "id"));
  if (v.type === "copilot.task.progress") identity(v.id); else check(v.id === undefined);
  return frozen(v) as NativeRead;
}
export function goal(value: unknown, nativeSession: string, allowNull = true): Goal | null {
  const v = nativeObject(value); check(Object.hasOwn(v, "goal"));
  if (v.goal === null) { check(allowNull); return null; }
  const g = object(v.goal); check(g.threadId === nativeSession);
  check(string(g.objective, 4000).trim().length > 0);
  check(["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"].includes(String(g.status)));
  check(g.tokenBudget === null || Number.isSafeInteger(g.tokenBudget) && Number(g.tokenBudget) >= 0);
  return frozen({ threadId: nativeSession, objective: g.objective as string, status: g.status as Goal["status"], tokenBudget: g.tokenBudget as number | null,
    tokensUsed: integer(g.tokensUsed), timeUsedSeconds: integer(g.timeUsedSeconds), createdAt: integer(g.createdAt), updatedAt: integer(g.updatedAt) });
}
function task(value: unknown): Task {
  const v = object(value), type = v.type; check(type === "agent" || type === "shell" || type === "client");
  const s = status(v.status); check(type === "client" || s !== "orphaned");
  const result: Record<string, unknown> = { id: identity(v.id), type, description: string(v.description), status: s, startedAt: string(v.startedAt, 256) };
  if (v.completedAt !== undefined) result.completedAt = string(v.completedAt, 256);
  if (v.executionMode !== undefined) { check(v.executionMode === "sync" || v.executionMode === "background"); result.executionMode = v.executionMode; }
  for (const key of ["canPromoteToBackground", "canCancel"]) if (v[key] !== undefined) { check(typeof v[key] === "boolean"); result[key] = v[key]; }
  if (type === "agent") {
    result.toolCallId = identity(v.toolCallId); result.agentType = string(v.agentType, 256);
    // Prompt/log paths/ownership capsules do not enter this observation.
    // Model absence/null stays unknown, never inferred from the parent.
    if (v.model !== undefined) result.model = v.model === null ? null : string(v.model, 256);
    if (v.resolvedModel !== undefined) result.resolvedModel = string(v.resolvedModel, 256);
    for (const key of ["latestResponse", "result"]) if (v[key] !== undefined) result[key] = preview(v[key]);
  } else if (type === "shell") {
    result.command = string(v.command);
    if (v.pid !== undefined) { check(integer(v.pid) > 0); result.pid = v.pid; }
  }
  else { check(v.executionMode === "background" && typeof v.canCancel === "boolean"); }
  if (type === "agent" || type === "client") {
    if (v.displayName !== undefined) result.displayName = string(v.displayName, 256);
    if (v.error !== undefined) result.error = preview(v.error);
  }
  return frozen(result) as Task;
}
function progress(value: unknown): TaskProgress | null {
  if (value === null || value === undefined) return null;
  const v = object(value), type = v.type; check(type === "agent" || type === "shell" || type === "client");
  const result: Record<string, unknown> = { type };
  if (type === "shell") result.recentOutput = string(v.recentOutput, 32768);
  else {
    check(Array.isArray(v.recentActivity) && v.recentActivity.length <= 128);
    result.recentActivity = v.recentActivity.map(raw => { const line = object(raw); return { message: string(line.message), timestamp: string(line.timestamp, 256) }; });
  }
  if (type === "agent" && v.latestIntent !== undefined) result.latestIntent = string(v.latestIntent);
  if (type === "client") {
    result.status = status(v.status); result.sequence = integer(v.sequence); result.updatedAt = string(v.updatedAt, 256);
    if (v.percentage !== undefined) { check(typeof v.percentage === "number" && Number.isFinite(v.percentage) && v.percentage >= 0 && v.percentage <= 100); result.percentage = v.percentage; }
    for (const key of ["phase", "lastMessage"]) if (v[key] !== undefined) result[key] = string(v[key]);
  }
  return frozen(result) as TaskProgress;
}
/** Project a complete bounded native response; malformed is unavailable, never empty. */
export function nativeReadResult(runValue: RunRef, request: NativeRead, value: unknown): NativeReadResult {
  const run = validateRun(runValue), v = nativeObject(value), type = request.type;
  if (type === "codex.goal") return frozen({ run, type, goal: goal(v, run.nativeSession) });
  if (type === "codex.terminals") {
    check(Array.isArray(v.data) && v.data.length <= (request.limit ?? 100));
    check(v.nextCursor === null || string(v.nextCursor, 8192).length > 0);
    const data = v.data.map(raw => {
      const item = object(raw); check(item.osPid === null || integer(item.osPid) > 0);
      check(item.cpuPercent === null || typeof item.cpuPercent === "number" && Number.isFinite(item.cpuPercent) && item.cpuPercent >= 0);
      if (item.rssKb !== null) integer(item.rssKb);
      return { itemId: identity(item.itemId), processId: identity(item.processId), command: string(item.command), cwd: string(item.cwd), osPid: item.osPid as number | null, cpuPercent: item.cpuPercent as number | null, rssKb: item.rssKb as number | null };
    });
    check(new Set(data.map(item => item.processId)).size === data.length);
    return frozen({ run, type, data, nextCursor: v.nextCursor as string | null });
  }
  if (type === "copilot.queue") {
    check(Array.isArray(v.items) && Array.isArray(v.steeringMessages) && v.items.length + v.steeringMessages.length <= 128);
    const items = v.items.map(raw => { const q = object(raw); return { id: identity(q.id), ...(q.messageId === undefined ? {} : { messageId: identity(q.messageId) }), kind: string(q.kind, 256), displayText: string(q.displayText), agentMode: string(q.agentMode, 256) }; });
    const steeringMessages = v.steeringMessages.map(text => string(text));
    if (v.inFlightSteeringCount !== undefined) check(integer(v.inFlightSteeringCount) <= steeringMessages.length);
    return frozen({ run, type, items, steeringMessages, ...(v.inFlightSteeringCount === undefined ? {} : { inFlightSteeringCount: v.inFlightSteeringCount as number }) });
  }
  if (type === "copilot.tasks") { check(Array.isArray(v.tasks) && v.tasks.length <= 128); const tasks = v.tasks.map(task); check(new Set(tasks.map(item => item.id)).size === tasks.length); return frozen({ run, type, tasks }); }
  if (type === "copilot.task.progress") return frozen({ run, type, id: request.id, progress: progress(v.progress) });
  if (type === "copilot.task.promotable") return frozen({ run, type, task: v.task === undefined ? null : task(v.task) });
  throw new SessionError("UNSUPPORTED");
}
export function validateNativeReadResult(run: RunRef, request: NativeRead, value: NativeReadResult): NativeReadResult {
  const v = nativeObject(value); check(sameRun(validateRun(v.run), run) && v.type === request.type);
  if (request.type === "copilot.task.progress") check(v.id === request.id);
  // Closed DTOs share the native field names; unknown fields are stripped again.
  return nativeReadResult(run, request, request.type === "copilot.task.promotable" && v.task === null ? {} : v);
}
