import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalJson,
  emptyMetadataSnapshot,
  newArchiveOperationId,
  newLaunchId,
  newRuntimeEpoch,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  type AccessSnapshot,
  type AdapterScopeId,
  type ArchiveRecord,
  type ControlNodeAttachment,
  type LaunchId,
  type LaunchRecord,
  type SessionId,
  type SessionRecord,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";

import {
  ControlNodeCatalog,
  ControlNodeCoreError,
  ControlNodeService,
  type ChildControlNodeConnection,
} from "../src/index.js";

const now = "2038-02-03T04:05:06.000Z";
const later = "2038-02-03T04:05:07.000Z";
const clock = () => new Date(now);

function stateFile(label: string): string {
  return join(
    mkdtempSync(join(tmpdir(), `agent-multiplex-recursive-v4-${label}-`)),
    "control.sqlite",
  );
}

function addArchivedSession(
  catalog: ControlNodeCatalog,
  vendorSessionId: string,
  sessionId?: SessionId,
): { session: SessionRecord; archive: ArchiveRecord } {
  const runtimeNodeId = newRuntimeNodeId();
  catalog.registerRuntimeNode({
    runtimeNodeId,
    runtimeNodeBootId: newRuntimeNodeBootId(),
    name: `runtime-${vendorSessionId}`,
    allowedRoots: ["/work"],
    harnesses: [],
    launchProfiles: [],
    protocolVersion: 5,
  });
  const active = sessionId === undefined
    ? catalog.reconcileInventory({
        runtimeNodeId,
        generation: `inventory-${vendorSessionId}`,
        complete: true,
        capturedAt: now,
        sessions: [{
          harness: "codex",
          adapterScopeId: "recursive-codex" as AdapterScopeId,
          vendorSessionId,
          cwd: `/work/${vendorSessionId}`,
          availability: "active",
          runtimeStatus: "idle",
          runtimeEpoch: newRuntimeEpoch(),
          lastActivityAt: now,
        }],
      })[0]
    : catalog.mergeRuntimeSession({
        sessionId,
        runtimeNodeId,
        harness: "codex",
        adapterScopeId: "recursive-codex" as AdapterScopeId,
        vendorSessionId,
        bindingRevision: 1,
        runtimeEpoch: newRuntimeEpoch(),
        cwd: `/work/${vendorSessionId}`,
        availability: "active",
        runtimeStatus: "idle",
        metadata: emptyMetadataSnapshot(),
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        lastActivityAt: now,
      });
  if (!active) throw new Error("archived-session fixture was not created");
  const stopped = catalog.markSessionStopped(
    active.sessionId,
    active.bindingRevision,
  );
  const archiveOperationId = newArchiveOperationId();
  const archive = catalog.recordArchive({
    archiveOperationId,
    payloadHash: canonicalJson({ archiveOperationId }).padEnd(16, "0"),
    sessionId: stopped.sessionId,
    runtimeNodeId,
    bindingRevision: stopped.bindingRevision,
    expectedAuthority: stopped.metadataAuthority,
    authority: stopped.metadataAuthority,
    state: "succeeded",
    releasedAt: now,
    catalogRevision: stopped.catalogRevision + 1,
    createdAt: now,
    updatedAt: now,
  });
  return { session: catalog.getSession(stopped.sessionId)!, archive };
}

