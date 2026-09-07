import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adapterScopeIdSchema,
  canonicalJson,
  emptyMetadataSnapshot,
  launchMetadataOperationId,
  newArchiveOperationId,
  newAuthorityEpochId,
  newCommandId,
  newControlNodeId,
  newLaunchId,
  newOperationId,
  newRealmId,
  newRuntimeEpoch,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  toJsonValue,
  type ArchiveRecord,
  type HarnessCatalogEntry,
  type HarnessCommand,
  type HarnessResumeOptions,
  type HarnessSpawnOptions,
  type JsonObject,
  type JsonValue,
  type LaunchBackendId,
  type LaunchRecord,
  type LaunchRequest,
  type NativeHistoryRequest,
  type NativeHistoryResult,
  type NativeInventoryItem,
  type NativeModel,
  type RuntimeNodeSessionRecord,
  type SessionRuntimeStatus,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";

import {
  AdapterOutcomeUnknownError,
  DirectWorkspaceLaunchProvider,
  LaunchProviderOutcomeUnknownError,
  RuntimeNodeService,
  RuntimeNodeStore,
  jsonSchemaSha256,
  type AdapterEvent,
  type AdapterSession,
  type AgentAdapter,
  type LaunchPreparationContext,
  type LaunchRecoveryResult,
  type LaunchSessionContext,
  type RuntimeAgentBackend,
  type RuntimeLaunchProvider,
  type RuntimePreparedLaunch,
} from "../src/index.js";

class FakeSession implements AdapterSession {
  public readonly runtimeEpoch = newRuntimeEpoch();
  readonly #listeners = new Set<(event: AdapterEvent) => void>();
  #status: SessionRuntimeStatus = "idle";

  public constructor(
    public readonly adapterScopeId: ReturnType<typeof adapterScopeIdSchema.parse>,
    public readonly vendorSessionId: string,
    public readonly cwd: string,
  ) {}

  public readonly harness = "codex" as const;

  public status(): SessionRuntimeStatus {
    return this.#status;
  }

