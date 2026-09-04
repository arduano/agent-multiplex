import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AccessClient } from "@arduano/agent-multiplex-client";
import { watchTerminal } from "@arduano/agent-multiplex-client";
import {
  P2PControlNodeSourceClient,
  type ConnectedControlNodeSource,
  type P2PControlNodeSourceHandle,
} from "@arduano/agent-multiplex-client-p2prpc";
import {
  ControlNodeCatalog,
  ControlNodeService,
} from "@arduano/agent-multiplex-control-node-core";
import {
  AccessGatewayProjection,
  type GatewaySourceDefinition,
} from "@arduano/agent-multiplex-gateway-core";
import {
  TERMINAL_MAX_REPLAY_ITEMS,
  TERMINAL_STREAM_BUFFER_ITEMS,
  adapterScopeIdSchema,
  newRuntimeEpoch,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newTerminalId,
  type RuntimeNodeRegistration,
  type SourceId,
  type TerminalAttachInput,
  type TerminalDescriptor,
  type TerminalStreamItem,
} from "@arduano/agent-multiplex-protocol";
import { P2PRuntimeNodeConnection } from "@arduano/agent-multiplex-transport-p2prpc";
import { describe, expect, it } from "vitest";

const timestamp = "2037-04-05T06:07:08.000Z";

