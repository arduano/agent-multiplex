import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adapterScopeIdSchema,
  emptyMetadataSnapshot,
  launchMetadataOperationId,
  newAuthorityEpochId,
  newControlNodeId,
  newLaunchId,
  newRealmId,
  newRuntimeEpoch,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  type AdapterScopeId,
  type ControlNodeAttachment,
  type HarnessCatalogEntry,
  type HarnessCommand,
  type HarnessResumeOptions,
  type HarnessSpawnOptions,
  type JsonValue,
  type LaunchProfileDescriptor,
  type LaunchRequest,
  type MetadataOperationRecord,
  type NativeHistoryRequest,
  type NativeHistoryResult,
  type NativeInventoryItem,
  type NativeModel,
  type RuntimeNodeSessionRecord,
} from "@arduano/agent-multiplex-protocol";
import {
  ControlNodeCatalog,
  ControlNodeService,
  type MetadataUpstreamConnection,
  type RuntimeNodeConnection,
  type RuntimeNodeIngressContext,
} from "@arduano/agent-multiplex-control-node-core";
import {
  RuntimeNodeService,
  RuntimeNodeStore,
  type AdapterEvent,
  type AdapterSession,
  type AgentAdapter,
} from "@arduano/agent-multiplex-runtime-node-core";
import { describe, expect, it } from "vitest";

const now = "2040-07-08T09:10:11.000Z";
const clock = () => new Date(now);

function stateFile(label: string): string {
  return join(
    mkdtempSync(join(tmpdir(), `agent-multiplex-launch-metadata-${label}-`)),
    "state.sqlite",
  );
}

class TestSession implements AdapterSession {
  public readonly harness = "codex" as const;
  public readonly runtimeEpoch = newRuntimeEpoch();

  public constructor(
    public readonly adapterScopeId: AdapterScopeId,
    public readonly vendorSessionId: string,
    public readonly cwd: string,
  ) {}

  public status() { return "idle" as const; }
  public subscribe(_listener: (event: AdapterEvent) => void) { return () => undefined; }
  public execute(_command: HarnessCommand): Promise<JsonValue> {
    return Promise.resolve({ ok: true });
  }
  public readNativeHistory(_request: NativeHistoryRequest): Promise<NativeHistoryResult> {
    return Promise.resolve({
      harness: "codex",
      vendorSessionId: this.vendorSessionId,
      payload: { encoding: "native-json-images-v1", json: {}, images: [] },
      complete: true,
    });
  }
  public stop(): Promise<void> { return Promise.resolve(); }
}

class TestAdapter implements AgentAdapter {
  public readonly harness = "codex" as const;
  public readonly adapterScopeId = adapterScopeIdSchema.parse("launch-metadata-codex");
  readonly #sessions: TestSession[] = [];

  public describe(): Promise<HarnessCatalogEntry> {
    return Promise.resolve({
      harness: this.harness,
      adapterScopeId: this.adapterScopeId,
      available: true,
      capabilities: [],
    });
  }
  public listModels(): Promise<NativeModel[]> {
    return Promise.resolve([{ harness: "codex", id: "test-model" }]);
  }
  public listSessions(): Promise<NativeInventoryItem[]> {
    return Promise.resolve(this.#sessions.map((session) => ({
      harness: session.harness,
      adapterScopeId: session.adapterScopeId,
      vendorSessionId: session.vendorSessionId,
      cwd: session.cwd,
      availability: "active",
      runtimeStatus: "idle",
      runtimeEpoch: session.runtimeEpoch,
      lastActivityAt: now,
    })));
  }
  public spawn(options: HarnessSpawnOptions): Promise<AdapterSession> {
    const session = new TestSession(
      this.adapterScopeId,
      `native-${this.#sessions.length + 1}`,
      options.cwd,
    );
    this.#sessions.push(session);
    return Promise.resolve(session);
  }
  public resume(_options: HarnessResumeOptions): Promise<AdapterSession> {
    return Promise.reject(new Error("unused"));
  }
  public close(): Promise<void> { return Promise.resolve(); }
}

