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
  type SessionSearchPage,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it, vi } from "vitest";

import {
  ControlNodeCatalog,
  ControlNodeCoreError,
  ControlNodeService,
  createAccessRouter,
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
    protocolVersion: 6,
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
    protocolVersion: 6,
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

async function coldSearchFixture(label: string) {
  const rootCatalog = new ControlNodeCatalog({ filename: stateFile(`${label}-root`), now: clock });
  const childCatalog = new ControlNodeCatalog({ filename: stateFile(`${label}-child`), now: clock });
  const reachableCatalog = new ControlNodeCatalog({ filename: stateFile(`${label}-reachable`), now: clock });
  const cold = addArchivedSession(childCatalog, `${label}-native-cold`);
  const reachable = addArchivedSession(reachableCatalog, `${label}-native-reachable`);
  const runtimeNodeId = newRuntimeNodeId();
  rootCatalog.registerRuntimeNode({ runtimeNodeId, runtimeNodeBootId: newRuntimeNodeBootId(),
    name: `${label}-local`, allowedRoots: ["/work"], harnesses: [], launchProfiles: [], protocolVersion: 6 });
  const hot = rootCatalog.reconcileInventory({ runtimeNodeId, generation: `${label}-hot`, complete: true,
    capturedAt: now, sessions: [{ harness: "codex", adapterScopeId: "recursive-codex" as AdapterScopeId,
      vendorSessionId: `${label}-native-hot`, cwd: `/work/${label}`, availability: "active", runtimeStatus: "idle",
      runtimeEpoch: newRuntimeEpoch(), lastActivityAt: now }] })[0]!;
  const attached = attach(rootCatalog, childCatalog, `${label}-endpoint`);
  const reachableAttachment = attach(rootCatalog, reachableCatalog, `${label}-reachable-endpoint`);
  const rootService = new ControlNodeService({ catalog: rootCatalog });
  const childService = new ControlNodeService({ catalog: childCatalog });
  const reachableService = new ControlNodeService({ catalog: reachableCatalog });
  const connection = childConnection(childCatalog, childService, attached.attachment, `${label}-endpoint`);
  await rootService.attachChildConnection(connection);
  await rootService.attachChildConnection(childConnection(reachableCatalog, reachableService,
    reachableAttachment.attachment, `${label}-reachable-endpoint`));
  return { rootCatalog, childCatalog, rootService, childService, connection, cold, reachable, hot,
    async replace(searchSessions: ChildControlNodeConnection["searchSessions"]) {
      const replacement = { ...connection, searchSessions };
      await rootService.attachChildConnection(replacement);
      return replacement;
    },
    close() {
      rootService.close(); childService.close(); reachableService.close();
      rootCatalog.close(); childCatalog.close(); reachableCatalog.close();
    } };
}

describe("bounded recursive archive search", () => {
  it("returns typed unavailable for a disconnected branch without hiding reachable or hot rows", async () => {
    const fixture = await coldSearchFixture("disconnected-search");
    try {
      fixture.rootService.detachChildConnection(fixture.connection);
      await expect(fixture.rootService.searchSessions({ states: ["archived"], limit: 10 }))
        .rejects.toMatchObject({ code: "UNAVAILABLE" });
      const reader = createAccessRouter(fixture.rootService).createCaller({ grantedScopes: ["read"] });
      await expect(reader.sessions.search({ states: ["running", "stopped", "archived"], limit: 10 }))
        .rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      expect((await reader.sessions.search({ limit: 10 })).sessions).toEqual([fixture.hot]);
      const scoped = await reader.sessions.search({ states: ["archived"],
        runtimeNodeIds: [fixture.reachable.session.runtimeNodeId], limit: 10 });
      expect(scoped.sessions).toMatchObject([{ sessionId: fixture.reachable.session.sessionId,
        vendorSessionId: fixture.reachable.session.vendorSessionId,
        bindingRevision: fixture.reachable.session.bindingRevision,
        metadataAuthority: fixture.rootCatalog.authority() }]);
      expect(scoped.nextCursor).toBeNull();
      expect(fixture.rootCatalog.getSession(fixture.cold.session.sessionId)).toBeNull();
      expect(fixture.childCatalog.getSession(fixture.cold.session.sessionId)?.catalogState).toBe("archived");
    } finally { fixture.close(); }
  });

  it("does not treat a retained stale connection as a complete empty archive result", async () => {
    const fixture = await coldSearchFixture("stale-search");
    try {
      await fixture.replace(async () => ({ sessions: [], nextCursor: null }));
      fixture.rootCatalog.markChildDisconnected(fixture.connection.controlNodeId, fixture.connection.controlNodeBootId);
      await expect(fixture.rootService.searchSessions({ states: ["archived"],
        runtimeNodeIds: [fixture.cold.session.runtimeNodeId], limit: 10 }))
        .rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect((await fixture.rootService.searchSessions({ limit: 10 })).sessions).toEqual([fixture.hot]);
    } finally { fixture.close(); }
  });

  it("bounds a held child read, retains its lane and discards a late reply", async () => {
    const fixture = await coldSearchFixture("held-search");
    let release!: (page: SessionSearchPage) => void;
    const held = new Promise<SessionSearchPage>(resolve => { release = resolve; });
    const read = vi.fn().mockReturnValueOnce(held).mockImplementation(query => fixture.childService.searchSessions(query));
    try {
      await fixture.replace(read);
      vi.useFakeTimers();
      const first = fixture.rootService.searchSessions({ states: ["archived"], limit: 10 });
      const rejection = expect(first).rejects.toMatchObject({ code: "UNAVAILABLE" });
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
      await expect(fixture.rootService.searchSessions({ states: ["archived"], limit: 10 }))
        .rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(read).toHaveBeenCalledTimes(1);
      expect((await fixture.rootService.searchSessions({ limit: 10 })).sessions).toEqual([fixture.hot]);
      release({ sessions: [], nextCursor: null });
      await vi.advanceTimersByTimeAsync(0);
      const recovered = await fixture.rootService.searchSessions({ states: ["archived"], limit: 10 });
      expect(read).toHaveBeenCalledTimes(2);
      expect(new Set(recovered.sessions.map(session => session.sessionId))).toEqual(new Set([
        fixture.cold.session.sessionId, fixture.reachable.session.sessionId,
      ]));
      expect(fixture.rootCatalog.getSession(fixture.cold.session.sessionId)).toBeNull();
    } finally { vi.useRealTimers(); fixture.close(); }
  });

  it("retires an aborted caller while another caller shares the exact child read", async () => {
    const fixture = await coldSearchFixture("cancelled-search");
    let release!: (page: SessionSearchPage) => void;
    const held = new Promise<SessionSearchPage>(resolve => { release = resolve; });
    const read = vi.fn().mockReturnValue(held);
    try {
      await fixture.replace(read);
      const controller = new AbortController();
      const caller = createAccessRouter(fixture.rootService).createCaller({ grantedScopes: ["read"] }, { signal: controller.signal });
      const first = caller.sessions.search({ states: ["archived"], limit: 10 });
      const rejected = expect(first).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      controller.abort();
      await rejected;
      const second = fixture.rootService.searchSessions({ states: ["archived"], limit: 10 });
      release(await fixture.childService.searchSessions({ states: ["archived"], limit: 10 }));
      const result = await second;
      expect(read).toHaveBeenCalledTimes(1);
      expect(result.sessions).toContainEqual(expect.objectContaining({ sessionId: fixture.cold.session.sessionId,
        vendorSessionId: fixture.cold.session.vendorSessionId, metadataAuthority: fixture.rootCatalog.authority() }));
    } finally { fixture.close(); }
  });

  it("rejects a page from a replaced connection and permits a fresh exact-binding read", async () => {
    const fixture = await coldSearchFixture("replaced-search");
    let release!: (page: SessionSearchPage) => void;
    const read = vi.fn(() => new Promise<SessionSearchPage>(resolve => { release = resolve; }));
    try {
      await fixture.replace(read);
      const first = fixture.rootService.searchSessions({ states: ["archived"], limit: 10 });
      const rejected = expect(first).rejects.toMatchObject({ code: "FENCED" });
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      await fixture.replace(query => fixture.childService.searchSessions(query));
      const recovered = await fixture.rootService.searchSessions({ states: ["archived"], limit: 10 });
      release({ sessions: [], nextCursor: null });
      await rejected;
      expect(recovered.sessions).toContainEqual(expect.objectContaining({
        sessionId: fixture.cold.session.sessionId, vendorSessionId: fixture.cold.session.vendorSessionId,
        adapterScopeId: fixture.cold.session.adapterScopeId, bindingRevision: fixture.cold.session.bindingRevision,
        launchProvenance: fixture.cold.session.launchProvenance, metadataAuthority: fixture.rootCatalog.authority(),
      }));
    } finally { fixture.close(); }
  });

  it("rechecks a completed sibling when another required child returns later", async () => {
    const fixture = await coldSearchFixture("merge-barrier-search");
    let release!: (page: SessionSearchPage) => void;
    const read = vi.fn(() => new Promise<SessionSearchPage>(resolve => { release = resolve; }));
    try {
      await fixture.replace(read);
      const pending = fixture.rootService.searchSessions({ states: ["archived"], limit: 10 });
      const rejected = expect(pending).rejects.toMatchObject({ code: "UNAVAILABLE" });
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      const owner = fixture.rootCatalog.getRuntimeNode(fixture.reachable.session.runtimeNodeId)!.ownerControlNodeId;
      fixture.rootCatalog.markChildDisconnected(owner, fixture.rootCatalog.getControlNode(owner)!.controlNodeBootId);
      release(await fixture.childService.searchSessions({ states: ["archived"], limit: 10 }));
      await rejected;
      expect(fixture.rootCatalog.getSession(fixture.cold.session.sessionId)).toBeNull();
    } finally { fixture.close(); }
  });
});

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
