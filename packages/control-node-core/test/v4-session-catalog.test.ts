import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  canonicalJson,
  newCommandId,
  newInteractionId,
  packNativePayload,
  newArchiveOperationId,
  newLaunchId,
  newOperationId,
  newRuntimeEpoch,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  type AdapterScopeId,
  type LaunchRecord,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";

import { ControlNodeCatalog, ControlNodeCoreError } from "../src/index.js";

const first = "2037-01-02T03:04:05.000Z";
const later = "2037-01-02T04:04:05.000Z";

function fixture() {
  let time = first;
  const catalog = new ControlNodeCatalog({
    filename: join(
      mkdtempSync(join(tmpdir(), "agent-multiplex-control-v4-")),
      "catalog.sqlite",
    ),
    now: () => new Date(time),
  });
  const runtimeNodeId = newRuntimeNodeId();
  catalog.registerRuntimeNode({
    runtimeNodeId,
    runtimeNodeBootId: newRuntimeNodeBootId(),
    name: "v4-runtime",
    allowedRoots: ["/work"],
    harnesses: [],
    launchProfiles: [],
    protocolVersion: 5,
  });
  const [session] = catalog.reconcileInventory({
    runtimeNodeId,
    generation: "v4-inventory-1",
    complete: true,
    capturedAt: first,
    sessions: [{
      harness: "codex",
      adapterScopeId: "codex-v4" as AdapterScopeId,
      vendorSessionId: "native-v4",
      cwd: "/work/project",
      availability: "active",
      runtimeStatus: "idle",
      runtimeEpoch: newRuntimeEpoch(),
      lastActivityAt: first,
    }],
  });
  if (!session) throw new Error("fixture session missing");
  return { catalog, runtimeNodeId, session, later: () => { time = later; } };
}

