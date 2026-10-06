import type { AnyTRPCRouter } from "@trpc/server";

import type {
  ControlNodeCatalog,
  ControlNodeService,
} from "@arduano/agent-multiplex-control-node-core";
import type { ControlNodeAttachmentRequest } from "@arduano/agent-multiplex-protocol";
import {
  parentControlNodeConnectionFromPeer,
  type MultiplexP2PNode,
  type P2PParentControlNodeConnection,
  type ReconnectableMetadataUpstream,
} from "@arduano/agent-multiplex-transport-p2prpc";

import {
  parseDesiredControlNodeUpstream,
  type DesiredControlNodeUpstream,
} from "./config.js";

export interface UpstreamSupervisorOptions {
  readonly node: MultiplexP2PNode<AnyTRPCRouter, AnyTRPCRouter>;
  readonly initialUpstream: DesiredControlNodeUpstream;
  /** Reachability fallback only; both identities must match durable desired state. */
  readonly bootstrapUpstream?: DesiredControlNodeUpstream;
  readonly catalog: ControlNodeCatalog;
  readonly service: ControlNodeService;
  readonly metadataUpstream: ReconnectableMetadataUpstream;
  readonly heartbeatMs: number;
  readonly reconnectMaxMs: number;
  readonly signal: AbortSignal;
  readonly onConnected?: (parentControlNodeId: string) => void;
  readonly onDisconnected?: (error: unknown, retryMs: number) => void;
}

/**
 * Maintains one explicit tree edge. Transport loss only removes the live
 * upstream port; it never changes the durable role or promotes this branch.
 */
export async function superviseUpstreamControlNode(
  options: UpstreamSupervisorOptions,
): Promise<void> {
  let desired = snapshotUpstream(options.initialUpstream);
  const bootstrap = options.bootstrapUpstream === undefined
    ? undefined : snapshotUpstream(options.bootstrapUpstream);
  let attempt = 0;
  while (!options.signal.aborted) {
    let connection: P2PParentControlNodeConnection | undefined;
    try {
      const configured = readDesiredUpstream(options.catalog);
      if (!configured || !sameUpstreamIdentity(configured, desired)) return;
      desired = snapshotUpstream(configured);

      const local = options.catalog.localControlNode();
      if (
        local.dataRole.role === "branch" &&
        local.dataRole.branch.lifecycle === "detached"
      ) return;
      if (
        local.dataRole.role === "branch" &&
        local.dataRole.branch.lifecycle === "attached" &&
        local.dataRole.branch.parentControlNodeId !== desired.controlNodeId
      ) {
        throw new Error(
          "persisted desired upstream does not match the active parent attachment",
        );
      }

      const connect = (upstream: DesiredControlNodeUpstream) =>
        options.node.connectAs<AnyTRPCRouter>({
          endpointId: upstream.endpointId,
          locator: upstream.locator,
        });
      let peer;
      try {
        peer = await connect(desired);
      } catch (error) {
        // An environment value never selects a parent. It may only locate the
        // already selected logical and transport identity after its saved
        // locator fails. Authentication and ticket validation remain transport-owned.
        const current = selectedUpstream(options.catalog, desired, options.signal);
        if (!current) return;
        if (!sameUpstreamSelection(current, desired)) continue;
        if (!bootstrap || !sameUpstreamIdentity(bootstrap, desired) ||
          sameUpstreamSelection(bootstrap, desired)) throw error;
        peer = await connect(bootstrap);
      }
      const afterConnect = selectedUpstream(options.catalog, desired, options.signal);
      if (!afterConnect) return;
      if (!sameUpstreamSelection(afterConnect, desired)) continue;
      connection = parentControlNodeConnectionFromPeer(peer, {
        controlNodeId: local.controlNodeId,
        controlNodeBootId: local.controlNodeBootId,
        currentAttachment: () => {
          const role = options.catalog.dataRole();
          if (role.role !== "branch" || role.branch.lifecycle !== "attached") {
            throw new Error("upstream attachment is no longer active");
          }
          return {
            attachmentId: role.branch.attachmentId,
            lineageId: role.branch.lineageId,
          };
        },
      });

      const result = await connection.attach(
        attachmentRequest(options.catalog, desired),
      );
      if (!result.accepted) throw new Error("upstream rejected attachment");
      if (
        result.attachment.childControlNodeId !== local.controlNodeId ||
        result.canonical.controlNodeId !== local.controlNodeId ||
        result.canonical.controlNodeBootId !== local.controlNodeBootId
      ) {
        throw new Error("upstream returned an attachment for another branch boot");
      }
      if (result.attachment.parentControlNodeId !== desired.controlNodeId) {
        throw new Error("upstream logical identity does not match the configured pin");
      }
      const afterAttach = selectedUpstream(options.catalog, desired, options.signal);
      if (!afterAttach) return;
      if (!sameUpstreamSelection(afterAttach, desired)) continue;

      options.catalog.applyParentAttachment(
        result.attachment,
        desired.endpointId,
      );
      options.metadataUpstream.attach(connection);

      // Readiness barrier: the parent can only pull the reverse subtree after
      // this child has durably committed its attachment and parent enrollment.
      desired = await heartbeat(connection, desired, options.catalog);
      const afterHeartbeat = selectedUpstream(options.catalog, desired, options.signal);
      if (!afterHeartbeat) return;
      if (!sameUpstreamSelection(afterHeartbeat, desired)) continue;
      await options.service.flushMetadataOutbox();
      await options.service.flushMetadataDeliveries();
      options.onConnected?.(desired.controlNodeId);
      attempt = 0;

      while (!options.signal.aborted) {
        await abortableDelay(options.heartbeatMs, options.signal);
        if (options.signal.aborted) break;
        const stillDesired = readDesiredUpstream(options.catalog);
        if (!stillDesired || !sameUpstreamIdentity(stillDesired, desired)) return;
        if (isDetached(options.catalog)) return;
        if (!sameUpstreamSelection(stillDesired, desired)) break;
        desired = await heartbeat(connection, stillDesired, options.catalog);
        const afterHeartbeat = selectedUpstream(options.catalog, desired, options.signal);
        if (!afterHeartbeat) return;
        if (!sameUpstreamSelection(afterHeartbeat, desired)) break;
        await options.service.flushMetadataOutbox();
        await options.service.flushMetadataDeliveries();
      }
    } catch (error) {
      if (options.signal.aborted) return;
      const role = options.catalog.dataRole();
      if (role.role === "branch" && role.branch.lifecycle === "detached") return;
      if (!readDesiredUpstream(options.catalog)) return;
      const retryMs = reconnectDelay(attempt++, options.reconnectMaxMs);
      options.onDisconnected?.(error, retryMs);
      await abortableDelay(retryMs, options.signal);
    } finally {
      options.metadataUpstream.detach(connection);
    }
  }
}

