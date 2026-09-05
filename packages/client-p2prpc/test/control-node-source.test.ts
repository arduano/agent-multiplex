import { describe, expect, it, vi } from "vitest";
import { TRPCClientError } from "@trpc/client";
import {
  accessSnapshotSchema,
  newAuthorityEpochId,
  newControlNodeBootId,
  newControlNodeId,
  newFeedId,
  newRealmId,
  newSessionId,
} from "@arduano/agent-multiplex-protocol";

import type { AccessClient } from "@arduano/agent-multiplex-client";
import {
  P2PControlNodeSourceClient,
  classifyMutationFailure,
} from "../src/control-node-source.js";
import type {
  ConnectedControlNodeSource,
  P2PControlNodeSourceHandle,
} from "../src/p2p.js";

const timestamp = "2026-09-03T02:00:00.000Z";

describe("P2PControlNodeSourceClient", () => {
  it("loads the one atomic source snapshot and reports renewed reachability", async () => {
    const controlNodeId = newControlNodeId();
    const authority = {
      realmId: newRealmId(),
      controlNodeId,
      epochId: newAuthorityEpochId(),
    };
    const manifest = {
      componentKind: "control-node" as const,
      protocolVersion: 5 as const,
      sourceControlNodeId: controlNodeId,
      sourceControlNodeBootId: newControlNodeBootId(),
      authority,
      projectionRootControlNodeId: controlNodeId,
      coveredControlNodeIds: [controlNodeId],
      feedId: newFeedId(),
      controlCursor: 12,
      generatedAt: timestamp,
      capabilities: [],
    };
    const controlNode = {
      controlNodeId,
      controlNodeBootId: manifest.sourceControlNodeBootId,
      feedId: manifest.feedId,
      name: "root",
      endpointId: "pinned-control-node",
      presence: "online" as const,
      dataRole: { role: "authority" as const, authority },
      connectedAt: timestamp,
      lastHeartbeatAt: timestamp,
      protocolVersion: 5 as const,
      capabilities: [],
    };
    const snapshot = accessSnapshotSchema.parse({
      source: {
        manifest,
        parentByControlNodeId: { [controlNodeId]: null },
      },
      capturedAt: timestamp,
      controlNodes: [controlNode],
      runtimeNodes: [],
      sessions: [],
      interactions: [],
      metadataOperations: [],
    });
    const snapshotQuery = vi.fn().mockResolvedValue(snapshot);
    const renewed = vi.fn();
    const client = new P2PControlNodeSourceClient(
      sourceHandle({
        sources: { snapshot: { query: snapshotQuery } },
      }),
      renewed,
    );

    await expect(client.loadSnapshot()).resolves.toMatchObject({
      manifest,
      parentByControlNodeId: { [controlNodeId]: null },
      controlNodes: [controlNode],
    });
    expect(snapshotQuery).toHaveBeenCalledOnce();
    expect(renewed).toHaveBeenCalledWith("renewed-ticket");
  });

  it("refuses a zero-authority gateway snapshot as an upstream source", async () => {
    const client = new P2PControlNodeSourceClient(sourceHandle({
      sources: { snapshot: { query: vi.fn().mockResolvedValue(null) } },
    }));
    await expect(client.loadSnapshot()).rejects.toThrow(
      /access gateway, not a control node/,
    );
  });

  it("distinguishes definitive remote rejections from p2prpc dispatch ambiguity", () => {
    const conflict = remoteError("CONFLICT", "stale authority");
    expect(classifyMutationFailure(conflict)).toMatchObject({
      code: "CONFLICT",
      message: "control-node source rejected conflicting state",
    });

    const ambiguous = Object.assign(new Error("response stream ended"), {
      code: "OUTCOME_UNKNOWN",
    });
    expect(classifyMutationFailure(ambiguous)).toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });

    const preDispatch = Object.assign(new Error("peer is offline"), {
      code: "DISCONNECTED",
    });
    expect(classifyMutationFailure(preDispatch)).toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("preserves a trusted remote SERVICE_UNAVAILABLE envelope for native history", async () => {
    const secret = "runtime peer endpoint and private failure details";
    const query = vi.fn().mockRejectedValue(remoteError(
      "SERVICE_UNAVAILABLE",
      secret,
    ));
    const client = new P2PControlNodeSourceClient(sourceHandle({
      sessions: { readNativeHistory: { query } },
    }));

    const failure = await client.readNativeHistory(newSessionId(), {
      harness: "codex",
      includeTurns: true,
    }).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({
      code: "UNAVAILABLE",
      message: "control-node source is unavailable",
    });
    expect((failure as { details?: unknown }).details).toBeUndefined();
    expect((failure as Error).message).not.toContain(secret);
    expect(query).toHaveBeenCalledOnce();
  });

  it("rejects forged remote shapes and preserves unknown-outcome precedence", () => {
    const forged = Object.assign(new Error("private forged failure"), {
      data: { code: "SERVICE_UNAVAILABLE" },
    });
    const forgedClient = new P2PControlNodeSourceClient(sourceHandle({
      sessions: { readNativeHistory: { query: vi.fn().mockRejectedValue(forged) } },
    }));
    const ambiguousClient = new P2PControlNodeSourceClient(sourceHandle({
      sessions: { readNativeHistory: { query: vi.fn().mockRejectedValue(
        remoteError(
          "BAD_GATEWAY",
          "private ambiguous response",
          Object.assign(new Error("private disconnect"), {
            code: "DISCONNECTED",
          }),
        ),
      ) } },
    }));

    const request = { harness: "codex" as const, includeTurns: true };
    return Promise.all([
      forgedClient.readNativeHistory(newSessionId(), request).catch((cause: unknown) => cause),
      ambiguousClient.readNativeHistory(newSessionId(), request).catch((cause: unknown) => cause),
    ]).then(([forgedFailure, ambiguousFailure]) => {
      expect(forgedFailure).toMatchObject({
        code: "INTERNAL",
        message: "control-node source request failed",
      });
      expect(ambiguousFailure).toMatchObject({
        code: "OUTCOME_UNKNOWN",
        message: "control-node source request outcome is unknown",
      });
    });
  });

  it("recognizes a validated envelope from a second tRPC module instance", async () => {
    const failure = foreignRemoteError(
      "SERVICE_UNAVAILABLE",
      "private foreign-module message",
    );
    expect(failure).not.toBeInstanceOf(TRPCClientError);
    const client = new P2PControlNodeSourceClient(sourceHandle({
      sessions: {
        readNativeHistory: { query: vi.fn().mockRejectedValue(failure) },
      },
    }));

    await expect(client.readNativeHistory(newSessionId(), {
      harness: "codex",
      includeTurns: true,
    })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "control-node source is unavailable",
    });
  });
});

