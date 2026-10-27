import { scopeKey, type SessionPort, type SessionScope } from "../../v8-session/src/contracts/types.js";
import { canonical, copy, create as validateCreate } from "../../v8-catalog/src/contracts/validation.js";
import { CatalogError, sessionScope, type CreateRequest, type HostCreationPort, type HostCreationStatus, type HostTarget } from "../../v8-catalog/src/contracts/types.js";
/** Composition configures the native port from original cwd/policy before opening its logical Host journal. */
export function sessionCreationHost(options: Readonly<{ target: HostTarget; resolve(original: CreateRequest, mode: "create" | "read"): Promise<SessionPort | null> }>): HostCreationPort {
  const target = copy(options.target), resolve = options.resolve;
  const fixed = (original: CreateRequest): SessionScope => { if (canonical(target) !== canonical(original.target)) throw new CatalogError("FENCED"); return sessionScope(original); };
  const observe = async (port: SessionPort, original: CreateRequest): Promise<HostCreationStatus> => {
    const scope = fixed(original), receipt = await port.receipt(scope, original.id);
    if (!receipt) return { state: "unknown" };
    if (receipt.id !== original.id || receipt.type !== "create" || receipt.generation !== 0 || scopeKey(receipt.scope) !== scopeKey(scope)) throw new CatalogError("FENCED");
    if (receipt.state === "refused") return { state: "refused" };
    const snapshot = await port.snapshot(scope);
    if (scopeKey(snapshot.scope) !== scopeKey(scope) || snapshot.kind !== target.kind || snapshot.placement !== target.placement || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0) throw new CatalogError("FENCED");
    if (snapshot.generation < 1 || !snapshot.nativeSession) return { state: "unknown" };
    // Catalog identity exists before native initialization/receipt ACK. Host phase stays authoritative.
    return { state: "created", binding: { nativeSession: snapshot.nativeSession, generation: 1, kind: target.kind, placement: target.placement } };
  };
  return Object.freeze({ target,
    async create(original: CreateRequest): Promise<HostCreationStatus> { original = validateCreate(original); const scope = fixed(original), port = await resolve(original, "create"); if (!port) return { state: "refused" }; await port.submit({ scope, id: original.id, generation: 0, command: { type: "create", ...(original.selection ? { selection: original.selection } : {}) } }); return observe(port, original); },
    async watch(original: CreateRequest, listener: (status: HostCreationStatus) => void): Promise<() => void> {
      original = validateCreate(original); const scope = fixed(original), port = await resolve(original, "read");
      if (!port) return () => {};
      let active = true, running = false, dirty = false, installed = false;
      const observeChanged = () => {
        dirty = true; if (running || !active || !installed) return; running = true;
        void (async () => { try { while (active && dirty) { dirty = false; let value: HostCreationStatus; try { value = await observe(port, original); } catch { continue; /* Only an already-notified dirty bit can start another read. */ } if (active) try { listener(copy(value)); } catch { /* Catalog consumer isolation. */ } } } catch { /* Explicit receipt check remains available after read failure. */ } finally { running = false; } })();
      };
      // Install both retained sources before the first read: early persisted native ID can
      // arrive while Create is still Starting and awaiting a real user confirmation.
      const releases: (() => void)[] = [];
      try { releases.push(port.subscribe(scope, observeChanged)); if (port.subscribeReceipt) releases.push(port.subscribeReceipt(scope, original.id, observeChanged)); }
      catch (error) { active = false; for (const release of releases) try { release(); } catch {} throw error; }
      installed = true; observeChanged();
      return () => { active = false; dirty = false; for (const release of releases) try { release(); } catch { /* Release every observation. */ } };
    },
    async read(original: CreateRequest): Promise<HostCreationStatus> { original = validateCreate(original); fixed(original); const port = await resolve(original, "read"); return port ? observe(port, original) : { state: "unknown" }; },
    async readArchive(original: CreateRequest, id: string, generation: number): Promise<boolean> {
      original = validateCreate(original); const scope = fixed(original), port = await resolve(original, "read"); if (!port) return false;
      const receipt = await port.receipt(scope, id), snapshot = await port.snapshot(scope);
      return receipt?.type === "archive" && receipt.id === id && receipt.generation === generation && receipt.state === "acknowledged" && scopeKey(receipt.scope) === scopeKey(scope) && snapshot.phase === "stopped" && snapshot.generation === generation && scopeKey(snapshot.scope) === scopeKey(scope) && snapshot.archive?.id === id && snapshot.archive.state === "complete";
    },
  });
}


/** Catalog bridge for the actual default lifecycle service. The catalog owns
 * reservation/publication; workspace and native creation remain with the plugin. */
export function lifecycleCreationHost<Input extends import("zod").z.ZodType, Data extends import("zod").z.ZodType>(options: Readonly<{
  target: HostTarget;
  sessions: import("./plugin.js").DefaultLifecycleSessions<Input, Data>;
  workspace(original: CreateRequest): import("zod").z.output<Input>;
}>): Required<HostCreationPort> {
  const target = copy(options.target);
  const fixed = (value: CreateRequest): CreateRequest => { const original = validateCreate(value); if (canonical(original.target) !== canonical(target)) throw new CatalogError("FENCED"); return original; };
  const observe = async (value: CreateRequest): Promise<HostCreationStatus> => {
    const original = fixed(value), scope = sessionScope(original);
    let receipt; try { receipt = await options.sessions.original(scope, original.id); } catch { return { state: "unknown" }; }
    if (receipt?.state === "refused") return { state: "refused" };
    if (!receipt) return { state: "unknown" };
    const view = await options.sessions.view(scope), native = view.native;
    if (!native?.nativeSession || native.generation < 1) return { state: "unknown" };
    if (native.kind !== target.kind || native.placement !== target.placement) throw new CatalogError("FENCED");
    return { state: "created", binding: { nativeSession: native.nativeSession, generation: 1, kind: target.kind, placement: target.placement } };
  };
  return { target,
    create: async value => { const original = fixed(value); await options.sessions.create(sessionScope(original), original.id, options.workspace(original), original.selection); return observe(original); },
    createAdmitted: async value => { const original = fixed(value); await options.sessions.createAdmitted(sessionScope(original), original.id, options.workspace(original), original.selection); return {state: "pending"}; },
    read: observe,
    readArchive: (value, id, generation) => options.sessions.archived(sessionScope(fixed(value)), id, generation),
    watch: async (value, listener) => {
      const original = fixed(value); let active = true, reading = false, dirty = false;
      const changed = () => {
        dirty = true; if (!active || reading) return; reading = true;
        void (async () => { try { while (active && dirty) { dirty = false; const result = await observe(original); if (active) listener(result); } } catch { /* Exact original remains available; no dispatch. */ } finally { reading = false; } })();
      };
      const release = await options.sessions.watch(sessionScope(original), changed);
      return () => { active = false; dirty = false; release(); };
    },
  };
}