function attachmentRequest(
  catalog: ControlNodeCatalog,
  desired: DesiredControlNodeUpstream,
): ControlNodeAttachmentRequest {
  catalog.assertCanAttach();
  const local = catalog.localControlNode();
  const role = catalog.dataRole();
  return {
    controlNodeId: local.controlNodeId,
    controlNodeBootId: local.controlNodeBootId,
    feedId: local.feedId,
    name: local.name,
    ...(local.endpointId === undefined ? {} : { endpointId: local.endpointId }),
    protocolVersion: 6,
    capabilities: local.capabilities,
    expectedParentControlNodeId: desired.controlNodeId,
    childProof: catalog.attachmentProof(),
    ...(role.role === "branch" && role.branch.lifecycle === "attached"
      ? {
          resume: {
            attachmentId: role.branch.attachmentId,
            lineageId: role.branch.lineageId,
            authority: role.authority,
          },
        }
      : {}),
  };
}

async function heartbeat(
  connection: P2PParentControlNodeConnection,
  desired: DesiredControlNodeUpstream,
  catalog: ControlNodeCatalog,
): Promise<DesiredControlNodeUpstream> {
  const response = await connection.heartbeat(catalog.feedCheckpoint());
  if (!response.accepted) throw new Error("upstream rejected attachment epoch");
  if (response.p2pTicket === undefined) return desired;
  const renewed = snapshotUpstream({
    ...desired,
    locator: { kind: "ticket", ticket: response.p2pTicket },
  });
  const current = readDesiredUpstream(catalog);
  if (current && sameUpstreamSelection(current, desired) &&
    !isDetached(catalog)) {
    catalog.setDesiredUpstream(renewed);
  }
  return renewed;
}

function isDetached(catalog: ControlNodeCatalog): boolean {
  const role = catalog.dataRole();
  return role.role === "branch" && role.branch.lifecycle === "detached";
}

function selectedUpstream(
  catalog: ControlNodeCatalog,
  desired: DesiredControlNodeUpstream,
  signal: AbortSignal,
): DesiredControlNodeUpstream | null {
  if (signal.aborted || isDetached(catalog)) return null;
  const current = readDesiredUpstream(catalog);
  return current !== null && sameUpstreamIdentity(current, desired) ? current : null;
}

function sameUpstreamSelection(
  left: DesiredControlNodeUpstream,
  right: DesiredControlNodeUpstream,
): boolean {
  return sameUpstreamIdentity(left, right) &&
    JSON.stringify(left.locator) === JSON.stringify(right.locator);
}

function readDesiredUpstream(
  catalog: ControlNodeCatalog,
): DesiredControlNodeUpstream | null {
  const desired = catalog.desiredUpstream();
  return desired === null ? null : parseDesiredControlNodeUpstream(desired);
}

function sameUpstreamIdentity(
  left: DesiredControlNodeUpstream,
  right: DesiredControlNodeUpstream,
): boolean {
  return (
    left.controlNodeId === right.controlNodeId &&
    left.endpointId === right.endpointId
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

function snapshotUpstream(
  upstream: DesiredControlNodeUpstream,
): DesiredControlNodeUpstream {
  const locator = upstream.locator.kind === "ticket"
    ? Object.freeze({ kind: "ticket" as const, ticket: upstream.locator.ticket })
    : upstream.locator.kind === "mdns"
      ? Object.freeze({
          kind: "mdns" as const,
          ...(upstream.locator.serviceName === undefined
            ? {}
            : { serviceName: upstream.locator.serviceName }),
        })
      : Object.freeze({ kind: "dns" as const });
  return Object.freeze({
    version: 1 as const,
    controlNodeId: upstream.controlNodeId,
    endpointId: upstream.endpointId,
    locator,
  });
}
