import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ControlNodeId,
  type StreamCursor,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";

import {
  ControlNodeCatalog,
  ControlNodeEventHub,
  type ControlNodeCatalogFailpoint,
} from "../src/index.js";

const now = "2034-01-02T03:04:05.000Z";
const clock = () => new Date(now);

function stateFile(prefix: string): string {
  return join(mkdtempSync(join(tmpdir(), `agent-multiplex-${prefix}-`)), "control-node.sqlite");
}

function attachAndDetach(parent: ControlNodeCatalog, child: ControlNodeCatalog) {
  const local = child.localControlNode();
  const { attachment } = parent.attachChild({
    controlNodeId: local.controlNodeId,
    controlNodeBootId: local.controlNodeBootId,
    feedId: local.feedId,
    name: local.name,
    protocolVersion: 4,
    capabilities: local.capabilities,
    expectedParentControlNodeId: parent.localControlNode().controlNodeId,
    childProof: child.attachmentProof(),
  });
  child.applyParentAttachment(attachment, `parent-${parent.localControlNode().controlNodeId}`);
  const receipt = parent.detachChild({
    childControlNodeId: child.localControlNode().controlNodeId,
    attachmentId: attachment.attachmentId,
    lineageId: attachment.lineageId,
    expectedAuthority: parent.authority(),
  });
  child.applyDetachmentReceipt(receipt);
  return receipt;
}

function promote(child: ControlNodeCatalog, detachmentTransitionId: string) {
  return child.promote({
    controlNodeId: child.localControlNode().controlNodeId,
    expectedAuthority: child.authority(),
    detachmentTransitionId,
  });
}

