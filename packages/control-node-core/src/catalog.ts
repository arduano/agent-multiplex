import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import {
  HardenedSqliteDatabase,
  type SqliteBackupResult,
  type SqliteDiagnostics,
} from "@arduano/agent-multiplex-storage-sqlite";
import {
  accessSnapshotSchema,
  archiveRecordSchema,
  authorityPromoteInputSchema,
  authorityPromotionReceiptSchema,
  canonicalJson,
  canonicalProtocolRecordJson,
  commandRecordSchema,
  controlChangeSchema,
  controlNodeAttachmentRequestSchema,
  controlNodeAttachmentSchema,
  controlNodeDataRoleSchema,
  controlNodeDescriptorSchema,
  emptyMetadataSnapshot,
  feedControlItemSchema,
  interactionRecordSchema,
  inventorySnapshotSchema,
  jsonObjectSchema,
  jsonValueSchema,
  launchListInputSchema,
  launchRecordSchema,
  metadataOperationRecordSchema,
  metadataPatchSchema,
  metadataValuesSchema,
  newAttachmentId,
  newAuthorityEpochId,
  newAuthorityTransitionId,
  newControlNodeBootId,
  newControlNodeId,
  newFeedId,
  newLineageId,
  newRealmId,
  newSessionId,
  newTopologyTransitionId,
  operationIdSchema,
  runtimeNodeDescriptorSchema,
  runtimeNodeSessionRecordSchema,
  runtimeNodeRegistrationSchema,
  sessionRecordSchema,
  sessionSearchInputSchema,
  sessionSearchPageSchema,
  sourceCoverageSnapshotSchema,
  sourceManifestSchema,
  topologyDetachInputSchema,
  topologyDetachmentReceiptSchema,
  topologyForceDetachInputSchema,
  type AccessSnapshot,
  type ArchiveOperationId,
  type ArchiveRecord,
  type AuthorityPromoteInput,
  type AuthorityPromotionReceipt,
  type AuthorityRef,
  type CommandId,
  type CommandRecord,
  type ControlChange,
  type ControlNodeAttachment,
  type ControlNodeAttachmentProof,
  type ControlNodeAttachmentRequest,
  type ControlNodeBootId,
  type ControlNodeDataRole,
  type ControlNodeDescriptor,
  type ControlNodeId,
  type FeedCheckpoint,
  type FeedControlItem,
  type FeedId,
  type Harness,
  type InteractionRecord,
  type InventorySnapshot,
  type LaunchId,
  type LaunchListInput,
  type LaunchListPage,
  type LaunchRecord,
  type MetadataOperationRecord,
  type MetadataOperationStatus,
  type MetadataPatch,
  type MetadataPatchResult,
  type MetadataSnapshot,
  type NativeInventoryItem,
  type RuntimeNodeDescriptor,
  type RuntimeNodeId,
  type RuntimeNodeRegistration,
  type RuntimeNodeSessionRecord,
  type SessionAvailability,
  type SessionId,
  type SessionRecord,
  type SessionCatalogState,
  type SessionSearchInput,
  type SessionSearchPage,
  type SourceManifest,
  type TopologyDetachInput,
  type TopologyDetachmentReceipt,
  type TopologyForceDetachInput,
} from "@arduano/agent-multiplex-protocol";
import { z, type ZodType } from "zod";

import { ControlNodeCoreError } from "./errors.js";

type Row = Record<string, unknown>;
const CONTROL_NODE_CATALOG_APPLICATION_ID = 0x414d_434e; // "AMCN"

const encode = (value: unknown): string => JSON.stringify(value);
const decode = (value: unknown): unknown => JSON.parse(String(value));
const parse = <T>(schema: ZodType<T>, value: unknown): T =>
  schema.parse(typeof value === "string" ? decode(value) : value);

/** Read-only compatibility shape for v3 lifecycle rows during migration. */
interface LegacyLifecycleCommand {
  readonly commandId: CommandId;
  readonly payloadHash: string;
  readonly sessionId: SessionId;
  readonly runtimeNodeId: RuntimeNodeId;
  readonly request: {
    readonly harness: Harness;
    readonly vendorSessionId?: string;
  };
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ControlNodeCatalogOptions {
  readonly filename: string;
  readonly controlNodeId?: ControlNodeId;
  readonly controlNodeBootId?: ControlNodeBootId;
  readonly controlNodeName?: string;
  readonly endpointId?: string;
  readonly now?: () => Date;
  readonly eventRetentionLimit?: number;
  /** Deterministic crash injection for transaction-boundary tests. */
  readonly failpoint?: ((point: ControlNodeCatalogFailpoint) => void) | undefined;
}

export type ControlNodeCatalogFailpoint =
  | "metadata.authority.afterState"
  | "metadata.authority.afterEvents"
  | "metadata.authority.afterDeliveryIntent"
  | "authority.promotion.afterFeedRotation";

export interface SessionFilter {
  readonly runtimeNodeId?: RuntimeNodeId;
  readonly harness?: Harness;
  readonly availability?: readonly SessionAvailability[];
  readonly catalogState?: readonly SessionCatalogState[];
}

interface PendingLifecycleIntent {
  readonly commandId: CommandId;
  readonly sessionId: SessionId;
  readonly harness: Harness;
  readonly vendorSessionId: string;
}

interface LaunchInventoryBinding {
  readonly launch: LaunchRecord;
  readonly result: NonNullable<LaunchRecord["result"]>;
  readonly sessionId: SessionId;
}

export interface RuntimeNodeRoute {
  readonly runtimeNodeId: RuntimeNodeId;
  readonly ownerControlNodeId: ControlNodeId;
  readonly immediateChildControlNodeId?: ControlNodeId;
  readonly attachmentId?: ControlNodeAttachment["attachmentId"];
  readonly lineageId?: ControlNodeAttachment["lineageId"];
}

export interface RoleTransitionRecord {
  readonly transitionId: string;
  readonly kind: "attached" | "detached" | "forced-detached" | "promoted";
  readonly before: ControlNodeDataRole;
  readonly after: ControlNodeDataRole;
  readonly receipt: TopologyDetachmentReceipt | AuthorityPromotionReceipt | ControlNodeAttachment;
  readonly committedAt: string;
}

export interface MetadataDeliveryIntent {
  readonly sequence: number;
  readonly destinationRuntimeNodeId: RuntimeNodeId;
  readonly operation: MetadataOperationRecord;
}

/**
 * Single-writer v4 domain store. Every public mutation commits its materialized
 * state, immutable event, and delivery intent in one SQLite transaction.
 */
export class ControlNodeCatalog {
  readonly #sqlite: HardenedSqliteDatabase;
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #events = new EventEmitter();
  readonly #controlNodeId: ControlNodeId;
  #feedId: FeedId;
  readonly #eventRetentionLimit: number;
  readonly #failpoint: ((point: ControlNodeCatalogFailpoint) => void) | undefined;
  #publishedCursor = 0;

  public constructor(options: ControlNodeCatalogOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#eventRetentionLimit = options.eventRetentionLimit ?? 100_000;
    this.#failpoint = options.failpoint;
    if (!Number.isSafeInteger(this.#eventRetentionLimit) || this.#eventRetentionLimit < 1_000) {
      throw new RangeError("eventRetentionLimit must be an integer of at least 1000");
    }
    this.#sqlite = new HardenedSqliteDatabase({
      filename: options.filename,
      applicationId: CONTROL_NODE_CATALOG_APPLICATION_ID,
      storeName: "control-node catalog",
      migrations: [
        {
          version: 3,
          name: "control-node-v3-bootstrap",
          apply: ControlNodeCatalog.#migrateV3,
        },
        {
          version: 4,
          name: "control-node-v4-session-lifecycle",
          apply: ControlNodeCatalog.#migrateV4,
        },
      ],
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.#db = this.#sqlite.database;
    try {
      const identity = this.#loadOrCreateIdentity(options.controlNodeId);
      this.#controlNodeId = identity.controlNodeId;
      this.#feedId = identity.feedId;
      this.#startBoot(options);
      this.#recoverInterruptedState();
      this.#retireArchivedMetadataDeliveryIntents();
      this.#publishedCursor = this.controlCursor();
    } catch (cause) {
      this.#sqlite.close();
      throw cause;
    }
  }

  public close(): void {
    this.#events.removeAllListeners();
    this.#sqlite.close();
  }

  public diagnostics(): SqliteDiagnostics { return this.#sqlite.diagnostics(); }
  public backup(destination: string): Promise<SqliteBackupResult> { return this.#sqlite.backup(destination); }
  public checkpoint() { return this.#sqlite.checkpoint("PASSIVE"); }

  public onControl(listener: (item: FeedControlItem) => void): () => void {
    this.#events.on("control", listener);
    return () => this.#events.off("control", listener);
  }

  public localControlNode(): ControlNodeDescriptor {
    const descriptor = this.getControlNode(this.#controlNodeId);
    if (!descriptor) throw new ControlNodeCoreError("NOT_FOUND", "local control-node descriptor is missing");
    return { ...descriptor, dataRole: this.dataRole() };
  }

  public setLocalEndpointId(endpointId: string): ControlNodeDescriptor {
    if (endpointId.trim().length === 0 || endpointId.length > 512) {
      throw new TypeError("control-node endpoint ID must contain 1 to 512 characters");
    }
    const local = this.localControlNode();
    if (local.endpointId !== undefined && local.endpointId !== endpointId) {
      throw new ControlNodeCoreError("FENCED", "control-node database is pinned to another endpoint identity");
    }
    if (local.endpointId === endpointId) return local;
    const updated = controlNodeDescriptorSchema.parse({ ...local, endpointId });
    this.#mutate(() => {
      this.#putControlNode(updated, null);
      this.#appendControl({ type: "controlNode.upsert", controlNode: updated });
    });
    return updated;
  }

  public dataRole(): ControlNodeDataRole {
    const row = this.#db.prepare("SELECT role_json FROM control_node_role WHERE singleton = 1").get() as Row;
    return parse(controlNodeDataRoleSchema, row.role_json);
  }

  public authority(): AuthorityRef { return this.dataRole().authority; }

  public listRoleTransitions(): RoleTransitionRecord[] {
    const rows = this.#db.prepare("SELECT record_json FROM role_transitions ORDER BY sequence").all() as Row[];
    return rows.map((row) => decode(row.record_json) as RoleTransitionRecord);
  }

  public desiredUpstream(): Readonly<Record<string, unknown>> | null {
    const row = this.#db.prepare("SELECT value_json FROM settings WHERE key = 'desired_upstream'").get() as Row | undefined;
    return row ? jsonValueSchema.parse(decode(row.value_json)) as Readonly<Record<string, unknown>> : null;
  }

  /** Environment configuration may call this only when the database is unconfigured. */
  public bootstrapDesiredUpstream(locator: Readonly<Record<string, unknown>>): boolean {
    const value = jsonObjectSchema.parse(locator);
    return this.#transaction(() => {
      const configured = this.#db.prepare(
        "SELECT 1 FROM settings WHERE key IN ('upstream_configuration_initialized', 'desired_upstream') LIMIT 1",
      ).get();
      if (configured) {
        // Upgrade databases created by an early v3 build without making an
        // environment value authoritative again.
        this.#markUpstreamConfigurationInitialized();
        return false;
      }
      this.#setDesiredUpstream(value);
      return true;
    });
  }

  public setDesiredUpstream(locator: Readonly<Record<string, unknown>> | null): void {
    const value = locator === null ? null : jsonObjectSchema.parse(locator);
    this.#transaction(() => this.#setDesiredUpstream(value));
  }

  public controlCursor(): number {
    const row = this.#db.prepare("SELECT last_cursor FROM control_feed_state WHERE singleton = 1").get() as Row;
    return Number(row.last_cursor);
  }

  public minimumControlCursor(): number {
    const row = this.#db.prepare("SELECT minimum_cursor FROM control_feed_state WHERE singleton = 1").get() as Row;
    return Number(row.minimum_cursor);
  }

  public canReplayControlCursor(cursor: number): boolean {
    return Number.isSafeInteger(cursor) && cursor >= this.minimumControlCursor() && cursor <= this.controlCursor();
  }

  public controlEventsAfter(cursor: number, limit = 10_000): FeedControlItem[] {
    if (!this.canReplayControlCursor(cursor)) {
      throw new ControlNodeCoreError("CURSOR_EXPIRED", `control cursor ${cursor} is outside retained range`, {
        minimumControlCursor: this.minimumControlCursor(),
        controlCursor: this.controlCursor(),
        feedId: this.#feedId,
      });
    }
    const rows = this.#db.prepare(
      "SELECT item_json FROM control_events WHERE cursor > ? ORDER BY cursor LIMIT ?",
    ).all(cursor, limit) as Row[];
    return rows.map((row) => parse(feedControlItemSchema, row.item_json));
  }

