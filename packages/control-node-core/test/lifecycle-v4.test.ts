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
  type AdapterScopeId,
  type ArchiveRecord,
  type ArchiveRequest,
  type LaunchProfileDescriptor,
  type LaunchRecord,
  type LaunchRequest,
  type RuntimeNodeRegistration,
  type RuntimeNodeSessionRecord,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";

import {
  ControlNodeCatalog,
  ControlNodeService,
  type RuntimeNodeConnection,
  type RuntimeNodeIngressContext,
} from "../src/index.js";

const now = "2038-05-06T07:08:09.000Z";
const clock = () => new Date(now);
const adapterScopeId = "codex-lifecycle-test" as AdapterScopeId;
const profile: LaunchProfileDescriptor = {
  profileId: "workspace",
  providerId: "core.direct",
  contractVersion: 1,
  requestSchemaHash: "a".repeat(64),
  implementationVersion: "1.0.0",
  harnesses: ["codex"],
  available: true,
  capabilities: [],
};

function stateFile(prefix: string): string {
  return join(
    mkdtempSync(join(tmpdir(), `agent-multiplex-lifecycle-v4-${prefix}-`)),
    "control-node.sqlite",
  );
}

function registration(
  runtimeNodeId = newRuntimeNodeId(),
  runtimeNodeBootId = newRuntimeNodeBootId(),
): RuntimeNodeRegistration {
  return {
    runtimeNodeId,
    runtimeNodeBootId,
    name: "lifecycle-runtime",
    allowedRoots: ["/work"],
    harnesses: [{
      harness: "codex",
      adapterScopeId,
      available: true,
      capabilities: [],
    }],
    launchProfiles: [profile],
    protocolVersion: 4,
  };
}

function launch(
  runtime: RuntimeNodeRegistration,
  suffix: string,
): LaunchRequest {
  return {
    launchId: newLaunchId(),
    payloadHash: `lifecycle-v4-${suffix}`.padEnd(32, "0"),
    sessionId: newSessionId(),
    runtimeNodeId: runtime.runtimeNodeId,
    profile: {
      profileId: profile.profileId,
      providerId: profile.providerId,
      contractVersion: profile.contractVersion,
      requestSchemaHash: profile.requestSchemaHash,
    },
    harness: "codex",
    input: { cwd: "/work/project" },
    metadata: { "agent.title": `lifecycle ${suffix}` },
  };
}

function accepted(input: LaunchRequest): LaunchRecord {
  return {
    ...input,
    implementationVersion: profile.implementationVersion,
    state: "accepted",
    createdAt: now,
    updatedAt: now,
  };
}

function succeeded(input: LaunchRequest, vendorSessionId: string): LaunchRecord {
  return {
    ...accepted(input),
    state: "succeeded",
    result: {
      sessionId: input.sessionId,
      adapterScopeId,
      vendorSessionId,
      backendId: `codex:${adapterScopeId}`,
      bindingRevision: 1,
    },
  };
}