describe("control-node v4 session catalog", () => {
  it("indexes structural metadata, distinguishes null from missing, and fences cursors", () => {
    const { catalog, session } = fixture();
    const secondRuntimeNodeId = newRuntimeNodeId();
    catalog.registerRuntimeNode({
      runtimeNodeId: secondRuntimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "v4-runtime-second",
      allowedRoots: ["/work"],
      harnesses: [],
      launchProfiles: [],
      protocolVersion: 5,
    });
    catalog.reconcileInventory({
      runtimeNodeId: secondRuntimeNodeId,
      generation: "v4-inventory-second",
      complete: true,
      capturedAt: first,
      sessions: [{
        harness: "copilot",
        adapterScopeId: "copilot-v4" as AdapterScopeId,
        vendorSessionId: "native-v4-second",
        cwd: "/work/second",
        availability: "active",
        runtimeStatus: "idle",
        runtimeEpoch: newRuntimeEpoch(),
        lastActivityAt: first,
      }],
    });
    catalog.submitMetadataPatch({
      operationId: newOperationId(),
      sessionId: session.sessionId,
      expectedAuthority: session.metadataAuthority,
      set: {
        "review.pull_request": { number: 42, labels: ["ready", "safe"] },
        "review.nullable": null,
      },
    });

    const equality = catalog.searchSessions({
      metadata: [{
        operator: "equals",
        key: "review.pull_request",
        value: { labels: ["ready", "safe"], number: 42 },
      }],
      limit: 1,
    });
    expect(equality.sessions.map((record) => record.sessionId)).toEqual([session.sessionId]);
    expect(catalog.searchSessions({
      metadata: [{ operator: "equals", key: "review.nullable", value: null }],
    }).sessions).toHaveLength(1);
    expect(catalog.searchSessions({
      metadata: [{ operator: "exists", key: "review.missing" }],
    }).sessions).toEqual([]);

    const cursorPage = catalog.searchSessions({ limit: 1 });
    expect(cursorPage.nextCursor).not.toBeNull();
    expect(catalog.searchSessions({
      cursor: cursorPage.nextCursor!,
      limit: 1,
    }).sessions).toHaveLength(1);
    expect(() => catalog.searchSessions({
      states: ["archived"],
      cursor: cursorPage.nextCursor!,
      limit: 1,
    })).toThrowError(expect.objectContaining<Partial<ControlNodeCoreError>>({ code: "FENCED" }));
    catalog.close();
  });

  it("keeps stopped sessions visible, archives only after cleanup, and cannot resurrect them", () => {
    const { catalog, runtimeNodeId, session, later: advance } = fixture();
    const beforeArchive = catalog.submitMetadataPatch({
      operationId: newOperationId(),
      sessionId: session.sessionId,
      expectedAuthority: session.metadataAuthority,
      set: { "review.disposition": "pending" },
    });
    expect(beforeArchive.status).toBe("accepted");
    expect(catalog.pendingMetadataDeliveries()).toHaveLength(1);
    const stopped = catalog.markSessionStopped(session.sessionId, session.bindingRevision);
    expect(catalog.searchSessions({ states: ["stopped"] }).sessions).toHaveLength(1);
    advance();
    const archiveOperationId = newArchiveOperationId();
    const archived = catalog.recordArchive({
      archiveOperationId,
      payloadHash: canonicalJson({ archiveOperationId }).padEnd(16, "0"),
      sessionId: stopped.sessionId,
      runtimeNodeId,
      bindingRevision: stopped.bindingRevision,
      expectedAuthority: stopped.metadataAuthority,
      authority: stopped.metadataAuthority,
      state: "succeeded",
      releasedAt: later,
      catalogRevision: stopped.catalogRevision + 1,
      createdAt: later,
      updatedAt: later,
    });
    expect(archived.state).toBe("succeeded");
    expect(catalog.listSessions()).toEqual([]);
    expect(catalog.searchSessions({ states: ["archived"] }).sessions[0]).toMatchObject({
      sessionId: stopped.sessionId,
      catalogState: "archived",
      archivedAt: later,
    });
    expect(catalog.pendingMetadataDeliveries()).toEqual([]);

    const afterArchive = catalog.submitMetadataPatch({
      operationId: newOperationId(),
      sessionId: session.sessionId,
      expectedAuthority: session.metadataAuthority,
      set: { "review.disposition": "approved" },
    });
    expect(afterArchive.status).toBe("accepted");
    expect(catalog.pendingMetadataDeliveries()).toEqual([]);
    expect(catalog.searchSessions({
      states: ["archived"],
      metadata: [{
        operator: "equals",
        key: "review.disposition",
        value: "approved",
      }],
    }).sessions.map((record) => record.sessionId)).toEqual([session.sessionId]);

    catalog.reconcileInventory({
      runtimeNodeId,
      generation: "stale-after-archive",
      complete: true,
      capturedAt: later,
      sessions: [{
        harness: stopped.harness,
        adapterScopeId: stopped.adapterScopeId,
        vendorSessionId: stopped.vendorSessionId,
        cwd: stopped.cwd,
        availability: "active",
        runtimeStatus: "idle",
        runtimeEpoch: newRuntimeEpoch(),
        lastActivityAt: later,
      }],
    });
    expect(catalog.getSession(stopped.sessionId)?.catalogState).toBe("archived");
    catalog.close();
  });

  it("persists bounded launch records and rejects immutable ID reuse", () => {
    const { catalog, runtimeNodeId } = fixture();
    const launchId = newLaunchId();
    const request = {
      launchId,
      payloadHash: "launch-v4-payload".padEnd(32, "0"),
      sessionId: newSessionId(),
      runtimeNodeId,
      profile: {
        profileId: "workspace",
        providerId: "core.direct",
        contractVersion: 1,
        requestSchemaHash: "a".repeat(64),
      },
      harness: "codex" as const,
      input: { cwd: "/work/project" },
    };
    const record: LaunchRecord = {
      ...request,
      implementationVersion: "1.0.0",
      state: "accepted",
      createdAt: first,
      updatedAt: first,
    };
    expect(catalog.recordLaunch(record)).toEqual(record);
    expect(catalog.listLaunches({ limit: 1 }).launches).toEqual([record]);
    expect(() => catalog.recordLaunch({
      ...record,
      input: { cwd: "/different" },
    })).toThrowError(expect.objectContaining<Partial<ControlNodeCoreError>>({
      code: "PAYLOAD_MISMATCH",
    }));
    const competing = { ...record, launchId: newLaunchId(), runtimeNodeId: newRuntimeNodeId() };
    const cursor = catalog.sourceManifest().controlCursor;
    expect(() => catalog.recordLaunch(competing)).toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    expect(catalog.getLaunch(competing.launchId)).toBeNull();
    expect(catalog.sourceManifest().controlCursor).toBe(cursor);
    catalog.close();
  });

  it("keeps local launch admission time while merging progress from independent clocks", () => {
    const { catalog, runtimeNodeId } = fixture();
    const launchId = newLaunchId();
    const request = {
      launchId,
      payloadHash: "launch-v4-clock-fence".padEnd(32, "0"),
      sessionId: newSessionId(),
      runtimeNodeId,
      profile: {
        profileId: "workspace",
        providerId: "core.direct",
        contractVersion: 1,
        requestSchemaHash: "a".repeat(64),
      },
      harness: "codex" as const,
      input: { cwd: "/work/project" },
    };
    const admitted: LaunchRecord = {
      ...request,
      implementationVersion: "1.0.0",
      state: "accepted",
      createdAt: later,
      updatedAt: later,
    };
    catalog.recordLaunch(admitted);

    // A worker clock may be behind this authority. Lifecycle rank advances,
    // while this catalog's admission identity and monotonic update clock stay
    // local to the catalog.
    expect(catalog.recordLaunch({
      ...admitted,
      state: "preparing",
      statusMessage: "preparing workspace",
      createdAt: first,
      updatedAt: first,
    })).toMatchObject({
      state: "preparing",
      createdAt: later,
      updatedAt: later,
    });

    // Even a delayed lower-rank record with a wall clock in the future cannot
    // regress the durable state.
    expect(catalog.recordLaunch({
      ...admitted,
      createdAt: "2037-01-02T06:04:05.000Z",
      updatedAt: "2037-01-02T06:04:05.000Z",
    })).toMatchObject({
      state: "preparing",
      createdAt: later,
      updatedAt: later,
    });

    const terminal = catalog.recordLaunch({
      ...admitted,
      state: "succeeded",
      result: {
        sessionId: request.sessionId,
        adapterScopeId: "codex-catalog-test" as AdapterScopeId,
        vendorSessionId: "native-clock-skew",
        backendId: "codex:catalog-test",
        bindingRevision: 1,
      },
      createdAt: first,
      updatedAt: first,
    });
    expect(terminal).toMatchObject({ state: "succeeded", createdAt: later, updatedAt: later });
    expect(catalog.recordLaunch(admitted)).toEqual(terminal);
    catalog.close();
  });

  it("migrates v3 authority rows in place and rebuilds the metadata index", () => {
    const filename = join(
      mkdtempSync(join(tmpdir(), "agent-multiplex-control-v3-migration-")),
      "catalog.sqlite",
    );
    const initial = new ControlNodeCatalog({ filename, now: () => new Date(first) });
    const runtimeNodeId = newRuntimeNodeId();
    initial.registerRuntimeNode({
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "legacy-runtime",
      allowedRoots: ["/work"],
      harnesses: [],
      launchProfiles: [],
      protocolVersion: 5,
    });
    const [session] = initial.reconcileInventory({
      runtimeNodeId,
      generation: "legacy-inventory",
      complete: true,
      capturedAt: first,
      sessions: [{
        harness: "codex",
        adapterScopeId: "legacy-codex" as AdapterScopeId,
        vendorSessionId: "legacy-native",
        cwd: "/work/project",
        availability: "resumable",
        runtimeStatus: "stopped",
        runtimeEpoch: null,
        lastActivityAt: first,
      }],
    });
    if (!session) throw new Error("legacy migration session missing");
    initial.submitMetadataPatch({
      operationId: newOperationId(),
      sessionId: session.sessionId,
      expectedAuthority: session.metadataAuthority,
      set: { "migration.marker": { version: 3 } },
    });
    const previousFeedId = initial.localControlNode().feedId;
    initial.close();

    // Recreate the exact v3 shape from a valid v4 fixture. This avoids relying
    // on private migration helpers while exercising the public on-disk upgrade.
    const downgrade = new DatabaseSync(filename);
    const rewrite = (
      table: "control_nodes" | "runtime_nodes" | "sessions",
      idColumn: string,
      mutate: (value: Record<string, unknown>) => void,
    ): void => {
      const rows = downgrade.prepare(
        `SELECT ${idColumn} AS id, record_json FROM ${table}`,
      ).all() as Array<Record<string, unknown>>;
      const update = downgrade.prepare(
        `UPDATE ${table} SET record_json=? WHERE ${idColumn}=?`,
      );
      for (const row of rows) {
        const value = JSON.parse(String(row.record_json)) as Record<string, unknown>;
        mutate(value);
        update.run(JSON.stringify(value), row.id as string);
      }
    };
    rewrite("control_nodes", "control_node_id", (value) => {
      value.protocolVersion = 3;
    });
    rewrite("runtime_nodes", "runtime_node_id", (value) => {
      value.protocolVersion = 3;
      delete value.launchProfiles;
    });
    rewrite("sessions", "session_id", (value) => {
      delete value.catalogState;
      delete value.catalogRevision;
      delete value.archivedAt;
      delete value.lastActivityAt;
      delete value.launchProvenance;
    });
    downgrade.exec(`
      DROP INDEX sessions_catalog_activity;
      DROP INDEX sessions_runtime_catalog;
      DROP INDEX sessions_launch_profile;
      DROP TABLE session_metadata_index;
      DROP TABLE launch_operations;
      DROP TABLE archive_operations;
      ALTER TABLE sessions DROP COLUMN catalog_state;
      ALTER TABLE sessions DROP COLUMN catalog_revision;
      ALTER TABLE sessions DROP COLUMN archived_at;
      ALTER TABLE sessions DROP COLUMN last_activity_at;
      ALTER TABLE sessions DROP COLUMN provider_id;
      ALTER TABLE sessions DROP COLUMN profile_id;
      DELETE FROM schema_migrations WHERE version>=4;
      PRAGMA user_version=3;
    `);
    downgrade.close();

    const migrated = new ControlNodeCatalog({ filename, now: () => new Date(later) });
    expect(migrated.diagnostics().userVersion).toBe(5);
    expect(migrated.localControlNode()).toMatchObject({ protocolVersion: 5 });
    expect(migrated.localControlNode().feedId).not.toBe(previousFeedId);
    expect(migrated.getRuntimeNode(runtimeNodeId)).toMatchObject({
      protocolVersion: 5,
      launchProfiles: [],
    });
    expect(migrated.getSession(session.sessionId)).toMatchObject({
      catalogState: "open",
      catalogRevision: 1,
      archivedAt: null,
      lastActivityAt: first,
      launchProvenance: null,
    });
    expect(migrated.searchSessions({
      metadata: [{
        operator: "equals",
        key: "migration.marker",
        value: { version: 3 },
      }],
    }).sessions.map(({ sessionId }) => sessionId)).toEqual([session.sessionId]);
    expect(migrated.diagnostics().integrity).toMatchObject({
      quickCheck: ["ok"],
      foreignKeyViolations: [],
    });
    migrated.close();
  });
});


