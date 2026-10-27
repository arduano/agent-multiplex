import { callTRPCProcedure, type AnyRouter } from '@trpc/server';
import type { HostContext, HostManifest } from '../../../v8-plugins/src/contracts.js';
import type { Identity } from '../contracts/types.js';
import type { HostRpcCall, HostRpcPort, HostRpcRequest } from '../contracts/rpc.js';

/** Trusted local composition uses the same actual router and schemas as Peer
 * dispatch. It does not publish an unauthenticated local HTTP bypass. */
export function createInProcessHostRpcPort<Router extends AnyRouter>(options: Readonly<{
  router: Router; manifest: HostManifest;
  context(identity: Identity, request: HostRpcRequest, type: 'query' | 'mutation' | 'subscription'): Promise<HostContext>;
  urgent?: (request: HostRpcCall) => boolean;
}>): HostRpcPort {
  const invoke = async (identity: Identity, request: HostRpcRequest, type: 'query' | 'mutation' | 'subscription', signal?: AbortSignal) =>
    callTRPCProcedure({ router: options.router, path: request.path, type, ctx: await options.context(identity, request, type),
      getRawInput: async () => request.input, signal, batchIndex: 0 });
  return Object.freeze({ manifest: structuredClone(options.manifest), ...(options.urgent ? { urgent: options.urgent } : {}),
    call: (identity: Identity, request: HostRpcCall) => invoke(identity, request, request.type),
    async *watch(identity: Identity, request: HostRpcRequest, signal: AbortSignal) {
      const source = await invoke(identity, request, 'subscription', signal);
      if (!source || typeof source !== 'object' || !(Symbol.asyncIterator in source)) throw new TypeError('Host subscription must be an AsyncIterable');
      yield* source as AsyncIterable<unknown>;
    },
  });
}
