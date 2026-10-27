import { createTRPCClient, TRPCClientError, type TRPCLink, type TRPCClient } from '@trpc/client';
import type { AnyRouter } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import type { HostRpcCall, HostRpcExpected, HostRpcRequest, HostRpcTarget, RpcResult } from '../contracts/rpc.js';
import { hostRpcExpected, rpcFault } from '../contracts/rpc.js';

export interface HostRpcTransport {
  rpcCall(request: HostRpcCall): Promise<RpcResult>;
  rpcWatch(request: HostRpcRequest, signal: AbortSignal, onStarted?: () => void): AsyncIterable<RpcResult>;
}

/** One app-selected router type; remote identity and version are checked by the route. */
export function gatewayLink<Router extends AnyRouter>(options: Readonly<{
  transport: HostRpcTransport; target: HostRpcTarget; expected: HostRpcExpected;
  session?: Readonly<{ id: string; generation: number }>;
}>): TRPCLink<Router> {
  const bound = structuredClone({ target: options.target, expected: hostRpcExpected(options.expected),
    ...(options.session ? { session: options.session } : {}) });
  return () => ({ op }) => observable(observer => {
    const controller = new AbortController();
    const abort = () => { controller.abort(); observer.complete(); };
    op.signal?.addEventListener('abort', abort, { once: true });
    if (op.signal?.aborted) abort();
    const request: HostRpcRequest = { ...bound, path: op.path, ...(op.input === undefined ? {} : { input: op.input }) };
    const error = (failure: unknown) => {
      if (controller.signal.aborted) return;
      const safe = rpcFault(failure);
      observer.error(TRPCClientError.from<Router>({ error: { message: safe.message, code: -32603, data: { code: safe.code } } }));
      controller.abort();
    };
    const emit = (result: RpcResult) => {
      if (controller.signal.aborted) return;
      if (!result.ok) { error({ code: result.error.code }); return; }
      observer.next({ result: { type: 'data', data: result.value } });
    };
    void (async () => {
      try {
        if (controller.signal.aborted) return;
        if (op.type === 'subscription') {
          for await (const result of options.transport.rpcWatch(request, controller.signal,
            () => { if (!controller.signal.aborted) observer.next({ result: { type: 'started' } }); })) emit(result);
        } else emit(await options.transport.rpcCall({ ...request, type: op.type }));
        if (!controller.signal.aborted) observer.complete();
      } catch (failure) { error(failure); }
    })();
    // Local cancellation only. Admitted server/Peer work retains its existing owner.
    return () => { op.signal?.removeEventListener('abort', abort); controller.abort(); };
  });
}

export function createGatewayHostClient<Router extends AnyRouter>(options: Parameters<typeof gatewayLink<Router>>[0]): TRPCClient<Router> {
  return createTRPCClient<Router>({ links: [gatewayLink<Router>(options)] });
}
