import { codexMessageSchema, type CodexObservedSelection } from "../../src/codex/contracts.js";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import {
  activateHost,
  defineHost,
  defaultLifecycle,
  existingDirectoryWorkspace,
} from "../../src/host/index.js";
import type { NativeObservation } from "../../src/host/index.js";
import { OriginalJournal } from "../../src/storage/index.js";
import { HistoryWindow, ReadBudget, type Frame, type NativePage } from "../../src/history/index.js";
import { InteractionOwner } from "../../src/interactions/index.js";
import { RetainedWorkspace } from "../../src/client/index.js";
import type {
  ClientPersistence,
  EntrySnapshot,
  ObservationConnector,
} from "../../src/client/contracts.js";
import type { CodexAnswer, CodexCommand } from "../../src/codex/index.js";
import { codexCommandSchema, codexRouter } from "../../src/codex/node.js";
import { canonicalJson, type Json } from "../../src/protocol/index.js";
import { openingProof, type OpeningCapsule } from "../../src/runtime/index.js";
import { ConversationFeature, conversationRouter } from "../../src/conversation/node.js";
import { createConversationFeed, subscriptionStream } from "../../src/conversation/index.js";
import { fixture, opening, scope, selection } from "../codex/fixtures.js";

const observe: ObservationConnector = {
  connect(input) {
    const abort = new AbortController(),
      iterator = input.open(abort.signal)[Symbol.asyncIterator]();
    let active = true;
    void (async () => {
      try {
        while (active) {
          const next = await iterator.next();
          if (next.done) break;
          if (active) input.receive(next.value);
        }
      } catch {
        if (active) input.unavailable();
      }
    })();
    return async () => {
      active = false;
      abort.abort();
      await iterator.return?.();
    };
  },
};
const persistence: ClientPersistence = {
  async load() {
    return [];
  },
  async save() {},
};
function nextEntry(
  entry: { getSnapshot(): EntrySnapshot; subscribe(listener: () => void): () => void },
  ready: (snapshot: EntrySnapshot) => boolean,
): Promise<EntrySnapshot> {
  if (ready(entry.getSnapshot())) return Promise.resolve(entry.getSnapshot());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      release();
      reject(
        new Error("Client observation did not arrive: " + JSON.stringify(entry.getSnapshot())),
      );
    }, 3000);
    const release = entry.subscribe(() => {
      if (ready(entry.getSnapshot())) {
        clearTimeout(timer);
        release();
        resolve(entry.getSnapshot());
      }
    });
  });
}

