import { createTRPCClient, experimental_localLink } from "@trpc/client";
import { cloneJson, type Json, type RunRef } from "../../src/protocol/index.js";
import { ObservationSupervisor } from "../../src/transport/index.js";
import { codexRouter } from "../../src/codex/server/router.js";
import type { CodexNativeApi } from "../../src/codex/node-contracts.js";
import type {
  CodexCaptureEvent,
  CodexCaptureFrame,
  CodexCaptureSnapshot,
  CodexNotification,
  Thread,
  ThreadItem,
  Turn,
} from "../../src/codex/native-contracts.js";
import { CodexWorkspace } from "../../src/codex/client/index.js";
import { CodexCapture } from "../../src/codex/capture.js";

export const run: RunRef = {
  scope: { connection: "connection", principal: "owner", host: "host", session: "session" },
  generation: 1,
  nativeSession: "root",
};
const json = <const T>(value: T): T & Json =>
  cloneJson(value as unknown as Json, 4 * 1024 * 1024) as T & Json;
export const message = (text: string, id = "message"): ThreadItem => ({
  type: "agentMessage",
  id,
  text,
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
});
export const turn = (items: ThreadItem[], id = "turn"): Turn => ({
  id,
  rootTurnId: null,
  items,
  itemsView: "full",
  status: "completed",
  error: null,
  startedAt: 1,
  completedAt: 2,
  durationMs: 1000,
});
export const thread = (id = "root"): Thread => ({
  id,
  environments: null,
  extra: null,
  sessionId: "root",
  forkedFromId: null,
  parentThreadId: id === "root" ? null : "root",
  preview: "",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "scripted",
  model: "scripted",
  reasoningEffort: null,
  createdAt: 1,
  updatedAt: 2,
  recencyAt: null,
  status: { type: "idle" },
  path: null,
  cwd: "/scripted",
  cliVersion: "0.162.1",
  originator: null,
  source: "appServer",
  canAcceptDirectInput: id === "root",
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  daybreakEnabled: null,
  turns: [],
});
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Feed implements AsyncIterableIterator<CodexCaptureFrame> {
  queue: CodexCaptureFrame[] = [];
  waiting:
    | {
        resolve: (value: IteratorResult<CodexCaptureFrame>) => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  closed = false;
  constructor(readonly release: () => void) {}
  [Symbol.asyncIterator]() {
    return this;
  }
  push(value: CodexCaptureFrame) {
    if (this.waiting) {
      const held = this.waiting;
      this.waiting = undefined;
      held.resolve({ done: false, value });
    } else this.queue.push(value);
  }
  next(): Promise<IteratorResult<CodexCaptureFrame>> {
    const value = this.queue.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }
  fail() {
    this.waiting?.reject(Error("scripted outage"));
    this.waiting = undefined;
  }
  async return() {
    this.closed = true;
    this.waiting?.resolve({ done: true, value: undefined });
    this.waiting = undefined;
    this.release();
    return { done: true as const, value: undefined };
  }
}
export function fixture(initial = false, openedAs: "created" | "resumed" | "unknown" = "unknown") {
  const feeds = new Set<Feed>(),
    reads: { method: string; params: unknown }[] = [],
    after: unknown[] = [];
  let revision = 0,
    attachment = "capture-1",
    events: CodexCaptureEvent[] = [],
    opens = 0,
    effects = 0;
  const capture = new CodexCapture(run);
  let read: (method: string, params: unknown) => unknown | Promise<unknown> = (method, params) => {
    const selected = params as { threadId: string; cursor?: string };
    if (method === "thread/read") return { thread: thread(selected.threadId) };
    if (method === "thread/turns/list")
      return {
        data: [turn([message(selected.cursor ?? "stored")])],
        nextCursor: selected.cursor ? null : "older-native-token",
        backwardsCursor: "newer-native-token",
      };
    if (method === "thread/items/list")
      return {
        data: [{ turnId: "turn", item: message("stored item"), startedAtMs: 1, completedAtMs: 2 }],
        nextCursor: null,
        backwardsCursor: null,
      };
    throw Error("unexpected native read");
  };
  const snapshot = (): CodexCaptureSnapshot => ({
    run,
    attachment,
    revision,
    source: "host-capture",
    coverage: {
      kind: "bounded-observation",
      nativeContinuity: "unproved",
      earlierOmitted: false,
      openedAs,
    },
    events,
    state: capture.snapshot(),
  });
  const adapter: CodexNativeApi = {
    nativeRead: async (_run, method, params) => {
      reads.push({ method, params });
      return read(method, params);
    },
    observation: snapshot,
    watchObservation: (_run, cursor) => {
      after.push(cursor);
      opens++;
      const feed = new Feed(() => {
        feeds.delete(feed);
      });
      feeds.add(feed);
      feed.push(json({ kind: cursor ? "gap" : "snapshot", snapshot: snapshot() }));
      return feed;
    },
    pendingCallbacks: () => [],
    watchCallbacks: () => {
      throw Error("unexpected callbacks");
    },
  };
  const router = codexRouter(
    {
      command: async () => {
        effects++;
        throw Error("unexpected native effect");
      },
    },
    adapter,
  );
  const client = createTRPCClient<typeof router>({
    links: [
      experimental_localLink({
        router,
        createContext: async () => ({
          identity: { connection: "connection", principal: "owner", actions: ["read"] },
          route: { authority: "root", host: "host", owner: "owner", routeEpoch: "epoch" },
          admit: () => () => {},
        }),
      }),
    ],
  });
  const observations = new ObservationSupervisor({ retryMinMs: 1, retryMaxMs: 1 });
  const workspace = new CodexWorkspace({ client, observations, loadInitialHistory: initial });
  return {
    workspace,
    observations,
    reads,
    after,
    client,
    get opens() {
      return opens;
    },
    get watchers() {
      return feeds.size;
    },
    get effects() {
      return effects;
    },
    setRead(value: typeof read) {
      read = value;
    },
    emit(notification: CodexNotification) {
      const event = { cursor: { attachment, revision: ++revision }, notification };
      capture.ingest(event);
      events = [...events, event].slice(-128);
      for (const feed of feeds) feed.push(json({ kind: "notification", run, event }));
    },
    disconnect() {
      for (const feed of feeds) feed.fail();
    },
    replaceAttachment() {
      attachment = "capture-2";
      revision = 0;
      events = [];
      capture.markGap();
    },
    async close() {
      await workspace.close();
      await observations.close();
    },
  };
}
export async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw Error("fixture stage deadline");
    await new Promise<void>((done) => setImmediate(done));
  }
}
