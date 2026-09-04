import type { AnyTRPCRouter } from "@trpc/server";

import {
  HostCatalog,
  HostService,
} from "@agent-multiplex/host-core";
import type {
  HostAttachmentRequest,
  HostLinkFence,
  MetadataOperationRecord,
} from "@agent-multiplex/protocol";
import {
  parentHostConnectionFromPeer,
  type MultiplexP2PNode,
  type P2PParentHostConnection,
  type PinnedPeerTarget,
  type ReconnectableMetadataUpstream,
} from "@agent-multiplex/transport-p2prpc";

export interface ParentSupervisorOptions {
  readonly node: MultiplexP2PNode<AnyTRPCRouter, AnyTRPCRouter>;
  readonly target: PinnedPeerTarget;
  readonly catalog: HostCatalog;
  readonly service: HostService;
  readonly metadataUpstream: ReconnectableMetadataUpstream;
  readonly heartbeatMs: number;
  readonly reconnectMaxMs: number;
  readonly signal: AbortSignal;
  readonly onConnected?: (parentHostId: string) => void;
  readonly onDisconnected?: (error: unknown, retryMs: number) => void;
}

/**
 * Maintain this host's one outbound parent attachment. Losing transport only
 * withdraws the live metadata port; the catalog attachment and authority are
 * intentionally retained.
 */
export async function superviseParentHost(
  options: ParentSupervisorOptions,
): Promise<void> {
  let target = snapshotTarget(options.target);
  let attempt = 0;
  let attachedOnce = false;
  while (!options.signal.aborted) {
    let connection: P2PParentHostConnection | undefined;
    try {
      const local = options.catalog.localHost();
      // A successful local promotion/force-adoption clears the attachment.
      // Do not let a still-running supervisor silently undo that explicit
      // topology action by attaching to its stale configured parent again.
      if (attachedOnce && local.parentHostId === null) return;
      const peer = await options.node.connectAs<AnyTRPCRouter>(target);
      connection = parentHostConnectionFromPeer(peer, {
        hostId: local.hostId,
        hostBootId: local.hostBootId,
        currentAttachment: () => {
          const attached = options.catalog.localHost();
          if (attached.attachmentId === null) {
            throw new Error("parent attachment has not been assigned");
          }
          return {
            attachmentId: attached.attachmentId,
            lineageId: attached.lineageId,
          };
        },
      });

      const result = await connection.attach(attachmentRequest(options.catalog));
      if (!result.accepted) throw new Error("parent rejected host attachment");
      if (result.attachment.childHostId !== local.hostId) {
        throw new Error("parent returned an attachment for another child host");
      }
      if (result.canonical.hostId !== local.hostId) {
        throw new Error("parent returned another host as the canonical child");
      }

      options.service.applyParentAttachment(result.attachment);
      attachedOnce = true;
      options.catalog.enrollPeer(
        target.endpointId,
        "parentHost",
        result.attachment.parentHostId,
      );
      options.metadataUpstream.attach(connection);

      // The first heartbeat is the readiness barrier: only after the child has
      // applied the attachment and enrolled its parent may the parent invoke
      // reverse `link.*` snapshot/event RPCs.
      target = await heartbeat(
        connection,
        target,
        options.catalog,
      );
      await flushQueuedMetadata(connection, options);
      options.onConnected?.(result.attachment.parentHostId);
      attempt = 0;

      while (!options.signal.aborted) {
        await abortableDelay(options.heartbeatMs, options.signal);
        if (options.signal.aborted) break;
        target = await heartbeat(connection, target, options.catalog);
        await flushQueuedMetadata(connection, options);
      }
    } catch (error) {
      if (options.signal.aborted) return;
      const retryMs = reconnectDelay(attempt++, options.reconnectMaxMs);
      options.onDisconnected?.(error, retryMs);
      await abortableDelay(retryMs, options.signal);
    } finally {
      options.metadataUpstream.detach(connection);
    }
  }
}

function attachmentRequest(catalog: HostCatalog): HostAttachmentRequest {
  const local = catalog.localHost();
  return {
    hostId: local.hostId,
    hostBootId: local.hostBootId,
    feedId: local.feedId,
    name: local.name,
    ...(local.endpointId === undefined ? {} : { endpointId: local.endpointId }),
    protocolVersion: 2,
    capabilities: local.capabilities,
    ...(local.parentHostId === null
      ? {}
      : { expectedParentHostId: local.parentHostId }),
    ...(local.attachmentId === null
      ? {}
      : {
          previousAttachmentId: local.attachmentId,
          previousLineageId: local.lineageId,
        }),
  };
}

async function heartbeat(
  connection: P2PParentHostConnection,
  target: PinnedPeerTarget,
  catalog: HostCatalog,
): Promise<PinnedPeerTarget> {
  const response = await connection.heartbeat(catalog.feedCheckpoint());
  if (!response.accepted) {
    throw new Error("parent rejected this host attachment epoch");
  }
  return response.p2pTicket === undefined
    ? target
    : snapshotTarget({
        endpointId: target.endpointId,
        locator: { kind: "ticket", ticket: response.p2pTicket },
      });
}

async function flushQueuedMetadata(
  connection: P2PParentHostConnection,
  options: ParentSupervisorOptions,
): Promise<void> {
  const queued = options.catalog.listMetadataOperations({
    status: "queued",
    limit: 1_000,
  });
  if (queued.length === 0) return;
  const results = await connection.pushMetadataOutbox(queued);
  const byId = new Map(results.map((result) => [result.operationId, result]));
  for (const pending of queued) {
    const result = byId.get(pending.operationId);
    if (!result) {
      throw new Error(
        `parent omitted metadata operation ${pending.operationId} from its acknowledgement`,
      );
    }
    applyMetadataResult(options, result);
  }
}

function applyMetadataResult(
  options: ParentSupervisorOptions,
  operation: MetadataOperationRecord,
): void {
  if (operation.status === "queued") return;
  const local = options.catalog.localHost();
  if (local.parentHostId === null || local.attachmentId === null) {
    throw new Error("cannot settle parent metadata without an active attachment");
  }
  const fence: HostLinkFence = {
    hostId: local.hostId,
    hostBootId: local.hostBootId,
    attachmentId: local.attachmentId,
    lineageId: local.lineageId,
  };
  options.service.applyMetadataFromParent(
    { ...fence, operation },
    {
      authenticatedHostId: local.parentHostId,
      endpointId: options.target.endpointId,
    },
  );
}

function reconnectDelay(attempt: number, maximum: number): number {
  const exponential = Math.min(maximum, 250 * 2 ** Math.min(attempt, 16));
  return Math.max(1, Math.round(exponential * (0.8 + Math.random() * 0.4)));
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    }
  });
}

function snapshotTarget(target: PinnedPeerTarget): PinnedPeerTarget {
  const locator = target.locator.kind === "ticket"
    ? Object.freeze({ kind: "ticket" as const, ticket: target.locator.ticket })
    : target.locator.kind === "mdns"
      ? Object.freeze({
          kind: "mdns" as const,
          ...(target.locator.serviceName === undefined
            ? {}
            : { serviceName: target.locator.serviceName }),
        })
      : Object.freeze({ kind: "dns" as const });
  return Object.freeze({ endpointId: target.endpointId, locator });
}
