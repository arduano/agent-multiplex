import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Json } from "../../src/protocol/index.js";
import { JournalError, OriginalJournal, OriginalReader } from "../../src/storage/index.js";

const scope = { connection: "c", principal: "p", host: "h", session: "s" };
const other = { ...scope, session: "other" };
function fixture(run: (filename: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "multiplex-checkpoints-"));
  chmodSync(directory, 0o700);
  try {
    run(join(directory, "state.sqlite"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function capacity(error: unknown): boolean {
  return error instanceof JournalError && error.code === "CAPACITY";
}

test("checkpoints discover saved sessions after reopen, without acquiring lifetimes", () =>
  fixture((filename) => {
    let journal = new OriginalJournal({ filename });
    assert.equal(journal.checkpoint(scope), null);
    assert.deepEqual(journal.checkpoints(), []);
    journal.saveCheckpoint(scope, { phase: "stopped", generation: 2, nativeSession: "n" });
    journal.saveCheckpoint(other, { phase: "new" });
    const reader = new OriginalReader(filename);
    assert.deepEqual(reader.checkpoint(scope), {
      generation: 2,
      nativeSession: "n",
      phase: "stopped",
    });
    journal.saveCheckpoint(scope, { phase: "stopped", generation: 3, nativeSession: "n2" });
    assert.deepEqual(reader.checkpoint(scope), {
      generation: 3,
      nativeSession: "n2",
      phase: "stopped",
    });
    reader.close();
    journal.close();
    journal = new OriginalJournal({ filename });
    assert.equal(journal.checkpoints().length, 2);
    assert.deepEqual(journal.checkpoint(scope), {
      generation: 3,
      nativeSession: "n2",
      phase: "stopped",
    });
    journal.close();
  }));

test("snapshot statement refusal rolls settlement back; duplicate receipt cannot restore stale snapshot", () =>
  fixture((filename) => {
    const journal = new OriginalJournal({ filename });
    journal.saveCheckpoint(scope, { phase: "opening" });
    journal.admit(scope, "open", { open: true });
    journal.markDispatched(scope, "open");
    const fault = new DatabaseSync(filename);
    fault.exec(
      "CREATE TRIGGER refuse_snapshot BEFORE UPDATE ON checkpoints BEGIN SELECT RAISE(ABORT,'snapshot write refused'); END",
    );
    assert.throws(
      () =>
        journal.settle(
          scope,
          "open",
          { state: "succeeded", result: { native: "n" } },
          { scope, value: { phase: "ready", native: "n" } },
        ),
      /snapshot write refused/,
    );
    assert.equal(journal.read(scope, "open")!.state, "dispatched");
    assert.deepEqual(journal.checkpoint(scope), { phase: "opening" });
    fault.exec("DROP TRIGGER refuse_snapshot");
    const receipt = journal.settle(
      scope,
      "open",
      { state: "succeeded", result: { native: "n" } },
      { scope, value: { phase: "ready", native: "n" } },
    );
    journal.saveCheckpoint(scope, { phase: "stopped", native: "n" });
    assert.deepEqual(
      journal.settle(
        scope,
        "open",
        { state: "succeeded", result: { native: "n" } },
        { scope, value: { phase: "ready", native: "n" } },
      ),
      receipt,
    );
    assert.deepEqual(journal.checkpoint(scope), { native: "n", phase: "stopped" });
    fault.close();
    journal.close();
    const reader = new OriginalReader(filename);
    assert.deepEqual(reader.read(scope, "open"), receipt);
    assert.deepEqual(reader.checkpoint(scope), { native: "n", phase: "stopped" });
    reader.close();
  }));

test("deferred COMMIT refusal acknowledges neither receipt nor session checkpoint", () =>
  fixture((filename) => {
    const journal = new OriginalJournal({ filename });
    journal.admit(scope, "create", { create: true });
    journal.markDispatched(scope, "create");
    const fault = new DatabaseSync(filename);
    fault.exec(`CREATE TABLE fault_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE fault_child(parent INTEGER REFERENCES fault_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER refuse_commit AFTER INSERT ON checkpoints BEGIN INSERT INTO fault_child VALUES(1); END;`);
    assert.throws(
      () =>
        journal.settle(
          scope,
          "create",
          { state: "succeeded", result: { id: "new" } },
          { scope: other, value: { phase: "ready" } },
        ),
      /FOREIGN KEY constraint failed/,
    );
    assert.equal(journal.read(scope, "create")!.state, "dispatched");
    assert.equal(journal.checkpoint(other), null);
    assert.equal(
      (fault.prepare("SELECT COUNT(*) AS n FROM fault_child").get() as { n: number }).n,
      0,
    );
    fault.exec("DROP TRIGGER refuse_commit; DROP TABLE fault_child; DROP TABLE fault_parent");
    fault.close();
    journal.close();
    const reopened = new OriginalJournal({ filename });
    assert.equal(reopened.read(scope, "create")!.state, "dispatched");
    assert.equal(reopened.checkpoint(other), null);
    const done = reopened.settle(
      scope,
      "create",
      { state: "succeeded", result: { id: "new" } },
      { scope: other, value: { phase: "ready" } },
    );
    assert.equal(done.state, "succeeded");
    assert.deepEqual(reopened.checkpoints(), [{ scope: other, value: { phase: "ready" } }]);
    reopened.close();
  }));

test("checkpoint count/value/total-byte bounds preserve accepted snapshots and pending originals", () =>
  fixture((filename) => {
    const journal = new OriginalJournal({
      filename,
      limits: { maxCheckpointBytes: 16, maxCheckpointTotalBytes: 64, maxCheckpoints: 1 },
    });
    journal.saveCheckpoint(scope, { x: 1 });
    journal.saveCheckpoint(scope, { x: 2 });
    assert.throws(() => journal.saveCheckpoint(other, null), capacity);
    assert.throws(() => journal.saveCheckpoint(scope, "more than sixteen bytes"), RangeError);
    let invoked = false;
    const getter = Object.defineProperty({}, "x", {
      enumerable: true,
      get() {
        invoked = true;
        return 1;
      },
    });
    assert.throws(() => journal.saveCheckpoint(scope, getter as Json), TypeError);
    assert.equal(invoked, false);
    const hugeScope = { ...scope, session: "long".repeat(30) };
    journal.admit(scope, "kept", null);
    journal.markDispatched(scope, "kept");
    assert.throws(
      () =>
        journal.settle(
          scope,
          "kept",
          { state: "succeeded", result: null },
          { scope: hugeScope, value: null },
        ),
      capacity,
    );
    assert.equal(journal.read(scope, "kept")!.state, "dispatched");
    assert.deepEqual(journal.checkpoint(scope), { x: 2 });
    journal.close();
    const bytes = new OriginalJournal({
      filename,
      limits: { maxCheckpointBytes: 64, maxCheckpointTotalBytes: 30, maxCheckpoints: 2 },
    });
    assert.throws(() => bytes.saveCheckpoint(other, { large: "0123456789" }), capacity);
    assert.equal(bytes.checkpoint(other), null);
    bytes.close();
  }));

test("writer alone appends the v1 checkpoint schema without changing original receipts", () =>
  fixture((filename) => {
    const journal = new OriginalJournal({ filename });
    journal.admit(scope, "retained", { text: "immutable" });
    journal.markDispatched(scope, "retained");
    const original = journal.settle(scope, "retained", {
      state: "succeeded",
      result: { done: true },
    });
    journal.close();
    const fixtureV1 = new DatabaseSync(filename);
    fixtureV1.exec("DROP TABLE checkpoints; PRAGMA user_version=1");
    fixtureV1.close();
    assert.throws(() => new OriginalReader(filename), /requires writer schema upgrade/);
    const upgraded = new OriginalJournal({ filename });
    assert.deepEqual(upgraded.read(scope, "retained"), original);
    assert.deepEqual(upgraded.checkpoints(), []);
    upgraded.saveCheckpoint(scope, { phase: "stopped" });
    upgraded.close();
    const version = new DatabaseSync(filename);
    assert.equal(
      (version.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      2,
    );
    version.close();
    const reader = new OriginalReader(filename);
    assert.deepEqual(reader.read(scope, "retained"), original);
    assert.deepEqual(reader.checkpoint(scope), { phase: "stopped" });
    reader.close();
  }));