test("actual Codex/lifecycle/SQLite/router feeds retained client, exact replies and stopped cold history", async () => {
  const callbacks = new Map<string, InteractionOwner>();
  let publish = (_: NativeObservation<CodexObservedSelection>) => {};
  const f = await fixture({
    observe: (value) => publish(value),
    interactions: (run, attachment) => {
      const owner = new InteractionOwner(run, attachment);
      callbacks.set(canonicalJson(run as unknown as Json, 8192).json, owner);
      return owner;
    },
  });
  const journal = new OriginalJournal({ filename: join(f.directory, "agents.sqlite") }),
    resources = new OriginalJournal({ filename: join(f.directory, "helpers.sqlite") });
  const route = { authority: "root", host: scope.host, owner: "owner", routeEpoch: "epoch" };
  let feature: ConversationFeature<CodexCommand, CodexAnswer> | undefined,
    coldOpens = 0,
    releases = 0;
  const definition = defineHost({
    contract: { id: "test.conversation", version: 1 },
    harness: { identity: f.adapter.identity, nativeKind: "codex" as const, capabilities: [] },
    lifecycle: () =>
      defaultLifecycle({
        journal,
        native: f.adapter,
        workspace: existingDirectoryWorkspace(),
        selection,
      }),
    native: ({ sessions }) => codexRouter(sessions, f.adapter),
    extensions: ({ sessions }) => {
      publish = (value) => sessions.observe(value.run.scope, value);
      feature = new ConversationFeature<CodexCommand, CodexAnswer>({
        lifecycle: sessions,
        interactions: (run) => callbacks.get(canonicalJson(run as unknown as Json, 8192).json),
        encodeAnswer: (value) => ({ type: "answer", ...value }),
        async history(run, state) {
          if (state.phase !== "stopped" && state.phase !== "archived")
            return { window: f.adapter.history(run).window(), port: f.adapter.historyRead(run) };
          coldOpens++;
          let capsule: OpeningCapsule | undefined;
          const readerOpening = {
            ...opening,
            operationId: `reader-${coldOpens}`,
            generation: run.generation,
          };
          const reader = await f.adapter.reader({
            opening: readerOpening,
            async begin() {
              resources.saveCheckpoint(run.scope, { state: "allocating", opening: readerOpening });
            },
            async owned(value) {
              capsule = value;
              resources.saveCheckpoint(run.scope, {
                state: "owned",
                capsule: value as unknown as import("../../src/protocol/index.js").Json,
              });
            },
            async released(proof) {
              assert(capsule);
              openingProof(capsule, proof);
              resources.saveCheckpoint(run.scope, { state: "none" });
              releases++;
            },
          });
          assert(capsule);
          const window = new HistoryWindow({
            run,
            attachment: capsule.identity.attachment,
            stream: run.nativeSession,
          });
          return {
            window,
            port: reader.history(window.scope),
            resource: { usable: () => reader.usable, retire: () => reader.close() },
          };
        },
      });
      return {
        conversation: {
          identity: { id: "test.conversation-feature", version: 1, recordVersion: 1 },
          public: { host: z.null(), session: z.null() },
          router: conversationRouter(feature),
          readiness: () => feature!.readiness(),
          close: () => feature!.close(),
        },
      };
    },
  });
  const host = await activateHost(definition, {
    route,

    authenticate: (call) => ({
      route,
      identity: {
        connection: scope.connection,
        principal: scope.principal,
        actions: ["read", "control"],
      },
      ...(call.session ? { session: call.session } : {}),
    }),
  });
  let workspace: RetainedWorkspace | undefined;
  try {
    assert.equal(
      (await host.sessions.create(scope, "create", { cwd: f.directory })).state,
      "succeeded",
    );
    const caller = host.router.createCaller(
      await host.context({ expected: host.manifest, proof: null }),
    );
    const feed = createConversationFeed({
      caller: () => caller.extensions.conversation,
      dispatch: (selected, command) =>
        command.kind === "send"
          ? host.sessions.send(
              selected,
              command.id,
              codexMessageSchema.parse(command.payload),
              command.run,
            )
          : command.kind === "stop"
            ? caller.lifecycle.stop({
                session: selected.session,
                id: command.id,
                generation: command.payload.generation,
              })
            : host.sessions.command(
                selected,
                command.id,
                codexCommandSchema.parse(command.payload),
                command.run,
              ),
    });
    workspace = new RetainedWorkspace({ feed, persistence, observations: observe });
    const view = workspace.view(scope),
      release = view.commit(),
      sibling = workspace.view(scope),
      releaseSibling = sibling.commit();
    const initial = await nextEntry(
      view.entry,
      (value) => value.history.current !== null && value.interactions !== null,
    );
    assert(initial.state!.run);
    const run = initial.state!.run;
    assert.equal(
      f.wires[0]!.requests.filter((request) => request.method === "thread/timeline/list").length,
      0,
      "Fresh proved-empty Create streams without a fetch",
    );
    assert.equal(
      f.adapter.history(run).window().subscriberCount,
      1,
      "Two views share the retained entry's native observer",
    );
    const sent = await view.submit({
      id: "send-once",
      kind: "send",
      run,
      payload: { text: "hello" },
    });
    assert.equal((await sent.settled).state, "succeeded");
    f.wires[0]!.emit({
      method: "item/completed",
      params: {
        threadId: run.nativeSession,
        turnId: "turn",
        item: { id: "agent-message", type: "agentMessage", text: "actual streamed response" },
      },
    });
    await nextEntry(view.entry, (value) =>
      value.history.rows.some(
        (row) => row.body.kind === "complete" && row.body.text === "actual streamed response",
      ),
    );
    f.wires[0]!.emit({
      id: "question",
      method: "item/tool/requestUserInput",
      params: {
        threadId: run.nativeSession,
        turnId: "turn",
        itemId: "question",
        isBlocking: true,
        questions: [
          {
            id: "q",
            header: "Choose",
            question: "What now?",
            isOther: true,
            isSecret: false,
            options: null,
          },
        ],
      },
    });
    const prompting = await nextEntry(
      view.entry,
      (value) => (value.interactions?.items.length ?? 0) > 0,
    );
    const reference = prompting.interactions!.items[0]!.reference;
    const reply = {
      id: "reply-once",
      reference,
      answer: {
        type: "codex.question" as const,
        answers: { q: { values: ["continue"], extraInfo: "context" } },
      },
    };
    const replied = await caller.extensions.conversation.answer(reply);
    assert.equal(replied.state, "succeeded");
    assert.equal(
      callbacks.get(canonicalJson(run as unknown as Json, 8192).json)!.getSnapshot().items[0]!
        .original!.requestHash,
      replied.requestHash,
    );
    assert.deepEqual(await caller.extensions.conversation.answer(reply), replied);
    f.wires[0]!.emit({ method: "serverRequest/resolved", params: { requestId: "question" } });
    await nextEntry(view.entry, (value) => value.interactions!.items[0]!.state === "confirmed");
    if (false as boolean) {
      await caller.extensions.conversation.answer({
        id: "wrong-family",
        reference,
        // @ts-expect-error This conversation is statically bound to Codex answers.
        answer: { type: "copilot.question", answer: "no", wasFreeform: true },
      });
    }
    const extra = await caller.extensions.conversation.historyWatch({ run }),
      first = extra[Symbol.asyncIterator]();
    await first.next();
    const waiting = first.next();
    await first.return?.();
    assert.equal((await waiting).done, true);
    assert.equal(
      f.owners.values().next().value!.stopped,
      false,
      "Quiet unsubscribe does not Stop native work",
    );
    release();
    releaseSibling();
    view.close();
    sibling.close();
    await workspace.settled();
    await workspace.close();
    workspace = undefined;
    assert.equal((await host.sessions.stop(scope, "stop", 1)).state, "succeeded");
    await new Promise<void>((done) => setImmediate(done));
    const cold = await caller.extensions.conversation.historyWatch({ run }),
      iterator = cold[Symbol.asyncIterator]();
    let result = await iterator.next();
    assert.equal(result.done, false);
    const visible = (next: IteratorResult<Frame>) =>
      !next.done &&
      (next.value.kind === "snapshot" ? next.value.snapshot.rows : next.value.rows).some(
        (row) => row.body.kind === "complete" && row.body.text === "retained history",
      );
    for (let count = 0; count < 4 && !visible(result); count++) result = await iterator.next();
    assert(visible(result));
    assert.equal(coldOpens, 1);
    assert(
      f.wires[1]!.requests.every(
        (request) => !["thread/start", "thread/resume", "turn/start"].includes(request.method),
      ),
    );
    assert.equal(
      f.wires[1]!.requests.find((request) => request.method === "thread/timeline/list")!.params!
        .limit,
      100,
    );
    await iterator.return?.();
    assert.equal(
      f.wires[1]!.closed,
      false,
      "Cold observer cancellation leaves adapter-owned helper custody intact",
    );
    assert.equal(feature!.readiness().ready, true);
    await host.close();
    assert.equal(releases, 1);
    assert.deepEqual(resources.checkpoint(scope), { state: "none" });
  } finally {
    await workspace?.close().catch(() => {});
    await f.cleanup();
    resources.close();
    journal.close();
  }
});

