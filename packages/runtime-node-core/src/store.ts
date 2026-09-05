import { DatabaseSync } from "node:sqlite";

import {
  HardenedSqliteDatabase,
  type SqliteBackupResult,
  type SqliteCheckpointResult,
  type SqliteDiagnostics,
  type SqliteIntegrityDiagnostics,
} from "@arduano/agent-multiplex-storage-sqlite";

import {
  archiveRecordSchema,
  archiveRequestSchema,
  canonicalJson,
  commandRecordSchema,
  jsonObjectSchema,
  launchRecordSchema,
  launchRequestSchema,
  metadataOperationRecordSchema,
  metadataPatchSchema,
  nativePayloadSchema,
  toJsonValue,
  runtimeNodeSessionRecordSchema,
  sessionLaunchProvenanceSchema,
  type ArchiveRecord,
  type ArchiveRequest,
  type CommandId,
  type CommandRecord,
  type JsonObject,
  type LaunchId,
  type LaunchRecord,
  type LaunchRequest,
  type MetadataOperationRecord,
  type MetadataPatch,
  type SessionId,
  type RuntimeNodeSessionRecord,
  type SessionLaunchProvenance,
  type Harness,
  type AdapterScopeId,
} from "@arduano/agent-multiplex-protocol";

import {
  parseRuntimePreparedLaunch,
  type RuntimePreparedLaunch,
} from "./launch-provider.js";

type Row = Record<string, unknown>;

const encode = (value: unknown): string => JSON.stringify(value);
const decode = (value: unknown): unknown => JSON.parse(String(value));
const RUNTIME_NODE_STORE_APPLICATION_ID = 0x414d_5254; // "AMRT" (agent-multiplex runtime)

export interface RuntimeLaunchJournalEntry {
  readonly request: LaunchRequest;
  readonly record: LaunchRecord;
  readonly checkpoint: JsonObject | null;
  readonly preparation: RuntimePreparedLaunch | null;
  /** Original known failure retained while compensation is pending. */
  readonly pendingFailure: string | null;
}

export interface RuntimeArchiveJournalEntry {
  readonly request: ArchiveRequest;
  readonly record: ArchiveRecord;
  readonly backendReleased: boolean;
  readonly providerReleased: boolean;
}

export interface RuntimeArchivedNativeBindingTombstone {
  readonly sessionId: SessionId;
  readonly harness: Harness;
  readonly adapterScopeId: AdapterScopeId;
  readonly vendorSessionId: string;
  readonly launchProvenance: SessionLaunchProvenance | null;
  readonly archivedAt: string;
}

export interface RuntimeImageEntry {
  imageId: string;
  sessionId: SessionId;
  bindingRevision: number;
  sha256: string;
  byteLength: number;
  mediaType: string;
  receivedBytes: number;
  committed: boolean;
  updatedAt: number;
  sourceKey: string | null;
}

export class RuntimeNodeStore {
  readonly #sqlite: HardenedSqliteDatabase;
  readonly #db: DatabaseSync;

