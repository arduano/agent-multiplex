import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  emptyMetadataSnapshot,
  newAttachmentId,
  newAuthorityEpochId,
  newAuthorityHandoffId,
  newFeedId,
  newHostBootId,
  newHostId,
  newLineageId,
  newRuntimeEpoch,
  newSessionId,
  newWorkerBootId,
  newWorkerId,
  type AuthorityForceAdoptInput,
  type AuthorityHandoffAcceptInput,
  type AuthorityHandoffOfferInput,
  type HostAttachment,
  type HostAttachmentRequest,
  type HostLinkFence,
  type SessionRecord,
  type WorkerDescriptor,
} from "@agent-multiplex/protocol";
import {
  HostCatalog,
  HostCoreError,
  HostService,
  createP2PAuthorityAcceptanceSigner,
  createCompositeHostRouter,
} from "@agent-multiplex/host-core";
import { describe, expect, it } from "vitest";

const childRequest = (): HostAttachmentRequest => ({
  hostId: newHostId(),
  hostBootId: newHostBootId(),
  feedId: newFeedId(),
  name: "handoff-child",
  endpointId: `child-${randomUUID()}`,
  protocolVersion: 2,
  capabilities: ["topology.nested-hosts"],
});

function addChildSession(
  catalog: HostCatalog,
  request: HostAttachmentRequest,
): { childId: HostAttachment["childHostId"]; sessionId: SessionRecord["sessionId"] } {
  const { attachment, child } = catalog.attachChild(request);
  const worker: WorkerDescriptor = {
    workerId: newWorkerId(),
    workerBootId: newWorkerBootId(),
    ownerHostId: child.hostId,
    name: "handoff-worker",
    presence: "online",
    reachability: "reachable",
    connectedAt: "2030-01-01T00:00:00.000Z",
    lastHeartbeatAt: "2030-01-01T00:00:00.000Z",
    allowedRoots: ["/work"],
    harnesses: [],
    protocolVersion: 2,
  };
  const session: SessionRecord = {
    sessionId: newSessionId(),
    workerId: worker.workerId,
    harness: "codex",
    adapterScopeId: "codex-default" as SessionRecord["adapterScopeId"],
    vendorSessionId: "native-handoff-session",
    bindingRevision: 1,
    runtimeEpoch: newRuntimeEpoch(),
    cwd: "/work/project",
    availability: "active",
    runtimeStatus: "idle",
    metadata: emptyMetadataSnapshot(),
    metadataAuthority: {
      hostId: catalog.localHost().hostId,
      epochId: catalog.localHost().authorityEpochId,
    },
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:00.000Z",
    lastSeenAt: "2030-01-01T00:00:00.000Z",
  };
  catalog.importChildSnapshotPage(child.hostId, attachment.attachmentId, {
    rootHostId: child.hostId,
    attachmentId: attachment.attachmentId,
    lineageId: attachment.lineageId,
    checkpoint: { feedId: request.feedId, controlCursor: 0 },
    capturedAt: "2030-01-01T00:00:00.000Z",
    hosts: [child],
    workers: [worker],
    sessions: [session],
    interactions: [],
    metadataOperations: [],
    nextPageToken: null,
  });
  return { childId: child.hostId, sessionId: session.sessionId };
}