test("browser subscription bridge retains final data, quiet abort and observer cleanup", async () => {
  let release = 0;
  const finite = subscriptionStream<number>((observer) => {
    observer.onData(1);
    observer.onComplete();
    return {
      unsubscribe() {
        release++;
      },
    };
  });
  assert.deepEqual(await finite.next(), { done: false, value: 1 });
  assert.equal((await finite.next()).done, true);
  assert.equal(release, 1);
  let observer: import("../../src/conversation/index.js").SubscriptionObserver<number> | undefined;
  const quiet = subscriptionStream<number>((value) => {
    observer = value;
    return {
      unsubscribe() {
        release++;
      },
    };
  });
  const next = quiet.next();
  await quiet.return?.();
  assert.equal((await next).done, true);
  observer!.onData(2);
  assert.equal((await quiet.next()).done, true);
  assert.equal(release, 2);
});

test("observer cancellation retains actual read budget and a late live page cannot publish after Stop", async () => {
  const run = { scope, generation: 1, nativeSession: "native" };
  let state: import("../../src/host/index.js").SessionState = {
    scope,
    generation: 1,
    nativeSession: "native",
    selectionSource: "observed",
    selection: {},
    workspace: null,
    phase: "running",
    run,
    activity: "idle",
    mayRun: true,
  };
  const listeners = new Set<() => void>(),
    live = new HistoryWindow({ run, attachment: "live", stream: "native" }),
    cold = new HistoryWindow({ run, attachment: "cold", stream: "native" }),
    budget = new ReadBudget(1);
  let finish!: (value: NativePage) => void, entered!: () => void;
  const pending = new Promise<NativePage>((resolve) => {
      finish = resolve;
    }),
    reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
  let calls = 0;
  const feature = new ConversationFeature({
    budget,
    waitMs: 1,
    lifecycle: {
      state: () => state,
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async command() {
        throw Error("no mutation admitted");
      },
      original() {
        return null;
      },
    },
    interactions: () => undefined,
    encodeAnswer: () => ({}),
    history: (_run, current) =>
      current.phase === "stopped"
        ? {
            window: cold,
            port: {
              scope: cold.scope,
              mode: "repeatable",
              async read() {
                calls++;
                return {
                  status: "page",
                  scope: cold.scope,
                  rows: [],
                  placement: "before",
                  nextCursor: null,
                };
              },
            },
          }
        : {
            window: live,
            port: {
              scope: live.scope,
              mode: "repeatable",
              async read() {
                calls++;
                entered();
                return pending;
              },
            },
          },
  });
  const stream = feature.historyWatch(run);
  await stream.next();
  await reading;
  assert.equal(calls, 1);
  assert.equal(budget.active, 1);
  assert.deepEqual(await feature.baseline(run), { state: "waitingExpired" });
  const quiet = stream.next();
  await stream.return?.();
  assert.equal((await quiet).done, true);
  assert.equal(budget.active, 1);
  assert.equal(feature.readiness().ready, false);
  assert.throws(() => feature.close(), /read remains owned/);
  state = {
    scope,
    generation: 1,
    nativeSession: "native",
    selectionSource: "observed",
    selection: {},
    workspace: null,
    phase: "stopped",
    activity: "idle",
    mayRun: false,
  };
  for (const listener of listeners) listener();
  await assert.rejects(feature.baseline(run), /READ_BUSY/);
  finish({
    status: "page",
    scope: live.scope,
    rows: [
      {
        id: "late",
        kind: "assistant",
        lifecycle: "completed",
        body: { kind: "complete", text: "must not publish", evidence: "native" },
        native: {},
      },
    ],
    placement: "before",
    nextCursor: null,
  });
  await new Promise<void>((done) => setImmediate(done));
  assert.equal(budget.active, 0);
  assert.equal(live.getSnapshot().rows.length, 0);
  assert.deepEqual(await feature.baseline(run), { state: "ready" });
  assert.equal(calls, 2);
  await feature.close();
});