function launchFor(
  session: SessionRecord,
  launchId: LaunchId = newLaunchId(),
  overrides: Partial<LaunchRecord> = {},
): LaunchRecord {
  return {
    launchId,
    payloadHash: "recursive-shared-launch-payload",
    sessionId: session.sessionId,
    runtimeNodeId: session.runtimeNodeId,
    profile: {
      providerId: "core.direct",
      profileId: "workspace",
      contractVersion: 1,
      requestSchemaHash: "a".repeat(64),
    },
    harness: "codex",
    input: { cwd: "/work/shared" },
    implementationVersion: "1.0.0",
    state: "accepted",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function attach(
  parent: ControlNodeCatalog,
  child: ControlNodeCatalog,
  childEndpointId: string,
): { attachment: ControlNodeAttachment; parentEndpointId: string } {
  const childNode = child.localControlNode();
  const parentEndpointId = `parent-${parent.localControlNode().controlNodeId}`;
  const { attachment } = parent.attachChild({
    controlNodeId: childNode.controlNodeId,
    controlNodeBootId: childNode.controlNodeBootId,
    feedId: childNode.feedId,
    name: childNode.name,
    endpointId: childEndpointId,
    protocolVersion: 5,
    capabilities: childNode.capabilities,
    expectedParentControlNodeId: parent.localControlNode().controlNodeId,
    childProof: child.attachmentProof(),
  });
  child.applyParentAttachment(attachment, parentEndpointId);
  return { attachment, parentEndpointId };
}

function childConnection(
  childCatalog: ControlNodeCatalog,
  childService: ControlNodeService,
  attachment: ControlNodeAttachment,
  endpointId: string,
): ChildControlNodeConnection {
  const unused = () => Promise.reject(new Error("unused test operation"));
  const snapshotPage = (): AccessSnapshot => childCatalog.accessSnapshot();
  return {
    controlNodeId: childCatalog.localControlNode().controlNodeId,
    controlNodeBootId: childCatalog.localControlNode().controlNodeBootId,
    endpointId,
    async readSubtreeSnapshot() {
      const snapshot = snapshotPage();
      return {
        source: snapshot.source,
        attachmentId: attachment.attachmentId,
        lineageId: attachment.lineageId,
        checkpoint: {
          feedId: snapshot.source.manifest.feedId,
          controlCursor: snapshot.source.manifest.controlCursor,
        },
        capturedAt: snapshot.capturedAt,
        controlNodes: snapshot.controlNodes,
        runtimeNodes: snapshot.runtimeNodes,
        sessions: snapshot.sessions,
        interactions: snapshot.interactions,
        metadataOperations: snapshot.metadataOperations,
        nextPageToken: null,
      };
    },
    async *subscribeAggregate(_cursor, signal) {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    listModels: async () => [],
    listLaunchProfileModels: async () => [],
    refreshInventory: unused,
    createLaunch: unused,
    getLaunch: (launchId) => childService.getLaunch(launchId),
    listLaunches: (query) => childService.listLaunches(query),
    searchSessions: (query) => childService.searchSessions(query),
    getSession: (sessionId) => childService.getSession(sessionId),
    resume: unused,
    stop: unused,
    archive: unused,
    getArchive: (archiveOperationId) => childService.getArchive(archiveOperationId),
    execute: unused,
    readNativeHistory: unused,
    resolveInteraction: unused,
  };
}

describe("protocol-v4 recursive cold discovery", () => {
  it("finds pre-attachment archives through an aggregate with fenced pagination", async () => {
    const rootCatalog = new ControlNodeCatalog({
      filename: stateFile("root"),
      now: clock,
    });
    const aggregateCatalog = new ControlNodeCatalog({
      filename: stateFile("aggregate"),
      now: clock,
    });
    const leafCatalog = new ControlNodeCatalog({
      filename: stateFile("leaf"),
      now: clock,
    });
    const aggregateAttachment = attach(
      rootCatalog,
      aggregateCatalog,
      "recursive-aggregate-endpoint",
    );
    const first = addArchivedSession(leafCatalog, "native-before-attach-a");
    const second = addArchivedSession(leafCatalog, "native-before-attach-b");
    const historicalLaunch = leafCatalog.recordLaunch({
      launchId: newLaunchId(),
      payloadHash: "recursive-launch-payload",
      sessionId: first.session.sessionId,
      runtimeNodeId: first.session.runtimeNodeId,
      profile: {
        providerId: "core.direct",
        profileId: "workspace",
        contractVersion: 1,
        requestSchemaHash: "a".repeat(64),
      },
      harness: "codex",
      input: { cwd: "/work/native-before-attach-a" },
      implementationVersion: "1.0.0",
      state: "accepted",
      createdAt: now,
      updatedAt: now,
    });
    const leafAttachment = attach(
      aggregateCatalog,
      leafCatalog,
      "recursive-leaf-endpoint",
    );
    const leafService = new ControlNodeService({ catalog: leafCatalog });
    const aggregateService = new ControlNodeService({ catalog: aggregateCatalog });
    await aggregateService.attachChildConnection(
      childConnection(
        leafCatalog,
        leafService,
        leafAttachment.attachment,
        "recursive-leaf-endpoint",
      ),
    );
    const rootService = new ControlNodeService({ catalog: rootCatalog });
    await rootService.attachChildConnection(
      childConnection(
        aggregateCatalog,
        aggregateService,
        aggregateAttachment.attachment,
        "recursive-aggregate-endpoint",
      ),
    );

    // Archived rows are intentionally absent from the hot subtree snapshot.
    expect(rootCatalog.searchSessions({ states: ["archived"] }).sessions).toEqual([]);

    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await rootService.searchSessions({
        states: ["archived"],
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      found.push(...page.sessions.map((session) => session.sessionId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(new Set(found)).toEqual(new Set([
      first.session.sessionId,
      second.session.sessionId,
    ]));

    const firstPage = await rootService.searchSessions({
      states: ["archived"],
      limit: 1,
    });
    await expect(rootService.searchSessions({
      states: ["stopped"],
      limit: 1,
      cursor: firstPage.nextCursor!,
    })).rejects.toMatchObject<Partial<ControlNodeCoreError>>({ code: "FENCED" });
    await expect(rootService.getSession(first.session.sessionId)).resolves.toMatchObject({
      catalogState: "archived",
      metadataAuthority: rootCatalog.authority(),
    });
    await expect(rootService.getArchive(first.archive.archiveOperationId)).resolves.toMatchObject({
      archiveOperationId: first.archive.archiveOperationId,
      state: "succeeded",
    });
    expect(rootCatalog.getLaunch(historicalLaunch.launchId)).toBeNull();
    await expect(rootService.getLaunch(historicalLaunch.launchId)).resolves.toMatchObject({
      launchId: historicalLaunch.launchId,
      state: "accepted",
    });
    await expect(rootService.listLaunches({ limit: 10 })).resolves.toMatchObject({
      launches: [{ launchId: historicalLaunch.launchId }],
      nextCursor: null,
    });

    rootService.close();
    aggregateService.close();
    leafService.close();
    rootCatalog.close();
    aggregateCatalog.close();
    leafCatalog.close();
  });

  it("fails closed when sibling subtrees return the same archived session identity", async () => {
    const rootCatalog = new ControlNodeCatalog({
      filename: stateFile("collision-root"),
      now: clock,
    });
    const leftCatalog = new ControlNodeCatalog({
      filename: stateFile("collision-left"),
      now: clock,
    });
    const rightCatalog = new ControlNodeCatalog({
      filename: stateFile("collision-right"),
      now: clock,
    });
    const left = addArchivedSession(leftCatalog, "native-collision-left");
    addArchivedSession(
      rightCatalog,
      "native-collision-right",
      left.session.sessionId,
    );
    const leftAttachment = attach(
      rootCatalog,
      leftCatalog,
      "recursive-left-endpoint",
    );
    const rightAttachment = attach(
      rootCatalog,
      rightCatalog,
      "recursive-right-endpoint",
    );
    const leftService = new ControlNodeService({ catalog: leftCatalog });
    const rightService = new ControlNodeService({ catalog: rightCatalog });
    const rootService = new ControlNodeService({ catalog: rootCatalog });
    await rootService.attachChildConnection(childConnection(
      leftCatalog,
      leftService,
      leftAttachment.attachment,
      "recursive-left-endpoint",
    ));
    await rootService.attachChildConnection(childConnection(
      rightCatalog,
      rightService,
      rightAttachment.attachment,
      "recursive-right-endpoint",
    ));

    await expect(rootService.searchSessions({
      states: ["archived"],
      limit: 10,
    })).rejects.toMatchObject<Partial<ControlNodeCoreError>>({ code: "CONFLICT" });
    await expect(rootService.getSession(left.session.sessionId))
      .rejects.toMatchObject<Partial<ControlNodeCoreError>>({ code: "CONFLICT" });

    rootService.close();
    leftService.close();
    rightService.close();
    rootCatalog.close();
    leftCatalog.close();
    rightCatalog.close();
  });

  it("fails closed when sibling subtrees return identical launch or archive records", async () => {
    const rootCatalog = new ControlNodeCatalog({
      filename: stateFile("operation-collision-root"),
      now: clock,
    });
    const leftCatalog = new ControlNodeCatalog({
      filename: stateFile("operation-collision-left"),
      now: clock,
    });
    const rightCatalog = new ControlNodeCatalog({
      filename: stateFile("operation-collision-right"),
      now: clock,
    });
    const left = addArchivedSession(leftCatalog, "native-operation-collision-left");
    addArchivedSession(rightCatalog, "native-operation-collision-right");
    const sharedLaunch = launchFor(left.session);
    const sharedArchive = left.archive;
    const leftAttachment = attach(
      rootCatalog,
      leftCatalog,
      "operation-collision-left-endpoint",
    );
    const rightAttachment = attach(
      rootCatalog,
      rightCatalog,
      "operation-collision-right-endpoint",
    );
    const leftService = new ControlNodeService({ catalog: leftCatalog });
    const rightService = new ControlNodeService({ catalog: rightCatalog });
    const rootService = new ControlNodeService({ catalog: rootCatalog });
    const collidingConnection = (
      catalog: ControlNodeCatalog,
      service: ControlNodeService,
      attachment: ControlNodeAttachment,
      endpointId: string,
    ): ChildControlNodeConnection => ({
      ...childConnection(catalog, service, attachment, endpointId),
      getLaunch: async (launchId) =>
        launchId === sharedLaunch.launchId ? sharedLaunch : null,
      listLaunches: async () => ({
        launches: [sharedLaunch],
        nextCursor: null,
      }),
      getArchive: async (archiveOperationId) =>
        archiveOperationId === sharedArchive.archiveOperationId
          ? sharedArchive
          : null,
    });
    await rootService.attachChildConnection(collidingConnection(
      leftCatalog,
      leftService,
      leftAttachment.attachment,
      "operation-collision-left-endpoint",
    ));
    await rootService.attachChildConnection(collidingConnection(
      rightCatalog,
      rightService,
      rightAttachment.attachment,
      "operation-collision-right-endpoint",
    ));

    await expect(rootService.getLaunch(sharedLaunch.launchId))
      .rejects.toMatchObject<Partial<ControlNodeCoreError>>({ code: "CONFLICT" });
    await expect(rootService.listLaunches({ limit: 10 }))
      .rejects.toMatchObject<Partial<ControlNodeCoreError>>({ code: "CONFLICT" });
    await expect(rootService.getArchive(sharedArchive.archiveOperationId))
      .rejects.toMatchObject<Partial<ControlNodeCoreError>>({ code: "CONFLICT" });

    rootService.close();
    leftService.close();
    rightService.close();
    rootCatalog.close();
    leftCatalog.close();
    rightCatalog.close();
  });

  it("reconciles local launch projections with the owning child's most advanced newest record", async () => {
    const rootCatalog = new ControlNodeCatalog({
      filename: stateFile("launch-reconciliation-root"),
      now: clock,
    });
    const childCatalog = new ControlNodeCatalog({
      filename: stateFile("launch-reconciliation-child"),
      now: clock,
    });
    const archived = addArchivedSession(
      childCatalog,
      "native-launch-reconciliation",
    );
    const attachment = attach(
      rootCatalog,
      childCatalog,
      "launch-reconciliation-endpoint",
    );

    const newestId = newLaunchId();
    const staleNewest = launchFor(archived.session, newestId, { sessionId: newSessionId() });
    const newest = launchFor(archived.session, newestId, {
      sessionId: staleNewest.sessionId,
      statusMessage: "newest owner checkpoint",
      updatedAt: later,
    });
    childCatalog.recordLaunch(newest);

    const advancedId = newLaunchId();
    const staleAdvanced = launchFor(archived.session, advancedId, { sessionId: newSessionId() });
    const advanced = launchFor(archived.session, advancedId, {
      sessionId: staleAdvanced.sessionId,
      state: "preparing",
      statusMessage: "local advanced checkpoint",
      updatedAt: later,
    });
    childCatalog.recordLaunch(staleAdvanced);

    const completedId = newLaunchId();
    const staleCompleted = launchFor(archived.session, completedId);
    const completed = launchFor(archived.session, completedId, {
      state: "succeeded",
      result: {
        sessionId: archived.session.sessionId,
        adapterScopeId: archived.session.adapterScopeId,
        vendorSessionId: archived.session.vendorSessionId,
        backendId: `codex:${archived.session.adapterScopeId}`,
        bindingRevision: archived.session.bindingRevision,
      },
      updatedAt: later,
    });
    childCatalog.recordLaunch(completed);

    const childService = new ControlNodeService({ catalog: childCatalog });
    const rootService = new ControlNodeService({ catalog: rootCatalog });
    const baseConnection = childConnection(
      childCatalog,
      childService,
      attachment.attachment,
      "launch-reconciliation-endpoint",
    );
    let forgedLaunch: LaunchRecord | null = null;
    const ownerConnection: ChildControlNodeConnection = {
      ...baseConnection,
      getLaunch: (launchId) => forgedLaunch?.launchId === launchId
        ? Promise.resolve(forgedLaunch)
        : baseConnection.getLaunch(launchId),
      listLaunches: (input) => forgedLaunch === null
        ? baseConnection.listLaunches(input)
        : Promise.resolve({ launches: [forgedLaunch], nextCursor: null }),
    };
    await rootService.attachChildConnection(ownerConnection);
    rootCatalog.recordLaunch(staleNewest, childCatalog.localControlNode().controlNodeId);
    rootCatalog.recordLaunch(advanced, childCatalog.localControlNode().controlNodeId);
    rootCatalog.recordLaunch(staleCompleted, childCatalog.localControlNode().controlNodeId);

    await expect(rootService.getLaunch(completedId)).resolves.toEqual(completed);
    expect(rootCatalog.getLaunch(completedId)).toEqual(completed);

    const page = await rootService.listLaunches({ limit: 10 });
    expect(page.launches.find((launch) => launch.launchId === newestId)).toEqual(newest);
    expect(page.launches.find((launch) => launch.launchId === advancedId)).toEqual(advanced);
    expect(rootCatalog.getLaunch(newestId)).toEqual(newest);
    expect(rootCatalog.getLaunch(advancedId)).toEqual(advanced);

    const mismatchedId = newLaunchId();
    const canonical = launchFor(archived.session, mismatchedId, { sessionId: newSessionId() });
    rootCatalog.recordLaunch(
      canonical,
      childCatalog.localControlNode().controlNodeId,
    );
    forgedLaunch = {
      ...canonical,
      input: { cwd: "/work/another-request" },
      updatedAt: later,
    };
    await expect(rootService.getLaunch(mismatchedId))
      .rejects.toMatchObject<Partial<ControlNodeCoreError>>({
        code: "PAYLOAD_MISMATCH",
      });
    await expect(rootService.listLaunches({ limit: 10 }))
      .rejects.toMatchObject<Partial<ControlNodeCoreError>>({
        code: "PAYLOAD_MISMATCH",
      });

    rootService.close();
    childService.close();
    rootCatalog.close();
    childCatalog.close();
  });
});