describe("HostCatalog authority handoff", () => {
  it("persists a destination-bound, one-shot handoff and exact replay receipt", () => {
    let now = new Date("2030-01-01T00:00:00.000Z");
    const sourceFile = join(mkdtempSync(join(tmpdir(), "multiplex-source-")), "host.sqlite");
    const destinationFile = join(
      mkdtempSync(join(tmpdir(), "multiplex-destination-")),
      "host.sqlite",
    );
    const source = new HostCatalog({ filename: sourceFile, now: () => now, hostName: "source" });
    const destinationSigner = createP2PAuthorityAcceptanceSigner(randomBytes(32));
    const destination = new HostCatalog({
      filename: destinationFile,
      now: () => now,
      hostName: "destination",
      endpointId: destinationSigner.endpointId,
    });
    const { childId, sessionId } = addChildSession(source, childRequest());
    const sourceRoot = source.localHost();
    const destinationRoot = destination.localHost();
    const offerInput: AuthorityHandoffOfferInput = {
      subtreeRootHostId: childId,
      sourceRootHostId: sourceRoot.hostId,
      sourceAuthorityHostId: sourceRoot.hostId,
      sourceAuthorityEpochId: sourceRoot.authorityEpochId,
      destinationRootHostId: destinationRoot.hostId,
      destinationAuthorityHostId: destinationRoot.hostId,
      destinationAuthorityEndpointId: destinationSigner.endpointId,
      expiresAt: "2030-01-01T01:00:00.000Z",
    };
    const offer = source.offerAuthorityHandoff(offerInput);
    expect(source.offerAuthorityHandoff(offerInput)).toEqual(offer);

    const acceptanceInput: AuthorityHandoffAcceptInput = {
      offer,
      acceptedByHostId: destinationRoot.hostId,
      acceptedByHostBootId: destinationRoot.hostBootId,
      destinationAuthorityEpochId: destinationRoot.authorityEpochId,
    };
    const acceptance = destination.acceptAuthorityHandoff(
      acceptanceInput,
      destinationSigner,
    );
    expect(
      destination.acceptAuthorityHandoff(acceptanceInput, destinationSigner),
    ).toEqual(acceptance);

    const wrongDestination = new HostCatalog({
      filename: ":memory:",
      now: () => now,
      hostName: "wrong-destination",
    });
    expect(() =>
      wrongDestination.acceptAuthorityHandoff(acceptanceInput, destinationSigner),
    ).toThrowError(HostCoreError);
    wrongDestination.close();

    const consumeInput = { offer, acceptance };
    expect(() =>
      source.consumeAuthorityHandoff({
        offer,
        acceptance: {
          ...acceptance,
          acceptanceToken: randomUUID(),
          acceptanceProof: {
            algorithm: "ed25519",
            signature: Buffer.alloc(64).toString("base64url"),
          },
        },
      }),
    ).toThrow(/acceptance proof/);
    const receipt = source.consumeAuthorityHandoff(consumeInput);
    expect(receipt).toMatchObject({
      mode: "handoff",
      handoffId: offer.handoffId,
      subtreeRootHostId: childId,
      destinationRootHostId: destinationRoot.hostId,
      destinationAuthorityHostId: destinationRoot.hostId,
      destinationAuthorityEpochId: destinationRoot.authorityEpochId,
    });
    expect(source.getHost(childId)).toMatchObject({
      rootHostId: destinationRoot.hostId,
      authorityHostId: destinationRoot.hostId,
      authorityEpochId: destinationRoot.authorityEpochId,
    });
    expect(source.getSession(sessionId)?.metadataAuthority).toEqual({
      hostId: destinationRoot.hostId,
      epochId: destinationRoot.authorityEpochId,
    });
    expect(source.getAuthorityHandoff(offer.handoffId)).toMatchObject({
      status: "consumed",
      offer,
      acceptance,
      receipt,
    });
    expect(source.listAuthorityAdoptionReceipts()).toEqual([receipt]);
    source.close();
    destination.close();

    now = new Date("2030-01-01T02:00:00.000Z");
    const reopenedSource = new HostCatalog({ filename: sourceFile, now: () => now });
    expect(reopenedSource.consumeAuthorityHandoff(consumeInput)).toEqual(receipt);
    expect(() =>
      reopenedSource.consumeAuthorityHandoff({
        offer,
        acceptance: { ...acceptance, acceptanceToken: randomUUID() },
      }),
    ).toThrow(/acceptance proof/);
    reopenedSource.close();

    const reopenedDestination = new HostCatalog({ filename: destinationFile, now: () => now });
    expect(
      reopenedDestination.acceptAuthorityHandoff(acceptanceInput, destinationSigner),
    ).toEqual(acceptance);
    reopenedDestination.close();
  });

  it("rejects first-time acceptance or consumption after capability expiry", () => {
    let now = new Date("2030-02-01T00:00:00.000Z");
    const source = new HostCatalog({ filename: ":memory:", now: () => now, hostName: "source" });
    const destinationSigner = createP2PAuthorityAcceptanceSigner(randomBytes(32));
    const destination = new HostCatalog({
      filename: ":memory:",
      now: () => now,
      hostName: "destination",
      endpointId: destinationSigner.endpointId,
    });
    const sourceRoot = source.localHost();
    const destinationRoot = destination.localHost();
    const offer = source.offerAuthorityHandoff({
      subtreeRootHostId: sourceRoot.hostId,
      sourceRootHostId: sourceRoot.hostId,
      sourceAuthorityHostId: sourceRoot.hostId,
      sourceAuthorityEpochId: sourceRoot.authorityEpochId,
      destinationRootHostId: destinationRoot.hostId,
      destinationAuthorityHostId: destinationRoot.hostId,
      destinationAuthorityEndpointId: destinationSigner.endpointId,
      expiresAt: "2030-02-01T00:01:00.000Z",
    });
    const acceptanceInput: AuthorityHandoffAcceptInput = {
      offer,
      acceptedByHostId: destinationRoot.hostId,
      acceptedByHostBootId: destinationRoot.hostBootId,
      destinationAuthorityEpochId: destinationRoot.authorityEpochId,
    };
    const acceptance = destination.acceptAuthorityHandoff(
      acceptanceInput,
      destinationSigner,
    );
    now = new Date("2030-02-01T00:02:00.000Z");
    expect(() => source.consumeAuthorityHandoff({ offer, acceptance })).toThrow(/expired/);

    const laterOffer = {
      ...offer,
      handoffId: newAuthorityHandoffId(),
      offerToken: randomUUID(),
    };
    expect(() =>
      destination.acceptAuthorityHandoff(
        { ...acceptanceInput, offer: laterOffer },
        destinationSigner,
      ),
    ).toThrow(/expired/);
    source.close();
    destination.close();
  });
});

