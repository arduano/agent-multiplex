import { packNativePayload } from "@arduano/agent-multiplex-protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  newRuntimeEpoch,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  type AdapterScopeId,
  type NativeEvent,
  type RuntimeEpoch,
  type SessionId,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";

import { ControlNodeCatalog, ControlNodeEventHub } from "../src/index.js";

const now = "2041-08-09T10:11:12.000Z";
const later = "2041-08-09T10:11:13.000Z";
const clock = () => new Date(now);

function stateFile(prefix: string): string {
  return join(
    mkdtempSync(join(tmpdir(), `agent-multiplex-native-dedup-${prefix}-`)),
    "control-node.sqlite",
  );
}

function nativeEvent(
  catalog: ControlNodeCatalog,
  sessionId: SessionId,
  runtimeEpoch: RuntimeEpoch,
  sequence: number,
): NativeEvent {
  return {
    kind: "native",
    sessionId,
    harness: "codex",
    runtimeEpoch,
    sequence,
    nativeType: "test/native",
    payload: packNativePayload({ sequence }),
    ephemeral: false,
    provenance: {
      originControlNodeId: catalog.localControlNode().controlNodeId,
      authority: catalog.authority(),
    },
  };
}

describe("ControlNodeEventHub native replay deduplication", () => {
  it.each(["ahead", "missing", "expired"] as const)("reports a %s native cursor gap before live delivery", async (scenario) => {
    const catalog = new ControlNodeCatalog({ filename: stateFile(scenario), now: clock });
    const hub = new ControlNodeEventHub({ catalog, heartbeatMs: 60_000, nativeRingSize: 1 });
    const sessionId = newSessionId();
    const runtimeEpoch = newRuntimeEpoch();
    if (scenario !== "missing") hub.publish(nativeEvent(catalog, sessionId, runtimeEpoch, 3));
    const controller = new AbortController();
    const iterator = hub.attach({
      sessions: [sessionId], includeNative: true,
      cursor: { ...catalog.feedCheckpoint(), native: { [sessionId]: { runtimeEpoch, sequence: scenario === "ahead" ? 8 : 0 } } },
    }, controller.signal)[Symbol.asyncIterator]();
    try {
      await expect(iterator.next()).resolves.toMatchObject({ done: false, value: {
        kind: "nativeGap", sessionId, recovery: "readNativeHistory",
        reason: scenario === "ahead" ? expect.stringContaining("behind requested sequence 8")
          : scenario === "missing" ? expect.stringContaining("no retained ring")
            : expect.stringContaining("begins at sequence 3"),
      } });
      const next = iterator.next();
      const live = nativeEvent(catalog, sessionId, runtimeEpoch, 9);
      hub.publish(live);
      await expect(next).resolves.toEqual({ done: false, value: live });
    } finally {
      controller.abort();
      await iterator.return?.();
      hub.close(); catalog.close();
    }
  });

  it("ignores unselected missing cursor rings and compares sequence only within the latest epoch", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("selected"), now: clock });
    const hub = new ControlNodeEventHub({ catalog, heartbeatMs: 60_000 });
    const sessionId = newSessionId();
    const replacement = nativeEvent(catalog, sessionId, newRuntimeEpoch(), 0);
    hub.publish(replacement);
    const controller = new AbortController();
    const iterator = hub.attach({ sessions: [sessionId], includeNative: true,
      cursor: { ...catalog.feedCheckpoint(), native: {
        [sessionId]: { runtimeEpoch: newRuntimeEpoch(), sequence: 99 },
        [newSessionId()]: { runtimeEpoch: newRuntimeEpoch(), sequence: 99 },
      } },
    }, controller.signal)[Symbol.asyncIterator]();
    try { await expect(iterator.next()).resolves.toEqual({ done: false, value: replacement }); }
    finally { controller.abort(); await iterator.return?.(); hub.close(); catalog.close(); }
  });

  it("suppresses reconnect replays and non-advancing sequences before replay or broadcast", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("reconnect"), now: clock });
    const hub = new ControlNodeEventHub({ catalog, heartbeatMs: 60_000 });
    const sessionId = newSessionId();
    const runtimeEpoch = newRuntimeEpoch();
    const first = nativeEvent(catalog, sessionId, runtimeEpoch, 0);
    const second = nativeEvent(catalog, sessionId, runtimeEpoch, 1);
    const third = nativeEvent(catalog, sessionId, runtimeEpoch, 2);

    // A child pump reconnects with native:{} and replays its complete ring.
    hub.publish(first);
    hub.publish(first);
    hub.publish(second);
    hub.publish(first);
    hub.publish(second);

    const controller = new AbortController();
    const iterator = hub.attach({
      sessions: [sessionId],
      includeNative: true,
      cursor: { ...catalog.feedCheckpoint(), native: {} },
    }, controller.signal)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: first });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: second });

    const live = iterator.next();
    hub.publish(second);
    hub.publish(first);
    hub.publish(third);
    await expect(live).resolves.toEqual({ done: false, value: third });

    controller.abort();
    await iterator.return?.();

    const replacement = nativeEvent(catalog, sessionId, newRuntimeEpoch(), 0);
    hub.publish(replacement);
    const replayController = new AbortController();
    const replay = hub.attach({
      sessions: [sessionId],
      includeNative: true,
      cursor: { ...catalog.feedCheckpoint(), native: {} },
    }, replayController.signal)[Symbol.asyncIterator]();
    await expect(replay.next()).resolves.toEqual({
      done: false,
      value: replacement,
    });
    const replayLive = replay.next();
    hub.publish({ ...replacement, sequence: 1, payload: packNativePayload({ sequence: 1 }) });
    await expect(replayLive).resolves.toMatchObject({
      done: false,
      value: { runtimeEpoch: replacement.runtimeEpoch, sequence: 1 },
    });
    replayController.abort();
    await replay.return?.();

    hub.close();
    catalog.close();
  });

  it("drops retained events as soon as the catalog replaces a session runtime epoch", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("epoch"), now: clock });
    const runtimeNodeId = newRuntimeNodeId();
    const runtimeNodeBootId = newRuntimeNodeBootId();
    catalog.registerRuntimeNode({
      runtimeNodeId,
      runtimeNodeBootId,
      name: "native-dedup-runtime",
      allowedRoots: ["/work"],
      harnesses: [],
      protocolVersion: 6,
    });
    const previousEpoch = newRuntimeEpoch();
    const [session] = catalog.reconcileInventory({
      runtimeNodeId,
      generation: "native-dedup-1",
      complete: true,
      capturedAt: now,
      sessions: [{
        harness: "codex",
        adapterScopeId: "native-dedup" as AdapterScopeId,
        vendorSessionId: "native-dedup-session",
        cwd: "/work/project",
        availability: "active",
        runtimeStatus: "running",
        runtimeEpoch: previousEpoch,
        lastActivityAt: now,
      }],
    });
    if (!session) throw new Error("test inventory did not create a session");
    const hub = new ControlNodeEventHub({ catalog, heartbeatMs: 60_000 });
    hub.publish(nativeEvent(catalog, session.sessionId, previousEpoch, 0));
    hub.publish(nativeEvent(catalog, session.sessionId, previousEpoch, 1));

    const replacementEpoch = newRuntimeEpoch();
    catalog.reconcileInventory({
      runtimeNodeId,
      generation: "native-dedup-2",
      complete: true,
      capturedAt: later,
      sessions: [{
        harness: "codex",
        adapterScopeId: session.adapterScopeId,
        vendorSessionId: session.vendorSessionId,
        cwd: session.cwd,
        availability: "active",
        runtimeStatus: "running",
        runtimeEpoch: replacementEpoch,
        lastActivityAt: later,
      }],
    });

    const replacement = nativeEvent(
      catalog,
      session.sessionId,
      replacementEpoch,
      0,
    );
    const controller = new AbortController();
    const iterator = hub.attach({
      sessions: [session.sessionId],
      includeNative: true,
      cursor: { ...catalog.feedCheckpoint(), native: {} },
    }, controller.signal)[Symbol.asyncIterator]();
    const next = iterator.next();
    hub.publish(replacement);

    // If the old epoch remained retained, replay would win this race and the
    // subscriber would observe a stale event before replacement sequence 0.
    await expect(next).resolves.toEqual({ done: false, value: replacement });

    controller.abort();
    await iterator.return?.();
    hub.close();
    catalog.close();
  });
});