  public constructor(filename: string) {
    this.#sqlite = new HardenedSqliteDatabase({
      filename,
      applicationId: RUNTIME_NODE_STORE_APPLICATION_ID,
      storeName: "runtime-node store",
      migrations: [{
        version: 3,
        name: "runtime-node-store-v3-bootstrap",
        apply: bootstrapRuntimeNodeSchema,
      }, {
        version: 4,
        name: "runtime-node-store-v4-launch-and-archive",
        apply: migrateRuntimeNodeSchemaV4,
      }, {
        version: 5,
        name: "runtime-node-store-v5-images",
        apply: migrateRuntimeNodeSchemaV5,
      }],
    });
    this.#db = this.#sqlite.database;
    try {
      this.#recoverInFlightCommands();
    } catch (error) {
      this.#sqlite.close();
      throw error;
    }
  }

  public close(): void {
    this.#sqlite.close();
  }

  public getImage(imageId: string): RuntimeImageEntry | undefined {
    const row = this.#db.prepare("SELECT record_json FROM images WHERE image_id = ?")
      .get(imageId) as Row | undefined;
    return row ? JSON.parse(String(row.record_json)) as RuntimeImageEntry : undefined;
  }

  public listImages(sessionId?: SessionId): RuntimeImageEntry[] {
    const rows = (sessionId === undefined
      ? this.#db.prepare("SELECT record_json FROM images").all()
      : this.#db.prepare("SELECT record_json FROM images WHERE session_id = ?").all(sessionId)) as Row[];
    return rows.map((row) => JSON.parse(String(row.record_json)) as RuntimeImageEntry);
  }

  public putImage(entry: RuntimeImageEntry): void {
    this.#db.prepare(`INSERT INTO images(image_id, session_id, source_key, record_json)
      VALUES (?, ?, ?, ?) ON CONFLICT(image_id) DO UPDATE SET record_json = excluded.record_json`)
      .run(entry.imageId, entry.sessionId, entry.sourceKey, encode(entry));
  }

  public deleteImage(imageId: string): void {
    this.#db.prepare("DELETE FROM images WHERE image_id = ?").run(imageId);
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

  public getSetting(key: string): string | undefined {
    const row = this.#db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | Row
      | undefined;
    return row ? String(row.value) : undefined;
  }

  public setSetting(key: string, value: string): void {
    this.#db
      .prepare(
        "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  public putSession(record: RuntimeNodeSessionRecord): void {
    const parsed = runtimeNodeSessionRecordSchema.parse(record);
    this.#putParsedSession(parsed);
  }

  /** Commit one reconciliation response as a single durable unit. */
  public putSessions(records: readonly RuntimeNodeSessionRecord[]): void {
    this.putSessionsAndEnqueueMetadata(records, []);
  }

  /**
   * Commit canonical bindings and metadata proposals derived from durable
   * runtime state as one unit. This is used when a newly bound launch first
   * learns its metadata-authority fence.
   */
  public putSessionsAndEnqueueMetadata(
    records: readonly RuntimeNodeSessionRecord[],
    patches: readonly MetadataPatch[],
  ): void {
    const parsed = records.map((record) => runtimeNodeSessionRecordSchema.parse(record));
    const parsedPatches = patches.map((patch) => metadataPatchSchema.parse(patch));
    if (parsed.length === 0 && parsedPatches.length === 0) return;
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const record of parsed) this.#putParsedSession(record);
      for (const patch of parsedPatches) this.#enqueueParsedMetadata(patch);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  public getSession(sessionId: SessionId): RuntimeNodeSessionRecord | undefined {
    const row = this.#db
      .prepare("SELECT record_json FROM bindings WHERE session_id = ?")
      .get(sessionId) as Row | undefined;
    return row ? runtimeNodeSessionRecordSchema.parse(decode(row.record_json)) : undefined;
  }

  public listSessions(): RuntimeNodeSessionRecord[] {
    const rows = this.#db
      .prepare("SELECT record_json FROM bindings ORDER BY updated_at DESC")
      .all() as Row[];
    return rows.map((row) => runtimeNodeSessionRecordSchema.parse(decode(row.record_json)));
  }

  public deleteSession(sessionId: SessionId): boolean {
    return this.#db
      .prepare("DELETE FROM bindings WHERE session_id = ?")
      .run(sessionId).changes > 0;
  }

  public isNativeBindingArchived(
    binding: Pick<
      RuntimeNodeSessionRecord,
      "harness" | "adapterScopeId" | "vendorSessionId"
    >,
  ): boolean {
    return this.#db.prepare(`
      SELECT 1 FROM archived_native_bindings
      WHERE harness = ? AND adapter_scope_id = ? AND vendor_session_id = ?
    `).get(binding.harness, binding.adapterScopeId, binding.vendorSessionId) !== undefined;
  }

  public listArchivedNativeBindings(): RuntimeArchivedNativeBindingTombstone[] {
    const rows = this.#db.prepare(`
      SELECT record_json FROM archived_native_bindings
      ORDER BY archived_at, session_id
    `).all() as Row[];
    return rows.map((row) => decodeArchivedNativeBinding(decode(row.record_json)));
  }

  public getCommand(commandId: CommandId): CommandRecord | undefined {
    const row = this.#db
      .prepare("SELECT record_json FROM command_journal WHERE command_id = ?")
      .get(commandId) as Row | undefined;
    return row ? commandRecordSchema.parse(decode(row.record_json)) : undefined;
  }

  public putCommand(record: CommandRecord): void {
    const parsed = commandRecordSchema.parse(record);
    this.#db
      .prepare(
        `INSERT INTO command_journal(command_id, payload_hash, record_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(command_id) DO UPDATE SET
           record_json = excluded.record_json,
           updated_at = excluded.updated_at`,
      )
      .run(parsed.commandId, parsed.payloadHash, encode(parsed), parsed.updatedAt);
  }

  public getLaunch(launchId: LaunchId): LaunchRecord | undefined {
    return this.getLaunchEntry(launchId)?.record;
  }

  public getLaunchEntry(launchId: LaunchId): RuntimeLaunchJournalEntry | undefined {
    const row = this.#db.prepare(`
      SELECT request_json, record_json, checkpoint_json, preparation_json,
             pending_failure
      FROM launch_journal WHERE launch_id = ?
    `).get(launchId) as Row | undefined;
    return row ? decodeLaunchEntry(row) : undefined;
  }

  public getLaunchEntryForSession(
    sessionId: SessionId,
  ): RuntimeLaunchJournalEntry | undefined {
    const row = this.#db.prepare(`
      SELECT request_json, record_json, checkpoint_json, preparation_json,
             pending_failure
      FROM launch_journal WHERE session_id = ?
    `).get(sessionId) as Row | undefined;
    return row ? decodeLaunchEntry(row) : undefined;
  }

  public listLaunchEntries(options: { nonterminalOnly?: boolean } = {}): RuntimeLaunchJournalEntry[] {
    const where = options.nonterminalOnly
      ? "WHERE state IN ('accepted', 'preparing', 'nativeStarting', 'cleanupPending')"
      : "";
    const rows = this.#db.prepare(`
      SELECT request_json, record_json, checkpoint_json, preparation_json,
             pending_failure
      FROM launch_journal ${where} ORDER BY created_at, launch_id
    `).all() as Row[];
    return rows.map(decodeLaunchEntry);
  }

  public putLaunchEntry(entry: RuntimeLaunchJournalEntry): void {
    this.#putParsedLaunch(parseLaunchEntry(entry));
  }

  /** Bind the native session and settle its launch in one durable commit. */
  public commitLaunchSuccess(
    entry: RuntimeLaunchJournalEntry,
    session: RuntimeNodeSessionRecord,
  ): void {
    const parsedEntry = parseLaunchEntry(entry);
    const parsedSession = runtimeNodeSessionRecordSchema.parse(session);
    if (
      parsedEntry.record.state !== "succeeded" ||
      parsedEntry.record.sessionId !== parsedSession.sessionId ||
      parsedEntry.record.result?.adapterScopeId !== parsedSession.adapterScopeId ||
      parsedEntry.record.result.vendorSessionId !== parsedSession.vendorSessionId
    ) {
      throw new Error("launch success and native session binding do not match");
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#putParsedSession(parsedSession);
      this.#putParsedLaunch(parsedEntry);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  public getArchive(
    archiveOperationId: ArchiveRequest["archiveOperationId"],
  ): ArchiveRecord | undefined {
    return this.getArchiveEntry(archiveOperationId)?.record;
  }

  public getArchiveEntry(
    archiveOperationId: ArchiveRequest["archiveOperationId"],
  ): RuntimeArchiveJournalEntry | undefined {
    const row = this.#db.prepare(`
      SELECT request_json, record_json, backend_released, provider_released
      FROM archive_journal WHERE archive_operation_id = ?
    `).get(archiveOperationId) as Row | undefined;
    return row ? decodeArchiveEntry(row) : undefined;
  }

  public listArchiveEntries(
    options: { nonterminalOnly?: boolean } = {},
  ): RuntimeArchiveJournalEntry[] {
    const where = options.nonterminalOnly ? "WHERE state IN ('accepted', 'releasing')" : "";
    const rows = this.#db.prepare(`
      SELECT request_json, record_json, backend_released, provider_released
      FROM archive_journal ${where} ORDER BY created_at, archive_operation_id
    `).all() as Row[];
    return rows.map(decodeArchiveEntry);
  }

  public listArchiveEntriesForSession(
    sessionId: SessionId,
  ): RuntimeArchiveJournalEntry[] {
    const rows = this.#db.prepare(`
      SELECT request_json, record_json, backend_released, provider_released
      FROM archive_journal WHERE session_id = ?
      ORDER BY created_at DESC, archive_operation_id DESC
    `).all(sessionId) as Row[];
    return rows.map(decodeArchiveEntry);
  }

  public putArchiveEntry(entry: RuntimeArchiveJournalEntry): void {
    this.#putParsedArchive(parseArchiveEntry(entry));
  }

  /** Remove the runtime binding and settle cleanup as one durable commit. */
  public commitArchiveSuccess(
    entry: RuntimeArchiveJournalEntry,
    session: RuntimeNodeSessionRecord,
  ): void {
    const parsed = parseArchiveEntry(entry);
    const parsedSession = runtimeNodeSessionRecordSchema.parse(session);
    if (
      parsed.record.state !== "succeeded" ||
      !parsed.backendReleased ||
      !parsed.providerReleased ||
      parsed.record.sessionId !== parsedSession.sessionId
    ) {
      throw new Error("archive success requires complete backend and provider release");
    }
    const tombstone: RuntimeArchivedNativeBindingTombstone = {
      sessionId: parsedSession.sessionId,
      harness: parsedSession.harness,
      adapterScopeId: parsedSession.adapterScopeId,
      vendorSessionId: parsedSession.vendorSessionId,
      launchProvenance: parsedSession.launchProvenance,
      archivedAt: parsed.record.releasedAt!,
    };
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        INSERT INTO archived_native_bindings(
          harness, adapter_scope_id, vendor_session_id, session_id,
          archived_at, record_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(harness, adapter_scope_id, vendor_session_id) DO UPDATE SET
          record_json = excluded.record_json,
          archived_at = excluded.archived_at
      `).run(
        tombstone.harness,
        tombstone.adapterScopeId,
        tombstone.vendorSessionId,
        tombstone.sessionId,
        tombstone.archivedAt,
        encode(tombstone),
      );
      this.#db
        .prepare("DELETE FROM bindings WHERE session_id = ?")
        .run(parsed.record.sessionId);
      this.#putParsedArchive(parsed);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  public enqueueMetadata(patch: MetadataPatch): void {
    const parsed = metadataPatchSchema.parse(patch);
    this.#enqueueParsedMetadata(parsed);
  }

  #enqueueParsedMetadata(parsed: MetadataPatch): void {
    const outboxRow = this.#db
      .prepare("SELECT patch_json FROM metadata_outbox WHERE operation_id = ?")
      .get(parsed.operationId) as Row | undefined;
    if (outboxRow) {
      assertSameMetadataPatch(
        metadataPatchSchema.parse(decode(outboxRow.patch_json)),
        parsed,
      );
      return;
    }
    const receipt = this.getMetadataOperation(parsed.operationId);
    if (receipt) {
      assertSameMetadataPatch(receipt.patch, parsed);
      return;
    }
    this.#db
      .prepare(
        "INSERT INTO metadata_outbox(operation_id, patch_json, created_at) VALUES (?, ?, ?)",
      )
      .run(parsed.operationId, encode(parsed), new Date().toISOString());
  }

  public listMetadataOutbox(limit = 1_000): MetadataPatch[] {
    assertPositiveLimit(limit);
    const rows = this.#db
      .prepare("SELECT patch_json FROM metadata_outbox ORDER BY sequence LIMIT ?")
      .all(limit) as Row[];
    return rows.map((row) => metadataPatchSchema.parse(decode(row.patch_json)));
  }

  /** Pending patches for one logical session, used to construct its complete local overlay. */
  public listSessionMetadataOutbox(sessionId: SessionId): MetadataPatch[] {
    const rows = this.#db
      .prepare(
        `SELECT patch_json FROM metadata_outbox
         WHERE json_extract(patch_json, '$.sessionId') = ?
         ORDER BY sequence`,
      )
      .all(sessionId) as Row[];
    return rows.map((row) => metadataPatchSchema.parse(decode(row.patch_json)));
  }

  /**
   * Durably transfer acknowledged operations to the control node. Receipt storage,
   * canonical-session advancement, and local outbox deletion are one commit.
   */
  public settleMetadataOutbox(records: readonly MetadataOperationRecord[]): void {
    const operations = records.map((record) => metadataOperationRecordSchema.parse(record));
    const findPatch = this.#db.prepare(
      "SELECT patch_json FROM metadata_outbox WHERE operation_id = ?",
    );
    const findReceipt = this.#db.prepare(
      "SELECT record_json FROM metadata_operation_receipts WHERE operation_id = ?",
    );
    const insertReceipt = this.#db.prepare(
      `INSERT INTO metadata_operation_receipts(
         operation_id, session_id, status, record_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const deletePatch = this.#db.prepare(
      "DELETE FROM metadata_outbox WHERE operation_id = ?",
    );
    const seen = new Set<string>();

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const operation of operations) {
        if (seen.has(operation.operationId)) {
          throw new Error(
            `control node returned metadata operation ${operation.operationId} more than once`,
          );
        }
        seen.add(operation.operationId);

        const row = findPatch.get(operation.operationId) as Row | undefined;
        if (!row) {
          throw new Error(
            `control node returned unknown metadata operation ${operation.operationId}`,
          );
        }
        const outstanding = metadataPatchSchema.parse(decode(row.patch_json));
        if (
          outstanding.sessionId !== operation.sessionId ||
          canonicalJson(toJsonValue(outstanding)) !== canonicalJson(toJsonValue(operation.patch))
        ) {
          throw new Error(
            `control node returned mismatched metadata operation ${operation.operationId}`,
          );
        }

        const session = this.getSession(operation.sessionId);
        if (!session) {
          throw new Error(`metadata session ${operation.sessionId} is no longer bound`);
        }
        assertSessionAuthority(session, operation);
        assertCanonicalDoesNotDiverge(session, operation);

        const receiptRow = findReceipt.get(operation.operationId) as Row | undefined;
        const existingReceipt = receiptRow
          ? metadataOperationRecordSchema.parse(decode(receiptRow.record_json))
          : undefined;
        let canonicalReceipt = operation;
        if (existingReceipt) {
          // A terminal downstream delivery can race the response to this
          // outbox transfer. A later queued acknowledgement is stale but still
          // proves that the control node durably accepted this exact patch.
          // Retain the terminal receipt and consume the local patch.
          assertSameMetadataOperationIdentity(existingReceipt, operation);
          if (existingReceipt.status !== "queued" && operation.status === "queued") {
            canonicalReceipt = existingReceipt;
          } else if (
            canonicalJson(toJsonValue(existingReceipt)) !==
              canonicalJson(toJsonValue(operation))
          ) {
            throw new Error(
              `control node changed metadata operation ${operation.operationId} during outbox settlement`,
            );
          }
        } else {
          // Persist the receipt before removing the patch. The surrounding
          // transaction makes the ordering durable even across process death.
          insertReceipt.run(
            operation.operationId,
            operation.sessionId,
            operation.status,
            encode(operation),
            operation.createdAt,
            operation.updatedAt,
          );
        }
        if (canonicalReceipt.canonical.revision > session.metadata.revision) {
          this.putSession({
            ...session,
            metadata: canonicalReceipt.canonical,
            updatedAt: new Date().toISOString(),
          });
        }
        deletePatch.run(operation.operationId);
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Apply a terminal result from the pinned metadata authority. Locally
   * originated operations replace their queued receipt; client-originated
   * operations are first observed here and are inserted as terminal receipts.
   * Both paths use the session's authority fence and canonical revision checks.
   */
  public applyMetadataSettlement(record: MetadataOperationRecord): MetadataOperationRecord {
    const operation = metadataOperationRecordSchema.parse(record);
    if (operation.status === "queued") {
      throw new Error("control-node metadata settlement must be terminal");
    }
    const current = this.getMetadataOperation(operation.operationId);
    if (current && (
      current.sessionId !== operation.sessionId ||
      canonicalJson(toJsonValue(current.patch)) !== canonicalJson(toJsonValue(operation.patch))
    )) {
      throw new Error(
        `control node returned mismatched metadata operation ${operation.operationId}`,
      );
    }
    if (current && current.status !== "queued") {
      if (
        canonicalJson(JSON.parse(encode(current))) !==
        canonicalJson(JSON.parse(encode(operation)))
      ) {
        throw new Error(
          `control node changed terminal metadata operation ${operation.operationId}`,
        );
      }
      return current;
    }
    const session = this.getSession(operation.sessionId);
    if (!session) {
      throw new Error(`metadata session ${operation.sessionId} is no longer bound`);
    }
    const establishesAuthority = session.metadataAuthority === undefined;
    if (establishesAuthority && session.metadata.revision !== 0) {
      throw new Error(
        `control node cannot establish metadata authority for session ${operation.sessionId} after its revision advanced`,
      );
    }
    if (!establishesAuthority) assertSessionAuthority(session, operation);
    assertCanonicalDoesNotDiverge(session, operation);

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (current) {
        this.#db
          .prepare(
            `UPDATE metadata_operation_receipts
             SET status = ?, record_json = ?, updated_at = ?
             WHERE operation_id = ? AND status = 'queued'`,
          )
          .run(
            operation.status,
            encode(operation),
            operation.updatedAt,
            operation.operationId,
          );
      } else {
        this.#db
          .prepare(
            `INSERT INTO metadata_operation_receipts(
               operation_id, session_id, status, record_json, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            operation.operationId,
            operation.sessionId,
            operation.status,
            encode(operation),
            operation.createdAt,
            operation.updatedAt,
          );
      }
      if (establishesAuthority || operation.canonical.revision > session.metadata.revision) {
        this.putSession({
          ...session,
          metadata: operation.canonical.revision > session.metadata.revision
            ? operation.canonical
            : session.metadata,
          metadataAuthority: operation.authority,
          updatedAt: new Date().toISOString(),
        });
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    return operation;
  }

  public getMetadataOperation(
    operationId: MetadataOperationRecord["operationId"],
  ): MetadataOperationRecord | undefined {
    const row = this.#db
      .prepare("SELECT record_json FROM metadata_operation_receipts WHERE operation_id = ?")
      .get(operationId) as Row | undefined;
    return row
      ? metadataOperationRecordSchema.parse(decode(row.record_json))
      : undefined;
  }

  public listMetadataOperations(
    filter: {
      sessionId?: SessionId;
      status?: MetadataOperationRecord["status"];
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
    const where = conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`;
    const rows = this.#db
      .prepare(
        `SELECT record_json FROM metadata_operation_receipts ${where}
         ORDER BY sequence`,
      )
      .all(...parameters) as Row[];
    return rows.map((row) => metadataOperationRecordSchema.parse(decode(row.record_json)));
  }

  #recoverInFlightCommands(): void {
    const rows = this.#db
      .prepare("SELECT record_json FROM command_journal")
      .all() as Row[];
    for (const row of rows) {
      const record = commandRecordSchema.parse(decode(row.record_json));
      if (record.state !== "received" && record.state !== "started") continue;
      this.putCommand({
        ...record,
        state: "outcomeUnknown",
        error: "runtime node restarted after native dispatch; outcome requires reconciliation",
        updatedAt: new Date().toISOString(),
      });
    }
  }

  #putParsedSession(record: RuntimeNodeSessionRecord): void {
    this.#db
      .prepare(
        `INSERT INTO bindings(session_id, record_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET record_json = excluded.record_json, updated_at = excluded.updated_at`,
      )
      .run(record.sessionId, encode(record), record.updatedAt);
  }

  #putParsedLaunch(entry: RuntimeLaunchJournalEntry): void {
    this.#db.prepare(`
      INSERT INTO launch_journal(
        launch_id, session_id, payload_hash, state, request_json, record_json,
        checkpoint_json, preparation_json, pending_failure, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(launch_id) DO UPDATE SET
        state = excluded.state,
        record_json = excluded.record_json,
        checkpoint_json = excluded.checkpoint_json,
        preparation_json = excluded.preparation_json,
        pending_failure = excluded.pending_failure,
        updated_at = excluded.updated_at
    `).run(
      entry.record.launchId,
      entry.record.sessionId,
      entry.record.payloadHash,
      entry.record.state,
      encode(entry.request),
      encode(entry.record),
      entry.checkpoint === null ? null : encode(entry.checkpoint),
      entry.preparation === null ? null : encode(entry.preparation),
      entry.pendingFailure,
      entry.record.createdAt,
      entry.record.updatedAt,
    );
  }

  #putParsedArchive(entry: RuntimeArchiveJournalEntry): void {
    this.#db.prepare(`
      INSERT INTO archive_journal(
        archive_operation_id, session_id, payload_hash, state, request_json,
        record_json, backend_released, provider_released, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(archive_operation_id) DO UPDATE SET
        state = excluded.state,
        record_json = excluded.record_json,
        backend_released = excluded.backend_released,
        provider_released = excluded.provider_released,
        updated_at = excluded.updated_at
    `).run(
      entry.record.archiveOperationId,
      entry.record.sessionId,
      entry.record.payloadHash,
      entry.record.state,
      encode(entry.request),
      encode(entry.record),
      entry.backendReleased ? 1 : 0,
      entry.providerReleased ? 1 : 0,
      entry.record.createdAt,
      entry.record.updatedAt,
    );
  }
}

function parseLaunchEntry(entry: RuntimeLaunchJournalEntry): RuntimeLaunchJournalEntry {
  const request = launchRequestSchema.parse(entry.request);
  const record = launchRecordSchema.parse(entry.record);
  if (
    request.launchId !== record.launchId ||
    request.payloadHash !== record.payloadHash ||
    request.sessionId !== record.sessionId ||
    request.runtimeNodeId !== record.runtimeNodeId
  ) {
    throw new Error("launch journal request and record identity do not match");
  }
  const checkpoint = entry.checkpoint === null ? null : jsonObjectSchema.parse(entry.checkpoint);
  const preparation = entry.preparation === null
    ? null
    : parseRuntimePreparedLaunch(entry.preparation);
  if (preparation && preparation.spawnOptions.harness !== request.harness) {
    throw new Error("launch preparation harness does not match its request");
  }
  return {
    request,
    record,
    checkpoint,
    preparation,
    pendingFailure: entry.pendingFailure,
  };
}

function decodeLaunchEntry(row: Row): RuntimeLaunchJournalEntry {
  return parseLaunchEntry({
    request: launchRequestSchema.parse(decode(row.request_json)),
    record: launchRecordSchema.parse(decode(row.record_json)),
    checkpoint: row.checkpoint_json === null
      ? null
      : jsonObjectSchema.parse(decode(row.checkpoint_json)),
    preparation: row.preparation_json === null
      ? null
      : decode(row.preparation_json) as RuntimePreparedLaunch,
    pendingFailure: row.pending_failure === null ? null : String(row.pending_failure),
  });
}

function parseArchiveEntry(entry: RuntimeArchiveJournalEntry): RuntimeArchiveJournalEntry {
  const request = archiveRequestSchema.parse(entry.request);
  const record = archiveRecordSchema.parse(entry.record);
  if (
    request.archiveOperationId !== record.archiveOperationId ||
    request.payloadHash !== record.payloadHash ||
    request.sessionId !== record.sessionId ||
    request.runtimeNodeId !== record.runtimeNodeId ||
    request.bindingRevision !== record.bindingRevision
  ) {
    throw new Error("archive journal request and record identity do not match");
  }
  return {
    request,
    record,
    backendReleased: entry.backendReleased,
    providerReleased: entry.providerReleased,
  };
}

function decodeArchiveEntry(row: Row): RuntimeArchiveJournalEntry {
  return parseArchiveEntry({
    request: archiveRequestSchema.parse(decode(row.request_json)),
    record: archiveRecordSchema.parse(decode(row.record_json)),
    backendReleased: Number(row.backend_released) === 1,
    providerReleased: Number(row.provider_released) === 1,
  });
}

function assertSessionAuthority(
  session: RuntimeNodeSessionRecord,
  operation: MetadataOperationRecord,
): void {
  const authority = session.metadataAuthority;
  if (
    !authority ||
    authority.realmId !== operation.authority.realmId ||
    authority.controlNodeId !== operation.authority.controlNodeId ||
    authority.epochId !== operation.authority.epochId
  ) {
    throw new Error(
      `control node returned metadata operation ${operation.operationId} for a stale or unrelated authority`,
    );
  }
}

function assertSameMetadataPatch(
  current: MetadataPatch,
  proposed: MetadataPatch,
): void {
  if (
    canonicalJson(toJsonValue(current)) !== canonicalJson(toJsonValue(proposed))
  ) {
    throw new Error(
      `metadata operation ${proposed.operationId} was already used with another patch`,
    );
  }
}

function assertSameMetadataOperationIdentity(
  current: MetadataOperationRecord,
  proposed: MetadataOperationRecord,
): void {
  if (
    current.sessionId !== proposed.sessionId ||
    current.originControlNodeId !== proposed.originControlNodeId ||
    canonicalJson(toJsonValue(current.patch)) !==
      canonicalJson(toJsonValue(proposed.patch)) ||
    canonicalJson(toJsonValue(current.authority)) !==
      canonicalJson(toJsonValue(proposed.authority))
  ) {
    throw new Error(
      `control node changed metadata operation ${proposed.operationId} during outbox settlement`,
    );
  }
}

function assertCanonicalDoesNotDiverge(
  session: RuntimeNodeSessionRecord,
  operation: MetadataOperationRecord,
): void {
  if (
    operation.canonical.revision === session.metadata.revision &&
    canonicalJson(toJsonValue(operation.canonical)) !==
      canonicalJson(toJsonValue(session.metadata))
  ) {
    throw new Error(
      "control-node metadata settlement diverged at the canonical revision",
    );
  }
}

function assertPositiveLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError("metadata outbox limit must be a positive integer");
  }
}

function bootstrapRuntimeNodeSchema(database: DatabaseSync): void {
  database.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS bindings (
        session_id TEXT PRIMARY KEY,
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS bindings_native_key
        ON bindings(json_extract(record_json, '$.runtimeNodeId'),
                    json_extract(record_json, '$.adapterScopeId'),
                    json_extract(record_json, '$.harness'),
                    json_extract(record_json, '$.vendorSessionId'));
      CREATE TABLE IF NOT EXISTS command_journal (
        command_id TEXT PRIMARY KEY,
        payload_hash TEXT NOT NULL,
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS metadata_outbox (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT UNIQUE NOT NULL,
        patch_json TEXT NOT NULL CHECK(json_valid(patch_json)),
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS metadata_operation_receipts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        operation_id TEXT UNIQUE NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'accepted', 'conflicted', 'outcomeUnknown')),
        record_json TEXT NOT NULL CHECK(json_valid(record_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS metadata_operation_receipts_session
        ON metadata_operation_receipts(session_id, sequence);
    `);
}

function migrateRuntimeNodeSchemaV4(database: DatabaseSync): void {
  database.exec(`
    UPDATE bindings
       SET record_json = json_set(record_json, '$.launchProvenance', json('null'))
     WHERE json_type(record_json, '$.launchProvenance') IS NULL;

    UPDATE bindings
       SET record_json = json_set(
         record_json,
         '$.lastActivityAt', json_extract(record_json, '$.lastSeenAt')
       )
     WHERE json_type(record_json, '$.lastActivityAt') IS NULL;

    CREATE TABLE launch_journal (
      launch_id TEXT PRIMARY KEY,
      session_id TEXT UNIQUE NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN (
        'accepted', 'preparing', 'nativeStarting', 'cleanupPending',
        'succeeded', 'failed', 'outcomeUnknown'
      )),
      request_json TEXT NOT NULL CHECK(json_valid(request_json)),
      record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      checkpoint_json TEXT CHECK(checkpoint_json IS NULL OR json_valid(checkpoint_json)),
      preparation_json TEXT CHECK(preparation_json IS NULL OR json_valid(preparation_json)),
      pending_failure TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX launch_journal_state ON launch_journal(state, updated_at, launch_id);

    CREATE TABLE archive_journal (
      archive_operation_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN (
        'accepted', 'releasing', 'succeeded', 'failed', 'outcomeUnknown'
      )),
      request_json TEXT NOT NULL CHECK(json_valid(request_json)),
      record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      backend_released INTEGER NOT NULL CHECK(backend_released IN (0, 1)),
      provider_released INTEGER NOT NULL CHECK(provider_released IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX archive_journal_session ON archive_journal(session_id, created_at);
    CREATE INDEX archive_journal_state ON archive_journal(state, updated_at, archive_operation_id);

    CREATE TABLE archived_native_bindings (
      harness TEXT NOT NULL,
      adapter_scope_id TEXT NOT NULL,
      vendor_session_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      archived_at TEXT NOT NULL,
      record_json TEXT NOT NULL CHECK(json_valid(record_json)),
      PRIMARY KEY(harness, adapter_scope_id, vendor_session_id)
    ) STRICT;
    CREATE UNIQUE INDEX archived_native_bindings_session
      ON archived_native_bindings(session_id);
  `);
}

function migrateRuntimeNodeSchemaV5(database: DatabaseSync): void {
  const update = database.prepare("UPDATE command_journal SET record_json=? WHERE command_id=?");
  for (const row of database.prepare("SELECT command_id, record_json FROM command_journal").all() as Row[]) {
    const value = decode(row.record_json) as Record<string, unknown>;
    if (value.result === undefined) continue;
    const wrapped = nativePayloadSchema.safeParse({ encoding: "native-json-images-v1", json: value.result, images: [] });
    if (!wrapped.success) {
      throw new Error("protocol-v5 migration refused: a stored v4 native payload exceeds the bounded envelope or is invalid; the original database has been preserved");
    }
    value.result = wrapped.data;
    update.run(encode(value), String(row.command_id));
  }
  database.exec(`
    CREATE TABLE images (
      image_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source_key TEXT,
      record_json TEXT NOT NULL CHECK(json_valid(record_json))
    ) STRICT;
    CREATE INDEX images_session ON images(session_id);
    CREATE UNIQUE INDEX images_source ON images(session_id, source_key)
      WHERE source_key IS NOT NULL;
  `);
}

function decodeArchivedNativeBinding(
  value: unknown,
): RuntimeArchivedNativeBindingTombstone {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error("invalid archived native binding tombstone");
  }
  const candidate = value as Record<string, unknown>;
  const launchProvenance = candidate.launchProvenance === null
    ? null
    : sessionLaunchProvenanceSchema.parse(candidate.launchProvenance);
  return {
    sessionId: runtimeNodeSessionRecordSchema.shape.sessionId.parse(candidate.sessionId),
    harness: runtimeNodeSessionRecordSchema.shape.harness.parse(candidate.harness),
    adapterScopeId: runtimeNodeSessionRecordSchema.shape.adapterScopeId.parse(
      candidate.adapterScopeId,
    ),
    vendorSessionId: runtimeNodeSessionRecordSchema.shape.vendorSessionId.parse(
      candidate.vendorSessionId,
    ),
    launchProvenance,
    archivedAt: runtimeNodeSessionRecordSchema.shape.updatedAt.parse(candidate.archivedAt),
  };
}
