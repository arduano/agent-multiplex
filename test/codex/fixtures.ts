import { codexSelectionSchema } from "../../src/codex/contracts.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
  canonical,
  sameOpening,
  type NativeAllocationBackend,
  type NativeAllocationOptions,
  type OpeningCapsule,
  type OpeningRef,
  type OpeningStopProof,
} from "../../src/runtime/index.js";
import { CodexAdapter, type CodexOptions, type CodexWire } from "../../src/codex/node.js";
import type { SessionScope } from "../../src/protocol/index.js";

export const scope: SessionScope = {
  connection: "connection",
  principal: "owner",
  host: "host",
  session: "session",
};
export const opening = { operationId: "create", generation: 1, scope };
export const selection = {
  kind: "codex",
  model: "fixture-luna",
  access: { approval: "on-request", sandbox: "danger-full-access" },
} as const;
export type Request = { id: number; method: string; params?: Record<string, unknown> };
export type Handler = (request: Request, wire: ScriptedWire) => unknown | Promise<unknown>;
export class ScriptedWire implements CodexWire {
  readonly requests: Request[] = [];
  readonly written: Record<string, unknown>[] = [];
  readonly data = new Set<(value: string) => void>();
  readonly closes = new Set<() => void>();
  closed = false;
  constructor(readonly handler: Handler) {}
  emit(value: unknown): void {
    for (const listener of this.data) listener(JSON.stringify(value) + "\n");
  }
  async write(line: string): Promise<void> {
    const value = JSON.parse(line) as Record<string, unknown>;
    this.written.push(value);
    if (typeof value.id === "number" && typeof value.method === "string") {
      const request = value as unknown as Request;
      this.requests.push(request);
      const result = await this.handler(request, this);
      if (result !== undefined) this.emit({ id: request.id, result });
    }
  }
  onData(listener: (value: string) => void) {
    this.data.add(listener);
    return () => {
      this.data.delete(listener);
    };
  }
  onClose(listener: () => void) {
    this.closes.add(listener);
    return () => {
      this.closes.delete(listener);
    };
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closes) listener();
  }
}
export function stopProof(capsule: OpeningCapsule): OpeningStopProof {
  return {
    ...capsule,
    state: "stopped",
    scope: "nativeTree",
    acquisitionSealed: true,
    noAutomaticContinuation: true,
  };
}
export function defaultHandler(request: Request, wire: ScriptedWire): unknown {
  const params = request.params ?? {};
  if (request.method === "initialize") return { userAgent: "codex/0.162.1 fixture" };
  if (request.method === "thread/start" || request.method === "thread/resume")
    return {
      thread: {
        id: params.threadId ?? "native-root",
        sessionId: "native-root",
        status: { type: "idle" },
      },
      model: params.model,
      modelProvider: params.modelProvider,
      approvalPolicy: params.approvalPolicy,
      sandbox: { type: "dangerFullAccess" },
      reasoningEffort: null,
    };
  if (request.method === "turn/start") {
    const id = `turn-${request.id}`;
    wire.emit({
      method: "turn/started",
      params: { threadId: params.threadId, turn: { id, status: "inProgress" } },
    });
    return { turn: { id, status: "inProgress" } };
  }
  if (request.method === "turn/steer") return { turnId: params.expectedTurnId };
  if (request.method === "thread/queue/add")
    return {
      queuedSubmission: { id: "queued-1", clientUserMessageId: params.clientUserMessageId },
    };
  if (request.method === "turn/settings/update") return { status: "applied" };
  if (request.method === "thread/settings/update") {
    wire.emit({
      method: "thread/settings/updated",
      params: { threadId: params.threadId, threadSettings: { ...params } },
    });
    return {};
  }
  if (request.method === "thread/goal/get" || request.method === "thread/goal/set")
    return {
      goal: {
        threadId: params.threadId,
        objective: params.objective ?? "Fixture goal",
        status: params.status ?? "active",
        tokenBudget: params.tokenBudget ?? null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    };
  if (request.method === "thread/goal/clear") return { cleared: true };
  if (request.method === "thread/backgroundTerminals/terminate") return { terminated: true };
  if (request.method === "thread/backgroundTerminals/list")
    return {
      data: [
        {
          itemId: "tool-1",
          processId: "process-1",
          command: "echo fixture",
          cwd: "/fixture",
          osPid: null,
          cpuPercent: null,
          rssKb: null,
        },
      ],
      nextCursor: null,
    };
  if (request.method === "model/list")
    return {
      data: [
        {
          id: "fixture-model-id",
          model: "fixture-luna",
          upgrade: null,
          upgradeInfo: null,
          availabilityNux: null,
          displayName: "Fixture Luna",
          description: "Scripted model",
          modelSpecialty: null,
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Low" },
            { reasoningEffort: "high", description: "High" },
          ],
          defaultReasoningEffort: "low",
          inputModalities: ["text", "image"],
          supportsPersonality: false,
          multiAgentVersion: null,
          additionalSpeedTiers: [],
          serviceTiers: [],
          defaultServiceTier: null,
          availableAccessPrograms: null,
          isDefault: true,
        },
      ],
      nextCursor: null,
    };
  if (request.method === "mcpServerStatus/list")
    return { data: [{ name: "local", tools: { fixture: {} } }], nextCursor: null };
  if (request.method === "mcpServer/oauth/login")
    return { loginId: "login-1", authorizationUrl: "https://auth.invalid/verify?private=fixture" };
  if (request.method === "thread/read")
    return {
      thread: {
        id: params.threadId,
        sessionId: "native-root",
        parentThreadId: params.threadId === "native-root" ? null : "native-root",
        status: { type: "idle" },
      },
    };
  if (request.method === "thread/timeline/list")
    return {
      threadId: params.threadId,
      data: [
        {
          position: 1,
          type: "item",
          turnId: "old-turn",
          item: {
            id: "old",
            type: "agentMessage",
            text: "retained history",
            phase: "final_answer",
          },
        },
      ],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: null,
    };
  return {};
}
export async function fixture(
  options: Partial<CodexOptions> = {},
  handler: Handler = defaultHandler,
) {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-codex-")),
    wires: ScriptedWire[] = [],
    allocations: NativeAllocationOptions[] = [];
  const owners = new Map<string, { capsule: OpeningCapsule; stopped: boolean }>();
  const backend: NativeAllocationBackend = {
    allocate(input) {
      allocations.push(input);
      let capsule: OpeningCapsule | undefined,
        stopped = false;
      const prepare = async () => {
        assert(!stopped);
        return {
          launcher: join(directory, "scripted-launcher.js"),
          identity: {
            attachment: `attachment-${allocations.length}`,
            process: `process-${allocations.length}`,
            containment: `containment-${allocations.length}`,
            placement: "dedicated" as const,
          },
        };
      };
      const stop = async () => {
        stopped = true;
        assert(capsule);
        owners.get(canonical(capsule.opening))!.stopped = true;
        return capsule.identity;
      };
      return {
        get identity() {
          return capsule?.identity ?? null;
        },
        get sealed() {
          return stopped;
        },
        prepare,
        async opening(ref: OpeningRef) {
          assert.equal(
            input.reference,
            canonical(ref),
            "Runtime allocator requires exact canonical opening reference",
          );
          const prepared = await prepare();
          capsule = { opening: structuredClone(ref), identity: prepared.identity };
          owners.set(canonical(ref), { capsule, stopped });
          return {
            ...capsule,
            stop: async () => ({ ...stopProof(capsule!), identity: await stop() }),
          };
        },
        assertLaunchable() {
          assert(!stopped);
        },
        async inspect() {
          return stopped ? "gone" : "created";
        },
        stop,
      };
    },
    async inspectOpening(capsule) {
      const held = owners.get(canonical(capsule.opening));
      if (!held || !sameOpening(held.capsule, capsule)) return null;
      return held.stopped
        ? stopProof(capsule)
        : {
            ...capsule,
            stop: async () => {
              held.stopped = true;
              return stopProof(capsule);
            },
          };
    },
  };
  const adapter = new CodexAdapter({
    node: process.execPath,
    binary: "/fixture/codex.js",
    packageRoot: "/fixture",
    directory,
    homeRoot: join(directory, "homes"),
    environment: { FIXTURE_PROVIDER_KEY: "fixture-credential" },
    provider: {
      id: "fixture",
      baseUrl: "https://provider.invalid/v1",
      environmentKey: "FIXTURE_PROVIDER_KEY",
      copilotOnly: true,
    },
    model: "fixture-luna",
    allocation: backend,
    wire: () => {
      const wire = new ScriptedWire(handler);
      wires.push(wire);
      return wire;
    },
    ...options,
  });
  return {
    adapter,
    directory,
    wires,
    allocations,
    backend,
    owners,
    async prepare(input: Pick<Parameters<CodexAdapter["prepare"]>[0], "opening" | "cwd">) {
      const value = await adapter.prepare({
        ...input,
        mode: "create",
        selectionSource: "requested",
        selection: codexSelectionSchema.parse(selection),
      });
      assert(!("state" in value));
      return value;
    },
    async open(mode: "create" | "reopen" = "create", generation = 1) {
      const parked = await adapter.prepare({
        opening: { ...opening, generation, operationId: generation === 1 ? "create" : "reopen" },
        cwd: directory,
        mode,
        selectionSource: "requested",
        selection: codexSelectionSchema.parse(selection),
      });
      assert(!("state" in parked));
      const result = await adapter.open({
        capsule: parked,
        cwd: directory,
        mode,
        nativeSession: mode === "create" ? null : "native-root",
        selectionSource: "requested",
        selection: codexSelectionSchema.parse(selection),
        commitBinding() {},
      });
      return { capsule: { opening: parked.opening, identity: parked.identity }, result };
    },
    async cleanup() {
      for (const held of owners.values()) await adapter.stop(held.capsule).catch(() => {});
      await adapter.close().catch(() => {});
      assert(wires.every((value) => value.closed));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