test("explicit baseline can retry one failed repeatable read; reconnect alone cannot retry it", async () => {
  const run = { scope, generation: 1, nativeSession: "native" },
    window = new HistoryWindow({ run, attachment: "retained", stream: "native" });
  let calls = 0;
  const feature = new ConversationFeature({
    waitMs: 100,
    lifecycle: {
      state: () => ({
        scope,
        generation: 1,
        nativeSession: "native",
        selectionSource: "observed",
        selection: {},
        workspace: null,
        phase: "running" as const,
        run,
        activity: "idle" as const,
        mayRun: true as const,
      }),
      subscribe: () => () => {},
      async command() {
        throw Error("no effect");
      },
      original() {
        return null;
      },
    },
    interactions: () => undefined,
    encodeAnswer: () => ({}),
    history: () => ({
      window,
      port: {
        scope: window.scope,
        mode: "repeatable",
        async read() {
          calls++;
          throw Error("transient read failure");
        },
      },
    }),
  });
  const first = feature.historyWatch(run);
  await first.next();
  await new Promise<void>((done) => setImmediate(done));
  await first.return?.();
  assert.equal(calls, 1);
  const reconnected = feature.historyWatch(run);
  await reconnected.next();
  await new Promise<void>((done) => setImmediate(done));
  await reconnected.return?.();
  assert.equal(calls, 1);
  assert.deepEqual(await feature.baseline(run), { state: "failed", code: "READ_FAILED" });
  assert.equal(calls, 2);
  assert.deepEqual(await feature.baseline(run), { state: "failed", code: "READ_FAILED" });
  assert.equal(calls, 2);
  await feature.close();
});