describe("distributed terminal replay", () => {
  it("carries a maximum exact replay and live output through every queue", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-multiplex-terminal-replay-"));
    const runtimeNodeId = newRuntimeNodeId();
    const runtimeNodeBootId = newRuntimeNodeBootId();
    const adapterScopeId = adapterScopeIdSchema.parse("codex:distributed-replay");
    const endpointId = "distributed-replay-runtime";
    let runtimeItems: readonly TerminalStreamItem[] = [];
    const runtimeUnsubscribe = () => undefined;
    const runtimeConnection = new P2PRuntimeNodeConnection(
      runtimeNodeId,
      runtimeNodeBootId,
      endpointId,
      {
        identity: { id: endpointId },
        principal: { id: endpointId },
        rpc: {
          terminals: {
            attach: {
              subscribe: (
                _input: unknown,
                callbacks: TerminalCallbacks,
              ) => {
                callbacks.onStarted?.();
                for (const item of runtimeItems) callbacks.onData(item);
                return { unsubscribe: runtimeUnsubscribe };
              },
            },
          },
        },
      } as never,
      endpointId,
    );
    const catalog = new ControlNodeCatalog({
      filename: join(directory, "control.sqlite"),
      now: () => new Date(timestamp),
    });
    const service = new ControlNodeService({
      catalog,
      now: () => new Date(timestamp),
    });

    const registration: RuntimeNodeRegistration = {
      runtimeNodeId,
      runtimeNodeBootId,
      name: "distributed replay runtime",
      allowedRoots: ["/work"],
      harnesses: [{
        harness: "codex",
        adapterScopeId,
        available: true,
        capabilities: [{
          name: "terminal.side-channel",
          version: "v1",
          experimental: false,
        }],
      }],
      launchProfiles: [],
      protocolVersion: 4,
    };
    const ingress = {
      endpointId,
      authenticatedRuntimeNodeId: runtimeNodeId,
      runtimeNodeConnection: runtimeConnection,
    };
    service.registerRuntimeNode(registration, ingress);
    const [session] = service.reconcile({
      runtimeNodeId,
      runtimeNodeBootId,
      snapshot: {
        runtimeNodeId,
        generation: "distributed-replay-inventory",
        complete: true,
        capturedAt: timestamp,
        sessions: [{
          harness: "codex",
          adapterScopeId,
          vendorSessionId: "native-distributed-replay",
          cwd: "/work/project",
          availability: "active",
          runtimeStatus: "idle",
          runtimeEpoch: newRuntimeEpoch(),
          lastActivityAt: timestamp,
        }],
      },
    }, ingress).sessions;
    if (!session) throw new Error("control node did not import the runtime session");

    const terminalId = newTerminalId();
    const target = {
      sessionId: session.sessionId,
      runtimeNodeId,
      bindingRevision: session.bindingRevision,
    };
    const initialDimensions = { columns: 80, rows: 24 };
    let dimensions = initialDimensions;
    const timeline: TerminalStreamItem[] = [];
    for (let sequence = 1; sequence <= TERMINAL_MAX_REPLAY_ITEMS; sequence += 1) {
      if (sequence % 2 === 1) {
        timeline.push({
          kind: "output",
          cursor: { terminalId, sequence },
          dataBase64: "eA==",
        });
      } else {
        dimensions = dimensions.columns === 80
          ? { columns: 81, rows: 24 }
          : { columns: 80, rows: 24 };
        timeline.push({
          kind: "resize",
          cursor: { terminalId, sequence },
          dimensions,
        });
      }
    }
    const descriptor = terminalDescriptor({
      ...target,
      runtimeNodeBootId,
      terminalId,
      sequence: TERMINAL_MAX_REPLAY_ITEMS,
      dimensions,
    });
    runtimeItems = [{
      kind: "replayStart",
      cursor: { terminalId, sequence: 0 },
      initialDimensions,
      terminal: descriptor,
    }, ...timeline, {
      kind: "replayEnd",
      cursor: { terminalId, sequence: TERMINAL_MAX_REPLAY_ITEMS },
      terminal: descriptor,
    }, {
      kind: "output",
      cursor: { terminalId, sequence: TERMINAL_MAX_REPLAY_ITEMS + 1 },
      dataBase64: "eg==",
    }];

    const attachInput: TerminalAttachInput = { ...target, terminalId };
    const controlItems: TerminalStreamItem[] = [];
    let unblockFirst: (() => void) | undefined;
    try {
      for await (const item of service.attachTerminal(attachInput)) {
        controlItems.push(item);
        if (controlItems.length === runtimeItems.length) break;
      }
      expect(controlItems).toEqual(runtimeItems);

      const access = synchronousTerminalAccess(service, controlItems);
      const connected = connectedSource(access, service);
      const sourceClient = new P2PControlNodeSourceClient({
        sourceId: connected.sourceId,
        target: connected.target,
        connected,
        connect: async () => connected,
        reconnect: async () => connected,
        acceptRenewedTicket: () => false,
      } satisfies P2PControlNodeSourceHandle);
      const gateway = new AccessGatewayProjection([{
        sourceId: connected.sourceId as SourceId,
        displayName: "distributed replay control",
        endpointId: connected.target.endpointId,
        client: sourceClient,
      } satisfies GatewaySourceDefinition]);
      expect(await gateway.refreshAll()).toMatchObject([{ status: "fulfilled" }]);

      const firstBlocked = new Promise<void>((resolve) => { unblockFirst = resolve; });
      let first = true;
      let forwarded = 0;
      let resolveForwarded!: () => void;
      const allForwarded = new Promise<void>((resolve) => { resolveForwarded = resolve; });
      const pumps: Promise<void>[] = [];
      const states: string[] = [];
      const received: TerminalStreamItem[] = [];
      let resolveConsumed!: () => void;
      const allConsumed = new Promise<void>((resolve) => { resolveConsumed = resolve; });
      const procedure = {
        subscribe: (input: TerminalAttachInput, callbacks: TerminalCallbacks) => {
          const controller = new AbortController();
          callbacks.onStarted?.();
          const pump = (async () => {
            try {
              for await (const item of gateway.attachTerminal(input, controller.signal)) {
                callbacks.onData(item);
                forwarded += 1;
                if (forwarded === runtimeItems.length) resolveForwarded();
              }
            } catch (cause) {
              if (!controller.signal.aborted) callbacks.onError(cause);
            }
          })();
          pumps.push(pump);
          return { unsubscribe: () => controller.abort() };
        },
      };
      const watcher = watchTerminal(procedure, {
        target,
        terminalId,
        maxPendingItems: TERMINAL_STREAM_BUFFER_ITEMS,
        onStateChange: (state) => states.push(state.state),
        onItem: async (item) => {
          if (first) {
            first = false;
            await firstBlocked;
          }
          received.push(item);
          if (received.length === runtimeItems.length) resolveConsumed();
        },
      });

      await Promise.race([
        allForwarded,
        rejectAfter(10_000, "timed out filling distributed terminal queues"),
      ]);
      expect(watcher.cursor).toBeUndefined();
      expect(states).not.toContain("failed");
      unblockFirst?.();
      unblockFirst = undefined;
      await Promise.race([
        allConsumed,
        rejectAfter(10_000, "timed out draining distributed terminal queues"),
      ]);
      await eventually(() => watcher.cursor?.sequence === TERMINAL_MAX_REPLAY_ITEMS + 1);
      expect(received).toEqual(runtimeItems);
      expect(watcher.cursor).toEqual({
        terminalId,
        sequence: TERMINAL_MAX_REPLAY_ITEMS + 1,
      });
      expect(states).not.toContain("failed");

      watcher.stop();
      await watcher.done;
      await Promise.all(pumps);
    } finally {
      unblockFirst?.();
      service.close();
      catalog.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

interface TerminalCallbacks {
  onData(item: TerminalStreamItem): void;
  onError(error: unknown): void;
  onComplete(): void;
  onStarted?(): void;
}

function terminalDescriptor(
  value: Pick<
    TerminalDescriptor,
    | "sessionId"
    | "runtimeNodeId"
    | "bindingRevision"
    | "runtimeNodeBootId"
    | "terminalId"
    | "sequence"
    | "dimensions"
  >,
): TerminalDescriptor {
  return {
    ...value,
    backend: "mock",
    sharing: "session",
    foregroundSessionId: null,
    state: "running",
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

function synchronousTerminalAccess(
  service: ControlNodeService,
  items: readonly TerminalStreamItem[],
): AccessClient {
  return {
    sources: {
      snapshot: { query: async () => service.sourceSnapshot() },
    },
    terminals: {
      attach: {
        subscribe: (_input: TerminalAttachInput, callbacks: TerminalCallbacks) => {
          callbacks.onStarted?.();
          for (const item of items) callbacks.onData(item);
          return { unsubscribe() {} };
        },
      },
    },
  } as unknown as AccessClient;
}

function connectedSource(
  access: AccessClient,
  service: ControlNodeService,
): ConnectedControlNodeSource {
  const target = {
    endpointId: "distributed-replay-control",
    locator: { kind: "ticket" as const, ticket: "distributed-replay-ticket" },
  };
  return {
    sourceId: "distributed-replay-control",
    target,
    access,
    canonical: service.listControlNodes()[0]!,
    grantedScopes: ["read", "terminal-view"],
    renewedTicket: undefined,
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for terminal replay convergence");
}

async function rejectAfter(milliseconds: number, message: string): Promise<never> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  throw new Error(message);
}
