import assert from "node:assert/strict";
import test from "node:test";
import { createElement as h, Fragment } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { RetainedWorkspace } from "../../src/client/index.js";
import type { DraftUploadPort } from "../../src/client/contracts.js";
import { AttachmentOwner } from "../../src/attachments/index.js";
import type { AttachmentController } from "../../src/attachments/contracts.js";
import type { AssetRemote } from "../../src/assets/contracts.js";
import { renderToString } from "react-dom/server";
import type { AttachmentSnapshot } from "../../src/attachments/contracts.js";
import type { SessionSummaryReadPort } from "../../src/chat/contracts.js";
import { Chat, SessionList } from "../../src/chat/index.js";
import { fixture, scope } from "../client/fixture.js";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function capabilities(draft: DraftUploadPort, transfer: AttachmentController) {
  // @ts-expect-error Uploads borrow no original dispatch capability.
  draft.submit({});
  // @ts-expect-error Uploads borrow no history/read entry.
  draft.getSnapshot();
  // @ts-expect-error Transfer consumers cannot inspect constructor context.
  void transfer.entry;
  // @ts-expect-error Transfer consumers cannot acquire the RPC client directly.
  void transfer.remote;
}
void capabilities;
test("same scope cannot substitute another retained draft owner in the actual composer", async () => {
  const f = fixture(),
    other = fixture(),
    a = new RetainedWorkspace(f),
    b = new RetainedWorkspace(other);
  const view = a.view(scope),
    wrong = b.view(scope);
  let transfers = 0;
  const unexpected = async (): Promise<never> => {
    transfers++;
    throw Error("wrong owner transfer");
  };
  const remote: AssetRemote = {
    begin: unexpected,
    status: unexpected,
    abort: unexpected,
    acquire: unexpected,
  };
  const uploads = new AttachmentOwner(wrong.entry, remote, { sendFile: unexpected });
  assert.notEqual(view.entry.owner, uploads.owner);
  assert.equal(uploads.owner, wrong.entry.owner);
  let rendered: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      rendered = create(h(Chat, { view, actions: {}, attachments: uploads }));
    });
    const file = new File(["private"], "draft.txt", { type: "text/plain" });
    await act(async () => {
      rendered!.root
        .findByType("form")
        .props.onDrop({ preventDefault() {}, dataTransfer: { files: [file] } });
    });
    assert.equal(transfers, 0);
    assert.deepEqual(view.entry.getDraft().attachments, []);
    assert.deepEqual(wrong.entry.getDraft().attachments, []);
    const held = wrong.entry.holdDraftPreparation(1);
    await assert.rejects(b.close(), /PENDING_WORK/);
    held();
  } finally {
    if (rendered) await act(async () => rendered!.unmount());
    await uploads.close();
    await a.settled();
    await a.close();
    await b.close();
  }
});

class ReceiverStore<Snapshot> {
  #snapshot: Snapshot;
  readonly listeners = new Set<() => void>();
  subscriptions = 0;
  constructor(snapshot: Snapshot) {
    this.#snapshot = snapshot;
  }
  getSnapshot(): Snapshot {
    return this.#snapshot;
  }
  subscribe(listener: () => void): () => void {
    this.subscriptions++;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  replace(snapshot: Snapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}

test("session summaries and upload controllers support ordinary class receivers without subscription churn", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    view = workspace.view(scope);
  const summary = new ReceiverStore<ReturnType<SessionSummaryReadPort["getSnapshot"]>>(
    view.entry.getSnapshot(),
  );
  const uploads = Object.assign(
    new ReceiverStore<AttachmentSnapshot>({ revision: 0, busy: false, uploads: [] }),
    {
      owner: view.entry.owner,
      async add() {},
      async check() {},
      clear() {},
    },
  ) satisfies AttachmentController;
  const item = { entry: summary };
  const elements = [
    h(SessionList, {
      items: [{ key: "custom", name: "Custom class", view: item }],
      selected: item,
      onSelect() {},
    }),
    h(Chat, { view, actions: {}, attachments: uploads }),
  ];
  const errors: unknown[] = [];
  for (const element of elements) {
    try {
      renderToString(element);
    } catch (error) {
      errors.push(error);
    }
  }
  assert.deepEqual(
    errors,
    [],
    "Both public component boundaries must preserve their borrowed receivers",
  );
  assert.equal(summary.subscriptions + uploads.subscriptions, 0);
  assert.equal(f.observations.opened, 0);
  let rendered: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      rendered = create(h(Fragment, null, ...elements));
    });
    assert.equal(summary.listeners.size, 1);
    assert.equal(uploads.listeners.size, 1);
    const subscriptions = [summary.subscriptions, uploads.subscriptions];
    await act(async () => {
      summary.replace({ ...summary.getSnapshot(), draft: "summary draft" });
      uploads.replace({
        revision: 1,
        busy: true,
        uploads: [
          { id: "pending", name: "class-upload.txt", bytes: 1, state: "uploading", removed: false },
        ],
      });
    });
    const text = JSON.stringify(rendered!.toJSON());
    assert.match(text, /Draft/);
    assert.match(text, /class-upload.txt/);
    assert.deepEqual([summary.subscriptions, uploads.subscriptions], subscriptions);
  } finally {
    if (rendered)
      await act(async () => {
        rendered!.unmount();
      });
    assert.equal(summary.listeners.size + uploads.listeners.size, 0);
    await workspace.settled();
    assert.equal(f.observations.connections.size, 0);
    assert.equal(f.feed.dispatches.length, 0);
    await workspace.close();
  }
});
