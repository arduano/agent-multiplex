import type { MetadataUpstreamConnection } from "@arduano/agent-multiplex-control-node-core";
import type {
  ControlNodeAttachment,
  ControlNodeAttachmentRequest,
  ControlNodeBootId,
  ControlNodeDescriptor,
  ControlNodeId,
  ControlNodeLinkFence,
  FeedCheckpoint,
  MetadataOperationRecord,
} from "@arduano/agent-multiplex-protocol";
import type { Peer } from "@arduano/p2prpc-core";
import type { AnyTRPCRouter } from "@trpc/server";

interface ParentControlNodeIngressRpc {
  readonly ingress: {
    readonly controlNodes: {
      readonly attach: {
        mutate(input: ControlNodeAttachmentRequest): Promise<{
          accepted: boolean;
          canonical: ControlNodeDescriptor;
          attachment: ControlNodeAttachment;
          parentCheckpoint: FeedCheckpoint;
        }>;
      };
      readonly heartbeat: {
        mutate(input: ControlNodeLinkFence & { checkpoint: FeedCheckpoint }): Promise<{
          accepted: boolean;
          parentCheckpoint: FeedCheckpoint;
          p2pTicket?: string;
        }>;
      };
      readonly pushMetadataOutbox: {
        mutate(
          input: ControlNodeLinkFence & {
            operations: MetadataOperationRecord[];
          },
        ): Promise<MetadataOperationRecord[]>;
      };
    };
  };
}

export interface ParentControlNodeFenceSource {
  readonly controlNodeId: ControlNodeId;
  readonly controlNodeBootId: ControlNodeBootId;
  currentAttachment(): Pick<
    ControlNodeAttachment,
    "attachmentId" | "lineageId"
  >;
}

/** Child-side typed port to its one explicitly configured parent control node. */
export interface P2PParentControlNodeConnection
  extends MetadataUpstreamConnection {
  readonly endpointId: string;
  attach(request: ControlNodeAttachmentRequest): Promise<{
    accepted: boolean;
    canonical: ControlNodeDescriptor;
    attachment: ControlNodeAttachment;
    parentCheckpoint: FeedCheckpoint;
  }>;
  heartbeat(checkpoint: FeedCheckpoint): Promise<{
    accepted: boolean;
    parentCheckpoint: FeedCheckpoint;
    p2pTicket?: string;
  }>;
}

/** Adapt a parent's `ingress.controlNodes.*` proxy to the upstream port. */
export function parentControlNodeConnectionFromPeer(
  peer: Peer<AnyTRPCRouter>,
  source: ParentControlNodeFenceSource,
): P2PParentControlNodeConnection {
  const rpc = (peer.rpc as unknown as ParentControlNodeIngressRpc).ingress
    .controlNodes;
  const fence = (): ControlNodeLinkFence => ({
    controlNodeId: source.controlNodeId,
    controlNodeBootId: source.controlNodeBootId,
    ...source.currentAttachment(),
  });
  return Object.freeze({
    endpointId: peer.identity.id,
    attach: (request: ControlNodeAttachmentRequest) =>
      rpc.attach.mutate(request),
    heartbeat: (checkpoint: FeedCheckpoint) =>
      rpc.heartbeat.mutate({ ...fence(), checkpoint }),
    pushMetadataOutbox: (operations: readonly MetadataOperationRecord[]) =>
      rpc.pushMetadataOutbox.mutate({ ...fence(), operations: [...operations] }),
  });
}

/** Mutable upstream port which is unavailable while the configured parent is offline. */
export class ReconnectableMetadataUpstream
  implements MetadataUpstreamConnection {
  #current: P2PParentControlNodeConnection | undefined;

  public attach(connection: P2PParentControlNodeConnection): void {
    this.#current = connection;
  }

  public detach(connection?: P2PParentControlNodeConnection): void {
    if (connection === undefined || this.#current === connection) {
      this.#current = undefined;
    }
  }

  public get connected(): boolean {
    return this.#current !== undefined;
  }

  public pushMetadataOutbox(
    operations: readonly MetadataOperationRecord[],
  ): Promise<MetadataOperationRecord[]> {
    const current = this.#current;
    if (!current) {
      return Promise.reject(
        new Error("parent metadata authority is unavailable"),
      );
    }
    return current.pushMetadataOutbox(operations);
  }
}