  public compactControlEvents(throughCursor: number): { deleted: number; minimumControlCursor: number } {
    const current = this.controlCursor();
    if (!Number.isSafeInteger(throughCursor) || throughCursor < 0 || throughCursor > current) {
      throw new RangeError("invalid control compaction cursor");
    }
    const previous = this.minimumControlCursor();
    if (throughCursor <= previous) return { deleted: 0, minimumControlCursor: previous };
    return this.#transaction(() => {
      const result = this.#db.prepare("DELETE FROM control_events WHERE cursor <= ?").run(throughCursor);
      this.#db.prepare("UPDATE control_feed_state SET minimum_cursor = ? WHERE singleton = 1").run(throughCursor);
      return { deleted: Number(result.changes), minimumControlCursor: throughCursor };
    });
  }

  public feedCheckpoint(): FeedCheckpoint {
    return { feedId: this.#feedId, controlCursor: this.controlCursor() };
  }

  public sourceManifest(): SourceManifest {
    const local = this.localControlNode();
    return sourceManifestSchema.parse({
      componentKind: "control-node",
      protocolVersion: 4,
      sourceControlNodeId: local.controlNodeId,
      sourceControlNodeBootId: local.controlNodeBootId,
      authority: this.authority(),
      projectionRootControlNodeId: local.controlNodeId,
      coveredControlNodeIds: this.listControlNodes().map((node) => node.controlNodeId),
      feedId: this.#feedId,
      controlCursor: this.controlCursor(),
      generatedAt: this.#timestamp(),
      capabilities: local.capabilities,
    });
  }

  /** Canonical proof supplied by this control node during attachment. */
  public attachmentProof(): ControlNodeAttachmentProof {
    return {
      currentRole: this.dataRole(),
      coveredControlNodeIds: this.listControlNodes().map(
        (node) => node.controlNodeId,
      ),
    };
  }

  /** All lists and the replay barrier are captured in one SQLite read transaction. */
  public accessSnapshot(): AccessSnapshot {
    this.#db.exec("BEGIN");
    try {
      const manifest = this.sourceManifest();
      const controlNodes = this.listControlNodes();
      const parentByControlNodeId = Object.fromEntries(controlNodes.map((node) => [
        node.controlNodeId,
        node.controlNodeId === this.#controlNodeId
          ? null
          : node.dataRole.role === "branch" && node.dataRole.branch.lifecycle === "attached"
            ? node.dataRole.branch.parentControlNodeId
            : null,
      ]));
      const value = accessSnapshotSchema.parse({
        source: sourceCoverageSnapshotSchema.parse({ manifest, parentByControlNodeId }),
        capturedAt: this.#timestamp(),
        controlNodes,
        runtimeNodes: this.listRuntimeNodes(),
        sessions: this.listSessions(),
        interactions: this.listInteractions({ pendingOnly: false }).filter((interaction) =>
          this.getSession(interaction.sessionId)?.catalogState === "open"),
        // A source snapshot is an authority hand-off, not a bounded UI list.
        // Silently omitting older receipts would let an aggregate accept a
        // replayed operation ID without seeing its immutable terminal result.
        metadataOperations: (this.#db.prepare(`
          SELECT m.record_json FROM metadata_operations m
          JOIN sessions s ON s.session_id=m.session_id
          WHERE s.catalog_state='open'
          ORDER BY m.updated_at DESC, m.operation_id
        `).all() as Row[]).map((row) =>
          parse(metadataOperationRecordSchema, row.record_json)),
      });
      this.#db.exec("COMMIT");
      return value;
    } catch (cause) {
      this.#db.exec("ROLLBACK");
      throw cause;
    }
  }

  public getControlNode(id: ControlNodeId): ControlNodeDescriptor | null {
    const row = this.#db.prepare("SELECT record_json FROM control_nodes WHERE control_node_id = ?").get(id) as Row | undefined;
    if (!row) return null;
    const descriptor = parse(controlNodeDescriptorSchema, row.record_json);
    return id === this.#controlNodeId ? { ...descriptor, dataRole: this.dataRole() } : descriptor;
  }

  public isControlNodeProjectedThrough(
    childControlNodeId: ControlNodeId,
    controlNodeId: ControlNodeId,
  ): boolean {
    return this.#projectionSource("control_nodes", "control_node_id", controlNodeId) === childControlNodeId;
  }

  public listControlNodes(): ControlNodeDescriptor[] {
    const rows = this.#db.prepare("SELECT record_json FROM control_nodes ORDER BY control_node_id").all() as Row[];
    return rows.map((row) => parse(controlNodeDescriptorSchema, row.record_json)).map((node) =>
      node.controlNodeId === this.#controlNodeId ? { ...node, dataRole: this.dataRole() } : node,
    );
  }

  public getAttachment(childControlNodeId: ControlNodeId): ControlNodeAttachment | null {
    const row = this.#db.prepare(
      "SELECT record_json FROM attachments WHERE child_control_node_id = ? AND state = 'active'",
    ).get(childControlNodeId) as Row | undefined;
    return row ? parse(controlNodeAttachmentSchema, row.record_json) : null;
  }

  public attachChild(requestInput: ControlNodeAttachmentRequest): {
    attachment: ControlNodeAttachment;
    child: ControlNodeDescriptor;
    reconnected: boolean;
  } {
    const request = controlNodeAttachmentRequestSchema.parse(requestInput);
    if (request.expectedParentControlNodeId !== this.#controlNodeId) {
      throw new ControlNodeCoreError("FENCED", "attachment targets a different parent control node");
    }
    if (request.controlNodeId === this.#controlNodeId) {
      throw new ControlNodeCoreError("CONFLICT", "a control node cannot attach to itself");
    }
    const existing = this.getAttachment(request.controlNodeId);
    if (existing === null && request.resume !== undefined) {
      throw new ControlNodeCoreError(
        "FENCED",
        "a fresh child attachment cannot resume an unrecognized lineage",
      );
    }
    const reconnect = existing !== null && request.resume !== undefined &&
      existing.attachmentId === request.resume.attachmentId &&
      existing.lineageId === request.resume.lineageId &&
      sameAuthority(existing.authority, request.resume.authority) &&
      sameAuthority(existing.authority, this.authority());
    this.#assertAttachmentRoleProof(request, existing, reconnect);
    if (existing && !reconnect) {
      throw new ControlNodeCoreError("CONFLICT", "child already has a different active attachment");
    }
    const parentCoverage = new Set(
      this.listControlNodes().map((node) => node.controlNodeId),
    );
    for (const controlNodeId of request.childProof.coveredControlNodeIds) {
      if (!parentCoverage.has(controlNodeId)) continue;
      if (
        reconnect &&
        this.isControlNodeProjectedThrough(request.controlNodeId, controlNodeId)
      ) {
        continue;
      }
      if (controlNodeId === this.#controlNodeId) {
        throw new ControlNodeCoreError(
          "CONFLICT",
          "child subtree already contains the proposed parent control node",
        );
      }
      throw new ControlNodeCoreError(
        "CONFLICT",
        `child subtree overlaps control node ${controlNodeId} already owned by the parent tree`,
      );
    }
    const previousChild = this.getControlNode(request.controlNodeId);
    if (
      request.endpointId !== undefined &&
      previousChild?.endpointId !== undefined &&
      previousChild.endpointId !== request.endpointId
    ) {
      throw new ControlNodeCoreError(
        "FENCED",
        "child control-node identity is pinned to another endpoint",
      );
    }
    const timestamp = this.#timestamp();
    const attachment = reconnect ? existing : controlNodeAttachmentSchema.parse({
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
      parentControlNodeId: this.#controlNodeId,
      childControlNodeId: request.controlNodeId,
      authority: this.authority(),
      attachedAt: timestamp,
    });
    const role: ControlNodeDataRole = {
      role: "branch",
      authority: attachment.authority,
      branch: {
        lifecycle: "attached",
        parentControlNodeId: this.#controlNodeId,
        attachmentId: attachment.attachmentId,
        lineageId: attachment.lineageId,
        attachedAt: attachment.attachedAt,
      },
    };
    const child = controlNodeDescriptorSchema.parse({
      controlNodeId: request.controlNodeId,
      controlNodeBootId: request.controlNodeBootId,
      feedId: request.feedId,
      name: request.name,
      ...(request.endpointId ? { endpointId: request.endpointId } : {}),
      presence: "online",
      dataRole: role,
      connectedAt: timestamp,
      lastHeartbeatAt: timestamp,
      protocolVersion: 4,
      capabilities: request.capabilities,
    });
    this.#mutate(() => {
      if (request.endpointId) {
        this.#enrollPeer(
          request.endpointId,
          "child-control-node",
          request.controlNodeId,
          [],
        );
      }
      if (!reconnect) {
        this.#db.prepare(`
          INSERT INTO attachments(attachment_id, child_control_node_id, state, record_json, updated_at)
          VALUES (?, ?, 'active', ?, ?)
        `).run(attachment.attachmentId, attachment.childControlNodeId, encode(attachment), timestamp);
      }
      this.#putControlNode(child, request.controlNodeId);
      this.#appendControl({ type: "controlNode.upsert", controlNode: child });
      if (!reconnect) this.#appendControl({ type: "controlNode.attached", attachment });
    });
    return { attachment, child, reconnected: reconnect };
  }

  public applyParentAttachment(
    attachmentInput: ControlNodeAttachment,
    parentEndpointId: string,
  ): ControlNodeDescriptor {
    const attachment = controlNodeAttachmentSchema.parse(attachmentInput);
    if (attachment.childControlNodeId !== this.#controlNodeId) {
      throw new ControlNodeCoreError("FENCED", "parent attachment targets a different child");
    }
    const coverage = new Set(
      this.listControlNodes().map((node) => node.controlNodeId),
    );
    if (coverage.has(attachment.parentControlNodeId)) {
      throw new ControlNodeCoreError(
        "CONFLICT",
        "proposed parent is already inside the local subtree",
      );
    }
    if (coverage.has(attachment.authority.controlNodeId)) {
      throw new ControlNodeCoreError(
        "CONFLICT",
        "proposed authority owner is already inside the local subtree",
      );
    }
    const before = this.dataRole();
    const after = controlNodeDataRoleSchema.parse({
      role: "branch",
      authority: attachment.authority,
      branch: {
        lifecycle: "attached",
        parentControlNodeId: attachment.parentControlNodeId,
        attachmentId: attachment.attachmentId,
        lineageId: attachment.lineageId,
        attachedAt: attachment.attachedAt,
      },
    });
    if (before.role === "branch" && before.branch.lifecycle === "attached") {
      if (!sameCanonicalJson(before, after)) {
        throw new ControlNodeCoreError(
          "FENCED",
          "parent attempted to replace an active attachment lineage",
        );
      }
      // Reconnects replay the same attachment receipt. Refresh the durable
      // endpoint enrollment without duplicating the role transition.
      this.#mutate(() => this.#enrollPeer(
        parentEndpointId,
        "parent-control-node",
        attachment.parentControlNodeId,
        [],
      ));
      return this.localControlNode();
    }
    this.#mutate(() => {
      this.#enrollPeer(
        parentEndpointId,
        "parent-control-node",
        attachment.parentControlNodeId,
        [],
      );
      this.#setRole(after);
      this.#appendRoleTransition("attached", before, after, attachment, attachment.attachmentId);
      this.#rewriteSubtreeAuthority(after.authority);
      const local = { ...this.localControlNode(), dataRole: after };
      this.#putControlNode(local, null);
      this.#appendControl({ type: "controlNode.upsert", controlNode: local });
    });
    return this.localControlNode();
  }

  public detachChild(inputValue: TopologyDetachInput): TopologyDetachmentReceipt {
    const input = topologyDetachInputSchema.parse(inputValue);
    this.#assertAuthority(input.expectedAuthority);
    const attachment = this.getAttachment(input.childControlNodeId);
    if (!attachment || attachment.attachmentId !== input.attachmentId || attachment.lineageId !== input.lineageId) {
      throw new ControlNodeCoreError("FENCED", "stale child attachment fence");
    }
    const receipt = topologyDetachmentReceiptSchema.parse({
      transitionId: newTopologyTransitionId(),
      mode: "graceful",
      childControlNodeId: input.childControlNodeId,
      formerParentControlNodeId: this.#controlNodeId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
      previousAuthority: attachment.authority,
      metadataBarrier: this.controlCursor(),
      detachedAt: this.#timestamp(),
    });
    this.#mutate(() => {
      this.#db.prepare("UPDATE attachments SET state = 'detached', updated_at = ? WHERE attachment_id = ?")
        .run(receipt.detachedAt, attachment.attachmentId);
      const child = this.getControlNode(input.childControlNodeId);
      if (child) {
        const detached = controlNodeDescriptorSchema.parse({
          ...child,
          presence: "offline",
          dataRole: {
            role: "branch",
            authority: attachment.authority,
            branch: {
              lifecycle: "detached",
              formerParentControlNodeId: this.#controlNodeId,
              attachmentId: attachment.attachmentId,
              lineageId: attachment.lineageId,
              attachedAt: attachment.attachedAt,
              detachedAt: receipt.detachedAt,
            },
          },
        });
        this.#putControlNode(detached, input.childControlNodeId);
      }
      this.#appendControl({ type: "controlNode.detached", receipt });
      this.#dropProjection(input.childControlNodeId);
    });
    return receipt;
  }

  /** Local emergency detach. Connectivity loss never calls this method. */
  public applyDetachmentReceipt(receiptInput: TopologyDetachmentReceipt): TopologyDetachmentReceipt {
    const receipt = topologyDetachmentReceiptSchema.parse(receiptInput);
    if (receipt.childControlNodeId !== this.#controlNodeId) {
      throw new ControlNodeCoreError("FENCED", "detachment receipt targets another branch");
    }
    const before = this.dataRole();
    if (before.role !== "branch" || before.branch.lifecycle !== "attached" ||
      before.branch.parentControlNodeId !== receipt.formerParentControlNodeId ||
      before.branch.attachmentId !== receipt.attachmentId ||
      before.branch.lineageId !== receipt.lineageId ||
      !sameAuthority(before.authority, receipt.previousAuthority)) {
      throw new ControlNodeCoreError("FENCED", "detachment receipt does not match the active attachment");
    }
    const after = controlNodeDataRoleSchema.parse({
      role: "branch",
      authority: before.authority,
      branch: {
        lifecycle: "detached",
        formerParentControlNodeId: before.branch.parentControlNodeId,
        attachmentId: before.branch.attachmentId,
        lineageId: before.branch.lineageId,
        attachedAt: before.branch.attachedAt,
        detachedAt: receipt.detachedAt,
      },
    });
    this.#mutate(() => {
      this.#setRole(after);
      this.#appendRoleTransition(
        receipt.mode === "forced" ? "forced-detached" : "detached",
        before,
        after,
        receipt,
        receipt.transitionId,
      );
      if (receipt.mode === "forced") {
        for (const id of receipt.unresolvedMetadataOperationIds) this.#markMetadataOutcomeUnknown(id);
      }
      this.#setDesiredUpstream(null);
      const local = { ...this.localControlNode(), dataRole: after };
      this.#putControlNode(local, null);
      this.#appendControl({ type: "controlNode.detached", receipt });
      this.#appendControl({ type: "controlNode.upsert", controlNode: local });
    });
    return receipt;
  }

  /** Local emergency detach. Connectivity loss never calls this method. */
  public forceDetach(inputValue: TopologyForceDetachInput): TopologyDetachmentReceipt {
    const input = topologyForceDetachInputSchema.parse(inputValue);
    if (input.controlNodeId !== this.#controlNodeId) throw new ControlNodeCoreError("FENCED", "force-detach targets another node");
    this.#assertAuthority(input.expectedAuthority);
    const before = this.dataRole();
    if (before.role !== "branch" || before.branch.lifecycle !== "attached" ||
      before.branch.attachmentId !== input.attachmentId || before.branch.lineageId !== input.lineageId) {
      throw new ControlNodeCoreError("FENCED", "local branch attachment fence is stale");
    }
    const unknownIds = this.listMetadataOperations({ statuses: ["queued"], limit: 10_000 }).map((op) => op.operationId);
    const receipt = topologyDetachmentReceiptSchema.parse({
      transitionId: newTopologyTransitionId(),
      mode: "forced",
      childControlNodeId: this.#controlNodeId,
      formerParentControlNodeId: before.branch.parentControlNodeId,
      attachmentId: before.branch.attachmentId,
      lineageId: before.branch.lineageId,
      previousAuthority: before.authority,
      metadataBarrier: null,
      detachedAt: this.#timestamp(),
      audit: input.audit,
      unresolvedMetadataOperationIds: unknownIds,
    });
    const after = controlNodeDataRoleSchema.parse({
      role: "branch",
      authority: before.authority,
      branch: {
        lifecycle: "detached",
        formerParentControlNodeId: before.branch.parentControlNodeId,
        attachmentId: before.branch.attachmentId,
        lineageId: before.branch.lineageId,
        attachedAt: before.branch.attachedAt,
        detachedAt: receipt.detachedAt,
      },
    });
    this.#mutate(() => {
      this.#setRole(after);
      this.#appendRoleTransition("forced-detached", before, after, receipt, receipt.transitionId);
      for (const id of unknownIds) this.#markMetadataOutcomeUnknown(id);
      this.#setDesiredUpstream(null);
      const local = { ...this.localControlNode(), dataRole: after };
      this.#putControlNode(local, null);
      this.#appendControl({ type: "controlNode.detached", receipt });
    });
    return receipt;
  }

  public promote(inputValue: AuthorityPromoteInput): AuthorityPromotionReceipt {
    const input = authorityPromoteInputSchema.parse(inputValue);
    if (input.controlNodeId !== this.#controlNodeId) throw new ControlNodeCoreError("FENCED", "promotion targets another node");
    this.#assertAuthority(input.expectedAuthority);
    const before = this.dataRole();
    if (before.role !== "branch" || before.branch.lifecycle !== "detached") {
      throw new ControlNodeCoreError("FENCED", "only an explicitly detached branch can be promoted");
    }
    const transition = this.listRoleTransitions().find((item) => item.transitionId === input.detachmentTransitionId);
    if (!transition || (transition.kind !== "detached" && transition.kind !== "forced-detached")) {
      throw new ControlNodeCoreError("FENCED", "promotion does not reference the committed detachment");
    }
    if (canonicalProtocolRecordJson(transition.after) !== canonicalProtocolRecordJson(before)) {
      throw new ControlNodeCoreError("FENCED", "promotion references an obsolete detachment state");
    }
    if (transition.kind === "forced-detached" && input.forcedDetachmentAudit === undefined) {
      throw new ControlNodeCoreError("FENCED", "forced detachment promotion requires split-brain acknowledgement");
    }
    let receipt!: AuthorityPromotionReceipt;
    this.#mutate(() => {
      // Authority identities are generated only after the write transaction owns
      // the database. Callers can neither choose nor pre-allocate either fence.
      const newAuthority: AuthorityRef = {
        realmId: newRealmId(),
        controlNodeId: this.#controlNodeId,
        epochId: newAuthorityEpochId(),
      };
      const nextFeedId = newFeedId();
      receipt = authorityPromotionReceiptSchema.parse({
        transitionId: newAuthorityTransitionId(),
        controlNodeId: this.#controlNodeId,
        previousAuthority: before.authority,
        authority: newAuthority,
        detachmentTransitionId: input.detachmentTransitionId,
        promotedAt: this.#timestamp(),
        ...(input.forcedDetachmentAudit ? { audit: input.forcedDetachmentAudit } : {}),
      });
      const after = controlNodeDataRoleSchema.parse({ role: "authority", authority: newAuthority });
      this.#rotateControlFeed(nextFeedId);
      this.#failpoint?.("authority.promotion.afterFeedRotation");
      this.#setRole(after);
      this.#appendRoleTransition("promoted", before, after, receipt, receipt.transitionId);
      this.#rewriteSubtreeAuthority(newAuthority);
      this.#setDesiredUpstream(null);
      const local = { ...this.localControlNode(), feedId: nextFeedId, dataRole: after };
      this.#putControlNode(local, null);
      this.#appendControl({ type: "authority.promoted", receipt });
      this.#appendControl({ type: "controlNode.upsert", controlNode: local });
    });
    return receipt;
  }

  public markChildDisconnected(controlNodeId: ControlNodeId, bootId?: ControlNodeBootId): boolean {
    const node = this.getControlNode(controlNodeId);
    if (!node || (bootId !== undefined && node.controlNodeBootId !== bootId)) return false;
    if (node.presence !== "online") return true;
    const stale = { ...node, presence: "stale" as const, connectedAt: null };
    this.#mutate(() => {
      this.#putControlNode(stale, controlNodeId);
      for (const runtime of this.#projectedRuntimeNodes(controlNodeId)) {
        const unreachable = { ...runtime, reachability: "unreachable" as const };
        this.#putRuntimeNode(unreachable, controlNodeId);
        this.#appendControl({ type: "runtimeNode.upsert", runtimeNode: unreachable }, runtime.ownerControlNodeId);
      }
      this.#appendControl({ type: "controlNode.presence", controlNodeId, presence: "stale" });
    });
    return true;
  }

  public heartbeatChild(controlNodeId: ControlNodeId, bootId: ControlNodeBootId): boolean {
    const child = this.getControlNode(controlNodeId);
    if (!child || child.controlNodeBootId !== bootId || !this.getAttachment(controlNodeId)) return false;
    const wasDegraded = child.presence !== "online";
    const updated = controlNodeDescriptorSchema.parse({
      ...child,
      presence: "online",
      connectedAt: child.connectedAt ?? this.#timestamp(),
      lastHeartbeatAt: this.#timestamp(),
    });
    this.#mutate(() => {
      this.#putControlNode(updated, controlNodeId);
      if (wasDegraded) {
        for (const runtime of this.#projectedRuntimeNodes(controlNodeId)) {
          const reachable = { ...runtime, reachability: "reachable" as const };
          this.#putRuntimeNode(reachable, controlNodeId);
          this.#appendControl({ type: "runtimeNode.upsert", runtimeNode: reachable }, runtime.ownerControlNodeId);
        }
        this.#appendControl({ type: "controlNode.upsert", controlNode: updated });
      }
    });
    return true;
  }

  public markStaleChildren(before: Date): ControlNodeId[] {
    const cutoff = before.toISOString();
    const rows = this.#db.prepare(`
      SELECT n.record_json
      FROM control_nodes n
      JOIN attachments a ON a.child_control_node_id = n.control_node_id
      WHERE a.state = 'active' AND n.projection_source = n.control_node_id
    `).all() as Row[];
    const stale = rows.map((row) => parse(controlNodeDescriptorSchema, row.record_json))
      .filter((node) => node.presence === "online" && (node.lastHeartbeatAt === null || node.lastHeartbeatAt < cutoff));
    for (const node of stale) this.markChildDisconnected(node.controlNodeId, node.controlNodeBootId);
    return stale.map((node) => node.controlNodeId);
  }

  public replaceChildSnapshot(
    childControlNodeId: ControlNodeId,
    attachmentId: ControlNodeAttachment["attachmentId"],
    snapshotInput: AccessSnapshot,
  ): void {
    const attachment = this.getAttachment(childControlNodeId);
    if (!attachment || attachment.attachmentId !== attachmentId) {
      throw new ControlNodeCoreError("FENCED", "snapshot targets a stale child attachment");
    }
    const snapshot = accessSnapshotSchema.parse(snapshotInput);
    const manifest = snapshot.source.manifest;
    const child = this.getControlNode(childControlNodeId);
    if (manifest.sourceControlNodeId !== childControlNodeId ||
      manifest.projectionRootControlNodeId !== childControlNodeId ||
      child === null || manifest.sourceControlNodeBootId !== child.controlNodeBootId ||
      !sameAuthority(manifest.authority, this.authority())) {
      throw new ControlNodeCoreError("FENCED", "child snapshot has a foreign identity, root, boot, or authority fence");
    }
    const coverage = new Set(manifest.coveredControlNodeIds);
    this.#assertSnapshotOwnership(childControlNodeId, snapshot);
    const canonicalControlNodes = snapshot.controlNodes.map((node) => {
      if (node.controlNodeId !== childControlNodeId) return node;
      // The subtree owns the child's replicated descriptor, but this parent
      // owns the immediate-link observations used to authenticate and fence
      // that descriptor. A child cannot know (or safely overwrite) the peer
      // endpoint through which its parent currently sees it.
      return controlNodeDescriptorSchema.parse({
        ...node,
        ...(child.endpointId ? { endpointId: child.endpointId } : {}),
        presence: child.presence,
        connectedAt: child.connectedAt,
        lastHeartbeatAt: child.lastHeartbeatAt,
      });
    });
    const canonicalSessions = snapshot.sessions.map((session) => {
      const previous = this.getSession(session.sessionId);
      return sessionRecordSchema.parse({
        ...session,
        metadata: this.#metadataImportedFromChild(previous, session.metadata),
        metadataAuthority: this.authority(),
      });
    });
    const canonicalMetadataOperations = snapshot.metadataOperations.map((operation) => {
      const previous = this.getMetadataOperation(operation.operationId);
      return {
        operation: this.#mergeMetadataOperationImportedFromChild(
          childControlNodeId,
          operation,
        ),
        // A receipt committed or settled at this control node is authority
        // state, not part of the child's replaceable projection. Preserve that
        // ownership so a later detach cannot delete the canonical receipt.
        projectionSource: previous === null
          ? childControlNodeId
          : previous.status !== "queued"
            ? null
            : this.#projectionSource(
              "metadata_operations",
              "operation_id",
              previous.operationId,
            ),
      };
    });
    const previousInteractions = (this.#db.prepare(
      "SELECT record_json FROM interactions WHERE projection_source = ?",
    ).all(childControlNodeId) as Row[])
      .map((row) => parse(interactionRecordSchema, row.record_json));
    const previousById = new Map(previousInteractions.map((interaction) => [
      interaction.interactionId,
      interaction,
    ]));
    const canonicalInteractions = snapshot.interactions.map((interaction) => {
      const previous = previousById.get(interaction.interactionId);
      return previous ? mergeInteractionRecord(previous, interaction) : interaction;
    });
    const incomingInteractionIds = new Set(snapshot.interactions.map((interaction) => interaction.interactionId));
    const incomingSessionIds = new Set(canonicalSessions.map((session) => session.sessionId));
    for (const previous of previousInteractions) {
      if (
        previous.state !== "pending" &&
        incomingSessionIds.has(previous.sessionId) &&
        !incomingInteractionIds.has(previous.interactionId)
      ) {
        // Terminal interaction records are convergence tombstones. Retaining
        // them prevents an older post-reset event from resurrecting pending.
        canonicalInteractions.push(previous);
      }
    }
    this.#mutate(() => {
      // Delete the old projection first; all pages were validated before this transaction.
      this.#db.prepare("DELETE FROM interactions WHERE projection_source = ?").run(childControlNodeId);
      this.#db.prepare("DELETE FROM metadata_operations WHERE projection_source = ?").run(childControlNodeId);
      // Archived rows are cold authority tombstones and intentionally absent
      // from hot snapshots. Preserve them across a child resnapshot.
      this.#db.prepare(
        "DELETE FROM sessions WHERE projection_source = ? AND catalog_state='open'",
      ).run(childControlNodeId);
      this.#db.prepare("DELETE FROM runtime_nodes WHERE projection_source = ?").run(childControlNodeId);
      this.#db.prepare("DELETE FROM control_nodes WHERE projection_source = ?").run(childControlNodeId);
      for (const node of canonicalControlNodes) {
        if (!coverage.has(node.controlNodeId)) throw new ControlNodeCoreError("CONFLICT", "snapshot record escaped coverage");
        this.#putControlNode(node, childControlNodeId);
      }
      for (const runtime of snapshot.runtimeNodes) this.#putRuntimeNode(runtime, childControlNodeId);
      for (const session of canonicalSessions) this.#putSession(session, childControlNodeId);
      for (const interaction of canonicalInteractions) this.#putInteraction(interaction, childControlNodeId);
      for (const { operation, projectionSource } of canonicalMetadataOperations) {
        this.#putMetadataOperation(operation, projectionSource);
      }
      this.#db.prepare(`
        INSERT INTO child_checkpoints(child_control_node_id, attachment_id, feed_id, control_cursor, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(child_control_node_id) DO UPDATE SET
          attachment_id=excluded.attachment_id, feed_id=excluded.feed_id,
          control_cursor=excluded.control_cursor, updated_at=excluded.updated_at
      `).run(childControlNodeId, attachmentId, manifest.feedId, manifest.controlCursor, this.#timestamp());
      for (const node of canonicalControlNodes) this.#appendControl({ type: "controlNode.upsert", controlNode: node }, node.controlNodeId);
      for (const runtime of snapshot.runtimeNodes) this.#appendControl({ type: "runtimeNode.upsert", runtimeNode: runtime }, runtime.ownerControlNodeId);
      for (const session of canonicalSessions) {
        this.#appendControl(
          { type: "session.upsert", session },
          session.metadataAuthority.controlNodeId,
        );
      }
      for (const interaction of canonicalInteractions) {
        this.#appendControl({ type: "interaction.changed", interaction }, childControlNodeId);
      }
    });
  }

  public childCheckpoint(childControlNodeId: ControlNodeId): FeedCheckpoint | null {
    const row = this.#db.prepare("SELECT feed_id, control_cursor FROM child_checkpoints WHERE child_control_node_id = ?")
      .get(childControlNodeId) as Row | undefined;
    return row ? { feedId: String(row.feed_id) as FeedCheckpoint["feedId"], controlCursor: Number(row.control_cursor) } : null;
  }

  public importChildControl(
    childControlNodeId: ControlNodeId,
    attachmentId: ControlNodeAttachment["attachmentId"],
    itemInput: FeedControlItem,
  ): { accepted: boolean; deduplicated: boolean; localCursor: number } {
    const item = feedControlItemSchema.parse(itemInput);
    const attachment = this.getAttachment(childControlNodeId);
    if (!attachment || attachment.attachmentId !== attachmentId) throw new ControlNodeCoreError("FENCED", "stale child stream fence");
    if (!sameAuthority(item.provenance.authority, this.authority())) throw new ControlNodeCoreError("FENCED", "child event has stale authority");
    const existing = this.#db.prepare("SELECT payload_hash, local_cursor FROM imported_events WHERE event_id = ?")
      .get(item.eventId) as Row | undefined;
    const hash = canonicalProtocolRecordJson(item);
    if (existing) {
      if (String(existing.payload_hash) !== hash) throw new ControlNodeCoreError("PAYLOAD_MISMATCH", "event ID was reused with a different payload");
      return { accepted: true, deduplicated: true, localCursor: Number(existing.local_cursor) };
    }
    const checkpoint = this.childCheckpoint(childControlNodeId);
    if (!checkpoint || checkpoint.feedId !== item.feedId || item.cursor !== checkpoint.controlCursor + 1) {
      throw new ControlNodeCoreError("CURSOR_EXPIRED", "child event is not the next checkpoint position");
    }
    let localCursor = 0;
    this.#mutate(() => {
      this.#assertImportedChangeOwnership(childControlNodeId, item);
      const canonicalChange = this.#applyImportedChange(childControlNodeId, item.change);
      localCursor = this.#appendControl(canonicalChange, item.provenance.originControlNodeId, item.eventId);
      this.#db.prepare(`
        INSERT INTO imported_events(event_id, child_control_node_id, payload_hash, local_cursor, imported_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(item.eventId, childControlNodeId, hash, localCursor, this.#timestamp());
      this.#db.prepare("UPDATE child_checkpoints SET control_cursor = ?, updated_at = ? WHERE child_control_node_id = ?")
        .run(item.cursor, this.#timestamp(), childControlNodeId);
    });
    return { accepted: true, deduplicated: false, localCursor };
  }

  public registerRuntimeNode(registrationInput: RuntimeNodeRegistration, endpointId?: string): RuntimeNodeDescriptor {
    const registration = runtimeNodeRegistrationSchema.parse(registrationInput);
    const previous = this.getRuntimeNode(registration.runtimeNodeId);
    if (previous && (
      previous.ownerControlNodeId !== this.#controlNodeId ||
      this.#projectionSource("runtime_nodes", "runtime_node_id", registration.runtimeNodeId) !== null
    )) {
      throw new ControlNodeCoreError("CONFLICT", "runtime-node identity is already owned by another control node");
    }
    if (
      endpointId !== undefined &&
      previous?.endpointId !== undefined &&
      previous.endpointId !== endpointId
    ) {
      throw new ControlNodeCoreError(
        "FENCED",
        "runtime-node identity is pinned to another endpoint",
      );
    }
    const timestamp = this.#timestamp();
    const descriptor = runtimeNodeDescriptorSchema.parse({
      ...registration,
      ownerControlNodeId: this.#controlNodeId,
      ...(endpointId ? { endpointId } : previous?.endpointId ? { endpointId: previous.endpointId } : {}),
      presence: "online",
      reachability: "reachable",
      connectedAt: timestamp,
      lastHeartbeatAt: timestamp,
    });
    this.#mutate(() => {
      if (endpointId) {
        this.#enrollPeer(endpointId, "runtime-node", registration.runtimeNodeId, []);
      }
      if (previous && previous.runtimeNodeBootId !== descriptor.runtimeNodeBootId) this.#fenceRuntimeBoot(previous.runtimeNodeId);
      this.#putRuntimeNode(descriptor, null);
      this.#appendControl({ type: "runtimeNode.upsert", runtimeNode: descriptor });
    });
    return descriptor;
  }

  public heartbeatRuntimeNode(runtimeNodeId: RuntimeNodeId, bootId: string): boolean {
    const runtime = this.getRuntimeNode(runtimeNodeId);
    if (!runtime || runtime.runtimeNodeBootId !== bootId) return false;
    const changed = runtime.presence !== "online" || runtime.reachability !== "reachable";
    const updated = { ...runtime, presence: "online" as const, reachability: "reachable" as const, connectedAt: runtime.connectedAt ?? this.#timestamp(), lastHeartbeatAt: this.#timestamp() };
    this.#mutate(() => {
      this.#putRuntimeNode(updated, null);
      if (changed) this.#appendControl({ type: "runtimeNode.upsert", runtimeNode: updated });
    });
    return true;
  }

  public markRuntimeNodeDisconnected(runtimeNodeId: RuntimeNodeId, bootId?: string): boolean {
    const runtime = this.getRuntimeNode(runtimeNodeId);
    if (!runtime || (bootId !== undefined && runtime.runtimeNodeBootId !== bootId)) return false;
    if (runtime.presence === "stale" && runtime.reachability === "stale") return true;
    const updated = { ...runtime, presence: "stale" as const, reachability: "stale" as const, connectedAt: null };
    this.#mutate(() => {
      this.#putRuntimeNode(updated, null);
      this.#appendControl({ type: "runtimeNode.presence", runtimeNodeId, presence: "stale" });
    });
    return true;
  }

  public markStaleRuntimeNodes(before: Date): RuntimeNodeId[] {
    const cutoff = before.toISOString();
    const rows = this.#db.prepare(
      "SELECT record_json FROM runtime_nodes WHERE projection_source IS NULL",
    ).all() as Row[];
    const stale = rows.map((row) => parse(runtimeNodeDescriptorSchema, row.record_json))
      .filter((node) => node.presence === "online" && (node.lastHeartbeatAt === null || node.lastHeartbeatAt < cutoff));
    for (const node of stale) this.markRuntimeNodeDisconnected(node.runtimeNodeId, node.runtimeNodeBootId);
    return stale.map((node) => node.runtimeNodeId);
  }

  public getRuntimeNode(id: RuntimeNodeId): RuntimeNodeDescriptor | null {
    const row = this.#db.prepare("SELECT record_json FROM runtime_nodes WHERE runtime_node_id = ?").get(id) as Row | undefined;
    return row ? parse(runtimeNodeDescriptorSchema, row.record_json) : null;
  }

  public listRuntimeNodes(): RuntimeNodeDescriptor[] {
    const rows = this.#db.prepare("SELECT record_json FROM runtime_nodes ORDER BY runtime_node_id").all() as Row[];
    return rows.map((row) => parse(runtimeNodeDescriptorSchema, row.record_json));
  }

  public routeForRuntimeNode(id: RuntimeNodeId): RuntimeNodeRoute | null {
    const runtime = this.getRuntimeNode(id);
    if (!runtime) return null;
    if (runtime.ownerControlNodeId === this.#controlNodeId) return { runtimeNodeId: id, ownerControlNodeId: this.#controlNodeId };
    const row = this.#db.prepare("SELECT projection_source FROM runtime_nodes WHERE runtime_node_id = ?").get(id) as Row;
    const child = String(row.projection_source) as ControlNodeId;
    const attachment = this.getAttachment(child);
    if (!attachment) return null;
    return {
      runtimeNodeId: id,
      ownerControlNodeId: runtime.ownerControlNodeId,
      immediateChildControlNodeId: child,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
    };
  }

  public reconcileInventory(snapshotInput: InventorySnapshot): SessionRecord[] {
    const snapshot = inventorySnapshotSchema.parse(snapshotInput);
    const runtime = this.getRuntimeNode(snapshot.runtimeNodeId);
    if (!runtime || runtime.ownerControlNodeId !== this.#controlNodeId) {
      throw new ControlNodeCoreError("NOT_FOUND", "runtime node is not locally owned");
    }
    const lifecycleIntents = this.#pendingLifecycleIntents(snapshot.runtimeNodeId);
    const unresolvedSpawnHarnesses = this.#unresolvedSpawnHarnesses(snapshot.runtimeNodeId);
    const unresolvedLifecycleNativeKeys = this.#unresolvedLifecycleNativeKeys(
      snapshot.runtimeNodeId,
    );
    const launchInventory = this.#launchInventoryState(snapshot.runtimeNodeId);
    const previousSnapshotRow = this.#db.prepare(
      "SELECT generation, snapshot_json, captured_at FROM inventory_snapshots WHERE runtime_node_id = ?",
    ).get(snapshot.runtimeNodeId) as Row | undefined;
    if (previousSnapshotRow) {
      const previousGeneration = String(previousSnapshotRow.generation);
      const previousSnapshot = parse(inventorySnapshotSchema, previousSnapshotRow.snapshot_json);
      if (previousGeneration === snapshot.generation) {
        if (!sameCanonicalJson(previousSnapshot, snapshot)) {
          throw new ControlNodeCoreError(
            "PAYLOAD_MISMATCH",
            "inventory generation was reused with different contents",
          );
        }
        if (
          lifecycleIntents.length === 0 &&
          unresolvedSpawnHarnesses.size === 0 &&
          unresolvedLifecycleNativeKeys.size === 0
        ) {
          this.applyPendingLifecycleMetadata(snapshot.runtimeNodeId);
          return this.#sessionsForInventory(snapshot);
        }
      }
      if (Date.parse(snapshot.capturedAt) < Date.parse(String(previousSnapshotRow.captured_at))) {
        throw new ControlNodeCoreError(
          "FENCED",
          "inventory snapshot predates the latest committed snapshot",
        );
      }
    }
    const timestamp = this.#timestamp();
    const lifecycleByNativeId = new Map<string, PendingLifecycleIntent[]>();
    for (const intent of lifecycleIntents) {
      const key = `${intent.harness}\0${intent.vendorSessionId}`;
      const entries = lifecycleByNativeId.get(key) ?? [];
      entries.push(intent);
      lifecycleByNativeId.set(key, entries);
    }
    let deferredInventory = false;
    this.#mutate(() => {
      const seen = new Set<string>();
      const settledLifecycleCommands = new Set<CommandId>();
      for (const item of snapshot.sessions) {
        const key = nativeKey(item);
        if (seen.has(key)) {
          throw new ControlNodeCoreError(
            "CONFLICT",
            `inventory contains duplicate native session ${key}`,
          );
        }
        seen.add(key);
        const existingRow = this.#db.prepare(`
          SELECT record_json FROM sessions
          WHERE runtime_node_id = ? AND harness = ? AND adapter_scope_id = ? AND vendor_session_id = ?
        `).get(snapshot.runtimeNodeId, item.harness, item.adapterScopeId, item.vendorSessionId) as Row | undefined;
        const existing = existingRow ? parse(sessionRecordSchema, existingRow.record_json) : null;
        // Archive is an authority-owned tombstone. A delayed or stale native
        // inventory must never reopen the logical session.
        if (existing?.catalogState === "archived") continue;
        const lifecycleCandidates = (
          lifecycleByNativeId.get(`${item.harness}\0${item.vendorSessionId}`) ?? []
        ).filter((intent) => !settledLifecycleCommands.has(intent.commandId));
        let lifecyclePreferred = lifecycleCandidates[0];
        const launchPreferred = launchInventory.bindings.get(key);
        if (
          launchPreferred &&
          lifecyclePreferred &&
          launchPreferred.sessionId !== lifecyclePreferred.sessionId
        ) {
          throw new ControlNodeCoreError(
            "CONFLICT",
            `native session ${item.vendorSessionId} is reserved by conflicting launch and lifecycle operations`,
          );
        }
        if (existing && lifecyclePreferred && existing.sessionId !== lifecyclePreferred.sessionId) {
          for (const intent of lifecycleCandidates) {
            this.#settleLifecycleIntent(
              intent.commandId,
              "conflicted",
              `native session is already bound to ${existing.sessionId}`,
            );
            settledLifecycleCommands.add(intent.commandId);
          }
          lifecyclePreferred = undefined;
        }
        if (existing && launchPreferred && existing.sessionId !== launchPreferred.sessionId) {
          throw new ControlNodeCoreError(
            "FENCED",
            `native session ${item.vendorSessionId} is already bound to ${existing.sessionId} instead of its launch reservation`,
          );
        }
        const preferredSessionId = launchPreferred?.sessionId ?? lifecyclePreferred?.sessionId;
        if (
          !existing &&
          preferredSessionId === undefined &&
          (unresolvedSpawnHarnesses.has(item.harness) ||
            launchInventory.unresolvedHarnesses.has(item.harness) ||
            unresolvedLifecycleNativeKeys.has(`${item.harness}\0${item.vendorSessionId}`))
        ) {
          // A native spawn may become visible before its command response gives
          // the authority the vendor ID. Preserve the preallocated logical ID
          // by deferring unknown bindings for that harness until settlement.
          deferredInventory = true;
          continue;
        }
        const preferredRecord = preferredSessionId
          ? this.getSession(preferredSessionId)
          : null;
        if (existing && preferredSessionId && existing.sessionId !== preferredSessionId) {
          throw new ControlNodeCoreError(
            "CONFLICT",
            `native session ${item.vendorSessionId} is already bound to ${existing.sessionId}`,
          );
        }
        if (
          preferredRecord &&
          !existing &&
          (preferredRecord.runtimeNodeId !== snapshot.runtimeNodeId ||
            preferredRecord.harness !== item.harness ||
            preferredRecord.adapterScopeId !== item.adapterScopeId ||
            preferredRecord.vendorSessionId !== item.vendorSessionId)
        ) {
          throw new ControlNodeCoreError(
            "FENCED",
            `logical session ${preferredRecord.sessionId} is already bound to another native session`,
          );
        }
        const base = existing ?? preferredRecord;
        if (base && base.runtimeEpoch !== item.runtimeEpoch) {
          this.#stalePendingInteractionsForSession(base.sessionId, timestamp);
        }
        const record = sessionRecordSchema.parse({
          sessionId: base?.sessionId ?? preferredSessionId ?? newSessionId(),
          runtimeNodeId: snapshot.runtimeNodeId,
          harness: item.harness,
          adapterScopeId: item.adapterScopeId,
          vendorSessionId: item.vendorSessionId,
          bindingRevision: base?.bindingRevision ?? launchPreferred?.result.bindingRevision ?? 1,
          runtimeEpoch: item.runtimeEpoch,
          cwd: item.cwd,
          availability: item.availability,
          runtimeStatus: item.runtimeStatus,
          ...(item.harnessSettings !== undefined
            ? { harnessSettings: item.harnessSettings }
            : base?.harnessSettings === undefined
              ? {}
              : { harnessSettings: base.harnessSettings }),
          ...(item.nativeSummary === undefined ? {} : { nativeSummary: item.nativeSummary }),
          launchProvenance: base?.launchProvenance ?? (
            launchPreferred === undefined
              ? null
              : {
                  launchId: launchPreferred.launch.launchId,
                  profileId: launchPreferred.launch.profile.profileId,
                  providerId: launchPreferred.launch.profile.providerId,
                  backendId: launchPreferred.result.backendId,
                  contractVersion: launchPreferred.launch.profile.contractVersion,
                  requestSchemaHash: launchPreferred.launch.profile.requestSchemaHash,
                  implementationVersion: launchPreferred.launch.implementationVersion,
                }
          ),
          metadata: base?.metadata ?? emptyMetadataSnapshot(),
          metadataAuthority: this.authority(),
          catalogState: "open",
          catalogRevision: base?.catalogRevision ?? 1,
          archivedAt: null,
          createdAt: base?.createdAt ?? launchPreferred?.launch.createdAt ?? timestamp,
          updatedAt: timestamp,
          lastSeenAt: snapshot.capturedAt,
          lastActivityAt: item.lastActivityAt ?? base?.lastActivityAt ?? snapshot.capturedAt,
        });
        this.#putSession(record, null);
        this.#appendControl({ type: "session.upsert", session: record });
        for (const intent of lifecycleCandidates) {
          if (settledLifecycleCommands.has(intent.commandId)) continue;
          if (intent.sessionId === record.sessionId) {
            this.#settleLifecycleIntent(intent.commandId, "bound");
          } else {
            this.#settleLifecycleIntent(
              intent.commandId,
              "conflicted",
              `another lifecycle command bound native session to ${record.sessionId}`,
            );
          }
          settledLifecycleCommands.add(intent.commandId);
        }
      }
      if (snapshot.complete) {
        for (const existing of this.listSessions({ runtimeNodeId: snapshot.runtimeNodeId })) {
          if (seen.has(nativeKey(existing))) continue;
          this.#stalePendingInteractionsForSession(existing.sessionId, timestamp);
          const unavailable = sessionRecordSchema.parse({
            ...existing,
            availability: "unavailable",
            runtimeStatus: "unknown",
            runtimeEpoch: null,
            updatedAt: timestamp,
          });
          this.#putSession(unavailable, null);
          this.#appendControl({ type: "session.upsert", session: unavailable });
        }
      }
      if (deferredInventory) {
        // Reconsider even an identical generation after the command result is
        // recovered; the skipped native binding has not been reconciled yet.
        this.#db.prepare("DELETE FROM inventory_snapshots WHERE runtime_node_id = ?")
          .run(snapshot.runtimeNodeId);
      } else {
        this.#db.prepare(`
          INSERT INTO inventory_snapshots(runtime_node_id, generation, snapshot_json, captured_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(runtime_node_id) DO UPDATE SET generation=excluded.generation,
            snapshot_json=excluded.snapshot_json, captured_at=excluded.captured_at
        `).run(snapshot.runtimeNodeId, snapshot.generation, encode(snapshot), snapshot.capturedAt);
        this.#appendControl({
          type: "inventory.completed",
          runtimeNodeId: snapshot.runtimeNodeId,
          generation: snapshot.generation,
        });
      }
    });
    this.applyPendingLifecycleMetadata(snapshot.runtimeNodeId);
    return this.#sessionsForInventory(snapshot);
  }

  public mergeRuntimeSession(input: RuntimeNodeSessionRecord): SessionRecord {
    const incoming = runtimeNodeSessionRecordSchema.parse(input);
    const runtime = this.getRuntimeNode(incoming.runtimeNodeId);
    if (!runtime || runtime.ownerControlNodeId !== this.#controlNodeId) throw new ControlNodeCoreError("FENCED", "runtime session is not locally owned");
    const current = this.getSession(incoming.sessionId);
    if (current?.catalogState === "archived") return current;
    const nativeOwnerRow = this.#db.prepare(`
      SELECT record_json FROM sessions
      WHERE runtime_node_id = ? AND harness = ? AND adapter_scope_id = ? AND vendor_session_id = ?
    `).get(
      incoming.runtimeNodeId,
      incoming.harness,
      incoming.adapterScopeId,
      incoming.vendorSessionId,
    ) as Row | undefined;
    const nativeOwner = nativeOwnerRow
      ? parse(sessionRecordSchema, nativeOwnerRow.record_json)
      : null;
    if (nativeOwner && nativeOwner.sessionId !== incoming.sessionId) {
      throw new ControlNodeCoreError(
        "FENCED",
        `native session is already bound to logical session ${nativeOwner.sessionId}`,
      );
    }
    if (current && current.runtimeNodeId !== incoming.runtimeNodeId) {
      throw new ControlNodeCoreError("FENCED", "session identity is already bound to another runtime node");
    }
    if (current && (
      current.harness !== incoming.harness ||
      current.adapterScopeId !== incoming.adapterScopeId ||
      current.vendorSessionId !== incoming.vendorSessionId ||
      current.bindingRevision !== incoming.bindingRevision
    )) {
      throw new ControlNodeCoreError("FENCED", "runtime attempted to replace an existing native session binding");
    }
    const record = sessionRecordSchema.parse({
      ...incoming,
      // Runtime nodes propose metadata through their durable outbox. A session
      // upsert owns liveness/native fields and cannot initialize authority data.
      metadata: current?.metadata ?? emptyMetadataSnapshot(),
      metadataAuthority: this.authority(),
      bindingRevision: current?.bindingRevision ?? incoming.bindingRevision,
      catalogState: current?.catalogState ?? "open",
      catalogRevision: current?.catalogRevision ?? 1,
      archivedAt: current?.archivedAt ?? null,
      createdAt: current?.createdAt ?? incoming.createdAt,
    });
    this.#mutate(() => {
      if (current && current.runtimeEpoch !== record.runtimeEpoch) {
        this.#stalePendingInteractionsForSession(current.sessionId, this.#timestamp());
      }
      this.#putSession(record, null);
      this.#settleLifecycleForSession(record);
      this.#appendControl({ type: "session.upsert", session: record });
    });
    this.applyPendingLifecycleMetadata(record.runtimeNodeId);
    return this.getSession(record.sessionId)!;
  }

  public getSession(id: SessionId): SessionRecord | null {
    const row = this.#db.prepare("SELECT record_json FROM sessions WHERE session_id = ?").get(id) as Row | undefined;
    return row ? parse(sessionRecordSchema, row.record_json) : null;
  }

  public listSessions(filter: SessionFilter = {}): SessionRecord[] {
    const rows = this.#db.prepare("SELECT record_json FROM sessions ORDER BY updated_at DESC, session_id").all() as Row[];
    return rows.map((row) => parse(sessionRecordSchema, row.record_json)).filter((session) =>
      (filter.runtimeNodeId === undefined || session.runtimeNodeId === filter.runtimeNodeId) &&
      (filter.harness === undefined || session.harness === filter.harness) &&
      (filter.availability === undefined || filter.availability.includes(session.availability)) &&
      (filter.catalogState?.includes(session.catalogState) ?? session.catalogState === "open"),
    );
  }

  /** Bounded, metadata-indexed keyset search across hot and archived sessions. */
  public searchSessions(inputValue: SessionSearchInput): SessionSearchPage {
    const input = sessionSearchInputSchema.parse(inputValue);
    const fingerprint = sessionSearchFingerprint(input);
    const authority = authorityKey(this.authority());
    const cursor = input.cursor === undefined
      ? null
      : decodeSessionSearchCursor(input.cursor, fingerprint, authority);
    const clauses: string[] = [];
    const parameters: SQLInputValue[] = [];
    const stateClauses: string[] = [];
    if (input.states.includes("running")) {
      stateClauses.push("(s.catalog_state='open' AND s.availability='active')");
    }
    if (input.states.includes("stopped")) {
      stateClauses.push("(s.catalog_state='open' AND s.availability<>'active')");
    }
    if (input.states.includes("archived")) stateClauses.push("s.catalog_state='archived'");
    clauses.push(`(${stateClauses.join(" OR ")})`);

    const addIn = (column: string, values: readonly string[] | undefined): void => {
      if (values === undefined) return;
      clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
      parameters.push(...values);
    };
    addIn("s.runtime_node_id", input.runtimeNodeIds);
    addIn("s.harness", input.harnesses);
    addIn("s.provider_id", input.providerIds);
    addIn("s.profile_id", input.profileIds);
    if (input.lastActivityAfter !== undefined) {
      clauses.push("COALESCE(s.last_activity_at,s.updated_at) >= ?");
      parameters.push(input.lastActivityAfter);
    }
    if (input.lastActivityBefore !== undefined) {
      clauses.push("COALESCE(s.last_activity_at,s.updated_at) <= ?");
      parameters.push(input.lastActivityBefore);
    }
    for (const predicate of input.metadata) {
      if (predicate.operator === "exists") {
        clauses.push(`EXISTS (
          SELECT 1 FROM session_metadata_index mi
          WHERE mi.session_id=s.session_id AND mi.key=?
        )`);
        parameters.push(predicate.key);
      } else {
        const valueJson = canonicalJson(predicate.value);
        clauses.push(`EXISTS (
          SELECT 1 FROM session_metadata_index mi
          WHERE mi.session_id=s.session_id AND mi.key=?
            AND mi.value_hash=? AND mi.value_json=?
        )`);
        parameters.push(
          predicate.key,
          createHash("sha256").update(valueJson).digest("hex"),
          valueJson,
        );
      }
    }
    if (cursor !== null) {
      clauses.push(`(
        COALESCE(s.last_activity_at,s.updated_at) < ? OR
        (COALESCE(s.last_activity_at,s.updated_at) = ? AND s.session_id > ?)
      )`);
      parameters.push(cursor.activityAt, cursor.activityAt, cursor.sessionId);
    }

    const rows = this.#db.prepare(`
      SELECT s.record_json, COALESCE(s.last_activity_at,s.updated_at) AS activity_at
      FROM sessions s
      WHERE ${clauses.join(" AND ")}
      ORDER BY activity_at DESC, s.session_id ASC
      LIMIT ?
    `).all(...parameters, input.limit + 1) as Row[];
    const hasMore = rows.length > input.limit;
    const visible = hasMore ? rows.slice(0, input.limit) : rows;
    const sessions = visible.map((row) => parse(sessionRecordSchema, row.record_json));
    const tail = hasMore ? visible.at(-1) : undefined;
    return sessionSearchPageSchema.parse({
      sessions,
      nextCursor: tail === undefined
        ? null
        : encodeSessionSearchCursor({
            version: 1,
            fingerprint,
            authority,
            activityAt: String(tail.activity_at),
            sessionId: String((decode(tail.record_json) as Record<string, unknown>).sessionId),
          }),
    });
  }

  /**
   * Build the authority- and query-fenced keyset used when a service merges
   * local and recursive child pages. The cursor format deliberately matches
   * searchSessions so the same anchor can be sent to every node in the tree.
   */
  public sessionSearchCursor(
    inputValue: SessionSearchInput,
    tail: Pick<SessionRecord, "sessionId" | "lastActivityAt" | "updatedAt">,
  ): string {
    const input = sessionSearchInputSchema.parse(inputValue);
    return encodeSessionSearchCursor({
      version: 1,
      fingerprint: sessionSearchFingerprint(input),
      authority: authorityKey(this.authority()),
      activityAt: tail.lastActivityAt ?? tail.updatedAt,
      sessionId: tail.sessionId,
    });
  }

  public recordLaunch(
    input: LaunchRecord,
    projectionSource: ControlNodeId | null = null,
  ): LaunchRecord {
    const incoming = launchRecordSchema.parse(input);
    const current = this.getLaunch(incoming.launchId);
    const record = current === null
      ? incoming
      : mergeLaunchRecord(current, incoming);
    if (current !== null && sameCanonicalJson(current, record)) return current;
    this.#mutate(() => {
      this.#putLaunch(record, projectionSource);
      this.#appendControl({ type: "launch.changed", launch: record });
    });
    return record;
  }

  public getLaunch(id: LaunchId): LaunchRecord | null {
    const row = this.#db.prepare(
      "SELECT record_json FROM launch_operations WHERE launch_id=?",
    ).get(id) as Row | undefined;
    return row === undefined ? null : parse(launchRecordSchema, row.record_json);
  }

  public listLaunches(inputValue: LaunchListInput): LaunchListPage {
    const input = launchListInputSchema.parse(inputValue);
    const fingerprint = launchListFingerprint(input);
    const authority = authorityKey(this.authority());
    const cursor = input.cursor === undefined
      ? null
      : decodeOperationCursor(input.cursor, fingerprint, authority, "launch");
    const clauses: string[] = [];
    const parameters: SQLInputValue[] = [];
    const add = (column: string, value: string | undefined): void => {
      if (value === undefined) return;
      clauses.push(`${column}=?`);
      parameters.push(value);
    };
    add("runtime_node_id", input.runtimeNodeId);
    add("session_id", input.sessionId);
    add("provider_id", input.providerId);
    add("profile_id", input.profileId);
    if (input.states !== undefined) {
      clauses.push(`state IN (${input.states.map(() => "?").join(",")})`);
      parameters.push(...input.states);
    }
    if (cursor !== null) {
      clauses.push("(updated_at < ? OR (updated_at = ? AND launch_id > ?))");
      parameters.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const rows = this.#db.prepare(`
      SELECT record_json, updated_at, launch_id
      FROM launch_operations
      ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
      ORDER BY updated_at DESC, launch_id ASC
      LIMIT ?
    `).all(...parameters, input.limit + 1) as Row[];
    const hasMore = rows.length > input.limit;
    const visible = hasMore ? rows.slice(0, input.limit) : rows;
    const tail = hasMore ? visible.at(-1) : undefined;
    return {
      launches: visible.map((row) => parse(launchRecordSchema, row.record_json)),
      nextCursor: tail === undefined
        ? null
        : encodeOperationCursor({
            version: 1,
            kind: "launch",
            fingerprint,
            authority,
            updatedAt: String(tail.updated_at),
            id: String(tail.launch_id),
          }),
    };
  }

  /** Cursor anchor for a globally merged recursive launch page. */
  public launchListCursor(
    inputValue: LaunchListInput,
    tail: Pick<LaunchRecord, "launchId" | "updatedAt">,
  ): string {
    const input = launchListInputSchema.parse(inputValue);
    return encodeOperationCursor({
      version: 1,
      kind: "launch",
      fingerprint: launchListFingerprint(input),
      authority: authorityKey(this.authority()),
      updatedAt: tail.updatedAt,
      id: tail.launchId,
    });
  }

  public recordArchive(
    input: ArchiveRecord,
    projectionSource: ControlNodeId | null = null,
  ): ArchiveRecord {
    const incoming = archiveRecordSchema.parse(input);
    this.#assertAuthority(incoming.expectedAuthority);
    const current = this.getArchive(incoming.archiveOperationId);
    let record = current === null
      ? incoming
      : mergeArchiveRecord(current, incoming);
    const session = this.getSession(record.sessionId);
    if (!session) {
      throw new ControlNodeCoreError("NOT_FOUND", "archive session is unknown");
    }
    if (
      session.runtimeNodeId !== record.runtimeNodeId ||
      session.bindingRevision !== record.bindingRevision
    ) {
      throw new ControlNodeCoreError("FENCED", "archive targets a stale session binding");
    }
    if (record.state === "succeeded" && session.catalogState === "open") {
      if (session.availability === "active" || session.runtimeStatus !== "stopped") {
        throw new ControlNodeCoreError(
          "CONFLICT",
          "only a stopped session can be archived",
        );
      }
      record = archiveRecordSchema.parse({
        ...record,
        authority: this.authority(),
        expectedAuthority: this.authority(),
        catalogRevision: session.catalogRevision + 1,
      });
    }
    if (current !== null && sameCanonicalJson(current, record)) {
      if (record.state === "succeeded" && session.catalogState === "archived") {
        this.#transaction(() => {
          this.#deleteMetadataDeliveryIntentsForSession(session.sessionId);
        });
      }
      return current;
    }
    this.#mutate(() => {
      this.#putArchive(record, projectionSource);
      this.#appendControl({ type: "archive.changed", archive: record });
      if (record.state === "succeeded" && session.catalogState === "open") {
        const timestamp = record.releasedAt ?? this.#timestamp();
        this.#stalePendingInteractionsForSession(session.sessionId, timestamp);
        this.#deleteMetadataDeliveryIntentsForSession(session.sessionId);
        const archived = sessionRecordSchema.parse({
          ...session,
          availability: "unavailable",
          runtimeStatus: "stopped",
          runtimeEpoch: null,
          catalogState: "archived",
          catalogRevision: record.catalogRevision,
          archivedAt: timestamp,
          updatedAt: timestamp,
        });
        this.#putSession(archived, projectionSource);
        this.#appendControl({ type: "session.upsert", session: archived });
      }
    });
    return record;
  }

  public getArchive(id: ArchiveOperationId): ArchiveRecord | null {
    const row = this.#db.prepare(
      "SELECT record_json FROM archive_operations WHERE archive_operation_id=?",
    ).get(id) as Row | undefined;
    return row === undefined ? null : parse(archiveRecordSchema, row.record_json);
  }

  public markSessionStopped(
    sessionId: SessionId,
    bindingRevision: number,
  ): SessionRecord {
    const current = this.getSession(sessionId);
    if (!current) throw new ControlNodeCoreError("NOT_FOUND", "session is unknown");
    if (current.bindingRevision !== bindingRevision || current.catalogState !== "open") {
      throw new ControlNodeCoreError("FENCED", "stop targets a stale session binding");
    }
    if (current.runtimeStatus === "stopped" && current.availability !== "active") {
      return current;
    }
    const stopped = sessionRecordSchema.parse({
      ...current,
      availability: "resumable",
      runtimeStatus: "stopped",
      runtimeEpoch: null,
      updatedAt: this.#timestamp(),
    });
    this.#mutate(() => {
      this.#stalePendingInteractionsForSession(stopped.sessionId, stopped.updatedAt);
      this.#putSession(stopped, this.#projectionSource(
        "sessions",
        "session_id",
        stopped.sessionId,
      ));
      this.#appendControl({ type: "session.upsert", session: stopped });
    });
    return stopped;
  }

  public getMetadata(sessionId: SessionId): MetadataSnapshot {
    const session = this.getSession(sessionId);
    if (!session) throw new ControlNodeCoreError("NOT_FOUND", `session ${sessionId} is unknown`);
    return session.metadata;
  }

  public submitMetadataPatch(patchInput: MetadataPatch, originControlNodeId = this.#controlNodeId): MetadataOperationRecord {
    const patch = metadataPatchSchema.parse(patchInput);
    this.#assertAuthority(patch.expectedAuthority);
    const existing = this.getMetadataOperation(patch.operationId);
    if (existing) {
      if (
        !sameMetadataPatch(existing.patch, patch) ||
        existing.originControlNodeId !== originControlNodeId
      ) {
        throw new ControlNodeCoreError(
          "PAYLOAD_MISMATCH",
          "metadata operation ID was reused with another immutable identity",
        );
      }
      const needsRelayAdoption = this.dataRole().role === "branch" &&
        existing.status === "queued" &&
        (
          this.#projectionSource(
            "metadata_operations",
            "operation_id",
            existing.operationId,
          ) !== null ||
          this.#db.prepare(
            "SELECT 1 AS present FROM metadata_outbox WHERE operation_id = ?",
          ).get(existing.operationId) === undefined
        );
      if (needsRelayAdoption) {
        // A child's aggregate feed can reveal its durable proposal before the
        // independent outbox RPC reaches this branch. Adopt that projected
        // record into the local relay journal and outbox atomically. Without
        // this transition every later child retry merely finds the projected
        // row and the operation can never advance to the authority.
        this.#mutate(() => {
          this.#putMetadataOperation(existing, null);
          this.#db.prepare(`
            INSERT OR IGNORE INTO metadata_outbox(operation_id, created_at)
            VALUES (?, ?)
          `).run(existing.operationId, existing.createdAt);
        });
      }
      return existing;
    }
    const session = this.getSession(patch.sessionId);
    if (!session) throw new ControlNodeCoreError("NOT_FOUND", "metadata session is unknown");
    const timestamp = this.#timestamp();
    if (this.dataRole().role === "branch") {
      const operation = metadataOperationRecordSchema.parse({
        operationId: patch.operationId,
        sessionId: patch.sessionId,
        patch,
        status: "queued",
        canonical: session.metadata,
        optimistic: optimisticMetadata(session.metadata, patch),
        originControlNodeId,
        authority: this.authority(),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      this.#mutate(() => {
        this.#putMetadataOperation(operation, null);
        this.#db.prepare("INSERT INTO metadata_outbox(operation_id, created_at) VALUES (?, ?)")
          .run(operation.operationId, timestamp);
        this.#appendControl({ type: "metadata.operation", operation });
      });
      return operation;
    }
    return this.#commitMetadataAtAuthority(patch, session, originControlNodeId, timestamp);
  }

  public applyMetadataAtAuthority(operationInput: MetadataOperationRecord): MetadataOperationRecord {
    if (this.dataRole().role !== "authority") throw new ControlNodeCoreError("FENCED", "branch cannot commit canonical metadata");
    const incoming = metadataOperationRecordSchema.parse(operationInput);
    this.#assertAuthority(incoming.authority);
    const existing = this.getMetadataOperation(incoming.operationId);
    if (existing) {
      assertSameMetadataOperationIdentity(existing, incoming);
      if (existing.status !== "queued") return existing;
    }
    const session = this.getSession(incoming.sessionId);
    if (!session) throw new ControlNodeCoreError("NOT_FOUND", "metadata session is unknown");
    return this.#commitMetadataAtAuthority(incoming.patch, session, incoming.originControlNodeId, incoming.createdAt);
  }

  /**
   * Adopt a terminal receipt from the authority. A receipt not already in the
   * local journal is accepted only when the caller has authenticated the
   * currently attached parent; ordinary catalog callers cannot invent one.
   */
  public settleMetadataOperation(
    input: MetadataOperationRecord,
    options: { authenticatedParent?: boolean } = {},
  ): MetadataOperationRecord {
    const operation = metadataOperationRecordSchema.parse(input);
    if (operation.status === "queued") throw new ControlNodeCoreError("CONFLICT", "settlement must be terminal");
    this.#assertAuthority(operation.authority);
    const current = this.getMetadataOperation(operation.operationId);
    if (current) assertSameMetadataOperationIdentity(current, operation);
    if (current && current.status !== "queued") {
      if (canonicalProtocolRecordJson(current) !== canonicalProtocolRecordJson(operation)) {
        throw new ControlNodeCoreError("PAYLOAD_MISMATCH", "metadata operation was settled twice with different results");
      }
      return current;
    }
    const session = this.getSession(operation.sessionId);
    if (!session) throw new ControlNodeCoreError("NOT_FOUND", "metadata session is unknown");
    if (!sameAuthority(session.metadataAuthority, operation.authority)) {
      throw new ControlNodeCoreError("FENCED", "metadata settlement targets a session with another authority fence");
    }
    if (!current) {
      const role = this.dataRole();
      if (
        options.authenticatedParent !== true ||
        role.role !== "branch" ||
        role.branch.lifecycle !== "attached"
      ) {
        throw new ControlNodeCoreError(
          "FENCED",
          "only an authenticated parent may deliver a first-observed terminal metadata receipt to its attached branch",
        );
      }
    }
    if (
      operation.canonical.revision === session.metadata.revision &&
      !sameCanonicalJson(operation.canonical, session.metadata)
    ) {
      throw new ControlNodeCoreError(
        "CONFLICT",
        "metadata settlement diverged at an already canonical revision",
      );
    }
    const advancesCanonical =
      operation.canonical.revision > session.metadata.revision;
    this.#mutate(() => {
      this.#putMetadataOperation(operation, null);
      if (advancesCanonical) {
        const updated = {
          ...session,
          metadata: operation.canonical,
          metadataAuthority: operation.authority,
          updatedAt: this.#timestamp(),
        };
        this.#putSession(
          updated,
          this.#projectionSource("sessions", "session_id", session.sessionId),
        );
      }
      this.#db.prepare("DELETE FROM metadata_outbox WHERE operation_id = ?").run(operation.operationId);
      if (advancesCanonical) {
        this.#appendControl({
          type: "metadata.changed",
          sessionId: session.sessionId,
          metadata: operation.canonical,
        });
      }
      this.#appendControl({ type: "metadata.operation", operation });
      if (session.catalogState === "open") {
        this.#enqueueDeliveryIntent("metadata", session.runtimeNodeId, operation.operationId, operation);
      }
    });
    return operation;
  }

  public pendingMetadataOutbox(limit = 1_000): MetadataOperationRecord[] {
    const rows = this.#db.prepare(`
      SELECT m.record_json FROM metadata_outbox o
      JOIN metadata_operations m ON m.operation_id = o.operation_id
      ORDER BY o.sequence LIMIT ?
    `).all(limit) as Row[];
    return rows.map((row) => parse(metadataOperationRecordSchema, row.record_json));
  }

  /** Terminal receipts awaiting idempotent delivery toward the owning runtime. */
  public pendingMetadataDeliveries(limit = 1_000): MetadataDeliveryIntent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("metadata delivery limit must be between 1 and 1000");
    }
    const rows = this.#db.prepare(`
      SELECT sequence, destination_id, payload_json
      FROM delivery_intents
      WHERE kind = 'metadata' AND delivered = 0
      ORDER BY sequence
      LIMIT ?
    `).all(limit) as Row[];
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      destinationRuntimeNodeId: String(row.destination_id) as RuntimeNodeId,
      operation: parse(metadataOperationRecordSchema, row.payload_json),
    }));
  }

  /** Delete only the exact receipt which a downstream peer acknowledged. */
  public acknowledgeMetadataDelivery(
    sequence: number,
    destinationRuntimeNodeId: RuntimeNodeId,
    operationId: string,
  ): boolean {
    if (!Number.isSafeInteger(sequence) || sequence < 1) return false;
    const result = this.#db.prepare(`
      DELETE FROM delivery_intents
      WHERE sequence = ? AND kind = 'metadata' AND destination_id = ? AND identity = ?
    `).run(sequence, destinationRuntimeNodeId, operationId);
    return Number(result.changes) === 1;
  }

  public getMetadataOperation(id: string): MetadataOperationRecord | null {
    const row = this.#db.prepare("SELECT record_json FROM metadata_operations WHERE operation_id = ?").get(id) as Row | undefined;
    return row ? parse(metadataOperationRecordSchema, row.record_json) : null;
  }

  public listMetadataOperations(options: {
    sessionId?: SessionId;
    originControlNodeId?: ControlNodeId;
    statuses?: readonly MetadataOperationStatus[];
    limit?: number;
  } = {}): MetadataOperationRecord[] {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
      throw new RangeError("metadata operation limit must be between 1 and 100000");
    }
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.sessionId !== undefined) {
      where.push("session_id = ?");
      parameters.push(options.sessionId);
    }
    if (options.originControlNodeId !== undefined) {
      where.push("origin_control_node_id = ?");
      parameters.push(options.originControlNodeId);
    }
    if (options.statuses !== undefined) {
      if (options.statuses.length === 0) return [];
      where.push(`status IN (${options.statuses.map(() => "?").join(",")})`);
      parameters.push(...options.statuses);
    }
    parameters.push(limit);
    const rows = this.#db.prepare(`
      SELECT record_json FROM metadata_operations
      ${where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`}
      ORDER BY updated_at DESC, operation_id
      LIMIT ?
    `).all(...parameters) as Row[];
    return rows.map((row) => parse(metadataOperationRecordSchema, row.record_json));
  }

  public acceptCommand(
    input: CommandRecord,
    lifecycleInput?: LegacyLifecycleCommand,
  ): CommandRecord {
    const command = commandRecordSchema.parse(input);
    if (lifecycleInput) this.#assertLifecycleCommand(command, lifecycleInput);
    const current = this.getCommand(command.commandId);
    if (current) {
      assertSameCommandRequest(current, command);
      if (lifecycleInput) {
        this.#mutate(() => this.#putLifecycleIntent(current, lifecycleInput));
      }
      return current;
    }
    this.#mutate(() => {
      this.#putCommand(command);
      if (lifecycleInput) this.#putLifecycleIntent(command, lifecycleInput);
      this.#appendControl({ type: "command.changed", command });
    });
    return command;
  }

  public updateCommand(input: CommandRecord): CommandRecord {
    const command = commandRecordSchema.parse(input);
    const current = this.getCommand(command.commandId);
    if (!current) {
      throw new ControlNodeCoreError("NOT_FOUND", "command response has no accepted request");
    }
    const merged = mergeCommandRecord(current, command, false);
    if (sameCanonicalJson(current, merged)) return current;
    this.#mutate(() => {
      this.#putCommand(merged);
      this.#syncLifecycleIntentForCommand(merged);
      this.#appendControl({ type: "command.changed", command: merged });
    });
    return merged;
  }

  /**
   * Reconcile a command whose dispatch acknowledgement was lost. This is the
   * only local transition which may refine outcomeUnknown to a known terminal
   * result, and it still requires the exact accepted request identity.
   */
  public recoverCommandOutcome(input: CommandRecord): CommandRecord {
    const command = commandRecordSchema.parse(input);
    const current = this.getCommand(command.commandId);
    if (!current) {
      throw new ControlNodeCoreError("NOT_FOUND", "recovered command has no accepted request");
    }
    const merged = mergeCommandRecord(current, command, true);
    if (sameCanonicalJson(current, merged)) return current;
    this.#mutate(() => {
      this.#putCommand(merged);
      this.#syncLifecycleIntentForCommand(merged);
      this.#appendControl({ type: "command.changed", command: merged });
    });
    return merged;
  }

  public hasLifecycleIntent(commandId: CommandId): boolean {
    return this.#db
      .prepare("SELECT 1 AS present FROM lifecycle_intents WHERE command_id = ?")
      .get(commandId) !== undefined;
  }

  /** Apply spawn metadata exactly once after its preallocated session is bound. */
  public applyPendingLifecycleMetadata(runtimeNodeId: RuntimeNodeId): number {
    const rows = this.#db.prepare(`
      SELECT command_id, session_id, metadata_json, metadata_operation_id
      FROM lifecycle_intents
      WHERE runtime_node_id = ? AND binding_state = 'bound'
        AND metadata_applied = 0 AND metadata_json IS NOT NULL
      ORDER BY created_at, command_id
    `).all(runtimeNodeId) as Row[];
    let applied = 0;
    for (const row of rows) {
      const session = this.getSession(row.session_id as SessionId);
      if (!session) continue;
      this.submitMetadataPatch(
        {
          operationId: operationIdSchema.parse(row.metadata_operation_id),
          sessionId: row.session_id as SessionId,
          expectedAuthority: session.metadataAuthority,
          set: metadataValuesSchema.parse(decode(row.metadata_json)),
        },
        this.#controlNodeId,
      );
      this.#db.prepare(
        "UPDATE lifecycle_intents SET metadata_applied = 1 WHERE command_id = ?",
      ).run(String(row.command_id));
      applied += 1;
    }
    return applied;
  }

  public getCommand(id: CommandId | string): CommandRecord | null {
    const row = this.#db.prepare("SELECT record_json FROM commands WHERE command_id = ?").get(id) as Row | undefined;
    return row ? parse(commandRecordSchema, row.record_json) : null;
  }

  public publishInteraction(input: InteractionRecord): InteractionRecord {
    const interaction = interactionRecordSchema.parse(input);
    const session = this.getSession(interaction.sessionId);
    if (!session) throw new ControlNodeCoreError("NOT_FOUND", "interaction session is unknown");
    if (
      session.harness !== interaction.harness ||
      session.runtimeEpoch !== interaction.runtimeEpoch
    ) {
      throw new ControlNodeCoreError("FENCED", "interaction targets a stale runtime epoch");
    }
    const current = this.getInteraction(interaction.interactionId);
    const merged = current
      ? mergeInteractionRecord(current, interaction)
      : interaction;
    if (current && sameCanonicalJson(current, merged)) return current;
    this.#mutate(() => {
      this.#putInteraction(merged, null);
      this.#appendControl({ type: "interaction.changed", interaction: merged });
    });
    return merged;
  }

  public getInteraction(id: string): InteractionRecord | null {
    const row = this.#db.prepare("SELECT record_json FROM interactions WHERE interaction_id = ?").get(id) as Row | undefined;
    return row ? parse(interactionRecordSchema, row.record_json) : null;
  }

  public updateInteraction(input: InteractionRecord): InteractionRecord {
    const interaction = interactionRecordSchema.parse(input);
    const current = this.getInteraction(interaction.interactionId);
    if (!current) throw new ControlNodeCoreError("NOT_FOUND", "interaction is unknown");
    const session = this.getSession(current.sessionId);
    if (
      !session ||
      session.harness !== current.harness ||
      session.runtimeEpoch !== current.runtimeEpoch
    ) {
      throw new ControlNodeCoreError("FENCED", "interaction targets a stale runtime epoch");
    }
    const merged = mergeInteractionRecord(current, interaction);
    if (sameCanonicalJson(current, merged)) return current;
    this.#mutate(() => {
      this.#putInteraction(merged, null);
      this.#appendControl({ type: "interaction.changed", interaction: merged });
    });
    return merged;
  }

  public listInteractions(options: { sessionId?: SessionId; pendingOnly?: boolean } = {}): InteractionRecord[] {
    const rows = this.#db.prepare("SELECT record_json FROM interactions ORDER BY created_at DESC").all() as Row[];
    return rows.map((row) => parse(interactionRecordSchema, row.record_json)).filter((interaction) =>
      (options.sessionId === undefined || interaction.sessionId === options.sessionId) &&
      (options.pendingOnly === false || interaction.state === "pending"),
    );
  }

  public expireInteractions(at: Date = this.#now()): number {
    const expired = this.listInteractions({ pendingOnly: true }).filter(
      (interaction) => interaction.expiresAt !== null && interaction.expiresAt <= at.toISOString(),
    );
    for (const interaction of expired) {
      this.updateInteraction(interactionRecordSchema.parse({
        ...interaction,
        state: "expired",
        resolvedAt: at.toISOString(),
      }));
    }
    return expired.length;
  }

  public enrollPeer(endpointId: string, role: string, principalId: string, scopes: readonly string[] = []): void {
    this.#transaction(() => this.#enrollPeer(endpointId, role, principalId, scopes));
  }

  #enrollPeer(
    endpointId: string,
    role: string,
    principalId: string,
    scopes: readonly string[],
  ): void {
    if (!endpointId || !role || !principalId) {
      throw new TypeError("peer enrollment identity fields must be non-empty");
    }
    const current = this.#db.prepare("SELECT role, principal_id FROM peer_enrollments WHERE endpoint_id = ?")
      .get(endpointId) as Row | undefined;
    if (current && (current.role !== role || current.principal_id !== principalId)) {
      throw new ControlNodeCoreError("FENCED", "endpoint is already pinned to another role or principal");
    }
    const otherEndpoint = this.#db.prepare(`
      SELECT endpoint_id FROM peer_enrollments
      WHERE role = ? AND principal_id = ? AND endpoint_id <> ?
    `).get(role, principalId, endpointId) as Row | undefined;
    if (otherEndpoint) {
      throw new ControlNodeCoreError(
        "FENCED",
        "principal is already pinned to another endpoint",
      );
    }
    this.#db.prepare(`
      INSERT INTO peer_enrollments(endpoint_id, role, principal_id, scopes_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(endpoint_id) DO UPDATE SET scopes_json=excluded.scopes_json
    `).run(endpointId, role, principalId, encode(scopes), this.#timestamp());
  }

  public activePeerEnrollment(endpointId: string): { role: string; principalId: string; scopes: string[] } | null {
    const row = this.#db.prepare("SELECT role, principal_id, scopes_json FROM peer_enrollments WHERE endpoint_id = ?")
      .get(endpointId) as Row | undefined;
    if (!row) return null;
    const enrollment = {
      role: String(row.role),
      principalId: String(row.principal_id),
      scopes: z.array(z.string()).parse(decode(row.scopes_json)),
    };
    if (enrollment.role === "runtime-node") {
      const runtime = this.getRuntimeNode(enrollment.principalId as RuntimeNodeId);
      if (
        !runtime ||
        runtime.ownerControlNodeId !== this.#controlNodeId ||
        runtime.endpointId !== endpointId ||
        this.#projectionSource(
          "runtime_nodes",
          "runtime_node_id",
          enrollment.principalId,
        ) !== null
      ) return null;
    } else if (enrollment.role === "child-control-node") {
      const child = this.getControlNode(enrollment.principalId as ControlNodeId);
      if (!child || child.endpointId !== endpointId || !this.getAttachment(child.controlNodeId)) {
        return null;
      }
    }
    return enrollment;
  }

  #sessionsForInventory(snapshot: InventorySnapshot): SessionRecord[] {
    return snapshot.sessions.flatMap((item) => {
      const row = this.#db.prepare(`
        SELECT record_json FROM sessions
        WHERE runtime_node_id = ? AND harness = ? AND adapter_scope_id = ?
          AND vendor_session_id = ?
      `).get(
        snapshot.runtimeNodeId,
        item.harness,
        item.adapterScopeId,
        item.vendorSessionId,
      ) as Row | undefined;
      return row ? [parse(sessionRecordSchema, row.record_json)] : [];
    });
  }

  #pendingLifecycleIntents(runtimeNodeId: RuntimeNodeId): PendingLifecycleIntent[] {
    const rows = this.#db.prepare(`
      SELECT command_id, session_id, harness, vendor_session_id
      FROM lifecycle_intents
      WHERE runtime_node_id = ? AND ready = 1 AND binding_state = 'pending'
        AND vendor_session_id IS NOT NULL
      ORDER BY created_at, command_id
    `).all(runtimeNodeId) as Row[];
    return rows.map((row) => ({
      commandId: row.command_id as CommandId,
      sessionId: row.session_id as SessionId,
      harness: row.harness as Harness,
      vendorSessionId: String(row.vendor_session_id),
    }));
  }

  #unresolvedSpawnHarnesses(runtimeNodeId: RuntimeNodeId): Set<Harness> {
    const rows = this.#db.prepare(`
      SELECT DISTINCT lifecycle_intents.harness
      FROM lifecycle_intents
      JOIN commands ON commands.command_id = lifecycle_intents.command_id
      WHERE lifecycle_intents.runtime_node_id = ?
        AND lifecycle_intents.ready = 0
        AND lifecycle_intents.binding_state = 'pending'
        AND lifecycle_intents.vendor_session_id IS NULL
        AND commands.state IN ('received','started','outcomeUnknown')
    `).all(runtimeNodeId) as Row[];
    return new Set(rows.map((row) => row.harness as Harness));
  }

  #unresolvedLifecycleNativeKeys(runtimeNodeId: RuntimeNodeId): Set<string> {
    const rows = this.#db.prepare(`
      SELECT lifecycle_intents.harness, lifecycle_intents.vendor_session_id
      FROM lifecycle_intents
      JOIN commands ON commands.command_id = lifecycle_intents.command_id
      WHERE lifecycle_intents.runtime_node_id = ?
        AND lifecycle_intents.ready = 0
        AND lifecycle_intents.binding_state = 'pending'
        AND lifecycle_intents.vendor_session_id IS NOT NULL
        AND commands.state IN ('received','started','outcomeUnknown')
    `).all(runtimeNodeId) as Row[];
    return new Set(
      rows.map((row) => `${String(row.harness)}\0${String(row.vendor_session_id)}`),
    );
  }

  /**
   * Correlate native inventory with v4 launch reservations. A native session
   * can become visible before its session.upsert event reaches the authority;
   * importing it under a fresh logical ID would permanently steal the native
   * binding from the launch's preallocated session ID.
   */
  #launchInventoryState(runtimeNodeId: RuntimeNodeId): {
    readonly unresolvedHarnesses: Set<Harness>;
    readonly bindings: Map<string, LaunchInventoryBinding>;
  } {
    const rows = this.#db.prepare(`
      SELECT record_json FROM launch_operations
      WHERE runtime_node_id = ? AND projection_source IS NULL
        AND (
          state IN ('accepted','preparing','nativeStarting','cleanupPending','outcomeUnknown')
          OR (
            state = 'succeeded' AND NOT EXISTS (
              SELECT 1 FROM sessions
              WHERE sessions.session_id = launch_operations.session_id
            )
          )
        )
      ORDER BY updated_at, launch_id
    `).all(runtimeNodeId) as Row[];
    const unresolvedHarnesses = new Set<Harness>();
    const bindings = new Map<string, LaunchInventoryBinding>();
    for (const row of rows) {
      const launch = parse(launchRecordSchema, row.record_json);
      if (
        launch.state === "accepted" ||
        launch.state === "preparing" ||
        launch.state === "nativeStarting" ||
        launch.state === "cleanupPending" ||
        launch.state === "outcomeUnknown"
      ) {
        unresolvedHarnesses.add(launch.harness);
        continue;
      }
      if (launch.state !== "succeeded") continue;
      const result = launch.result;
      if (result === undefined) {
        throw new ControlNodeCoreError(
          "CONFLICT",
          `successful launch ${launch.launchId} has no native binding`,
        );
      }
      const key = [launch.harness, result.adapterScopeId, result.vendorSessionId].join("\0");
      const existing = bindings.get(key);
      if (existing) {
        throw new ControlNodeCoreError(
          "CONFLICT",
          `native session ${result.vendorSessionId} is claimed by multiple successful launches`,
        );
      }
      bindings.set(key, { launch, result, sessionId: launch.sessionId });
    }
    return { unresolvedHarnesses, bindings };
  }

  #settleLifecycleIntent(
    commandId: CommandId,
    state: "bound" | "conflicted",
    error?: string,
  ): void {
    this.#db.prepare(`
      UPDATE lifecycle_intents
      SET binding_state = ?, binding_error = ?
      WHERE command_id = ? AND binding_state = 'pending'
    `).run(state, error ?? null, commandId);
  }

  #settleLifecycleForSession(session: SessionRecord): void {
    const rows = this.#db.prepare(`
      SELECT command_id, session_id
      FROM lifecycle_intents
      WHERE runtime_node_id = ? AND harness = ? AND vendor_session_id = ?
        AND ready = 1 AND binding_state = 'pending'
      ORDER BY created_at, command_id
    `).all(
      session.runtimeNodeId,
      session.harness,
      session.vendorSessionId,
    ) as Row[];
    for (const row of rows) {
      const commandId = row.command_id as CommandId;
      if (row.session_id === session.sessionId) {
        this.#settleLifecycleIntent(commandId, "bound");
      } else {
        this.#settleLifecycleIntent(
          commandId,
          "conflicted",
          `native session is already bound to ${session.sessionId}`,
        );
      }
    }
  }

  #putLifecycleIntent(
    command: CommandRecord,
    input: LegacyLifecycleCommand,
  ): void {
    this.#assertLifecycleCommand(command, input);
    const metadata = "metadata" in input
      ? metadataValuesSchema.parse(input.metadata ?? {})
      : {};
    const metadataJson = Object.keys(metadata).length > 0 ? encode(metadata) : null;
    const requestedVendorSessionId = "vendorSessionId" in input.request
      ? input.request.vendorSessionId
      : undefined;
    const resultVendorSessionId = command.state === "succeeded"
      ? this.#commandVendorSessionId(command)
      : undefined;
    if (
      requestedVendorSessionId &&
      resultVendorSessionId &&
      requestedVendorSessionId !== resultVendorSessionId
    ) {
      throw new ControlNodeCoreError(
        "PAYLOAD_MISMATCH",
        "runtime resumed a native session other than the one requested",
      );
    }
    const vendorSessionId = resultVendorSessionId ?? requestedVendorSessionId;
    const ready = command.state === "succeeded" && vendorSessionId !== undefined;
    const current = this.#db.prepare(`
      SELECT runtime_node_id, session_id, harness, vendor_session_id, metadata_json
      FROM lifecycle_intents WHERE command_id = ?
    `).get(input.commandId) as Row | undefined;
    if (current) {
      const currentMetadata = current.metadata_json === null
        ? {}
        : metadataValuesSchema.parse(decode(current.metadata_json));
      if (
        current.runtime_node_id !== input.runtimeNodeId ||
        current.session_id !== input.sessionId ||
        current.harness !== input.request.harness ||
        !sameCanonicalJson(currentMetadata, metadata)
      ) {
        throw new ControlNodeCoreError(
          "PAYLOAD_MISMATCH",
          `command ${input.commandId} has another lifecycle binding intent`,
        );
      }
      if (
        current.vendor_session_id !== null &&
        vendorSessionId !== undefined &&
        current.vendor_session_id !== vendorSessionId
      ) {
        throw new ControlNodeCoreError(
          "PAYLOAD_MISMATCH",
          `command ${input.commandId} resolved to another native session`,
        );
      }
      if (ready) {
        this.#db.prepare(`
          UPDATE lifecycle_intents SET vendor_session_id = ?, ready = 1
          WHERE command_id = ?
        `).run(vendorSessionId, input.commandId);
      }
      return;
    }
    this.#db.prepare(`
      INSERT INTO lifecycle_intents(
        command_id, runtime_node_id, session_id, harness, vendor_session_id,
        ready, binding_state, binding_error, metadata_json,
        metadata_operation_id, metadata_applied, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?)
    `).run(
      input.commandId,
      input.runtimeNodeId,
      input.sessionId,
      input.request.harness,
      vendorSessionId ?? null,
      ready ? 1 : 0,
      metadataJson,
      // Lifecycle commands cross every control-node hop unchanged. Reusing
      // their UUID gives spawn metadata one idempotency identity everywhere.
      operationIdSchema.parse(input.commandId),
      metadataJson === null ? 1 : 0,
      this.#timestamp(),
    );
  }

  #syncLifecycleIntentForCommand(record: CommandRecord): void {
    if (record.state !== "succeeded") return;
    const row = this.#db.prepare(`
      SELECT runtime_node_id, session_id, harness, vendor_session_id
      FROM lifecycle_intents WHERE command_id = ?
    `).get(record.commandId) as Row | undefined;
    if (!row) return;
    const vendorSessionId = this.#commandVendorSessionId(record);
    if (row.vendor_session_id !== null && row.vendor_session_id !== vendorSessionId) {
      throw new ControlNodeCoreError(
        "PAYLOAD_MISMATCH",
        `command ${record.commandId} succeeded for another native session`,
      );
    }
    this.#db.prepare(`
      UPDATE lifecycle_intents SET vendor_session_id = ?, ready = 1
      WHERE command_id = ?
    `).run(vendorSessionId, record.commandId);

    const session = this.getSession(row.session_id as SessionId);
    if (!session) return;
    if (
      session.runtimeNodeId === row.runtime_node_id &&
      session.harness === row.harness &&
      session.vendorSessionId === vendorSessionId
    ) {
      this.#settleLifecycleIntent(record.commandId, "bound");
    } else {
      this.#settleLifecycleIntent(
        record.commandId,
        "conflicted",
        `logical session ${session.sessionId} already has another native binding`,
      );
    }
  }

  #assertLifecycleCommand(
    record: CommandRecord,
    input: LegacyLifecycleCommand,
  ): void {
    if (
      record.commandId !== input.commandId ||
      record.payloadHash !== input.payloadHash ||
      record.sessionId !== input.sessionId ||
      record.runtimeNodeId !== input.runtimeNodeId ||
      !sameCanonicalJson(record.request, input)
    ) {
      throw new ControlNodeCoreError(
        "PAYLOAD_MISMATCH",
        `command ${record.commandId} does not match its lifecycle binding intent`,
      );
    }
  }

  #commandVendorSessionId(record: CommandRecord): string {
    const result = record.result;
    if (!result || Array.isArray(result) || typeof result !== "object") {
      throw new ControlNodeCoreError(
        "PAYLOAD_MISMATCH",
        `successful lifecycle command ${record.commandId} omitted its result`,
      );
    }
    if (result.sessionId !== record.sessionId) {
      throw new ControlNodeCoreError(
        "PAYLOAD_MISMATCH",
        `successful lifecycle command ${record.commandId} returned another logical session`,
      );
    }
    const vendorSessionId = result.vendorSessionId;
    if (typeof vendorSessionId !== "string" || vendorSessionId.length === 0) {
      throw new ControlNodeCoreError(
        "PAYLOAD_MISMATCH",
        `successful lifecycle command ${record.commandId} omitted its native session ID`,
      );
    }
    return vendorSessionId;
  }

  static #migrateV3(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE control_node_identity (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        control_node_id TEXT NOT NULL UNIQUE,
        feed_id TEXT NOT NULL UNIQUE,
        initial_realm_id TEXT NOT NULL,
        initial_epoch_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE control_node_role (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        revision INTEGER NOT NULL CHECK(revision > 0),
        role_json TEXT NOT NULL CHECK(json_valid(role_json)),
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE role_transitions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        transition_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK(kind IN ('attached','detached','forced-detached','promoted')),
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        committed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL CHECK(json_valid(value_json)),
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE control_nodes (
        control_node_id TEXT PRIMARY KEY,
        projection_source TEXT,
        record_json TEXT NOT NULL CHECK(json_valid(record_json))
      ) STRICT;
      CREATE INDEX control_nodes_projection ON control_nodes(projection_source);
      CREATE TABLE attachments (
        attachment_id TEXT PRIMARY KEY,
        child_control_node_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active','detached','fenced')),
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX attachments_active_child ON attachments(child_control_node_id) WHERE state='active';
      CREATE TABLE runtime_nodes (
        runtime_node_id TEXT PRIMARY KEY,
        owner_control_node_id TEXT NOT NULL,
        projection_source TEXT,
        record_json TEXT NOT NULL CHECK(json_valid(record_json))
      ) STRICT;
      CREATE INDEX runtime_nodes_projection ON runtime_nodes(projection_source);
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        runtime_node_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        adapter_scope_id TEXT NOT NULL,
        vendor_session_id TEXT NOT NULL,
        availability TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        projection_source TEXT,
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        UNIQUE(runtime_node_id,harness,adapter_scope_id,vendor_session_id)
      ) STRICT;
      CREATE INDEX sessions_projection ON sessions(projection_source);
      CREATE TABLE interactions (
        interaction_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        projection_source TEXT,
        record_json TEXT NOT NULL CHECK(json_valid(record_json))
      ) STRICT;
      CREATE INDEX interactions_projection ON interactions(projection_source);
      CREATE TABLE metadata_operations (
        operation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','accepted','conflicted','outcomeUnknown')),
        origin_control_node_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        projection_source TEXT,
        record_json TEXT NOT NULL CHECK(json_valid(record_json))
      ) STRICT;
      CREATE INDEX metadata_operations_projection ON metadata_operations(projection_source);
      CREATE TABLE metadata_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE commands (
        command_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL CHECK(json_valid(record_json))
      ) STRICT;
      CREATE TABLE lifecycle_intents (
        command_id TEXT PRIMARY KEY,
        runtime_node_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        vendor_session_id TEXT,
        ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1)),
        binding_state TEXT NOT NULL DEFAULT 'pending'
          CHECK(binding_state IN ('pending','bound','conflicted')),
        binding_error TEXT,
        metadata_json TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json)),
        metadata_operation_id TEXT NOT NULL,
        metadata_applied INTEGER NOT NULL DEFAULT 0 CHECK(metadata_applied IN (0,1)),
        created_at TEXT NOT NULL,
        FOREIGN KEY(command_id) REFERENCES commands(command_id)
      ) STRICT;
      CREATE INDEX lifecycle_intents_pending
        ON lifecycle_intents(
          runtime_node_id, ready, binding_state, harness, vendor_session_id
        );
      CREATE TABLE inventory_snapshots (
        runtime_node_id TEXT PRIMARY KEY,
        generation TEXT NOT NULL,
        snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
        captured_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE child_checkpoints (
        child_control_node_id TEXT PRIMARY KEY,
        attachment_id TEXT NOT NULL,
        feed_id TEXT NOT NULL,
        control_cursor INTEGER NOT NULL CHECK(control_cursor >= 0),
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE imported_events (
        event_id TEXT PRIMARY KEY,
        child_control_node_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        local_cursor INTEGER NOT NULL,
        imported_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE delivery_intents (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        destination_id TEXT NOT NULL,
        identity TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1)),
        created_at TEXT NOT NULL,
        UNIQUE(kind,destination_id,identity)
      ) STRICT;
      CREATE TABLE peer_enrollments (
        endpoint_id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        scopes_json TEXT NOT NULL CHECK(json_valid(scopes_json)),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE control_feed_state (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        last_cursor INTEGER NOT NULL CHECK(last_cursor >= 0),
        minimum_cursor INTEGER NOT NULL CHECK(minimum_cursor >= 0)
      ) STRICT;
      INSERT INTO control_feed_state(singleton,last_cursor,minimum_cursor) VALUES(1,0,0);
      CREATE TABLE control_events (
        cursor INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        item_json TEXT NOT NULL CHECK(json_valid(item_json)),
        created_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  /**
   * Protocol v4 is a wire-level clean break, but the authority database is
   * upgraded in place. Old hot-feed entries are deliberately discarded and
   * the feed identity is rotated: replaying a v3 projection through v4 schemas
   * would be both invalid and less safe than forcing an atomic snapshot.
   */
  static #migrateV4(database: DatabaseSync): void {
    database.exec(`
      ALTER TABLE sessions ADD COLUMN catalog_state TEXT NOT NULL DEFAULT 'open'
        CHECK(catalog_state IN ('open','archived'));
      ALTER TABLE sessions ADD COLUMN catalog_revision INTEGER NOT NULL DEFAULT 1
        CHECK(catalog_revision > 0);
      ALTER TABLE sessions ADD COLUMN archived_at TEXT;
      ALTER TABLE sessions ADD COLUMN last_activity_at TEXT;
      ALTER TABLE sessions ADD COLUMN provider_id TEXT;
      ALTER TABLE sessions ADD COLUMN profile_id TEXT;

      CREATE INDEX sessions_catalog_activity
        ON sessions(catalog_state, last_activity_at DESC, updated_at DESC, session_id);
      CREATE INDEX sessions_runtime_catalog
        ON sessions(runtime_node_id, catalog_state, updated_at DESC, session_id);
      CREATE INDEX sessions_launch_profile
        ON sessions(provider_id, profile_id, catalog_state, updated_at DESC, session_id);

      CREATE TABLE session_metadata_index (
        session_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value_hash TEXT NOT NULL,
        value_json TEXT NOT NULL CHECK(json_valid(value_json)),
        PRIMARY KEY(session_id, key),
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX session_metadata_lookup
        ON session_metadata_index(key, value_hash, session_id);

      CREATE TABLE launch_operations (
        launch_id TEXT PRIMARY KEY,
        runtime_node_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        projection_source TEXT,
        record_json TEXT NOT NULL CHECK(json_valid(record_json))
      ) STRICT;
      CREATE INDEX launch_operations_query
        ON launch_operations(updated_at DESC, launch_id);
      CREATE INDEX launch_operations_runtime
        ON launch_operations(runtime_node_id, updated_at DESC, launch_id);
      CREATE INDEX launch_operations_projection
        ON launch_operations(projection_source);

      CREATE TABLE archive_operations (
        archive_operation_id TEXT PRIMARY KEY,
        runtime_node_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        projection_source TEXT,
        record_json TEXT NOT NULL CHECK(json_valid(record_json))
      ) STRICT;
      CREATE INDEX archive_operations_query
        ON archive_operations(updated_at DESC, archive_operation_id);
      CREATE INDEX archive_operations_projection
        ON archive_operations(projection_source);
    `);

    const identity = database.prepare(
      "SELECT control_node_id FROM control_node_identity WHERE singleton=1",
    ).get() as Row | undefined;
    const localControlNodeId = identity === undefined
      ? null
      : String(identity.control_node_id);
    const nextFeedId = newFeedId();
    if (localControlNodeId !== null) {
      database.prepare(
        "UPDATE control_node_identity SET feed_id=? WHERE singleton=1",
      ).run(nextFeedId);
    }

    const updateControlNode = database.prepare(
      "UPDATE control_nodes SET record_json=? WHERE control_node_id=?",
    );
    for (const row of database.prepare(
      "SELECT control_node_id, record_json FROM control_nodes",
    ).all() as Row[]) {
      const value = decode(row.record_json) as Record<string, unknown>;
      value.protocolVersion = 4;
      if (String(row.control_node_id) === localControlNodeId) value.feedId = nextFeedId;
      updateControlNode.run(encode(value), String(row.control_node_id));
    }

    const updateRuntime = database.prepare(
      "UPDATE runtime_nodes SET record_json=? WHERE runtime_node_id=?",
    );
    for (const row of database.prepare(
      "SELECT runtime_node_id, record_json FROM runtime_nodes",
    ).all() as Row[]) {
      const value = decode(row.record_json) as Record<string, unknown>;
      value.protocolVersion = 4;
      value.launchProfiles ??= [];
      updateRuntime.run(encode(value), String(row.runtime_node_id));
    }

    const updateSession = database.prepare(`
      UPDATE sessions SET
        catalog_state=?, catalog_revision=?, archived_at=?, last_activity_at=?,
        provider_id=?, profile_id=?, record_json=?
      WHERE session_id=?
    `);
    const putMetadataIndex = database.prepare(`
      INSERT INTO session_metadata_index(session_id,key,value_hash,value_json)
      VALUES(?,?,?,?)
    `);
    for (const row of database.prepare(
      "SELECT session_id, record_json FROM sessions",
    ).all() as Row[]) {
      const value = decode(row.record_json) as Record<string, unknown>;
      const lastActivityAt = typeof value.lastActivityAt === "string"
        ? value.lastActivityAt
        : typeof value.lastSeenAt === "string"
          ? value.lastSeenAt
          : typeof value.updatedAt === "string"
            ? value.updatedAt
            : null;
      value.catalogState = "open";
      value.catalogRevision = 1;
      value.archivedAt = null;
      value.lastActivityAt = lastActivityAt;
      value.launchProvenance = null;
      const parsed = sessionRecordSchema.parse(value);
      updateSession.run(
        parsed.catalogState,
        parsed.catalogRevision,
        parsed.archivedAt,
        parsed.lastActivityAt,
        null,
        null,
        encode(parsed),
        parsed.sessionId,
      );
      for (const [key, metadataValue] of Object.entries(parsed.metadata.values)) {
        const canonical = canonicalJson(metadataValue);
        putMetadataIndex.run(
          parsed.sessionId,
          key,
          createHash("sha256").update(canonical).digest("hex"),
          canonical,
        );
      }
    }

    // v3 inventory generations and lifecycle-intent reconciliation describe
    // the removed spawn API. Native state will be rediscovered after boot.
    database.exec(`
      DELETE FROM inventory_snapshots;
      DELETE FROM lifecycle_intents;
      DELETE FROM imported_events;
      DELETE FROM child_checkpoints;
      DELETE FROM control_events;
      UPDATE control_feed_state SET last_cursor=0, minimum_cursor=0 WHERE singleton=1;
    `);
  }

  #loadOrCreateIdentity(expected?: ControlNodeId): {
    controlNodeId: ControlNodeId;
    feedId: FeedId;
    authority: AuthorityRef;
  } {
    const row = this.#db.prepare(`
      SELECT control_node_id, feed_id, initial_realm_id, initial_epoch_id
      FROM control_node_identity WHERE singleton=1
    `).get() as Row | undefined;
    if (row) {
      if (expected !== undefined && expected !== row.control_node_id) {
        throw new ControlNodeCoreError("FENCED", "database belongs to another control-node identity");
      }
      return {
        controlNodeId: String(row.control_node_id) as ControlNodeId,
        feedId: String(row.feed_id) as FeedId,
        authority: {
          realmId: String(row.initial_realm_id) as AuthorityRef["realmId"],
          controlNodeId: String(row.control_node_id) as ControlNodeId,
          epochId: String(row.initial_epoch_id) as AuthorityRef["epochId"],
        },
      };
    }
    return this.#transaction(() => {
      const controlNodeId = expected ?? newControlNodeId();
      const identity = {
        controlNodeId,
        feedId: newFeedId(),
        authority: { realmId: newRealmId(), controlNodeId, epochId: newAuthorityEpochId() },
      };
      this.#db.prepare(`
        INSERT INTO control_node_identity(singleton,control_node_id,feed_id,initial_realm_id,initial_epoch_id,created_at)
        VALUES(1,?,?,?,?,?)
      `).run(controlNodeId, identity.feedId, identity.authority.realmId, identity.authority.epochId, this.#timestamp());
      this.#db.prepare("INSERT INTO control_node_role(singleton,revision,role_json,updated_at) VALUES(1,1,?,?)")
        .run(encode({ role: "authority", authority: identity.authority }), this.#timestamp());
      return identity;
    });
  }

  #startBoot(options: ControlNodeCatalogOptions): void {
    const previousRow = this.#db.prepare("SELECT record_json FROM control_nodes WHERE control_node_id = ?")
      .get(this.#controlNodeId) as Row | undefined;
    const previous = previousRow ? parse(controlNodeDescriptorSchema, previousRow.record_json) : null;
    const timestamp = this.#timestamp();
    const descriptor = controlNodeDescriptorSchema.parse({
      controlNodeId: this.#controlNodeId,
      controlNodeBootId: options.controlNodeBootId ?? newControlNodeBootId(),
      feedId: this.#feedId,
      name: options.controlNodeName ?? previous?.name ?? "agent-multiplex-control-node",
      ...(options.endpointId ? { endpointId: options.endpointId } : previous?.endpointId ? { endpointId: previous.endpointId } : {}),
      presence: "online",
      dataRole: this.dataRole(),
      connectedAt: timestamp,
      lastHeartbeatAt: timestamp,
      protocolVersion: 4,
      capabilities: [
        "catalog.sqlite-v4",
        "sessions.lifecycle-v4",
        "sessions.search-v1",
        "launch.operations-v1",
        "topology.control-node-tree",
        "authority.explicit-promotion",
        "sources.atomic-snapshot",
        "stream.bounded-replay",
        "terminal.side-channel.v1",
      ],
    });
    this.#mutate(() => {
      this.#putControlNode(descriptor, null);
      this.#appendControl({ type: "controlNode.upsert", controlNode: descriptor });
    });
  }

  #recoverInterruptedState(): void {
    const started = this.#db.prepare(
      "SELECT record_json FROM commands WHERE state IN ('received','started')",
    ).all() as Row[];
    const localOnlineRuntimes = (this.#db.prepare(
      "SELECT record_json FROM runtime_nodes WHERE projection_source IS NULL",
    ).all() as Row[])
      .map((row) => parse(runtimeNodeDescriptorSchema, row.record_json))
      .filter((node) => node.presence === "online");
    const onlineChildren = (this.#db.prepare(`
      SELECT n.record_json
      FROM control_nodes n
      JOIN attachments a ON a.child_control_node_id = n.control_node_id
      WHERE a.state = 'active' AND n.projection_source = n.control_node_id
    `).all() as Row[])
      .map((row) => parse(controlNodeDescriptorSchema, row.record_json))
      .filter((node) => node.presence === "online");
    if (started.length === 0 && localOnlineRuntimes.length === 0 && onlineChildren.length === 0) return;
    this.#mutate(() => {
      for (const row of started) {
        const command = parse(commandRecordSchema, row.record_json);
        const unknown = commandRecordSchema.parse({ ...command, state: "outcomeUnknown", error: "control node restarted before a terminal response", updatedAt: this.#timestamp() });
        this.#putCommand(unknown);
        this.#appendControl({ type: "command.changed", command: unknown });
      }
      for (const runtime of localOnlineRuntimes) {
        const stale = { ...runtime, presence: "stale" as const, reachability: "stale" as const, connectedAt: null };
        this.#putRuntimeNode(stale, null);
        this.#appendControl({ type: "runtimeNode.presence", runtimeNodeId: runtime.runtimeNodeId, presence: "stale" });
      }
      for (const child of onlineChildren) {
        this.#putControlNode({ ...child, presence: "stale", connectedAt: null }, child.controlNodeId);
        this.#markProjectionReachability(child.controlNodeId, "stale");
        this.#appendControl({
          type: "controlNode.presence",
          controlNodeId: child.controlNodeId,
          presence: "stale",
        });
      }
    });
  }

  #commitMetadataAtAuthority(
    patch: MetadataPatch,
    session: SessionRecord,
    originControlNodeId: ControlNodeId,
    createdAt: string,
  ): MetadataOperationRecord {
    let operation!: MetadataOperationRecord;
    this.#mutate(() => {
      const currentSession = this.getSession(session.sessionId)!;
      const result = applyMetadataPatch(currentSession.metadata, patch);
      operation = metadataOperationRecordSchema.parse({
        operationId: patch.operationId,
        sessionId: patch.sessionId,
        patch,
        status: result.accepted ? "accepted" : "conflicted",
        canonical: result.snapshot,
        ...(!result.accepted ? { conflicts: result.conflicts } : {}),
        originControlNodeId,
        authority: this.authority(),
        createdAt,
        updatedAt: this.#timestamp(),
      });
      this.#putMetadataOperation(operation, null);
      const updated = { ...currentSession, metadata: result.snapshot, metadataAuthority: this.authority(), updatedAt: this.#timestamp() };
      this.#putSession(updated, this.#projectionSource("sessions", "session_id", session.sessionId));
      this.#failpoint?.("metadata.authority.afterState");
      this.#appendControl({ type: "metadata.changed", sessionId: session.sessionId, metadata: result.snapshot });
      this.#appendControl({ type: "metadata.operation", operation });
      this.#failpoint?.("metadata.authority.afterEvents");
      if (currentSession.catalogState === "open") {
        this.#enqueueDeliveryIntent("metadata", currentSession.runtimeNodeId, operation.operationId, operation);
      }
      this.#failpoint?.("metadata.authority.afterDeliveryIntent");
    });
    return operation;
  }

  #rewriteSubtreeAuthority(authority: AuthorityRef): void {
    for (const session of this.listSessions({
      catalogState: ["open", "archived"],
    })) {
      this.#putSession({ ...session, metadataAuthority: authority, updatedAt: this.#timestamp() }, this.#projectionSource("sessions", "session_id", session.sessionId));
    }
  }

  #markMetadataOutcomeUnknown(operationId: string): void {
    const operation = this.getMetadataOperation(operationId);
    if (!operation || operation.status !== "queued") return;
    const updated = metadataOperationRecordSchema.parse({ ...operation, status: "outcomeUnknown", optimistic: undefined, updatedAt: this.#timestamp() });
    this.#putMetadataOperation(updated, null);
    this.#appendControl({ type: "metadata.operation", operation: updated });
  }

  /**
   * Metadata is owned by the tree authority, even when the rest of a session
   * record is projected from a child. Child replays may confirm or lag the
   * canonical snapshot, but they cannot advance or fork it.
   */
  #metadataImportedFromChild(
    current: SessionRecord | null,
    incoming: MetadataSnapshot,
  ): MetadataSnapshot {
    if (!current) return incoming;
    if (incoming.revision < current.metadata.revision) return current.metadata;
    if (incoming.revision === current.metadata.revision) {
      if (!sameCanonicalJson(incoming, current.metadata)) {
        throw new ControlNodeCoreError(
          "CONFLICT",
          "child metadata diverged at an already canonical revision",
        );
      }
      return current.metadata;
    }
    throw new ControlNodeCoreError(
      "FENCED",
      "child cannot advance metadata owned by the tree authority",
    );
  }

  /**
   * Merge the child's durable proposal journal into the authority journal.
   * A queued replay is useful for discovery, but only the authority/downstream
   * settlement path may create a terminal receipt. Once terminal, a receipt is
   * immutable and a stale queued replay resolves to that canonical receipt.
   */
  #mergeMetadataOperationImportedFromChild(
    source: ControlNodeId,
    operationInput: MetadataOperationRecord,
  ): MetadataOperationRecord {
    const incoming = metadataOperationRecordSchema.parse(operationInput);
    if (!sameAuthority(incoming.authority, this.authority())) {
      throw new ControlNodeCoreError(
        "FENCED",
        "child metadata operation carries a stale authority fence",
      );
    }
    const current = this.getMetadataOperation(incoming.operationId);
    if (!current) {
      if (incoming.status !== "queued") {
        throw new ControlNodeCoreError(
          "FENCED",
          "a child cannot introduce a terminal metadata receipt",
        );
      }
      return incoming;
    }

    const projectionSource = this.#projectionSource(
      "metadata_operations",
      "operation_id",
      incoming.operationId,
    );
    if (projectionSource !== null && projectionSource !== source) {
      throw new ControlNodeCoreError(
        "CONFLICT",
        "child metadata operation collides with another child projection",
      );
    }
    assertSameMetadataOperationIdentity(current, incoming);
    if (current.status !== "queued") {
      if (incoming.status !== "queued" && !sameCanonicalJson(current, incoming)) {
        throw new ControlNodeCoreError(
          "CONFLICT",
          "terminal metadata receipt cannot be changed",
        );
      }
      return current;
    }
    if (incoming.status !== "queued") {
      throw new ControlNodeCoreError(
        "FENCED",
        "a child cannot settle an operation owned by the metadata authority",
      );
    }
    return current;
  }

  #applyImportedChange(source: ControlNodeId, change: ControlChange): ControlChange {
    switch (change.type) {
      case "controlNode.upsert": this.#putControlNode(change.controlNode, source); break;
      case "controlNode.presence": {
        const current = this.getControlNode(change.controlNodeId);
        if (current) this.#putControlNode({ ...current, presence: change.presence }, source);
        break;
      }
      case "runtimeNode.upsert": this.#putRuntimeNode(change.runtimeNode, source); break;
      case "runtimeNode.presence": {
        const current = this.getRuntimeNode(change.runtimeNodeId);
        if (current) this.#putRuntimeNode({ ...current, presence: change.presence }, source);
        break;
      }
      case "session.upsert": {
        const current = this.getSession(change.session.sessionId);
        if (
          current?.catalogState === "archived" &&
          change.session.catalogState !== "archived"
        ) {
          return { type: "session.upsert", session: current };
        }
        if (
          current !== null &&
          change.session.catalogRevision < current.catalogRevision
        ) {
          return { type: "session.upsert", session: current };
        }
        const session = sessionRecordSchema.parse({
          ...change.session,
          metadata: this.#metadataImportedFromChild(current, change.session.metadata),
          metadataAuthority: this.authority(),
        });
        this.#putSession(session, source);
        return { type: "session.upsert", session };
      }
      case "launch.changed": {
        const current = this.getLaunch(change.launch.launchId);
        const launch = current === null
          ? change.launch
          : mergeLaunchRecord(current, change.launch);
        this.#putLaunch(launch, source);
        return { type: "launch.changed", launch };
      }
      case "archive.changed": {
        const current = this.getArchive(change.archive.archiveOperationId);
        const archive = current === null
          ? change.archive
          : mergeArchiveRecord(current, change.archive);
        this.#putArchive(archive, source);
        if (archive.state === "succeeded") {
          const session = this.getSession(archive.sessionId);
          if (session?.catalogState === "open") {
            this.#deleteMetadataDeliveryIntentsForSession(session.sessionId);
            this.#putSession(sessionRecordSchema.parse({
              ...session,
              availability: "unavailable",
              runtimeStatus: "stopped",
              runtimeEpoch: null,
              catalogState: "archived",
              catalogRevision: archive.catalogRevision,
              archivedAt: archive.releasedAt,
              updatedAt: archive.releasedAt,
            }), source);
          }
        }
        return { type: "archive.changed", archive };
      }
      case "session.unavailable": {
        const current = this.getSession(change.sessionId);
        if (current) this.#putSession({ ...current, availability: "unavailable", updatedAt: this.#timestamp() }, source);
        break;
      }
      case "metadata.changed": {
        const current = this.getSession(change.sessionId);
        if (!current) {
          throw new ControlNodeCoreError(
            "NOT_FOUND",
            "child metadata event targets an unknown session",
          );
        }
        const metadata = this.#metadataImportedFromChild(current, change.metadata);
        this.#putSession(
          { ...current, metadata, updatedAt: this.#timestamp() },
          source,
        );
        return { type: "metadata.changed", sessionId: change.sessionId, metadata };
      }
      case "metadata.operation": {
        const current = this.getMetadataOperation(change.operation.operationId);
        const operation = this.#mergeMetadataOperationImportedFromChild(
          source,
          change.operation,
        );
        const projectionSource = current === null
          ? source
          : current.status !== "queued"
            ? null
            : this.#projectionSource(
              "metadata_operations",
              "operation_id",
              current.operationId,
            );
        this.#putMetadataOperation(operation, projectionSource);
        return { type: "metadata.operation", operation };
      }
      case "command.changed": {
        const current = this.getCommand(change.command.commandId);
        const command = current
          ? mergeCommandRecord(current, change.command, true)
          : change.command;
        this.#putCommand(command);
        return { type: "command.changed", command };
      }
      case "interaction.changed": {
        const current = this.getInteraction(change.interaction.interactionId);
        const interaction = current
          ? mergeInteractionRecord(current, change.interaction)
          : change.interaction;
        this.#putInteraction(interaction, source);
        return { type: "interaction.changed", interaction };
      }
      default: break;
    }
    return change;
  }

  #assertSnapshotOwnership(source: ControlNodeId, snapshot: AccessSnapshot): void {
    const checks: ReadonlyArray<readonly [string, string, string]> = [
      ...snapshot.controlNodes.map((item) => ["control_nodes", "control_node_id", item.controlNodeId] as const),
      ...snapshot.runtimeNodes.map((item) => ["runtime_nodes", "runtime_node_id", item.runtimeNodeId] as const),
      ...snapshot.sessions.map((item) => ["sessions", "session_id", item.sessionId] as const),
      ...snapshot.interactions.map((item) => ["interactions", "interaction_id", item.interactionId] as const),
    ];
    for (const [table, column, identity] of checks) {
      const current = this.#projectionSource(table, column, identity);
      const exists = this.#db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(identity) !== undefined;
      if (exists && current !== source) {
        throw new ControlNodeCoreError("CONFLICT", `child snapshot attempted to take ownership of ${identity}`);
      }
    }
    for (const operation of snapshot.metadataOperations) {
      const current = this.getMetadataOperation(operation.operationId);
      if (!current) continue;
      const projectionSource = this.#projectionSource(
        "metadata_operations",
        "operation_id",
        operation.operationId,
      );
      if (projectionSource !== null && projectionSource !== source) {
        throw new ControlNodeCoreError(
          "CONFLICT",
          `child snapshot attempted to take ownership of ${operation.operationId}`,
        );
      }
    }
  }

  #assertImportedChangeOwnership(source: ControlNodeId, item: FeedControlItem): void {
    const owned = (table: string, column: string, identity: string): boolean =>
      this.#projectionSource(table, column, identity) === source;
    const change = item.change;
    switch (change.type) {
      case "controlNode.upsert": {
        const existing = this.getControlNode(change.controlNode.controlNodeId);
        if (existing && !owned("control_nodes", "control_node_id", change.controlNode.controlNodeId)) {
          throw new ControlNodeCoreError("CONFLICT", "child event attempted to replace a foreign control node");
        }
        if (!sameAuthority(change.controlNode.dataRole.authority, this.authority())) {
          throw new ControlNodeCoreError("FENCED", "child control node carries a stale authority fence");
        }
        break;
      }
      case "controlNode.presence":
        if (!owned("control_nodes", "control_node_id", change.controlNodeId)) throw new ControlNodeCoreError("FENCED", "child presence targets a foreign control node");
        break;
      case "runtimeNode.upsert": {
        const existing = this.getRuntimeNode(change.runtimeNode.runtimeNodeId);
        if (existing && !owned("runtime_nodes", "runtime_node_id", change.runtimeNode.runtimeNodeId)) {
          throw new ControlNodeCoreError("CONFLICT", "child event attempted to replace a foreign runtime node");
        }
        if (!owned("control_nodes", "control_node_id", change.runtimeNode.ownerControlNodeId)) {
          throw new ControlNodeCoreError("FENCED", "child runtime owner is outside its projection");
        }
        break;
      }
      case "runtimeNode.presence":
        if (!owned("runtime_nodes", "runtime_node_id", change.runtimeNodeId)) throw new ControlNodeCoreError("FENCED", "child presence targets a foreign runtime node");
        break;
      case "session.upsert": {
        const existing = this.getSession(change.session.sessionId);
        if (existing && !owned("sessions", "session_id", change.session.sessionId)) {
          throw new ControlNodeCoreError("CONFLICT", "child event attempted to replace a foreign session");
        }
        if (!owned("runtime_nodes", "runtime_node_id", change.session.runtimeNodeId)) {
          throw new ControlNodeCoreError("FENCED", "child session runtime is outside its projection");
        }
        if (!sameAuthority(change.session.metadataAuthority, this.authority())) {
          throw new ControlNodeCoreError(
            "FENCED",
            "child session carries a stale metadata authority fence",
          );
        }
        break;
      }
      case "session.unavailable":
      case "metadata.changed":
        if (!owned("sessions", "session_id", change.sessionId)) throw new ControlNodeCoreError("FENCED", "child event targets a foreign session");
        break;
      case "metadata.operation":
        if (!owned("sessions", "session_id", change.operation.sessionId)) throw new ControlNodeCoreError("FENCED", "child metadata targets a foreign session");
        if (!sameAuthority(change.operation.authority, this.authority())) {
          throw new ControlNodeCoreError(
            "FENCED",
            "child metadata operation carries a stale authority fence",
          );
        }
        break;
      case "interaction.changed":
        if (!owned("sessions", "session_id", change.interaction.sessionId)) throw new ControlNodeCoreError("FENCED", "child interaction targets a foreign session");
        break;
      case "launch.changed": {
        const existing = this.getLaunch(change.launch.launchId);
        if (
          existing &&
          !owned("launch_operations", "launch_id", change.launch.launchId)
        ) {
          throw new ControlNodeCoreError(
            "CONFLICT",
            "child launch event attempted to replace a foreign operation",
          );
        }
        if (!owned("runtime_nodes", "runtime_node_id", change.launch.runtimeNodeId)) {
          throw new ControlNodeCoreError(
            "FENCED",
            "child launch event targets a runtime outside its projection",
          );
        }
        break;
      }
      case "archive.changed": {
        const existing = this.getArchive(change.archive.archiveOperationId);
        if (
          existing &&
          !owned(
            "archive_operations",
            "archive_operation_id",
            change.archive.archiveOperationId,
          )
        ) {
          throw new ControlNodeCoreError(
            "CONFLICT",
            "child archive event attempted to replace a foreign operation",
          );
        }
        if (!owned("runtime_nodes", "runtime_node_id", change.archive.runtimeNodeId)) {
          throw new ControlNodeCoreError(
            "FENCED",
            "child archive event targets a runtime outside its projection",
          );
        }
        break;
      }
      case "command.changed": {
        const command = this.getCommand(change.command.commandId);
        if (command) assertSameCommandRequest(command, change.command);
        if (change.command.sessionId) {
          const session = this.getSession(change.command.sessionId);
          // A lifecycle command allocates its logical session ID before the
          // runtime can create and inventory the native session. The command
          // control event can consequently overtake session.upsert on this
          // independently consumed feed. Its already-projected runtime route
          // is sufficient to authenticate that transient state; as soon as a
          // session with that identity exists it must be owned by this child.
          if (session && !owned("sessions", "session_id", change.command.sessionId)) {
            throw new ControlNodeCoreError("FENCED", "child command targets a foreign session");
          }
        }
        if (!owned("runtime_nodes", "runtime_node_id", change.command.runtimeNodeId)) {
          throw new ControlNodeCoreError("FENCED", "child command targets a foreign runtime node");
        }
        break;
      }
      case "inventory.completed":
        if (!owned("runtime_nodes", "runtime_node_id", change.runtimeNodeId)) throw new ControlNodeCoreError("FENCED", "child inventory targets a foreign runtime node");
        break;
      case "controlNode.attached":
      case "controlNode.detached":
      case "authority.promoted":
        break;
    }
  }

  #setRole(role: ControlNodeDataRole): void {
    const parsed = controlNodeDataRoleSchema.parse(role);
    this.#db.prepare("UPDATE control_node_role SET revision=revision+1, role_json=?, updated_at=? WHERE singleton=1")
      .run(encode(parsed), this.#timestamp());
  }

  #setDesiredUpstream(locator: Readonly<Record<string, unknown>> | null): void {
    this.#markUpstreamConfigurationInitialized();
    if (locator === null) {
      this.#db.prepare("DELETE FROM settings WHERE key = 'desired_upstream'").run();
      return;
    }
    this.#db.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES ('desired_upstream', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at
    `).run(encode(locator), this.#timestamp());
  }

  #markUpstreamConfigurationInitialized(): void {
    this.#db.prepare(`
      INSERT OR IGNORE INTO settings(key, value_json, updated_at)
      VALUES ('upstream_configuration_initialized', 'true', ?)
    `).run(this.#timestamp());
  }

  #appendRoleTransition(
    kind: RoleTransitionRecord["kind"],
    before: ControlNodeDataRole,
    after: ControlNodeDataRole,
    receipt: RoleTransitionRecord["receipt"],
    transitionId: string,
  ): void {
    const record: RoleTransitionRecord = { transitionId, kind, before, after, receipt, committedAt: this.#timestamp() };
    this.#db.prepare("INSERT INTO role_transitions(transition_id,kind,record_json,committed_at) VALUES(?,?,?,?)")
      .run(transitionId, kind, encode(record), record.committedAt);
  }

  #assertAuthority(expected: AuthorityRef): void {
    if (!sameAuthority(expected, this.authority())) {
      throw new ControlNodeCoreError("FENCED", "authority realm/owner/epoch fence is stale", {
        expectedAuthority: expected,
        currentAuthority: this.authority(),
      });
    }
  }

  #assertAttachmentRoleProof(
    request: ControlNodeAttachmentRequest,
    existing: ControlNodeAttachment | null,
    reconnect: boolean,
  ): void {
    const proof = request.childProof;
    const role = proof.currentRole;
    if (role.role === "authority") {
      if (role.authority.controlNodeId !== request.controlNodeId) {
        throw new ControlNodeCoreError(
          "FENCED",
          "child authority proof is owned by another control node",
        );
      }
      if (request.resume !== undefined) {
        throw new ControlNodeCoreError(
          "FENCED",
          "an authority child cannot resume a branch attachment",
        );
      }
      return;
    }

    if (proof.coveredControlNodeIds.includes(role.authority.controlNodeId)) {
      throw new ControlNodeCoreError(
        "CONFLICT",
        "branch coverage must not include its ancestor authority",
      );
    }
    if (role.branch.lifecycle === "detached") {
      if (request.resume !== undefined) {
        throw new ControlNodeCoreError(
          "FENCED",
          "a detached branch cannot resume its former attachment",
        );
      }
      return;
    }
    if (request.resume === undefined || existing === null || !reconnect) {
      throw new ControlNodeCoreError(
        "FENCED",
        "attached child role proof does not match an active parent lineage",
      );
    }
    const expectedRole: ControlNodeDataRole = {
      role: "branch",
      authority: existing.authority,
      branch: {
        lifecycle: "attached",
        parentControlNodeId: this.#controlNodeId,
        attachmentId: existing.attachmentId,
        lineageId: existing.lineageId,
        attachedAt: existing.attachedAt,
      },
    };
    if (!sameCanonicalJson(role, expectedRole)) {
      throw new ControlNodeCoreError(
        "FENCED",
        "attached child role proof does not match the active parent receipt",
      );
    }
  }

  #putControlNode(node: ControlNodeDescriptor, projectionSource: ControlNodeId | null): void {
    const value = controlNodeDescriptorSchema.parse(node);
    this.#db.prepare(`
      INSERT INTO control_nodes(control_node_id,projection_source,record_json) VALUES(?,?,?)
      ON CONFLICT(control_node_id) DO UPDATE SET projection_source=excluded.projection_source, record_json=excluded.record_json
    `).run(value.controlNodeId, projectionSource, encode(value));
  }

  #putRuntimeNode(node: RuntimeNodeDescriptor, projectionSource: ControlNodeId | null): void {
    const value = runtimeNodeDescriptorSchema.parse(node);
    this.#db.prepare(`
      INSERT INTO runtime_nodes(runtime_node_id,owner_control_node_id,projection_source,record_json) VALUES(?,?,?,?)
      ON CONFLICT(runtime_node_id) DO UPDATE SET owner_control_node_id=excluded.owner_control_node_id,
        projection_source=excluded.projection_source, record_json=excluded.record_json
    `).run(value.runtimeNodeId, value.ownerControlNodeId, projectionSource, encode(value));
  }

  #putSession(session: SessionRecord, projectionSource: ControlNodeId | null): void {
    const value = sessionRecordSchema.parse(session);
    this.#db.prepare(`
      INSERT INTO sessions(
        session_id,runtime_node_id,harness,adapter_scope_id,vendor_session_id,
        availability,updated_at,projection_source,record_json,catalog_state,
        catalog_revision,archived_at,last_activity_at,provider_id,profile_id
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET runtime_node_id=excluded.runtime_node_id,harness=excluded.harness,
        adapter_scope_id=excluded.adapter_scope_id,vendor_session_id=excluded.vendor_session_id,
        availability=excluded.availability,updated_at=excluded.updated_at,
        projection_source=excluded.projection_source,record_json=excluded.record_json,
        catalog_state=excluded.catalog_state,catalog_revision=excluded.catalog_revision,
        archived_at=excluded.archived_at,last_activity_at=excluded.last_activity_at,
        provider_id=excluded.provider_id,profile_id=excluded.profile_id
    `).run(value.sessionId, value.runtimeNodeId, value.harness, value.adapterScopeId, value.vendorSessionId,
      value.availability, value.updatedAt, projectionSource, encode(value), value.catalogState,
      value.catalogRevision, value.archivedAt, value.lastActivityAt,
      value.launchProvenance?.providerId ?? null, value.launchProvenance?.profileId ?? null);
    this.#db.prepare("DELETE FROM session_metadata_index WHERE session_id=?")
      .run(value.sessionId);
    const putMetadata = this.#db.prepare(`
      INSERT INTO session_metadata_index(session_id,key,value_hash,value_json)
      VALUES(?,?,?,?)
    `);
    for (const [key, metadataValue] of Object.entries(value.metadata.values)) {
      const valueJson = canonicalJson(metadataValue);
      putMetadata.run(
        value.sessionId,
        key,
        createHash("sha256").update(valueJson).digest("hex"),
        valueJson,
      );
    }
  }

  #putLaunch(launch: LaunchRecord, projectionSource: ControlNodeId | null): void {
    const value = launchRecordSchema.parse(launch);
    this.#db.prepare(`
      INSERT INTO launch_operations(
        launch_id,runtime_node_id,session_id,provider_id,profile_id,state,
        updated_at,projection_source,record_json
      ) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(launch_id) DO UPDATE SET
        state=excluded.state,updated_at=excluded.updated_at,
        projection_source=excluded.projection_source,record_json=excluded.record_json
    `).run(
      value.launchId,
      value.runtimeNodeId,
      value.sessionId,
      value.profile.providerId,
      value.profile.profileId,
      value.state,
      value.updatedAt,
      projectionSource,
      encode(value),
    );
  }

  #putArchive(archive: ArchiveRecord, projectionSource: ControlNodeId | null): void {
    const value = archiveRecordSchema.parse(archive);
    this.#db.prepare(`
      INSERT INTO archive_operations(
        archive_operation_id,runtime_node_id,session_id,state,updated_at,
        projection_source,record_json
      ) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(archive_operation_id) DO UPDATE SET
        state=excluded.state,updated_at=excluded.updated_at,
        projection_source=excluded.projection_source,record_json=excluded.record_json
    `).run(
      value.archiveOperationId,
      value.runtimeNodeId,
      value.sessionId,
      value.state,
      value.updatedAt,
      projectionSource,
      encode(value),
    );
  }

  #putInteraction(interaction: InteractionRecord, projectionSource: ControlNodeId | null): void {
    const value = interactionRecordSchema.parse(interaction);
    this.#db.prepare(`
      INSERT INTO interactions(interaction_id,session_id,state,created_at,projection_source,record_json) VALUES(?,?,?,?,?,?)
      ON CONFLICT(interaction_id) DO UPDATE SET state=excluded.state,projection_source=excluded.projection_source,record_json=excluded.record_json
    `).run(value.interactionId, value.sessionId, value.state, value.createdAt, projectionSource, encode(value));
  }

  #putMetadataOperation(operation: MetadataOperationRecord, projectionSource: ControlNodeId | null): void {
    const value = metadataOperationRecordSchema.parse(operation);
    this.#db.prepare(`
      INSERT INTO metadata_operations(operation_id,session_id,status,origin_control_node_id,updated_at,projection_source,record_json)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(operation_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,
        projection_source=excluded.projection_source,record_json=excluded.record_json
    `).run(value.operationId, value.sessionId, value.status, value.originControlNodeId, value.updatedAt, projectionSource, encode(value));
  }

  #putCommand(command: CommandRecord): void {
    const value = commandRecordSchema.parse(command);
    this.#db.prepare(`
      INSERT INTO commands(command_id,payload_hash,state,updated_at,record_json) VALUES(?,?,?,?,?)
      ON CONFLICT(command_id) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at,record_json=excluded.record_json
    `).run(value.commandId, value.payloadHash, value.state, value.updatedAt, encode(value));
  }

  #projectionSource(table: string, idColumn: string, id: string): ControlNodeId | null {
    if (!/^(sessions|runtime_nodes|control_nodes|interactions|metadata_operations|launch_operations|archive_operations)$/.test(table) || !/^[a-z_]+$/.test(idColumn)) throw new Error("unsafe projection lookup");
    const row = this.#db.prepare(`SELECT projection_source FROM ${table} WHERE ${idColumn}=?`).get(id) as Row | undefined;
    return row?.projection_source === null || row?.projection_source === undefined ? null : String(row.projection_source) as ControlNodeId;
  }

  #enqueueDeliveryIntent(kind: string, destinationId: string, identity: string, payload: unknown): void {
    this.#db.prepare(`
      INSERT OR IGNORE INTO delivery_intents(kind,destination_id,identity,payload_json,created_at)
      VALUES(?,?,?,?,?)
    `).run(kind, destinationId, identity, encode(payload), this.#timestamp());
  }

  #deleteMetadataDeliveryIntentsForSession(sessionId: SessionId): void {
    this.#db.prepare(`
      DELETE FROM delivery_intents
      WHERE kind = 'metadata'
        AND identity IN (
          SELECT operation_id
          FROM metadata_operations
          WHERE session_id = ?
        )
    `).run(sessionId);
  }

  #retireArchivedMetadataDeliveryIntents(): void {
    this.#transaction(() => {
      this.#db.prepare(`
        DELETE FROM delivery_intents
        WHERE kind = 'metadata'
          AND identity IN (
            SELECT m.operation_id
            FROM metadata_operations m
            JOIN sessions s ON s.session_id = m.session_id
            WHERE s.catalog_state = 'archived'
          )
      `).run();
    });
  }

  #markProjectionReachability(source: ControlNodeId, reachability: "reachable" | "unreachable" | "stale"): void {
    for (const runtime of this.#projectedRuntimeNodes(source)) {
      this.#putRuntimeNode({ ...runtime, reachability }, source);
    }
  }

  #projectedRuntimeNodes(source: ControlNodeId): RuntimeNodeDescriptor[] {
    const rows = this.#db.prepare("SELECT record_json FROM runtime_nodes WHERE projection_source=?")
      .all(source) as Row[];
    return rows.map((row) => parse(runtimeNodeDescriptorSchema, row.record_json));
  }

  #dropProjection(source: ControlNodeId): void {
    this.#db.prepare("DELETE FROM interactions WHERE projection_source=?").run(source);
    this.#db.prepare("DELETE FROM metadata_operations WHERE projection_source=?").run(source);
    this.#db.prepare("DELETE FROM launch_operations WHERE projection_source=?").run(source);
    this.#db.prepare("DELETE FROM archive_operations WHERE projection_source=?").run(source);
    this.#db.prepare("DELETE FROM sessions WHERE projection_source=?").run(source);
    this.#db.prepare("DELETE FROM runtime_nodes WHERE projection_source=?").run(source);
    this.#db.prepare("DELETE FROM control_nodes WHERE projection_source=? OR control_node_id=?").run(source, source);
    this.#db.prepare("DELETE FROM child_checkpoints WHERE child_control_node_id=?").run(source);
  }

  #stalePendingInteractionsForSession(sessionId: SessionId, timestamp: string): void {
    for (const interaction of this.listInteractions({ sessionId, pendingOnly: true })) {
      const stale = interactionRecordSchema.parse({
        ...interaction,
        state: "stale",
        resolvedAt: timestamp,
      });
      this.#putInteraction(stale, null);
      this.#appendControl({ type: "interaction.changed", interaction: stale });
    }
  }

  #fenceRuntimeBoot(runtimeNodeId: RuntimeNodeId): void {
    const timestamp = this.#timestamp();
    // Snapshot generations and capture times are monotonic only within one
    // runtime process epoch.
    this.#db.prepare("DELETE FROM inventory_snapshots WHERE runtime_node_id = ?")
      .run(runtimeNodeId);
    const interruptedCommands = (this.#db.prepare(
      "SELECT record_json FROM commands WHERE state IN ('received','started')",
    ).all() as Row[])
      .map((row) => parse(commandRecordSchema, row.record_json))
      .filter((command) => command.runtimeNodeId === runtimeNodeId);
    for (const command of interruptedCommands) {
      const unknown = commandRecordSchema.parse({
        ...command,
        state: "outcomeUnknown",
        error: "runtime-node boot was replaced before a terminal response",
        updatedAt: timestamp,
      });
      this.#putCommand(unknown);
      this.#appendControl({ type: "command.changed", command: unknown });
    }
    for (const session of this.listSessions({ runtimeNodeId })) {
      this.#stalePendingInteractionsForSession(session.sessionId, timestamp);
      const fenced = sessionRecordSchema.parse({
        ...session,
        availability: "resumable",
        runtimeStatus: "stopped",
        runtimeEpoch: null,
        updatedAt: timestamp,
      });
      this.#putSession(fenced, null);
      this.#appendControl({ type: "session.upsert", session: fenced });
    }
  }

  #appendControl(changeInput: ControlChange, origin = this.#controlNodeId, eventId: string = randomUUID()): number {
    const change = controlChangeSchema.parse(changeInput);
    const cursor = this.controlCursor() + 1;
    const item = feedControlItemSchema.parse({
      kind: "control",
      eventId,
      feedId: this.#feedId,
      cursor,
      provenance: { originControlNodeId: origin, authority: this.authority() },
      change,
    });
    this.#db.prepare("INSERT INTO control_events(cursor,event_id,item_json,created_at) VALUES(?,?,?,?)")
      .run(cursor, eventId, encode(item), this.#timestamp());
    this.#db.prepare("UPDATE control_feed_state SET last_cursor=? WHERE singleton=1").run(cursor);
    return cursor;
  }

  /** Start a new replay generation without changing this node's stable identity. */
  #rotateControlFeed(feedId: FeedId): void {
    const result = this.#db.prepare(
      "UPDATE control_node_identity SET feed_id = ? WHERE singleton = 1",
    ).run(feedId);
    if (Number(result.changes) !== 1) {
      throw new ControlNodeCoreError("NOT_FOUND", "control-node identity is missing during feed rotation");
    }
    this.#db.prepare("DELETE FROM control_events").run();
    this.#db.prepare(
      "UPDATE control_feed_state SET last_cursor = 0, minimum_cursor = 0 WHERE singleton = 1",
    ).run();
    this.#feedId = feedId;
    this.#publishedCursor = 0;
  }

  #mutate<T>(body: () => T): T {
    const result = this.#transaction(body);
    this.#publishNewControls();
    this.#compactToLimit();
    return result;
  }

  #transaction<T>(body: () => T): T {
    const previousFeedId = this.#feedId;
    const previousPublishedCursor = this.#publishedCursor;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = body();
      this.#db.exec("COMMIT");
      return result;
    } catch (cause) {
      try {
        this.#db.exec("ROLLBACK");
      } finally {
        // Feed generation is the only transactionally mutated in-memory
        // state. Restore it alongside SQLite if promotion does not commit.
        this.#feedId = previousFeedId;
        this.#publishedCursor = previousPublishedCursor;
      }
      throw cause;
    }
  }

  #publishNewControls(): void {
    for (;;) {
      const events = this.controlEventsAfter(this.#publishedCursor);
      for (const event of events) {
        this.#publishedCursor = event.cursor;
        this.#events.emit("control", event);
      }
      if (events.length < 10_000) break;
    }
  }

  #compactToLimit(): void {
    const cursor = this.controlCursor();
    const through = cursor - this.#eventRetentionLimit;
    if (through > this.minimumControlCursor()) this.compactControlEvents(through);
  }

  #timestamp(): string { return this.#now().toISOString(); }
}

function sameAuthority(left: AuthorityRef, right: AuthorityRef): boolean {
  return left.realmId === right.realmId && left.controlNodeId === right.controlNodeId && left.epochId === right.epochId;
}

function sameMetadataPatch(left: MetadataPatch, right: MetadataPatch): boolean {
  return canonicalProtocolRecordJson(left) === canonicalProtocolRecordJson(right);
}

function assertSameMetadataOperationIdentity(
  current: MetadataOperationRecord,
  incoming: MetadataOperationRecord,
): void {
  if (
    current.sessionId !== incoming.sessionId ||
    !sameMetadataPatch(current.patch, incoming.patch) ||
    current.originControlNodeId !== incoming.originControlNodeId ||
    !sameAuthority(current.authority, incoming.authority)
  ) {
    throw new ControlNodeCoreError(
      "PAYLOAD_MISMATCH",
      `metadata operation ${incoming.operationId} changed its immutable identity`,
    );
  }
}

function assertSameCommandRequest(
  left: CommandRecord,
  right: CommandRecord,
): void {
  if (
    left.commandId !== right.commandId ||
    left.payloadHash !== right.payloadHash ||
    left.sessionId !== right.sessionId ||
    left.runtimeNodeId !== right.runtimeNodeId ||
    !sameCanonicalJson(left.request, right.request)
  ) {
    throw new ControlNodeCoreError(
      "PAYLOAD_MISMATCH",
      "command identity or request differs from the accepted command",
    );
  }
}

function isTerminalCommandState(state: CommandRecord["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "outcomeUnknown";
}

function mergeCommandRecord(
  current: CommandRecord,
  incomingInput: CommandRecord,
  allowOutcomeRecovery: boolean,
): CommandRecord {
  assertSameCommandRequest(current, incomingInput);
  // createdAt belongs to the control node which first accepted the command;
  // downstream clocks and relayed records cannot rewrite it.
  const incoming = commandRecordSchema.parse({
    ...incomingInput,
    createdAt: current.createdAt,
  });
  if (sameCanonicalJson(current, incoming)) return current;

  if (current.state === "received") {
    if (incoming.state === "received") {
      if (sameCommandStateData(current, incoming)) return current;
      throw new ControlNodeCoreError(
        "CONFLICT",
        "a received command was replayed with different state data",
      );
    }
    return incoming;
  }

  if (current.state === "started") {
    if (incoming.state === "received") return current;
    if (incoming.state === "started") {
      if (sameCommandStateData(current, incoming)) return current;
      throw new ControlNodeCoreError(
        "CONFLICT",
        "a started command was replayed with different state data",
      );
    }
    return incoming;
  }

  if (current.state === "outcomeUnknown") {
    if (
      allowOutcomeRecovery &&
      (incoming.state === "succeeded" || incoming.state === "failed")
    ) {
      return incoming;
    }
    if (incoming.state === "received" || incoming.state === "started") {
      return current;
    }
    throw new ControlNodeCoreError(
      "CONFLICT",
      "command already has a different terminal outcome",
    );
  }

  if (isTerminalCommandState(current.state)) {
    if (incoming.state === "received" || incoming.state === "started") {
      return current;
    }
    throw new ControlNodeCoreError(
      "CONFLICT",
      "command already has a different terminal outcome",
    );
  }

  return current;
}

/**
 * Each forwarding control node journals its own acceptance timestamps before
 * dispatching to the next hop. Equal non-terminal states may therefore carry
 * different clocks while still representing exactly the same state. All
 * request identity and optional state payload fields remain immutable.
 */
function sameCommandStateData(
  left: CommandRecord,
  right: CommandRecord,
): boolean {
  const { createdAt: _leftCreatedAt, updatedAt: _leftUpdatedAt, ...leftData } = left;
  const { createdAt: _rightCreatedAt, updatedAt: _rightUpdatedAt, ...rightData } = right;
  return sameCanonicalJson(leftData, rightData);
}

function sameCanonicalJson(left: unknown, right: unknown): boolean {
  return canonicalProtocolRecordJson(left) === canonicalProtocolRecordJson(right);
}

/**
 * Runtime events can be replayed after their control cursor is lost. Pending
 * may advance once to a terminal state, but no replay may regress or replace a
 * terminal decision.
 */
function mergeInteractionRecord(
  current: InteractionRecord,
  incoming: InteractionRecord,
): InteractionRecord {
  const currentIdentity = {
    interactionId: current.interactionId,
    sessionId: current.sessionId,
    harness: current.harness,
    runtimeEpoch: current.runtimeEpoch,
    ...(current.nativeRequestId === undefined
      ? {}
      : { nativeRequestId: current.nativeRequestId }),
    requestType: current.requestType,
    payload: current.payload,
    ephemeral: current.ephemeral,
    createdAt: current.createdAt,
    expiresAt: current.expiresAt,
  };
  const incomingIdentity = {
    interactionId: incoming.interactionId,
    sessionId: incoming.sessionId,
    harness: incoming.harness,
    runtimeEpoch: incoming.runtimeEpoch,
    ...(incoming.nativeRequestId === undefined
      ? {}
      : { nativeRequestId: incoming.nativeRequestId }),
    requestType: incoming.requestType,
    payload: incoming.payload,
    ephemeral: incoming.ephemeral,
    createdAt: incoming.createdAt,
    expiresAt: incoming.expiresAt,
  };
  if (!sameCanonicalJson(currentIdentity, incomingIdentity)) {
    throw new ControlNodeCoreError(
      "PAYLOAD_MISMATCH",
      "interaction identity was reused with a different request",
    );
  }
  if (sameCanonicalJson(current, incoming)) return current;
  if (current.state === "pending") {
    if (incoming.state === "pending") {
      throw new ControlNodeCoreError(
        "CONFLICT",
        "a pending interaction was replayed with different state data",
      );
    }
    return incoming;
  }
  if (incoming.state === "pending") return current;
  throw new ControlNodeCoreError(
    "CONFLICT",
    "interaction already has a different terminal outcome",
  );
}

function nativeKey(item: Pick<NativeInventoryItem, "harness" | "adapterScopeId" | "vendorSessionId">): string {
  return `${item.harness}\0${item.adapterScopeId}\0${item.vendorSessionId}`;
}

function authorityKey(authority: AuthorityRef): string {
  return `${authority.realmId}\0${authority.controlNodeId}\0${authority.epochId}`;
}

function hashCanonical(value: unknown): string {
  return createHash("sha256")
    .update(canonicalProtocolRecordJson(value))
    .digest("hex");
}

function sessionSearchFingerprint(input: SessionSearchInput): string {
  const { cursor: _cursor, ...query } = input;
  return hashCanonical(query);
}

function launchListFingerprint(input: LaunchListInput): string {
  const { cursor: _cursor, ...query } = input;
  return hashCanonical(query);
}

interface SessionSearchCursorData {
  readonly version: 1;
  readonly fingerprint: string;
  readonly authority: string;
  readonly activityAt: string;
  readonly sessionId: string;
}

interface OperationCursorData {
  readonly version: 1;
  readonly kind: "launch";
  readonly fingerprint: string;
  readonly authority: string;
  readonly updatedAt: string;
  readonly id: string;
}

function encodeSessionSearchCursor(cursor: SessionSearchCursorData): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeSessionSearchCursor(
  encoded: string,
  fingerprint: string,
  authority: string,
): SessionSearchCursorData {
  const value = decodeCursor(encoded) as Partial<SessionSearchCursorData>;
  if (
    value.version !== 1 ||
    value.fingerprint !== fingerprint ||
    value.authority !== authority ||
    typeof value.activityAt !== "string" ||
    typeof value.sessionId !== "string"
  ) {
    throw new ControlNodeCoreError("FENCED", "session search cursor does not match this query or authority epoch");
  }
  return value as SessionSearchCursorData;
}

function encodeOperationCursor(cursor: OperationCursorData): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeOperationCursor(
  encoded: string,
  fingerprint: string,
  authority: string,
  kind: OperationCursorData["kind"],
): OperationCursorData {
  const value = decodeCursor(encoded) as Partial<OperationCursorData>;
  if (
    value.version !== 1 ||
    value.kind !== kind ||
    value.fingerprint !== fingerprint ||
    value.authority !== authority ||
    typeof value.updatedAt !== "string" ||
    typeof value.id !== "string"
  ) {
    throw new ControlNodeCoreError("FENCED", `${kind} cursor does not match this query or authority epoch`);
  }
  return value as OperationCursorData;
}

function decodeCursor(encoded: string): unknown {
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch (cause) {
    throw new ControlNodeCoreError("FENCED", "cursor is malformed", undefined, { cause });
  }
}

function mergeLaunchRecord(
  current: LaunchRecord,
  incomingInput: LaunchRecord,
): LaunchRecord {
  // Every forwarding control node durably admits the operation before
  // dispatch. Preserve the timestamp of this node's admission; a worker or
  // child has an independent clock and does not get to rewrite local durable
  // identity merely because it reports the same launch.
  const observedRecency = compareOperationTimestamp(
    incomingInput.updatedAt,
    current.updatedAt,
  );
  const incoming = launchRecordSchema.parse({
    ...incomingInput,
    createdAt: current.createdAt,
    updatedAt:
      compareOperationTimestamp(incomingInput.updatedAt, current.updatedAt) < 0
        ? current.updatedAt
        : incomingInput.updatedAt,
  });
  const identity = (record: LaunchRecord) => ({
    launchId: record.launchId,
    payloadHash: record.payloadHash,
    sessionId: record.sessionId,
    runtimeNodeId: record.runtimeNodeId,
    profile: record.profile,
    harness: record.harness,
    input: record.input,
    ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
    implementationVersion: record.implementationVersion,
    createdAt: record.createdAt,
  });
  if (!sameCanonicalJson(identity(current), identity(incoming))) {
    throw new ControlNodeCoreError("PAYLOAD_MISMATCH", "launch ID was reused with another immutable request");
  }
  if (sameCanonicalJson(current, incoming)) return current;
  const rank: Record<LaunchRecord["state"], number> = {
    accepted: 0,
    preparing: 1,
    nativeStarting: 2,
    cleanupPending: 3,
    succeeded: 4,
    failed: 4,
    outcomeUnknown: 4,
  };
  const progress = rank[incoming.state] - rank[current.state];
  if (progress < 0) {
    // State rank, rather than a wall clock from another process, is the
    // monotonic fence. A delayed lower-rank observation is always stale.
    return current;
  }
  const terminal = new Set<LaunchRecord["state"]>(["succeeded", "failed", "outcomeUnknown"]);
  if (terminal.has(current.state)) {
    throw new ControlNodeCoreError("CONFLICT", "launch already has a different terminal outcome");
  }
  if (progress > 0) {
    return incoming;
  }
  if (observedRecency < 0) return current;
  // Equal millisecond timestamps are possible for two ordered checkpoints.
  // The incoming record is the latest observation from the owning source.
  return incoming;
}

function mergeArchiveRecord(current: ArchiveRecord, incoming: ArchiveRecord): ArchiveRecord {
  const identity = (record: ArchiveRecord) => ({
    archiveOperationId: record.archiveOperationId,
    payloadHash: record.payloadHash,
    sessionId: record.sessionId,
    runtimeNodeId: record.runtimeNodeId,
    bindingRevision: record.bindingRevision,
    expectedAuthority: record.expectedAuthority,
    authority: record.authority,
    createdAt: record.createdAt,
  });
  if (!sameCanonicalJson(identity(current), identity(incoming))) {
    throw new ControlNodeCoreError("PAYLOAD_MISMATCH", "archive operation ID was reused with another immutable request");
  }
  if (sameCanonicalJson(current, incoming)) return current;
  const terminal = new Set<ArchiveRecord["state"]>(["succeeded", "failed", "outcomeUnknown"]);
  if (terminal.has(current.state)) {
    throw new ControlNodeCoreError("CONFLICT", "archive operation already has a different terminal outcome");
  }
  const rank: Record<ArchiveRecord["state"], number> = {
    accepted: 0,
    releasing: 1,
    succeeded: 2,
    failed: 2,
    outcomeUnknown: 2,
  };
  const progress = rank[incoming.state] - rank[current.state];
  const recency = compareOperationTimestamp(incoming.updatedAt, current.updatedAt);
  if (progress < 0) {
    if (recency > 0) {
      throw new ControlNodeCoreError(
        "CONFLICT",
        "a newer archive record cannot regress lifecycle state",
      );
    }
    return current;
  }
  if (progress > 0) {
    if (recency < 0) {
      throw new ControlNodeCoreError(
        "CONFLICT",
        "archive lifecycle progress cannot move its update timestamp backwards",
      );
    }
    return incoming;
  }
  if (recency < 0) return current;
  return incoming;
}

function compareOperationTimestamp(left: string, right: string): number {
  return Math.sign(Date.parse(left) - Date.parse(right));
}

function optimisticMetadata(snapshot: MetadataSnapshot, patch: MetadataPatch): MetadataSnapshot {
  const values = { ...snapshot.values, ...(patch.set ?? {}) };
  for (const key of patch.remove ?? []) delete values[key];
  return { ...snapshot, values };
}

function applyMetadataPatch(snapshot: MetadataSnapshot, patch: MetadataPatch): MetadataPatchResult {
  const conflicts = Object.entries(patch.ifKeyRevision ?? {}).flatMap(([key, expectedRevision]) => {
    const actualRevision = snapshot.keyRevisions[key] ?? null;
    if (actualRevision === expectedRevision) return [];
    return [{
      key,
      expectedRevision,
      actualRevision,
      ...(Object.hasOwn(snapshot.values, key) ? { actualValue: snapshot.values[key] } : {}),
    }];
  });
  if (conflicts.length > 0) return { accepted: false, operationId: patch.operationId, snapshot, conflicts };
  const revision = snapshot.revision + 1;
  const values = { ...snapshot.values, ...(patch.set ?? {}) };
  const keyRevisions = { ...snapshot.keyRevisions };
  for (const key of Object.keys(patch.set ?? {})) keyRevisions[key] = revision;
  for (const key of patch.remove ?? []) {
    delete values[key];
    keyRevisions[key] = revision;
  }
  return { accepted: true, operationId: patch.operationId, snapshot: { revision, values, keyRevisions }, deduplicated: false };
}