  public subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public emit(event: AdapterEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  public execute(_command: HarnessCommand): Promise<JsonValue | undefined> {
    return Promise.resolve({ ok: true });
  }

  public readNativeHistory(_request: NativeHistoryRequest): Promise<NativeHistoryResult> {
    return Promise.resolve({
      harness: "codex",
      vendorSessionId: this.vendorSessionId,
      payload: { history: true },
      complete: true,
    });
  }

  public stop(): Promise<void> {
    this.#status = "stopped";
    for (const listener of [...this.#listeners]) {
      listener({ kind: "status", status: "stopped" });
    }
    return Promise.resolve();
  }
}

class FakeAdapter implements AgentAdapter {
  public readonly harness = "codex" as const;
  public readonly adapterScopeId = adapterScopeIdSchema.parse("codex-test");
  public readonly spawned: HarnessSpawnOptions[] = [];
  public readonly resumed: HarnessResumeOptions[] = [];
  public readonly sessions = new Map<string, FakeSession>();
  public spawnFailure: unknown;

  public describe(): Promise<HarnessCatalogEntry> {
    return Promise.resolve({
      harness: "codex",
      adapterScopeId: this.adapterScopeId,
      available: true,
      capabilities: [],
    });
  }

  public listModels(): Promise<NativeModel[]> {
    return Promise.resolve([{ harness: "codex", id: "gpt-test" }]);
  }

  public listSessions(): Promise<NativeInventoryItem[]> {
    return Promise.resolve([...this.sessions.values()].map((session) => ({
      harness: "codex",
      adapterScopeId: this.adapterScopeId,
      vendorSessionId: session.vendorSessionId,
      cwd: session.cwd,
      availability: session.status() === "stopped" ? "resumable" : "active",
      runtimeStatus: session.status(),
      runtimeEpoch: session.status() === "stopped" ? null : session.runtimeEpoch,
      lastActivityAt: new Date().toISOString(),
    })));
  }

  public spawn(options: HarnessSpawnOptions): Promise<AdapterSession> {
    this.spawned.push(options);
    if (this.spawnFailure !== undefined) return Promise.reject(this.spawnFailure);
    const session = new FakeSession(
      this.adapterScopeId,
      `native-${this.spawned.length}`,
      options.cwd,
    );
    this.sessions.set(session.vendorSessionId, session);
    return Promise.resolve(session);
  }

  public resume(options: HarnessResumeOptions): Promise<AdapterSession> {
    this.resumed.push(options);
    const session = new FakeSession(
      this.adapterScopeId,
      options.vendorSessionId,
      options.cwd!,
    );
    this.sessions.set(session.vendorSessionId, session);
    return Promise.resolve(session);
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

const requestSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["cwd"],
  properties: { cwd: { type: "string" } },
  additionalProperties: false,
} as JsonObject;

class FakeProvider implements RuntimeLaunchProvider {
  public readonly descriptor = {
    profileId: "test",
    providerId: "test.container",
    contractVersion: 1,
    requestSchemaHash: jsonSchemaSha256(requestSchema),
    implementationVersion: "1.2.3",
    harnesses: ["codex" as const],
    available: true,
    capabilities: [],
  };
  public readonly requestSchema = requestSchema;
  public readonly calls: string[] = [];
  public prepareFailure: unknown;
  public recovery: LaunchRecoveryResult = { state: "retryPreparation" };

  public constructor(
    public readonly backendId: LaunchBackendId,
  ) {}

  public validateInput(input: JsonObject): JsonObject {
    if (typeof input.cwd !== "string") throw new TypeError("cwd is required");
    return input;
  }

  public async prepare(context: LaunchPreparationContext): Promise<RuntimePreparedLaunch> {
    this.calls.push("prepare");
    context.saveCheckpoint({ phase: "prepared-resource" });
    if (this.prepareFailure !== undefined) throw this.prepareFailure;
    return {
      backendId: this.backendId,
      spawnOptions: {
        harness: "codex",
        cwd: String(context.request.input.cwd),
      },
      providerState: { resourceId: "container-1" },
    };
  }

  public recoverPreparation(): Promise<LaunchRecoveryResult> {
    this.calls.push("recover");
    return Promise.resolve(this.recovery);
  }

  public compensate(_context: LaunchPreparationContext): Promise<void> {
    this.calls.push("compensate");
    return Promise.resolve();
  }

  public stop(_context: LaunchSessionContext): Promise<void> {
    this.calls.push("provider-stop");
    return Promise.resolve();
  }

  public release(_context: LaunchSessionContext): Promise<void> {
    this.calls.push("provider-release");
    return Promise.resolve();
  }
}

describe("runtime v4 launch providers", () => {
  it("durably records a definite input-validation failure before provider work", async () => {
    const fixture = createProviderFixture();
    const request = launchRequest(
      fixture.runtimeNodeId,
      fixture.provider.descriptor,
      {},
    );

    expect(fixture.service.createLaunch(request)).toMatchObject({
      state: "failed",
      error: "cwd is required",
    });
    expect(fixture.service.getLaunch(request.launchId)).toMatchObject({
      state: "failed",
      error: "cwd is required",
    });
    expect(fixture.adapter.spawned).toHaveLength(0);
    expect(fixture.provider.calls).toHaveLength(0);

    await fixture.service.close();
    fixture.store.close();
  });

  it("deduplicates launch retries when transport preserves explicit undefined optionals", async () => {
    const fixture = createProviderFixture();
    const base = launchRequest(
      fixture.runtimeNodeId,
      fixture.provider.descriptor,
      { cwd: fixture.root },
    );
    const request: LaunchRequest = { ...base, metadata: undefined };

    expect(fixture.service.createLaunch(request)).toMatchObject({ state: "accepted" });
    await waitForLaunch(fixture.service, request.launchId, "succeeded");
    expect(() => fixture.service.createLaunch(request)).not.toThrow();
    expect(fixture.adapter.spawned).toHaveLength(1);

    await fixture.service.close();
    fixture.store.close();
  });

  it("durably accepts then asynchronously binds a direct-workspace launch", async () => {
    const root = mkdtempSync(join(tmpdir(), "multiplex-v4-direct-"));
    const adapter = new FakeAdapter();
    const storeFilename = join(root, "runtime.sqlite");
    const store = new RuntimeNodeStore(storeFilename);
    const runtimeNodeId = newRuntimeNodeId();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "direct test",
      allowedRoots: [root],
      adapters: [adapter],
    });
    const profile = service.listLaunchProfiles()[0]!;
    const request = launchRequest(runtimeNodeId, profile, { cwd: root });

    expect(service.createLaunch(request)).toMatchObject({ state: "accepted" });
    expect(store.getLaunch(request.launchId)?.state).toBe("accepted");
    const succeeded = await waitForLaunch(service, request.launchId, "succeeded");
    expect(succeeded.result).toMatchObject({
      sessionId: request.sessionId,
      adapterScopeId: adapter.adapterScopeId,
      backendId: `codex:${adapter.adapterScopeId}`,
    });
    expect(store.getSession(request.sessionId)).toMatchObject({
      availability: "active",
      runtimeStatus: "idle",
      metadata: { values: { "test.title": "direct" } },
      launchProvenance: {
        launchId: request.launchId,
        providerId: profile.providerId,
        implementationVersion: profile.implementationVersion,
      },
    });

    const authority = {
      realmId: newRealmId(),
      controlNodeId: newControlNodeId(),
      epochId: newAuthorityEpochId(),
    };
    service.applyCanonicalSessions([{
      ...store.getSession(request.sessionId)!,
      metadata: emptyMetadataSnapshot(),
      metadataAuthority: authority,
      catalogState: "open",
      catalogRevision: 1,
      archivedAt: null,
    }]);
    expect(service.metadataOutbox()).toEqual([{
      operationId: launchMetadataOperationId(request.launchId),
      sessionId: request.sessionId,
      expectedAuthority: authority,
      set: request.metadata,
      ifKeyRevision: { "test.title": null },
    }]);
    expect(store.getSession(request.sessionId)?.metadata).toEqual(emptyMetadataSnapshot());
    expect(service.getMetadata(request.sessionId).values).toEqual(request.metadata);

    // Reconciliation is repeatable: the launch deterministically derives a
    // separate initialization-operation ID, so retries do not duplicate or
    // mutate the durable proposal.
    service.applyCanonicalSessions([{
      ...store.getSession(request.sessionId)!,
      metadata: emptyMetadataSnapshot(),
      metadataAuthority: authority,
      catalogState: "open",
      catalogRevision: 1,
      archivedAt: null,
    }]);
    expect(service.metadataOutbox()).toHaveLength(1);
    expect(service.createLaunch(request)).toEqual(succeeded);
    expect(adapter.spawned).toHaveLength(1);
    expect((await service.describe()).protocolVersion).toBe(5);

    await service.close();
    store.close();
    const reopened = new RuntimeNodeStore(storeFilename);
    expect(reopened.listMetadataOutbox()).toEqual([{
      operationId: launchMetadataOperationId(request.launchId),
      sessionId: request.sessionId,
      expectedAuthority: authority,
      set: request.metadata,
      ifKeyRevision: { "test.title": null },
    }]);
    reopened.close();
  });

  it("replays a durable logical binding before buffered native events", async () => {
    const fixture = createProviderFixture();
    const request = launchRequest(
      fixture.runtimeNodeId,
      fixture.provider.descriptor,
      { cwd: fixture.root },
    );
    fixture.service.createLaunch(request);
    await waitForLaunch(fixture.service, request.launchId, "succeeded");
    fixture.adapter.sessions.get("native-1")!.emit({
      kind: "native",
      nativeType: "item/agentMessage/delta",
      payload: { delta: "hello" },
      ephemeral: false,
    });

    const iterator = fixture.service.events({ native: {} })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        kind: "control",
        change: {
          type: "session.upsert",
          session: { sessionId: request.sessionId, vendorSessionId: "native-1" },
        },
      },
      done: false,
    });
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        kind: "native",
        sessionId: request.sessionId,
        sequence: 0,
        nativeType: "item/agentMessage/delta",
      },
      done: false,
    });
    await iterator.return?.();

    await fixture.service.close();
    fixture.store.close();
  });

  it("replays stopped bindings after restart and resumes only on an explicit command", async () => {
    const fixture = createProviderFixture();
    const request = launchRequest(fixture.runtimeNodeId, fixture.provider.descriptor, { cwd: fixture.root });
    fixture.service.createLaunch(request);
    await waitForLaunch(fixture.service, request.launchId, "succeeded");
    const before = fixture.store.getSession(request.sessionId)!;
    await fixture.service.close();

    const restarted = fixture.makeService();
    const expected = { sessionId: request.sessionId, availability: "resumable", runtimeStatus: "stopped", runtimeEpoch: null };
    expect(fixture.store.getSession(request.sessionId)).toMatchObject({ ...before, ...expected, updatedAt: expect.any(String), lastSeenAt: expect.any(String) });
    const iterator = restarted.events({ native: {} })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { kind: "control", change: { type: "session.upsert", session: expected } } });
    await iterator.return?.();
    expect((await restarted.refreshInventory()).sessions[0]).toMatchObject({ availability: "resumable", runtimeStatus: "stopped", runtimeEpoch: null });
    expect(fixture.adapter.resumed).toHaveLength(0);
    const resumed = await restarted.resume({ operation: "resume", commandId: newCommandId(), payloadHash: "0123456789abcdef", sessionId: request.sessionId, runtimeNodeId: fixture.runtimeNodeId, bindingRevision: 1 });
    expect(resumed.state).toBe("succeeded");
    expect(fixture.adapter.resumed).toHaveLength(1);
    expect((await restarted.refreshInventory()).sessions[0]).toMatchObject({ availability: "active", runtimeStatus: "idle" });
    await restarted.close();
    fixture.store.close();
  });

  it("does not advertise a temporary history attachment as command-ready", async () => {
    const fixture = createProviderFixture();
    const request = launchRequest(fixture.runtimeNodeId, fixture.provider.descriptor, { cwd: fixture.root });
    fixture.service.createLaunch(request);
    await waitForLaunch(fixture.service, request.launchId, "succeeded");
    await fixture.service.stop({ operation: "stop", commandId: newCommandId(), payloadHash: "0123456789abcdef", sessionId: request.sessionId, runtimeNodeId: fixture.runtimeNodeId, bindingRevision: 1 });
    let attached!: () => void;
    const attachedPromise = new Promise<void>(resolve => { attached = resolve; });
    let finish!: () => void;
    const reading = new Promise<void>(resolve => { finish = resolve; });
    const resume = fixture.adapter.resume.bind(fixture.adapter);
    fixture.adapter.resume = async options => {
      const handle = await resume(options);
      const read = handle.readNativeHistory.bind(handle);
      handle.readNativeHistory = async request => { attached(); await reading; return read(request); };
      return handle;
    };
    const history = fixture.service.readNativeHistory(request.sessionId, { harness: "codex", limit: 20 });
    await attachedPromise;
    expect((await fixture.adapter.listSessions())[0]).toMatchObject({ availability: "active" });
    expect((await fixture.service.refreshInventory()).sessions[0]).toMatchObject({ availability: "resumable", runtimeStatus: "stopped", runtimeEpoch: null });
    finish();
    await history;
    await fixture.service.close();
    fixture.store.close();
  });

  it("streams durable binding replay beyond the live subscriber mailbox", async () => {
    const fixture = createProviderFixture();
    const timestamp = new Date().toISOString();
    const bindingCount = 4_200;
    for (let index = 0; index < bindingCount; index += 1) {
      fixture.store.putSession({
        sessionId: newSessionId(),
        runtimeNodeId: fixture.runtimeNodeId,
        harness: "codex",
        adapterScopeId: fixture.adapter.adapterScopeId,
        vendorSessionId: `bulk-native-${index}`,
        bindingRevision: 1,
        runtimeEpoch: null,
        cwd: fixture.root,
        availability: "resumable",
        runtimeStatus: "stopped",
        launchProvenance: null,
        metadata: { revision: 0, values: {}, keyRevisions: {} },
        createdAt: timestamp,
        updatedAt: timestamp,
        lastSeenAt: timestamp,
        lastActivityAt: timestamp,
      });
    }

    const iterator = fixture.service.events({ native: {} })[Symbol.asyncIterator]();
    const observed = new Set<string>();
    for (let index = 0; index < bindingCount; index += 1) {
      const item = await iterator.next();
      expect(item.done).toBe(false);
      if (item.value?.kind === "control" && item.value.change.type === "session.upsert") {
        observed.add(item.value.change.session.vendorSessionId);
      }
    }
    expect(observed.size).toBe(bindingCount);
    expect(observed).toContain("bulk-native-4199");
    await iterator.return?.();

    await fixture.service.close();
    fixture.store.close();
  });

  it("compensates definite preparation failure but never compensates an ambiguous native start", async () => {
    const first = createProviderFixture();
    first.provider.prepareFailure = new Error("clone failed");
    const definite = launchRequest(
      first.runtimeNodeId,
      first.provider.descriptor,
      { cwd: first.root },
    );
    first.service.createLaunch(definite);
    await expect(waitForLaunch(first.service, definite.launchId, "failed")).resolves.toMatchObject({
      error: "clone failed",
    });
    expect(first.provider.calls).toEqual(["prepare", "compensate"]);
    await first.service.close();
    first.store.close();

    const second = createProviderFixture();
    second.adapter.spawnFailure = new AdapterOutcomeUnknownError("connection lost after start");
    const ambiguous = launchRequest(
      second.runtimeNodeId,
      second.provider.descriptor,
      { cwd: second.root },
    );
    second.service.createLaunch(ambiguous);
    await expect(
      waitForLaunch(second.service, ambiguous.launchId, "outcomeUnknown"),
    ).resolves.toMatchObject({ error: "connection lost after start" });
    expect(second.provider.calls).toEqual(["prepare"]);
    await second.service.close();
    second.store.close();
  });

  it("recovers preparing work through the provider and fences nativeStarting as unknown", async () => {
    const recovered = createProviderFixture({ constructService: false });
    const retry = launchRequest(
      recovered.runtimeNodeId,
      recovered.provider.descriptor,
      { cwd: recovered.root },
    );
    seedLaunch(recovered.store, retry, recovered.provider, "preparing", {
      checkpoint: { phase: "clone-created" },
    });
    const recoveredService = recovered.makeService();
    await waitForLaunch(recoveredService, retry.launchId, "succeeded");
    expect(recovered.provider.calls.slice(0, 2)).toEqual(["recover", "prepare"]);
    expect(recovered.adapter.spawned).toHaveLength(1);
    await recoveredService.close();
    recovered.store.close();

    const unknown = createProviderFixture({ constructService: false });
    const dispatched = launchRequest(
      unknown.runtimeNodeId,
      unknown.provider.descriptor,
      { cwd: unknown.root },
    );
    seedLaunch(unknown.store, dispatched, unknown.provider, "nativeStarting", {
      preparation: {
        backendId: unknown.backend.backendId,
        spawnOptions: { harness: "codex", cwd: unknown.root },
      },
    });
    const unknownService = unknown.makeService();
    await expect(
      waitForLaunch(unknownService, dispatched.launchId, "outcomeUnknown"),
    ).resolves.toMatchObject({ error: expect.stringContaining("restarted after native") });
    expect(unknown.adapter.spawned).toHaveLength(0);
    expect(unknown.provider.calls).toHaveLength(0);
    await unknownService.close();
    unknown.store.close();
  });

  it("stops immediately and archives in backend-then-provider order", async () => {
    const filename = join(
      mkdtempSync(join(tmpdir(), "multiplex-v4-tombstone-")),
      "runtime.sqlite",
    );
    const fixture = createProviderFixture({ filename });
    const releaseOrder: string[] = [];
    fixture.backend.releaseSession = () => {
      releaseOrder.push("backend-release");
      return Promise.resolve();
    };
    const originalRelease = fixture.provider.release.bind(fixture.provider);
    fixture.provider.release = async (context) => {
      releaseOrder.push("provider-release");
      await originalRelease(context);
    };
    const request = launchRequest(
      fixture.runtimeNodeId,
      fixture.provider.descriptor,
      { cwd: fixture.root },
    );
    fixture.service.createLaunch(request);
    await waitForLaunch(fixture.service, request.launchId, "succeeded");
    const stop = await fixture.service.stop({
      operation: "stop",
      commandId: newCommandId(),
      payloadHash: "0123456789abcdef",
      sessionId: request.sessionId,
      runtimeNodeId: request.runtimeNodeId,
      bindingRevision: 1,
    });
    expect(stop.state).toBe("succeeded");
    expect(fixture.store.getSession(request.sessionId)).toMatchObject({
      availability: "resumable",
      runtimeStatus: "stopped",
      runtimeEpoch: null,
    });
    expect(fixture.provider.calls).toContain("provider-stop");

    const authority = {
      realmId: newRealmId(),
      controlNodeId: newControlNodeId(),
      epochId: newAuthorityEpochId(),
    };
    fixture.store.putSession({
      ...fixture.store.getSession(request.sessionId)!,
      metadataAuthority: authority,
    });
    const archiveRequest = {
      archiveOperationId: newArchiveOperationId(),
      payloadHash: "fedcba9876543210",
      sessionId: request.sessionId,
      runtimeNodeId: request.runtimeNodeId,
      bindingRevision: 1,
      expectedAuthority: authority,
    };
    expect(fixture.service.archive(archiveRequest).state).toBe("accepted");
    expect(() => fixture.service.enqueueMetadata({
      operationId: newOperationId(),
      sessionId: request.sessionId,
      expectedAuthority: authority,
      set: { "archive.race": true },
    })).toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    await waitForArchive(fixture.service, archiveRequest.archiveOperationId, "succeeded");
    expect(releaseOrder).toEqual(["backend-release", "provider-release"]);
    expect(fixture.store.getSession(request.sessionId)).toBeUndefined();
    expect(fixture.store.listArchivedNativeBindings()).toMatchObject([{
      sessionId: request.sessionId,
      vendorSessionId: "native-1",
      launchProvenance: { launchId: request.launchId },
    }]);
    expect((await fixture.service.refreshInventory()).sessions).toEqual([]);

    await fixture.service.close();
    fixture.store.close();

    const reopenedStore = new RuntimeNodeStore(filename);
    const reopenedService = new RuntimeNodeService({
      store: reopenedStore,
      runtimeNodeId: fixture.runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "restarted provider test",
      allowedRoots: [fixture.root],
      backends: [fixture.backend],
      launchProviders: [fixture.provider],
      includeDirectWorkspaceProvider: false,
    });
    expect((await reopenedService.refreshInventory()).sessions).toEqual([]);
    await reopenedService.close();
    reopenedStore.close();
  });

  it("keeps a stopped binding when archive cleanup fails", async () => {
    const fixture = createProviderFixture();
    const request = launchRequest(
      fixture.runtimeNodeId,
      fixture.provider.descriptor,
      { cwd: fixture.root },
    );
    fixture.service.createLaunch(request);
    await waitForLaunch(fixture.service, request.launchId, "succeeded");
    await fixture.service.stop({
      operation: "stop",
      commandId: newCommandId(),
      payloadHash: "0123456789abcdef",
      sessionId: request.sessionId,
      runtimeNodeId: request.runtimeNodeId,
      bindingRevision: 1,
    });
    const authority = {
      realmId: newRealmId(),
      controlNodeId: newControlNodeId(),
      epochId: newAuthorityEpochId(),
    };
    fixture.store.putSession({
      ...fixture.store.getSession(request.sessionId)!,
      metadataAuthority: authority,
    });
    fixture.backend.releaseSession = () => Promise.reject(new Error("container busy"));
    const archiveRequest = {
      archiveOperationId: newArchiveOperationId(),
      payloadHash: "fedcba9876543210",
      sessionId: request.sessionId,
      runtimeNodeId: request.runtimeNodeId,
      bindingRevision: 1,
      expectedAuthority: authority,
    };
    fixture.service.archive(archiveRequest);
    await expect(
      waitForArchive(fixture.service, archiveRequest.archiveOperationId, "failed"),
    ).resolves.toMatchObject({ error: "container busy" });
    expect(fixture.store.getSession(request.sessionId)).toMatchObject({
      availability: "resumable",
      runtimeStatus: "stopped",
    });
    expect(fixture.provider.calls).not.toContain("provider-release");

    await fixture.service.close();
    fixture.store.close();
  });

  it("refuses archive while agent-authored metadata is still pending delivery", async () => {
    const fixture = createProviderFixture();
    const request = launchRequest(
      fixture.runtimeNodeId,
      fixture.provider.descriptor,
      { cwd: fixture.root },
    );
    fixture.service.createLaunch(request);
    await waitForLaunch(fixture.service, request.launchId, "succeeded");
    await fixture.service.stop({
      operation: "stop",
      commandId: newCommandId(),
      payloadHash: "0123456789abcdef",
      sessionId: request.sessionId,
      runtimeNodeId: request.runtimeNodeId,
      bindingRevision: 1,
    });
    const authority = {
      realmId: newRealmId(),
      controlNodeId: newControlNodeId(),
      epochId: newAuthorityEpochId(),
    };
    fixture.store.putSession({
      ...fixture.store.getSession(request.sessionId)!,
      metadataAuthority: authority,
    });
    fixture.service.enqueueMetadata({
      operationId: newOperationId(),
      sessionId: request.sessionId,
      expectedAuthority: authority,
      set: { "review.unsent": true },
    });
    const archiveRequest = {
      archiveOperationId: newArchiveOperationId(),
      payloadHash: "fedcba9876543210",
      sessionId: request.sessionId,
      runtimeNodeId: request.runtimeNodeId,
      bindingRevision: 1,
      expectedAuthority: authority,
    };

    expect(() => fixture.service.archive(archiveRequest)).toThrowError(
      expect.objectContaining({ code: "CONFLICT" }),
    );
    expect(fixture.service.getArchive(archiveRequest.archiveOperationId)).toBeNull();
    expect(fixture.store.getSession(request.sessionId)).toMatchObject({
      availability: "resumable",
      runtimeStatus: "stopped",
    });
    expect(fixture.service.metadataOutbox()).toHaveLength(1);

    await fixture.service.close();
    fixture.store.close();
  });
});

