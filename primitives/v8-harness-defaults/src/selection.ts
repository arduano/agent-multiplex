import { sameRun, type Catalog, type Harness, type NativeEvent, type NativeOutcome, type RunRef, type Selection, type SelectionFor } from "../../v8-session/src/contracts/types.js";
import { canonical, check, frozen } from "../../v8-session/src/contracts/validation.js";
import { validateEvent, validateSelection } from "./validation.js";
import { validateCatalog, validateOutcome, validateRun } from "../../v8-session/src/native/validation.js";

export type SelectionFence = Readonly<{ run: RunRef; revision: number }>;
/** One current observation, distinct native preferences, and no ACK-to-selection shortcut. */
export class SelectionOwner<K extends Harness> {
  readonly #kind: K;
  #run: RunRef;
  #revision = 0;
  #selection: SelectionFor<K>;
  #preferences: Readonly<{ effort?: string | null }> = Object.freeze({});
  #catalog: Catalog = Object.freeze({ available: false, choices: [] });
  constructor(kind: K, run: RunRef, initial: SelectionFor<K>) {
    this.#kind = kind; this.#run = validateRun(run);
    this.#selection = validateSelection(kind, initial) as SelectionFor<K>;
    if (initial.effort !== undefined) this.#preferences = frozen({ effort: initial.effort });
  }
  snapshot(): Readonly<{ run: RunRef; revision: number; selection: SelectionFor<K>; nativePreferences: Readonly<{ effort?: string | null }>; catalog: Catalog }> {
    return frozen({ run: this.#run, revision: this.#revision, selection: this.#selection, nativePreferences: this.#preferences, catalog: this.#catalog });
  }
  fence(): SelectionFence { return frozen({ run: this.#run, revision: this.#revision }); }
  /** Invalidates older reads without inventing a newly applied native selection. */
  beginChange(): SelectionFence { this.#revision++; return this.fence(); }
  acknowledge(value: unknown): NativeOutcome { return validateOutcome(value); }
  setCatalog(value: unknown): void { this.#catalog = validateCatalog(value); }
  observe(value: unknown): NativeEvent {
    const selection = validateSelection(this.#kind, value) as SelectionFor<K>;
    if (selection.effort !== undefined) this.#preferences = frozen({ effort: selection.effort });
    this.#selection = selection; this.#revision++;
    return validateEvent(this.#kind, { run: this.#run, type: "selection", selection });
  }
  acceptRead(fence: SelectionFence, value: unknown): boolean {
    if (!sameRun(this.#run, fence.run) || fence.revision !== this.#revision) return false;
    this.observe(value); return true;
  }
  rebind(run: RunRef, initial: SelectionFor<K>): void {
    const next = validateRun(run);
    if (canonical(next.scope) !== canonical(this.#run.scope) || next.nativeSession !== this.#run.nativeSession) this.#preferences = Object.freeze({});
    this.#run = next; this.observe(initial);
  }
  /** Root-scoped .19 events only; child observations never overwrite root state. */
  copilotEvent(value: unknown, expectedAgentId: string | null = null): NativeEvent | null {
    check(this.#kind === "copilot");
    const event = object(value), type = field(event, "type");
    if (!["session.model_change", "session.model_deselected", "session.mode_changed", "session.permissions_changed"].includes(String(type))) return null;
    const agent = field(event, "agentId");
    if (agent !== undefined) check(typeof agent === "string" && agent.length > 0 && agent.length <= 256);
    if ((agent ?? null) !== expectedAgentId) return null;
    const data = object(field(event, "data"));
    const legacyAgent = field(data, "agentId"), legacyTool = field(data, "parentToolCallId");
    // A legacy child marker cannot be root-promoted merely because the envelope omitted it.
    if (legacyAgent !== undefined || legacyTool !== undefined) return null;
    const current = { ...this.#selection } as Record<string, unknown>;
    if (type === "session.model_change") {
      current.model = field(data, "newModel"); delete current.providerId; delete current.effort;
      const provider = field(data, "providerId"), effort = field(data, "reasoningEffort");
      if (provider !== undefined) current.providerId = provider;
      if (effort !== undefined) current.effort = effort;
    } else if (type === "session.model_deselected") {
      const previous = field(data, "previousModel"); check(typeof previous === "string" && previous.length > 0 && previous.length <= 256);
      delete current.model; delete current.providerId; delete current.effort;
      // Independent native effort preference remains recorded even though no
      // concrete current model/effort pair can now be certified.
    } else if (type === "session.mode_changed") current.mode = field(data, "newMode");
    else {
      const mode = field(data, "mode"); if (mode === undefined) return null; current.permissions = mode;
    }
    return this.observe(current);
  }
  codexEvent(value: unknown): NativeEvent | null {
    check(this.#kind === "codex");
    const event = object(value); if (field(event, "method") !== "thread/settings/updated") return null;
    const params = object(field(event, "params")); if (field(params, "threadId") !== this.#run.nativeSession) return null;
    const raw = object(field(params, "threadSettings")), selected: Record<string, unknown> = { ...this.#selection };
    const model = field(raw, "model"), effort = field(raw, "effort"), collaboration = field(raw, "collaborationMode");
    if (model !== undefined) { selected.model = model; if (effort === undefined) delete selected.effort; }
    if (effort !== undefined) selected.effort = effort;
    if (collaboration !== undefined) {
      const mode = object(collaboration), settings = object(field(mode, "settings"));
      const instructions = field(settings, "developer_instructions");
      selected.collaboration = { mode: field(mode, "mode"), model: field(settings, "model"), effort: field(settings, "reasoning_effort"),
        ...(instructions === undefined ? {} : { instructions }) };
    } else if (model !== undefined || effort !== undefined) delete selected.collaboration;
    const approval = field(raw, "approvalPolicy"), sandbox = field(raw, "sandboxPolicy"), profile = field(raw, "activePermissionProfile");
    if (approval !== undefined || sandbox !== undefined || profile !== undefined) {
      delete selected.access;
      if (["on-request", "untrusted", "never"].includes(String(approval))) {
        const profileId = profile && typeof profile === "object" && !Array.isArray(profile) ? field(object(profile), "id") : undefined;
        if (typeof profileId === "string" && profileId.length > 0) selected.access = { approval, profile: profileId };
        else if (sandbox && typeof sandbox === "object" && !Array.isArray(sandbox)) {
          const type = field(object(sandbox), "type"), mode = type === "dangerFullAccess" ? "danger-full-access" : type === "workspaceWrite" ? "workspace-write" : type === "readOnly" ? "read-only" : undefined;
          if (mode) selected.access = { approval, sandbox: mode };
        }
      }
      // A granular/unknown native policy lies outside this increment's typed
      // access vocabulary. Unknown is absence, never the managed default.
    }
    return this.observe(selected);
  }
}
function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
  return value as Record<string, unknown>;
}
function field(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key); check(!descriptor || "value" in descriptor); return descriptor?.value;
}
