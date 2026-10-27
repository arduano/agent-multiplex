import { createServer, type ServerResponse } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CatalogAuthority } from "../../v8-catalog/src/authority/index.js";
import { lifecycleCreationHost } from "../../v8-lifecycle-default/src/catalog.js";
import { GatewayCoordinator } from "../../v8-gateway/src/gateway/coordinator.js";
import { createGatewayHttpHandler } from "../../v8-gateway/src/http/server.js";
import { GatewayError, type GatewayTarget, type Identity } from "../../v8-gateway/src/contracts/types.js";
import { defaultLifecycle, existingDirectoryWorkspace, type AgentHost } from "../../v8-lifecycle-default/src/node.js";
import { defineHost, activateHost } from "../../v8-plugins/src/host.js";
import type { HostContext } from "../../v8-plugins/src/contracts.js";
import { codexHarnessRouter } from "../../v8-harness-codex/src/router.js";
import { copilotHarnessRouter } from "../../v8-harness-copilot/src/router.js";
import { createInProcessHostRpcPort } from "../../v8-gateway/src/node/in-process-host.js";
import type { SessionPort } from "../../v8-session/src/contracts/types.js";
import type { HostRpcTarget } from "../../v8-gateway/src/contracts/rpc.js";
import { scriptedHost, until } from "../../v8-host/qualification/fixture.js";
import { SessionError, scopeKey, type Receipt } from "../../v8-session/src/contracts/types.js";

/** Executable owned local application. Only its native driver is scripted.
 * Cookies/auth issuance here are disposable qualification configuration, not
 * production sign-in. No credential or native provider is read or forwarded. */
