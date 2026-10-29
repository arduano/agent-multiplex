import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { canonicalJson, cloneJson, type Json } from "../../src/protocol/index.js";
import { JournalError, OriginalJournal, OriginalReader } from "../../src/storage/index.js";

const scope = { connection: "c", principal: "owner", host: "h", session: "s" };
function fixture(run: (filename: string, directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "multiplex-originals-"));
  chmodSync(directory, 0o700);
  try {
    run(join(directory, "originals.sqlite"), directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
function code(expected: JournalError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof JournalError && error.code === expected;
}

test("canonical data has one meaning and never invokes accessors", () => {
  assert.deepEqual(canonicalJson({ b: [1, "😀"], a: -0 }, 100), {
    json: '{"a":0,"b":[1,"😀"]}',
    bytes: 22,
  });
  assert.deepEqual(cloneJson({ b: 2, a: 1 }, 100), { a: 1, b: 2 });
  let invoked = false;
  const accessor = Object.defineProperty({}, "x", {
    enumerable: true,
    get() {
      invoked = true;
      return 1;
    },
  });
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  for (const value of [
    accessor,
    new Date(),
    NaN,
    [undefined],
    new Array(2),
    cycle,
    Object.create({ x: 1 }),
    { x: undefined },
  ]) {
    assert.throws(() => canonicalJson(value as Json, 100));
  }
  assert.equal(invoked, false);
  assert.throws(() => canonicalJson("😀", 5), RangeError);
  assert.equal(canonicalJson("😀", 6).bytes, 6);
});

test("original meaning and terminal receipt survive reopen, without renewed dispatch", () =>
  fixture((filename) => {
    let journal = new OriginalJournal({ filename });
    const first = journal.admit(scope, "send", { text: "hello", settings: { b: 2, a: 1 } });
    assert.equal(first.fresh, true);
    assert.deepEqual(journal.admit(scope, "send", { settings: { a: 1, b: 2 }, text: "hello" }), {
      fresh: false,
      receipt: first.receipt,
    });
    assert.throws(() => journal.admit(scope, "send", { text: "different" }), code("CONFLICT"));
    assert.throws(
      () =>
        journal.admit(
          scope,
          "send",
          { text: "hello", settings: { b: 2, a: 1 } },
          { priority: "stop" },
        ),
      code("CONFLICT"),
    );
    assert.throws(
      () => journal.settle(scope, "send", { state: "succeeded", result: null }),
      code("INVALID_TRANSITION"),
    );
    assert.equal(journal.markDispatched(scope, "send").fresh, true);
    journal.close();
    journal = new OriginalJournal({ filename });
    assert.equal(journal.markDispatched(scope, "send").fresh, false);
    assert.equal(journal.read(scope, "send")!.state, "dispatched");
    const unknown = journal.settle(scope, "send", { state: "unknown" });
    assert.deepEqual(journal.settle(scope, "send", { state: "unknown" }), unknown);
    const done = journal.settle(scope, "send", {
      state: "succeeded",
      result: { native: "receipt" },
    });
    assert.equal(journal.request(scope, "send"), null);
    journal.close();
    journal = new OriginalJournal({ filename });
    assert.deepEqual(journal.read(scope, "send"), done);
    assert.equal(
      journal.admit(scope, "send", { settings: { a: 1, b: 2 }, text: "hello" }).fresh,
      false,
    );
    assert.deepEqual(
      journal.settle(scope, "send", { state: "succeeded", result: { native: "receipt" } }),
      done,
    );
    assert.throws(
      () => journal.settle(scope, "send", { state: "refused", result: null }),
      code("CONFLICT"),
    );
    assert.equal(journal.read({ ...scope, principal: "other" }, "send"), null);
    journal.close();
    journal.close();
    assert.throws(() => journal.read(scope, "send"), code("CLOSED"));
  }));

test("actual killed writer leaves durable dispatch and releases only its OS ownership", () =>
  fixture((filename) => {
    const module = new URL("../../src/storage/index.js", import.meta.url).href;
    const script = `import {writeSync} from "node:fs";const started=performance.now();const phase=name=>writeSync(1,JSON.stringify({phase:name,elapsedMs:performance.now()-started})+"\\n");phase("started");const {OriginalJournal}=await import(${JSON.stringify(module)});phase("imported");const journal=new OriginalJournal({filename:${JSON.stringify(filename)}});phase("opened");journal.admit(${JSON.stringify(scope)},"crash",{text:"once"});phase("admitted");journal.markDispatched(${JSON.stringify(scope)},"crash");phase("dispatched");process.kill(process.pid,"SIGKILL");`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      // This bounds child startup/import plus real fsyncs, not a product response-time promise.
      timeout: 30000,
      killSignal: "SIGKILL",
    });
    assert.equal(
      child.error,
      undefined,
      `Writer phases before failure: ${child.stdout}; ${child.stderr}`,
    );
    assert.equal(child.signal, "SIGKILL", child.stderr);
    const phases = child.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { phase: string; elapsedMs: number });
    assert.deepEqual(
      phases.map((value) => value.phase),
      ["started", "imported", "opened", "admitted", "dispatched"],
    );
    assert(
      phases.every(
        (value, index) =>
          Number.isFinite(value.elapsedMs) &&
          value.elapsedMs >= (phases[index - 1]?.elapsedMs ?? 0),
      ),
    );
    const journal = new OriginalJournal({ filename });
    assert.equal(journal.read(scope, "crash")!.state, "dispatched");
    assert.equal(journal.markDispatched(scope, "crash").fresh, false);
    assert.deepEqual(journal.request(scope, "crash"), { text: "once" });
    journal.close();
  }));

