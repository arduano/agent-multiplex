import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { activateHost, defineHost, hostProcedure, hostRouter, originalMutation } from '../../v8-plugins/src/index.js';
import { ViewerQueue } from '../src/contracts/queue.js';
import { createHmacHostProof, authenticateHostProof } from '../src/node/host-proof.js';
import { createInProcessHostRpcPort } from '../src/node/in-process-host.js';
import { GatewayCoordinator } from '../src/gateway/coordinator.js';
import { listenLoopback } from '../src/http/server.js';
import { HttpGatewayTransport } from '../src/client/http.js';
import { createGatewayHostClient } from '../src/client/rpc.js';
import type { HostRouter } from '../../v8-plugins/src/host.js';
import { hostRpcExpected, type HostRpcCall, type HostRpcRequest } from '../src/contracts/rpc.js';
import { alice, target, deferred } from './fixture.js';

/** Scripted domain owner, distinct from the actual lifecycle/native journals.
 * It proves routing/delegation only, not process restart durability. */
export function pluginDefinition() {
  const original = new Map<string, { id: string; label: string }>(), watchers = new Set<ViewerQueue<{ directory: string; revision: number }>>();
  let effects = 0, revision = 1, subscriptions = 0, gate: ReturnType<typeof deferred<void>> | undefined;
  const definition = defineHost({ contract: { id: 'fixture.plugins', version: 1 },
    harness: { kind: 'harness', identity: { id: 'fixture.codex', version: 1, recordVersion: 1 }, nativeKind: 'codex', capabilities: [] } as const,
    lifecycle: () => ({ kind: 'lifecycle' as const, identity: { id: 'fixture.lifecycle', version: 1, recordVersion: 1 }, capabilities: [],
      createInput: z.object({ path: z.string() }), public: { host: z.object({ allocation: z.literal('existing') }), session: z.object({ directory: z.string() }) },
      open: () => ({ sessions: {}, router: hostRouter({ stopped: hostProcedure.query(() => true) }), readiness: () => ({ ready: true as const }), close() {} }) }),
    extensions: () => ({ workspace: { identity: { id: 'fixture.workspace', version: 1, recordVersion: 1 },
      public: { host: z.object({ quota: z.number() }), session: z.object({ branch: z.string() }) },
      router: hostRouter({
        inspect: hostProcedure.input(z.object({ prefix: z.string() }).optional()).query(({ input }) => ({ directory: `${input?.prefix ?? ''}directory`, bytes: 42 })),
        privateFailure: hostProcedure.query(() => { throw Error('private secret must never cross wire'); }),
        claim: originalMutation({ input: z.object({ label: z.string().min(1) }).strict(), output: z.object({ id: z.string(), label: z.string() }).strict(), owner: {
          async submit(_ctx, request) {
            const old = original.get(request.id); if (old) { if (old.label !== request.input.label) throw Error('conflict'); return old; }
            effects++; const value = { id: request.id, label: request.input.label }; original.set(request.id, value);
            await gate?.promise; return value;
          }, original(_ctx, id) { return original.get(id) ?? null; },
        } }),
        watch: hostProcedure.subscription(async function* ({ signal }) {
          const queue = new ViewerQueue<{ directory: string; revision: number }>(8, 65536); watchers.add(queue); subscriptions++;
          const abort = () => { void queue.return(); }; signal?.addEventListener('abort', abort, { once: true });
          try { queue.push({ directory: 'directory', revision }); if (signal?.aborted) abort(); yield* queue; }
          finally { signal?.removeEventListener('abort', abort); await queue.return(); watchers.delete(queue); }
        }),
      }), readiness: () => ({ ready: true as const }), close() { for (const queue of watchers) queue.finish(); },
    } }),
  });
  return { definition, stats: () => ({ effects, subscriptions, watchers: watchers.size }),
    emit() { revision++; for (const queue of watchers) queue.push({ directory: 'directory', revision }); },
    hold() { gate = deferred<void>(); return gate; },
  };
}
export async function rpcFixture(options: { fetch?: typeof fetch; limits?: ConstructorParameters<typeof GatewayCoordinator>[0] } = {}) {
  const domain = pluginDefinition(), proof = createHmacHostProof({ issuer: 'gateway', audience: 'host', secret: randomBytes(32) });
  const { session: _session, ...hostTarget } = target;
  const host = await activateHost(domain.definition, { route: hostTarget, storage: {}, authenticate: authenticateHostProof(proof) });
  const context = (identity: typeof alice, request: HostRpcRequest, type: 'query' | 'mutation' | 'subscription') => host.context({
    proof: { authorization: proof.issue(identity, request, type), path: request.path, type }, expected: request.expected,
    ...(request.session ? { session: request.session } : {}),
  });
  const port = createInProcessHostRpcPort({ router: host.router, manifest: host.manifest, context,
    urgent: (request: HostRpcCall) => request.path === 'extensions.workspace.claim.submit' && (request.input as { id?: string } | undefined)?.id === 'trusted-urgent-fixture',
  });
  const coordinator = new GatewayCoordinator(options.limits); coordinator.registerHostRpc({ target: hostTarget, port });
  const server = await listenLoopback(coordinator, async value => value === 'Bearer fixture-alice' ? alice : null);
  const transport = new HttpGatewayTransport({ url: server.url, authorization: 'Bearer fixture-alice', ...(options.fetch ? { fetch: options.fetch } : {}) });
  const client = createGatewayHostClient<HostRouter<typeof domain.definition>>({ transport, target: hostTarget, expected: host.manifest });
  return { ...domain, host, proof, context, port, target: hostTarget, coordinator, server, transport, client,
    request(path: string, input?: unknown): HostRpcRequest { return { target: hostTarget, expected: hostRpcExpected(host.manifest), path, ...(input === undefined ? {} : { input }) }; },
    async close() { transport.close(); coordinator.close(); await server.close(); await host.close(); proof.revoke(); },
  };
}
