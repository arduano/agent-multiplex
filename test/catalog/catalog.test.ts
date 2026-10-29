import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog } from "../../src/catalog/node.js";
import {
  queryCatalog,
  type CreateRequest,
  type CreationEvidence,
  type HostCreationPort,
} from "../../src/catalog/index.js";
import { OriginalJournal } from "../../src/storage/index.js";
const scope = { connection: "connection", principal: "owner", host: "host", session: "session" };
const original: CreateRequest = {
  scope,
  id: "create",
  target: {
    owner: "owner-id",
    nativeKind: "future-family",
    contractId: "contract",
    contractVersion: 1,
  },
  name: "Conversation",
  workspace: { cwd: "/workspace" },
  selection: { model: "fixture-model" },
  data: null,
};
const binding = { scope, generation: 1, nativeSession: "native-id" };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
function fixture(port: HostCreationPort) {
  const directory = mkdtempSync(join(tmpdir(), "multiplex-catalog-"));
  const journal = new OriginalJournal({ filename: join(directory, "root.sqlite") });
  const catalog = new Catalog({ authority: "root", journal, host: () => port });
  return {
    catalog,
    journal,
    directory,
    close() {
      catalog.close();
      journal.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("lost Host Create reply reconciles its exact original after Root restart without replay", async () => {
  let creates = 0,
    reads = 0;
  const port: HostCreationPort = {
    async create(request) {
      creates++;
      assert.deepEqual(request, original);
      throw Error("reply lost");
    },
    async read(request) {
      reads++;
      assert.deepEqual(request, original);
      return { state: "created", binding };
    },
    async readArchive() {
      return false;
    },
  };
  const f = fixture(port);
  try {
    assert.equal((await f.catalog.create(original)).state, "unknown");
    assert.equal((await f.catalog.create(original)).state, "unknown");
    assert.equal(creates, 1);
    f.catalog.close();
    f.journal.close();
    const journal = new OriginalJournal({ filename: join(f.directory, "root.sqlite") });
    const restored = new Catalog({ authority: "root", journal, host: () => port });
    try {
      assert.equal((await restored.reconcile(scope)).state, "succeeded");
      assert.equal(creates, 1);
      assert.equal(reads, 1);
      assert.deepEqual(restored.get(scope)?.binding, binding);
    } finally {
      restored.close();
      journal.close();
    }
  } finally {
    f.catalog.close();
    f.journal.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
test("pending create retains work; late evidence preserves current metadata and terminal truth", async () => {
  const pending = deferred<CreationEvidence>(),
    read = deferred<CreationEvidence>();
  const f = fixture({
    create: () => pending.promise,
    read: () => read.promise,
    async readArchive() {
      return false;
    },
  });
  try {
    const creating = f.catalog.create(original),
      reconciling = f.catalog.reconcile(scope);
    assert.throws(() => f.catalog.close(), /retains/);
    const revision = f.catalog.get(scope)!.revision;
    assert.equal(
      f.catalog.patch(scope, "rename", revision, { name: "Renamed" }).state,
      "succeeded",
    );
    read.resolve({ state: "created", binding });
    await reconciling;
    pending.resolve({ state: "unknown" });
    assert.equal((await creating).state, "succeeded");
    assert.equal(f.catalog.get(scope)?.name, "Renamed");
    assert.equal(f.catalog.get(scope)?.creation, "created");
  } finally {
    pending.resolve({ state: "unknown" });
    read.resolve({ state: "unknown" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.close();
  }
});
test("metadata CAS and immutable originals survive further revisions, isolate principals and never stop agents", async () => {
  const f = fixture({
    async create() {
      return { state: "created", binding };
    },
    async read() {
      throw Error("unexpected");
    },
    async readArchive() {
      return false;
    },
  });
  try {
    await f.catalog.create(original);
    const revision = f.catalog.get(scope)!.revision;
    const first = f.catalog.patch(scope, "first", revision, { name: "One", watched: true });
    const second = f.catalog.patch(scope, "second", revision + 1, { name: "Two" });
    assert.equal(second.state, "succeeded");
    assert.deepEqual(
      f.catalog.patch(scope, "first", revision, { name: "One", watched: true }),
      first,
    );
    assert.equal(f.catalog.patch(scope, "stale", revision, { name: "Wrong" }).state, "refused");
    assert.equal(f.catalog.get(scope)?.name, "Two");
    assert.equal(f.catalog.list({ connection: scope.connection, principal: "other" }).length, 0);
    assert.equal(
      (await f.catalog.publishArchive(scope, "publish", "host-archive", 1)).state,
      "unknown",
    );
    assert.equal(f.catalog.get(scope)?.archived, false);
    assert.throws(() => f.catalog.create({ ...original, selection: { model: "different" } }), {
      code: "CONFLICT",
    });
  } finally {
    f.close();
  }
});
test("catalog distinguishes positive refusal, opaque future families and pinned absence", async () => {
  const f = fixture({
    async create() {
      return { state: "refused" };
    },
    async read() {
      throw Error("must not retry");
    },
    async readArchive() {
      return false;
    },
  });
  try {
    assert.equal((await f.catalog.create(original)).state, "refused");
    assert.equal(f.catalog.get(scope)?.creation, "refused");
    const key = JSON.stringify([scope.host, scope.session]);
    const listing = queryCatalog(
      f.catalog.list(scope),
      { nativeKind: "future-family", pinnedOnly: true },
      [key, "unobserved"],
    );
    assert.equal(listing.rows.length, 1);
    assert.deepEqual(listing.unobservedPinned, ["unobserved"]);
    assert.throws(
      () =>
        new Catalog({
          authority: "root",
          journal: f.journal,
          host: () => {
            throw Error();
          },
        }),
      /already owned/,
    );
  } finally {
    f.close();
  }
});

test("Root interruption before dispatch can refuse its reservation without contacting any Host", async () => {
  const f = fixture({
    async create() {
      throw Error("must not send");
    },
    async read() {
      throw Error("must not inspect undispatched original");
    },
    async readArchive() {
      return false;
    },
  });
  try {
    f.journal.markDispatched = () => {
      assert.equal(f.journal.read(scope, original.id)?.state, "admitted");
      assert.equal(
        (f.journal.checkpoint(scope) as { original: CreateRequest }).original.id,
        original.id,
      );
      throw Error("process interrupted after atomic admission, before dispatch");
    };
    assert.throws(() => f.catalog.create(original), /interrupted/);
    f.catalog.close();
    f.journal.close();
    const journal = new OriginalJournal({ filename: join(f.directory, "root.sqlite") });
    const restored = new Catalog({
      authority: "root",
      journal,
      host() {
        assert.fail("undispatched original has no Host effect");
      },
    });
    try {
      assert.equal((await restored.reconcile(scope)).state, "refused");
      assert.equal(restored.get(scope)?.creation, "refused");
      assert.equal((await restored.create(original)).state, "refused");
    } finally {
      restored.close();
      journal.close();
    }
  } finally {
    f.catalog.close();
    f.journal.close();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("reservation admission bounds reject both original and checkpoint before any Host effect", () => {
  const directory = mkdtempSync(join(tmpdir(), "multiplex-catalog-bounds-"));
  const journal = new OriginalJournal({
    filename: join(directory, "root.sqlite"),
    limits: { maxCheckpointBytes: 128 },
  });
  const catalog = new Catalog({
    authority: "root",
    journal,
    host() {
      assert.fail("invalid reservation cannot contact Host");
    },
  });
  try {
    assert.throws(() => catalog.create(original));
    assert.equal(journal.read(scope, original.id), null);
    assert.equal(journal.checkpoint(scope), null);
    assert.equal(catalog.get(scope), null);
  } finally {
    catalog.close();
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Create observers see dispatched retained work and cannot refuse or close it before dispatch", async () => {
  const pending = deferred<CreationEvidence>();
  let creates = 0,
    observed = 0;
  const f = fixture({
    async create() {
      creates++;
      return pending.promise;
    },
    async read() {
      return { state: "unknown" };
    },
    async readArchive() {
      return false;
    },
  });
  let reconciling: Promise<unknown> | undefined,
    observedState: string | undefined,
    closeError: unknown;
  const detach = f.catalog.subscribe(() => {
    if (observed++) return;
    observedState = f.catalog.original(scope, original.id)?.state;
    try {
      f.catalog.close();
    } catch (error) {
      closeError = error;
    }
    reconciling = f.catalog.reconcile(scope);
  });
  try {
    const creating = f.catalog.create(original);
    assert.equal(observedState, "dispatched");
    assert.match(String(closeError), /retains/);
    assert.ok(reconciling);
    pending.resolve({ state: "created", binding });
    assert.equal((await creating).state, "succeeded");
    await reconciling;
    assert.equal(creates, 1);
    assert.equal(f.catalog.get(scope)?.creation, "created");
  } finally {
    detach();
    pending.resolve({ state: "unknown" });
    await reconciling;
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.close();
  }
});

test("Archive lost replies reconcile the retained Host original across restart without Create or Archive replay and preserve CAS metadata", async () => {
  let creates = 0,
    reads = 0,
    archiveReads = 0;
  const proof = deferred<boolean>();
  const port: HostCreationPort = {
    async create() {
      creates++;
      return { state: "created", binding };
    },
    async read() {
      reads++;
      throw Error("Archive reconciliation must not read Create");
    },
    async readArchive(actualScope, hostOriginalId, generation) {
      archiveReads++;
      assert.deepEqual(actualScope, scope);
      assert.equal(hostOriginalId, "host-archive");
      assert.equal(generation, 7);
      if (archiveReads === 1) throw Error("Archive receipt reply lost");
      return proof.promise;
    },
  };
  const f = fixture(port);
  try {
    await f.catalog.create(original);
    assert.equal(
      (await f.catalog.publishArchive(scope, "publish", "host-archive", 7)).state,
      "unknown",
    );
    assert.equal(f.catalog.get(scope)?.archived, false);
    assert.equal(
      (await f.catalog.publishArchive(scope, "publish", "host-archive", 7)).state,
      "unknown",
    );
    assert.equal(archiveReads, 1);
    assert.throws(() => f.catalog.publishArchive(scope, "publish", "another-archive", 7), {
      code: "CONFLICT",
    });
    f.catalog.close();
    f.journal.close();
    const journal = new OriginalJournal({ filename: join(f.directory, "root.sqlite") });
    const restored = new Catalog({ authority: "root", journal, host: () => port });
    try {
      const callerScope = { ...scope },
        reconciling = restored.reconcileArchive(callerScope, "publish");
      callerScope.session = "foreign-after-admission";
      assert.equal(
        restored.reconcileArchive(scope, "publish"),
        reconciling,
        "simultaneous checks share one exact read",
      );
      assert.throws(() => restored.close(), /retains/);
      const revision = restored.get(scope)!.revision;
      assert.equal(
        restored.patch(scope, "rename-after-archive", revision, { name: "Current name" }).state,
        "succeeded",
      );
      assert.equal(
        restored.patch(scope, "stale-after-archive", revision, { name: "Stale name" }).state,
        "refused",
      );
      proof.resolve(true);
      const settled = await reconciling;
      assert.equal(settled.state, "succeeded");
      assert.equal(restored.get(scope)?.archived, true);
      assert.equal(restored.get(scope)?.name, "Current name");
      assert.deepEqual(await restored.reconcileArchive(scope, "publish"), settled);
      assert.equal(archiveReads, 2);
      assert.equal(creates, 1);
      assert.equal(reads, 0);
    } finally {
      proof.resolve(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      restored.close();
      journal.close();
    }
  } finally {
    proof.resolve(true);
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test("Archive reconciliation rejects an unresolved Create identity rather than consulting its Host", async () => {
  let archiveReads = 0;
  const f = fixture({
    async create() {
      return { state: "unknown" };
    },
    async read() {
      throw Error("must not read Create");
    },
    async readArchive() {
      archiveReads++;
      return true;
    },
  });
  try {
    await f.catalog.create(original);
    assert.throws(() => f.catalog.reconcileArchive(scope, original.id));
    assert.equal(f.catalog.original(scope, original.id)?.state, "unknown");
    assert.equal(archiveReads, 0);
  } finally {
    f.close();
  }
});

test("bounded large metadata lives in its checkpoint rather than overflowing immutable operation receipts", async () => {
  const firstData = "a".repeat(20 * 1024),
    nextData = "b".repeat(20 * 1024);
  const f = fixture({
    async create() {
      return { state: "created", binding };
    },
    async read() {
      throw Error("positive Create needs no reconciliation");
    },
    async readArchive() {
      return true;
    },
  });
  try {
    const request = { ...original, data: { detail: firstData } },
      created = await f.catalog.create(request);
    assert.equal(created.state, "succeeded");
    assert.deepEqual(created.result, { revision: 2, binding });
    const patched = f.catalog.patch(scope, "large-metadata", 2, { data: { detail: nextData } });
    assert.equal(patched.state, "succeeded");
    assert.deepEqual(patched.result, { revision: 3 });
    const archived = await f.catalog.publishArchive(scope, "archive-large", "host-archive", 1);
    assert.equal(archived.state, "succeeded");
    assert.deepEqual(archived.result, { revision: 4, archived: true });
    assert.deepEqual(f.catalog.get(scope)?.data, { detail: nextData });
    assert.deepEqual(await f.catalog.create(request), created);
    assert.deepEqual(
      f.catalog.patch(scope, "large-metadata", 2, { data: { detail: nextData } }),
      patched,
    );
    assert.deepEqual(
      await f.catalog.publishArchive(scope, "archive-large", "host-archive", 1),
      archived,
    );
  } finally {
    f.close();
  }
});
