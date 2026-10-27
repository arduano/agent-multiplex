import type { Activity, AttentionSignal } from "../../v8-session/src/contracts/types.js";
import { check, id } from "../../v8-session/src/contracts/validation.js";
import { sameAttention } from "../../v8-session/src/contracts/attention.js";

type Projection = Readonly<{ attention?: AttentionSignal; activity?: Activity }>;
const object = (value: unknown): Record<string, unknown> => { check(value && typeof value === "object" && !Array.isArray(value)); return value as Record<string, unknown>; };
const text = (value: unknown): boolean => typeof value === "string" && value.length > 0;

/** One root turn observer. The controller proves root ownership before entry;
 * this replaces its old turn/idle flag rather than maintaining another turn. */
export class CodexAttention {
  #turn: string | null = null;
  #last: AttentionSignal | undefined;
  readonly #terminal = new Set<string>();
  reset(): void { this.#turn = null; this.#last = undefined; this.#terminal.clear(); }
  #set(state: AttentionSignal["state"], turn: string, activity?: Activity): Projection {
    const attention: AttentionSignal = { state, cause: { source: "codex.turn", id: turn } };
    const changed = !this.#last || !sameAttention(this.#last, attention); this.#last = attention;
    return { ...(changed ? { attention } : {}), ...(activity === undefined ? {} : { activity }) };
  }
  invalidate(): Projection { return this.#turn ? this.#set("unknown", this.#turn, "unknown") : {}; }
  observe(method: string, params: Record<string, unknown>): Projection {
    if (method === "turn/started") {
      const turn = object(params.turn); id(turn.id);
      if (this.#turn === turn.id) return {};
      // Match the codec's bounded recent-terminal window, not a lifetime quota.
      // A recent old start cannot replace newer work or revive a settled turn.
      if (this.#terminal.has(turn.id)) return {};
      this.#turn = turn.id; return this.#set("working", turn.id, "working");
    }
    if (method === "turn/completed") {
      const turn = object(params.turn); if (turn.id !== this.#turn || this.#turn === null) return {};
      check(["completed", "failed", "interrupted"].includes(String(turn.status)));
      const current = this.#turn; this.#turn = null;
      this.#terminal.add(current);
      if (this.#terminal.size > 256) this.#terminal.delete(this.#terminal.values().next().value!);
      return this.#set(turn.status === "completed" ? "finished" : turn.status === "failed" ? "error" : "interrupted", current, "idle");
    }
    if (method === "thread/status/changed") {
      const status = object(params.status);
      // Thread status and exact turn outcome are separate notifications. Idle
      // cannot settle/erase an active turn or invent a contradictory failure.
      if (status.type === "idle") return this.#turn === null ? { activity: "idle" } : {};
      if (status.type === "systemError") return this.invalidate();
      return {};
    }
    if (this.#turn === null || params.turnId !== this.#turn) return {};
    if (method === "error") {
      check(typeof params.willRetry === "boolean");
      return this.#set(params.willRetry ? "retrying" : "error", this.#turn);
    }
    // Output/completion from a tool dispatched before a provider retry cannot
    // prove recovery. Actual new model output or native tool dispatch can.
    const delta = ["item/agentMessage/delta", "item/plan/delta", "item/reasoning/textDelta", "item/reasoning/summaryTextDelta"].includes(method) && text(params.delta);
    let dispatch = false;
    if (method === "item/started") {
      const item = object(params.item);
      dispatch = item.status === "inProgress" && ["fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(String(item.type)) ||
        item.type === "commandExecution" && item.status === "inProgress" && ["agent", "unifiedExecStartup", "unifiedExecInteraction"].includes(String(item.source)) ||
        ["webSearch", "imageView", "sleep"].includes(String(item.type));
    }
    if ((delta || dispatch) && this.#last?.state !== "working") return this.#set("working", this.#turn, "working");
    return {};
  }
}