test("retained live streams do not consume page budget; settled unobserved projections can be forgotten", async () => {
  const runs = [0, 1, 2].map((index) => ({
      scope: { ...scope, session: `session-${index}` },
      generation: 1,
      nativeSession: `native-${index}`,
    })),
    budget = new ReadBudget(1);
  let reads = 0;
  const feature = new ConversationFeature({
    budget,
    maxBindings: 2,
    lifecycle: {
      state: (selected) => {
        const run = runs.find((run) => run.scope.session === selected.session)!;
        return {
          scope: selected,
          generation: 1,
          nativeSession: run.nativeSession,
          selectionSource: "observed",
          selection: {},
          workspace: null,
          phase: "running" as const,
          run,
          activity: "idle" as const,
          mayRun: true as const,
        };
      },
      subscribe: () => () => {},
      async command() {
        throw Error("no native effect");
      },
      original() {
        return null;
      },
    },
    interactions: () => undefined,
    encodeAnswer: () => ({}),
    history: (run) => {
      const window = new HistoryWindow(
        { run, attachment: `attachment-${run.nativeSession}`, stream: run.nativeSession },
        {},
        true,
      );
      return {
        window,
        port: {
          scope: window.scope,
          mode: "repeatable",
          async read() {
            reads++;
            throw Error("fresh stream cannot fetch");
          },
        },
      };
    },
  });
  const a = feature.historyWatch(runs[0]!),
    b = feature.historyWatch(runs[1]!);
  assert.equal((await a.next()).done, false);
  assert.equal((await b.next()).done, false);
  assert.equal(budget.active, 0);
  assert.equal(reads, 0);
  assert.throws(() => feature.forget(runs[0]!), /observation\/read retained/);
  await a.return?.();
  feature.forget(runs[0]!);
  const c = feature.historyWatch(runs[2]!);
  assert.equal((await c.next()).done, false);
  assert.equal(reads, 0);
  await b.return?.();
  await c.return?.();
  await feature.close();
});

test("expired cold resource retires exactly before a new attachment; observed history follows its new frontier without Resume", async () => {
  const run = { scope, generation: 1, nativeSession: "native" };
  let opened = 0,
    retired = 0,
    usable = true,
    reads = 0;
  const feature = new ConversationFeature({
    waitMs: 100,
    lifecycle: {
      state: () => ({
        scope,
        generation: 1,
        nativeSession: "native",
        selectionSource: "observed",
        selection: {},
        workspace: null,
        phase: "stopped" as const,
        activity: "idle" as const,
        mayRun: false as const,
      }),
      subscribe: () => () => {},
      async command() {
        throw Error("No native mutation");
      },
      original() {
        return null;
      },
    },
    interactions: () => undefined,
    encodeAnswer: () => ({}),
    history: () => {
      const serial = ++opened,
        window = new HistoryWindow({ run, attachment: `helper-${serial}`, stream: "native" });
      return {
        window,
        resource: {
          usable: () => serial === opened && usable,
          async retire() {
            retired++;
            usable = true;
          },
        },
        port: {
          scope: window.scope,
          mode: "singleUse" as const,
          async read() {
            reads++;
            return {
              status: "page" as const,
              scope: window.scope,
              rows: [
                {
                  id: `row-${serial}`,
                  kind: "assistant" as const,
                  lifecycle: "completed" as const,
                  body: {
                    kind: "complete" as const,
                    text: `capture-${serial}`,
                    evidence: "native" as const,
                  },
                  native: {},
                },
              ],
              placement: "before" as const,
              nextCursor: "older",
            };
          },
        },
      };
    },
  });
  const stream = feature.historyWatch(run);
  await stream.next();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(opened, 1);
  assert.equal(reads, 1);
  const before = await feature.baseline(run);
  assert.equal(before.state, "ready");
  usable = false;
  assert.equal((await feature.older(run, "old-public-cursor")).state, "expired");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(opened, 2);
  assert.equal(retired, 1);
  assert.equal(reads, 2);
  let attachment = "";
  for (let n = 0; n < 5 && attachment !== "helper-2"; n++) {
    const frame = await stream.next();
    assert(!frame.done);
    attachment =
      frame.value.kind === "snapshot"
        ? frame.value.snapshot.scope.attachment
        : frame.value.scope.attachment;
  }
  assert.equal(attachment, "helper-2");
  await stream.return?.();
  await feature.close();
});
