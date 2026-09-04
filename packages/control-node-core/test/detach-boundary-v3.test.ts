import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ControlNodeCatalog, ControlNodeService } from "../src/index.js";

const now = "2040-01-02T03:04:05.000Z";
const clock = () => new Date(now);

function stateFile(name: string): string {
  return join(
    mkdtempSync(join(tmpdir(), `agent-multiplex-detach-v3-${name}-`)),
    "control-node.sqlite",
  );
}

describe("protocol-v4 graceful-detach safety boundary", () => {
  it("fails before mutating either the attachment or projection", async () => {
    const parent = new ControlNodeCatalog({
      filename: stateFile("parent"),
      now: clock,
    });
    const child = new ControlNodeCatalog({
      filename: stateFile("child"),
      now: clock,
    });
    const local = child.localControlNode();
    const attached = parent.attachChild({
      controlNodeId: local.controlNodeId,
      controlNodeBootId: local.controlNodeBootId,
      feedId: local.feedId,
      name: local.name,
      protocolVersion: 4,
      capabilities: local.capabilities,
      expectedParentControlNodeId: parent.localControlNode().controlNodeId,
      childProof: child.attachmentProof(),
    });
    child.applyParentAttachment(attached.attachment, "parent-endpoint");
    const service = new ControlNodeService({ catalog: parent, now: clock });
    const cursor = parent.controlCursor();

    await expect(service.detachTopology({
      childControlNodeId: local.controlNodeId,
      attachmentId: attached.attachment.attachmentId,
      lineageId: attached.attachment.lineageId,
      expectedAuthority: parent.authority(),
    })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: expect.stringContaining("prepare/drain/commit"),
    });

    expect(parent.getAttachment(local.controlNodeId)).toEqual(
      attached.attachment,
    );
    expect(parent.controlCursor()).toBe(cursor);
    expect(child.dataRole()).toMatchObject({
      role: "branch",
      branch: {
        lifecycle: "attached",
        attachmentId: attached.attachment.attachmentId,
        lineageId: attached.attachment.lineageId,
      },
    });

    service.close();
    child.close();
    parent.close();
  });
});
