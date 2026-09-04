import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  newAttachmentId,
  newAuthorityEpochId,
  newControlNodeBootId,
  newControlNodeId,
  newFeedId,
  newLineageId,
  newRealmId,
  type ControlNodeAttachmentRequest,
  type ControlNodeId,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";

import { ControlNodeCatalog, ControlNodeCoreError } from "../src/index.js";

const now = "2040-07-08T09:10:11.000Z";
const clock = () => new Date(now);

function stateFile(prefix: string): string {
  return join(
    mkdtempSync(join(tmpdir(), `agent-multiplex-attachment-v3-${prefix}-`)),
    "control-node.sqlite",
  );
}

function requestFor(
  parent: ControlNodeCatalog,
  child: ControlNodeCatalog,
): ControlNodeAttachmentRequest {
  const local = child.localControlNode();
  const proof = child.attachmentProof();
  const role = proof.currentRole;
  return {
    controlNodeId: local.controlNodeId,
    controlNodeBootId: local.controlNodeBootId,
    feedId: local.feedId,
    name: local.name,
    ...(local.endpointId === undefined ? {} : { endpointId: local.endpointId }),
    protocolVersion: 4,
    capabilities: local.capabilities,
    expectedParentControlNodeId: parent.localControlNode().controlNodeId,
    childProof: proof,
    ...(role.role === "branch" && role.branch.lifecycle === "attached"
      ? {
          resume: {
            attachmentId: role.branch.attachmentId,
            lineageId: role.branch.lineageId,
            authority: role.authority,
          },
        }
      : {}),
  };
}

function freshRequest(
  parent: ControlNodeCatalog,
  controlNodeId = newControlNodeId(),
  coveredControlNodeIds: ControlNodeId[] = [controlNodeId],
): ControlNodeAttachmentRequest {
  return {
    controlNodeId,
    controlNodeBootId: newControlNodeBootId(),
    feedId: newFeedId(),
    name: "fresh-child",
    endpointId: `endpoint-${controlNodeId}`,
    protocolVersion: 4,
    capabilities: [],
    expectedParentControlNodeId: parent.localControlNode().controlNodeId,
    childProof: {
      currentRole: {
        role: "authority",
        authority: {
          realmId: newRealmId(),
          controlNodeId,
          epochId: newAuthorityEpochId(),
        },
      },
      coveredControlNodeIds,
    },
  };
}

function attach(parent: ControlNodeCatalog, child: ControlNodeCatalog) {
  const result = parent.attachChild(requestFor(parent, child));
  child.applyParentAttachment(
    result.attachment,
    `parent-${parent.localControlNode().controlNodeId}`,
  );
  return result;
}

function threeNodeTree(prefix: string) {
  const a = new ControlNodeCatalog({
    filename: stateFile(`${prefix}-a`),
    controlNodeName: "a",
    now: clock,
  });
  const bFile = stateFile(`${prefix}-b`);
  const b = new ControlNodeCatalog({
    filename: bFile,
    controlNodeName: "b",
    now: clock,
  });
  const c = new ControlNodeCatalog({
    filename: stateFile(`${prefix}-c`),
    controlNodeName: "c",
    now: clock,
  });
  const ab = attach(a, b);
  const bc = attach(b, c);
  a.replaceChildSnapshot(
    b.localControlNode().controlNodeId,
    ab.attachment.attachmentId,
    b.accessSnapshot(),
  );
  return { a, b, bFile, c, ab, bc };
}

