import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement as h, StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { RetainedWorkspace, type SessionView } from "../../src/client/index.js";
import { useSessionView, useViewAnchor, useTranscriptView } from "../../src/react/index.js";
import type {
  AnchorSnapshot,
  EntrySnapshot,
  TranscriptSnapshot,
  TranscriptViewPort,
} from "../../src/client/contracts.js";
import { fixture, scope } from "../client/fixture.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function Consumer({ view }: { view: SessionView }) {
  const state = useSessionView(view);
  return h("p", null, state.draft || state.freshness);
}

test("actual React SSR is inert; committed StrictMode leases share retained owners and cleanup without native effects", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    view = workspace.view(scope);
  assert.match(renderToString(h(Consumer, { view })), /unobserved/);
  assert.equal(f.observations.opened, 0);
  assert.equal(f.persistence.loads + f.persistence.saves, 0);
  let rendered!: ReactTestRenderer;
  await act(async () => {
    rendered = create(h(StrictMode, null, h(Consumer, { view })));
  });
  assert.equal(f.observations.connections.size, 3);
  await act(async () => {
    await view.entry.setDraft("retained");
  });
  assert.match(JSON.stringify(rendered.toJSON()), /retained/);
  await act(async () => {
    rendered.update(h(StrictMode, null, h(Consumer, { view })));
  });
  assert.equal(f.observations.connections.size, 3);
  await act(async () => {
    rendered.unmount();
  });
  await workspace.settled();
  assert.equal(f.observations.connections.size, 0);
  assert.equal(f.feed.dispatches.length + f.feed.baselineReads + f.feed.olderReads, 0);
  await workspace.close();
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

test("structural class ports preserve distinct receivers and stable subscriptions in all React store hooks", async () => {
  const f = fixture(),
    workspace = new RetainedWorkspace(f),
    prepared = workspace.view(scope);
  const entry = Object.assign(new ReceiverStore<EntrySnapshot>(prepared.entry.getSnapshot()), {
    scope: prepared.entry.scope,
    owner: prepared.entry.owner,
    getDraft: () => prepared.entry.getDraft(),
    setDraft: (text: string) => prepared.entry.setDraft(text),
    checkOriginal: prepared.entry.checkOriginal.bind(prepared.entry),
    pin: prepared.entry.pin.bind(prepared.entry),
    submit: prepared.entry.submit.bind(prepared.entry),
  });
  const anchor = Object.assign(new ReceiverStore<AnchorSnapshot>(prepared.anchor.getSnapshot()), {
    captureGeometry: prepared.anchor.captureGeometry.bind(prepared.anchor),
    gesture: prepared.anchor.gesture.bind(prepared.anchor),
    observed: prepared.anchor.observed.bind(prepared.anchor),
    read: prepared.anchor.read.bind(prepared.anchor),
    followLatest: prepared.anchor.followLatest.bind(prepared.anchor),
    captureFollow: prepared.anchor.captureFollow.bind(prepared.anchor),
  });
  let leases = 0;
  const commit = () => {
    leases++;
    return () => {
      leases--;
    };
  };
  const transcript = Object.assign(
    new ReceiverStore<TranscriptSnapshot>(prepared.transcript.getSnapshot()),
    {
      anchor,
      commit,
      baseline: prepared.transcript.baseline.bind(prepared.transcript),
      older: prepared.transcript.older.bind(prepared.transcript),
    },
  ) satisfies TranscriptViewPort;
  const view: SessionView = {
    ...prepared,
    entry,
    anchor,
    transcript,
    commit,
    submit: prepared.submit.bind(prepared),
    submitDraft: prepared.submitDraft.bind(prepared),
    baseline: prepared.baseline.bind(prepared),
    older: prepared.older.bind(prepared),
    close: prepared.close.bind(prepared),
  };
  function ClassConsumer() {
    const state = useSessionView(view),
      intent = useViewAnchor(view),
      history = useTranscriptView(transcript);
    return h("p", null, `${state.draft}:${intent.mode}:${history.working}`);
  }
  let rendered: ReactTestRenderer | undefined;
  try {
    assert.match(renderToString(h(ClassConsumer)), /followingLive:false/);
    assert.equal(leases, 0);
    assert.equal(entry.subscriptions + anchor.subscriptions + transcript.subscriptions, 0);
    await act(async () => {
      rendered = create(h(StrictMode, null, h(ClassConsumer)));
    });
    assert.equal(leases, 2);
    for (const store of [entry, anchor, transcript]) assert.equal(store.listeners.size, 1);
    const subscriptions = [entry.subscriptions, anchor.subscriptions, transcript.subscriptions];
    await act(async () => {
      rendered!.update(h(StrictMode, null, h(ClassConsumer)));
    });
    assert.deepEqual(
      [entry.subscriptions, anchor.subscriptions, transcript.subscriptions],
      subscriptions,
    );
    await act(async () => {
      entry.replace({ ...entry.getSnapshot(), draft: "class receiver" });
      anchor.replace({ ...anchor.getSnapshot(), mode: "readingHistory" });
      transcript.replace({ ...transcript.getSnapshot(), working: true });
    });
    assert.match(JSON.stringify(rendered!.toJSON()), /class receiver:readingHistory:true/);
    assert.deepEqual(
      [entry.subscriptions, anchor.subscriptions, transcript.subscriptions],
      subscriptions,
    );
  } finally {
    if (rendered)
      await act(async () => {
        rendered!.unmount();
      });
    assert.equal(leases, 0);
    for (const store of [entry, anchor, transcript]) assert.equal(store.listeners.size, 0);
    assert.equal(f.observations.opened + f.feed.dispatches.length, 0);
    await workspace.close();
  }
});