describe("HostCatalog force-adopt authority recovery", () => {
  it("promotes a detached local subtree with a fresh epoch and durable audit receipt", () => {
    let now = new Date("2030-03-01T00:00:00.000Z");
    const filename = join(mkdtempSync(join(tmpdir(), "multiplex-force-")), "host.sqlite");
    const catalog = new HostCatalog({ filename, now: () => now, hostName: "recovering-host" });
    const local = catalog.localHost();
    const previousRootHostId = newHostId();
    const previousAuthorityEpochId = newAuthorityEpochId();
    const parentAttachment: HostAttachment = {
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
      parentHostId: previousRootHostId,
      childHostId: local.hostId,
      rootHostId: previousRootHostId,
      authorityHostId: previousRootHostId,
      authorityEpochId: previousAuthorityEpochId,
      attachedAt: now.toISOString(),
    };
    catalog.applyParentAttachment(parentAttachment);

    const destinationAuthorityEpochId = newAuthorityEpochId();
    const request: AuthorityForceAdoptInput = {
      subtreeRootHostId: local.hostId,
      previousRootHostId,
      previousAuthorityHostId: previousRootHostId,
      previousAuthorityEpochId,
      destinationRootHostId: local.hostId,
      destinationAuthorityHostId: local.hostId,
      destinationHostBootId: local.hostBootId,
      destinationAuthorityEpochId,
      audit: {
        actorId: "operator@example.test",
        reason: "old authority is irrecoverable after machine loss",
        incidentId: "INC-2030-0042",
        evidence: [{ kind: "operator-confirmation", oldHostReachable: false }],
        acknowledgedSplitBrainRisk: true,
        requestedAt: now.toISOString(),
      },
    };
    const receipt = catalog.forceAdoptAuthority(request);
    expect(receipt).toMatchObject({
      mode: "forced",
      sourceRootHostId: previousRootHostId,
      sourceAuthorityHostId: previousRootHostId,
      sourceAuthorityEpochId: previousAuthorityEpochId,
      subtreeRootHostId: local.hostId,
      destinationRootHostId: local.hostId,
      destinationAuthorityHostId: local.hostId,
      destinationAuthorityEpochId,
      audit: request.audit,
    });
    expect(catalog.localHost()).toMatchObject({
      parentHostId: null,
      attachmentId: null,
      rootHostId: local.hostId,
      authorityHostId: local.hostId,
      authorityEpochId: destinationAuthorityEpochId,
    });
    expect(catalog.listAuthorityAdoptionReceipts()).toEqual([receipt]);
    catalog.close();

    now = new Date("2030-03-02T00:00:00.000Z");
    const reopened = new HostCatalog({ filename, now: () => now });
    expect(reopened.localHost().authorityEpochId).toBe(destinationAuthorityEpochId);
    expect(reopened.forceAdoptAuthority(request)).toEqual(receipt);
    expect(reopened.listAuthorityAdoptionReceipts()).toEqual([receipt]);
    reopened.close();
  });

  it("requires explicit split-brain acknowledgement and an accurate previous epoch", () => {
    const now = new Date("2030-04-01T00:00:00.000Z");
    const catalog = new HostCatalog({ filename: ":memory:", now: () => now });
    const local = catalog.localHost();
    expect(() =>
      catalog.forceAdoptAuthority({
        subtreeRootHostId: newHostId(),
        previousRootHostId: null,
        previousAuthorityHostId: null,
        previousAuthorityEpochId: null,
        destinationRootHostId: local.hostId,
        destinationAuthorityHostId: local.hostId,
        destinationHostBootId: local.hostBootId,
        destinationAuthorityEpochId: local.authorityEpochId,
        audit: {
          actorId: "operator",
          reason: "recovery test",
          evidence: ["manual verification"],
          acknowledgedSplitBrainRisk: false,
          requestedAt: now.toISOString(),
        },
      } as unknown as AuthorityForceAdoptInput),
    ).toThrow();

    const previousRootHostId = newHostId();
    const previousAuthorityEpochId = newAuthorityEpochId();
    catalog.applyParentAttachment({
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
      parentHostId: previousRootHostId,
      childHostId: local.hostId,
      rootHostId: previousRootHostId,
      authorityHostId: previousRootHostId,
      authorityEpochId: previousAuthorityEpochId,
      attachedAt: now.toISOString(),
    });
    expect(() =>
      catalog.forceAdoptAuthority({
        subtreeRootHostId: local.hostId,
        previousRootHostId,
        previousAuthorityHostId: previousRootHostId,
        previousAuthorityEpochId: newAuthorityEpochId(),
        destinationRootHostId: local.hostId,
        destinationAuthorityHostId: local.hostId,
        destinationHostBootId: local.hostBootId,
        destinationAuthorityEpochId: newAuthorityEpochId(),
        audit: {
          actorId: "operator",
          reason: "old authority epoch must be exact",
          evidence: ["manual verification"],
          acknowledgedSplitBrainRisk: true,
          requestedAt: now.toISOString(),
        },
      }),
    ).toThrow(/previous-authority tuple is stale/);
    catalog.close();
  });
});

