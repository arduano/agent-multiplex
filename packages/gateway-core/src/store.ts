import { DatabaseSync } from "node:sqlite";

import {
  HardenedSqliteDatabase,
  SQLITE_SCHEMA_VERSION,
  type SqliteBackupResult,
  type SqliteDiagnostics,
} from "@arduano/agent-multiplex-storage-sqlite";
import { sourceIdSchema, type FeedId, type SourceId } from "@arduano/agent-multiplex-protocol";

const GATEWAY_STORE_APPLICATION_ID = 0x414d_4757; // "AMGW"
type Row = Record<string, unknown>;

export interface PersistedGatewaySource {
  readonly sourceId: SourceId;
  readonly displayName: string;
  readonly endpointId: string;
  readonly locator: Readonly<Record<string, unknown>>;
  readonly priority: number;
  readonly enabled: boolean;
  readonly renewedTicket?: string;
  readonly feedId?: FeedId;
  readonly controlCursor: number;
  readonly health?: Readonly<Record<string, unknown>>;
  readonly updatedAt: string;
}

/** Operational state only. This database is never a domain-data authority. */
export class GatewayOperationalStore {
  readonly #sqlite: HardenedSqliteDatabase;
  readonly #db: DatabaseSync;

  public constructor(filename: string) {
    this.#sqlite = new HardenedSqliteDatabase({
      filename,
      applicationId: GATEWAY_STORE_APPLICATION_ID,
      storeName: "access gateway operational store",
      migrations: [{
        version: SQLITE_SCHEMA_VERSION,
        name: "access-gateway-v3-bootstrap",
        apply(database) {
          database.exec(`
            CREATE TABLE gateway_sources (
              source_id TEXT PRIMARY KEY,
              display_name TEXT NOT NULL,
              endpoint_id TEXT NOT NULL,
              locator_json TEXT NOT NULL CHECK(json_valid(locator_json)),
              priority INTEGER NOT NULL DEFAULT 0,
              enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
              renewed_ticket TEXT,
              feed_id TEXT,
              control_cursor INTEGER NOT NULL DEFAULT 0 CHECK(control_cursor >= 0),
              health_json TEXT CHECK(health_json IS NULL OR json_valid(health_json)),
              updated_at TEXT NOT NULL
            ) STRICT;
            CREATE UNIQUE INDEX gateway_sources_endpoint_id ON gateway_sources(endpoint_id);
          `);
        },
      }],
    });
    this.#db = this.#sqlite.database;
  }

  public close(): void { this.#sqlite.close(); }
  public diagnostics(): SqliteDiagnostics { return this.#sqlite.diagnostics(); }
  public backup(destination: string): Promise<SqliteBackupResult> { return this.#sqlite.backup(destination); }

  public putSource(source: PersistedGatewaySource): void {
    const sourceId = sourceIdSchema.parse(source.sourceId);
    this.#db.prepare(`
      INSERT INTO gateway_sources(
        source_id, display_name, endpoint_id, locator_json, priority, enabled,
        renewed_ticket, feed_id, control_cursor, health_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        display_name = excluded.display_name,
        endpoint_id = excluded.endpoint_id,
        locator_json = excluded.locator_json,
        priority = excluded.priority,
        enabled = excluded.enabled,
        renewed_ticket = excluded.renewed_ticket,
        feed_id = excluded.feed_id,
        control_cursor = excluded.control_cursor,
        health_json = excluded.health_json,
        updated_at = excluded.updated_at
    `).run(
      sourceId,
      source.displayName,
      source.endpointId,
      JSON.stringify(source.locator),
      source.priority,
      source.enabled ? 1 : 0,
      source.renewedTicket ?? null,
      source.feedId ?? null,
      source.controlCursor,
      source.health === undefined ? null : JSON.stringify(source.health),
      source.updatedAt,
    );
  }

  public listSources(): PersistedGatewaySource[] {
    const rows = this.#db.prepare("SELECT * FROM gateway_sources ORDER BY source_id").all() as Row[];
    return rows.map((row) => ({
      sourceId: sourceIdSchema.parse(row.source_id),
      displayName: String(row.display_name),
      endpointId: String(row.endpoint_id),
      locator: JSON.parse(String(row.locator_json)) as Readonly<Record<string, unknown>>,
      priority: Number(row.priority),
      enabled: Number(row.enabled) === 1,
      ...(row.renewed_ticket === null ? {} : { renewedTicket: String(row.renewed_ticket) }),
      ...(row.feed_id === null ? {} : { feedId: String(row.feed_id) as FeedId }),
      controlCursor: Number(row.control_cursor),
      ...(row.health_json === null
        ? {}
        : { health: JSON.parse(String(row.health_json)) as Readonly<Record<string, unknown>> }),
      updatedAt: String(row.updated_at),
    }));
  }
}