function acceptedArchive(input: ArchiveRequest): ArchiveRecord {
  return {
    ...input,
    authority: input.expectedAuthority,
    state: "accepted",
    releasedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function succeededArchive(input: ArchiveRequest): ArchiveRecord {
  return {
    ...acceptedArchive(input),
    state: "succeeded",
    releasedAt: now,
    catalogRevision: input.bindingRevision + 1,
  };
}

function boundSession(
  input: LaunchRequest,
  vendorSessionId: string,
): RuntimeNodeSessionRecord {
  return {
    sessionId: input.sessionId,
    runtimeNodeId: input.runtimeNodeId,
    harness: input.harness,
    adapterScopeId,
    vendorSessionId,
    bindingRevision: 1,
    runtimeEpoch: newRuntimeEpoch(),
    cwd: "/work/project",
    availability: "active",
    runtimeStatus: "idle",
    launchProvenance: {
      launchId: input.launchId,
      profileId: input.profile.profileId,
      providerId: input.profile.providerId,
      backendId: `codex:${adapterScopeId}`,
      contractVersion: input.profile.contractVersion,
      requestSchemaHash: input.profile.requestSchemaHash,
      implementationVersion: profile.implementationVersion,
    },
    metadata: emptyMetadataSnapshot(),
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    lastActivityAt: now,
  };
}

function connection(
  runtime: RuntimeNodeRegistration,
  createLaunch: RuntimeNodeConnection["createLaunch"],
): RuntimeNodeConnection {
  const unused = () => Promise.reject(new Error("unused"));
  return {
    runtimeNodeId: runtime.runtimeNodeId,
    runtimeNodeBootId: runtime.runtimeNodeBootId,
    endpointId: `endpoint-${runtime.runtimeNodeId}`,
    refreshInventory: async () => ({
      runtimeNodeId: runtime.runtimeNodeId,
      generation: "empty",
      complete: true,
      capturedAt: now,
      sessions: [],
    }),
    listModels: unused,
    listLaunchProfiles: async () => [profile],
    listLaunchProfileModels: unused,
    createLaunch,
    getLaunch: unused,
    listLaunches: unused,
    resume: unused,
    stop: unused,
    archive: unused,
    getArchive: unused,
    execute: unused,
    readNativeHistory: unused,
    resolveInteraction: unused,
  };
}

function register(
  service: ControlNodeService,
  runtime: RuntimeNodeRegistration,
  runtimeConnection: RuntimeNodeConnection,
): Required<Pick<RuntimeNodeIngressContext, "endpointId" | "authenticatedRuntimeNodeId">> {
  const context = {
    endpointId: runtimeConnection.endpointId!,
    authenticatedRuntimeNodeId: runtime.runtimeNodeId,
  };
  service.registerRuntimeNode(runtime, {
    ...context,
    runtimeNodeConnection: runtimeConnection,
  });
  return context;
}

describe("protocol-v4 launch binding durability", () => {
  it("preserves the launch session ID when inventory overtakes its binding event", () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("inventory-race"), now: clock });
    const runtime = registration();
    const input = launch(runtime, "inventory-race");
    const native = boundSession(input, "native-inventory-race");
    const snapshot = {
      runtimeNodeId: runtime.runtimeNodeId,
      generation: newRuntimeEpoch(),
      complete: true,
      capturedAt: now,
      sessions: [{
        harness: native.harness,
        adapterScopeId: native.adapterScopeId,
        vendorSessionId: native.vendorSessionId,
        cwd: native.cwd,
        availability: native.availability,
        runtimeStatus: native.runtimeStatus,
        runtimeEpoch: native.runtimeEpoch,
        lastActivityAt: native.lastActivityAt,
      }],
    };
    catalog.registerRuntimeNode(runtime);
    catalog.recordLaunch(accepted(input));

    // Until the native ID is known, importing this inventory item under a new
    // logical ID would steal it from the launch reservation.
    expect(catalog.reconcileInventory(snapshot)).toEqual([]);
    expect(catalog.listSessions()).toEqual([]);

    catalog.recordLaunch(succeeded(input, native.vendorSessionId));
    expect(catalog.reconcileInventory(snapshot)).toMatchObject([{
      sessionId: input.sessionId,
      vendorSessionId: native.vendorSessionId,
      launchProvenance: {
        launchId: input.launchId,
        providerId: input.profile.providerId,
      },
    }]);
    expect(() => catalog.mergeRuntimeSession(native)).not.toThrow();
    expect(catalog.listSessions()).toHaveLength(1);

    catalog.close();
  });

  it("merges launch transitions whose optional fields arrive as explicit undefined", () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("undefined-transition"), now: clock });
    const runtime = registration();
    const input = launch(runtime, "undefined-transition");

    expect(catalog.recordLaunch(accepted(input))).toMatchObject({ state: "accepted" });
    expect(catalog.recordLaunch({
      ...accepted(input),
      state: "preparing",
      statusMessage: "preparing workspace",
      result: undefined,
      error: undefined,
    })).toMatchObject({ state: "preparing" });
    expect(catalog.recordLaunch({
      ...succeeded(input, "native-undefined-transition"),
      statusMessage: "native session bound",
      error: undefined,
    })).toMatchObject({
      state: "succeeded",
      result: { vendorSessionId: "native-undefined-transition" },
    });

    catalog.close();
  });

  it("replays native sequence zero after the runtime publishes its logical binding", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("early-native"), now: clock });
    const service = new ControlNodeService({ catalog, now: clock });
    const runtime = registration();
    const input = launch(runtime, "early-native");
    const session = boundSession(input, "native-early");
    const native = {
      kind: "native" as const,
      sessionId: input.sessionId,
      harness: "codex" as const,
      runtimeEpoch: session.runtimeEpoch!,
      sequence: 0,
      nativeType: "thread/started",
      payload: { threadId: "native-early" },
      ephemeral: false,
    };
    const runtimeConnection = connection(runtime, async () => accepted(input));
    const context = register(service, runtime, runtimeConnection);

    expect(service.publishRuntimeEvent({
      runtimeNodeId: runtime.runtimeNodeId,
      runtimeNodeBootId: runtime.runtimeNodeBootId,
      event: native,
    }, context)).toEqual({ accepted: false });
    await expect(service.createLaunch(input)).resolves.toMatchObject({ state: "accepted" });
    await expect(service.getSession(input.sessionId)).resolves.toBeNull();

    expect(service.publishRuntimeEvent({
      runtimeNodeId: runtime.runtimeNodeId,
      runtimeNodeBootId: runtime.runtimeNodeBootId,
      event: { kind: "control", change: { type: "session.upsert", session } },
    }, context)).toEqual({ accepted: true });
    expect(service.publishRuntimeEvent({
      runtimeNodeId: runtime.runtimeNodeId,
      runtimeNodeBootId: runtime.runtimeNodeBootId,
      event: native,
    }, context)).toEqual({ accepted: true });

    service.publishRuntimeEvent({
      runtimeNodeId: runtime.runtimeNodeId,
      runtimeNodeBootId: runtime.runtimeNodeBootId,
      event: {
        kind: "control",
        change: { type: "launch.changed", launch: succeeded(input, "native-early") },
      },
    }, context);
    await expect(service.getSession(input.sessionId)).resolves.toMatchObject({
      sessionId: input.sessionId,
      vendorSessionId: "native-early",
      launchProvenance: {
        launchId: input.launchId,
        providerId: profile.providerId,
      },
    });
    await expect(service.getLaunch(input.launchId)).resolves.toMatchObject({ state: "succeeded" });

    service.close();
    catalog.close();
  });

  it("preserves the reserved logical ID when a binding races the launch response", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("race"), now: clock });
    const service = new ControlNodeService({ catalog, now: clock });
    const runtime = registration();
    const input = launch(runtime, "race");
    const session = boundSession(input, "native-race");
    let context!: Required<
      Pick<RuntimeNodeIngressContext, "endpointId" | "authenticatedRuntimeNodeId">
    >;
    let observedDuringLaunch: string | undefined;
    const runtimeConnection = connection(runtime, async () => {
      service.publishRuntimeEvent({
        runtimeNodeId: runtime.runtimeNodeId,
        runtimeNodeBootId: runtime.runtimeNodeBootId,
        event: { kind: "control", change: { type: "session.upsert", session } },
      }, context);
      observedDuringLaunch = service.listSessions()[0]?.sessionId;
      return accepted(input);
    });
    context = register(service, runtime, runtimeConnection);

    await expect(service.createLaunch(input)).resolves.toMatchObject({ state: "accepted" });
    expect(observedDuringLaunch).toBe(input.sessionId);
    expect(service.listSessions()).toHaveLength(1);
    await expect(service.getSession(input.sessionId)).resolves.toMatchObject({
      sessionId: input.sessionId,
      runtimeNodeId: runtime.runtimeNodeId,
      vendorSessionId: "native-race",
    });

    service.close();
    catalog.close();
  });

  it("durably reserves a launch before inventory and binding events can overtake dispatch", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("pre-dispatch-reservation"), now: clock });
    const service = new ControlNodeService({ catalog, now: clock });
    const runtime = registration();
    const input = launch(runtime, "pre-dispatch-reservation");
    const session = boundSession(input, "native-pre-dispatch-reservation");
    let context!: Required<
      Pick<RuntimeNodeIngressContext, "endpointId" | "authenticatedRuntimeNodeId">
    >;
    let observedReservation = false;
    const runtimeConnection = connection(runtime, async () => {
      observedReservation = catalog.getLaunch(input.launchId)?.state === "accepted";
      expect(catalog.reconcileInventory({
        runtimeNodeId: runtime.runtimeNodeId,
        generation: newRuntimeEpoch(),
        complete: true,
        capturedAt: now,
        sessions: [{
          harness: session.harness,
          adapterScopeId: session.adapterScopeId,
          vendorSessionId: session.vendorSessionId,
          cwd: session.cwd,
          availability: session.availability,
          runtimeStatus: session.runtimeStatus,
          runtimeEpoch: session.runtimeEpoch,
          lastActivityAt: session.lastActivityAt,
        }],
      })).toEqual([]);
      expect(service.publishRuntimeEvent({
        runtimeNodeId: runtime.runtimeNodeId,
        runtimeNodeBootId: runtime.runtimeNodeBootId,
        event: { kind: "control", change: { type: "session.upsert", session } },
      }, context)).toEqual({ accepted: true });
      return accepted(input);
    });
    context = register(service, runtime, runtimeConnection);

    await expect(service.createLaunch(input)).resolves.toMatchObject({ state: "accepted" });
    expect(observedReservation).toBe(true);
    expect(catalog.listSessions()).toMatchObject([{
      sessionId: input.sessionId,
      vendorSessionId: session.vendorSessionId,
    }]);

    service.close();
    catalog.close();
  });

  it("redrives a launch admitted before a lost first downstream dispatch", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("admission-redrive"), now: clock });
    const service = new ControlNodeService({ catalog, now: clock });
    const runtime = registration();
    const input = launch(runtime, "admission-redrive");
    let launchCalls = 0;
    const runtimeConnection = {
      ...connection(runtime, async () => {
        launchCalls += 1;
        if (launchCalls === 1) throw new Error("request lost before runtime admission");
        return accepted(input);
      }),
      getLaunch: async () => null,
    } satisfies RuntimeNodeConnection;
    register(service, runtime, runtimeConnection);

    await expect(service.createLaunch(input)).resolves.toMatchObject({ state: "accepted" });
    expect(launchCalls).toBe(1);
    expect(catalog.getLaunch(input.launchId)).toMatchObject({ state: "accepted" });

    await expect(service.createLaunch(input)).resolves.toMatchObject({ state: "accepted" });
    expect(launchCalls).toBe(2);

    service.close();
    catalog.close();
  });

  it("durably de-duplicates an accepted launch across restart without replaying it", async () => {
    const filename = stateFile("recovery");
    const runtime = registration();
    const input = launch(runtime, "recovery");
    let launchCalls = 0;
    const runtimeConnection = connection(runtime, async () => {
      launchCalls += 1;
      return accepted(input);
    });

    const firstCatalog = new ControlNodeCatalog({ filename, now: clock });
    const firstService = new ControlNodeService({ catalog: firstCatalog, now: clock });
    register(firstService, runtime, runtimeConnection);
    await expect(firstService.createLaunch(input)).resolves.toMatchObject({ state: "accepted" });
    expect(launchCalls).toBe(1);
    firstService.close();
    firstCatalog.close();

    const recoveredCatalog = new ControlNodeCatalog({ filename, now: clock });
    const recoveredService = new ControlNodeService({ catalog: recoveredCatalog, now: clock });
    await expect(recoveredService.createLaunch(input)).resolves.toEqual(accepted(input));
    expect(launchCalls).toBe(1);
    await expect(recoveredService.getLaunch(input.launchId)).resolves.toEqual(accepted(input));
    recoveredService.close();
    recoveredCatalog.close();
  });

  it("repairs a missed terminal launch event from the worker journal", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("missed-launch"), now: clock });
    const service = new ControlNodeService({ catalog, now: clock });
    const runtime = registration();
    const input = launch(runtime, "missed-launch");
    let workerRecord: LaunchRecord = accepted(input);
    const runtimeConnection: RuntimeNodeConnection = {
      ...connection(runtime, async () => workerRecord),
      getLaunch: async (launchId) => launchId === input.launchId ? workerRecord : null,
    };
    register(service, runtime, runtimeConnection);

    await expect(service.createLaunch(input)).resolves.toMatchObject({ state: "accepted" });
    workerRecord = succeeded(input, "native-missed-launch");
    await expect(service.getLaunch(input.launchId)).resolves.toMatchObject({
      state: "succeeded",
      result: { sessionId: input.sessionId, vendorSessionId: "native-missed-launch" },
    });
    expect(catalog.getLaunch(input.launchId)).toMatchObject({ state: "succeeded" });

    service.close();
    catalog.close();
  });

  it("repairs missed archive completion and keeps the retry idempotent after tombstoning", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("missed-archive"), now: clock });
    const service = new ControlNodeService({ catalog, now: clock });
    const runtime = registration();
    const launchInput = launch(runtime, "missed-archive");
    const session = boundSession(launchInput, "native-missed-archive");
    let workerArchive: ArchiveRecord | null = null;
    const runtimeConnection: RuntimeNodeConnection = {
      ...connection(runtime, async () => accepted(launchInput)),
      archive: async (request) => {
        workerArchive = acceptedArchive(request);
        return workerArchive;
      },
      getArchive: async (archiveOperationId) =>
        workerArchive?.archiveOperationId === archiveOperationId ? workerArchive : null,
    };
    const context = register(service, runtime, runtimeConnection);
    service.publishRuntimeEvent({
      runtimeNodeId: runtime.runtimeNodeId,
      runtimeNodeBootId: runtime.runtimeNodeBootId,
      event: { kind: "control", change: { type: "session.upsert", session } },
    }, context);
    const stopped = catalog.markSessionStopped(session.sessionId, session.bindingRevision);
    const archiveOperationId = newArchiveOperationId();
    const archiveInput: ArchiveRequest = {
      archiveOperationId,
      payloadHash: canonicalJson({ archiveOperationId }).padEnd(16, "0"),
      sessionId: stopped.sessionId,
      runtimeNodeId: stopped.runtimeNodeId,
      bindingRevision: stopped.bindingRevision,
      expectedAuthority: stopped.metadataAuthority,
    };

    await expect(service.archive(archiveInput)).resolves.toMatchObject({ state: "accepted" });
    workerArchive = succeededArchive(archiveInput);
    await expect(service.getArchive(archiveOperationId)).resolves.toMatchObject({
      state: "succeeded",
      catalogRevision: stopped.catalogRevision + 1,
    });
    expect(catalog.getSession(stopped.sessionId)).toMatchObject({
      catalogState: "archived",
      availability: "unavailable",
    });
    await expect(service.archive(archiveInput)).resolves.toMatchObject({ state: "succeeded" });

    service.close();
    catalog.close();
  });

  it("rejects a launch response correlated to another logical session", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("correlation"), now: clock });
    const service = new ControlNodeService({ catalog, now: clock });
    const runtime = registration();
    const input = launch(runtime, "correlation");
    const wrongRequest = { ...input, sessionId: newSessionId() };
    const runtimeConnection = connection(runtime, async () => accepted(wrongRequest));
    register(service, runtime, runtimeConnection);

    await expect(service.createLaunch(input)).rejects.toMatchObject({
      code: "PAYLOAD_MISMATCH",
    });
    await expect(service.getLaunch(input.launchId)).resolves.toMatchObject({
      sessionId: input.sessionId,
      state: "accepted",
    });
    expect(service.listSessions()).toEqual([]);

    service.close();
    catalog.close();
  });
});