describe("protocol-v4 attachment topology proofs", () => {
  it("rejects stealing an attached descendant from A -> B -> C without mutation", () => {
    const { a, b, c, ab, bc } = threeNodeTree("steal-descendant");
    const aCursor = a.controlCursor();
    const aNodes = a.listControlNodes();
    const cRequest = requestFor(a, c);

    expect(() => a.attachChild(cRequest)).toThrowError(
      expect.objectContaining<Partial<ControlNodeCoreError>>({ code: "FENCED" }),
    );
    expect(a.controlCursor()).toBe(aCursor);
    expect(a.listControlNodes()).toEqual(aNodes);
    expect(a.getAttachment(b.localControlNode().controlNodeId)).toEqual(ab.attachment);
    expect(a.getAttachment(c.localControlNode().controlNodeId)).toBeNull();
    expect(b.getAttachment(c.localControlNode().controlNodeId)).toEqual(bc.attachment);

    c.close();
    b.close();
    a.close();
  });

  it("rejects attaching ancestor A beneath descendant C without mutation", () => {
    const { a, b, c } = threeNodeTree("ancestor-cycle");
    const cCursor = c.controlCursor();
    const cRole = c.dataRole();
    const request = requestFor(c, a);

    expect(() => c.attachChild(request)).toThrowError(
      expect.objectContaining<Partial<ControlNodeCoreError>>({ code: "CONFLICT" }),
    );
    expect(c.controlCursor()).toBe(cCursor);
    expect(c.dataRole()).toEqual(cRole);
    expect(c.getAttachment(a.localControlNode().controlNodeId)).toBeNull();
    expect(c.activePeerEnrollment(`endpoint-${a.localControlNode().controlNodeId}`)).toBeNull();

    c.close();
    b.close();
    a.close();
  });

  it("rejects fresh subtree identity overlap and forged reconnect roles atomically", () => {
    const { a, b, c, ab } = threeNodeTree("overlap-and-forgery");
    const descendantId = c.localControlNode().controlNodeId;
    const freshId = newControlNodeId();
    const overlap = freshRequest(a, freshId, [freshId, descendantId]);
    const beforeOverlapCursor = a.controlCursor();
    const beforeOverlapNodes = a.listControlNodes();

    expect(() => a.attachChild(overlap)).toThrowError(
      expect.objectContaining<Partial<ControlNodeCoreError>>({ code: "CONFLICT" }),
    );
    expect(a.controlCursor()).toBe(beforeOverlapCursor);
    expect(a.listControlNodes()).toEqual(beforeOverlapNodes);
    expect(a.getAttachment(freshId)).toBeNull();
    expect(a.activePeerEnrollment(overlap.endpointId!)).toBeNull();

    const validReconnect = requestFor(a, b);
    if (validReconnect.childProof.currentRole.role !== "branch") {
      throw new Error("test branch unexpectedly became authoritative");
    }
    const forged = {
      ...validReconnect,
      childProof: {
        ...validReconnect.childProof,
        currentRole: {
          ...validReconnect.childProof.currentRole,
          branch: {
            ...validReconnect.childProof.currentRole.branch,
            lineageId: newLineageId(),
          },
        },
      },
    } satisfies ControlNodeAttachmentRequest;
    const beforeForgeryCursor = a.controlCursor();
    const beforeAttachment = a.getAttachment(b.localControlNode().controlNodeId);

    expect(() => a.attachChild(forged)).toThrowError(
      expect.objectContaining<Partial<ControlNodeCoreError>>({ code: "FENCED" }),
    );
    expect(a.controlCursor()).toBe(beforeForgeryCursor);
    expect(a.getAttachment(b.localControlNode().controlNodeId)).toEqual(beforeAttachment);
    expect(beforeAttachment).toEqual(ab.attachment);

    c.close();
    b.close();
    a.close();
  });

  it("retains exact reconnects, including a new child boot and existing subtree coverage", () => {
    const tree = threeNodeTree("exact-reconnect");
    const bId = tree.b.localControlNode().controlNodeId;
    const cId = tree.c.localControlNode().controlNodeId;
    const previousTransitionCount = tree.b.listRoleTransitions().length;
    tree.b.close();

    const restartedB = new ControlNodeCatalog({
      filename: tree.bFile,
      controlNodeBootId: newControlNodeBootId(),
      now: clock,
    });
    const reconnect = tree.a.attachChild(requestFor(tree.a, restartedB));

    expect(reconnect.reconnected).toBe(true);
    expect(reconnect.attachment).toEqual(tree.ab.attachment);
    expect(reconnect.child.controlNodeBootId).toBe(
      restartedB.localControlNode().controlNodeBootId,
    );
    expect(tree.a.isControlNodeProjectedThrough(bId, bId)).toBe(true);
    expect(tree.a.isControlNodeProjectedThrough(bId, cId)).toBe(true);
    restartedB.applyParentAttachment(reconnect.attachment, `parent-${tree.a.localControlNode().controlNodeId}`);
    expect(restartedB.listRoleTransitions()).toHaveLength(previousTransitionCount);

    tree.c.close();
    restartedB.close();
    tree.a.close();
  });

  it("rejects a forged parent receipt whose parent is already in the local subtree", () => {
    const { a, b, c } = threeNodeTree("apply-defense");
    const aCursor = a.controlCursor();
    const aRole = a.dataRole();
    const cId = c.localControlNode().controlNodeId;

    expect(() => a.applyParentAttachment({
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
      parentControlNodeId: cId,
      childControlNodeId: a.localControlNode().controlNodeId,
      authority: c.authority(),
      attachedAt: now,
    }, "forged-descendant-parent-endpoint")).toThrowError(
      expect.objectContaining<Partial<ControlNodeCoreError>>({ code: "CONFLICT" }),
    );
    expect(a.controlCursor()).toBe(aCursor);
    expect(a.dataRole()).toEqual(aRole);
    expect(a.activePeerEnrollment("forged-descendant-parent-endpoint")).toBeNull();

    c.close();
    b.close();
    a.close();
  });
});
