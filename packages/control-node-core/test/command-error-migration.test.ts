import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { newCommandId, newRuntimeNodeId, newSessionId, safeCommandError } from "@arduano/agent-multiplex-protocol";
import { RuntimeNodeStore } from "../../runtime-node-core/src/store.js";
import { ControlNodeCatalog } from "../src/catalog.js";

const sentinel = "SYNTHETIC_SECRET_SENTINEL_DO_NOT_PERSIST";
const timestamp = "2026-09-22T00:00:00.000Z";

describe("command-error clean-break migration", () => {
  it("sanitizes retained runtime/control receipts identically and rotates the replay feed", () => {
    const directory = mkdtempSync(join(tmpdir(), "multiplex-error-migration-"));
    const runtimeFile = join(directory, "runtime.sqlite");
    const controlFile = join(directory, "control.sqlite");
    const command = { commandId: newCommandId(), sessionId: newSessionId(), runtimeNodeId: newRuntimeNodeId(),
      payloadHash: "migration-payload-hash", state: "failed" as const, request: { synthetic: true },
      error: safeCommandError(undefined, { stage: "native", certainty: "definiteFailure" }),
      createdAt: timestamp, updatedAt: timestamp };
    const runtime = new RuntimeNodeStore(runtimeFile);
    runtime.putCommand(command); runtime.close();
    const control = new ControlNodeCatalog({ filename: controlFile });
    const previousFeed = control.feedCheckpoint().feedId;
    control.acceptCommand(command); control.close();

    for (const [file, table, version] of [[runtimeFile, "command_journal", 5], [controlFile, "commands", 6]] as const) {
      const legacy = new DatabaseSync(file);
      legacy.prepare(`UPDATE ${table} SET record_json=? WHERE command_id=?`).run(
        JSON.stringify({ ...command, error: sentinel }), command.commandId);
      legacy.prepare("DELETE FROM schema_migrations WHERE version>?").run(version);
      legacy.exec(`PRAGMA user_version=${version}`);
      // Simulate the old schema while remaining valid when lifecycle migration
      // is included in this same coordinated maintenance window.
      if (table === "command_journal") legacy.exec("DROP TABLE IF EXISTS lifecycle_state; DROP TABLE IF EXISTS copilot_startup_intent");
      else legacy.exec("DROP TABLE IF EXISTS runtime_lifecycle_cursors");
      legacy.close();
    }

    const upgradedRuntime = new RuntimeNodeStore(runtimeFile);
    const upgradedControl = new ControlNodeCatalog({ filename: controlFile });
    try {
      const receipt = upgradedRuntime.getCommand(command.commandId);
      expect(receipt?.error).toEqual(safeCommandError(undefined, { stage: "recovery",
        certainty: "definiteFailure", diagnosticId: command.commandId }));
      expect(upgradedControl.getCommand(command.commandId)).toEqual(receipt);
      expect(receipt?.request).toEqual(command.request);
      expect(receipt?.payloadHash).toBe(command.payloadHash);
      expect(JSON.stringify(receipt)).not.toContain(sentinel);
      expect(JSON.stringify(upgradedControl.controlEventsAfter(0))).not.toContain(sentinel);
      expect(upgradedControl.feedCheckpoint().feedId).not.toBe(previousFeed);
    } finally {
      upgradedRuntime.close(); upgradedControl.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