describe("HostService authority routing", () => {
  it("attributes force-adopt to the authenticated transport actor", async () => {
    const now = new Date("2030-06-01T00:00:00.000Z");
    const catalog = new HostCatalog({ filename: ":memory:", now: () => now });
    const service = new HostService({ catalog, instanceId: "force-actor" });
    const router = createCompositeHostRouter(service);
    const local = catalog.localHost();
    const request: AuthorityForceAdoptInput = {
      subtreeRootHostId: newHostId(),
      previousRootHostId: null,
      previousAuthorityHostId: null,
      previousAuthorityEpochId: null,
      destinationRootHostId: local.hostId,
      destinationAuthorityHostId: local.hostId,
      destinationHostBootId: local.hostBootId,
      destinationAuthorityEpochId: local.authorityEpochId,
      audit: {
        actorId: "caller-controlled-forgery",
        reason: "recover an externally verified detached subtree",
        evidence: ["operator verification"],
        acknowledgedSplitBrainRisk: true,
        requestedAt: now.toISOString(),
      },
    };

    await expect(
      router.createCaller({}).fleet.authority.forceAdopt(request),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const receipt = await router
      .createCaller({ authenticatedActorId: "observer-p2p-endpoint" })
      .fleet.authority.forceAdopt(request);
    expect(receipt).toMatchObject({
      mode: "forced",
      audit: { actorId: "observer-p2p-endpoint" },
    });

    service.close();
    catalog.close();
  });

  it("coordinates a handoff by addressing the independent source and destination roots", async () => {
    const now = new Date("2031-01-01T00:00:00.000Z");
    const sourceCatalog = new HostCatalog({ filename: ":memory:", now: () => now });
    const destinationSigner = createP2PAuthorityAcceptanceSigner(randomBytes(32));
    const destinationCatalog = new HostCatalog({
      filename: ":memory:",
      now: () => now,
      endpointId: destinationSigner.endpointId,
    });
    const sourceService = new HostService({
      catalog: sourceCatalog,
      instanceId: "routing-source",
    });
    const destinationService = new HostService({
      catalog: destinationCatalog,
      instanceId: "routing-destination",
      authorityAcceptanceSigner: destinationSigner,
    });
    const source = sourceCatalog.localHost();
    const destination = destinationCatalog.localHost();
    const offerInput: AuthorityHandoffOfferInput = {
      subtreeRootHostId: source.hostId,
      sourceRootHostId: source.hostId,
      sourceAuthorityHostId: source.hostId,
      sourceAuthorityEpochId: source.authorityEpochId,
      destinationRootHostId: destination.hostId,
      destinationAuthorityHostId: destination.hostId,
      destinationAuthorityEndpointId: destinationSigner.endpointId,
      expiresAt: "2031-01-01T01:00:00.000Z",
    };

    const offer = await sourceService.offerAuthorityHandoff(offerInput);
    const acceptanceInput: AuthorityHandoffAcceptInput = {
      offer,
      acceptedByHostId: destination.hostId,
      acceptedByHostBootId: destination.hostBootId,
      destinationAuthorityEpochId: destination.authorityEpochId,
    };
    const acceptance = await destinationService.acceptAuthorityHandoff(acceptanceInput);
    const receipt = await sourceService.consumeAuthorityHandoff({ offer, acceptance });

    expect(sourceCatalog.getAuthorityHandoff(offer.handoffId)).toMatchObject({
      status: "consumed",
      receipt,
    });
    expect(destinationCatalog.getAuthorityHandoff(offer.handoffId)).toMatchObject({
      status: "accepted",
      acceptance,
    });
    await expect(
      destinationService.offerAuthorityHandoff({
        ...offerInput,
        expiresAt: "2031-01-01T02:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "FENCED" });

    sourceService.close();
    destinationService.close();
    sourceCatalog.close();
    destinationCatalog.close();
  });

  it("exposes authority mutations on fleet and fenced link routers", async () => {
    const now = new Date("2032-01-01T00:00:00.000Z");
    const sourceCatalog = new HostCatalog({ filename: ":memory:", now: () => now });
    const destinationSigner = createP2PAuthorityAcceptanceSigner(randomBytes(32));
    const destinationCatalog = new HostCatalog({
      filename: ":memory:",
      now: () => now,
      endpointId: destinationSigner.endpointId,
    });
    const sourceService = new HostService({ catalog: sourceCatalog, instanceId: "router-source" });
    const destinationService = new HostService({
      catalog: destinationCatalog,
      instanceId: "router-destination",
      authorityAcceptanceSigner: destinationSigner,
    });
    const sourceRouter = createCompositeHostRouter(sourceService);
    const destinationRouter = createCompositeHostRouter(destinationService);
    const source = sourceCatalog.localHost();
    const destination = destinationCatalog.localHost();
    const request: AuthorityHandoffOfferInput = {
      subtreeRootHostId: source.hostId,
      sourceRootHostId: source.hostId,
      sourceAuthorityHostId: source.hostId,
      sourceAuthorityEpochId: source.authorityEpochId,
      destinationRootHostId: destination.hostId,
      destinationAuthorityHostId: destination.hostId,
      destinationAuthorityEndpointId: destinationSigner.endpointId,
      expiresAt: "2032-01-01T01:00:00.000Z",
    };
    const fleetCaller = sourceRouter.createCaller({});
    const offer = await fleetCaller.fleet.authority.offerHandoff(request);
    const destinationCaller = destinationRouter.createCaller({
      authenticatedActorId: "destination-observer-endpoint",
    });
    const acceptance = await destinationCaller.fleet.authority.acceptHandoff({
      offer,
      acceptedByHostId: destination.hostId,
      acceptedByHostBootId: destination.hostBootId,
      destinationAuthorityEpochId: destination.authorityEpochId,
    });

    const parentId = newHostId();
    const parentAttachment: HostAttachment = {
      attachmentId: newAttachmentId(),
      lineageId: newLineageId(),
      parentHostId: parentId,
      childHostId: source.hostId,
      rootHostId: parentId,
      authorityHostId: parentId,
      authorityEpochId: newAuthorityEpochId(),
      attachedAt: now.toISOString(),
    };
    sourceCatalog.applyParentAttachment(parentAttachment);
    sourceCatalog.enrollPeer("parent-endpoint", "parentHost", parentId);
    const linkCaller = sourceRouter.createCaller({
      authenticatedHostId: parentId,
      endpointId: "parent-endpoint",
    });
    await expect(
      linkCaller.link.authority.consumeHandoff({
        ...fenceFor(sourceCatalog),
        hostBootId: newHostBootId(),
        request: { offer, acceptance },
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    sourceService.close();
    destinationService.close();
    sourceCatalog.close();
    destinationCatalog.close();
  });
});

function fenceFor(catalog: HostCatalog): HostLinkFence {
  const local = catalog.localHost();
  if (local.attachmentId === null) throw new Error("authority test host is not attached");
  return {
    hostId: local.hostId,
    hostBootId: local.hostBootId,
    attachmentId: local.attachmentId,
    lineageId: local.lineageId,
  };
}
