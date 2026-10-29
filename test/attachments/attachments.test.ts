import { transferFixture } from "../assets/transfer-fixture.js";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentOwner } from "../../src/attachments/index.js";
import { HostAssetOwner } from "../../src/assets/node.js";
import type { AssetRemote } from "../../src/assets/index.js";
import { FileStore } from "../../src/files/node.js";
import { RetainedWorkspace, type EntrySnapshot } from "../../src/client/index.js";
import { deferred, fixture, receipt, scope, until } from "../client/fixture.js";

async function setup(t: TestContext, attachmentLimits = { maxFiles: 8, maxBytes: 33554432 }) {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-attachments-")),
    store = await FileStore.open({ directory }),
    host = new HostAssetOwner({ store });
  const f = fixture(),
    workspace = new RetainedWorkspace({ ...f, attachmentLimits }),
    view = workspace.view(scope),
    release = view.commit();
  await until(() => view.entry.getSnapshot().freshness === "current");
  const calls = { begin: 0, transfer: 0, status: 0 };
  let lostCommit = false,
    commitBarrier: Promise<void> | undefined,
    commitEntered: (() => void) | undefined;
  const transport = transferFixture(host, scope, {
    async beforeFinalize() {
      calls.transfer++;
      commitEntered?.();
      if (commitBarrier) await commitBarrier;
    },
    afterFinalize() {
      if (lostCommit) throw Error("Lost publication reply");
    },
  });
  const remote: AssetRemote = {
    async begin(input) {
      calls.begin++;
      assert.equal(input.session, scope.session);
      return host.begin(scope, input.file);
    },
    async status(input) {
      calls.status++;
      return host.status(scope, input.id);
    },
    async abort(input) {
      host.abort(scope, input.id, input.token);
    },
    async acquire(input) {
      return { file: input.file, handle: transport.files.share(host.source(scope, input.file)) };
    },
  };
  const uploads = new AttachmentOwner(view.entry, remote, transport.files);
  t.after(async () => {
    await uploads.close();
    release();
    await workspace.settled();
    await workspace.close();
    await host.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    f,
    workspace,
    view,
    store,
    uploads,
    calls,
    loseCommit() {
      lostCommit = true;
    },
    holdCommit(value: Promise<void>) {
      commitBarrier = value;
      const entered = deferred<void>();
      commitEntered = () => entered.resolve();
      return entered.promise;
    },
  };
}
const source = (name = "note.txt", text = "exact bytes") =>
  new File([text], name, { type: "text/plain" });
const message = (snapshot: EntrySnapshot, id: string) => ({
  id,
  kind: "send" as const,
  run: snapshot.state!.run!,
  optimisticText: snapshot.draft,
  payload: {
    text: snapshot.draft,
    attachments: snapshot.attachments.map((file) => ({ id: file.id })),
  },
});
function observed(event: Promise<void>, phase: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Real filesystem publication is not a one-second product latency contract.
    const timer = setTimeout(() => reject(Error(`Attachment fixture timed out: ${phase}`)), 30000);
    void event.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

test("actual scoped upload retains confirmed descriptors across switching and persistence restore; foreign descriptors cannot enter draft", async (t) => {
  const { uploads, view, f, store } = await setup(t);
  await uploads.add([source()]);
  const file = view.entry.getSnapshot().attachments[0]!;
  assert.deepEqual(store.file(scope, file.id), file);
  assert.equal(uploads.getSnapshot().busy, false);
  await view.entry.setDraft("retained text");
  const switched = new RetainedWorkspace({ ...f });
  await switched.restore();
  assert.deepEqual(switched.entry(scope).getSnapshot().attachments, [file]);
  assert.equal(switched.entry(scope).getSnapshot().draft, "retained text");
  await switched.close();
  await assert.rejects(
    view.entry.setAttachments([{ ...file, scope: { ...scope, session: "foreign" } }]),
    /FENCED/,
  );
  assert.deepEqual(view.entry.getSnapshot().attachments, [file]);
});

test("one durable Send captures text plus exact file IDs; new edits survive admission and an unknown receipt never resends", async (t) => {
  const { uploads, view, f } = await setup(t);
  await uploads.add([source()]);
  await view.entry.setDraft("first text");
  const captured = view.entry.getSnapshot(),
    expected = message(captured, "with-files"),
    durable = deferred<void>();
  f.persistence.barrier = durable.promise;
  f.feed.dispatchResult = async () => {
    const saved = [...f.persistence.records.values()][0]!.originals.find(
      (value) => value.command.id === expected.id,
    );
    assert.deepEqual(saved!.command, expected);
    throw Error("Lost Send reply");
  };
  const attached = deferred<void>();
  const unsubscribe = view.entry.subscribe(() => {
    if (view.entry.getSnapshot().attachments.length === 2) attached.resolve();
  });
  const work: Promise<unknown>[] = [];
  try {
    const pending = view.submitDraft(expected);
    work.push(pending);
    assert.equal(f.feed.dispatches.length, 0);
    const edit = view.entry.setDraft("newer text");
    work.push(edit);
    const second = uploads.add([source("second.txt", "new bytes")]);
    work.push(second);
    void second.catch((error) => attached.reject(error));
    await observed(attached.promise, "second immutable file reached the retained draft");
    durable.resolve();
    const original = await pending;
    await original.settled;
    await edit;
    await second;
    assert.deepEqual(
      f.feed.dispatches.map((value) => value.command),
      [expected],
    );
    assert.equal(original.getSnapshot().state, "unknown");
    assert.equal(view.entry.getSnapshot().draft, "newer text");
    assert.equal(view.entry.getSnapshot().attachments.length, 2);
    f.feed.originalResult = receipt("with-files");
    await view.entry.checkOriginal("with-files");
    assert.equal(f.feed.dispatches.length, 1);
    f.feed.dispatchResult = undefined;
    const next = await view.submitDraft(message(view.entry.getSnapshot(), "next-files"));
    assert.equal(view.entry.getSnapshot().draft, "");
    assert.deepEqual(view.entry.getSnapshot().attachments, []);
    await next.settled;
  } finally {
    // A failed observation/assertion must not leave cleanup waiting on this fixture's own gate.
    unsubscribe();
    durable.resolve();
    await Promise.allSettled(work);
  }
});

test("lost upload commit is exact-status-only; pending clear preserves actual transfer custody and confirmed draft limits", async (t) => {
  const { uploads, view, calls, workspace, f, loseCommit, holdCommit } = await setup(t, {
    maxFiles: 1,
    maxBytes: 16,
  });
  loseCommit();
  await assert.rejects(uploads.add([source("one.txt", "hello")]));
  const id = uploads.getSnapshot().uploads[0]!.id;
  assert.deepEqual(view.entry.getSnapshot().attachments, []);
  const firstCheck = uploads.check(id),
    overlappingCheck = uploads.check(id);
  await Promise.all([firstCheck, overlappingCheck]);
  assert.equal(view.entry.getSnapshot().attachments[0]!.id, id);
  assert.deepEqual(calls, { begin: 1, transfer: 1, status: 1 });
  assert.throws(() => uploads.add([source("over.txt", "more")]), /CAPACITY/);
  await view.entry.setAttachments([]);
  const barrier = deferred<void>();
  const entered = holdCommit(barrier.promise);
  const pending = uploads.add([source("removed.txt", "data")]);
  try {
    await observed(entered, "original upload commit entered before its held publication");
    assert.equal(calls.transfer, 2);
    uploads.clear(uploads.getSnapshot().uploads[0]!.id);
    assert.equal(uploads.getSnapshot().busy, true);
    assert.throws(
      () => view.submitDraft(message(view.entry.getSnapshot(), "premature")),
      /PENDING_WORK/,
    );
    await (
      await view.submit({
        id: "stop-during-upload",
        kind: "stop",
        run: null,
        payload: { generation: 1 },
      })
    ).settled;
    assert.equal(f.feed.dispatches.length, 1);
    await assert.rejects(workspace.close(), /PENDING_WORK/);
    barrier.resolve();
    await assert.rejects(pending);
    assert.equal(uploads.getSnapshot().busy, false);
    assert.deepEqual(view.entry.getSnapshot().attachments, []);
  } finally {
    barrier.resolve();
    await Promise.allSettled([pending]);
  }
});