interface RuntimeFixture {
  readonly cwd: string;
  readonly store: RuntimeNodeStore;
  readonly service: RuntimeNodeService;
  readonly runtimeNodeBootId: ReturnType<typeof newRuntimeNodeBootId>;
  readonly connection: RuntimeNodeConnection;
  readonly context: Required<Pick<
    RuntimeNodeIngressContext,
    "endpointId" | "authenticatedRuntimeNodeId"
  >>;
}

function runtimeFixture(label: string): RuntimeFixture {
  const cwd = mkdtempSync(join(tmpdir(), `agent-multiplex-runtime-${label}-`));
  const store = new RuntimeNodeStore(stateFile(`runtime-${label}`));
  const runtimeNodeId = newRuntimeNodeId();
  const runtimeNodeBootId = newRuntimeNodeBootId();
  const service = new RuntimeNodeService({
    store,
    runtimeNodeId,
    runtimeNodeBootId,
    name: `runtime-${label}`,
    allowedRoots: [cwd],
    adapters: [new TestAdapter()],
  });
  const unused = () => Promise.reject(new Error("unused"));
  const connection: RuntimeNodeConnection = {
    runtimeNodeId,
    runtimeNodeBootId,
    endpointId: `runtime-endpoint-${label}`,
    refreshInventory: () => service.refreshInventory(),
    listModels: (harness) => service.listModels(harness),
    listLaunchProfiles: async () => service.listLaunchProfiles(),
    listLaunchProfileModels: (profile, harness) =>
      service.listLaunchProfileModels(profile, harness),
    createLaunch: async (request) => service.createLaunch(request),
    getLaunch: async (launchId) => service.getLaunch(launchId) ?? null,
    listLaunches: async (query) => service.listLaunches(query),
    resume: unused,
    stop: unused,
    archive: unused,
    getArchive: unused,
    execute: unused,
    readNativeHistory: unused,
    resolveInteraction: unused,
    applyMetadata: async (operation) => service.applyMetadataSettlement(operation),
  };
  return {
    cwd,
    store,
    service,
    runtimeNodeBootId,
    connection,
    context: {
      endpointId: connection.endpointId!,
      authenticatedRuntimeNodeId: runtimeNodeId,
    },
  };
}

async function registerRuntime(
  control: ControlNodeService,
  runtime: RuntimeFixture,
): Promise<void> {
  control.registerRuntimeNode(await runtime.service.describe(), {
    ...runtime.context,
    runtimeNodeConnection: runtime.connection,
  });
}

function launchRequest(
  runtime: RuntimeFixture,
  profile: LaunchProfileDescriptor,
  label: string,
): LaunchRequest {
  return {
    launchId: newLaunchId(),
    payloadHash: `launch-metadata-${label}`.padEnd(32, "0"),
    sessionId: newSessionId(),
    runtimeNodeId: runtime.connection.runtimeNodeId,
    profile: {
      providerId: profile.providerId,
      profileId: profile.profileId,
      contractVersion: profile.contractVersion,
      requestSchemaHash: profile.requestSchemaHash,
    },
    harness: "codex",
    input: { cwd: runtime.cwd, model: "test-model" },
    metadata: {
      "agent.title": `Launch ${label}`,
      "test.run_id": label,
    },
  };
}