describe("runtime store v3 to v5", () => {
  it("adds launch journals and backfills runtime session fields", () => {
    const filename = join(
      mkdtempSync(join(tmpdir(), "multiplex-v4-migration-")),
      "runtime.sqlite",
    );
    const initial = new RuntimeNodeStore(filename);
    const timestamp = new Date().toISOString();
    const legacyCompatible: RuntimeNodeSessionRecord = {
      sessionId: newSessionId(),
      runtimeNodeId: newRuntimeNodeId(),
      harness: "codex",
      adapterScopeId: adapterScopeIdSchema.parse("legacy"),
      vendorSessionId: "legacy-native",
      bindingRevision: 1,
      runtimeEpoch: null,
      cwd: "/tmp",
      availability: "resumable",
      runtimeStatus: "stopped",
      launchProvenance: null,
      metadata: { revision: 0, values: {}, keyRevisions: {} },
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSeenAt: timestamp,
      lastActivityAt: timestamp,
    };
    initial.putSession(legacyCompatible);
    initial.close();

    const downgrade = new DatabaseSync(filename);
    const legacyJson = { ...legacyCompatible } as Record<string, unknown>;
    delete legacyJson.launchProvenance;
    delete legacyJson.lastActivityAt;
    downgrade.prepare("UPDATE bindings SET record_json=? WHERE session_id=?")
      .run(JSON.stringify(legacyJson), legacyCompatible.sessionId);
    downgrade.exec(
      "DROP TABLE images; DROP TABLE launch_journal; DROP TABLE archive_journal; DROP TABLE archived_native_bindings",
    );
    downgrade.prepare("DELETE FROM schema_migrations WHERE version>=4").run();
    downgrade.exec("PRAGMA user_version=3");
    downgrade.close();

    const migrated = new RuntimeNodeStore(filename);
    expect(migrated.diagnostics().userVersion).toBe(5);
    expect(migrated.getSession(legacyCompatible.sessionId)).toMatchObject({
      launchProvenance: null,
      lastActivityAt: timestamp,
    });
    migrated.close();
  });
});

