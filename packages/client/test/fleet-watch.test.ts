import { randomUUID } from "node:crypto";

import {
  accessStreamItemSchema,
  newAuthorityEpochId,
  newControlNodeId,
  newFeedId,
  newRealmId,
  newRuntimeEpoch,
  newSessionId,
  type AccessAttachInput,
  type AccessStreamItem,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";

import { AccessCursor } from "../src/cursor.js";
import {
  advanceAccessCursor,
  watchAccess,
} from "../src/access-watch.js";
import type {
  SubscriptionCallbacks,
  SubscriptionProcedure,
} from "../src/resilient-subscription.js";

const sessionId = newSessionId();
const runtimeEpoch = newRuntimeEpoch();
const originControlNodeId = newControlNodeId();
const authority = {
  realmId: newRealmId(),
  controlNodeId: originControlNodeId,
  epochId: newAuthorityEpochId(),
};

describe("access cursors", () => {
  it("waits for feed identity while retaining early native positions", () => {
    const feedId = newFeedId();
    const native = nativeItem(7);
    const heartbeat = accessStreamItemSchema.parse({
      kind: "heartbeat",
      feedId,
      controlCursor: 12,
      authorityRefs: [authority],
    });

    expect(advanceAccessCursor(undefined, native)).toBeUndefined();
    const cursor = new AccessCursor();
    cursor.observe(native);
    expect(cursor.snapshot()).toBeUndefined();
    cursor.observe(heartbeat);

    expect(cursor.snapshot()).toEqual({
      feedId,
      controlCursor: 12,
      native: { [sessionId]: { runtimeEpoch, sequence: 7 } },
    });
  });

  it("clears stale native positions on feed changes and explicit resets", () => {
    const firstFeedId = newFeedId();
    const secondFeedId = newFeedId();
    const cursor = new AccessCursor({
      feedId: firstFeedId,
      controlCursor: 4,
      native: { [sessionId]: { runtimeEpoch, sequence: 7 } },
    });

    cursor.observe(accessStreamItemSchema.parse({
      kind: "heartbeat",
      feedId: secondFeedId,
      controlCursor: 1,
      authorityRefs: [authority],
    }));
    expect(cursor.snapshot()).toEqual({
      feedId: secondFeedId,
      controlCursor: 1,
      native: {},
    });

    cursor.observe(nativeItem(8));
    cursor.observe(accessStreamItemSchema.parse({
      kind: "streamReset",
      previousFeedId: secondFeedId,
      feedId: secondFeedId,
      controlCursor: 9,
      authorityRefs: [authority],
      reason: "topologyChanged",
      recovery: "snapshot",
    }));
    expect(cursor.snapshot()).toEqual({
      feedId: secondFeedId,
      controlCursor: 9,
      native: {},
    });
  });

  it("resubscribes from the committed feed cursor and suppresses same-feed replay", async () => {
    const procedure = new FakeSubscription();
    const received: AccessStreamItem[] = [];
    const watcher = watchAccess(procedure, {
      onItem: (item) => received.push(item),
      initialRetryDelayMs: 0,
      maxRetryDelayMs: 0,
      retryJitter: 0,
    });
    const item = controlItem(newFeedId(), 3);

    procedure.emit(item);
    await tick();
    procedure.fail(new Error("connection lost"));
    await tick();
    await tick();

    expect(procedure.inputs).toHaveLength(2);
    expect(procedure.inputs[1]?.cursor).toMatchObject({
      feedId: item.feedId,
      controlCursor: 3,
    });
    procedure.emit(item);
    await tick();
    expect(received).toEqual([item]);
    watcher.stop();
    await watcher.done;
  });

  it("does not suppress a low cursor from a replacement feed", async () => {
    const procedure = new FakeSubscription();
    const received: AccessStreamItem[] = [];
    const first = controlItem(newFeedId(), 30);
    const replacement = controlItem(newFeedId(), 1);
    const watcher = watchAccess(procedure, {
      cursor: { feedId: first.feedId, controlCursor: 30, native: {} },
      onItem: (item) => received.push(item),
    });

    procedure.emit(first);
    procedure.emit(replacement);
    await tick();

    expect(received).toEqual([replacement]);
    expect(watcher.cursor).toEqual({
      feedId: replacement.feedId,
      controlCursor: 1,
      native: {},
    });
    watcher.stop();
    await watcher.done;
  });
});

class FakeSubscription
  implements SubscriptionProcedure<AccessAttachInput, AccessStreamItem>
{
  readonly inputs: AccessAttachInput[] = [];
  private callbacks: SubscriptionCallbacks<AccessStreamItem> | undefined;

  subscribe(
    input: AccessAttachInput,
    callbacks: SubscriptionCallbacks<AccessStreamItem>,
  ): { unsubscribe(): void } {
    this.inputs.push(input);
    this.callbacks = callbacks;
    callbacks.onStarted?.();
    return { unsubscribe: () => undefined };
  }

  emit(item: AccessStreamItem): void {
    this.callbacks?.onData(item);
  }

  fail(error: unknown): void {
    this.callbacks?.onError(error);
  }
}

function nativeItem(sequence: number): AccessStreamItem {
  return accessStreamItemSchema.parse({
    kind: "native",
    sessionId,
    harness: "codex",
    runtimeEpoch,
    sequence,
    nativeType: "item/updated",
    payload: { text: "hello" },
    ephemeral: false,
    provenance: { originControlNodeId, authority },
  });
}

function controlItem(
  feedId: ReturnType<typeof newFeedId>,
  cursor: number,
): Extract<AccessStreamItem, { kind: "control" }> {
  return accessStreamItemSchema.parse({
    kind: "control",
    eventId: randomUUID(),
    provenance: { originControlNodeId, authority },
    feedId,
    cursor,
    change: {
      type: "session.unavailable",
      sessionId,
    },
  }) as Extract<AccessStreamItem, { kind: "control" }>;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