describe("control-feed generations across authority promotion", () => {
  it("atomically starts a fresh feed while preserving the stable control-node identity", () => {
    const parent = new ControlNodeCatalog({ filename: stateFile("promotion-parent"), now: clock });
    const child = new ControlNodeCatalog({ filename: stateFile("promotion-child"), now: clock });
    const detachment = attachAndDetach(parent, child);
    const controlNodeId = child.localControlNode().controlNodeId;
    const previousAuthority = child.authority();
    const previousCheckpoint = child.feedCheckpoint();
    const previousEventIds = new Set(child.controlEventsAfter(0).map((item) => item.eventId));
    const published: ReturnType<typeof child.controlEventsAfter> = [];
    const unsubscribe = child.onControl((item) => published.push(item));

    const receipt = promote(child, detachment.transitionId);
    unsubscribe();
    const checkpoint = child.feedCheckpoint();
    const replay = child.controlEventsAfter(0);

    expect(child.localControlNode()).toMatchObject({
      controlNodeId,
      feedId: checkpoint.feedId,
      dataRole: { role: "authority", authority: receipt.authority },
    });
    expect(checkpoint.feedId).not.toBe(previousCheckpoint.feedId);
    expect(receipt.authority).not.toEqual(previousAuthority);
    expect(receipt.authority.controlNodeId).toBe(controlNodeId);
    expect(checkpoint.controlCursor).toBe(2);
    expect(replay.map((item) => item.cursor)).toEqual([1, 2]);
    expect(replay.map((item) => item.change.type)).toEqual([
      "authority.promoted",
      "controlNode.upsert",
    ]);
    expect(replay.every((item) => item.feedId === checkpoint.feedId)).toBe(true);
    expect(replay.map((item) => item.provenance.authority)).toEqual([
      receipt.authority,
      receipt.authority,
    ]);
    expect(replay.every((item) => !previousEventIds.has(item.eventId))).toBe(true);
    expect(published).toEqual(replay);

    child.close();
    parent.close();
  });

  it("requires snapshot recovery when a pre-promotion cursor reconnects", async () => {
    const parent = new ControlNodeCatalog({ filename: stateFile("reset-parent"), now: clock });
    const child = new ControlNodeCatalog({ filename: stateFile("reset-child"), now: clock });
    const detachment = attachAndDetach(parent, child);
    const previous: StreamCursor = { ...child.feedCheckpoint(), native: {} };
    const hub = new ControlNodeEventHub({ catalog: child, heartbeatMs: 60_000 });

    promote(child, detachment.transitionId);
    const current = child.feedCheckpoint();
    const controller = new AbortController();
    const iterator = hub.attach({
      sessions: "all",
      includeNative: false,
      cursor: previous,
    }, controller.signal)[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first).toEqual({
      done: false,
      value: {
        kind: "streamReset",
        previousFeedId: previous.feedId,
        feedId: current.feedId,
        controlCursor: current.controlCursor,
        authorityRefs: [child.authority()],
        reason: "feedChanged",
        recovery: "snapshot",
      },
    });

    controller.abort();
    await iterator.return?.();
    hub.close();
    child.close();
    parent.close();
  });

  it("resets a subscriber that is live while the authority feed rotates", async () => {
    const parent = new ControlNodeCatalog({ filename: stateFile("live-reset-parent"), now: clock });
    const child = new ControlNodeCatalog({ filename: stateFile("live-reset-child"), now: clock });
    const detachment = attachAndDetach(parent, child);
    const previous = child.feedCheckpoint();
    const hub = new ControlNodeEventHub({ catalog: child, heartbeatMs: 60_000 });
    const controller = new AbortController();
    const iterator = hub.attach({
      // Even a subscription selecting no sessions must see the generation
      // boundary rather than linger on the old feed until a heartbeat.
      sessions: [],
      includeNative: false,
    }, controller.signal)[Symbol.asyncIterator]();
    const next = iterator.next();

    const receipt = promote(child, detachment.transitionId);
    const current = child.feedCheckpoint();
    await expect(next).resolves.toEqual({
      done: false,
      value: {
        kind: "streamReset",
        previousFeedId: previous.feedId,
        feedId: current.feedId,
        controlCursor: current.controlCursor,
        authorityRefs: [receipt.authority],
        reason: "feedChanged",
        recovery: "snapshot",
      },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });

    controller.abort();
    hub.close();
    child.close();
    parent.close();
  });

  it("persists the rotated feed across restart and never revives old-generation events", async () => {
    const parent = new ControlNodeCatalog({ filename: stateFile("restart-parent"), now: clock });
    const childFile = stateFile("restart-child");
    let child = new ControlNodeCatalog({ filename: childFile, now: clock });
    const detachment = attachAndDetach(parent, child);
    const controlNodeId = child.localControlNode().controlNodeId;
    const previous: StreamCursor = { ...child.feedCheckpoint(), native: {} };
    const oldEventIds = new Set(child.controlEventsAfter(0).map((item) => item.eventId));
    const promotion = promote(child, detachment.transitionId);
    const rotatedFeedId = child.feedCheckpoint().feedId;
    child.close();

    child = new ControlNodeCatalog({ filename: childFile, now: clock });
    const replay = child.controlEventsAfter(0);
    expect(child.localControlNode()).toMatchObject({ controlNodeId, feedId: rotatedFeedId });
    expect(child.authority()).toEqual(promotion.authority);
    expect(child.feedCheckpoint().feedId).toBe(rotatedFeedId);
    expect(replay.map((item) => item.cursor)).toEqual([1, 2, 3]);
    expect(replay.map((item) => item.change.type)).toEqual([
      "authority.promoted",
      "controlNode.upsert",
      "controlNode.upsert",
    ]);
    expect(replay.every((item) => item.feedId === rotatedFeedId)).toBe(true);
    expect(replay.every((item) => !oldEventIds.has(item.eventId))).toBe(true);

    const hub = new ControlNodeEventHub({ catalog: child, heartbeatMs: 60_000 });
    const controller = new AbortController();
    const iterator = hub.attach({
      sessions: "all",
      includeNative: false,
      cursor: previous,
    }, controller.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        kind: "streamReset",
        previousFeedId: previous.feedId,
        feedId: rotatedFeedId,
        reason: "feedChanged",
        recovery: "snapshot",
      },
    });
    controller.abort();
    await iterator.return?.();
    hub.close();
    child.close();
    parent.close();
  });

  it("rolls feed identity, journal, cursors, and authority back together", () => {
    const parent = new ControlNodeCatalog({ filename: stateFile("rollback-parent"), now: clock });
    const childFile = stateFile("rollback-child");
    let injected: ControlNodeCatalogFailpoint | undefined;
    let child = new ControlNodeCatalog({
      filename: childFile,
      now: clock,
      failpoint: (point) => {
        if (point === injected) throw new Error(`injected ${point}`);
      },
    });
    const detachment = attachAndDetach(parent, child);
    const controlNodeId: ControlNodeId = child.localControlNode().controlNodeId;
    const previousRole = child.dataRole();
    const previousCheckpoint = child.feedCheckpoint();
    const previousReplay = child.controlEventsAfter(0);

    injected = "authority.promotion.afterFeedRotation";
    expect(() => promote(child, detachment.transitionId)).toThrow(
      "injected authority.promotion.afterFeedRotation",
    );
    expect(child.dataRole()).toEqual(previousRole);
    expect(child.feedCheckpoint()).toEqual(previousCheckpoint);
    expect(child.localControlNode()).toMatchObject({
      controlNodeId,
      feedId: previousCheckpoint.feedId,
    });
    expect(child.controlEventsAfter(0)).toEqual(previousReplay);

    child.close();
    child = new ControlNodeCatalog({ filename: childFile, now: clock });
    const replayAfterRestart = child.controlEventsAfter(0);
    expect(child.dataRole()).toEqual(previousRole);
    expect(child.feedCheckpoint().feedId).toBe(previousCheckpoint.feedId);
    expect(child.localControlNode()).toMatchObject({
      controlNodeId,
      feedId: previousCheckpoint.feedId,
    });
    expect(replayAfterRestart.slice(0, previousReplay.length)).toEqual(previousReplay);
    expect(replayAfterRestart.every((item) => item.feedId === previousCheckpoint.feedId)).toBe(true);
    expect(replayAfterRestart.some((item) => item.change.type === "authority.promoted")).toBe(false);

    child.close();
    parent.close();
  });
});