describe("control-node protocol-v5 storage upgrade", () => {
  it("wraps old native receipts exactly once, preserves immutable command input, and rotates the feed", () => {
    const filename = join(mkdtempSync(join(tmpdir(), "multiplex-v5-migration-")), "catalog.sqlite");
    const initial = new ControlNodeCatalog({ filename, now: () => new Date(first) });
    const previousFeed = initial.localControlNode().feedId;
    const runtimeNodeId = newRuntimeNodeId();
    const sessionId = newSessionId();
    const commandId = newCommandId();
    const interactionId = newInteractionId();
    initial.close();
    const legacy = new DatabaseSync(filename);
    // Model the released v4 wire values inside a valid v4 ledger. The request
    // includes an encoding-looking object to prove migration is not coercion.
    const request = { harness: "codex", command: { type: "send", input: "hello" } };
    const nativeResult = { encoding: "native-json-images-v1", json: { native: true }, images: [] };
    const command = {
      commandId, payloadHash: "unchanged-command-hash", sessionId, runtimeNodeId,
      state: "succeeded", request, result: nativeResult, createdAt: first, updatedAt: first,
    };
    const interaction = {
      interactionId, sessionId, harness: "codex", runtimeEpoch: newRuntimeEpoch(),
      requestType: "approval", payload: { command: "echo hello" }, resolution: { approved: true },
      ephemeral: false, state: "resolved", createdAt: first, expiresAt: null, resolvedAt: first,
    };
    legacy.prepare("INSERT INTO commands(command_id,payload_hash,state,updated_at,record_json) VALUES(?,?,?,?,?)")
      .run(commandId, command.payloadHash, command.state, first, JSON.stringify(command));
    legacy.prepare("INSERT INTO interactions(interaction_id,session_id,state,created_at,record_json) VALUES(?,?,?,?,?)")
      .run(interactionId, sessionId, interaction.state, first, JSON.stringify(interaction));
    legacy.exec("DELETE FROM schema_migrations WHERE version=5; PRAGMA user_version=4;");
    legacy.close();
    const upgraded = new ControlNodeCatalog({ filename, now: () => new Date(later) });
    expect(upgraded.diagnostics().userVersion).toBe(5);
    expect(upgraded.localControlNode().feedId).not.toBe(previousFeed);
    expect(upgraded.getCommand(commandId)).toEqual({ ...command, result: packNativePayload(nativeResult) });
    expect(upgraded.getInteraction(interactionId)).toEqual({
      ...interaction, payload: packNativePayload(interaction.payload), resolution: packNativePayload(interaction.resolution),
    });
    const migratedFeed = upgraded.localControlNode().feedId;
    upgraded.close();
    const reopened = new ControlNodeCatalog({ filename, now: () => new Date(later) });
    expect(reopened.localControlNode().feedId).toBe(migratedFeed);
    expect(reopened.getCommand(commandId)?.result).toEqual(packNativePayload(nativeResult));
    reopened.close();
  });

  it("refuses oversized legacy receipts atomically without rewriting their immutable bytes", () => {
    const filename = join(mkdtempSync(join(tmpdir(), "multiplex-v5-incompatible-")), "catalog.sqlite");
    const initial = new ControlNodeCatalog({ filename, now: () => new Date(first) });
    const previousFeed = initial.localControlNode().feedId;
    initial.close();
    const legacy = new DatabaseSync(filename);
    const commandId = newCommandId();
    const sessionId = newSessionId();
    const command = JSON.stringify({
      commandId, payloadHash: "unchanged-command-hash", sessionId, runtimeNodeId: newRuntimeNodeId(),
      state: "succeeded", request: { input: "unchanged" }, result: { first: "bounded receipt" },
      createdAt: first, updatedAt: first,
    });
    const interactionId = newInteractionId();
    const interaction = JSON.stringify({
      interactionId, sessionId, harness: "codex", runtimeEpoch: newRuntimeEpoch(),
      requestType: "approval", payload: { native: "x".repeat(1_024 * 1_024) },
      ephemeral: false, state: "pending", createdAt: first, expiresAt: null, resolvedAt: null,
    });
    legacy.prepare("INSERT INTO commands(command_id,payload_hash,state,updated_at,record_json) VALUES(?,?,?,?,?)")
      .run(commandId, "unchanged-command-hash", "succeeded", first, command);
    legacy.prepare("INSERT INTO interactions(interaction_id,session_id,state,created_at,record_json) VALUES(?,?,?,?,?)")
      .run(interactionId, sessionId, "pending", first, interaction);
    legacy.exec("DELETE FROM schema_migrations WHERE version=5; PRAGMA user_version=4;");
    legacy.close();
    expect(() => new ControlNodeCatalog({ filename })).toThrow(/protocol-v5 migration refused.*original database has been preserved/);
    const unchanged = new DatabaseSync(filename);
    expect(unchanged.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 4 });
    expect(unchanged.prepare("SELECT version FROM schema_migrations WHERE version=5").get()).toBeUndefined();
    expect(unchanged.prepare("SELECT record_json FROM commands WHERE command_id=?").get(commandId)?.record_json).toBe(command);
    expect(unchanged.prepare("SELECT record_json FROM interactions WHERE interaction_id=?").get(interactionId)?.record_json).toBe(interaction);
    expect(unchanged.prepare("SELECT feed_id FROM control_node_identity").get()?.feed_id).toBe(previousFeed);
    unchanged.close();
  });

});
