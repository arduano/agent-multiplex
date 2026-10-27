import type { z } from "zod";
import { GatewayError, type GatewayTarget, type SessionRoute } from "../../v8-gateway/src/contracts/types.js";
import { scopeKey, type Catalog, type Receipt, type SessionScope, type SessionPort } from "../../v8-session/src/contracts/types.js";
import type { Scope as HistoryScope } from "../../v8-history/src/contracts/types.js";
import type { AgentHost } from "./assembly.js";
import type { DefaultLifecycleSessions } from "./plugin.js";

/** This installed lifecycle forwards the complete standard port. Generic
 * SessionRoute/SessionPort still permit other lifecycles to omit capabilities. */
export type DefaultLifecycleRoute = SessionRoute & Required<Pick<SessionRoute, 'binding' | 'controlCatalog' | 'interactions' | 'mcp' | 'files'>> & {
  session: Required<SessionPort>;
  history: Required<SessionRoute['history']>;
  close(): void;
};

/** Routing glue only. The selected lifecycle retains every original, native
 * owner and read exception. Closing a route releases observers, never agents. */
export function lifecycleSessionRoute<Input extends z.ZodType, Data extends z.ZodType>(options: Readonly<{
  sessions: DefaultLifecycleSessions<Input, Data>;
  target: GatewayTarget;
  controlCatalog: () => Promise<Catalog>;
}>): DefaultLifecycleRoute {
  const { sessions } = options, target = Object.freeze({ ...options.target });
  const scope: SessionScope = { connection: target.connection, principal: target.principal, host: target.host, session: target.session };
  const context = { route: { authority: target.authority, host: target.host, owner: target.owner, routeEpoch: target.routeEpoch }, identity: { connection: scope.connection, principal: scope.principal, actions: [] } };
  const observers = new Set<() => void>();
  let closed = false;
  const active = () => { if (closed) throw new GatewayError("CLOSED"); };
  const exact = (value: SessionScope) => { active(); if (scopeKey(value) !== scopeKey(scope)) throw new GatewayError("FENCED"); };
  const historyScope = (value: HistoryScope) => {
    active(); const origin = value.origin;
    if (origin.connection !== scope.connection || origin.principal !== scope.principal || origin.host !== scope.host) throw new GatewayError("FENCED");
  };
  const present = () => { active(); if (!sessions.list(context).some(value => value.id === scope.session)) throw new GatewayError("UNAVAILABLE"); };
  // The existing registry proves absence without interpreting a native owner's
  // FENCED error. A cold explicit snapshot may inspect existing custody only.
  const snapshot = async () => {
    present(); const { native } = await sessions.view(scope); active();
    if (!native) throw new GatewayError("UNAVAILABLE");
    return native;
  };
  const agent = async () => {
    active(); const existing = sessions.attached(scope); if (existing) return existing;
    await snapshot(); active(); return sessions.agent(scope);
  };
  const historyAgent = async (value: HistoryScope) => {
    historyScope(value); const native = await snapshot();
    if (value.origin.nativeSession !== native.nativeSession || value.kind !== native.kind) throw new GatewayError("FENCED");
    return agent();
  };
  // Late registration after observer cancellation must immediately release its
  // lease. Neither cancellation nor a failed registration retires actual work.
  const observe = (start: (keep: (release: () => void) => void, live: () => boolean) => Promise<void>) => {
    active(); const releases = new Set<() => void>(); let stopped = false;
    const stop = () => { if (stopped) return; stopped = true; observers.delete(stop); for (const release of releases) release(); releases.clear(); };
    const keep = (release: () => void) => { if (stopped) release(); else releases.add(release); };
    observers.add(stop); void start(keep, () => !stopped).catch(stop); return stop;
  };
  const nativeObserver = (attach: (host: AgentHost, live: () => boolean) => () => void) => observe(async (keep, live) => {
    let opening = false;
    keep(await sessions.watch(scope, view => {
      if (!live() || !view.native || opening) return; opening = true;
      void agent().then(host => { if (live()) keep(attach(host, live)); }).catch(() => {});
    }));
  });

  return {
    target,
    session: {
      snapshot: value => { exact(value); return snapshot(); },
      submit: request => { exact(request.scope); return sessions.submit(request); },
      receipt: (value, id) => { exact(value); present(); return sessions.original(value, id); },
      read: async (run, request) => { exact(run.scope); present(); return (await sessions.session(run.scope)).read(run, request); },
      mcpLoginLink: async (run, originalId) => { exact(run.scope); present(); return (await sessions.session(run.scope)).mcpLoginLink(run, originalId); },
      subscribe: (value, listener) => { exact(value); return observe(async (keep, live) => {
        keep(await sessions.watch(scope, view => { if (live() && view.native) listener(view.native); }));
      }); },
      subscribeReceipt: (value, id, listener) => {
        exact(value);
        return observe(async (keep, live) => {
          let opened = false;
          const publish = (receipt: Receipt | null) => { if (live() && receipt) listener(receipt); };
          keep(await sessions.watch(scope, view => {
            if (!live()) return;
            if (view.native && !opened) {
              opened = true;
              void sessions.session(scope).then(port => {
                if (!live()) return;
                keep(port.subscribeReceipt(scope, id, publish));
                // Register first, then read the same original to close the join.
                return sessions.original(scope, id).then(publish);
              }).catch(() => {});
            } else if (!opened) void sessions.original(scope, id).then(publish).catch(() => {});
          }));
        });
      },
    },
    history: {
      scopes: async () => (await agent()).history.scopes(),
      watch(value, cursor) {
        active(); let source: ReturnType<AgentHost["history"]["watch"]> | undefined, retiring: Promise<unknown> | undefined, stopped = false;
        const stop = () => {
          stopped = true; observers.delete(stop);
          if (source && !retiring) { retiring = source.return(); void retiring.catch(() => {}); }
        };
        observers.add(stop);
        const stream = (async function* () {
          try {
            historyScope(value); if (stopped) return;
            const host = await historyAgent(value); if (stopped) return;
            active(); source = host.history.watch(value, cursor); if (stopped) return;
            for await (const frame of source) { if (stopped) return; yield frame; }
          } catch (error) { if (!stopped) throw error;
          } finally { stop(); await retiring; }
        })();
        // An async generator queues return behind its pending next. Release
        // the actual Hub subscription first so a quiet next can finish.
        return { [Symbol.asyncIterator]() { return this; }, next: () => stream.next(),
          return: value => { stop(); return stream.return(value); },
          throw: error => { stop(); return stream.throw(error); } };
      },
      older: async (value, cursor, generation) => (await historyAgent(value)).history.older(value, cursor, generation),
      recover: async (value, observation) => (await historyAgent(value)).history.recover(value, observation),
      authorize: async (value, observation) => (await historyAgent(value)).history.authorize(value, observation),
    },
    binding: async () => (await agent()).binding(),
    controlCatalog: () => { active(); return options.controlCatalog(); },
    interactions: {
      snapshot: async value => { exact(value); return (await agent()).interactions.snapshot(value); },
      subscribe: (value, listener) => { exact(value); return nativeObserver((host, live) => host.interactions.subscribe(value, state => { if (live()) listener(state); })); },
    },
    mcp: {
      snapshot: async run => { exact(run.scope); return (await agent()).mcp.snapshot(run); },
      refresh: async (run, observation) => { exact(run.scope); return (await agent()).mcp.refresh(run, observation); },
      subscribe: (run, listener) => { exact(run.scope); return nativeObserver((host, live) => host.mcp.subscribe(run, state => { if (live()) listener(state); })); },
    },
    files: {
      port: { call: async (method, input) => {
        active(); const value = input.scope;
        if (value.connection !== scope.connection || value.principal !== scope.principal || value.host !== scope.host) throw new GatewayError("FENCED");
        const native = await snapshot(); if (value.session !== native.nativeSession) throw new GatewayError("FENCED");
        return (await agent()).files.call(method, input);
      } },
      scope: () => { active(); return sessions.attached(scope)?.fileScope() ?? null; },
    },
    authorizeHistory: value => {
      historyScope(value); const host = sessions.attached(scope); if (!host) return false;
      try { host.history.snapshot(value); return true; } catch { return false; }
    },
    close: () => { if (closed) return; closed = true; for (const stop of [...observers]) stop(); },
  };
}