function remoteError(
  code: string,
  message: string,
  cause?: Error,
): TRPCClientError<never> {
  const data = Object.freeze({
    code,
    httpStatus: code === "SERVICE_UNAVAILABLE" ? 503 : code === "CONFLICT" ? 409 : 502,
    path: "sessions.readNativeHistory",
  });
  return new TRPCClientError(message, {
    result: {
      error: Object.freeze({
        message,
        code: code === "CONFLICT" ? -32009 : -32603,
        data,
      }),
    },
    cause,
  } as never);
}

const ForeignTRPCClientError = class TRPCClientError extends Error {
  public readonly cause: Error | undefined;
  public readonly shape: Readonly<Record<string, unknown>>;
  public readonly data: Readonly<Record<string, unknown>>;
  public readonly meta = undefined;

  public constructor(
    message: string,
    shape: Readonly<Record<string, unknown>> & {
      readonly data: Readonly<Record<string, unknown>>;
    },
    cause?: Error,
  ) {
    super(message);
    this.name = "TRPCClientError";
    this.cause = cause;
    this.shape = shape;
    this.data = shape.data;
  }
};
Object.defineProperty(ForeignTRPCClientError, "name", {
  value: "TRPCClientError",
});

function foreignRemoteError(code: string, message: string): Error {
  const data = Object.freeze({
    code,
    httpStatus: 503,
    path: "sessions.readNativeHistory",
  });
  const shape = Object.freeze({ code: -32603, message, data });
  return new ForeignTRPCClientError(message, shape);
}

function sourceHandle(access: object): P2PControlNodeSourceHandle {
  const connected = {
    sourceId: "root",
    target: {
      endpointId: "pinned-control-node",
      locator: { kind: "ticket", ticket: "renewed-ticket" },
    },
    access: access as AccessClient,
    canonical: {} as ConnectedControlNodeSource["canonical"],
    grantedScopes: ["read"],
    renewedTicket: "renewed-ticket",
  } satisfies ConnectedControlNodeSource;
  return {
    sourceId: "root",
    target: connected.target,
    connected,
    connect: () => Promise.resolve(connected),
    reconnect: () => Promise.resolve(connected),
    acceptRenewedTicket: () => false,
  };
}