export async function startApplication(options: Readonly<{ directory: string; assets: string }>) {
  const scope = { connection: "local-v8", principal: "local-owner", authority: "local-catalog" };
  const identity: Identity = { connection: scope.connection, principal: scope.principal, authorities: [scope.authority], actions: ["read", "control", "catalogWrite", "fileWrite", "mcpRefresh"] };
  const coordinator = new GatewayCoordinator(), credential = randomBytes(32).toString("hex");
  const http = createGatewayHttpHandler(coordinator, async authorization => authorization === `Bearer ${credential}` ? identity : null);
  const hosts: { id: string; host: AgentHost; attached(): AgentHost | undefined; driver: ReturnType<typeof scriptedHost>; target: GatewayTarget; shutdown(): Promise<void>; terminate(): Promise<void>; diagnostics(): Promise<{ id: string; phase: string; issue?: string; nativeBound: boolean; create?: string; reason?: string }>; receipt(operation: string): Promise<Receipt | null> }[] = [];
  const hostRpcTargets: HostRpcTarget[] = [];
  let catalog: CatalogAuthority | undefined, closing: Promise<void> | undefined;
  const responses = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    responses.add(response); response.once('close', () => responses.delete(response));
    void (async () => {
    try {
      const address = server.address();
      const authority = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : null;
      // Check the bound loopback authority before issuing even a disposable
      // cookie. Host supplied by a rebinding browser is not an authority.
      if (!authority || request.headers.host !== authority || (request.headers.origin && request.headers.origin !== `http://${authority}`)) {
        response.writeHead(403).end(); return;
      }
      if (request.method === "GET" && ["/", "/client.js", "/style.css", "/configuration"].includes(request.url ?? "")) {
        const path = request.url!;
        response.setHeader("cache-control", "no-store"); response.setHeader("x-content-type-options", "nosniff");
        response.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        if (path === "/") response.setHeader("set-cookie", `v8_local=${credential}; HttpOnly; SameSite=Strict; Path=/`);
        if (path === "/configuration") {
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ scope, targets: hosts.map(value => value.target), hostRpcTargets })); return;
        }
        const name = path === "/" ? "index.html" : path.slice(1), bytes = await readFile(join(options.assets, name));
        response.writeHead(200, { "content-type": name.endsWith(".html") ? "text/html; charset=utf-8" : name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" }).end(bytes); return;
      }
      const cookie = request.headers.cookie?.split(";").some(value => value.trim() === `v8_local=${credential}`);
      if (!cookie) { response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "UNAUTHENTICATED" })); return; }
      // Same-origin local credential issuer supplies the exact verifier input;
      // caller headers cannot select another principal or owner.
      request.headers.authorization = `Bearer ${credential}`; http(request, response);
    } catch { if (!response.headersSent) response.writeHead(500).end(); else response.destroy(); }
  })(); });
  const close = (): Promise<void> => closing ??= (async () => {
    http.close(); coordinator.close(); server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const cleanup = await Promise.allSettled(hosts.map(async entry => {
      try { await entry.shutdown(); }
      catch (error) {
        // This executable owns scripted drivers only. Preserve the failed
        // checkpoint while releasing its exact mock and private writers.
        if (entry.driver.controller.current()) entry.driver.containment.halt();
        await entry.terminate(); throw error;
      }
    }));
    await catalog?.close();
    const failures = cleanup.flatMap(value => value.status === "rejected" ? [value.reason] : []);
    if (failures.length) throw new AggregateError(failures, "Owned application Host cleanup failed");
  })();
  try {
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    catalog = await CatalogAuthority.open({ directory: join(options.directory, "catalog"), scope });
    coordinator.registerCatalog({ scope, owner: "local-catalog-owner", port: catalog });
    for (const [id, kind] of [["main", "codex"], ["peer", "copilot"]] as const) {
      const target: GatewayTarget = { ...scope, host: `local-${kind}`, session: id, owner: `local-${kind}-owner`, routeEpoch: "local-route-1" };
      const sessionScope = { connection: scope.connection, principal: scope.principal, host: target.host, session: id };
      const cwd = join(options.directory, id, "workspace"); await mkdir(cwd, { recursive: true, mode: 0o700 });
      const driver = scriptedHost(kind, { cwd, model: "gpt-6-luna" });
      driver.onSend = (text, native) => {
        native.emitText(`Scripted response: ${text}\n`); native.emitTool("scripted terminal output\n");
        if (/\bconfirm\b/i.test(text)) void native.requestForm().then(() => native.complete("Tool confirmation returned."), () => {});
        else if (!native.holdWork) native.complete();
      };
      const route = { authority: target.authority, host: target.host, owner: target.owner, routeEpoch: target.routeEpoch };
      let attached: AgentHost | undefined;
      const localProof = Symbol("owned-local-host");
      const harness = { kind: "harness" as const, nativeKind: kind, protocol: driver.controller.protocol, identity: { id: `multiplex.scripted.${kind}`, version: 1, recordVersion: 1 }, capabilities: ["lifecycle.full-stop", "history.streaming"],
        async create() { return { controller: driver.controller }; } };
      const definition = defineHost({
        contract: { id: `multiplex.application.${kind}`, version: 1 }, harness,
        lifecycle: ({ harness }) => defaultLifecycle({ harness, workspace: existingDirectoryWorkspace(), directory: join(options.directory, id, "host"),
          policy: kind === "codex" ? { kind, provider: "copilot-only", access: { approval: "on-request", sandbox: "danger-full-access" } } : { kind, provider: "copilot-only", permissions: "manual" } }),
        harnessRouter: ({ sessions }) => kind === "codex" ? codexHarnessRouter({ sessions }) : copilotHarnessRouter({ sessions }),
      });
      const active = await activateHost(definition, { route, storage: null, authenticate: call => {
        const proof = call.proof as { token?: symbol; context?: HostContext } | null;
        return proof?.token === localProof ? proof.context ?? null : null;
      } });
      const owner = active.sessions;
      const agent = async () => attached ??= await owner.agent(sessionScope);
      // These legacy domain ports are thin delegations into the selected
      // plugin owner. No native/workspace lifecycle remains in this shell.
      const session: SessionPort = {
        snapshot: async scope => {
          if (scopeKey(scope) !== scopeKey(sessionScope)) throw new SessionError("FENCED");
          // This executable registers one logical session per Host before
          // Create. Its observer may arrive before allocation or the native
          // journal exists; that is temporary absence, not a stale identity.
          if (owner.hostData().sessionCount === 0) throw new GatewayError("UNAVAILABLE");
          const view = await owner.view(scope);
          if (!view.native) throw new GatewayError("UNAVAILABLE");
          return view.native;
        },
        submit: request => owner.submit(request), receipt: (scope, operation) => owner.original(scope, operation),
        read: async (run, request) => (await owner.session(run.scope)).read(run, request),
        subscribe: (scope, listener) => { let disposed = false, release: (() => void) | undefined;
          void owner.watch(scope, view => { if (!disposed && view.native) { void agent().catch(() => {}); listener(view.native); } }).then(value => { if (disposed) value(); else release = value; }).catch(() => {});
          return () => { disposed = true; release?.(); };
        },
        subscribeReceipt: (scope, operation, listener) => { let disposed = false, release: (() => void) | undefined;
          void owner.session(scope).then(port => { if (!disposed) release = port.subscribeReceipt(scope, operation, listener); }).catch(() => {});
          return () => { disposed = true; release?.(); };
        },
      };
      const rpcTarget: HostRpcTarget = { ...route, connection: scope.connection, principal: scope.principal }; hostRpcTargets.push(rpcTarget);
      coordinator.registerHostRpc({ target: rpcTarget, port: createInProcessHostRpcPort({ router: active.router, manifest: active.manifest,
        context: (identity, request) => active.context({ proof: { token: localProof, context: { identity: { connection: identity.connection, principal: identity.principal, actions: identity.actions }, route, ...(request.session ? { session: request.session } : {}) } }, expected: request.expected, ...(request.session ? { session: request.session } : {}) }),
        urgent: request => request.path === "lifecycle.submit" && (request.input as { command?: { type?: unknown } } | null)?.command?.type === "stop",
      }) });
      hosts.push({ id, get host() { if (!attached) throw new SessionError("FENCED"); return attached; }, attached: () => attached, driver, target,
        async shutdown() {
          try { const view = await owner.view(sessionScope); const snapshot = view.native;
            if (!snapshot || snapshot.phase !== "stopped") await owner.submit({ scope: sessionScope, id: `owned-demo-close-${snapshot?.generation ?? 0}`, generation: snapshot?.generation ?? 0, command: { type: "stop" } });
          } catch (error) { if (!(error instanceof SessionError) || error.code !== "FENCED") throw error; }
          await until(async () => (await active.readiness()).ready, 30000); await active.close();
        }, terminate: () => owner.terminate(),
        async diagnostics() {
          try { const view = await owner.view(sessionScope), original = await owner.original(sessionScope, `create-${id}`);
            return { id, phase: view.native?.phase ?? view.phase, ...(view.native?.issue ? { issue: view.native.issue } : {}), nativeBound: !!view.native?.nativeSession, ...(original ? { create: original.state } : {}), ...(original?.reason ? { reason: original.reason } : {}) };
          } catch (error) { if (error instanceof SessionError && error.code === "FENCED") return { id, phase: "uncreated", nativeBound: false }; throw error; }
        },
        receipt: operation => owner.original(sessionScope, operation),
      });
      coordinator.register({ target, session, history: {
        async *watch(scope, cursor) { yield* (await agent()).history.watch(scope, cursor); },
        older: async (scope, cursor, generation) => (await agent()).history.older(scope, cursor, generation),
        recover: async (scope, observation) => (await agent()).history.recover(scope, observation),
        authorize: async (scope, observation) => (await agent()).history.authorize(scope, observation),
      }, binding: async () => { try { return (await agent()).binding(); } catch (error) { if (error instanceof SessionError && error.code === "FENCED") return null; throw error; } },
        controlCatalog: () => driver.controller.catalog(),
        interactions: { snapshot: async scope => (await agent()).interactions.snapshot(scope), subscribe: (scope, listener) => { if (!attached) throw new SessionError("FENCED"); return attached.interactions.subscribe(scope, listener); } },
        mcp: { snapshot: async run => (await agent()).mcp.snapshot(run), refresh: async (run, observation) => (await agent()).mcp.refresh(run, observation), subscribe: (run, listener) => { if (!attached) throw new SessionError("FENCED"); return attached.mcp.subscribe(run, listener); } },
        files: { port: { call: async (method, input) => (await agent()).files.call(method, input) }, scope: () => attached?.fileScope() ?? null },
        authorizeHistory: native => {
          if (native.origin.connection !== scope.connection || native.origin.principal !== scope.principal || native.origin.host !== target.host || !attached) return false;
          try { attached.history.snapshot(native); return true; } catch { return false; }
        } });
      catalog.register(lifecycleCreationHost({ target: { host: target.host, owner: target.owner, kind, placement: "dedicated" }, sessions: owner,
        workspace: original => { if (original.session !== id) throw new SessionError("FENCED"); return { cwd: original.metadata.cwd ?? cwd }; } }));
    }
    server.requestTimeout = 10000; server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { url, close, revoke: () => http.revoke(scope),
      interruptObservation: () => { for (const response of responses) if (response.getHeader('content-type') === 'application/x-ndjson') response.destroy(); },
      stats: () => hosts.map(({ id, driver }) => ({ id, ...driver.counts })),
      diagnostics: () => Promise.all(hosts.map(entry => entry.diagnostics())),
      driver: (id: "main" | "peer") => hosts.find(value => value.id === id)!.driver,
      subscribeReceipt: (id: "main" | "peer", operationId: string, listener: (receipt: Receipt) => void) => {
        const owned = hosts.find(value => value.id === id)!;
        return owned.host.session.subscribeReceipt(owned.target, operationId, listener);
      },
      receipt: (id: "main" | "peer", operationId: string) => {
        const owned = hosts.find(value => value.id === id)!;
        return owned.receipt(operationId);
      },
    };
  } catch (error) { await close(); throw error; }
}