test("one writer, independent readonly reconciliation, explicit close", () =>
  fixture((filename, directory) => {
    const journal = new OriginalJournal({ filename });
    journal.admit(scope, "pending", null);
    journal.markDispatched(scope, "pending");
    assert.throws(() => new OriginalJournal({ filename }), /locked/);
    const reader = new OriginalReader(filename);
    assert.equal(reader.read(scope, "pending")!.state, "dispatched");
    journal.settle(scope, "pending", { state: "unknown" });
    assert.equal(reader.read(scope, "pending")!.state, "unknown");
    assert.equal(reader.unresolved(scope).length, 1);
    reader.close();
    journal.close();
    const reopened = new OriginalJournal({ filename });
    reopened.close();
    assert.ok(readdirSync(directory).includes("originals.sqlite.writer.sqlite"));
  }));

test("unknown retains pending capacity; terminal IDs and Stop reserve have independent bounds", () =>
  fixture((filename) => {
    const journal = new OriginalJournal({
      filename,
      limits: {
        maxPending: 1,
        maxPendingBytes: 32,
        maxRequestBytes: 32,
        maxResultBytes: 32,
        maxRetainedBytes: 16_384,
        reservedStops: 1,
      },
    });
    journal.admit(scope, "normal", { a: 1 });
    journal.markDispatched(scope, "normal");
    journal.settle(scope, "normal", { state: "unknown" });
    assert.throws(() => journal.admit(scope, "next", null), code("CAPACITY"));
    journal.admit(scope, "stop", { stop: true }, { priority: "stop" });
    assert.throws(
      () => journal.admit(scope, "stop2", null, { priority: "stop" }),
      code("CAPACITY"),
    );
    journal.settle(scope, "normal", { state: "succeeded", result: "ok" });
    journal.admit(scope, "next", null);
    assert.equal(journal.admit(scope, "normal", { a: 1 }).fresh, false);
    journal.settle(scope, "next", { state: "refused", result: null });
    let filled = false;
    for (let i = 0; i < 100; i++) {
      try {
        journal.admit(scope, `terminal${i}`, null);
        journal.settle(scope, `terminal${i}`, { state: "refused", result: null });
      } catch (error) {
        assert.ok(code("CAPACITY")(error));
        filled = true;
        break;
      }
    }
    assert.equal(filled, true, "retained terminal identity quota must not be silently evicted");
    journal.markDispatched(scope, "stop");
    assert.equal(
      journal.settle(scope, "stop", { state: "succeeded", result: "stopped" }).state,
      "succeeded",
    );
    journal.close();
  }));

