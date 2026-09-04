import {
  adapterScopeIdSchema,
  emptyMetadataSnapshot,
  newRuntimeEpoch,
  newSessionId,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  type RuntimeNodeEventCursor,
  type RuntimeNodeEventItem,
} from "@arduano/agent-multiplex-protocol";
import {
  P2PRuntimeNodeConnection,
  RuntimeNodeEventPump,
} from "../src/runtime-node-bridge.js";
import { describe, expect, it, vi } from "vitest";

describe("RuntimeNodeEventPump", () => {
  it("opens a retried event subscription on the replacement authenticated peer", async () => {
    type Callbacks = {
      onStarted?(): void;
      onData(item: RuntimeNodeEventItem): void;
      onError(error: unknown): void;
      onComplete(): void;
    };
    let firstCallbacks: Callbacks | undefined;
    let secondCallbacks: Callbacks | undefined;
    const firstSubscribe = vi.fn((_input: unknown, callbacks: Callbacks) => {
      firstCallbacks = callbacks;
      callbacks.onStarted?.();
      return { unsubscribe() {} };
    });
    const secondSubscribe = vi.fn((_input: unknown, callbacks: Callbacks) => {
      secondCallbacks = callbacks;
      callbacks.onStarted?.();
      return { unsubscribe() {} };
    });
    const endpointId = "replacement-runtime-endpoint";
    const peer = (subscribe: typeof firstSubscribe) => ({
      identity: { id: endpointId },
      principal: { id: endpointId },
      rpc: { events: { subscribe: { subscribe } } },
    });
    let currentPeer = peer(firstSubscribe);
    const connection = new P2PRuntimeNodeConnection(
      newRuntimeNodeId(),
      newRuntimeNodeBootId(),
      endpointId,
      () => currentPeer as never,
      endpointId,
    );
    let observed = 0;
    const pump = new RuntimeNodeEventPump({
      connection,
      retryDelayMs: () => 0,
      onItem: () => { observed += 1; },
    });

    pump.start();
    expect(firstSubscribe).toHaveBeenCalledOnce();
    currentPeer = peer(secondSubscribe);
    firstCallbacks?.onError(new Error("authenticated session expired"));
    await eventually(() => secondSubscribe.mock.calls.length === 1);
    secondCallbacks?.onData({ kind: "heartbeat" });
    await eventually(() => observed === 1);
    pump.stop();
  });

  it("defers an early stop until p2prpc has dispatched the subscription", () => {
    let callbacks:
      | {
          onStarted?(): void;
        }
      | undefined;
    const unsubscribe = vi.fn();
    const connection = {
      runtimeNodeId: newRuntimeNodeId(),
      runtimeNodeBootId: newRuntimeNodeBootId(),
      endpointId: "test-endpoint",
      peer: {
        rpc: {
          events: {
            subscribe: {
              subscribe: (_input: unknown, nextCallbacks: typeof callbacks) => {
                callbacks = nextCallbacks;
                return { unsubscribe };
              },
            },
          },
        },
      },
    } as unknown as P2PRuntimeNodeConnection;
    const pump = new RuntimeNodeEventPump({ connection, onItem: () => true });

    pump.start();
    pump.stop();
    expect(unsubscribe).not.toHaveBeenCalled();
    callbacks?.onStarted?.();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("forwards runtime-node-local controls for control-node canonicalization", async () => {
    let callbacks:
      | {
          onData(item: RuntimeNodeEventItem): void;
          onStarted?(): void;
        }
      | undefined;
    const connection = {
      runtimeNodeId: newRuntimeNodeId(),
      runtimeNodeBootId: newRuntimeNodeBootId(),
      endpointId: "test-endpoint",
      peer: {
        rpc: {
          events: {
            subscribe: {
              subscribe: (
                _input: unknown,
                nextCallbacks: typeof callbacks,
              ) => {
                callbacks = nextCallbacks;
                callbacks?.onStarted?.();
                return { unsubscribe() {} };
              },
            },
          },
        },
      },
    } as unknown as P2PRuntimeNodeConnection;
    const observed: RuntimeNodeEventItem[] = [];
    const pump = new RuntimeNodeEventPump({
      connection,
      onItem: (item) => observed.push(item),
    });
    pump.start();
    const sessionId = newSessionId();
    const now = new Date().toISOString();
    const item: RuntimeNodeEventItem = {
      kind: "control",
      change: {
        type: "session.upsert",
        session: {
          sessionId,
          runtimeNodeId: connection.runtimeNodeId,
          harness: "codex",
          adapterScopeId: adapterScopeIdSchema.parse("codex-test"),
          vendorSessionId: "native-session",
          bindingRevision: 1,
          runtimeEpoch: newRuntimeEpoch(),
          cwd: "/work",
          availability: "active",
          runtimeStatus: "idle",
          metadata: emptyMetadataSnapshot(),
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
        },
      },
    };
    callbacks?.onData(item);
    await new Promise((resolve) => setImmediate(resolve));
    expect(observed).toEqual([item]);
    expect(pump.cursor).toEqual({ native: {} });
    pump.stop();
  });

  it("does not overflow when a synchronous receiver keeps up with a large binding replay", () => {
    let callbacks:
      | {
          onData(item: RuntimeNodeEventItem): void;
          onStarted?(): void;
        }
      | undefined;
    const errors: unknown[] = [];
    const connection = {
      runtimeNodeId: newRuntimeNodeId(),
      runtimeNodeBootId: newRuntimeNodeBootId(),
      endpointId: "large-replay-endpoint",
      peer: {
        rpc: {
          events: {
            subscribe: {
              subscribe: (
                _input: unknown,
                nextCallbacks: typeof callbacks,
              ) => {
                callbacks = nextCallbacks;
                callbacks?.onStarted?.();
                return { unsubscribe() {} };
              },
            },
          },
        },
      },
    } as unknown as P2PRuntimeNodeConnection;
    let observed = 0;
    const pump = new RuntimeNodeEventPump({
      connection,
      maxPendingItems: 1,
      onError: (error) => errors.push(error),
      onItem: () => { observed += 1; },
    });

    pump.start();
    for (let index = 0; index < 5_000; index += 1) {
      callbacks?.onData({ kind: "heartbeat" });
    }

    expect(observed).toBe(5_000);
    expect(errors).toEqual([]);
    pump.stop();
  });

  it("commits its cursor only after the receiver accepts an item", async () => {
    const sessionId = newSessionId();
    const item: RuntimeNodeEventItem = {
      kind: "native",
      sessionId,
      harness: "codex",
      runtimeEpoch: newRuntimeEpoch(),
      sequence: 0,
      nativeType: "turn/started",
      payload: { turnId: "early" },
      ephemeral: false,
    };
    const subscriptions: RuntimeNodeEventCursor[] = [];
    let calls = 0;
    let rejected!: () => void;
    const firstRejection = new Promise<void>((resolve) => { rejected = resolve; });
    const connection = replayingConnection(item, subscriptions);
    const pump = new RuntimeNodeEventPump({
      connection,
      retryDelayMs: () => 20,
      onItem: () => {
        calls += 1;
        if (calls === 1) {
          rejected();
          return false;
        }
        return true;
      },
    });

    pump.start();
    await firstRejection;
    expect(pump.cursor.native).toEqual({});
    await eventually(() => calls === 2);
    expect(pump.cursor.native[sessionId]).toEqual({
      runtimeEpoch: item.runtimeEpoch,
      sequence: 0,
    });
    expect(subscriptions).toHaveLength(2);
    expect(subscriptions[1]?.native).toEqual({});
    pump.stop();
  });

  it("retries ingestion failures instead of permanently stopping the feed", async () => {
    const item: RuntimeNodeEventItem = { kind: "heartbeat" };
    const errors: unknown[] = [];
    let calls = 0;
    const pump = new RuntimeNodeEventPump({
      connection: replayingConnection(item),
      retryDelayMs: () => 0,
      onError: (error) => {
        errors.push(error);
        throw new Error("diagnostics hook failed");
      },
      onItem: () => {
        calls += 1;
        if (calls === 1) throw new Error("control node temporarily unavailable");
      },
    });

    pump.start();
    await eventually(() => calls === 2);
    expect(errors).toHaveLength(1);
    expect(pump.cursor).toEqual({ native: {} });
    pump.stop();
  });
});

function replayingConnection(
  item: RuntimeNodeEventItem,
  cursors: RuntimeNodeEventCursor[] = [],
): P2PRuntimeNodeConnection {
  const runtimeNodeId = newRuntimeNodeId();
  return {
    runtimeNodeId,
    runtimeNodeBootId: newRuntimeNodeBootId(),
    endpointId: "test-replaying-endpoint",
    peer: {
      rpc: {
        events: {
          subscribe: {
            subscribe: (
              input: { runtimeNodeBootId: string; cursor: RuntimeNodeEventCursor },
              callbacks: { onData(item: RuntimeNodeEventItem): void },
            ) => {
              cursors.push(input.cursor);
              queueMicrotask(() => callbacks.onData(item));
              return { unsubscribe() {} };
            },
          },
        },
      },
    },
  } as unknown as P2PRuntimeNodeConnection;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for event pump");
}
