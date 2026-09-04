import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";

import {
  HardenedSqliteDatabase,
  SQLITE_SCHEMA_VERSION,
  type SqliteBackupResult,
  type SqliteCheckpointResult,
  type SqliteDiagnostics,
  type SqliteIntegrityDiagnostics,
} from "@agent-multiplex/storage-sqlite";

import {
  authorityAdoptionReceiptSchema,
  authorityForceAdoptInputSchema,
  authorityHandoffAcceptanceClaimsSchema,
  authorityHandoffAcceptanceSchema,
  authorityHandoffAcceptInputSchema,
  authorityHandoffConsumeInputSchema,
  authorityHandoffOfferInputSchema,
  authorityHandoffOfferSchema,
  canonicalJson,
  commandRecordSchema,
  controlChangeSchema,
  emptyMetadataSnapshot,
  feedCheckpointSchema,
  hostAttachmentRequestSchema,
  hostAttachmentSchema,
  hostDescriptorSchema,
  interactionRecordSchema,
  inventorySnapshotSchema,
  jsonValueSchema,
  metadataPatchResultSchema,
  metadataPatchSchema,
  metadataOperationRecordSchema,
  metadataValuesSchema,
  newAttachmentId,
  newAuthorityEpochId,
  newAuthorityHandoffId,
  newFeedId,
  newHostBootId,
  newHostId,
  newLineageId,
  newSessionId,
  operationIdSchema,
  sessionRecordSchema,
  workerDescriptorSchema,
  type CommandRecord,
  type CommandState,
  type ControlChange,
  type AuthorityAdoptionReceipt,
  type AuthorityForceAdoptInput,
  type AuthorityHandoffAcceptance,
  type AuthorityHandoffAcceptInput,
  type AuthorityHandoffConsumeInput,
  type AuthorityHandoffId,
  type AuthorityHandoffOffer,
  type AuthorityHandoffOfferInput,
  type FeedCheckpoint,
  type FeedControlItem,
  type FleetStreamItem,
  type HostAttachment,
  type HostAttachmentRequest,
  type HostBootId,
  type HostDescriptor,
  type HostId,
  type HostSubtreeSnapshotPage,
  type InteractionRecord,
  type InventorySnapshot,
  type JsonValue,
  type MetadataPatch,
  type MetadataOperationRecord,
  type MetadataPatchResult,
  type MetadataSnapshot,
  type NativeInventoryItem,
  type ResumeCommand,
  type SessionId,
  type SessionRecord,
  type SpawnCommand,
  type WorkerDescriptor,
  type WorkerId,
  type WorkerRegistration,
} from "@agent-multiplex/protocol";
import type { ZodType } from "zod";

import {
  verifyAuthorityHandoffAcceptanceProof,
  type AuthorityAcceptanceSigner,
} from "./authority-proof.js";
import { HostCoreError } from "./errors.js";

type Row = Record<string, unknown>;

interface PendingLifecycleIntent {
  commandId: string;
  sessionId: SessionId;
  harness: "codex" | "copilot";
  vendorSessionId: string;
}

export interface HostCatalogOptions {
  filename: string;
  now?: () => Date;
  hostId?: HostId;
  hostBootId?: HostBootId;
  hostName?: string;
  endpointId?: string;
  maxHostDepth?: number;
  /** Deterministic crash-boundary injection used by catalog atomicity tests. */
  failpoint?: (name: "import.afterProjection") => void;
}

export interface SessionFilter {
  workerId?: WorkerId | undefined;
  harness?: "codex" | "copilot" | undefined;
  availability?: readonly ("active" | "resumable" | "unavailable")[] | undefined;
}

export interface ReconcileOptions {
  /** Native-key to preallocated logical session ID, used by spawn/resume. */
  preferredSessionIds?: ReadonlyMap<string, SessionId>;
}

export interface ImportedControlResult {
  accepted: boolean;
  deduplicated: boolean;
  checkpoint: FeedCheckpoint;
  localCursor: number;
}

/** Durable local view of one half of an authority handoff exchange. */
export interface AuthorityHandoffRecord {
  status: "offered" | "accepted" | "consumed";
  offer: AuthorityHandoffOffer;
  acceptance?: AuthorityHandoffAcceptance;
  receipt?: AuthorityAdoptionReceipt & { mode: "handoff" };
}

export interface AggregateRoute {
  entityType: "host" | "worker" | "session";
  entityId: string;
  ownerHostId: HostId;
  immediateChildHostId: HostId;
  attachmentId: HostAttachment["attachmentId"];
  lineageId: HostAttachment["lineageId"];
}

export type EnrolledPeerRole = "worker" | "childHost" | "parentHost" | "observer";

export const nativeInventoryKey = (
  workerId: WorkerId,
  item: Pick<NativeInventoryItem, "harness" | "adapterScopeId" | "vendorSessionId">,
): string =>
  `${workerId}\0${item.harness}\0${item.adapterScopeId}\0${item.vendorSessionId}`;

const encode = (value: unknown): string => JSON.stringify(value);
const decode = (value: unknown): unknown => JSON.parse(String(value));

function parsed<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(decode(value));
}

function rowRecord<T>(schema: ZodType<T>, row: Row | undefined): T | null {
  return row ? parsed(schema, row.record_json) : null;
}

function jsonForHash(value: unknown): string {
  return canonicalJson(jsonValueSchema.parse(value));
}

function metadataFor(record: SessionRecord): MetadataSnapshot {
  return record.metadata;
}

const HOST_CATALOG_APPLICATION_ID = 0x414d_434e; // "AMCN" (agent-multiplex control node)

/** SQLite-backed canonical catalog. All mutating methods are synchronous and atomic. */
export class HostCatalog {
  readonly #sqlite: HardenedSqliteDatabase;
  readonly #db: DatabaseSync;
  readonly #now: () => Date;
  readonly #events = new EventEmitter();
  readonly #localHostId: HostId;
  readonly #localFeedId: import("@agent-multiplex/protocol").FeedId;
  readonly #maxHostDepth: number;
  readonly #failpoint: ((name: "import.afterProjection") => void) | undefined;
  #publishedCursor: number;

