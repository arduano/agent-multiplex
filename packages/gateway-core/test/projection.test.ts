import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  emptyMetadataSnapshot,
  newAuthorityEpochId,
  newControlNodeBootId,
  newControlNodeId,
  newFeedId,
  newLaunchId,
  newRealmId,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  newTerminalId,
  type AccessStreamItem,
  type AuthorityRef,
  type CommandRecord,
  type ControlNodeDescriptor,
  type RuntimeNodeDescriptor,
  type SessionRecord,
  type SourceId,
  type SourceManifest,
  type TerminalAttachInput,
  type TerminalDescriptor,
  type TerminalGetInput,
  type TerminalStreamItem,
} from "@arduano/agent-multiplex-protocol";

import {
  AccessGatewayProjection,
  GatewayOperationalStore,
  GatewayRoutingError,
  GatewaySubscriberOverflowError,
  createGatewayLaunchPort,
  instantiateGatewayPlugins,
  type ControlNodeSourceClient,
  type GatewaySourceSnapshot,
} from "../src/index.js";

const timestamp = "2026-09-03T01:00:00.000Z";

class FakeSource implements ControlNodeSourceClient {
  public dispatches = 0;
  public commandReads = 0;
  public executeError: Error | undefined;
  public getCommandError: Error | undefined;
  public recoveredCommand: CommandRecord | null = null;
  public loadError: Error | undefined;
  public terminalReads = 0;
  public terminalAttaches = 0;
  public launchDispatches = 0;
  public omitUndefinedLaunchFields = false;
  public launchRecord: import("@arduano/agent-multiplex-protocol").LaunchRecord | null = null;
  public readonly terminalId = newTerminalId();
  public terminalStreamItems: readonly TerminalStreamItem[] | undefined;