function createProviderFixture(
  options: { constructService?: boolean; filename?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "multiplex-v4-provider-"));
  const store = new RuntimeNodeStore(options.filename ?? ":memory:");
  const runtimeNodeId = newRuntimeNodeId();
  const adapter = new FakeAdapter();
  const backend: RuntimeAgentBackend = {
    backendId: "test-backend" as LaunchBackendId,
    adapter,
  };
  const provider = new FakeProvider(backend.backendId);
  const makeService = () => new RuntimeNodeService({
    store,
    runtimeNodeId,
    runtimeNodeBootId: newRuntimeNodeBootId(),
    name: "provider test",
    allowedRoots: [root],
    backends: [backend],
    launchProviders: [provider],
    includeDirectWorkspaceProvider: false,
  });
  const service = options.constructService === false ? undefined : makeService();
  return { root, store, runtimeNodeId, adapter, backend, provider, service: service!, makeService };
}

function launchRequest(
  runtimeNodeId: ReturnType<typeof newRuntimeNodeId>,
  profile: FakeProvider["descriptor"] | DirectWorkspaceLaunchProvider["descriptor"],
  input: JsonObject,
): LaunchRequest {
  const requestWithoutHash = {
    launchId: newLaunchId(),
    sessionId: newSessionId(),
    runtimeNodeId,
    profile: {
      profileId: profile.profileId,
      providerId: profile.providerId,
      contractVersion: profile.contractVersion,
      requestSchemaHash: profile.requestSchemaHash,
    },
    harness: "codex" as const,
    input,
    metadata: { "test.title": "direct" },
  };
  return {
    ...requestWithoutHash,
    payloadHash: hashish(requestWithoutHash),
  };
}