async function waitForSucceededLaunch(
  runtime: RuntimeFixture,
  request: LaunchRequest,
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const launch = runtime.service.getLaunch(request.launchId);
    if (launch?.state === "succeeded") return launch;
    if (launch?.state === "failed" || launch?.state === "outcomeUnknown") {
      throw new Error(`launch settled as ${launch.state}: ${launch.error ?? "unknown"}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("launch did not settle");
}

async function publishBoundSession(
  control: ControlNodeService,
  runtime: RuntimeFixture,
  request: LaunchRequest,
): Promise<void> {
  await waitForSucceededLaunch(runtime, request);
  const binding = runtime.store.getSession(request.sessionId);
  if (!binding) throw new Error("runtime did not persist the launched binding");

  // Even a correctly authenticated runtime cannot smuggle arbitrary metadata
  // through its liveness/native-binding record.
  const untrusted: RuntimeNodeSessionRecord = {
    ...binding,
    metadata: {
      revision: 99,
      values: { "attacker.injected": true },
      keyRevisions: { "attacker.injected": 99 },
    },
  };
  control.publishRuntimeEvent({
    runtimeNodeId: runtime.connection.runtimeNodeId,
    runtimeNodeBootId: runtime.runtimeNodeBootId,
    event: {
      kind: "control",
      change: { type: "session.upsert", session: untrusted },
    },
  }, runtime.context);
  expect(control.catalog.getSession(request.sessionId)?.metadata)
    .toEqual(emptyMetadataSnapshot());
}

function attach(
  parent: ControlNodeCatalog,
  child: ControlNodeCatalog,
  endpointId: string,
): ControlNodeAttachment {
  const descriptor = child.localControlNode();
  const { attachment } = parent.attachChild({
    controlNodeId: descriptor.controlNodeId,
    controlNodeBootId: descriptor.controlNodeBootId,
    feedId: descriptor.feedId,
    name: descriptor.name,
    endpointId,
    protocolVersion: 5,
    capabilities: descriptor.capabilities,
    expectedParentControlNodeId: parent.localControlNode().controlNodeId,
    childProof: child.attachmentProof(),
  });
  child.applyParentAttachment(attachment, `parent-${endpointId}`);
  return attachment;
}

describe("protocol-v4 launch metadata authority path", () => {
  it("durably proposes launch metadata after direct control reconciliation", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("direct-control"), now: clock });
    const control = new ControlNodeService({ catalog, now: clock });
    const runtime = runtimeFixture("direct");
    await registerRuntime(control, runtime);
    const profile = runtime.service.listLaunchProfiles()[0]!;
    const request = launchRequest(runtime, profile, "direct");

    await expect(control.createLaunch(request)).resolves.toMatchObject({ state: "accepted" });
    await publishBoundSession(control, runtime, request);
    const canonical = catalog.getSession(request.sessionId)!;

    runtime.service.applyCanonicalSessions([canonical]);
    const patches = runtime.service.metadataOutbox();
    expect(patches).toEqual([{
      operationId: launchMetadataOperationId(request.launchId),
      sessionId: request.sessionId,
      expectedAuthority: canonical.metadataAuthority,
      set: request.metadata,
      ifKeyRevision: {
        "agent.title": null,
        "test.run_id": null,
      },
    }]);

    const settled = await control.pushRuntimeMetadataOutbox({
      runtimeNodeId: runtime.connection.runtimeNodeId,
      runtimeNodeBootId: runtime.runtimeNodeBootId,
      patches,
    }, runtime.context);
    expect(settled).toMatchObject([{
      operationId: launchMetadataOperationId(request.launchId),
      status: "accepted",
      canonical: { values: request.metadata },
    }]);
    runtime.service.settleMetadataOutbox(settled);
    runtime.service.applyCanonicalSessions([catalog.getSession(request.sessionId)!]);

    expect(catalog.searchSessions({
      states: ["running"],
      metadata: [{ operator: "equals", key: "test.run_id", value: "direct" }],
    }).sessions.map((session) => session.sessionId)).toEqual([request.sessionId]);
    expect(runtime.service.getMetadata(request.sessionId).values).toEqual(request.metadata);
    expect(runtime.service.metadataOutbox()).toEqual([]);

    // A later topology transition establishes a new authority epoch but does
    // not make already-settled creation metadata pending again.
    runtime.service.applyCanonicalSessions([{
      ...catalog.getSession(request.sessionId)!,
      metadataAuthority: {
        realmId: newRealmId(),
        controlNodeId: newControlNodeId(),
        epochId: newAuthorityEpochId(),
      },
    }]);
    expect(runtime.service.metadataOutbox()).toEqual([]);

    control.close();
    catalog.close();
    await runtime.service.close();
    runtime.store.close();
  });

  it("settles launch metadata through an attached branch without trusting its session upsert", async () => {
    const rootCatalog = new ControlNodeCatalog({ filename: stateFile("nested-root"), now: clock });
    const leafCatalog = new ControlNodeCatalog({ filename: stateFile("nested-leaf"), now: clock });
    const childEndpointId = "launch-metadata-leaf";
    const attachment = attach(rootCatalog, leafCatalog, childEndpointId);
    const root = new ControlNodeService({ catalog: rootCatalog, now: clock });
    const childFence = {
      controlNodeId: leafCatalog.localControlNode().controlNodeId,
      controlNodeBootId: leafCatalog.localControlNode().controlNodeBootId,
      attachmentId: attachment.attachmentId,
      lineageId: attachment.lineageId,
    };
    const childContext = {
      authenticatedControlNodeId: leafCatalog.localControlNode().controlNodeId,
      endpointId: childEndpointId,
    };
    const upstream: MetadataUpstreamConnection = {
      pushMetadataOutbox: (operations) => root.pushChildMetadataOutbox(
        { ...childFence, operations: [...operations] },
        childContext,
      ),
    };
    const leaf = new ControlNodeService({
      catalog: leafCatalog,
      metadataUpstream: upstream,
      now: clock,
    });
    const runtime = runtimeFixture("nested");
    await registerRuntime(leaf, runtime);
    const profile = runtime.service.listLaunchProfiles()[0]!;
    const request = launchRequest(runtime, profile, "nested");

    await expect(leaf.createLaunch(request)).resolves.toMatchObject({ state: "accepted" });
    await publishBoundSession(leaf, runtime, request);
    const leafSession = leafCatalog.getSession(request.sessionId)!;
    runtime.service.applyCanonicalSessions([leafSession]);

    const queued = await leaf.pushRuntimeMetadataOutbox({
      runtimeNodeId: runtime.connection.runtimeNodeId,
      runtimeNodeBootId: runtime.runtimeNodeBootId,
      patches: runtime.service.metadataOutbox(),
    }, runtime.context);
    expect(queued).toMatchObject([{
      operationId: launchMetadataOperationId(request.launchId),
      status: "queued",
    }]);
    runtime.service.settleMetadataOutbox(queued);

    // The metadata outbox and aggregate session feed are independently
    // ordered. Once the root imports the matching session, retrying the same
    // durable proposal commits it at the tree authority.
    rootCatalog.replaceChildSnapshot(
      leafCatalog.localControlNode().controlNodeId,
      attachment.attachmentId,
      leafCatalog.accessSnapshot(),
    );
    await expect(leaf.flushMetadataOutbox()).resolves.toBe(1);
    await leaf.flushMetadataDeliveries();

    expect(rootCatalog.getMetadataOperation(
      launchMetadataOperationId(request.launchId),
    )).toMatchObject({
      status: "accepted",
      canonical: { values: request.metadata },
    });
    expect(rootCatalog.searchSessions({
      states: ["running"],
      metadata: [{ operator: "equals", key: "test.run_id", value: "nested" }],
    }).sessions.map((session) => session.sessionId)).toEqual([request.sessionId]);
    expect(leafCatalog.getMetadata(request.sessionId).values).toEqual(request.metadata);
    expect(runtime.service.getMetadata(request.sessionId).values).toEqual(request.metadata);
    runtime.service.applyCanonicalSessions([leafCatalog.getSession(request.sessionId)!]);
    expect(runtime.service.metadataOutbox()).toEqual([]);

    leaf.close();
    root.close();
    leafCatalog.close();
    rootCatalog.close();
    await runtime.service.close();
    runtime.store.close();
  });
});
