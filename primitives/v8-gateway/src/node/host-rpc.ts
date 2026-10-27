import { getUntypedClient } from '@trpc/client';
import type { AnyRouter } from '@trpc/server';
import { p2pRpcContext, type Peer } from '@arduano/p2prpc-core';
import type { HostManifest } from '../../../v8-plugins/src/contracts.js';
import type { Identity } from '../contracts/types.js';
import type { HostRpcCall, HostRpcPort, HostRpcRequest } from '../contracts/rpc.js';
import { observePeer } from './peer-observer.js';
import { HOST_PROOF_HEADER } from './host-proof.js';

/** Version-coupled tRPC dispatch is isolated here; the Host remains the sole router. */
export function createP2pHostRpcPort<Router extends AnyRouter>(options: Readonly<{
  peer: Peer<Router>; manifest: HostManifest;
  forwardProof(identity: Identity, request: HostRpcRequest, type: 'query' | 'mutation' | 'subscription'): Promise<string>;
  urgent?: (request: HostRpcCall) => boolean;
}>): HostRpcPort {
  const rpc = getUntypedClient(options.peer.rpc);
  return Object.freeze({
    manifest: structuredClone(options.manifest),
    ...(options.urgent ? { urgent: options.urgent } : {}),
    async call(identity: Identity, request: HostRpcCall) {
      const authorization = await options.forwardProof(identity, request, request.type);
      // No observer abort signal reaches raw setup or releases its physical capacity.
      const context = p2pRpcContext({ [HOST_PROOF_HEADER]: authorization });
      return request.type === 'query'
        ? rpc.query(request.path, request.input, { context })
        : rpc.mutation(request.path, request.input, { context });
    },
    async *watch(identity: Identity, request: HostRpcRequest, signal: AbortSignal) {
      const authorization = await options.forwardProof(identity, request, 'subscription');
      yield* observePeer<unknown>(observer => rpc.subscription(request.path, request.input,
        { ...observer, context: p2pRpcContext({ [HOST_PROOF_HEADER]: authorization }) }), signal);
    },
  });
}