test("byte admission and result reservation reject before acknowledgement", () =>
  fixture((filename) => {
    const journal = new OriginalJournal({
      filename,
      limits: { maxPendingBytes: 8, maxRequestBytes: 32, maxResultBytes: 8 },
    });
    assert.throws(() => journal.admit(scope, "big", "1234567"), code("CAPACITY"));
    assert.equal(journal.read(scope, "big"), null);
    journal.admit(scope, "small", null);
    journal.markDispatched(scope, "small");
    assert.throws(
      () => journal.settle(scope, "small", { state: "succeeded", result: "1234567" }),
      RangeError,
    );
    assert.equal(journal.read(scope, "small")!.state, "dispatched");
    assert.equal(
      journal.settle(scope, "small", { state: "succeeded", result: "123456" }).state,
      "succeeded",
    );
    journal.close();
  }));

test("SQLite write refusal produces no admission or state acknowledgement", () =>
  fixture((filename) => {
    const journal = new OriginalJournal({ filename });
    const fault = new DatabaseSync(filename);
    fault.exec(
      "CREATE TRIGGER refuse_admission BEFORE INSERT ON originals BEGIN SELECT RAISE(ABORT,'scripted write failure'); END",
    );
    assert.throws(() => journal.admit(scope, "failed", null), /scripted write failure/);
    assert.equal(journal.read(scope, "failed"), null);
    fault.exec("DROP TRIGGER refuse_admission");
    fault.exec(`CREATE TABLE fault_parent(id INTEGER PRIMARY KEY);
    CREATE TABLE fault_child(parent INTEGER REFERENCES fault_parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER refuse_commit AFTER INSERT ON originals BEGIN INSERT INTO fault_child VALUES(1); END;`);
    assert.throws(() => journal.admit(scope, "uncommitted", null), /FOREIGN KEY constraint failed/);
    assert.equal(journal.read(scope, "uncommitted"), null);
    assert.equal(
      (fault.prepare("SELECT COUNT(*) AS n FROM fault_child").get() as { n: number }).n,
      0,
    );
    fault.exec("DROP TRIGGER refuse_commit; DROP TABLE fault_child; DROP TABLE fault_parent");
    journal.admit(scope, "kept", null);
    fault.exec(
      "CREATE TRIGGER refuse_dispatch BEFORE UPDATE ON originals BEGIN SELECT RAISE(ABORT,'scripted write failure'); END",
    );
    assert.throws(() => journal.markDispatched(scope, "kept"), /scripted write failure/);
    assert.equal(journal.read(scope, "kept")!.state, "admitted");
    fault.exec("DROP TRIGGER refuse_dispatch");
    fault.close();
    journal.close();
    const reopened = new OriginalJournal({ filename });
    assert.equal(reopened.read(scope, "failed"), null);
    assert.equal(reopened.markDispatched(scope, "kept").fresh, true);
    reopened.close();
  }));

test("private path and foreign schema fail closed without adopting state", () =>
  fixture((filename, directory) => {
    chmodSync(directory, 0o755);
    assert.throws(() => new OriginalJournal({ filename }), /not private/);
    chmodSync(directory, 0o700);
    const foreign = new DatabaseSync(filename);
    foreign.exec("CREATE TABLE foreign_data(value TEXT)");
    foreign.close();
    chmodSync(filename, 0o600);
    assert.throws(() => new OriginalJournal({ filename }), /unrecognized/);
    const inspect = new DatabaseSync(filename);
    assert.equal(
      (inspect.prepare("SELECT COUNT(*) AS n FROM foreign_data").get() as { n: number }).n,
      0,
    );
    inspect.close();
    symlinkSync(filename, join(directory, "link.sqlite"));
    assert.throws(() => new OriginalReader(join(directory, "link.sqlite")));
  }));