function hashish(value: unknown): string {
  // The runtime treats the caller's hash as an idempotency fence; canonical
  // content here keeps tests deterministic without duplicating client crypto.
  return canonicalJson(toJsonValue(value)).padEnd(16, "0").slice(0, 256);
}

function seedLaunch(
  store: RuntimeNodeStore,
  request: LaunchRequest,
  provider: FakeProvider,
  state: "preparing" | "nativeStarting",
  options: {
    checkpoint?: JsonObject;
    preparation?: RuntimePreparedLaunch;
  },
): void {
  const timestamp = new Date().toISOString();
  store.putLaunchEntry({
    request,
    record: {
      ...request,
      implementationVersion: provider.descriptor.implementationVersion,
      state,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    checkpoint: options.checkpoint ?? null,
    preparation: options.preparation ?? null,
    pendingFailure: null,
  });
}

async function waitForLaunch(
  service: RuntimeNodeService,
  launchId: LaunchRequest["launchId"],
  state: LaunchRecord["state"],
): Promise<LaunchRecord> {
  return eventually(() => {
    const record = service.getLaunch(launchId);
    return record?.state === state ? record : undefined;
  });
}

async function waitForArchive(
  service: RuntimeNodeService,
  archiveOperationId: Parameters<RuntimeNodeService["getArchive"]>[0],
  state: ArchiveRecord["state"],
): Promise<ArchiveRecord> {
  return eventually(() => {
    const record = service.getArchive(archiveOperationId);
    return record?.state === state ? record : undefined;
  });
}

async function eventually<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for durable state");
}