  public constructor(options: HostCatalogOptions) {
    this.#now = options.now ?? (() => new Date());
    this.#maxHostDepth = options.maxHostDepth ?? 32;
    this.#failpoint = options.failpoint;
    if (!Number.isSafeInteger(this.#maxHostDepth) || this.#maxHostDepth < 1) {
      throw new RangeError("maxHostDepth must be a positive integer");
    }
    this.#sqlite = new HardenedSqliteDatabase({
      filename: options.filename,
      applicationId: HOST_CATALOG_APPLICATION_ID,
      storeName: "host catalog",
      migrations: [{
        version: SQLITE_SCHEMA_VERSION,
        name: "host-catalog-v3-bootstrap",
        apply: HostCatalog.#migrate,
      }],
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.#db = this.#sqlite.database;
    try {
      const identity = this.#loadOrCreateHostIdentity(options);
      this.#localHostId = identity.hostId;
      this.#localFeedId = identity.feedId;
      this.#startLocalHost(options, identity);
      this.#recoverAfterHostRestart();
      this.recoverTerminalMetadataReplication();
      this.#backfillPeerEnrollments();
      this.#publishedCursor = this.controlCursor();
    } catch (error) {
      try {
        this.#sqlite.close();
      } catch {
        // Preserve the initialization failure; the SQLite lifecycle still
        // attempts both database closure and writer-lock release internally.
      }
      throw error;
    }
  }

  public close(): void {
    this.#events.removeAllListeners();
    this.#sqlite.close();
  }

  public diagnostics(): SqliteDiagnostics {
    return this.#sqlite.diagnostics();
  }

  public backup(destination: string): Promise<SqliteBackupResult> {
    return this.#sqlite.backup(destination);
  }

  public integrityCheck(
    mode: "quick" | "full" = "quick",
  ): SqliteIntegrityDiagnostics {
    return this.#sqlite.integrityCheck(mode);
  }

  public checkpoint(
    mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE",
  ): SqliteCheckpointResult {
    return this.#sqlite.checkpoint(mode);
  }

  public onControl(listener: (item: FleetStreamItem & { kind: "control" }) => void): () => void {
    this.#events.on("control", listener);
    return () => this.#events.off("control", listener);
  }

  public controlCursor(): number {
    const row = this.#db
      .prepare(
        `SELECT MAX(
           COALESCE((SELECT MAX(cursor) FROM control_events), 0),
           (SELECT minimum_cursor FROM control_event_retention WHERE singleton = 1)
         ) AS cursor`,
      )
      .get() as Row;
    return Number(row.cursor);
  }

  /** The oldest client checkpoint that can still be replayed without a snapshot. */
  public minimumControlCursor(): number {
    const row = this.#db
      .prepare("SELECT minimum_cursor FROM control_event_retention WHERE singleton = 1")
      .get() as Row;
    return Number(row.minimum_cursor);
  }

  public canReplayControlCursor(cursor: number): boolean {
    return Number.isSafeInteger(cursor) &&
      cursor >= this.minimumControlCursor() &&
      cursor <= this.controlCursor();
  }

  /**
   * Delete controls through a caller-selected safe checkpoint. The durable
   * watermark is advanced in the same transaction, so a crash cannot expose a
   * pruned feed while claiming an older cursor is replayable.
   */
  public compactControlEvents(throughCursor: number): {
    deleted: number;
    minimumControlCursor: number;
  } {
    if (!Number.isSafeInteger(throughCursor) || throughCursor < 0) {
      throw new RangeError("control compaction cursor must be a non-negative integer");
    }
    const currentCursor = this.controlCursor();
    if (throughCursor > currentCursor) {
      throw new RangeError("control compaction cursor cannot exceed the current feed cursor");
    }
    if (throughCursor > this.#publishedCursor) {
      throw new RangeError("control compaction cursor cannot exceed the published feed cursor");
    }
    const previous = this.minimumControlCursor();
    if (throughCursor <= previous) {
      return { deleted: 0, minimumControlCursor: previous };
    }
    return this.#transaction(() => {
      const result = this.#db
        .prepare("DELETE FROM control_events WHERE cursor <= ?")
        .run(throughCursor);
      this.#db
        .prepare(
          `UPDATE control_event_retention
           SET minimum_cursor = ? WHERE singleton = 1`,
        )
        .run(throughCursor);
      return {
        deleted: Number(result.changes),
        minimumControlCursor: throughCursor,
      };
    });
  }

  public controlEventsAfter(
    cursor: number,
    options: { through?: number; limit?: number } = {},
  ): Array<FleetStreamItem & { kind: "control" }> {
    const through = options.through ?? Number.MAX_SAFE_INTEGER;
    const limit = options.limit ?? 10_000;
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new RangeError("control cursor must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(through) || through < 0) {
      throw new RangeError("control replay boundary must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) {
      throw new RangeError("control replay limit must be an integer between 1 and 100000");
    }
    const minimumControlCursor = this.minimumControlCursor();
    if (cursor < minimumControlCursor) {
      throw new HostCoreError(
        "CONFLICT",
        "control cursor expired; recover from a fresh snapshot",
        { cursor, minimumControlCursor },
      );
    }
    const rows = this.#db
      .prepare(
        `SELECT cursor, event_id, origin_host_id, feed_id, change_json
         FROM control_events WHERE cursor > ? AND cursor <= ? ORDER BY cursor LIMIT ?`,
      )
      .all(cursor, through, limit) as Row[];
    return rows.map((row) => ({
      kind: "control" as const,
      eventId: String(row.event_id),
      originHostId: row.origin_host_id as HostId,
      feedId: row.feed_id as import("@agent-multiplex/protocol").FeedId,
      cursor: Number(row.cursor),
      change: parsed(controlChangeSchema, row.change_json),
    }));
  }

  public localHost(): HostDescriptor {
    const host = this.getHost(this.#localHostId);
    if (!host) throw new HostCoreError("NOT_FOUND", "local host identity is missing");
    return host;
  }

  public feedCheckpoint(): FeedCheckpoint {
    return feedCheckpointSchema.parse({
      feedId: this.#localFeedId,
      controlCursor: this.controlCursor(),
    });
  }

  public getHost(hostId: HostId): HostDescriptor | null {
    const row = this.#db
      .prepare("SELECT record_json FROM hosts WHERE host_id = ?")
      .get(hostId) as Row | undefined;
    return rowRecord(hostDescriptorSchema, row);
  }

  public listHosts(): HostDescriptor[] {
    const rows = this.#db
      .prepare("SELECT record_json FROM hosts ORDER BY host_id")
      .all() as Row[];
    return rows.map((row) => parsed(hostDescriptorSchema, row.record_json));
  }

  /** Mint a source-side, destination-bound, expiring authority capability. */
  public offerAuthorityHandoff(input: AuthorityHandoffOfferInput): AuthorityHandoffOffer {
    const request = authorityHandoffOfferInputSchema.parse(input);
    const requestHash = jsonForHash(request);
    const replay = this.#db
      .prepare("SELECT offer_json FROM authority_handoff_offers WHERE request_hash = ?")
      .get(requestHash) as Row | undefined;
    if (replay) return parsed(authorityHandoffOfferSchema, replay.offer_json);

    this.#assertSourceAuthorityBinding(request);
    const offeredAt = this.#timestamp();
    if (Date.parse(request.expiresAt) <= Date.parse(offeredAt)) {
      throw new HostCoreError("FENCED", "authority handoff expiry is not in the future");
    }
    const offer = authorityHandoffOfferSchema.parse({
      handoffId: newAuthorityHandoffId(),
      ...request,
      offeredAt,
      offerToken: this.#capabilityToken(),
    });
    this.#db
      .prepare(
        `INSERT INTO authority_handoff_offers(
           handoff_id, request_hash, status, offer_json, created_at, updated_at
         ) VALUES (?, ?, 'offered', ?, ?, ?)`,
      )
      .run(offer.handoffId, requestHash, encode(offer), offeredAt, offeredAt);
    return offer;
  }

  /** Persist a destination acceptance. Exact retries return the original token. */
  public acceptAuthorityHandoff(
    input: AuthorityHandoffAcceptInput,
    signer: AuthorityAcceptanceSigner,
  ): AuthorityHandoffAcceptance {
    const request = authorityHandoffAcceptInputSchema.parse(input);
    const requestHash = jsonForHash(request);
    const existing = this.#db
      .prepare(
        `SELECT request_hash, acceptance_json FROM authority_handoff_acceptances
         WHERE handoff_id = ?`,
      )
      .get(request.offer.handoffId) as Row | undefined;
    if (existing) {
      if (String(existing.request_hash) !== requestHash) {
        throw new HostCoreError(
          "PAYLOAD_MISMATCH",
          `handoff ${request.offer.handoffId} was accepted with another binding`,
        );
      }
      const acceptance = parsed(
        authorityHandoffAcceptanceSchema,
        existing.acceptance_json,
      );
      this.#assertValidAcceptanceProof(acceptance);
      return acceptance;
    }

    this.#assertDestinationAcceptanceBinding(request);
    if (signer.endpointId !== request.offer.destinationAuthorityEndpointId) {
      throw new HostCoreError(
        "FENCED",
        "authority handoff signer is not the destination endpoint named by the offer",
      );
    }
    this.#assertLiveAuthorityOffer(request.offer);
    const acceptedAt = this.#timestamp();
    const claims = authorityHandoffAcceptanceClaimsSchema.parse({
      handoffId: request.offer.handoffId,
      offerToken: request.offer.offerToken,
      destinationRootHostId: request.offer.destinationRootHostId,
      destinationAuthorityHostId: request.offer.destinationAuthorityHostId,
      destinationAuthorityEndpointId: request.offer.destinationAuthorityEndpointId,
      destinationHostBootId: request.acceptedByHostBootId,
      destinationAuthorityEpochId: request.destinationAuthorityEpochId,
      acceptedAt,
      acceptanceToken: this.#capabilityToken(),
    });
    const acceptance = authorityHandoffAcceptanceSchema.parse({
      ...claims,
      acceptanceProof: {
        algorithm: "ed25519",
        signature: signer.sign(claims),
      },
    });
    this.#assertValidAcceptanceProof(acceptance);
    this.#db
      .prepare(
        `INSERT INTO authority_handoff_acceptances(
           handoff_id, request_hash, offer_json, acceptance_json, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        acceptance.handoffId,
        requestHash,
        encode(request.offer),
        encode(acceptance),
        acceptedAt,
      );
    return acceptance;
  }

  /**
   * Atomically consume an offer at its source and fence the subtree's old
   * metadata epoch. An exact replay returns the durable receipt, even after
   * the offer's wall-clock expiry.
   */
  public consumeAuthorityHandoff(
    input: AuthorityHandoffConsumeInput,
  ): AuthorityAdoptionReceipt & { mode: "handoff" } {
    const request = authorityHandoffConsumeInputSchema.parse(input);
    this.#assertValidAcceptanceProof(request.acceptance);
    const requestHash = jsonForHash(request);
    const row = this.#db
      .prepare(
        `SELECT status, offer_json, consume_request_hash, receipt_json
         FROM authority_handoff_offers WHERE handoff_id = ?`,
      )
      .get(request.offer.handoffId) as Row | undefined;
    if (!row) {
      throw new HostCoreError("NOT_FOUND", `authority handoff ${request.offer.handoffId} is unknown`);
    }
    const durableOffer = parsed(authorityHandoffOfferSchema, row.offer_json);
    if (jsonForHash(durableOffer) !== jsonForHash(request.offer)) {
      throw new HostCoreError(
        "PAYLOAD_MISMATCH",
        `handoff ${request.offer.handoffId} does not match the minted offer`,
      );
    }
    if (row.status === "consumed") {
      if (row.consume_request_hash !== requestHash || row.receipt_json === null) {
        throw new HostCoreError(
          "PAYLOAD_MISMATCH",
          `authority handoff ${request.offer.handoffId} was already consumed`,
        );
      }
      return this.#handoffReceipt(row.receipt_json);
    }

    this.#assertSourceAuthorityBinding(request.offer);
    this.#assertLiveAuthorityOffer(request.offer);
    const acceptedAt = Date.parse(request.acceptance.acceptedAt);
    if (
      acceptedAt < Date.parse(request.offer.offeredAt) ||
      acceptedAt > this.#now().getTime()
    ) {
      throw new HostCoreError("FENCED", "authority handoff acceptance time is invalid");
    }
    const adoptedAt = this.#timestamp();
    const receipt = this.#handoffReceipt({
      mode: "handoff",
      handoffId: request.offer.handoffId,
      sourceRootHostId: request.offer.sourceRootHostId,
      sourceAuthorityHostId: request.offer.sourceAuthorityHostId,
      sourceAuthorityEpochId: request.offer.sourceAuthorityEpochId,
      subtreeRootHostId: request.offer.subtreeRootHostId,
      destinationRootHostId: request.offer.destinationRootHostId,
      destinationAuthorityHostId: request.offer.destinationAuthorityHostId,
      destinationAuthorityEpochId: request.acceptance.destinationAuthorityEpochId,
      adoptedAt,
      consumptionToken: this.#capabilityToken(),
    });
    this.#transaction(() => {
      this.#projectSubtreeAuthority(
        request.offer.subtreeRootHostId,
        request.offer.destinationRootHostId,
        request.offer.destinationAuthorityHostId,
        request.acceptance.destinationAuthorityEpochId,
        false,
      );
      const changed = this.#db
        .prepare(
          `UPDATE authority_handoff_offers SET status = 'consumed',
             acceptance_json = ?, consume_request_hash = ?, receipt_json = ?, updated_at = ?
           WHERE handoff_id = ? AND status = 'offered'`,
        )
        .run(
          encode(request.acceptance),
          requestHash,
          encode(receipt),
          adoptedAt,
          request.offer.handoffId,
        );
      if (Number(changed.changes) !== 1) {
        throw new HostCoreError("CONFLICT", "authority handoff changed while being consumed");
      }
    });
    this.#publishNewControls();
    return receipt;
  }

  /** Audited split-brain recovery at the destination authority. */
  public forceAdoptAuthority(input: AuthorityForceAdoptInput): AuthorityAdoptionReceipt & {
    mode: "forced";
  } {
    const request = authorityForceAdoptInputSchema.parse(input);
    const requestHash = jsonForHash(request);
    const replay = this.#db
      .prepare("SELECT receipt_json FROM authority_force_adoptions WHERE request_hash = ?")
      .get(requestHash) as Row | undefined;
    if (replay) return this.#forcedReceipt(replay.receipt_json);

    this.#assertForceAdoptionBinding(request);
    const adoptedAt = this.#timestamp();
    const receipt = this.#forcedReceipt({
      mode: "forced",
      handoffId: null,
      sourceRootHostId: request.previousRootHostId,
      sourceAuthorityHostId: request.previousAuthorityHostId,
      sourceAuthorityEpochId: request.previousAuthorityEpochId,
      subtreeRootHostId: request.subtreeRootHostId,
      destinationRootHostId: request.destinationRootHostId,
      destinationAuthorityHostId: request.destinationAuthorityHostId,
      destinationAuthorityEpochId: request.destinationAuthorityEpochId,
      adoptedAt,
      audit: request.audit,
    });
    this.#transaction(() => {
      this.#projectSubtreeAuthority(
        request.subtreeRootHostId,
        request.destinationRootHostId,
        request.destinationAuthorityHostId,
        request.destinationAuthorityEpochId,
        request.subtreeRootHostId === this.#localHostId &&
          request.destinationRootHostId === this.#localHostId,
      );
      this.#db
        .prepare(
          `INSERT INTO authority_force_adoptions(
             request_hash, request_json, receipt_json, created_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(requestHash, encode(request), encode(receipt), adoptedAt);
      if (request.destinationAuthorityHostId === this.#localHostId) {
        this.#db
          .prepare("UPDATE host_identity SET authority_epoch_id = ? WHERE singleton = 1")
          .run(request.destinationAuthorityEpochId);
      }
    });
    if (request.destinationAuthorityHostId === this.#localHostId) {
    }
    this.#publishNewControls();
    return receipt;
  }

  public getAuthorityHandoff(handoffId: AuthorityHandoffId): AuthorityHandoffRecord | null {
    const source = this.#db
      .prepare(
        `SELECT status, offer_json, acceptance_json, receipt_json
         FROM authority_handoff_offers WHERE handoff_id = ?`,
      )
      .get(handoffId) as Row | undefined;
    if (source) {
      const record: AuthorityHandoffRecord = {
        status: String(source.status) as AuthorityHandoffRecord["status"],
        offer: parsed(authorityHandoffOfferSchema, source.offer_json),
      };
      if (source.acceptance_json !== null) {
        record.acceptance = parsed(authorityHandoffAcceptanceSchema, source.acceptance_json);
      }
      if (source.receipt_json !== null) record.receipt = this.#handoffReceipt(source.receipt_json);
      return record;
    }
    const destination = this.#db
      .prepare(
        `SELECT offer_json, acceptance_json FROM authority_handoff_acceptances
         WHERE handoff_id = ?`,
      )
      .get(handoffId) as Row | undefined;
    return destination
      ? {
          status: "accepted",
          offer: parsed(authorityHandoffOfferSchema, destination.offer_json),
          acceptance: parsed(authorityHandoffAcceptanceSchema, destination.acceptance_json),
        }
      : null;
  }

  public listAuthorityAdoptionReceipts(): AuthorityAdoptionReceipt[] {
    const handoffs = this.#db
      .prepare(
        `SELECT receipt_json FROM authority_handoff_offers
         WHERE status = 'consumed' ORDER BY updated_at, handoff_id`,
      )
      .all() as Row[];
    const forced = this.#db
      .prepare(
        `SELECT receipt_json FROM authority_force_adoptions
         ORDER BY created_at, request_hash`,
      )
      .all() as Row[];
    return [...handoffs, ...forced]
      .map((row) => authorityAdoptionReceiptSchema.parse(decode(row.receipt_json)))
      .sort(
        (left, right) =>
          Date.parse(left.adoptedAt) - Date.parse(right.adoptedAt) ||
          String(left.handoffId).localeCompare(String(right.handoffId)),
      );
  }

  /** Record the transport identity after the p2prpc node has derived it. */
  public setLocalEndpointId(endpointId: string): HostDescriptor {
    if (endpointId.length === 0) throw new TypeError("endpointId must not be empty");
    const local = this.localHost();
    if (local.endpointId === endpointId) return local;
    if (local.endpointId !== undefined) {
      throw new HostCoreError("FENCED", "local host is pinned to another transport endpoint");
    }
    const updated = hostDescriptorSchema.parse({ ...local, endpointId });
    this.#transaction(() => {
      this.#putHost(updated);
      this.#appendControl({ type: "host.upsert", host: updated });
    });
    this.#publishNewControls();
    return updated;
  }

  public enrollPeer(
    endpointId: string,
    role: EnrolledPeerRole,
    principalId: string,
  ): void {
    if (!endpointId || !principalId) {
      throw new TypeError("peer endpoint and principal IDs must not be empty");
    }
    const existing = this.#db
      .prepare("SELECT role, principal_id FROM peer_enrollments WHERE endpoint_id = ?")
      .get(endpointId) as Row | undefined;
    if (
      existing &&
      (existing.role !== role || existing.principal_id !== principalId)
    ) {
      throw new HostCoreError("FENCED", "peer endpoint is enrolled for another role or principal");
    }
    this.#db
      .prepare(
        `INSERT INTO peer_enrollments(endpoint_id, role, principal_id, created_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(endpoint_id) DO NOTHING`,
      )
      .run(endpointId, role, principalId, this.#timestamp());
  }

  public peerEnrollment(endpointId: string): {
    role: EnrolledPeerRole;
    principalId: string;
  } | null {
    const row = this.#db
      .prepare("SELECT role, principal_id FROM peer_enrollments WHERE endpoint_id = ?")
      .get(endpointId) as Row | undefined;
    return row
      ? {
          role: String(row.role) as EnrolledPeerRole,
          principalId: String(row.principal_id),
        }
      : null;
  }

  /**
   * Resolve durable enrollment only while its topology ownership is current.
   * Enrollment rows are intentionally append-only audit/pinning records; they
   * must not let a former parent or explicitly detached child retain control.
   * Offline direct workers and observers remain enrolled so they can reconnect.
   */
  public activePeerEnrollment(endpointId: string): {
    role: EnrolledPeerRole;
    principalId: string;
  } | null {
    const enrollment = this.peerEnrollment(endpointId);
    if (!enrollment) return null;
    if (enrollment.role === "observer") return enrollment;
    if (enrollment.role === "worker") {
      const worker = this.getWorker(enrollment.principalId as WorkerId);
      return worker?.ownerHostId === this.#localHostId && worker.endpointId === endpointId
        ? enrollment
        : null;
    }
    if (enrollment.role === "parentHost") {
      const local = this.localHost();
      return local.parentHostId === enrollment.principalId && local.attachmentId !== null
        ? enrollment
        : null;
    }
    const childHostId = enrollment.principalId as HostId;
    const child = this.getHost(childHostId);
    const attachment = this.getAttachment(childHostId);
    return child?.parentHostId === this.#localHostId &&
      child.endpointId === endpointId &&
      child.attachmentId !== null &&
      attachment?.attachmentId === child.attachmentId &&
      attachment.parentHostId === this.#localHostId
      ? enrollment
      : null;
  }

  /** A transport loss changes reachability only; it never detaches ownership. */
  public setChildReachability(
    childHostId: HostId,
    presence: "online" | "stale" | "offline",
  ): boolean {
    const attachment = this.getAttachment(childHostId);
    if (!attachment) return false;
    const workerReachability =
      presence === "online" ? "reachable" : presence === "stale" ? "stale" : "unreachable";
    this.#transaction(() => {
      for (const host of this.#hostsThroughChild(childHostId)) {
        if (presence === "online" && host.hostId !== childHostId) continue;
        const updated = hostDescriptorSchema.parse({
          ...host,
          presence,
          ...(host.hostId === childHostId && presence !== "online"
            ? { connectedAt: null }
            : {}),
          lastHeartbeatAt: presence === "online" ? this.#timestamp() : host.lastHeartbeatAt,
        });
        this.#putHost(updated);
        this.#appendControl({ type: "host.presence", hostId: host.hostId, presence });
      }
      for (const worker of presence === "online" ? [] : this.#workersThroughChild(childHostId)) {
        const updated = workerDescriptorSchema.parse({
          ...worker,
          reachability: workerReachability,
        });
        this.#putWorker(updated);
        this.#appendControl({ type: "worker.upsert", worker: updated });
      }
    });
    this.#publishNewControls();
    return true;
  }

  public getAttachment(childHostId: HostId): HostAttachment | null {
    const row = this.#db
      .prepare(
        `SELECT attachment_json FROM host_attachments
         WHERE child_host_id = ? AND parent_host_id = ? AND state = 'active'`,
      )
      .get(childHostId, this.#localHostId) as Row | undefined;
    return row ? parsed(hostAttachmentSchema, row.attachment_json) : null;
  }

  public attachChild(requestInput: HostAttachmentRequest): {
    attachment: HostAttachment;
    child: HostDescriptor;
    reconnected: boolean;
  } {
    const request = hostAttachmentRequestSchema.parse(requestInput);
    const local = this.localHost();
    if (request.hostId === local.hostId) {
      throw new HostCoreError("CONFLICT", "a host cannot attach below itself");
    }
    if (
      request.expectedParentHostId !== undefined &&
      request.expectedParentHostId !== local.hostId
    ) {
      throw new HostCoreError("FENCED", "child expected a different parent host");
    }
    const existing = this.getHost(request.hostId);
    const existingRoute = this.#aggregateRoute("host", request.hostId);
    if (existingRoute && existingRoute.immediateChildHostId !== request.hostId) {
      throw new HostCoreError(
        "CONFLICT",
        "host is already present below another immediate child",
      );
    }
    if (
      existing?.endpointId !== undefined &&
      request.endpointId !== undefined &&
      existing.endpointId !== request.endpointId
    ) {
      throw new HostCoreError("FENCED", "child host is pinned to another transport endpoint");
    }
    if (
      request.endpointId !== undefined &&
      this.listHosts().some(
        (host) => host.hostId !== request.hostId && host.endpointId === request.endpointId,
      )
    ) {
      throw new HostCoreError("FENCED", "transport endpoint is enrolled as another host");
    }
    const active = this.getAttachment(request.hostId);
    if (
      active &&
      request.previousAttachmentId !== undefined &&
      request.previousAttachmentId !== active.attachmentId
    ) {
      throw new HostCoreError("FENCED", "child presented a stale attachment ID");
    }
    if (
      active &&
      request.previousLineageId !== undefined &&
      request.previousLineageId !== active.lineageId
    ) {
      throw new HostCoreError("FENCED", "child presented a stale metadata lineage");
    }

    const timestamp = this.#timestamp();
    const reconnected = active !== null;
    const attachment = active ?? hostAttachmentSchema.parse({
      attachmentId: newAttachmentId(),
      lineageId:
        existing?.rootHostId === local.rootHostId
          ? existing.lineageId
          : newLineageId(),
      parentHostId: local.hostId,
      childHostId: request.hostId,
      rootHostId: local.rootHostId,
      authorityHostId: local.authorityHostId,
      authorityEpochId: local.authorityEpochId,
      attachedAt: timestamp,
    });
    const child = hostDescriptorSchema.parse({
      hostId: request.hostId,
      hostBootId: request.hostBootId,
      feedId: request.feedId,
      name: request.name,
      ...(request.endpointId === undefined
        ? existing?.endpointId === undefined
          ? {}
          : { endpointId: existing.endpointId }
        : { endpointId: request.endpointId }),
      presence: "online",
      parentHostId: local.hostId,
      rootHostId: local.rootHostId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
      authorityHostId: attachment.authorityHostId,
      authorityEpochId: attachment.authorityEpochId,
      connectedAt: timestamp,
      lastHeartbeatAt: timestamp,
      protocolVersion: 2,
      capabilities: request.capabilities,
    });

    this.#transaction(() => {
      this.#putHost(child);
      this.#db
        .prepare(
          `INSERT INTO host_attachments(
             attachment_id, parent_host_id, child_host_id, lineage_id, state,
             attachment_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
           ON CONFLICT(attachment_id) DO UPDATE SET state = 'active',
             attachment_json = excluded.attachment_json, updated_at = excluded.updated_at`,
        )
        .run(
          attachment.attachmentId,
          attachment.parentHostId,
          attachment.childHostId,
          attachment.lineageId,
          encode(attachment),
          attachment.attachedAt,
          timestamp,
        );
      this.#putAggregateRoute({
        entityType: "host",
        entityId: child.hostId,
        ownerHostId: child.hostId,
        immediateChildHostId: child.hostId,
        attachmentId: attachment.attachmentId,
        lineageId: attachment.lineageId,
      });
      this.#appendControl({ type: "host.upsert", host: child });
      if (!reconnected) this.#appendControl({ type: "host.attached", attachment });
    });
    this.#publishNewControls();
    return { attachment, child, reconnected };
  }

  /** Apply the attachment issued by this host's parent without importing ancestors. */
  public applyParentAttachment(attachmentInput: HostAttachment): HostDescriptor {
    const attachment = hostAttachmentSchema.parse(attachmentInput);
    const local = this.localHost();
    if (attachment.childHostId !== local.hostId) {
      throw new HostCoreError("FENCED", "parent attachment targets another child host");
    }
    const subtreeHostIds = new Set(this.listHosts().map((host) => host.hostId));
    if (
      subtreeHostIds.has(attachment.parentHostId) ||
      subtreeHostIds.has(attachment.rootHostId)
    ) {
      throw new HostCoreError("CONFLICT", "parent attachment would create a host cycle");
    }
    const attached = hostDescriptorSchema.parse({
      ...local,
      parentHostId: attachment.parentHostId,
      rootHostId: attachment.rootHostId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
      authorityHostId: attachment.authorityHostId,
      authorityEpochId: attachment.authorityEpochId,
      presence: "online",
      lastHeartbeatAt: this.#timestamp(),
    });
    this.#transaction(() => {
      for (const host of this.listHosts()) {
        const updated = hostDescriptorSchema.parse({
          ...host,
          ...(host.hostId === local.hostId
            ? {
                parentHostId: attachment.parentHostId,
                attachmentId: attachment.attachmentId,
                lineageId: attachment.lineageId,
              }
            : {}),
          rootHostId: attachment.rootHostId,
          authorityHostId: attachment.authorityHostId,
          authorityEpochId: attachment.authorityEpochId,
          ...(host.hostId === local.hostId
            ? { presence: "online", lastHeartbeatAt: this.#timestamp() }
            : {}),
        });
        this.#putHost(updated);
        this.#appendControl({ type: "host.upsert", host: updated });
      }
      for (const session of this.listSessions()) {
        const updated = sessionRecordSchema.parse({
          ...session,
          metadataAuthority: {
            hostId: attachment.authorityHostId,
            epochId: attachment.authorityEpochId,
          },
          updatedAt: this.#timestamp(),
        });
        this.#putSession(updated);
        this.#appendControl({ type: "session.upsert", session: updated });
      }
      this.#appendControl({ type: "host.attached", attachment });
    });
    this.#publishNewControls();
    return attached;
  }

  public detachChild(
    childHostId: HostId,
    attachmentId?: HostAttachment["attachmentId"],
  ): boolean {
    const attachment = this.getAttachment(childHostId);
    if (!attachment || (attachmentId !== undefined && attachment.attachmentId !== attachmentId)) {
      return false;
    }
    const child = this.getHost(childHostId);
    const timestamp = this.#timestamp();
    this.#transaction(() => {
      this.#db
        .prepare(
          `UPDATE host_attachments SET state = 'detached', updated_at = ?
           WHERE attachment_id = ? AND state = 'active'`,
        )
        .run(timestamp, attachment.attachmentId);
      for (const host of this.#hostsThroughChild(childHostId)) {
        const offline = hostDescriptorSchema.parse({
          ...host,
          presence: "offline",
          connectedAt: host.hostId === childHostId ? null : host.connectedAt,
        });
        this.#putHost(offline);
        this.#appendControl({ type: "host.presence", hostId: host.hostId, presence: "offline" });
      }
      for (const worker of this.#workersThroughChild(childHostId)) {
        const unreachable = workerDescriptorSchema.parse({
          ...worker,
          reachability: "unreachable",
        });
        this.#putWorker(unreachable);
        this.#appendControl({ type: "worker.upsert", worker: unreachable });
      }
      this.#appendControl({
        type: "host.detached",
        hostId: childHostId,
        attachmentId: attachment.attachmentId,
        lineageId: attachment.lineageId,
      });
    });
    this.#publishNewControls();
    return child !== null;
  }

  public heartbeatChild(
    childHostId: HostId,
    hostBootId: HostBootId,
    attachmentId: HostAttachment["attachmentId"],
    lineageId: HostAttachment["lineageId"],
  ): boolean {
    const attachment = this.#activeAttachment(childHostId, attachmentId);
    if (attachment.lineageId !== lineageId) {
      throw new HostCoreError("FENCED", "child heartbeat has a stale lineage");
    }
    const child = this.getHost(childHostId);
    if (!child || child.hostBootId !== hostBootId) {
      throw new HostCoreError("FENCED", "child heartbeat has a stale boot ID");
    }
    const wasOnline = child.presence === "online";
    const online = hostDescriptorSchema.parse({
      ...child,
      presence: "online",
      lastHeartbeatAt: this.#timestamp(),
      ...(wasOnline ? {} : { connectedAt: this.#timestamp() }),
    });
    this.#transaction(() => {
      this.#putHost(online);
      if (!wasOnline) {
        this.#appendControl({ type: "host.presence", hostId: childHostId, presence: "online" });
      }
    });
    this.#publishNewControls();
    return true;
  }

  /** A transport drop retains the active attachment and only changes reachability. */
  public markChildDisconnected(
    childHostId: HostId,
    hostBootId?: HostBootId,
  ): boolean {
    const attachment = this.getAttachment(childHostId);
    const child = this.getHost(childHostId);
    if (
      !attachment ||
      !child ||
      (hostBootId !== undefined && child.hostBootId !== hostBootId)
    ) {
      return false;
    }
    if (child.presence !== "online") return true;
    this.#transaction(() => {
      const stale = hostDescriptorSchema.parse({ ...child, presence: "stale" });
      this.#putHost(stale);
      this.#appendControl({ type: "host.presence", hostId: childHostId, presence: "stale" });
      for (const worker of this.#workersThroughChild(childHostId)) {
        const unreachable = workerDescriptorSchema.parse({
          ...worker,
          reachability: "unreachable",
        });
        this.#putWorker(unreachable);
        this.#appendControl({ type: "worker.upsert", worker: unreachable });
      }
    });
    this.#publishNewControls();
    return true;
  }

  public routeForWorker(workerId: WorkerId): AggregateRoute | null {
    const row = this.#db
      .prepare(
        `SELECT entity_type, entity_id, owner_host_id, immediate_child_host_id,
                attachment_id, lineage_id
         FROM aggregate_routes WHERE entity_type = 'worker' AND entity_id = ?`,
      )
      .get(workerId) as Row | undefined;
    return row ? this.#routeFromRow(row) : null;
  }

  public importChildSnapshotPage(
    childHostId: HostId,
    attachmentId: HostAttachment["attachmentId"],
    pageInput: HostSubtreeSnapshotPage,
  ): FeedCheckpoint {
    const page = pageInput;
    const attachment = this.#activeAttachment(childHostId, attachmentId);
    if (page.attachmentId !== attachment.attachmentId || page.lineageId !== attachment.lineageId) {
      throw new HostCoreError("FENCED", "snapshot belongs to another child attachment");
    }
    if (page.rootHostId !== childHostId) {
      throw new HostCoreError("FENCED", "snapshot root does not match the attached child");
    }
    this.#assertSnapshotTopology(childHostId, page.hosts);

    const importedWorkerIds = new Set<WorkerId>();
    this.#transaction(() => {
      const local = this.localHost();
      for (const incoming of page.hosts) {
        const host = hostDescriptorSchema.parse({
          ...incoming,
          ...(incoming.hostId === childHostId
            ? {
                parentHostId: local.hostId,
                attachmentId: attachment.attachmentId,
                lineageId: attachment.lineageId,
              }
            : {}),
          rootHostId: local.rootHostId,
          authorityHostId: local.authorityHostId,
          authorityEpochId: local.authorityEpochId,
          // The reverse link proves only that its immediate child is online.
          // Descendant presence remains the child's aggregate projection.
          presence: incoming.hostId === childHostId ? "online" : incoming.presence,
        });
        this.#assertRouteAvailable("host", host.hostId, childHostId);
        const previous = this.getHost(host.hostId);
        this.#putHost(host);
        this.#putAggregateRoute({
          entityType: "host",
          entityId: host.hostId,
          ownerHostId: host.hostId,
          immediateChildHostId: childHostId,
          attachmentId: attachment.attachmentId,
          lineageId: attachment.lineageId,
        });
        if (!previous || jsonForHash(previous) !== jsonForHash(host)) {
          this.#appendControl({ type: "host.upsert", host });
        }
      }
      for (const incoming of page.workers) {
        this.#assertRouteAvailable("worker", incoming.workerId, childHostId);
        this.#assertWorkerOwnerInChildSubtree(childHostId, incoming.ownerHostId);
        const worker = workerDescriptorSchema.parse(incoming);
        importedWorkerIds.add(worker.workerId);
        const previous = this.getWorker(worker.workerId);
        this.#putWorker(worker);
        this.#putAggregateRoute({
          entityType: "worker",
          entityId: worker.workerId,
          ownerHostId: worker.ownerHostId,
          immediateChildHostId: childHostId,
          attachmentId: attachment.attachmentId,
          lineageId: attachment.lineageId,
        });
        if (!previous || jsonForHash(previous) !== jsonForHash(worker)) {
          this.#appendControl({ type: "worker.upsert", worker });
        }
      }
      for (const incoming of page.sessions) {
        const route = this.routeForWorker(incoming.workerId);
        if (!route || route.immediateChildHostId !== childHostId) {
          throw new HostCoreError("CONFLICT", "snapshot session references a worker outside its subtree");
        }
        this.#assertRouteAvailable("session", incoming.sessionId, childHostId);
        const previous = this.getSession(incoming.sessionId);
        const session = sessionRecordSchema.parse({
          ...incoming,
          metadata: this.#metadataImportedFromChild(previous, incoming.metadata),
          metadataAuthority: {
            hostId: local.authorityHostId,
            epochId: local.authorityEpochId,
          },
        });
        this.#putSession(session);
        this.#settleImportedLifecycle(session);
        this.#putAggregateRoute({
          entityType: "session",
          entityId: session.sessionId,
          ownerHostId: route.ownerHostId,
          immediateChildHostId: childHostId,
          attachmentId: attachment.attachmentId,
          lineageId: attachment.lineageId,
        });
        if (!previous || jsonForHash(previous) !== jsonForHash(session)) {
          this.#appendControl({ type: "session.upsert", session });
        }
      }
      for (const incoming of page.interactions) {
        const route = this.#aggregateRoute("session", incoming.sessionId);
        if (!route || route.immediateChildHostId !== childHostId) {
          throw new HostCoreError(
            "CONFLICT",
            "snapshot interaction references a session outside its subtree",
          );
        }
        const merged = this.#mergeImportedInteraction(incoming);
        if (merged.changed) {
          this.#putInteraction(merged.interaction);
          this.#appendControl({
            type: "interaction.changed",
            interaction: merged.interaction,
          });
        }
      }
      for (const operation of page.metadataOperations) {
        const operationSession = this.getSession(operation.sessionId);
        if (
          operationSession &&
          operation.status !== "queued" &&
          operation.authorityEpochId !== operationSession.metadataAuthority.epochId
        ) {
          // Historical receipts from the child's former standalone authority
          // remain in its audit snapshot, but cannot enter the new tree epoch.
          continue;
        }
        const merged = this.#mergeMetadataOperationImportedFromChild(operation);
        if (merged.changed) {
          this.#appendControl({ type: "metadata.operation", operation: merged.operation });
        }
      }
      if (page.nextPageToken === null) {
        this.#putChildCheckpoint(childHostId, attachment, page.checkpoint);
      }
    });
    for (const workerId of importedWorkerIds) this.applyPendingLifecycleMetadata(workerId);
    this.#publishNewControls();
    return page.checkpoint;
  }

  public importChildControl(
    childHostId: HostId,
    attachmentId: HostAttachment["attachmentId"],
    itemInput: FeedControlItem,
  ): ImportedControlResult {
    const item = itemInput;
    const attachment = this.#activeAttachment(childHostId, attachmentId);
    const checkpoint = this.childCheckpoint(childHostId, attachmentId);
    if (checkpoint && checkpoint.feedId !== item.feedId) {
      throw new HostCoreError("CONFLICT", "child feed changed; import requires a fresh snapshot");
    }
    const known = this.#db
      .prepare("SELECT local_cursor, item_json FROM imported_control_events WHERE event_id = ?")
      .get(item.eventId) as Row | undefined;
    if (known) {
      if (
        known.item_json !== null &&
        String(known.item_json) !== this.#importedEventPayloadHash(item)
      ) {
        throw new HostCoreError(
          "PAYLOAD_MISMATCH",
          `global event ${item.eventId} was reused for another control item`,
        );
      }
      if (!checkpoint || checkpoint.controlCursor < item.cursor) {
        const expectedCursor = (checkpoint?.controlCursor ?? 0) + 1;
        if (item.cursor !== expectedCursor) {
          throw new HostCoreError(
            "CONFLICT",
            `child control cursor jumped from ${expectedCursor - 1} to ${item.cursor}`,
          );
        }
        this.#transaction(() => {
          this.#putChildCheckpoint(
            childHostId,
            attachment,
            feedCheckpointSchema.parse({ feedId: item.feedId, controlCursor: item.cursor }),
          );
        });
      }
      return {
        accepted: true,
        deduplicated: true,
        checkpoint:
          !checkpoint || checkpoint.controlCursor < item.cursor
            ? feedCheckpointSchema.parse({ feedId: item.feedId, controlCursor: item.cursor })
            : checkpoint,
        localCursor: Number(known.local_cursor),
      };
    }
    const expectedCursor = (checkpoint?.controlCursor ?? 0) + 1;
    if (item.cursor !== expectedCursor) {
      throw new HostCoreError(
        "CONFLICT",
        `child control cursor jumped from ${expectedCursor - 1} to ${item.cursor}`,
      );
    }
    let localCursor = 0;
    this.#transaction(() => {
      this.#applyImportedChange(childHostId, attachment, item.change);
      localCursor = this.#appendControl(this.#canonicalImportedChange(item.change), {
        eventId: item.eventId,
        originHostId: item.originHostId,
      });
      this.#failpoint?.("import.afterProjection");
      this.#db
        .prepare(
          `INSERT INTO imported_control_events(
             event_id, origin_host_id, child_host_id, attachment_id,
             origin_feed_id, origin_cursor, local_cursor, item_json, imported_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.eventId,
          item.originHostId,
          childHostId,
          attachment.attachmentId,
          item.feedId,
          item.cursor,
          localCursor,
          this.#importedEventPayloadHash(item),
          this.#timestamp(),
        );
      this.#putChildCheckpoint(
        childHostId,
        attachment,
        feedCheckpointSchema.parse({ feedId: item.feedId, controlCursor: item.cursor }),
      );
    });
    if (item.change.type === "session.upsert") {
      this.applyPendingLifecycleMetadata(item.change.session.workerId);
    }
    this.#publishNewControls();
    return {
      accepted: true,
      deduplicated: false,
      checkpoint: feedCheckpointSchema.parse({ feedId: item.feedId, controlCursor: item.cursor }),
      localCursor,
    };
  }

  public childCheckpoint(
    childHostId: HostId,
    attachmentId?: HostAttachment["attachmentId"],
  ): FeedCheckpoint | null {
    const row = this.#db
      .prepare(
        `SELECT feed_id, control_cursor FROM child_import_checkpoints
         WHERE child_host_id = ? ${attachmentId === undefined ? "" : "AND attachment_id = ?"}`,
      )
      .get(...(attachmentId === undefined ? [childHostId] : [childHostId, attachmentId])) as
      | Row
      | undefined;
    return row
      ? feedCheckpointSchema.parse({
          feedId: row.feed_id,
          controlCursor: Number(row.control_cursor),
        })
      : null;
  }

  public registerWorker(
    registration: WorkerRegistration,
    endpointId?: string,
  ): WorkerDescriptor {
    const current = this.getWorker(registration.workerId);
    const timestamp = this.#timestamp();
    const descriptor = workerDescriptorSchema.parse({
      ...registration,
      ownerHostId: this.#localHostId,
      ...(endpointId === undefined
        ? current?.endpointId === undefined
          ? {}
          : { endpointId: current.endpointId }
        : { endpointId }),
      presence: "online",
      reachability: "reachable",
      connectedAt: timestamp,
      lastHeartbeatAt: timestamp,
      protocolVersion: 2,
    });
    this.#transaction(() => {
      if (current && current.workerBootId !== registration.workerBootId) {
        this.#fencePreviousBoot(current.workerId, timestamp);
      }
      this.#putWorker(descriptor);
      this.#appendControl({ type: "worker.upsert", worker: descriptor });
    });
    this.#publishNewControls();
    return descriptor;
  }

  public heartbeat(workerId: WorkerId, workerBootId: string): boolean {
    const current = this.getWorker(workerId);
    if (!current || current.workerBootId !== workerBootId) return false;
    const wasOnline = current.presence === "online";
    const descriptor = workerDescriptorSchema.parse({
      ...current,
      presence: "online",
      reachability: "reachable",
      lastHeartbeatAt: this.#timestamp(),
    });
    this.#transaction(() => {
      this.#putWorker(descriptor);
      if (!wasOnline) {
        this.#appendControl({ type: "worker.presence", workerId, presence: "online" });
      }
    });
    this.#publishNewControls();
    return true;
  }

  public setWorkerPresence(
    workerId: WorkerId,
    presence: "online" | "offline" | "stale",
    workerBootId?: string,
  ): boolean {
    const current = this.getWorker(workerId);
    if (!current || (workerBootId !== undefined && current.workerBootId !== workerBootId)) {
      return false;
    }
    if (current.presence === presence) return true;
    const descriptor = workerDescriptorSchema.parse({
      ...current,
      presence,
      reachability:
        current.ownerHostId === this.#localHostId
          ? presence === "online"
            ? "reachable"
            : presence === "stale"
              ? "stale"
              : "unreachable"
          : current.reachability,
    });
    this.#transaction(() => {
      this.#putWorker(descriptor);
      this.#appendControl({ type: "worker.presence", workerId, presence });
    });
    this.#publishNewControls();
    return true;
  }

  public markStaleWorkers(staleBefore: Date): WorkerId[] {
    const changed: WorkerId[] = [];
    for (const worker of this.listWorkers()) {
      if (
        worker.ownerHostId === this.#localHostId &&
        worker.presence === "online" &&
        worker.lastHeartbeatAt !== null &&
        new Date(worker.lastHeartbeatAt) < staleBefore
      ) {
        if (this.setWorkerPresence(worker.workerId, "stale", worker.workerBootId)) {
          changed.push(worker.workerId);
        }
      }
    }
    return changed;
  }

  public markStaleChildren(staleBefore: Date): HostId[] {
    const changed: HostId[] = [];
    for (const host of this.listHosts()) {
      if (
        host.hostId !== this.#localHostId &&
        host.parentHostId === this.#localHostId &&
        this.getAttachment(host.hostId) !== null &&
        host.presence === "online" &&
        host.lastHeartbeatAt !== null &&
        new Date(host.lastHeartbeatAt) < staleBefore
      ) {
        if (this.setChildReachability(host.hostId, "stale")) {
          changed.push(host.hostId);
        }
      }
    }
    return changed;
  }

  public getWorker(workerId: WorkerId): WorkerDescriptor | null {
    const row = this.#db
      .prepare("SELECT record_json FROM workers WHERE worker_id = ?")
      .get(workerId) as Row | undefined;
    return rowRecord(workerDescriptorSchema, row);
  }

  public listWorkers(): WorkerDescriptor[] {
    const rows = this.#db
      .prepare("SELECT record_json FROM workers ORDER BY name, worker_id")
      .all() as Row[];
    return rows.map((row) => parsed(workerDescriptorSchema, row.record_json));
  }

  public getSession(sessionId: SessionId): SessionRecord | null {
    const row = this.#db
      .prepare("SELECT record_json FROM sessions WHERE session_id = ?")
      .get(sessionId) as Row | undefined;
    return rowRecord(sessionRecordSchema, row);
  }

  public listSessions(filter: SessionFilter = {}): SessionRecord[] {
    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (filter.workerId !== undefined) {
      conditions.push("worker_id = ?");
      parameters.push(filter.workerId);
    }
    if (filter.harness !== undefined) {
      conditions.push("harness = ?");
      parameters.push(filter.harness);
    }
    if (filter.availability !== undefined) {
      if (filter.availability.length === 0) return [];
      conditions.push(`availability IN (${filter.availability.map(() => "?").join(",")})`);
      parameters.push(...filter.availability);
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.#db
      .prepare(`SELECT record_json FROM sessions ${where} ORDER BY updated_at DESC, session_id`)
      .all(...parameters) as Row[];
    return rows.map((row) => parsed(sessionRecordSchema, row.record_json));
  }

  public reconcileInventory(
    snapshotInput: InventorySnapshot,
    options: ReconcileOptions = {},
  ): SessionRecord[] {
    const snapshot = inventorySnapshotSchema.parse(snapshotInput);
    if (this.getWorker(snapshot.workerId) === null) {
      throw new HostCoreError("NOT_FOUND", `worker ${snapshot.workerId} is not registered`);
    }
    const previousSnapshot = this.#db
      .prepare("SELECT generation FROM inventory_snapshots WHERE worker_id = ?")
      .get(snapshot.workerId) as Row | undefined;
    const lifecycleIntents = this.#pendingLifecycleIntents(snapshot.workerId);
    const unresolvedSpawnHarnesses = this.#unresolvedSpawnHarnesses(snapshot.workerId);
    const unresolvedLifecycleNativeKeys = this.#unresolvedLifecycleNativeKeys(snapshot.workerId);
    if (
      previousSnapshot &&
      previousSnapshot.generation === snapshot.generation &&
      lifecycleIntents.length === 0 &&
      unresolvedSpawnHarnesses.size === 0 &&
      unresolvedLifecycleNativeKeys.size === 0
    ) {
      return this.listSessions({ workerId: snapshot.workerId });
    }
    const lifecycleByNativeId = new Map<string, PendingLifecycleIntent[]>();
    for (const intent of lifecycleIntents) {
      const key = `${intent.harness}\0${intent.vendorSessionId}`;
      const entries = lifecycleByNativeId.get(key) ?? [];
      entries.push(intent);
      lifecycleByNativeId.set(key, entries);
    }
    const seen = new Set<string>();
    const settledLifecycleCommands = new Set<string>();
    let deferredInventory = false;
    this.#transaction(() => {
      for (const item of snapshot.sessions) {
        const key = nativeInventoryKey(snapshot.workerId, item);
        if (seen.has(key)) {
          throw new HostCoreError("CONFLICT", `inventory contains duplicate native session ${key}`);
        }
        seen.add(key);
        const row = this.#db
          .prepare(
            `SELECT record_json FROM sessions
             WHERE worker_id = ? AND harness = ? AND adapter_scope_id = ? AND vendor_session_id = ?`,
          )
          .get(snapshot.workerId, item.harness, item.adapterScopeId, item.vendorSessionId) as
          | Row
          | undefined;
        const existing = rowRecord(sessionRecordSchema, row);
        const explicitPreferred = options.preferredSessionIds?.get(key);
        const lifecycleCandidates = (
          lifecycleByNativeId.get(`${item.harness}\0${item.vendorSessionId}`) ?? []
        ).filter((intent) => !settledLifecycleCommands.has(intent.commandId));
        let lifecyclePreferred = lifecycleCandidates[0];
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
        if (explicitPreferred && lifecyclePreferred && explicitPreferred !== lifecyclePreferred.sessionId) {
          throw new HostCoreError(
            "CONFLICT",
            `lifecycle intent for ${item.vendorSessionId} targets another logical session`,
          );
        }
        const preferred = explicitPreferred ?? lifecyclePreferred?.sessionId;
        if (
          !existing &&
          preferred === undefined &&
          (unresolvedSpawnHarnesses.has(item.harness) ||
            unresolvedLifecycleNativeKeys.has(`${item.harness}\0${item.vendorSessionId}`))
        ) {
          // A native spawn can become visible before its command response tells
          // us which vendor ID belongs to the preallocated logical session.
          // Do not invent a competing logical identity during that window.
          deferredInventory = true;
          continue;
        }
        const preferredRecord = preferred ? this.getSession(preferred) : null;
        if (existing && preferred && existing.sessionId !== preferred) {
          throw new HostCoreError(
            "CONFLICT",
            `native session ${item.vendorSessionId} is already bound to ${existing.sessionId}`,
          );
        }
        if (preferredRecord && !existing) {
          this.#assertCanRebind(preferredRecord, snapshot.workerId, item);
        }
        const base = existing ?? preferredRecord;
        if (base?.runtimeEpoch && base.runtimeEpoch !== item.runtimeEpoch) {
          this.#staleInteractionsForSession(base.sessionId);
        }
        const timestamp = this.#timestamp();
        const record = sessionRecordSchema.parse({
          sessionId: base?.sessionId ?? preferred ?? newSessionId(),
          workerId: snapshot.workerId,
          harness: item.harness,
          adapterScopeId: item.adapterScopeId,
          vendorSessionId: item.vendorSessionId,
          bindingRevision: base
            ? this.#sameBinding(base, snapshot.workerId, item)
              ? base.bindingRevision
              : base.bindingRevision + 1
            : 1,
          runtimeEpoch: item.runtimeEpoch,
          cwd: item.cwd,
          availability: item.availability,
          runtimeStatus: item.runtimeStatus,
          ...(item.nativeSummary === undefined ? {} : { nativeSummary: item.nativeSummary }),
          metadata: base?.metadata ?? emptyMetadataSnapshot(),
          metadataAuthority: base?.metadataAuthority ?? {
            hostId: this.localHost().authorityHostId,
            epochId: this.localHost().authorityEpochId,
          },
          createdAt: base?.createdAt ?? timestamp,
          updatedAt: timestamp,
          lastSeenAt: snapshot.capturedAt,
        });
        this.#putSession(record);
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
        for (const current of this.listSessions({ workerId: snapshot.workerId })) {
          const key = nativeInventoryKey(snapshot.workerId, current);
          if (seen.has(key) || current.availability === "unavailable") continue;
          const unavailable = sessionRecordSchema.parse({
            ...current,
            availability: "unavailable",
            runtimeStatus: "unknown",
            runtimeEpoch: null,
            updatedAt: this.#timestamp(),
          });
          this.#putSession(unavailable);
          this.#staleInteractionsForSession(current.sessionId);
          this.#appendControl({ type: "session.unavailable", sessionId: current.sessionId });
        }
      }
      if (deferredInventory) {
        // Removing the generation checkpoint ensures the exact same snapshot
        // is reconsidered after the command succeeds, fails, or is recovered.
        this.#db
          .prepare("DELETE FROM inventory_snapshots WHERE worker_id = ?")
          .run(snapshot.workerId);
      } else {
        this.#db
          .prepare(
            `INSERT INTO inventory_snapshots(worker_id, generation, snapshot_json, captured_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(worker_id) DO UPDATE SET generation = excluded.generation,
               snapshot_json = excluded.snapshot_json, captured_at = excluded.captured_at`,
          )
          .run(snapshot.workerId, snapshot.generation, encode(snapshot), snapshot.capturedAt);
      }
      if (!deferredInventory) {
        this.#appendControl({
          type: "inventory.completed",
          workerId: snapshot.workerId,
          generation: snapshot.generation,
        });
      }
    });
    this.#publishNewControls();
    return this.listSessions({ workerId: snapshot.workerId });
  }

  /**
   * Persist the logical identity reserved by a spawn/resume command before the
   * native side effect is dispatched. A successful command result makes the
   * intent eligible for a later inventory reconciliation, even after restart.
   */
  public recordLifecycleIntent(input: SpawnCommand | ResumeCommand): void {
    const command = this.getCommand(input.commandId);
    if (!command) {
      throw new HostCoreError("NOT_FOUND", `command ${input.commandId} is not registered`);
    }
    this.#assertLifecycleCommand(command, input);
    this.#transaction(() => this.#putLifecycleIntent(command, input));
  }

  #putLifecycleIntent(
    command: CommandRecord,
    input: SpawnCommand | ResumeCommand,
  ): void {
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
      throw new HostCoreError(
        "PAYLOAD_MISMATCH",
        "worker resumed a vendor session other than the one requested",
      );
    }
    const vendorSessionId = resultVendorSessionId ?? requestedVendorSessionId;
    const ready = command.state === "succeeded" && vendorSessionId !== undefined;
    const current = this.#db
      .prepare(
        `SELECT worker_id, session_id, harness, vendor_session_id, metadata_json
         FROM lifecycle_intents WHERE command_id = ?`,
      )
      .get(input.commandId) as Row | undefined;

    if (current) {
      const currentMetadata = current.metadata_json === null
        ? {}
        : metadataValuesSchema.parse(decode(current.metadata_json));
      if (
        current.worker_id !== input.workerId ||
        current.session_id !== input.sessionId ||
        current.harness !== input.request.harness ||
        canonicalJson(currentMetadata) !== canonicalJson(metadata)
      ) {
        throw new HostCoreError(
          "PAYLOAD_MISMATCH",
          `command ${input.commandId} has another lifecycle binding intent`,
        );
      }
      if (
        current.vendor_session_id !== null &&
        vendorSessionId !== undefined &&
        current.vendor_session_id !== vendorSessionId
      ) {
        throw new HostCoreError(
          "PAYLOAD_MISMATCH",
          `command ${input.commandId} resolved to another vendor session`,
        );
      }
      if (ready) {
        this.#db
          .prepare(
            `UPDATE lifecycle_intents
             SET vendor_session_id = ?, ready = 1
             WHERE command_id = ?`,
          )
          .run(vendorSessionId, input.commandId);
      }
      return;
    }

    this.#db
      .prepare(
        `INSERT INTO lifecycle_intents(
           command_id, worker_id, session_id, harness, vendor_session_id,
           ready, binding_state, binding_error, metadata_json,
           metadata_operation_id, metadata_applied, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, ?)`,
      )
      .run(
        input.commandId,
        input.workerId,
        input.sessionId,
        input.request.harness,
        vendorSessionId ?? null,
        ready ? 1 : 0,
        metadataJson,
        // A lifecycle command crosses every routing hop unchanged. Reusing its
        // UUID in the operation namespace gives all hosts one durable metadata
        // identity instead of independently applying the spawn metadata.
        operationIdSchema.parse(input.commandId),
        metadataJson === null ? 1 : 0,
        this.#timestamp(),
      );
  }

  /** Apply deferred spawn metadata after its logical session binding exists. */
  public applyPendingLifecycleMetadata(workerId: WorkerId): number {
    const rows = this.#db
      .prepare(
        `SELECT command_id, session_id, metadata_json, metadata_operation_id
         FROM lifecycle_intents
         WHERE worker_id = ? AND binding_state = 'bound'
           AND metadata_applied = 0 AND metadata_json IS NOT NULL
         ORDER BY created_at, command_id`,
      )
      .all(workerId) as Row[];
    let applied = 0;
    for (const row of rows) {
      const session = this.getSession(row.session_id as SessionId);
      if (!session) continue;
      const operation = this.submitMetadataPatch(
        {
          operationId: operationIdSchema.parse(row.metadata_operation_id),
          sessionId: row.session_id as SessionId,
          set: metadataValuesSchema.parse(decode(row.metadata_json)),
        },
        // Every projection retains the worker's owning leaf host, giving this
        // lifecycle-derived operation one stable origin at every routing hop.
        this.getWorker(session.workerId)?.ownerHostId ?? this.#localHostId,
      );
      if (operation.status !== "queued") {
        // Lifecycle metadata is applied by the catalog while a session binding
        // is imported. Unlike HostService.patchMetadata(), that path cannot
        // directly schedule the terminal receipt. Persist the same durable
        // child delivery invariant here so snapshot-vs-control timing cannot
        // strand descendants at revision zero.
        const route = this.#aggregateRoute("session", session.sessionId);
        if (route) {
          this.enqueueMetadataReplication(route.immediateChildHostId, operation);
        }
      }
      this.#db
        .prepare("UPDATE lifecycle_intents SET metadata_applied = 1 WHERE command_id = ?")
        .run(String(row.command_id));
      applied += 1;
    }
    return applied;
  }

  /** Merge worker-owned runtime fields without accepting worker metadata/history. */
  public mergeWorkerSession(incoming: SessionRecord): SessionRecord {
    const current = this.getSession(incoming.sessionId);
    if (!current) throw new HostCoreError("NOT_FOUND", "session is not registered");
    if (
      current.workerId !== incoming.workerId ||
      current.bindingRevision !== incoming.bindingRevision ||
      current.harness !== incoming.harness ||
      current.adapterScopeId !== incoming.adapterScopeId ||
      current.vendorSessionId !== incoming.vendorSessionId
    ) {
      throw new HostCoreError("FENCED", "worker session binding is stale");
    }
    const record = sessionRecordSchema.parse({
      ...incoming,
      metadata: current.metadata,
      metadataAuthority: current.metadataAuthority,
      createdAt: current.createdAt,
      updatedAt: this.#timestamp(),
    });
    this.#transaction(() => {
      this.#putSession(record);
      this.#appendControl({ type: "session.upsert", session: record });
    });
    this.#publishNewControls();
    return record;
  }

  public getMetadata(sessionId: SessionId): MetadataSnapshot {
    const record = this.getSession(sessionId);
    if (!record) throw new HostCoreError("NOT_FOUND", `session ${sessionId} does not exist`);
    return metadataFor(record);
  }

  public patchMetadata(patchInput: MetadataPatch): MetadataPatchResult {
    const patch = metadataPatchSchema.parse(patchInput);
    const patchJson = jsonForHash(patch);
    const prior = this.#db
      .prepare("SELECT patch_json, result_json FROM metadata_operations WHERE operation_id = ?")
      .get(patch.operationId) as Row | undefined;
    if (prior) {
      if (String(prior.patch_json) !== patchJson) {
        throw new HostCoreError(
          "PAYLOAD_MISMATCH",
          `operation ${patch.operationId} was already used for another metadata patch`,
        );
      }
      const result = parsed(metadataPatchResultSchema, prior.result_json);
      return result.accepted ? { ...result, deduplicated: true } : result;
    }

    let result!: MetadataPatchResult;
    this.#transaction(() => {
      const record = this.getSession(patch.sessionId);
      if (!record) throw new HostCoreError("NOT_FOUND", `session ${patch.sessionId} does not exist`);
      const current = record.metadata;
      const conflicts = Object.entries(patch.ifKeyRevision ?? {}).flatMap(
        ([key, expectedRevision]) => {
          const actualRevision = current.keyRevisions[key] ?? null;
          if (actualRevision === expectedRevision) return [];
          const actualValue = current.values[key];
          return [
            {
              key,
              expectedRevision,
              actualRevision,
              ...(actualValue === undefined ? {} : { actualValue }),
            },
          ];
        },
      );
      if (conflicts.length > 0) {
        result = metadataPatchResultSchema.parse({
          accepted: false,
          operationId: patch.operationId,
          snapshot: current,
          conflicts,
        });
      } else {
        const revision = current.revision + 1;
        const values = { ...current.values };
        const keyRevisions = { ...current.keyRevisions };
        for (const [key, value] of Object.entries(patch.set ?? {})) {
          values[key] = value;
          keyRevisions[key] = revision;
        }
        for (const key of patch.remove ?? []) {
          delete values[key];
          keyRevisions[key] = revision;
        }
        const snapshot = { revision, values, keyRevisions };
        const updated = sessionRecordSchema.parse({
          ...record,
          metadata: snapshot,
          updatedAt: this.#timestamp(),
        });
        this.#putSession(updated);
        result = metadataPatchResultSchema.parse({
          accepted: true,
          operationId: patch.operationId,
          snapshot,
          deduplicated: false,
        });
        this.#appendControl({
          type: "metadata.changed",
          sessionId: patch.sessionId,
          metadata: snapshot,
        });
      }
      this.#db
        .prepare(
          "INSERT INTO metadata_operations(operation_id, session_id, patch_json, result_json, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(patch.operationId, patch.sessionId, patchJson, encode(result), this.#timestamp());
    });
    this.#publishNewControls();
    return result;
  }

  public submitMetadataPatch(
    patchInput: MetadataPatch,
    originHostId: HostId = this.#localHostId,
  ): MetadataOperationRecord {
    const patch = metadataPatchSchema.parse(patchInput);
    const prior = this.getMetadataOperation(patch.operationId);
    if (prior) {
      if (jsonForHash(prior.patch) !== jsonForHash(patch)) {
        throw new HostCoreError(
          "PAYLOAD_MISMATCH",
          `operation ${patch.operationId} was already used for another metadata patch`,
        );
      }
      return prior;
    }
    const session = this.getSession(patch.sessionId);
    if (!session) throw new HostCoreError("NOT_FOUND", `session ${patch.sessionId} does not exist`);

    if (session.metadataAuthority.hostId === this.#localHostId) {
      const result = this.patchMetadata(patch);
      const timestamp = this.#timestamp();
      const operation = metadataOperationRecordSchema.parse({
        operationId: patch.operationId,
        sessionId: patch.sessionId,
        patch,
        status: result.accepted ? "accepted" : "conflicted",
        canonical: result.snapshot,
        ...(!result.accepted ? { conflicts: result.conflicts } : {}),
        originHostId,
        authorityEpochId: session.metadataAuthority.epochId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      this.#transaction(() => {
        this.#putMetadataOperation(operation);
        this.#appendControl({ type: "metadata.operation", operation });
      });
      this.#publishNewControls();
      return operation;
    }

    const timestamp = this.#timestamp();
    const operation = metadataOperationRecordSchema.parse({
      operationId: patch.operationId,
      sessionId: patch.sessionId,
      patch,
      status: "queued",
      canonical: session.metadata,
      optimistic: this.#optimisticMetadata(session.metadata, patch),
      originHostId,
      authorityEpochId: session.metadataAuthority.epochId,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.#transaction(() => {
      this.#putMetadataOperation(operation);
      this.#appendControl({ type: "metadata.operation", operation });
    });
    this.#publishNewControls();
    return operation;
  }

  public getMetadataOperation(operationId: string): MetadataOperationRecord | null {
    const row = this.#db
      .prepare("SELECT record_json FROM metadata_operation_ledger WHERE operation_id = ?")
      .get(operationId) as Row | undefined;
    return rowRecord(metadataOperationRecordSchema, row);
  }

  public listMetadataOperations(
    filter: {
      sessionId?: SessionId;
      originHostId?: HostId;
      status?: MetadataOperationRecord["status"];
      statuses?: readonly MetadataOperationRecord["status"][];
      limit?: number;
    } = {},
  ): MetadataOperationRecord[] {
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (filter.sessionId !== undefined) {
      conditions.push("session_id = ?");
      parameters.push(filter.sessionId);
    }
    if (filter.status !== undefined) {
      conditions.push("status = ?");
      parameters.push(filter.status);
    }
    if (filter.statuses !== undefined) {
      if (filter.statuses.length === 0) return [];
      conditions.push(`status IN (${filter.statuses.map(() => "?").join(",")})`);
      parameters.push(...filter.statuses);
    }
    if (filter.originHostId !== undefined) {
      conditions.push("json_extract(record_json, '$.originHostId') = ?");
      parameters.push(filter.originHostId);
    }
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const limit = filter.limit ?? 10_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new RangeError("metadata operation limit must be between 1 and 10,000");
    }
    const rows = this.#db
      .prepare(
        `SELECT record_json FROM metadata_operation_ledger ${where}
         ORDER BY created_at, operation_id LIMIT ?`,
      )
      .all(...parameters, limit) as Row[];
    return rows.map((row) => parsed(metadataOperationRecordSchema, row.record_json));
  }

  public recordQueuedMetadataOperation(
    input: MetadataOperationRecord,
  ): MetadataOperationRecord {
    const operation = metadataOperationRecordSchema.parse(input);
    if (operation.status !== "queued") {
      throw new HostCoreError("CONFLICT", "only queued metadata operations can enter an outbox");
    }
    const session = this.getSession(operation.sessionId);
    if (!session) throw new HostCoreError("NOT_FOUND", "metadata operation session is missing");
    if (operation.authorityEpochId !== session.metadataAuthority.epochId) {
      throw new HostCoreError("FENCED", "metadata operation targets a stale authority epoch");
    }
    const current = this.getMetadataOperation(operation.operationId);
    if (current) {
      this.#assertSameMetadataOperationIdentity(current, operation);
      return current;
    }
    this.#transaction(() => {
      this.#putMetadataOperation(operation);
      this.#appendControl({ type: "metadata.operation", operation });
    });
    this.#publishNewControls();
    return operation;
  }

  public applyMetadataOperationAtAuthority(
    input: MetadataOperationRecord,
  ): MetadataOperationRecord {
    const operation = metadataOperationRecordSchema.parse(input);
    const session = this.getSession(operation.sessionId);
    if (!session) throw new HostCoreError("NOT_FOUND", "metadata operation session is missing");
    if (session.metadataAuthority.hostId !== this.#localHostId) {
      throw new HostCoreError("FENCED", "this host is not the metadata authority");
    }
    if (operation.authorityEpochId !== session.metadataAuthority.epochId) {
      throw new HostCoreError("FENCED", "metadata operation targets a stale authority epoch");
    }
    const current = this.getMetadataOperation(operation.operationId);
    if (current) this.#assertSameMetadataOperationIdentity(current, operation);
    if (current && current.status !== "queued") return current;
    const result = this.patchMetadata(operation.patch);
    const terminal = metadataOperationRecordSchema.parse({
      ...operation,
      status: result.accepted ? "accepted" : "conflicted",
      canonical: result.snapshot,
      ...(result.accepted ? {} : { conflicts: result.conflicts }),
      updatedAt: this.#timestamp(),
    });
    const normalized = { ...terminal };
    delete normalized.optimistic;
    this.#transaction(() => {
      this.#putMetadataOperation(normalized);
      this.#appendControl({ type: "metadata.operation", operation: normalized });
    });
    this.#publishNewControls();
    return normalized;
  }

  public enqueueMetadataReplication(
    childHostId: HostId,
    operationInput: MetadataOperationRecord,
  ): void {
    const operation = metadataOperationRecordSchema.parse(operationInput);
    if (operation.status === "queued") {
      throw new HostCoreError("CONFLICT", "queued operations cannot replicate downstream");
    }
    const attachment = this.getAttachment(childHostId);
    // A route survives an ordinary disconnect. Queueing the terminal receipt
    // must therefore survive it too; the next reverse connection flushes this
    // durable row. Only a completely unknown host is an invalid target.
    if (!attachment && !this.getHost(childHostId)) {
      throw new HostCoreError("NOT_FOUND", "metadata replication child is unknown");
    }
    this.#db
      .prepare(
        `INSERT INTO downstream_replication_queue(
           child_host_id, operation_id, record_json, delivered, created_at
         ) VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(child_host_id, operation_id) DO UPDATE SET
           record_json = excluded.record_json,
           delivered = CASE
             WHEN downstream_replication_queue.record_json = excluded.record_json
               THEN downstream_replication_queue.delivered
             ELSE 0
           END`,
      )
      .run(childHostId, operation.operationId, encode(operation), this.#timestamp());
  }

  public pendingMetadataReplication(
    childHostId: HostId,
    limit = 1_000,
  ): MetadataOperationRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT record_json FROM downstream_replication_queue
         WHERE child_host_id = ? AND delivered = 0
         ORDER BY created_at, operation_id LIMIT ?`,
      )
      .all(childHostId, limit) as Row[];
    return rows.map((row) => parsed(metadataOperationRecordSchema, row.record_json));
  }

  /** Remember that a directly attached worker has transferred this queued operation. */
  public trackWorkerMetadataReplication(
    workerId: WorkerId,
    operationInput: MetadataOperationRecord,
  ): void {
    const operation = metadataOperationRecordSchema.parse(operationInput);
    if (operation.status !== "queued") {
      throw new HostCoreError("CONFLICT", "only queued worker operations require later settlement");
    }
    const session = this.getSession(operation.sessionId);
    const worker = this.getWorker(workerId);
    if (
      !session ||
      session.workerId !== workerId ||
      !worker ||
      worker.ownerHostId !== this.#localHostId ||
      this.routeForWorker(workerId) !== null
    ) {
      throw new HostCoreError("FENCED", "metadata settlement target is not a direct worker");
    }
    this.#db
      .prepare(
        `INSERT INTO worker_metadata_replication_queue(
           worker_id, operation_id, status, record_json, delivered, created_at
         ) VALUES (?, ?, 'queued', ?, 0, ?)
         ON CONFLICT(worker_id, operation_id) DO NOTHING`,
      )
      .run(workerId, operation.operationId, encode(operation), this.#timestamp());
  }

  /** Promote an existing direct-worker queue row to a terminal deliverable. */
  public enqueueWorkerMetadataReplication(
    workerId: WorkerId,
    operationInput: MetadataOperationRecord,
  ): boolean {
    const operation = metadataOperationRecordSchema.parse(operationInput);
    if (operation.status === "queued") return false;
    const changed = this.#db
      .prepare(
        `UPDATE worker_metadata_replication_queue
         SET status = ?, record_json = ?, delivered = 0
         WHERE worker_id = ? AND operation_id = ?`,
      )
      .run(operation.status, encode(operation), workerId, operation.operationId);
    return Number(changed.changes) > 0;
  }

  public pendingWorkerMetadataReplication(
    workerId: WorkerId,
    limit = 1_000,
  ): MetadataOperationRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT record_json FROM worker_metadata_replication_queue
         WHERE worker_id = ? AND delivered = 0
           AND status IN ('accepted', 'conflicted')
         ORDER BY created_at, operation_id LIMIT ?`,
      )
      .all(workerId, limit) as Row[];
    return rows.map((row) => parsed(metadataOperationRecordSchema, row.record_json));
  }

  public markWorkerMetadataReplicationDelivered(
    workerId: WorkerId,
    operationId: string,
  ): void {
    this.#db
      .prepare(
        `UPDATE worker_metadata_replication_queue SET delivered = 1
         WHERE worker_id = ? AND operation_id = ?`,
      )
      .run(workerId, operationId);
  }

  /**
   * Repair the narrow crash window between committing a terminal metadata
   * receipt and inserting its downstream delivery row. Existing delivered or
   * pending rows are intentionally retained unchanged.
   */
  public recoverTerminalMetadataReplication(): number {
    let recovered = 0;
    this.#transaction(() => {
      const rows = this.#db
        .prepare(
          `SELECT record_json FROM metadata_operation_ledger
           WHERE status IN ('accepted', 'conflicted')
           ORDER BY created_at, operation_id`,
        )
        .all() as Row[];
      for (const row of rows) {
        const operation = parsed(metadataOperationRecordSchema, row.record_json);
        const session = this.getSession(operation.sessionId);
        const route = session ? this.#aggregateRoute("session", session.sessionId) : null;
        if (route) {
          const changed = this.#db
            .prepare(
              `INSERT OR IGNORE INTO downstream_replication_queue(
                 child_host_id, operation_id, record_json, delivered, created_at
               ) VALUES (?, ?, ?, 0, ?)`,
            )
            .run(
              route.immediateChildHostId,
              operation.operationId,
              encode(operation),
              this.#timestamp(),
            );
          recovered += Number(changed.changes);
        }

        const workerChanged = this.#db
          .prepare(
            `UPDATE worker_metadata_replication_queue
             SET status = ?, record_json = ?, delivered = 0
             WHERE operation_id = ? AND status = 'queued'`,
          )
          .run(operation.status, encode(operation), operation.operationId);
        recovered += Number(workerChanged.changes);
      }
    });
    return recovered;
  }

  public markMetadataReplicationDelivered(childHostId: HostId, operationId: string): void {
    this.#db
      .prepare(
        `UPDATE downstream_replication_queue SET delivered = 1
         WHERE child_host_id = ? AND operation_id = ?`,
      )
      .run(childHostId, operationId);
  }

  public settleMetadataOperation(
    input: MetadataOperationRecord,
    options: { acceptAuthorityEpochFromParent?: boolean } = {},
  ): MetadataOperationRecord {
    const operation = metadataOperationRecordSchema.parse(input);
    if (operation.status === "queued") {
      throw new HostCoreError("CONFLICT", "an upstream result cannot remain queued");
    }
    const current = this.getMetadataOperation(operation.operationId);
    if (current) {
      this.#assertSameMetadataOperationIdentity(current, operation);
      if (current.status !== "queued") {
        this.#assertSameTerminalMetadataReceipt(current, operation);
        return current;
      }
    }
    const session = this.getSession(operation.sessionId);
    if (!session) throw new HostCoreError("NOT_FOUND", "metadata operation session is missing");
    if (
      operation.authorityEpochId !== session.metadataAuthority.epochId &&
      !options.acceptAuthorityEpochFromParent
    ) {
      throw new HostCoreError("FENCED", "metadata operation belongs to a stale authority epoch");
    }
    if (
      operation.canonical.revision === session.metadata.revision &&
      jsonForHash(operation.canonical) !== jsonForHash(session.metadata)
    ) {
      throw new HostCoreError(
        "CONFLICT",
        "metadata operation returned a divergent snapshot at the canonical revision",
      );
    }
    this.#transaction(() => {
      const authorityChanged = operation.authorityEpochId !== session.metadataAuthority.epochId;
      const metadataChanged = operation.canonical.revision > session.metadata.revision;
      if (authorityChanged || metadataChanged) {
        const updated = sessionRecordSchema.parse({
          ...session,
          ...(authorityChanged
            ? {
                metadataAuthority: {
                  ...session.metadataAuthority,
                  epochId: operation.authorityEpochId,
                },
              }
            : {}),
          ...(metadataChanged ? { metadata: operation.canonical } : {}),
          updatedAt: this.#timestamp(),
        });
        this.#putSession(updated);
        if (authorityChanged) {
          this.#appendControl({ type: "session.upsert", session: updated });
        }
      }
      if (metadataChanged) {
        this.#appendControl({
          type: "metadata.changed",
          sessionId: session.sessionId,
          metadata: operation.canonical,
        });
      }
      this.#putMetadataOperation(operation);
      this.#appendControl({ type: "metadata.operation", operation });
    });
    this.#publishNewControls();
    return operation;
  }

  public acceptCommand(
    recordInput: CommandRecord,
    lifecycleInput?: SpawnCommand | ResumeCommand,
  ): CommandRecord {
    const record = commandRecordSchema.parse(recordInput);
    if (lifecycleInput) this.#assertLifecycleCommand(record, lifecycleInput);
    const existing = this.getCommand(record.commandId);
    if (existing) {
      this.#assertSameCommand(existing, record);
      if (lifecycleInput) {
        this.#transaction(() => this.#putLifecycleIntent(existing, lifecycleInput));
      }
      return existing;
    }
    this.#transaction(() => {
      this.#putCommand(record);
      if (lifecycleInput) this.#putLifecycleIntent(record, lifecycleInput);
      this.#appendControl({ type: "command.changed", command: record });
    });
    this.#publishNewControls();
    return record;
  }

  public updateCommand(recordInput: CommandRecord): CommandRecord {
    const incoming = commandRecordSchema.parse(recordInput);
    const current = this.getCommand(incoming.commandId);
    if (!current) return this.acceptCommand(incoming);
    this.#assertSameCommand(current, incoming);
    if (!this.#canTransitionCommand(current.state, incoming.state)) {
      if (this.#commandStateRank(incoming.state) < this.#commandStateRank(current.state)) {
        return current;
      }
      throw new HostCoreError(
        "CONFLICT",
        `command ${current.commandId} cannot transition from ${current.state} to ${incoming.state}`,
      );
    }
    const record = commandRecordSchema.parse({
      ...incoming,
      createdAt: current.createdAt,
      updatedAt: this.#timestamp(),
    });
    this.#transaction(() => {
      this.#putCommand(record);
      this.#syncLifecycleIntentForCommand(record);
      this.#appendControl({ type: "command.changed", command: record });
    });
    this.#publishNewControls();
    return record;
  }

  public transitionCommand(
    commandId: string,
    state: CommandState,
    update: { result?: JsonValue; error?: string } = {},
  ): CommandRecord {
    const current = this.getCommand(commandId);
    if (!current) throw new HostCoreError("NOT_FOUND", `command ${commandId} does not exist`);
    const record = commandRecordSchema.parse({
      ...current,
      state,
      ...update,
      updatedAt: this.#timestamp(),
    });
    return this.updateCommand(record);
  }

  public getCommand(commandId: string): CommandRecord | null {
    const row = this.#db
      .prepare("SELECT record_json FROM commands WHERE command_id = ?")
      .get(commandId) as Row | undefined;
    return rowRecord(commandRecordSchema, row);
  }

  public publishInteraction(input: InteractionRecord): InteractionRecord {
    const incoming = interactionRecordSchema.parse(input);
    const session = this.getSession(incoming.sessionId);
    if (!session) throw new HostCoreError("NOT_FOUND", "interaction session is not registered");
    if (session.harness !== incoming.harness || session.runtimeEpoch !== incoming.runtimeEpoch) {
      throw new HostCoreError("FENCED", "interaction belongs to a stale session runtime");
    }
    const existing = this.getInteraction(incoming.interactionId);
    if (existing && existing.sessionId !== incoming.sessionId) {
      throw new HostCoreError("PAYLOAD_MISMATCH", "interaction ID was reused for another session");
    }
    if (existing) {
      if (
        existing.harness !== incoming.harness ||
        existing.runtimeEpoch !== incoming.runtimeEpoch ||
        existing.nativeRequestId !== incoming.nativeRequestId ||
        existing.requestType !== incoming.requestType ||
        existing.ephemeral !== incoming.ephemeral ||
        existing.createdAt !== incoming.createdAt ||
        existing.expiresAt !== incoming.expiresAt ||
        jsonForHash(existing.payload) !== jsonForHash(incoming.payload)
      ) {
        throw new HostCoreError("PAYLOAD_MISMATCH", "interaction ID was reused for another request");
      }
      if (existing.state !== "pending" && incoming.state === "pending") return existing;
      if (existing.state !== "pending") {
        if (incoming.state !== existing.state) {
          throw new HostCoreError("CONFLICT", "a terminal interaction cannot change state");
        }
        if (!this.#sameInteractionResolution(existing, incoming)) {
          throw new HostCoreError(
            "CONFLICT",
            "interaction was already resolved with another response",
          );
        }
        return existing;
      }
      if (incoming.state === "pending") return existing;
    }
    this.#transaction(() => {
      this.#putInteraction(incoming);
      this.#appendControl({ type: "interaction.changed", interaction: incoming });
    });
    this.#publishNewControls();
    return incoming;
  }

  public getInteraction(interactionId: string): InteractionRecord | null {
    const row = this.#db
      .prepare("SELECT record_json FROM interactions WHERE interaction_id = ?")
      .get(interactionId) as Row | undefined;
    return rowRecord(interactionRecordSchema, row);
  }

  public updateInteraction(input: InteractionRecord): InteractionRecord {
    const incoming = interactionRecordSchema.parse(input);
    const current = this.getInteraction(incoming.interactionId);
    if (!current) throw new HostCoreError("NOT_FOUND", "interaction is not registered");
    if (current.sessionId !== incoming.sessionId || current.runtimeEpoch !== incoming.runtimeEpoch) {
      throw new HostCoreError("FENCED", "interaction response belongs to a stale request");
    }
    if (current.state !== "pending") {
      if (incoming.state !== current.state || !this.#sameInteractionResolution(current, incoming)) {
        throw new HostCoreError("CONFLICT", "a terminal interaction cannot change resolution");
      }
      return current;
    }
    this.#transaction(() => {
      this.#putInteraction(incoming);
      this.#appendControl({ type: "interaction.changed", interaction: incoming });
    });
    this.#publishNewControls();
    return incoming;
  }

  public listInteractions(
    filter: {
      sessionId?: SessionId | undefined;
      pendingOnly?: boolean | undefined;
    } = {},
  ): InteractionRecord[] {
    const conditions: string[] = [];
    const parameters: string[] = [];
    if (filter.sessionId !== undefined) {
      conditions.push("session_id = ?");
      parameters.push(filter.sessionId);
    }
    if (filter.pendingOnly ?? true) conditions.push("state = 'pending'");
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.#db
      .prepare(`SELECT record_json FROM interactions ${where} ORDER BY created_at, interaction_id`)
      .all(...parameters) as Row[];
    return rows.map((row) => parsed(interactionRecordSchema, row.record_json));
  }

  public expireInteractions(at = this.#now()): number {
    const expiring = this.listInteractions({ pendingOnly: true }).filter(
      (interaction) => interaction.expiresAt !== null && new Date(interaction.expiresAt) <= at,
    );
    if (expiring.length === 0) return 0;
    this.#transaction(() => {
      for (const interaction of expiring) {
        const expired = interactionRecordSchema.parse({ ...interaction, state: "expired" });
        this.#putInteraction(expired);
        this.#appendControl({ type: "interaction.changed", interaction: expired });
      }
    });
    this.#publishNewControls();
    return expiring.length;
  }

  static #migrate(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS host_identity (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        host_id TEXT NOT NULL UNIQUE,
        feed_id TEXT NOT NULL UNIQUE,
        lineage_id TEXT NOT NULL,
        authority_epoch_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS hosts (
        host_id TEXT PRIMARY KEY,
        host_boot_id TEXT NOT NULL,
        parent_host_id TEXT,
        root_host_id TEXT NOT NULL,
        attachment_id TEXT,
        presence TEXT NOT NULL,
        record_json TEXT NOT NULL CHECK(json_valid(record_json))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS hosts_parent ON hosts(parent_host_id, host_id);
      CREATE TABLE IF NOT EXISTS host_attachments (
        attachment_id TEXT PRIMARY KEY,
        parent_host_id TEXT NOT NULL,
        child_host_id TEXT NOT NULL,
        lineage_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'detached', 'fenced')),
        attachment_json TEXT NOT NULL CHECK(json_valid(attachment_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS host_attachments_active_child
        ON host_attachments(child_host_id) WHERE state = 'active';
      CREATE TABLE IF NOT EXISTS aggregate_routes (
        entity_type TEXT NOT NULL CHECK(entity_type IN ('host', 'worker', 'session')),
        entity_id TEXT NOT NULL,
        owner_host_id TEXT NOT NULL,
        immediate_child_host_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        lineage_id TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        PRIMARY KEY(entity_type, entity_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS aggregate_routes_child
        ON aggregate_routes(immediate_child_host_id, entity_type, entity_id);
      CREATE TABLE IF NOT EXISTS child_import_checkpoints (
        child_host_id TEXT PRIMARY KEY,
        attachment_id TEXT NOT NULL,
        lineage_id TEXT NOT NULL,
        feed_id TEXT NOT NULL,
        control_cursor INTEGER NOT NULL CHECK(control_cursor >= 0),
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS imported_control_events (
        event_id TEXT PRIMARY KEY,
        origin_host_id TEXT NOT NULL,
        child_host_id TEXT NOT NULL,
        attachment_id TEXT NOT NULL,
        origin_feed_id TEXT NOT NULL,
        origin_cursor INTEGER NOT NULL CHECK(origin_cursor >= 0),
        local_cursor INTEGER NOT NULL CHECK(local_cursor >= 0),
        item_json TEXT CHECK(item_json IS NULL OR json_valid(item_json)),
        imported_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS imported_control_position
        ON imported_control_events(child_host_id, attachment_id, origin_feed_id, origin_cursor);
      CREATE TABLE IF NOT EXISTS metadata_operation_ledger (
        operation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued', 'accepted', 'conflicted')),
        patch_json TEXT NOT NULL CHECK(json_valid(patch_json)),
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS metadata_operation_ledger_pending
        ON metadata_operation_ledger(status, created_at, operation_id);
      CREATE TABLE IF NOT EXISTS downstream_replication_queue (
        child_host_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0, 1)),
        created_at TEXT NOT NULL,
        PRIMARY KEY(child_host_id, operation_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS worker_metadata_replication_queue (
        worker_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued', 'accepted', 'conflicted')),
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0, 1)),
        created_at TEXT NOT NULL,
        PRIMARY KEY(worker_id, operation_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS peer_enrollments (
        endpoint_id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK(role IN ('worker', 'childHost', 'parentHost', 'observer')),
        principal_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS authority_handoff_offers (
        handoff_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN ('offered', 'consumed')),
        offer_json TEXT NOT NULL CHECK(json_valid(offer_json)),
        acceptance_json TEXT CHECK(acceptance_json IS NULL OR json_valid(acceptance_json)),
        consume_request_hash TEXT,
        receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(
          (status = 'offered' AND acceptance_json IS NULL AND
            consume_request_hash IS NULL AND receipt_json IS NULL) OR
          (status = 'consumed' AND acceptance_json IS NOT NULL AND
            consume_request_hash IS NOT NULL AND receipt_json IS NOT NULL)
        )
      ) STRICT;
      CREATE TABLE IF NOT EXISTS authority_handoff_acceptances (
        handoff_id TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        offer_json TEXT NOT NULL CHECK(json_valid(offer_json)),
        acceptance_json TEXT NOT NULL CHECK(json_valid(acceptance_json)),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS authority_force_adoptions (
        request_hash TEXT PRIMARY KEY,
        request_json TEXT NOT NULL CHECK(json_valid(request_json)),
        receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS workers (
        worker_id TEXT PRIMARY KEY,
        worker_boot_id TEXT NOT NULL,
        name TEXT NOT NULL,
        presence TEXT NOT NULL,
        record_json TEXT NOT NULL CHECK(json_valid(record_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        adapter_scope_id TEXT NOT NULL,
        vendor_session_id TEXT NOT NULL,
        availability TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        FOREIGN KEY(worker_id) REFERENCES workers(worker_id),
        UNIQUE(worker_id, harness, adapter_scope_id, vendor_session_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_worker ON sessions(worker_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS metadata_operations (
        operation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        patch_json TEXT NOT NULL CHECK(json_valid(patch_json)),
        result_json TEXT NOT NULL CHECK(json_valid(result_json)),
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS commands (
        command_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        session_id TEXT,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        FOREIGN KEY(worker_id) REFERENCES workers(worker_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS lifecycle_intents (
        command_id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        harness TEXT NOT NULL,
        vendor_session_id TEXT,
        ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0, 1)),
        binding_state TEXT NOT NULL DEFAULT 'pending'
          CHECK(binding_state IN ('pending', 'bound', 'conflicted')),
        binding_error TEXT,
        metadata_json TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json)),
        metadata_operation_id TEXT NOT NULL,
        metadata_applied INTEGER NOT NULL DEFAULT 0 CHECK(metadata_applied IN (0, 1)),
        created_at TEXT NOT NULL,
        FOREIGN KEY(command_id) REFERENCES commands(command_id),
        FOREIGN KEY(worker_id) REFERENCES workers(worker_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS lifecycle_intents_pending
        ON lifecycle_intents(worker_id, ready, binding_state, harness, vendor_session_id);
      CREATE TABLE IF NOT EXISTS interactions (
        interaction_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        FOREIGN KEY(session_id) REFERENCES sessions(session_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS interactions_pending ON interactions(state, session_id);
      CREATE TABLE IF NOT EXISTS inventory_snapshots (
        worker_id TEXT PRIMARY KEY,
        generation TEXT NOT NULL,
        snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
        captured_at TEXT NOT NULL,
        FOREIGN KEY(worker_id) REFERENCES workers(worker_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_events (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT,
        origin_host_id TEXT,
        feed_id TEXT,
        change_json TEXT NOT NULL CHECK(json_valid(change_json)),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS control_event_retention (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        minimum_cursor INTEGER NOT NULL CHECK(minimum_cursor >= 0)
      ) STRICT;
      INSERT INTO control_event_retention(singleton, minimum_cursor) VALUES (1, 0);
    `);
    database.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS control_events_event_id ON control_events(event_id)",
    );
  }

  #loadOrCreateHostIdentity(options: HostCatalogOptions): {
    hostId: HostId;
    feedId: import("@agent-multiplex/protocol").FeedId;
    lineageId: import("@agent-multiplex/protocol").LineageId;
    authorityEpochId: import("@agent-multiplex/protocol").AuthorityEpochId;
  } {
    const current = this.#db
      .prepare(
        `SELECT host_id, feed_id, lineage_id, authority_epoch_id
         FROM host_identity WHERE singleton = 1`,
      )
      .get() as Row | undefined;
    if (current) {
      if (options.hostId !== undefined && options.hostId !== current.host_id) {
        throw new HostCoreError("FENCED", "catalog is owned by another stable host identity");
      }
      return {
        hostId: current.host_id as HostId,
        feedId: current.feed_id as import("@agent-multiplex/protocol").FeedId,
        lineageId: current.lineage_id as import("@agent-multiplex/protocol").LineageId,
        authorityEpochId:
          current.authority_epoch_id as import("@agent-multiplex/protocol").AuthorityEpochId,
      };
    }
    const identity = {
      hostId: options.hostId ?? newHostId(),
      feedId: newFeedId(),
      lineageId: newLineageId(),
      authorityEpochId: newAuthorityEpochId(),
    };
    this.#db
      .prepare(
        `INSERT INTO host_identity(
           singleton, host_id, feed_id, lineage_id, authority_epoch_id, created_at
         ) VALUES (1, ?, ?, ?, ?, ?)`,
      )
      .run(
        identity.hostId,
        identity.feedId,
        identity.lineageId,
        identity.authorityEpochId,
        this.#timestamp(),
      );
    return identity;
  }

  #startLocalHost(
    options: HostCatalogOptions,
    identity: {
      hostId: HostId;
      feedId: import("@agent-multiplex/protocol").FeedId;
      lineageId: import("@agent-multiplex/protocol").LineageId;
      authorityEpochId: import("@agent-multiplex/protocol").AuthorityEpochId;
    },
  ): void {
    const existing = this.getHost(identity.hostId);
    const timestamp = this.#timestamp();
    const descriptor = hostDescriptorSchema.parse({
      hostId: identity.hostId,
      hostBootId: options.hostBootId ?? newHostBootId(),
      feedId: identity.feedId,
      name: options.hostName ?? existing?.name ?? "agent-multiplex-host",
      ...(options.endpointId === undefined
        ? existing?.endpointId === undefined
          ? {}
          : { endpointId: existing.endpointId }
        : { endpointId: options.endpointId }),
      presence: "online",
      parentHostId: existing?.parentHostId ?? null,
      rootHostId: existing?.rootHostId ?? identity.hostId,
      attachmentId: existing?.attachmentId ?? null,
      lineageId: existing?.lineageId ?? identity.lineageId,
      authorityHostId: existing?.authorityHostId ?? identity.hostId,
      authorityEpochId: existing?.authorityEpochId ?? identity.authorityEpochId,
      connectedAt: timestamp,
      lastHeartbeatAt: timestamp,
      protocolVersion: 2,
      capabilities: [
        "catalog.sqlite",
        "topology.nested-hosts",
        "routing.recursive",
        "metadata.queued",
        "stream.feed-checkpoints",
      ],
    });
    this.#transaction(() => {
      this.#putHost(descriptor);
      this.#appendControl({ type: "host.upsert", host: descriptor });
    });
  }

  #recoverAfterHostRestart(): void {
    const onlineWorkers = this.listWorkers().filter((worker) => worker.presence === "online");
    const onlineRemoteHosts = this.listHosts().filter(
      (host) => host.hostId !== this.#localHostId && host.presence === "online",
    );
    const startedRows = this.#db
      .prepare("SELECT record_json FROM commands WHERE state = 'started'")
      .all() as Row[];
    if (
      onlineWorkers.length === 0 &&
      onlineRemoteHosts.length === 0 &&
      startedRows.length === 0
    ) return;
    const timestamp = this.#timestamp();
    this.#transaction(() => {
      for (const host of onlineRemoteHosts) {
        const stale = hostDescriptorSchema.parse({ ...host, presence: "stale" });
        this.#putHost(stale);
        this.#appendControl({ type: "host.presence", hostId: host.hostId, presence: "stale" });
      }
      for (const worker of onlineWorkers) {
        const stale = workerDescriptorSchema.parse({
          ...worker,
          ...(worker.ownerHostId === this.#localHostId
            ? { presence: "stale", connectedAt: null, reachability: "stale" }
            : { reachability: "unreachable" }),
        });
        this.#putWorker(stale);
        this.#appendControl(
          worker.ownerHostId === this.#localHostId
            ? {
                type: "worker.presence",
                workerId: stale.workerId,
                presence: "stale",
              }
            : { type: "worker.upsert", worker: stale },
        );
      }
      for (const row of startedRows) {
        const command = parsed(commandRecordSchema, row.record_json);
        const unknown = commandRecordSchema.parse({
          ...command,
          state: "outcomeUnknown",
          error: "host restarted before it observed a terminal worker response",
          updatedAt: timestamp,
        });
        this.#putCommand(unknown);
        this.#appendControl({ type: "command.changed", command: unknown });
      }
    });
  }

  /** Preserve endpoint pins created before the composite peer-role table existed. */
  #backfillPeerEnrollments(): void {
    for (const worker of this.listWorkers()) {
      if (
        worker.ownerHostId === this.#localHostId &&
        worker.endpointId !== undefined
      ) {
        this.enrollPeer(worker.endpointId, "worker", worker.workerId);
      }
    }
    for (const host of this.listHosts()) {
      if (
        host.hostId !== this.#localHostId &&
        host.parentHostId === this.#localHostId &&
        host.endpointId !== undefined &&
        this.getAttachment(host.hostId) !== null
      ) {
        this.enrollPeer(host.endpointId, "childHost", host.hostId);
      }
    }
  }

  #capabilityToken(): string {
    return `${randomUUID()}.${randomUUID()}`;
  }

  #handoffReceipt(value: unknown): AuthorityAdoptionReceipt & { mode: "handoff" } {
    const receipt = authorityAdoptionReceiptSchema.parse(
      typeof value === "string" ? decode(value) : value,
    );
    if (receipt.mode !== "handoff") {
      throw new HostCoreError("CONFLICT", "stored adoption receipt is not a handoff receipt");
    }
    return receipt;
  }

  #forcedReceipt(value: unknown): AuthorityAdoptionReceipt & { mode: "forced" } {
    const receipt = authorityAdoptionReceiptSchema.parse(
      typeof value === "string" ? decode(value) : value,
    );
    if (receipt.mode !== "forced") {
      throw new HostCoreError("CONFLICT", "stored adoption receipt is not a force-adopt receipt");
    }
    return receipt;
  }

  #assertLiveAuthorityOffer(offer: AuthorityHandoffOffer): void {
    const now = this.#now().getTime();
    if (Date.parse(offer.offeredAt) > now) {
      throw new HostCoreError("FENCED", "authority handoff offer is not valid yet");
    }
    if (Date.parse(offer.expiresAt) <= now) {
      throw new HostCoreError("FENCED", "authority handoff offer has expired");
    }
  }

  #assertSourceAuthorityBinding(
    request: Pick<
      AuthorityHandoffOffer,
      | "subtreeRootHostId"
      | "sourceRootHostId"
      | "sourceAuthorityHostId"
      | "sourceAuthorityEpochId"
      | "destinationRootHostId"
      | "destinationAuthorityHostId"
    >,
  ): void {
    const local = this.localHost();
    if (
      request.sourceRootHostId !== local.hostId ||
      request.sourceAuthorityHostId !== local.hostId ||
      local.parentHostId !== null ||
      local.rootHostId !== request.sourceRootHostId ||
      local.authorityHostId !== request.sourceAuthorityHostId ||
      local.authorityEpochId !== request.sourceAuthorityEpochId
    ) {
      throw new HostCoreError("FENCED", "this host is not the named source root authority");
    }
    if (request.destinationRootHostId !== request.destinationAuthorityHostId) {
      throw new HostCoreError("FENCED", "destination metadata authority must be its tree root");
    }
    const subtree = this.getHost(request.subtreeRootHostId);
    if (!subtree) {
      throw new HostCoreError("NOT_FOUND", `subtree root ${request.subtreeRootHostId} is unknown`);
    }
    if (
      subtree.rootHostId !== request.sourceRootHostId ||
      subtree.authorityHostId !== request.sourceAuthorityHostId ||
      subtree.authorityEpochId !== request.sourceAuthorityEpochId
    ) {
      throw new HostCoreError("FENCED", "subtree no longer belongs to the source authority epoch");
    }
  }

  #assertDestinationAcceptanceBinding(request: AuthorityHandoffAcceptInput): void {
    const local = this.localHost();
    if (
      request.offer.destinationRootHostId !== local.hostId ||
      request.offer.destinationAuthorityHostId !== local.hostId ||
      request.acceptedByHostId !== local.hostId ||
      request.acceptedByHostBootId !== local.hostBootId ||
      request.destinationAuthorityEpochId !== local.authorityEpochId ||
      local.endpointId !== request.offer.destinationAuthorityEndpointId ||
      local.parentHostId !== null ||
      local.rootHostId !== local.hostId ||
      local.authorityHostId !== local.hostId
    ) {
      throw new HostCoreError("FENCED", "handoff acceptance does not bind the current destination root");
    }
  }

  #assertValidAcceptanceProof(acceptance: AuthorityHandoffAcceptance): void {
    if (!verifyAuthorityHandoffAcceptanceProof(acceptance)) {
      throw new HostCoreError(
        "FENCED",
        "authority handoff acceptance proof is not signed by the named destination endpoint",
      );
    }
  }

  #assertForceAdoptionBinding(request: AuthorityForceAdoptInput): void {
    const local = this.localHost();
    if (
      request.destinationRootHostId !== local.hostId ||
      request.destinationAuthorityHostId !== local.hostId ||
      request.destinationHostBootId !== local.hostBootId
    ) {
      throw new HostCoreError("FENCED", "force-adopt does not bind the current destination host boot");
    }
    if (Date.parse(request.audit.requestedAt) > this.#now().getTime()) {
      throw new HostCoreError("FENCED", "force-adopt audit request is dated in the future");
    }

    const promotingLocalSubtree =
      request.subtreeRootHostId === local.hostId && local.rootHostId !== local.hostId;
    if (promotingLocalSubtree) {
      if (request.destinationAuthorityEpochId === local.authorityEpochId) {
        throw new HostCoreError("FENCED", "force-promoting a subtree requires a fresh authority epoch");
      }
    } else if (
      local.parentHostId !== null ||
      local.rootHostId !== local.hostId ||
      local.authorityHostId !== local.hostId ||
      request.destinationAuthorityEpochId !== local.authorityEpochId
    ) {
      throw new HostCoreError("FENCED", "force-adopt destination is not the current root authority");
    }

    const subtree = this.getHost(request.subtreeRootHostId);
    if (!subtree) {
      if (
        request.previousRootHostId !== null ||
        request.previousAuthorityHostId !== null ||
        request.previousAuthorityEpochId !== null
      ) {
        throw new HostCoreError("FENCED", "unknown subtree must use a null previous-authority tuple");
      }
      return;
    }
    if (
      request.previousRootHostId !== subtree.rootHostId ||
      request.previousAuthorityHostId !== subtree.authorityHostId ||
      request.previousAuthorityEpochId !== subtree.authorityEpochId
    ) {
      throw new HostCoreError("FENCED", "force-adopt previous-authority tuple is stale");
    }
  }

  #projectSubtreeAuthority(
    subtreeRootHostId: HostId,
    destinationRootHostId: HostId,
    destinationAuthorityHostId: HostId,
    destinationAuthorityEpochId: import("@agent-multiplex/protocol").AuthorityEpochId,
    promoteLocalRoot: boolean,
  ): void {
    if (!this.getHost(subtreeRootHostId)) return;
    const subtreeHostIds = new Set<HostId>([subtreeRootHostId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const host of this.listHosts()) {
        if (
          host.parentHostId !== null &&
          subtreeHostIds.has(host.parentHostId) &&
          !subtreeHostIds.has(host.hostId)
        ) {
          subtreeHostIds.add(host.hostId);
          grew = true;
        }
      }
    }

    for (const host of this.listHosts()) {
      if (!subtreeHostIds.has(host.hostId)) continue;
      const updated = hostDescriptorSchema.parse({
        ...host,
        ...(promoteLocalRoot && host.hostId === this.#localHostId
          ? { parentHostId: null, attachmentId: null }
          : {}),
        rootHostId: destinationRootHostId,
        authorityHostId: destinationAuthorityHostId,
        authorityEpochId: destinationAuthorityEpochId,
      });
      this.#putHost(updated);
      this.#appendControl({ type: "host.upsert", host: updated });
    }

    const subtreeWorkerIds = new Set(
      this.listWorkers()
        .filter((worker) => subtreeHostIds.has(worker.ownerHostId))
        .map((worker) => worker.workerId),
    );
    const updatedAt = this.#timestamp();
    for (const session of this.listSessions()) {
      if (!subtreeWorkerIds.has(session.workerId)) continue;
      const updated = sessionRecordSchema.parse({
        ...session,
        metadataAuthority: {
          hostId: destinationAuthorityHostId,
          epochId: destinationAuthorityEpochId,
        },
        updatedAt,
      });
      this.#putSession(updated);
      this.#appendControl({ type: "session.upsert", session: updated });
    }

    const attachmentRows = this.#db
      .prepare("SELECT attachment_id, attachment_json FROM host_attachments")
      .all() as Row[];
    for (const row of attachmentRows) {
      const attachment = parsed(hostAttachmentSchema, row.attachment_json);
      if (
        !subtreeHostIds.has(attachment.parentHostId) ||
        !subtreeHostIds.has(attachment.childHostId)
      ) continue;
      const updated = hostAttachmentSchema.parse({
        ...attachment,
        rootHostId: destinationRootHostId,
        authorityHostId: destinationAuthorityHostId,
        authorityEpochId: destinationAuthorityEpochId,
      });
      this.#db
        .prepare(
          "UPDATE host_attachments SET attachment_json = ?, updated_at = ? WHERE attachment_id = ?",
        )
        .run(encode(updated), updatedAt, updated.attachmentId);
    }
  }

  #transaction<T>(body: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = body();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  #appendControl(
    changeInput: ControlChange,
    identity: { eventId?: string; originHostId?: HostId } = {},
  ): number {
    const change = controlChangeSchema.parse(changeInput);
    const result = this.#db
      .prepare(
        `INSERT INTO control_events(
           event_id, origin_host_id, feed_id, change_json, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        identity.eventId ?? randomUUID(),
        identity.originHostId ?? this.#localHostId,
        this.#localFeedId,
        encode(change),
        this.#timestamp(),
      );
    return Number(result.lastInsertRowid);
  }

  #publishNewControls(): void {
    for (;;) {
      const page = this.controlEventsAfter(this.#publishedCursor);
      for (const item of page) {
        this.#publishedCursor = item.cursor;
        this.#events.emit("control", item);
      }
      if (page.length < 10_000) break;
    }
  }

  #putHost(host: HostDescriptor): void {
    this.#db
      .prepare(
        `INSERT INTO hosts(
           host_id, host_boot_id, parent_host_id, root_host_id,
           attachment_id, presence, record_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(host_id) DO UPDATE SET host_boot_id = excluded.host_boot_id,
           parent_host_id = excluded.parent_host_id, root_host_id = excluded.root_host_id,
           attachment_id = excluded.attachment_id, presence = excluded.presence,
           record_json = excluded.record_json`,
      )
      .run(
        host.hostId,
        host.hostBootId,
        host.parentHostId,
        host.rootHostId,
        host.attachmentId,
        host.presence,
        encode(host),
      );
  }

  #putAggregateRoute(route: AggregateRoute): void {
    this.#db
      .prepare(
        `INSERT INTO aggregate_routes(
           entity_type, entity_id, owner_host_id, immediate_child_host_id,
           attachment_id, lineage_id, imported_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity_type, entity_id) DO UPDATE SET
           owner_host_id = excluded.owner_host_id,
           immediate_child_host_id = excluded.immediate_child_host_id,
           attachment_id = excluded.attachment_id,
           lineage_id = excluded.lineage_id,
           imported_at = excluded.imported_at`,
      )
      .run(
        route.entityType,
        route.entityId,
        route.ownerHostId,
        route.immediateChildHostId,
        route.attachmentId,
        route.lineageId,
        this.#timestamp(),
      );
  }

  #routeFromRow(row: Row): AggregateRoute {
    return {
      entityType: String(row.entity_type) as AggregateRoute["entityType"],
      entityId: String(row.entity_id),
      ownerHostId: row.owner_host_id as HostId,
      immediateChildHostId: row.immediate_child_host_id as HostId,
      attachmentId: row.attachment_id as HostAttachment["attachmentId"],
      lineageId: row.lineage_id as HostAttachment["lineageId"],
    };
  }

  #activeAttachment(
    childHostId: HostId,
    attachmentId: HostAttachment["attachmentId"],
  ): HostAttachment {
    const attachment = this.getAttachment(childHostId);
    if (!attachment || attachment.attachmentId !== attachmentId) {
      throw new HostCoreError("FENCED", "child host attachment is not active");
    }
    return attachment;
  }

  #putChildCheckpoint(
    childHostId: HostId,
    attachment: HostAttachment,
    checkpoint: FeedCheckpoint,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO child_import_checkpoints(
           child_host_id, attachment_id, lineage_id, feed_id,
           control_cursor, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(child_host_id) DO UPDATE SET
           attachment_id = excluded.attachment_id,
           lineage_id = excluded.lineage_id,
           feed_id = excluded.feed_id,
           control_cursor = excluded.control_cursor,
           updated_at = excluded.updated_at`,
      )
      .run(
        childHostId,
        attachment.attachmentId,
        attachment.lineageId,
        checkpoint.feedId,
        checkpoint.controlCursor,
        this.#timestamp(),
      );
  }

  #hostsThroughChild(childHostId: HostId): HostDescriptor[] {
    const rows = this.#db
      .prepare(
        `SELECT hosts.record_json FROM hosts
         JOIN aggregate_routes ON aggregate_routes.entity_type = 'host'
           AND aggregate_routes.entity_id = hosts.host_id
         WHERE aggregate_routes.immediate_child_host_id = ?`,
      )
      .all(childHostId) as Row[];
    return rows.map((row) => parsed(hostDescriptorSchema, row.record_json));
  }

  #workersThroughChild(childHostId: HostId): WorkerDescriptor[] {
    const rows = this.#db
      .prepare(
        `SELECT workers.record_json FROM workers
         JOIN aggregate_routes ON aggregate_routes.entity_type = 'worker'
           AND aggregate_routes.entity_id = workers.worker_id
         WHERE aggregate_routes.immediate_child_host_id = ?`,
      )
      .all(childHostId) as Row[];
    return rows.map((row) => parsed(workerDescriptorSchema, row.record_json));
  }

  #assertRouteAvailable(
    entityType: AggregateRoute["entityType"],
    entityId: string,
    immediateChildHostId: HostId,
  ): void {
    if (
      (entityType === "host" && entityId === this.#localHostId) ||
      (entityType === "worker" && this.getWorker(entityId as WorkerId)?.ownerHostId === this.#localHostId) ||
      (entityType === "session" && this.getSession(entityId as SessionId) !== null &&
        this.routeForWorker(this.getSession(entityId as SessionId)!.workerId) === null)
    ) {
      throw new HostCoreError("CONFLICT", `${entityType} ${entityId} is owned locally`);
    }
    const row = this.#db
      .prepare(
        `SELECT immediate_child_host_id FROM aggregate_routes
         WHERE entity_type = ? AND entity_id = ?`,
      )
      .get(entityType, entityId) as Row | undefined;
    if (row && row.immediate_child_host_id !== immediateChildHostId) {
      throw new HostCoreError(
        "CONFLICT",
        `${entityType} ${entityId} is already owned through another child`,
      );
    }
  }

  #assertSnapshotTopology(childHostId: HostId, incoming: readonly HostDescriptor[]): void {
    const known = new Map(this.listHosts().map((host) => [host.hostId, host]));
    const incomingIds = new Set(incoming.map((host) => host.hostId));
    for (const host of incoming) {
      if (host.hostId === this.#localHostId) {
        throw new HostCoreError("CONFLICT", "child snapshot contains its parent host");
      }
      known.set(host.hostId, host);
    }
    // A live upsert can move an existing ancestor without changing any of its
    // descendants. Validate the resulting complete imported subtree so that
    // such a move cannot introduce a descendant cycle or exceed the depth
    // limit while the changed host itself still looks valid.
    const candidates = [...known.values()].filter((host) => {
      if (incomingIds.has(host.hostId) || host.hostId === childHostId) return true;
      return this.#aggregateRoute("host", host.hostId)?.immediateChildHostId === childHostId;
    });
    for (const host of candidates) {
      const visited = new Set<HostId>();
      let current: HostDescriptor | undefined = host;
      for (let depth = 0; current && current.hostId !== childHostId; depth += 1) {
        // The immediate child is already one edge below this host. Include
        // that edge so the configured limit is absolute from the local host.
        if (depth + 1 >= this.#maxHostDepth) {
          throw new HostCoreError("CONFLICT", "child snapshot exceeds maximum host depth");
        }
        if (visited.has(current.hostId)) {
          throw new HostCoreError("CONFLICT", "child snapshot contains a host cycle");
        }
        visited.add(current.hostId);
        if (current.parentHostId === null) break;
        if (current.parentHostId === this.#localHostId) {
          throw new HostCoreError("CONFLICT", "a descendant bypasses the immediate child route");
        }
        current = known.get(current.parentHostId);
      }
      if (!current || current.hostId !== childHostId) {
        throw new HostCoreError(
          "CONFLICT",
          `host ${host.hostId} is not descended from the attached child`,
        );
      }
    }
  }

  #assertWorkerOwnerInChildSubtree(childHostId: HostId, ownerHostId: HostId): void {
    const route = this.#aggregateRoute("host", ownerHostId);
    if (!route || route.immediateChildHostId !== childHostId) {
      throw new HostCoreError("FENCED", "child worker owner is outside its subtree");
    }
  }

  #assertImportedAttachment(childHostId: HostId, attachment: HostAttachment): void {
    if (attachment.parentHostId === this.#localHostId) {
      throw new HostCoreError("FENCED", "child attempted to create a direct parent attachment");
    }
    const parentRoute = this.#aggregateRoute("host", attachment.parentHostId);
    const childRoute = this.#aggregateRoute("host", attachment.childHostId);
    const child = this.getHost(attachment.childHostId);
    if (
      !parentRoute ||
      !childRoute ||
      parentRoute.immediateChildHostId !== childHostId ||
      childRoute.immediateChildHostId !== childHostId ||
      !child ||
      child.parentHostId !== attachment.parentHostId ||
      child.attachmentId !== attachment.attachmentId ||
      child.lineageId !== attachment.lineageId ||
      child.rootHostId !== attachment.rootHostId ||
      child.authorityHostId !== attachment.authorityHostId ||
      child.authorityEpochId !== attachment.authorityEpochId
    ) {
      throw new HostCoreError("FENCED", "child attachment does not match its imported host tuple");
    }
    const existingById = this.#attachmentById(attachment.attachmentId);
    const existingForChild = this.#activeAttachmentForAnyChild(attachment.childHostId);
    if (
      (existingById !== null && jsonForHash(existingById) !== jsonForHash(attachment)) ||
      (existingForChild !== null && jsonForHash(existingForChild) !== jsonForHash(attachment))
    ) {
      throw new HostCoreError("FENCED", "child attachment conflicts with an active attachment");
    }
  }

  #attachmentById(attachmentId: HostAttachment["attachmentId"]): HostAttachment | null {
    const row = this.#db
      .prepare(
        `SELECT attachment_json FROM host_attachments
         WHERE attachment_id = ? AND state = 'active'`,
      )
      .get(attachmentId) as Row | undefined;
    return row ? parsed(hostAttachmentSchema, row.attachment_json) : null;
  }

  #activeAttachmentForAnyChild(childHostId: HostId): HostAttachment | null {
    const row = this.#db
      .prepare(
        `SELECT attachment_json FROM host_attachments
         WHERE child_host_id = ? AND state = 'active'`,
      )
      .get(childHostId) as Row | undefined;
    return row ? parsed(hostAttachmentSchema, row.attachment_json) : null;
  }

  #applyImportedChange(
    childHostId: HostId,
    attachment: HostAttachment,
    change: ControlChange,
  ): void {
    const local = this.localHost();
    switch (change.type) {
      case "host.upsert": {
        this.#assertRouteAvailable("host", change.host.hostId, childHostId);
        this.#assertSnapshotTopology(childHostId, [change.host]);
        const host = hostDescriptorSchema.parse({
          ...change.host,
          ...(change.host.hostId === childHostId
            ? {
                parentHostId: local.hostId,
                attachmentId: attachment.attachmentId,
                lineageId: attachment.lineageId,
              }
            : {}),
          rootHostId: local.rootHostId,
          authorityHostId: local.authorityHostId,
          authorityEpochId: local.authorityEpochId,
          presence:
            change.host.hostId === childHostId ? "online" : change.host.presence,
        });
        this.#putHost(host);
        this.#putAggregateRoute({
          entityType: "host",
          entityId: host.hostId,
          ownerHostId: host.hostId,
          immediateChildHostId: childHostId,
          attachmentId: attachment.attachmentId,
          lineageId: attachment.lineageId,
        });
        return;
      }
      case "host.presence": {
        const route = this.#aggregateRoute("host", change.hostId);
        if (!route || route.immediateChildHostId !== childHostId) {
          throw new HostCoreError("FENCED", "child changed a host outside its subtree");
        }
        const host = this.getHost(change.hostId);
        if (host) {
          this.#putHost(
            hostDescriptorSchema.parse({
              ...host,
              presence: change.hostId === childHostId ? "online" : change.presence,
            }),
          );
        }
        return;
      }
      case "host.attached": {
        this.#assertImportedAttachment(childHostId, change.attachment);
        this.#db
          .prepare(
            `INSERT INTO host_attachments(
               attachment_id, parent_host_id, child_host_id, lineage_id, state,
               attachment_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
             ON CONFLICT(attachment_id) DO UPDATE SET state = 'active',
               attachment_json = excluded.attachment_json, updated_at = excluded.updated_at`,
          )
          .run(
            change.attachment.attachmentId,
            change.attachment.parentHostId,
            change.attachment.childHostId,
            change.attachment.lineageId,
            encode(change.attachment),
            change.attachment.attachedAt,
            this.#timestamp(),
          );
        return;
      }
      case "host.detached": {
        const route = this.#aggregateRoute("host", change.hostId);
        if (!route || route.immediateChildHostId !== childHostId) {
          throw new HostCoreError("FENCED", "child detached a host outside its subtree");
        }
        const host = this.getHost(change.hostId);
        const active = this.#attachmentById(change.attachmentId);
        const activeForChild = this.#activeAttachmentForAnyChild(change.hostId);
        if (
          !host ||
          host.parentHostId === null ||
          host.parentHostId === this.#localHostId ||
          host.attachmentId !== change.attachmentId ||
          host.lineageId !== change.lineageId ||
          (active !== null &&
            (active.parentHostId !== host.parentHostId ||
              active.childHostId !== change.hostId ||
              active.lineageId !== change.lineageId)) ||
          (activeForChild !== null &&
            (activeForChild.attachmentId !== change.attachmentId ||
              activeForChild.parentHostId !== host.parentHostId ||
              activeForChild.lineageId !== change.lineageId))
        ) {
          throw new HostCoreError("FENCED", "child detached another or stale host attachment");
        }
        const parentRoute = this.#aggregateRoute("host", host.parentHostId);
        if (!parentRoute || parentRoute.immediateChildHostId !== childHostId) {
          throw new HostCoreError("FENCED", "child detached an attachment outside its subtree");
        }
        this.#db
          .prepare("UPDATE host_attachments SET state = 'detached', updated_at = ? WHERE attachment_id = ?")
          .run(this.#timestamp(), change.attachmentId);
        if (host) this.#putHost(hostDescriptorSchema.parse({ ...host, presence: "offline" }));
        return;
      }
      case "worker.upsert": {
        this.#assertRouteAvailable("worker", change.worker.workerId, childHostId);
        this.#assertWorkerOwnerInChildSubtree(childHostId, change.worker.ownerHostId);
        const worker = workerDescriptorSchema.parse(change.worker);
        this.#putWorker(worker);
        this.#putAggregateRoute({
          entityType: "worker",
          entityId: worker.workerId,
          ownerHostId: worker.ownerHostId,
          immediateChildHostId: childHostId,
          attachmentId: attachment.attachmentId,
          lineageId: attachment.lineageId,
        });
        return;
      }
      case "worker.presence": {
        const route = this.routeForWorker(change.workerId);
        if (!route || route.immediateChildHostId !== childHostId) {
          throw new HostCoreError("FENCED", "child changed a worker outside its subtree");
        }
        const worker = this.getWorker(change.workerId);
        if (worker) {
          this.#putWorker(
            workerDescriptorSchema.parse({
              ...worker,
              presence: change.presence,
              // Presence is the worker runtime's own state. Reachability is
              // the child host's path projection and is changed separately by
              // worker.upsert when an intermediate link degrades or recovers.
              reachability: worker.reachability,
            }),
          );
        }
        return;
      }
      case "session.upsert": {
        const route = this.routeForWorker(change.session.workerId);
        if (!route || route.immediateChildHostId !== childHostId) {
          throw new HostCoreError("FENCED", "child changed a session outside its subtree");
        }
        this.#assertRouteAvailable("session", change.session.sessionId, childHostId);
        const previous = this.getSession(change.session.sessionId);
        const session = sessionRecordSchema.parse({
          ...change.session,
          metadata: this.#metadataImportedFromChild(previous, change.session.metadata),
          metadataAuthority: {
            hostId: local.authorityHostId,
            epochId: local.authorityEpochId,
          },
        });
        this.#putSession(session);
        this.#settleImportedLifecycle(session);
        this.#putAggregateRoute({
          entityType: "session",
          entityId: session.sessionId,
          ownerHostId: route.ownerHostId,
          immediateChildHostId: childHostId,
          attachmentId: attachment.attachmentId,
          lineageId: attachment.lineageId,
        });
        return;
      }
      case "session.unavailable": {
        const route = this.#aggregateRoute("session", change.sessionId);
        if (!route || route.immediateChildHostId !== childHostId) {
          throw new HostCoreError("FENCED", "child changed a session outside its subtree");
        }
        const session = this.getSession(change.sessionId);
        if (session) {
          this.#putSession(
            sessionRecordSchema.parse({
              ...session,
              availability: "unavailable",
              runtimeStatus: "unknown",
              runtimeEpoch: null,
              updatedAt: this.#timestamp(),
            }),
          );
        }
        return;
      }
      case "metadata.changed": {
        const route = this.#aggregateRoute("session", change.sessionId);
        if (!route || route.immediateChildHostId !== childHostId) {
          throw new HostCoreError("FENCED", "child changed metadata outside its subtree");
        }
        const session = this.getSession(change.sessionId);
        if (!session) throw new HostCoreError("NOT_FOUND", "metadata session is not imported");
        const metadata = this.#metadataImportedFromChild(session, change.metadata);
        if (jsonForHash(metadata) !== jsonForHash(session.metadata)) {
          this.#putSession(
            sessionRecordSchema.parse({
              ...session,
              metadata,
              updatedAt: this.#timestamp(),
            }),
          );
        }
        return;
      }
      case "metadata.operation":
        this.#mergeMetadataOperationImportedFromChild(change.operation);
        return;
      case "command.changed": {
        const route = this.routeForWorker(change.command.workerId);
        if (!route || route.immediateChildHostId !== childHostId) {
          throw new HostCoreError("FENCED", "child changed a command outside its subtree");
        }
        const current = this.getCommand(change.command.commandId);
        if (current) this.#assertSameCommand(current, change.command);
        this.#putCommand(change.command);
        return;
      }
      case "interaction.changed": {
        const route = this.#aggregateRoute("session", change.interaction.sessionId);
        if (!route || route.immediateChildHostId !== childHostId) {
          throw new HostCoreError("FENCED", "child changed an interaction outside its subtree");
        }
        const merged = this.#mergeImportedInteraction(change.interaction);
        if (merged.changed) this.#putInteraction(merged.interaction);
        return;
      }
      case "inventory.completed": {
        const route = this.routeForWorker(change.workerId);
        if (!route || route.immediateChildHostId !== childHostId) {
          throw new HostCoreError("FENCED", "child completed inventory outside its subtree");
        }
        return;
      }
    }
  }

  #canonicalImportedChange(change: ControlChange): ControlChange {
    switch (change.type) {
      case "host.upsert":
        return { type: "host.upsert", host: this.getHost(change.host.hostId)! };
      case "host.presence":
        return {
          type: "host.presence",
          hostId: change.hostId,
          presence: this.getHost(change.hostId)?.presence ?? change.presence,
        };
      case "worker.upsert":
        return { type: "worker.upsert", worker: this.getWorker(change.worker.workerId)! };
      case "session.upsert":
        return { type: "session.upsert", session: this.getSession(change.session.sessionId)! };
      case "metadata.changed":
        return {
          type: "metadata.changed",
          sessionId: change.sessionId,
          metadata: this.getMetadata(change.sessionId),
        };
      case "metadata.operation":
        return {
          type: "metadata.operation",
          operation: this.getMetadataOperation(change.operation.operationId)!,
        };
      case "command.changed":
        return { type: "command.changed", command: this.getCommand(change.command.commandId)! };
      case "interaction.changed":
        return {
          type: "interaction.changed",
          interaction: this.getInteraction(change.interaction.interactionId)!,
        };
      default:
        return change;
    }
  }

  #settleImportedLifecycle(session: SessionRecord): void {
    const candidates = this.#pendingLifecycleIntents(session.workerId).filter(
      (intent) =>
        intent.harness === session.harness &&
        intent.vendorSessionId === session.vendorSessionId,
    );
    for (const intent of candidates) {
      this.#settleLifecycleIntent(
        intent.commandId,
        intent.sessionId === session.sessionId ? "bound" : "conflicted",
        intent.sessionId === session.sessionId
          ? undefined
          : `child bound native session to ${session.sessionId}`,
      );
    }
  }

  #aggregateRoute(
    entityType: AggregateRoute["entityType"],
    entityId: string,
  ): AggregateRoute | null {
    const row = this.#db
      .prepare(
        `SELECT entity_type, entity_id, owner_host_id, immediate_child_host_id,
                attachment_id, lineage_id
         FROM aggregate_routes WHERE entity_type = ? AND entity_id = ?`,
      )
      .get(entityType, entityId) as Row | undefined;
    return row ? this.#routeFromRow(row) : null;
  }

  #importedEventPayloadHash(item: FeedControlItem): string {
    // Feed/cursor/attachment are hop-local positions. The global event ID may
    // legitimately arrive through a new route after a same-lineage reparent;
    // only its origin and semantic change must remain immutable.
    return jsonForHash({
      eventId: item.eventId,
      originHostId: item.originHostId,
      change: item.change,
    });
  }

  #metadataImportedFromChild(
    current: SessionRecord | null,
    incoming: MetadataSnapshot,
  ): MetadataSnapshot {
    if (!current) return incoming;
    if (incoming.revision < current.metadata.revision) return current.metadata;
    if (incoming.revision === current.metadata.revision) {
      if (jsonForHash(incoming) !== jsonForHash(current.metadata)) {
        throw new HostCoreError(
          "CONFLICT",
          "child metadata diverged at an already canonical revision",
        );
      }
      return current.metadata;
    }
    throw new HostCoreError(
      "FENCED",
      "child cannot advance metadata owned by the tree authority",
    );
  }

  #mergeMetadataOperationImportedFromChild(
    operationInput: MetadataOperationRecord,
  ): { operation: MetadataOperationRecord; changed: boolean } {
    const presented = metadataOperationRecordSchema.parse(operationInput);
    const session = this.getSession(presented.sessionId);
    if (!session) {
      throw new HostCoreError("NOT_FOUND", "metadata operation session is not imported");
    }
    if (
      presented.status !== "queued" &&
      presented.authorityEpochId !== session.metadataAuthority.epochId
    ) {
      throw new HostCoreError("FENCED", "child metadata operation targets a stale authority epoch");
    }
    // Descendants do not receive a replacement direct attachment when an
    // aggregate joins a higher root. The first parent projection therefore
    // promotes queued operations onto the current tree epoch while retaining
    // the operation/session/patch/origin identity.
    const operation = presented.status === "queued"
      ? metadataOperationRecordSchema.parse({
          ...presented,
          authorityEpochId: session.metadataAuthority.epochId,
        })
      : presented;
    const current = this.getMetadataOperation(operation.operationId);
    if (current) {
      this.#assertSameMetadataOperationIdentity(current, operation);
      if (current.status !== "queued") {
        if (operation.status !== "queued") {
          this.#assertSameTerminalMetadataReceipt(current, operation);
        }
        return { operation: current, changed: false };
      }
      if (operation.status !== "queued") {
        throw new HostCoreError(
          "FENCED",
          "a child cannot settle an operation owned by the metadata authority",
        );
      }
      return { operation: current, changed: false };
    }
    if (operation.status !== "queued") {
      throw new HostCoreError(
        "FENCED",
        "a child cannot introduce a terminal metadata receipt",
      );
    }
    this.#putMetadataOperation(operation);
    return { operation, changed: true };
  }

  #assertSameMetadataOperationIdentity(
    current: MetadataOperationRecord,
    incoming: MetadataOperationRecord,
  ): void {
    if (
      current.sessionId !== incoming.sessionId ||
      jsonForHash(current.patch) !== jsonForHash(incoming.patch) ||
      current.originHostId !== incoming.originHostId
    ) {
      throw new HostCoreError(
        "PAYLOAD_MISMATCH",
        `metadata operation ${incoming.operationId} changed its immutable identity`,
      );
    }
  }

  #assertSameTerminalMetadataReceipt(
    current: MetadataOperationRecord,
    incoming: MetadataOperationRecord,
  ): void {
    if (
      current.status === "queued" ||
      incoming.status === "queued" ||
      jsonForHash(current) !== jsonForHash(incoming)
    ) {
      throw new HostCoreError(
        "CONFLICT",
        `terminal metadata receipt ${incoming.operationId} cannot be changed`,
      );
    }
  }

  #putMetadataOperation(operation: MetadataOperationRecord): MetadataOperationRecord {
    const current = this.getMetadataOperation(operation.operationId);
    if (current) {
      this.#assertSameMetadataOperationIdentity(current, operation);
      if (current.status !== "queued") {
        if (operation.status !== "queued") {
          this.#assertSameTerminalMetadataReceipt(current, operation);
        }
        return current;
      }
      if (operation.status === "queued") return current;
    }
    this.#db
      .prepare(
        `INSERT INTO metadata_operation_ledger(
           operation_id, session_id, status, patch_json, record_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(operation_id) DO UPDATE SET status = excluded.status,
           record_json = excluded.record_json, updated_at = excluded.updated_at`,
      )
      .run(
        operation.operationId,
        operation.sessionId,
        operation.status,
        jsonForHash(operation.patch),
        encode(operation),
        operation.createdAt,
        operation.updatedAt,
      );
    return operation;
  }

  #optimisticMetadata(snapshot: MetadataSnapshot, patch: MetadataPatch): MetadataSnapshot {
    const values = { ...snapshot.values };
    for (const [key, value] of Object.entries(patch.set ?? {})) values[key] = value;
    for (const key of patch.remove ?? []) delete values[key];
    return { ...snapshot, values };
  }

  #putWorker(worker: WorkerDescriptor): void {
    this.#db
      .prepare(
        `INSERT INTO workers(worker_id, worker_boot_id, name, presence, record_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(worker_id) DO UPDATE SET worker_boot_id = excluded.worker_boot_id,
           name = excluded.name, presence = excluded.presence, record_json = excluded.record_json`,
      )
      .run(worker.workerId, worker.workerBootId, worker.name, worker.presence, encode(worker));
  }

  #putSession(record: SessionRecord): void {
    this.#db
      .prepare(
        `INSERT INTO sessions(session_id, worker_id, harness, adapter_scope_id,
           vendor_session_id, availability, updated_at, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET worker_id = excluded.worker_id,
           harness = excluded.harness, adapter_scope_id = excluded.adapter_scope_id,
           vendor_session_id = excluded.vendor_session_id, availability = excluded.availability,
           updated_at = excluded.updated_at, record_json = excluded.record_json`,
      )
      .run(
        record.sessionId,
        record.workerId,
        record.harness,
        record.adapterScopeId,
        record.vendorSessionId,
        record.availability,
        record.updatedAt,
        encode(record),
      );
  }

  #putCommand(record: CommandRecord): void {
    this.#db
      .prepare(
        `INSERT INTO commands(command_id, payload_hash, worker_id, session_id, state, updated_at, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(command_id) DO UPDATE SET state = excluded.state,
           updated_at = excluded.updated_at, record_json = excluded.record_json`,
      )
      .run(
        record.commandId,
        record.payloadHash,
        record.workerId,
        record.sessionId,
        record.state,
        record.updatedAt,
        encode(record),
      );
  }

  #putInteraction(record: InteractionRecord): void {
    this.#db
      .prepare(
        `INSERT INTO interactions(interaction_id, session_id, state, created_at, record_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(interaction_id) DO UPDATE SET state = excluded.state,
           record_json = excluded.record_json`,
      )
      .run(record.interactionId, record.sessionId, record.state, record.createdAt, encode(record));
  }

  #fencePreviousBoot(workerId: WorkerId, timestamp: string): void {
    for (const command of this.#listCommandsForWorker(workerId)) {
      if (command.state !== "received" && command.state !== "started") continue;
      const fenced = commandRecordSchema.parse({
        ...command,
        state: "outcomeUnknown",
        error: "worker restarted before the host observed a terminal command result",
        updatedAt: timestamp,
      });
      this.#putCommand(fenced);
      this.#appendControl({ type: "command.changed", command: fenced });
    }
    for (const interaction of this.listInteractions({ pendingOnly: true })) {
      const session = this.getSession(interaction.sessionId);
      if (session?.workerId !== workerId) continue;
      const stale = interactionRecordSchema.parse({ ...interaction, state: "stale" });
      this.#putInteraction(stale);
      this.#appendControl({ type: "interaction.changed", interaction: stale });
    }
    for (const session of this.listSessions({ workerId })) {
      if (session.availability === "unavailable" && session.runtimeEpoch === null) continue;
      const unavailable = sessionRecordSchema.parse({
        ...session,
        availability: "unavailable",
        runtimeStatus: "unknown",
        runtimeEpoch: null,
        updatedAt: timestamp,
      });
      this.#putSession(unavailable);
      this.#appendControl({ type: "session.unavailable", sessionId: session.sessionId });
    }
  }

  #staleInteractionsForSession(sessionId: SessionId): void {
    for (const interaction of this.listInteractions({ sessionId, pendingOnly: true })) {
      const stale = interactionRecordSchema.parse({ ...interaction, state: "stale" });
      this.#putInteraction(stale);
      this.#appendControl({ type: "interaction.changed", interaction: stale });
    }
  }

  #canTransitionCommand(current: CommandState, incoming: CommandState): boolean {
    if (current === incoming) return true;
    if (current === "received") return true;
    if (current === "started") {
      return incoming === "succeeded" || incoming === "failed" || incoming === "outcomeUnknown";
    }
    if (current === "outcomeUnknown") {
      return incoming === "succeeded" || incoming === "failed";
    }
    return false;
  }

  #commandStateRank(state: CommandState): number {
    switch (state) {
      case "received":
        return 0;
      case "started":
        return 1;
      case "outcomeUnknown":
        return 2;
      case "succeeded":
      case "failed":
        return 3;
    }
  }

  #listCommandsForWorker(workerId: WorkerId): CommandRecord[] {
    const rows = this.#db
      .prepare("SELECT record_json FROM commands WHERE worker_id = ?")
      .all(workerId) as Row[];
    return rows.map((row) => parsed(commandRecordSchema, row.record_json));
  }

  #pendingLifecycleIntents(workerId: WorkerId): PendingLifecycleIntent[] {
    const rows = this.#db
      .prepare(
        `SELECT command_id, session_id, harness, vendor_session_id
         FROM lifecycle_intents
         WHERE worker_id = ? AND ready = 1 AND binding_state = 'pending'
           AND vendor_session_id IS NOT NULL
         ORDER BY created_at, command_id`,
      )
      .all(workerId) as Row[];
    return rows.map((row) => ({
      commandId: String(row.command_id),
      sessionId: row.session_id as SessionId,
      harness: row.harness as "codex" | "copilot",
      vendorSessionId: String(row.vendor_session_id),
    }));
  }

  #unresolvedSpawnHarnesses(workerId: WorkerId): Set<"codex" | "copilot"> {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT lifecycle_intents.harness
         FROM lifecycle_intents
         JOIN commands ON commands.command_id = lifecycle_intents.command_id
         WHERE lifecycle_intents.worker_id = ?
           AND lifecycle_intents.ready = 0
           AND lifecycle_intents.binding_state = 'pending'
           AND lifecycle_intents.vendor_session_id IS NULL
           AND commands.state IN ('received', 'started', 'outcomeUnknown')`,
      )
      .all(workerId) as Row[];
    return new Set(rows.map((row) => row.harness as "codex" | "copilot"));
  }

  #unresolvedLifecycleNativeKeys(workerId: WorkerId): Set<string> {
    const rows = this.#db
      .prepare(
        `SELECT lifecycle_intents.harness, lifecycle_intents.vendor_session_id
         FROM lifecycle_intents
         JOIN commands ON commands.command_id = lifecycle_intents.command_id
         WHERE lifecycle_intents.worker_id = ?
           AND lifecycle_intents.ready = 0
           AND lifecycle_intents.binding_state = 'pending'
           AND lifecycle_intents.vendor_session_id IS NOT NULL
           AND commands.state IN ('received', 'started', 'outcomeUnknown')`,
      )
      .all(workerId) as Row[];
    return new Set(
      rows.map((row) => `${String(row.harness)}\0${String(row.vendor_session_id)}`),
    );
  }

  #settleLifecycleIntent(
    commandId: string,
    state: "bound" | "conflicted",
    error?: string,
  ): void {
    this.#db
      .prepare(
        `UPDATE lifecycle_intents
         SET binding_state = ?, binding_error = ?
         WHERE command_id = ? AND binding_state = 'pending'`,
      )
      .run(state, error ?? null, commandId);
  }

  #syncLifecycleIntentForCommand(record: CommandRecord): void {
    if (record.state !== "succeeded") return;
    const row = this.#db
      .prepare("SELECT vendor_session_id FROM lifecycle_intents WHERE command_id = ?")
      .get(record.commandId) as Row | undefined;
    if (!row) return;
    const resultVendorSessionId = this.#commandVendorSessionId(record);
    const currentVendorSessionId = row.vendor_session_id === null
      ? undefined
      : String(row.vendor_session_id);
    if (
      currentVendorSessionId &&
      resultVendorSessionId &&
      currentVendorSessionId !== resultVendorSessionId
    ) {
      throw new HostCoreError(
        "PAYLOAD_MISMATCH",
        `command ${record.commandId} succeeded for another vendor session`,
      );
    }
    const vendorSessionId = resultVendorSessionId ?? currentVendorSessionId;
    if (!vendorSessionId) return;
    this.#db
      .prepare(
        `UPDATE lifecycle_intents
         SET vendor_session_id = ?, ready = 1
         WHERE command_id = ?`,
      )
      .run(vendorSessionId, record.commandId);
  }

  #assertLifecycleCommand(
    record: CommandRecord,
    input: SpawnCommand | ResumeCommand,
  ): void {
    if (
      record.commandId !== input.commandId ||
      record.payloadHash !== input.payloadHash ||
      record.sessionId !== input.sessionId ||
      record.workerId !== input.workerId ||
      jsonForHash(record.request) !== jsonForHash(input)
    ) {
      throw new HostCoreError(
        "PAYLOAD_MISMATCH",
        `command ${record.commandId} does not match its lifecycle binding intent`,
      );
    }
  }

  #commandVendorSessionId(record: CommandRecord): string | undefined {
    const result = record.result;
    if (!result || Array.isArray(result) || typeof result !== "object") return undefined;
    const vendorSessionId = result.vendorSessionId;
    return typeof vendorSessionId === "string" && vendorSessionId.length > 0
      ? vendorSessionId
      : undefined;
  }

  /** Merge a child-projected interaction without allowing snapshot replay to
   * resurrect a terminal request or reuse an ID for another native request. */
  #mergeImportedInteraction(input: InteractionRecord): {
    interaction: InteractionRecord;
    changed: boolean;
  } {
    const incoming = interactionRecordSchema.parse(input);
    const session = this.getSession(incoming.sessionId);
    if (!session) {
      throw new HostCoreError("NOT_FOUND", "interaction session is not imported");
    }
    if (session.harness !== incoming.harness) {
      throw new HostCoreError("FENCED", "interaction harness does not match its session");
    }
    const existing = this.getInteraction(incoming.interactionId);
    if (existing) {
      if (
        existing.sessionId !== incoming.sessionId ||
        existing.harness !== incoming.harness ||
        existing.runtimeEpoch !== incoming.runtimeEpoch ||
        existing.nativeRequestId !== incoming.nativeRequestId ||
        existing.requestType !== incoming.requestType ||
        existing.ephemeral !== incoming.ephemeral ||
        existing.createdAt !== incoming.createdAt ||
        existing.expiresAt !== incoming.expiresAt ||
        jsonForHash(existing.payload) !== jsonForHash(incoming.payload)
      ) {
        throw new HostCoreError(
          "PAYLOAD_MISMATCH",
          "interaction ID was reused for another request",
        );
      }
      if (existing.state !== "pending") {
        if (incoming.state === "pending") return { interaction: existing, changed: false };
        if (
          incoming.state !== existing.state ||
          !this.#sameInteractionResolution(existing, incoming)
        ) {
          throw new HostCoreError("CONFLICT", "a terminal interaction cannot change state");
        }
        return { interaction: existing, changed: false };
      }
      if (incoming.state === "pending") {
        if (session.runtimeEpoch !== incoming.runtimeEpoch) {
          throw new HostCoreError("FENCED", "pending interaction belongs to a stale runtime");
        }
        return { interaction: existing, changed: false };
      }
      return { interaction: incoming, changed: true };
    }
    if (incoming.state === "pending" && session.runtimeEpoch !== incoming.runtimeEpoch) {
      throw new HostCoreError("FENCED", "pending interaction belongs to a stale runtime");
    }
    return { interaction: incoming, changed: true };
  }

  #sameInteractionResolution(
    current: InteractionRecord,
    incoming: InteractionRecord,
  ): boolean {
    if (current.resolution === undefined || incoming.resolution === undefined) {
      return current.resolution === undefined && incoming.resolution === undefined;
    }
    return jsonForHash(current.resolution) === jsonForHash(incoming.resolution);
  }

  #sameBinding(
    record: SessionRecord,
    workerId: WorkerId,
    item: Pick<NativeInventoryItem, "harness" | "adapterScopeId" | "vendorSessionId">,
  ): boolean {
    return (
      record.workerId === workerId &&
      record.harness === item.harness &&
      record.adapterScopeId === item.adapterScopeId &&
      record.vendorSessionId === item.vendorSessionId
    );
  }

  #assertCanRebind(record: SessionRecord, workerId: WorkerId, item: NativeInventoryItem): void {
    if (record.harness !== item.harness) {
      throw new HostCoreError("FENCED", "cannot bind a logical session to another harness");
    }
    if (record.workerId !== workerId && record.availability !== "unavailable") {
      throw new HostCoreError("FENCED", "cannot move an available session between workers");
    }
  }

  #assertSameCommand(current: CommandRecord, incoming: CommandRecord): void {
    if (
      current.payloadHash !== incoming.payloadHash ||
      current.workerId !== incoming.workerId ||
      current.sessionId !== incoming.sessionId ||
      jsonForHash(current.request) !== jsonForHash(incoming.request)
    ) {
      throw new HostCoreError(
        "PAYLOAD_MISMATCH",
        `command ${current.commandId} was already used for another request`,
      );
    }
  }
}
