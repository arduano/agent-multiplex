import type { Activity, AttentionSignal } from "../../v8-session/src/contracts/types.js";
import { check, id } from "../../v8-session/src/contracts/validation.js";
import { sameAttention } from "../../v8-session/src/contracts/attention.js";
import type { CopilotEvent } from "./controller.js";

type Projection = Readonly<{ attention?: AttentionSignal; activity?: Activity }>;

/** Root-only observations. Child identity/task lifetime remains in the
 * controller's existing exact lineage, supplied here rather than mirrored. */
export class CopilotAttention {
  #cycle: string | null = null;
  #idle = true;
  #last: AttentionSignal | undefined;
  reset(): void { this.#cycle = null; this.#idle = true; this.#last = undefined; }
  #set(state: AttentionSignal["state"], cause: string, activity?: Activity): Projection {
    const attention: AttentionSignal = { state, cause: { source: "copilot.event", id: cause } };
    const changed = !this.#last || !sameAttention(this.#last, attention); this.#last = attention;
    return { ...(changed ? { attention } : {}), ...(activity === undefined ? {} : { activity }) };
  }
  invalidate(): Projection {
    // A later observation gap cannot erase an already positive root failure or
    // cancellation; it can withhold a previously unproved successful finish.
    if (!this.#cycle || this.#idle || ["error", "interrupted"].includes(this.#last?.state ?? "")) return {};
    return this.#set("unknown", this.#cycle, "unknown");
  }
  observe(event: CopilotEvent, children: Readonly<{ active: number; complete: boolean }>): Projection {
    if (event.type === "assistant.turn_start") {
      id(event.id); id(event.data.turnId);
      if (event.id === this.#cycle) return {};
      // Native turnId is a small loop-local number and may repeat. Native
      // event.id, not that number, identifies this root observation cycle.
      this.#cycle = event.id; this.#idle = false;
      return this.#set("working", event.id, "working");
    }
    if (!this.#cycle || this.#idle) {
      if (event.type !== "session.idle") return {};
      id(event.id); check(event.data.aborted === undefined || typeof event.data.aborted === "boolean");
      // Full native idle remains a useful activity observation after opening
      // or Resume. Without an identified work cycle it supplies no outcome.
      return { activity: children.complete && children.active === 0 ? "idle" : "unknown" };
    }
    if (event.type === "session.error") {
      id(event.id); check(text(event.data.errorType) && text(event.data.message));
      return this.#set("error", event.id);
    }
    if (event.type === "assistant.idle") {
      id(event.id); check(event.data.aborted === undefined || typeof event.data.aborted === "boolean");
      if (event.data.aborted === true) return this.#set("interrupted", event.id);
      if (["error", "interrupted", "unknown"].includes(this.#last?.state ?? "")) return {};
      return children.active > 0 ? this.#set("background", this.#cycle) : {};
    }
    if (event.type !== "session.idle") return {};
    id(event.id); check(event.data.aborted === undefined || typeof event.data.aborted === "boolean");
    // This native event says no agents or attached shells remain. Conflicting
    // exact child facts are a gap, not a license to discard their ownership.
    if (!children.complete || children.active !== 0) return { ...this.invalidate(), activity: "unknown" };
    this.#idle = true;
    if (event.data.aborted === true) return this.#set("interrupted", event.id, "idle");
    if (["error", "interrupted", "unknown"].includes(this.#last?.state ?? "")) return { activity: "idle" };
    // Finished means this continuously observed native work cycle settled.
    // It is not a claim that an Autopilot objective or user task succeeded.
    return this.#set("finished", event.id, "idle");
  }
}
const text = (value: unknown): boolean => typeof value === "string" && value.length > 0;
