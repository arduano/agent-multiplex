import { packNativePayload } from "@arduano/agent-multiplex-protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TRPCClientError } from "@trpc/client";
import { TRPC_ERROR_CODES_BY_KEY } from "@trpc/server/rpc";
import {
  canonicalJson,
  emptyMetadataSnapshot,
  newArchiveOperationId,
  newCommandId,
  imageDescriptorSchema,
  type ImageReadResult,
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
  createAccessRouter,
  ControlNodeCatalog,
  ControlNodeCoreError,
  ControlNodeService,
  type ChildControlNodeConnection,
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
    protocolVersion: 5,
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
    beginImageUpload: unused,
    writeImageUpload: unused,
    commitImageUpload: unused,
    abortImageUpload: unused,
    resolveImagePath: unused,
    readImage: unused,
    imageLimits: unused,
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

async function connectChild(parent: ControlNodeService, child: ControlNodeService): Promise<void> {
  const node = child.catalog.localControlNode();
  const endpointId = `child-${node.controlNodeId}`;
  const parentEndpointId = `parent-${parent.catalog.localControlNode().controlNodeId}`;
  const { attachment } = parent.catalog.attachChild({
    controlNodeId: node.controlNodeId,
    controlNodeBootId: node.controlNodeBootId,
    feedId: node.feedId,
    name: node.name,
    endpointId,
    protocolVersion: 5,
    capabilities: node.capabilities,
    expectedParentControlNodeId: parent.catalog.localControlNode().controlNodeId,
    childProof: child.catalog.attachmentProof(),
  });
  child.catalog.applyParentAttachment(attachment, parentEndpointId);
  const unused = () => Promise.reject(new Error("unused child operation"));
  const link: ChildControlNodeConnection = {
    controlNodeId: node.controlNodeId,
    controlNodeBootId: node.controlNodeBootId,
    endpointId,
    readSubtreeSnapshot: async () => {
      const snapshot = child.catalog.accessSnapshot();
      return {
        ...snapshot,
        attachmentId: attachment.attachmentId,
        lineageId: attachment.lineageId,
        checkpoint: {
          feedId: snapshot.source.manifest.feedId,
          controlCursor: snapshot.source.manifest.controlCursor,
        },
        nextPageToken: null,
      };
    },
    async *subscribeAggregate(_cursor, signal) {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve();
        else signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
    listModels: unused,
    listLaunchProfileModels: unused,
    refreshInventory: unused,
    createLaunch: (request) => child.createLaunch(request),
    getLaunch: (id) => child.getLaunch(id),
    listLaunches: (query) => child.listLaunches(query),
    searchSessions: (query) => child.searchSessions(query),
    getSession: (id) => child.getSession(id),
    resume: unused,
    stop: unused,
    archive: unused,
    getArchive: unused,
    execute: unused,
    readNativeHistory: unused,
    beginImageUpload: (input) => child.beginImageUpload(input),
    writeImageUpload: (input) => child.writeImageUpload(input),
    commitImageUpload: (input) => child.commitImageUpload(input),
    abortImageUpload: (input) => child.abortImageUpload(input),
    resolveImagePath: (input) => child.resolveImagePath(input),
    readImage: (input) => child.readImage(input),
    imageLimits: (input) => child.imageLimits(input),
    resolveInteraction: unused,
  };
  await parent.attachChildConnection(link);
}

function rejection(code: keyof typeof TRPC_ERROR_CODES_BY_KEY): TRPCClientError<never> {
  const message = "private runtime configuration detail";
  return new TRPCClientError(message, {
    result: {
      error: Object.freeze({
        code: TRPC_ERROR_CODES_BY_KEY[code],
        message,
        data: Object.freeze({ code, httpStatus: 409, path: "launches.create" }),
      }),
    },
  } as never);
}

describe("protocol-v4 launch binding durability", () => {
  it.each(["direct", "child"] as const)(
    "reserves the logical session across routes when %s launches first",
    async (firstRoute) => {
      const catalog = new ControlNodeCatalog({ filename: stateFile("reservation-root"), now: clock });
      const childCatalog = new ControlNodeCatalog({ filename: stateFile("reservation-child"), now: clock });
      const service = new ControlNodeService({ catalog, now: clock });
      const child = new ControlNodeService({ catalog: childCatalog, now: clock });
      const directRuntime = registration();
      const childRuntime = registration();
      const calls: string[] = [];
      register(service, directRuntime, connection(directRuntime, async (input) => {
        calls.push("direct");
        return accepted(input);
      }));
      register(child, childRuntime, connection(childRuntime, async (input) => {
        calls.push("child");
        return accepted(input);
      }));
      await connectChild(service, child);
      const runtimes = firstRoute === "direct"
        ? [directRuntime, childRuntime]
        : [childRuntime, directRuntime];
      const first = launch(runtimes[0]!, "first-reservation");
      const competing = { ...launch(runtimes[1]!, "competing-reservation"), sessionId: first.sessionId };
      try {
        const pending = service.createLaunch(first);
        const cursor = catalog.sourceManifest().controlCursor;
        expect(() => service.createLaunch(competing)).toThrowError(
          expect.objectContaining({ code: "CONFLICT" }),
        );
        expect(catalog.sourceManifest().controlCursor).toBe(cursor);
        expect(catalog.getLaunch(competing.launchId)).toBeNull();
        await expect(pending).resolves.toMatchObject({ state: "accepted" });
        expect(calls).toEqual([firstRoute]);
      } finally {
        service.close();
        child.close();
        catalog.close();
        childCatalog.close();
      }
    },
  );

  it.each(["accepted", "failed"] as const)(
    "retains the %s launch's session reservation across restart",
    async (state) => {
      const filename = stateFile(`reservation-restart-${state}`);
      const runtime = registration();
      const input = launch(runtime, "durable-reservation");
      const first = new ControlNodeCatalog({ filename, now: clock });
      first.recordLaunch({
        ...accepted(input),
        state,
        ...(state === "failed" ? { error: "input validation failed" } : {}),
      });
      first.close();
      const catalog = new ControlNodeCatalog({ filename, now: clock });
      const service = new ControlNodeService({ catalog, now: clock });
      const anotherRuntime = registration();
      let calls = 0;
      register(service, anotherRuntime, connection(anotherRuntime, async (request) => {
        calls += 1;
        return accepted(request);
      }));
      const competing = { ...launch(anotherRuntime, "reused-session"), sessionId: input.sessionId };
      try {
        expect(() => service.createLaunch(competing)).toThrowError(
          expect.objectContaining({ code: "CONFLICT" }),
        );
        expect(catalog.getLaunch(competing.launchId)).toBeNull();
        await expect(service.createLaunch(input)).resolves.toMatchObject({ state });
        expect(calls).toBe(0);
      } finally {
        service.close();
        catalog.close();
      }
    },
  );

  it.each(["initial", "recovery"] as const)(
    "settles confirmed %s admission rejection durably without redispatch",
    async (phase) => {
      const filename = stateFile(`rejection-${phase}`);
      const catalog = new ControlNodeCatalog({ filename, now: clock });
      const service = new ControlNodeService({ catalog, now: clock });
      const runtime = registration();
      const input = launch(runtime, "unsupported-profile");
      let calls = 0;
      const owner = {
        ...connection(runtime, async () => {
          calls += 1;
          throw rejection("METHOD_NOT_SUPPORTED");
        }),
        getLaunch: async () => null,
      };
      register(service, runtime, owner);
      if (phase === "recovery") catalog.recordLaunch(accepted(input));
      try {
        const record = phase === "initial"
          ? await service.createLaunch(input)
          : await service.getLaunch(input.launchId);
        expect(record).toMatchObject({ state: "failed" });
        expect(record?.error).not.toContain("private runtime configuration detail");
        await expect(service.createLaunch(input)).resolves.toEqual(record);
        await expect(service.getLaunch(input.launchId)).resolves.toEqual(record);
        expect(calls).toBe(1);
      } finally {
        service.close();
        catalog.close();
      }
      const reopened = new ControlNodeCatalog({ filename, now: clock });
      const restarted = new ControlNodeService({ catalog: reopened, now: clock });
      register(restarted, runtime, owner);
      try {
        await expect(restarted.createLaunch(input)).resolves.toMatchObject({ state: "failed" });
        expect(calls).toBe(1);
      } finally {
        restarted.close();
        reopened.close();
      }
    },
  );

  it.each(["matching", "mismatched", "conflicting"] as const)(
    "checks the owner's %s recovery result after admission rejection",
    async (identity) => {
      const catalog = new ControlNodeCatalog({ filename: stateFile(`owner-${identity}`), now: clock });
      const service = new ControlNodeService({ catalog, now: clock });
      const runtime = registration();
      const input = launch(runtime, "owner-recovery");
      const owned = succeeded(identity === "matching" ? input : { ...input, sessionId: newSessionId() }, "native-owner");
      register(service, runtime, {
        ...connection(runtime, async () => { throw rejection("CONFLICT"); }),
        getLaunch: async () => {
          if (identity === "conflicting") throw new ControlNodeCoreError("CONFLICT", "owner identity fork");
          return owned;
        },
      });
      try {
        if (identity === "matching") {
          await expect(service.createLaunch(input)).resolves.toEqual(owned);
        } else {
          await expect(service.createLaunch(input)).rejects.toMatchObject({
            code: identity === "conflicting" ? "CONFLICT" : "PAYLOAD_MISMATCH",
          });
          expect(catalog.getLaunch(input.launchId)).toEqual(accepted(input));
        }
      } finally {
        service.close();
        catalog.close();
      }
    },
  );

  it.each(["ambiguous", "forged", "lookup-unavailable", "boot-changed"] as const)(
    "preserves accepted recovery when rejection proof is %s",
    async (reason) => {
      const catalog = new ControlNodeCatalog({ filename: stateFile(`uncertain-${reason}`), now: clock });
      const service = new ControlNodeService({ catalog, now: clock });
      const runtime = registration();
      const input = launch(runtime, "uncertain-rejection");
      let lookups = 0;
      register(service, runtime, {
        ...connection(runtime, async () => {
          if (reason === "ambiguous") throw rejection("BAD_GATEWAY");
          if (reason === "forged") {
            throw Object.assign(new Error("forged rejection"), { data: { code: "METHOD_NOT_SUPPORTED" } });
          }
          throw rejection("METHOD_NOT_SUPPORTED");
        }),
        getLaunch: async () => {
          lookups += 1;
          if (reason === "lookup-unavailable") throw new Error("connection lost");
          if (reason === "boot-changed") {
            const replacement = registration(runtime.runtimeNodeId);
            register(service, replacement, connection(replacement, async (request) => accepted(request)));
          }
          return null;
        },
      });
      try {
        await expect(service.createLaunch(input)).resolves.toEqual(accepted(input));
        expect(lookups).toBe(reason === "ambiguous" || reason === "forged" ? 0 : 1);
      } finally {
        service.close();
        catalog.close();
      }
    },
  );

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
      payload: packNativePayload({ threadId: "native-early" }),
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


describe("protocol-v5 image routing", () => {
  it.each(["direct", "child"] as const)("forwards bounded reads through a %s route and enforces access scopes", async (route) => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("image-root"), now: clock });
    const childCatalog = new ControlNodeCatalog({ filename: stateFile("image-child"), now: clock });
    const service = new ControlNodeService({ catalog, now: clock });
    const child = new ControlNodeService({ catalog: childCatalog, now: clock });
    const owner = route === "direct" ? service : child;
    const runtime = registration();
    const request = launch(runtime, "image");
    const image = imageDescriptorSchema.parse({
      imageId: newCommandId(), sessionId: request.sessionId,
      runtimeNodeId: runtime.runtimeNodeId, bindingRevision: 1,
      sha256: "a".repeat(64), byteLength: 4, mediaType: "image/png",
    });
    const target = { ...image, runtimeNodeBootId: runtime.runtimeNodeBootId };
    const reads: unknown[] = [];
    const runtimeConnection = {
      ...connection(runtime, async () => succeeded(request, "image-native")),
      readImage: async (input: Parameters<RuntimeNodeConnection["readImage"]>[0]) => {
        reads.push(input);
        return { image, offset: input.offset, dataBase64: "AAAAAA==", eof: true };
      },
      resolveImagePath: async () => image,
      beginImageUpload: async () => ({ imageId: image.imageId, byteLength: 4, receivedBytes: 0, committed: null }),
    };
    register(owner, runtime, runtimeConnection);
    owner.catalog.recordLaunch(succeeded(request, "image-native"));
    owner.catalog.mergeRuntimeSession(boundSession(request, "image-native"));
    if (route === "child") await connectChild(service, child);
    try {
      const reader = createAccessRouter(service).createCaller({ grantedScopes: ["read"] });
      await expect(reader.images.read({ ...target, offset: 0 })).resolves.toMatchObject({ image, eof: true });
      expect(reads).toMatchObject([{ length: 256 * 1_024 }]);
      await expect(reader.images.resolvePath({ ...target, sourceKey: "native/item/image", path: "output.png" })).resolves.toEqual(image);
      await expect(reader.images.beginUpload(target)).rejects.toMatchObject({ code: "FORBIDDEN" });
      const writer = createAccessRouter(service).createCaller({ grantedScopes: ["agent-control"] });
      await expect(writer.images.beginUpload(target)).resolves.toMatchObject({ receivedBytes: 0 });
      await expect(writer.images.read({ ...target, offset: 0 })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(service.readImage({ ...target, runtimeNodeBootId: newRuntimeNodeBootId(), offset: 0, length: 4 })).rejects.toMatchObject({ code: "FENCED" });
      expect(reads).toHaveLength(1);
    } finally {
      service.close(); child.close(); catalog.close(); childCatalog.close();
    }
  });

  it("rejects a reply from another image and from a replaced runtime boot", async () => {
    const catalog = new ControlNodeCatalog({ filename: stateFile("image-fence"), now: clock });
    const service = new ControlNodeService({ catalog, now: clock });
    const runtime = registration();
    const request = launch(runtime, "image-fence");
    const image = imageDescriptorSchema.parse({
      imageId: newCommandId(), sessionId: request.sessionId,
      runtimeNodeId: runtime.runtimeNodeId, bindingRevision: 1,
      sha256: "a".repeat(64), byteLength: 4, mediaType: "image/png",
    });
    let reply!: (value: ImageReadResult) => void;
    const runtimeConnection = {
      ...connection(runtime, async () => succeeded(request, "image-native")),
      readImage: () => new Promise<ImageReadResult>((resolve) => { reply = resolve; }),
    };
    register(service, runtime, runtimeConnection);
    catalog.recordLaunch(succeeded(request, "image-native"));
    catalog.mergeRuntimeSession(boundSession(request, "image-native"));
    const input = { ...image, runtimeNodeBootId: runtime.runtimeNodeBootId, offset: 0, length: 4 };
    try {
      const wrongImage = service.readImage(input);
      reply({ image: { ...image, imageId: newCommandId() }, offset: 0, dataBase64: "AAAAAA==", eof: true });
      await expect(wrongImage).rejects.toMatchObject({ code: "FENCED" });
      const replacedBoot = service.readImage(input);
      const replacement = registration(runtime.runtimeNodeId);
      register(service, replacement, connection(replacement, async () => succeeded(request, "image-native")));
      reply({ image, offset: 0, dataBase64: "AAAAAA==", eof: true });
      await expect(replacedBoot).rejects.toMatchObject({ code: "FENCED" });
    } finally {
      service.close(); catalog.close();
    }
  });
});