  public constructor(public snapshot: GatewaySourceSnapshot) {}
  public loadSnapshot(): Promise<GatewaySourceSnapshot> {
    return this.loadError
      ? Promise.reject(this.loadError)
      : Promise.resolve(this.snapshot);
  }
  public async *watch(): AsyncIterable<AccessStreamItem> {}
  public listModels(): Promise<[]> { return Promise.resolve([]); }
  public listLaunchProfiles() {
    return Promise.resolve(this.snapshot.runtimeNodes.flatMap((runtime) => runtime.launchProfiles));
  }
  public listLaunchModels(): Promise<[]> { return Promise.resolve([]); }
  public createLaunch(
    request: import("@arduano/agent-multiplex-protocol").LaunchRequest,
  ): Promise<import("@arduano/agent-multiplex-protocol").LaunchRecord> {
    this.launchDispatches += 1;
    const record: import("@arduano/agent-multiplex-protocol").LaunchRecord = {
      ...request,
      implementationVersion: "test",
      state: "accepted",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.launchRecord = this.omitUndefinedLaunchFields
      ? JSON.parse(JSON.stringify(record)) as typeof record
      : record;
    return Promise.resolve(this.launchRecord);
  }
  public getLaunch(launchId: import("@arduano/agent-multiplex-protocol").LaunchId) {
    return Promise.resolve(this.launchRecord?.launchId === launchId ? this.launchRecord : null);
  }
  public listLaunches() {
    return Promise.resolve({
      launches: this.launchRecord === null ? [] : [this.launchRecord],
      nextCursor: null,
    });
  }
  public searchSessions() {
    return Promise.resolve({ sessions: [...this.snapshot.sessions], nextCursor: null });
  }
  public getSession(sessionId: import("@arduano/agent-multiplex-protocol").SessionId) {
    return Promise.resolve(
      this.snapshot.sessions.find((session) => session.sessionId === sessionId) ?? null,
    );
  }
  public refresh(): Promise<never> { return Promise.reject(new Error("unused")); }
  public resume(): Promise<never> { return Promise.reject(new Error("unused")); }
  public stop(): Promise<never> { return Promise.reject(new Error("unused")); }
  public archive(): Promise<never> { return Promise.reject(new Error("unused")); }
  public getArchive(): Promise<null> { return Promise.resolve(null); }
  public execute(command: Parameters<ControlNodeSourceClient["execute"]>[0]): Promise<CommandRecord> {
    this.dispatches += 1;
    if (this.executeError) return Promise.reject(this.executeError);
    return Promise.resolve({
      commandId: command.commandId,
      payloadHash: command.payloadHash,
      sessionId: command.sessionId,
      runtimeNodeId: command.runtimeNodeId,
      state: "succeeded",
      request: command.request,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }
  public readNativeHistory(): Promise<never> { return Promise.reject(new Error("unused")); }
  public getTerminal(input: TerminalGetInput): Promise<TerminalDescriptor> {
    this.terminalReads += 1;
    return Promise.resolve(this.#terminal(input));
  }
  public openTerminal(input: Parameters<NonNullable<ControlNodeSourceClient["openTerminal"]>>[0]) {
    return Promise.resolve({ status: "opened" as const, terminal: this.#terminal(input) });
  }
  public async *attachTerminal(input: TerminalAttachInput, signal?: AbortSignal) {
    this.terminalAttaches += 1;
    yield* this.terminalStreamItems ?? [{
      kind: "heartbeat" as const,
      cursor: { terminalId: input.terminalId, sequence: 0 },
    }];
    if (signal?.aborted) return;
    await new Promise<void>((resolve) =>
      signal?.addEventListener("abort", () => resolve(), { once: true }));
  }
  public acquireTerminalLease(): Promise<never> { return Promise.reject(new Error("unused")); }
  public renewTerminalLease(): Promise<never> { return Promise.reject(new Error("unused")); }
  public releaseTerminalLease(): Promise<never> { return Promise.reject(new Error("unused")); }
  public sendTerminalInput(): Promise<never> { return Promise.reject(new Error("unused")); }
  public terminateTerminal(): Promise<never> { return Promise.reject(new Error("unused")); }
  public patchMetadata(): Promise<never> { return Promise.reject(new Error("unused")); }
  public resolveInteraction(): Promise<never> { return Promise.reject(new Error("unused")); }
  public getCommand(): Promise<CommandRecord | null> {
    this.commandReads += 1;
    if (this.getCommandError) return Promise.reject(this.getCommandError);
    return Promise.resolve(this.recoveredCommand);
  }
  public detach(): Promise<never> { return Promise.reject(new Error("unused")); }
  public forceDetach(): Promise<never> { return Promise.reject(new Error("unused")); }
  public promote(): Promise<never> { return Promise.reject(new Error("unused")); }

  #terminal(input: TerminalGetInput): TerminalDescriptor {
    const runtime = this.snapshot.runtimeNodes.find(
      (candidate) => candidate.runtimeNodeId === input.runtimeNodeId,
    )!;
    return {
      ...input,
      runtimeNodeBootId: runtime.runtimeNodeBootId,
      terminalId: this.terminalId,
      backend: "mock",
      sharing: "session",
      foregroundSessionId: null,
      state: "running",
      dimensions: { columns: 80, rows: 24 },
      sequence: 0,
      lease: null,
      capabilities: {
        write: true,
        resize: true,
        terminate: true,
        restart: true,
        foregroundSwitch: false,
      },
      openedAt: timestamp,
      updatedAt: timestamp,
      exit: null,
    };
  }
}

function authority(controlNodeId = newControlNodeId(), realmId = newRealmId()): AuthorityRef {
  return { realmId, controlNodeId, epochId: newAuthorityEpochId() };
}

function controlNode(
  controlNodeId: ReturnType<typeof newControlNodeId>,
  authorityRef: AuthorityRef,
): ControlNodeDescriptor {
  return {
    controlNodeId,
    controlNodeBootId: newControlNodeBootId(),
    feedId: newFeedId(),
    name: controlNodeId,
    presence: "online",
    dataRole: controlNodeId === authorityRef.controlNodeId
      ? { role: "authority", authority: authorityRef }
      : {
          role: "branch",
          authority: authorityRef,
          branch: {
            lifecycle: "attached",
            parentControlNodeId: authorityRef.controlNodeId,
            attachmentId: newControlNodeId(),
            lineageId: newControlNodeId(),
            attachedAt: timestamp,
          },
        },
    connectedAt: timestamp,
    lastHeartbeatAt: timestamp,
    protocolVersion: 4,
    capabilities: [],
  };
}

function snapshot(
  authorityRef: AuthorityRef,
  ids: readonly ReturnType<typeof newControlNodeId>[],
  options: { withSession?: boolean } = {},
): GatewaySourceSnapshot {
  const sourceControlNodeId = ids[0]!;
  const manifest: SourceManifest = {
    componentKind: "control-node",
    protocolVersion: 4,
    sourceControlNodeId,
    sourceControlNodeBootId: newControlNodeBootId(),
    authority: authorityRef,
    projectionRootControlNodeId: sourceControlNodeId,
    coveredControlNodeIds: [...ids],
    feedId: newFeedId(),
    controlCursor: 0,
    generatedAt: timestamp,
    capabilities: [],
  };
  const runtimeNodeId = newRuntimeNodeId();
  const runtimeNodes: RuntimeNodeDescriptor[] = options.withSession
    ? [{
        runtimeNodeId,
        runtimeNodeBootId: newRuntimeNodeBootId(),
        ownerControlNodeId: sourceControlNodeId,
        name: "runtime",
        presence: "online",
        reachability: "reachable",
        connectedAt: timestamp,
        lastHeartbeatAt: timestamp,
        allowedRoots: ["/work"],
        harnesses: [],
        launchProfiles: [],
        protocolVersion: 4,
      }]
    : [];
  const sessions: SessionRecord[] = options.withSession
    ? [{
        sessionId: newSessionId(),
        runtimeNodeId,
        harness: "codex",
        adapterScopeId: "codex-test",
        vendorSessionId: "native-1",
        bindingRevision: 1,
        runtimeEpoch: null,
        cwd: "/work",
        availability: "active",
        runtimeStatus: "idle",
        launchProvenance: null,
        metadata: emptyMetadataSnapshot(),
        metadataAuthority: authorityRef,
        catalogState: "open",
        catalogRevision: 1,
        archivedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastSeenAt: timestamp,
        lastActivityAt: timestamp,
      }]
    : [];
  const controlNodes = ids.map((id) => controlNode(id, authorityRef)).map(
    (record) => record.controlNodeId === sourceControlNodeId
      ? {
          ...record,
          controlNodeBootId: manifest.sourceControlNodeBootId,
          feedId: manifest.feedId,
        }
      : record,
  );
  return {
    manifest,
    parentByControlNodeId: Object.fromEntries(
      ids.map((id, index) => [id, index === 0 ? null : ids[index - 1]!]),
    ),
    controlNodes,
    runtimeNodes,
    sessions,
    interactions: [],
    metadataOperations: [],
  };
}

function source(sourceId: string, value: GatewaySourceSnapshot, priority = 0) {
  return {
    sourceId: sourceId as SourceId,
    displayName: sourceId,
    endpointId: `endpoint-${sourceId}`,
    priority,
    client: new FakeSource(value),
  };
}

function overlappingSnapshots(
  authorityRef: AuthorityRef,
  root: ReturnType<typeof newControlNodeId>,
  child: ReturnType<typeof newControlNodeId>,
  options: { withSession?: boolean } = {},
) {
  const descendant = snapshot(authorityRef, [child], options);
  const ancestorBase = snapshot(authorityRef, [root, child]);
  const descendantControl = descendant.controlNodes[0]!;
  const ancestor: GatewaySourceSnapshot = {
    ...ancestorBase,
    controlNodes: ancestorBase.controlNodes.map((record) =>
      record.controlNodeId === child ? descendantControl : record
    ),
    runtimeNodes: descendant.runtimeNodes,
    sessions: descendant.sessions,
  };
  return { ancestor, descendant };
}

function nativeEvent(
  session: SessionRecord,
  sourceSnapshot: GatewaySourceSnapshot,
  runtimeEpoch: ReturnType<typeof newRuntimeNodeBootId>,
  sequence: number,
): Extract<AccessStreamItem, { kind: "native" }> {
  return {
    kind: "native",
    sessionId: session.sessionId,
    harness: session.harness,
    runtimeEpoch,
    sequence,
    nativeType: `test/${sequence}`,
    payload: { sequence },
    ephemeral: false,
    provenance: {
      originControlNodeId: sourceSnapshot.manifest.sourceControlNodeId,
      authority: sourceSnapshot.manifest.authority,
    },
  };
}

describe("AccessGatewayProjection source selection", () => {
  it("selects the ancestor projection and keeps a descendant warm", async () => {
    const root = newControlNodeId();
    const child = newControlNodeId();
    const fence = authority(root);
    const snapshots = overlappingSnapshots(fence, root, child);
    const ancestor = source("ancestor", snapshots.ancestor);
    const descendant = source("descendant", snapshots.descendant);
    const gateway = new AccessGatewayProjection([descendant, ancestor]);

    await gateway.refreshAll();

    expect(gateway.diagnostics()).toMatchObject([
      { sourceId: "ancestor", state: "selected" },
      { sourceId: "descendant", state: "suppressed", selectedBySourceId: "ancestor" },
    ]);
    expect(gateway.listControlNodes()).toHaveLength(2);

    gateway.markUnavailable("ancestor" as SourceId);
    expect(gateway.diagnostics()).toMatchObject([
      { sourceId: "ancestor", state: "unavailable" },
      { sourceId: "descendant", state: "selected" },
    ]);
    expect(gateway.listControlNodes()).toHaveLength(1);
  });

  it("coexists with disjoint siblings and independent realms", async () => {
    const leftId = newControlNodeId();
    const rightId = newControlNodeId();
    const gateway = new AccessGatewayProjection([
      source("left", snapshot(authority(leftId), [leftId])),
      source("right", snapshot(authority(rightId), [rightId])),
    ]);
    await gateway.refreshAll();
    expect(gateway.diagnostics().map(({ state }) => state)).toEqual(["selected", "selected"]);
    expect(gateway.listControlNodes()).toHaveLength(2);
  });

  it("quarantines a domain identity duplicated across disjoint trees", async () => {
    const left = snapshot(authority(), [newControlNodeId()], { withSession: true });
    const rightBase = snapshot(authority(), [newControlNodeId()], { withSession: true });
    const right: GatewaySourceSnapshot = {
      ...rightBase,
      sessions: [{
        ...rightBase.sessions[0]!,
        sessionId: left.sessions[0]!.sessionId,
      }],
    };
    const gateway = new AccessGatewayProjection([
      source("left", left),
      source("right", right),
    ]);

    await gateway.refreshAll();

    expect(gateway.diagnostics()).toMatchObject([
      { state: "conflict", reason: expect.stringContaining("duplicated across disjoint") },
      { state: "conflict", reason: expect.stringContaining("duplicated across disjoint") },
    ]);
    expect(gateway.listSessions()).toEqual([]);
  });

  it("quarantines epoch conflicts and non-hierarchical partial overlap", async () => {
    const root = newControlNodeId();
    const left = newControlNodeId();
    const right = newControlNodeId();
    const realm = newRealmId();
    const firstFence = authority(root, realm);
    const secondFence = { ...firstFence, epochId: newAuthorityEpochId() };
    const epochConflict = new AccessGatewayProjection([
      source("old", snapshot(firstFence, [root])),
      source("new", snapshot(secondFence, [root])),
    ]);
    await epochConflict.refreshAll();
    expect(epochConflict.diagnostics().map(({ state }) => state)).toEqual(["conflict", "conflict"]);

    const partial = new AccessGatewayProjection([
      source("a", snapshot(firstFence, [root, left])),
      source("b", snapshot(firstFence, [root, right])),
    ]);
    await partial.refreshAll();
    expect(partial.diagnostics().map(({ state }) => state)).toEqual(["conflict", "conflict"]);
  });

  it("quarantines immutable overlap forks but permits a monotonically stale standby", async () => {
    const root = newControlNodeId();
    const child = newControlNodeId();
    const fence = authority(root);
    const compatible = overlappingSnapshots(fence, root, child, { withSession: true });
    const ancestorSession = compatible.ancestor.sessions[0]!;
    const newerAncestor: GatewaySourceSnapshot = {
      ...compatible.ancestor,
      sessions: [{
        ...ancestorSession,
        metadata: {
          revision: 1,
          values: { "agent.title": "newer authority value" },
          keyRevisions: { "agent.title": 1 },
        },
      }],
    };
    const lagging = new AccessGatewayProjection([
      source("ancestor", newerAncestor),
      source("descendant", compatible.descendant),
    ]);
    await lagging.refreshAll();
    expect(lagging.diagnostics()).toMatchObject([
      { sourceId: "ancestor", state: "selected" },
      { sourceId: "descendant", state: "suppressed" },
    ]);
    lagging.markUnavailable("ancestor" as SourceId);
    expect(lagging.diagnostics()).toMatchObject([
      { sourceId: "ancestor", state: "unavailable" },
      { sourceId: "descendant", state: "selected" },
    ]);

    const forked = overlappingSnapshots(fence, root, child, { withSession: true });
    const descendantSession = forked.descendant.sessions[0]!;
    const forkedDescendant: GatewaySourceSnapshot = {
      ...forked.descendant,
      sessions: [{
        ...descendantSession,
        vendorSessionId: "forked-native-session",
      }],
    };
    const conflict = new AccessGatewayProjection([
      source("ancestor", forked.ancestor),
      source("descendant", forkedDescendant),
    ]);
    await conflict.refreshAll();
    expect(conflict.diagnostics()).toMatchObject([
      { state: "conflict", reason: expect.stringContaining("conflicting native binding") },
      { state: "conflict", reason: expect.stringContaining("conflicting native binding") },
    ]);
  });

  it("rechecks a suppressed source against the last selected snapshot at failover", async () => {
    const root = newControlNodeId();
    const child = newControlNodeId();
    const fence = authority(root);
    const snapshots = overlappingSnapshots(fence, root, child, { withSession: true });
    const gateway = new AccessGatewayProjection([
      source("ancestor", snapshots.ancestor),
      source("descendant", snapshots.descendant),
    ]);
    await gateway.refreshAll();
    const session = snapshots.descendant.sessions[0]!;
    const divergent = {
      revision: session.metadata.revision,
      values: { "agent.title": "forked-at-the-same-revision" },
      keyRevisions: { "agent.title": session.metadata.revision },
    };
    expect(gateway.ingest("descendant" as SourceId, {
      kind: "control",
      eventId: "00000000-0000-4000-8000-000000000001",
      feedId: snapshots.descendant.manifest.feedId,
      cursor: 1,
      provenance: {
        originControlNodeId: child,
        authority: fence,
      },
      change: {
        type: "metadata.changed",
        sessionId: session.sessionId,
        metadata: divergent,
      },
    })).toBe(false);

    gateway.markUnavailable("ancestor" as SourceId);

    expect(gateway.diagnostics()).toMatchObject([
      { sourceId: "ancestor", state: "unavailable" },
      {
        sourceId: "descendant",
        state: "conflict",
        reason: expect.stringContaining("unsafe warm failover"),
      },
    ]);
    expect(gateway.listSessions()).toEqual([]);
  });

  it("applies the same warm-failover fence when a selected refresh fails", async () => {
    const root = newControlNodeId();
    const child = newControlNodeId();
    const fence = authority(root);
    const snapshots = overlappingSnapshots(fence, root, child, { withSession: true });
    const ancestor = source("ancestor", snapshots.ancestor);
    const descendant = source("descendant", snapshots.descendant);
    const gateway = new AccessGatewayProjection([ancestor, descendant]);
    await gateway.refreshAll();
    const session = descendant.client.snapshot.sessions[0]!;
    expect(gateway.ingest("descendant" as SourceId, {
      kind: "control",
      eventId: "00000000-0000-4000-8000-000000000002",
      feedId: descendant.client.snapshot.manifest.feedId,
      cursor: 1,
      provenance: { originControlNodeId: child, authority: fence },
      change: {
        type: "session.upsert",
        session: { ...session, vendorSessionId: "forked-after-snapshot" },
      },
    })).toBe(false);
    // The suppressed stream accepted this valid local projection update; the
    // selected ancestor's last snapshot remains the failover fence.
    ancestor.client.loadError = new Error("selected source refresh failed");

    await expect(gateway.refreshSource("ancestor" as SourceId)).rejects.toThrow(
      "selected source refresh failed",
    );
    gateway.markUnavailable(
      "ancestor" as SourceId,
      new Error("supervisor observed the same failure"),
    );

    expect(gateway.diagnostics()).toMatchObject([
      { sourceId: "ancestor", state: "unavailable" },
      { sourceId: "descendant", state: "conflict" },
    ]);
  });
});

describe("AccessGatewayProjection routing and feed", () => {
  it("routes a launch exactly once through the selected ancestor", async () => {
    const root = newControlNodeId();
    const child = newControlNodeId();
    const fence = authority(root);
    const profile = {
      profileId: "review.container",
      providerId: "example.container",
      contractVersion: 1,
      requestSchemaHash: "a".repeat(64),
      implementationVersion: "test",
      harnesses: ["codex" as const],
      available: true,
      capabilities: [],
    };
    const snapshots = overlappingSnapshots(fence, root, child, { withSession: true });
    const advertise = (value: GatewaySourceSnapshot): GatewaySourceSnapshot => ({
      ...value,
      runtimeNodes: value.runtimeNodes.map((runtime) => ({
        ...runtime,
        launchProfiles: [profile],
      })),
    });
    const ancestor = source("ancestor", advertise(snapshots.ancestor));
    const descendant = source("descendant", advertise(snapshots.descendant));
    ancestor.client.omitUndefinedLaunchFields = true;
    const gateway = new AccessGatewayProjection([ancestor, descendant]);
    await gateway.refreshAll();
    const runtimeNodeId = gateway.listRuntimeNodes()[0]!.runtimeNodeId;
    const request = {
      launchId: newLaunchId(),
      payloadHash: "0123456789abcdef",
      sessionId: newSessionId(),
      runtimeNodeId,
      profile: {
        profileId: profile.profileId,
        providerId: profile.providerId,
        contractVersion: profile.contractVersion,
        requestSchemaHash: profile.requestSchemaHash,
      },
      harness: "codex" as const,
      input: { pullRequestUrl: "https://example.test/org/repo/pull/42" },
      metadata: undefined,
    };

    await expect(gateway.createLaunch(request)).resolves.toMatchObject({
      launchId: request.launchId,
      state: "accepted",
    });
    expect(ancestor.client.launchDispatches).toBe(1);
    expect(descendant.client.launchDispatches).toBe(0);
    await expect(gateway.getLaunch(request.launchId)).resolves.toMatchObject({
      launchId: request.launchId,
    });

    await expect(gateway.createLaunch({
      ...request,
      launchId: newLaunchId(),
      profile: {
        ...request.profile,
        requestSchemaHash: "b".repeat(64),
      },
    })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "launch profile compatibility fence changed",
    });
    await expect(gateway.createLaunch({
      ...request,
      launchId: newLaunchId(),
      profile: {
        ...request.profile,
        contractVersion: request.profile.contractVersion + 1,
      },
    })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(ancestor.client.launchDispatches).toBe(1);
    expect(descendant.client.launchDispatches).toBe(0);
  });

  it("gives statically composed plugins only the restricted launch port", async () => {
    const root = newControlNodeId();
    const gateway = new AccessGatewayProjection([
      source("only", snapshot(authority(root), [root], { withSession: true })),
    ]);
    await gateway.refreshAll();
    const port = createGatewayLaunchPort(gateway);
    expect(Object.isFrozen(port)).toBe(true);
    expect(Object.keys(port).sort()).toEqual([
      "create",
      "get",
      "getSession",
      "list",
      "listModels",
      "listProfiles",
      "listRuntimeNodes",
    ]);
    expect("patchMetadata" in port).toBe(false);
    const runtimeNodes = port.listRuntimeNodes();
    expect(Object.isFrozen(runtimeNodes)).toBe(true);
    expect(runtimeNodes.every((runtime) => Object.isFrozen(runtime))).toBe(true);
    expect(Object.isFrozen(runtimeNodes[0]?.launchProfiles)).toBe(true);
    expect(() => {
      (runtimeNodes[0] as { name: string }).name = "plugin mutation";
    }).toThrow();
    expect(gateway.listRuntimeNodes()[0]?.name).toBe("runtime");
    const session = await port.getSession(gateway.listSessions()[0]!.sessionId);
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session?.metadata)).toBe(true);
    const plugins = instantiateGatewayPlugins([{
      pluginId: "review.pull_request",
      implementationVersion: "1.0.0",
      createRouter: (launchPort) => ({ launchPort }),
    }], port);
    expect(plugins["review.pull_request"]?.launchPort).toBe(port);

    let createCalls = 0;
    expect(() => instantiateGatewayPlugins([{
      pluginId: "review.pull_request",
      implementationVersion: "1",
      createRouter: () => {
        createCalls += 1;
        return {};
      },
    }, {
      pluginId: "review.pull_request",
      implementationVersion: "2",
      createRouter: () => ({}),
    }], port)).toThrow("duplicate gateway plugin ID");
    expect(createCalls).toBe(0);
    expect(() => instantiateGatewayPlugins([{
      pluginId: "not-namespaced",
      implementationVersion: "1",
      createRouter: () => ({}),
    }], port)).toThrow("namespaced lowercase identifiers");
    expect(() => instantiateGatewayPlugins([{
      pluginId: "review.empty_version",
      implementationVersion: "   ",
      createRouter: () => ({}),
    }], port)).toThrow("has no implementation version");
    for (const implementationVersion of [
      `1.${"x".repeat(255)}`,
      " 1.0.0",
      "1.0.0\n",
    ]) {
      expect(() => instantiateGatewayPlugins([{
        pluginId: "review.invalid_version",
        implementationVersion,
        createRouter: () => ({}),
      }], port)).toThrow("has an invalid implementation version");
    }
  });

  it("routes terminals only through the selected ancestor and fences its stream on failover", async () => {
    const root = newControlNodeId();
    const child = newControlNodeId();
    const fence = authority(root);
    const snapshots = overlappingSnapshots(fence, root, child, { withSession: true });
    const ancestor = source("ancestor", snapshots.ancestor);
    const descendant = source("descendant", snapshots.descendant);
    const gateway = new AccessGatewayProjection([ancestor, descendant]);
    await gateway.refreshAll();
    const session = gateway.listSessions()[0]!;
    const target = {
      sessionId: session.sessionId,
      runtimeNodeId: session.runtimeNodeId,
      bindingRevision: session.bindingRevision,
    };

    const terminal = await gateway.getTerminal(target);
    expect(terminal?.terminalId).toBe(ancestor.client.terminalId);
    expect(ancestor.client.terminalReads).toBe(1);
    expect(descendant.client.terminalReads).toBe(0);

    const iterator = gateway.attachTerminal({
      ...target,
      terminalId: terminal!.terminalId,
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "heartbeat", cursor: { terminalId: terminal!.terminalId } },
    });
    expect(ancestor.client.terminalAttaches).toBe(1);
    expect(descendant.client.terminalAttaches).toBe(0);

    gateway.markUnavailable("ancestor" as SourceId);
    await expect(iterator.next()).rejects.toMatchObject({ code: "CONFLICT" });
    await iterator.return?.();
  });

  it("rejects a terminal source replay ending at another high-water sequence", async () => {
    const root = newControlNodeId();
    const definition = source("only", snapshot(authority(root), [root], { withSession: true }));
    const gateway = new AccessGatewayProjection([definition]);
    await gateway.refreshAll();
    const session = gateway.listSessions()[0]!;
    const target = {
      sessionId: session.sessionId,
      runtimeNodeId: session.runtimeNodeId,
      bindingRevision: session.bindingRevision,
    };
    const descriptor = await definition.client.getTerminal(target);
    definition.client.terminalStreamItems = [{
      kind: "replayStart",
      cursor: { terminalId: descriptor.terminalId, sequence: 0 },
      initialDimensions: descriptor.dimensions,
      terminal: { ...descriptor, sequence: 2 },
    }, {
      kind: "replayEnd",
      cursor: { terminalId: descriptor.terminalId, sequence: 1 },
      terminal: { ...descriptor, sequence: 1 },
    }];

    const iterator = gateway.attachTerminal({
      ...target,
      terminalId: descriptor.terminalId,
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { kind: "replayStart" },
    });
    await expect(iterator.next()).rejects.toThrow(
      "terminal source replay ended outside its advertised high-water fence",
    );
    await iterator.return?.();
  });

  it("dispatches a mutation exactly once and reports an unknown outcome", async () => {
    const root = newControlNodeId();
    const definition = source("only", snapshot(authority(root), [root], { withSession: true }));
    definition.client.executeError = new Error("connection lost after dispatch");
    const gateway = new AccessGatewayProjection([definition]);
    await gateway.refreshAll();
    const session = gateway.listSessions()[0]!;
    const command = {
      commandId: newSessionId(),
      payloadHash: "0123456789abcdef",
      sessionId: session.sessionId,
      runtimeNodeId: session.runtimeNodeId,
      bindingRevision: 1,
      request: { harness: "codex" as const, command: { type: "interrupt" as const } },
    };

    await expect(gateway.execute(command)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(definition.client.dispatches).toBe(1);
  });

  it("preserves a definitive source rejection instead of claiming ambiguity", async () => {
    const root = newControlNodeId();
    const definition = source("only", snapshot(authority(root), [root], { withSession: true }));
    definition.client.executeError = new GatewayRoutingError(
      "CONFLICT",
      "control node rejected a stale binding",
    );
    const gateway = new AccessGatewayProjection([definition]);
    await gateway.refreshAll();
    const session = gateway.listSessions()[0]!;

    await expect(gateway.execute({
      commandId: newSessionId(),
      payloadHash: "0123456789abcdef",
      sessionId: session.sessionId,
      runtimeNodeId: session.runtimeNodeId,
      bindingRevision: 1,
      request: { harness: "codex", command: { type: "interrupt" } },
    })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "control node rejected a stale binding",
    });
    expect(definition.client.dispatches).toBe(1);
  });

  it("invalidates cached command routing when a warm descendant takes over", async () => {
    const root = newControlNodeId();
    const child = newControlNodeId();
    const fence = authority(root);
    const snapshots = overlappingSnapshots(fence, root, child, { withSession: true });
    const ancestor = source("ancestor", snapshots.ancestor);
    const descendant = source("descendant", snapshots.descendant);
    const gateway = new AccessGatewayProjection([ancestor, descendant]);
    await gateway.refreshAll();
    const session = gateway.listSessions()[0]!;
    const command = {
      commandId: newSessionId(),
      payloadHash: "0123456789abcdef",
      sessionId: session.sessionId,
      runtimeNodeId: session.runtimeNodeId,
      bindingRevision: session.bindingRevision,
      request: { harness: "codex" as const, command: { type: "interrupt" as const } },
    };
    const record = await gateway.execute(command);
    ancestor.client.recoveredCommand = record;
    descendant.client.recoveredCommand = record;
    ancestor.client.getCommandError = new Error("ancestor transport is offline");

    gateway.markUnavailable("ancestor" as SourceId);

    await expect(gateway.getCommand(command.commandId)).resolves.toEqual(record);
    expect(ancestor.client.commandReads).toBe(0);
    expect(descendant.client.commandReads).toBe(1);
  });

  it("rotates its synthetic feed on source selection and deduplicates native events", async () => {
    const root = newControlNodeId();
    const definition = source("only", snapshot(authority(root), [root], { withSession: true }));
    const gateway = new AccessGatewayProjection([definition]);
    const events: AccessStreamItem[] = [];
    const controller = new AbortController();
    const consume = (async () => {
      for await (const event of gateway.watch(controller.signal)) events.push(event);
    })();
    await gateway.refreshAll();
    const session = gateway.listSessions()[0]!;
    const native: AccessStreamItem = {
      kind: "native",
      sessionId: session.sessionId,
      harness: "codex",
      runtimeEpoch: newRuntimeNodeBootId(),
      sequence: 0,
      nativeType: "test",
      payload: { ok: true },
      ephemeral: false,
      provenance: {
        originControlNodeId: root,
        authority: definition.client.snapshot.manifest.authority,
      },
    };
    expect(gateway.ingest("only" as SourceId, native)).toBe(true);
    expect(gateway.ingest("only" as SourceId, native)).toBe(false);
    await Promise.resolve();
    controller.abort();
    await consume;
    expect(events.map(({ kind }) => kind)).toEqual([
      "heartbeat",
      "streamReset",
      "native",
    ]);
  });

  it("replays uncommitted native events from a session cursor without duplicates", async () => {
    const root = newControlNodeId();
    const definition = source("only", snapshot(authority(root), [root], { withSession: true }));
    const gateway = new AccessGatewayProjection([definition]);
    await gateway.refreshAll();
    const session = gateway.listSessions()[0]!;
    const runtimeEpoch = newRuntimeNodeBootId();
    const first = nativeEvent(session, definition.client.snapshot, runtimeEpoch, 0);
    const second = nativeEvent(session, definition.client.snapshot, runtimeEpoch, 1);
    expect(gateway.ingest("only" as SourceId, first)).toBe(true);
    expect(gateway.ingest("only" as SourceId, second)).toBe(true);

    const iterator = gateway.attach({
      sessions: [session.sessionId],
      includeNative: true,
      cursor: {
        feedId: gateway.feedId(),
        controlCursor: 0,
        native: {
          [session.sessionId]: { runtimeEpoch, sequence: 0 },
        },
      },
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: "native", sessionId: session.sessionId, sequence: 1 },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: "heartbeat" },
      done: false,
    });

    expect(gateway.ingest("only" as SourceId, second)).toBe(false);
    const third = nativeEvent(session, definition.client.snapshot, runtimeEpoch, 2);
    expect(gateway.ingest("only" as SourceId, third)).toBe(true);
    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: "native", sessionId: session.sessionId, sequence: 2 },
      done: false,
    });
    await iterator.return?.();
  });

  it("emits a native history recovery gap when the bounded journal expired", async () => {
    const root = newControlNodeId();
    const definition = source("only", snapshot(authority(root), [root], { withSession: true }));
    const gateway = new AccessGatewayProjection(
      [definition],
      () => new Date(timestamp),
      2,
    );
    await gateway.refreshAll();
    const session = gateway.listSessions()[0]!;
    const runtimeEpoch = newRuntimeNodeBootId();
    for (let sequence = 0; sequence < 4; sequence += 1) {
      expect(gateway.ingest(
        "only" as SourceId,
        nativeEvent(session, definition.client.snapshot, runtimeEpoch, sequence),
      )).toBe(true);
    }

    const iterator = gateway.attach({
      sessions: [session.sessionId],
      includeNative: true,
      cursor: {
        feedId: gateway.feedId(),
        controlCursor: 0,
        native: {
          [session.sessionId]: { runtimeEpoch, sequence: 0 },
        },
      },
    })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        kind: "nativeGap",
        sessionId: session.sessionId,
        recovery: "readNativeHistory",
        reason: "gateway native journal begins at sequence 2",
      },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { kind: "heartbeat" },
      done: false,
    });
    await iterator.return?.();
  });

  it("replays a replacement runtime epoch and clears native replay on feed rotation", async () => {
    const root = newControlNodeId();
    const definition = source("only", snapshot(authority(root), [root], { withSession: true }));
    const gateway = new AccessGatewayProjection([definition]);
    await gateway.refreshAll();
    const session = gateway.listSessions()[0]!;
    const oldEpoch = newRuntimeNodeBootId();
    const newEpoch = newRuntimeNodeBootId();
    expect(gateway.ingest(
      "only" as SourceId,
      nativeEvent(session, definition.client.snapshot, oldEpoch, 0),
    )).toBe(true);
    expect(gateway.ingest(
      "only" as SourceId,
      nativeEvent(session, definition.client.snapshot, newEpoch, 0),
    )).toBe(true);

    const replacement = gateway.attach({
      sessions: [session.sessionId],
      includeNative: true,
      cursor: {
        feedId: gateway.feedId(),
        controlCursor: 0,
        native: {
          [session.sessionId]: { runtimeEpoch: oldEpoch, sequence: 0 },
        },
      },
    })[Symbol.asyncIterator]();
    await expect(replacement.next()).resolves.toMatchObject({
      value: { kind: "native", runtimeEpoch: newEpoch, sequence: 0 },
      done: false,
    });
    await replacement.return?.();

    gateway.markUnavailable("only" as SourceId);
    await gateway.refreshSource("only" as SourceId);
    const afterRotation = gateway.attach({
      sessions: [session.sessionId],
      includeNative: true,
      cursor: {
        feedId: gateway.feedId(),
        controlCursor: 0,
        native: {},
      },
    })[Symbol.asyncIterator]();
    await expect(afterRotation.next()).resolves.toMatchObject({
      value: { kind: "heartbeat" },
      done: false,
    });
    await afterRotation.return?.();
  });

  it("fails and unregisters a subscriber whose bounded mailbox overflows", async () => {
    const root = newControlNodeId();
    const definition = source("only", snapshot(authority(root), [root]));
    const gateway = new AccessGatewayProjection([definition]);
    await gateway.refreshAll();

    const iterator = gateway.watch()[Symbol.asyncIterator]();
    const heartbeat: AccessStreamItem = {
      kind: "heartbeat",
      feedId: definition.client.snapshot.manifest.feedId,
      controlCursor: definition.client.snapshot.manifest.controlCursor,
      authorityRefs: [definition.client.snapshot.manifest.authority],
    };
    for (let index = 0; index <= AccessGatewayProjection.maximumSubscriberItems; index += 1) {
      expect(gateway.ingest("only" as SourceId, heartbeat)).toBe(true);
    }

    await expect(iterator.next()).rejects.toEqual(
      expect.objectContaining({
        name: "GatewaySubscriberOverflowError",
        capacity: AccessGatewayProjection.maximumSubscriberItems,
      }),
    );
    await expect(iterator.next()).rejects.toBeInstanceOf(GatewaySubscriberOverflowError);
    const healthyIterator = gateway.watch()[Symbol.asyncIterator]();
    await expect(healthyIterator.next()).resolves.toMatchObject({
      value: { kind: "heartbeat" },
      done: false,
    });
    await healthyIterator.return?.();
  });

  it("bounds the source-diagnostic subscriber mailbox too", async () => {
    const root = newControlNodeId();
    const template = source("template", snapshot(authority(root), [root]));
    const definitions = Array.from(
      { length: AccessGatewayProjection.maximumSubscriberItems + 1 },
      (_, index) => ({
        ...template,
        sourceId: `source-${index}` as SourceId,
        displayName: `Source ${index}`,
        endpointId: `endpoint-${index}`,
      }),
    );
    const gateway = new AccessGatewayProjection(definitions);

    await expect(
      gateway.watchSources()[Symbol.asyncIterator]().next(),
    ).rejects.toBeInstanceOf(GatewaySubscriberOverflowError);
  });

  it("immediately closes already-aborted access and diagnostic subscriptions", async () => {
    const root = newControlNodeId();
    const gateway = new AccessGatewayProjection([
      source("only", snapshot(authority(root), [root])),
    ]);
    const signal = AbortSignal.abort();

    await expect(gateway.watch(signal)[Symbol.asyncIterator]().next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
    await expect(gateway.watchSources(signal)[Symbol.asyncIterator]().next()).resolves.toEqual({
      value: undefined,
      done: true,
    });
  });
});

describe("GatewayOperationalStore", () => {
  it("persists only source configuration, health, and cursors", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-multiplex-gateway-"));
    const filename = join(directory, "gateway.sqlite");
    try {
      const store = new GatewayOperationalStore(filename);
      store.putSource({
        sourceId: "root" as SourceId,
        displayName: "Root",
        endpointId: "endpoint-root",
        locator: { kind: "ticket", ticket: "redacted-in-real-config" },
        priority: 10,
        enabled: true,
        feedId: newFeedId(),
        controlCursor: 42,
        health: { state: "selected" },
        updatedAt: timestamp,
      });
      expect(store.listSources()).toMatchObject([{
        sourceId: "root",
        endpointId: "endpoint-root",
        priority: 10,
        controlCursor: 42,
      }]);
      expect(store.diagnostics()).toMatchObject({ userVersion: 3, applicationId: 0x414d_4757 });
      store.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
