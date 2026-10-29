import { copilotSelectionSchema } from "../../src/copilot/contracts.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  canonical,
  type NativeAllocation,
  type NativeAllocationOptions,
  type NativeOpening,
  type OpeningCapsule,
  type OpeningIdentity,
  type OpeningRef,
  type OpeningStopProof,
  type ReaderCustodyPort,
} from "../../src/runtime/index.js";
import { InteractionOwner } from "../../src/interactions/index.js";
import type { Json, RunRef } from "../../src/protocol/index.js";
import {
  createCopilotAdapter,
  type CopilotOptions,
  type SdkClient,
  type SdkSession,
  type SessionConfig,
} from "../../src/copilot/node.js";
export const scope = { connection: "c", principal: "p", host: "h", session: "s" };
export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export class Allocation implements NativeAllocation {
  readonly identity: OpeningIdentity;
  sealed = false;
  openingValue: OpeningRef | undefined;
  failStop = false;
  constructor(
    readonly options: NativeAllocationOptions,
    index: number,
  ) {
    this.identity = {
      attachment: `attachment${index}`,
      process: `process${index}`,
      containment: `containment${index}`,
      placement: "dedicated",
    };
  }
  async prepare() {
    return { launcher: `/scripted/${this.identity.attachment}`, identity: this.identity };
  }
  async opening(opening: OpeningRef): Promise<NativeOpening> {
    assert.equal(this.options.reference, canonical(opening));
    this.openingValue = opening;
    return {
      opening,
      identity: this.identity,
      stop: async () => ({
        ...this.capsule(),
        identity: await this.stop(),
        state: "stopped",
        scope: "nativeTree",
        noAutomaticContinuation: true,
        acquisitionSealed: true,
      }),
    };
  }
  capsule(): OpeningCapsule {
    return { opening: this.openingValue!, identity: this.identity };
  }
  assertLaunchable() {
    assert.equal(this.sealed, false);
  }
  async inspect() {
    return this.sealed ? ("gone" as const) : ("running" as const);
  }
  async stop() {
    if (this.failStop) throw Error("scripted stop failure");
    this.sealed = true;
    return this.identity;
  }
}
export class Client implements SdkClient {
  readonly calls: {
    method: string;
    input?: Readonly<Record<string, unknown>>;
  }[] = [];
  config: SessionConfig | undefined;
  sessionId = "";
  mode = "interactive";
  permissions = "allow-all";
  model = "m";
  effort = "high";
  working = false;
  creates = 0;
  resumes = 0;
  starts = 0;
  forceStops = 0;
  serial = 0;
  forceStopGate: Promise<void> | undefined;
  sendHook:
    | ((
        input: Readonly<{
          prompt: string;
          mode: "enqueue" | "immediate";
          attachments?: readonly Json[];
        }>,
      ) => Promise<string>)
    | undefined;
  modeFailure = false;
  pages: unknown[] = [];
  record(method: string, input?: Readonly<Record<string, unknown>>) {
    this.calls.push({ method, ...(input === undefined ? {} : { input }) });
  }
  async start() {
    this.starts++;
  }
  async getStatus() {
    return { version: "1.0.95", protocolVersion: 2 };
  }
  async forceStop() {
    this.forceStops++;
    await this.forceStopGate;
  }
  async listModels() {
    return [
      {
        id: "m",
        name: "Model",
        capabilities: { supports: { reasoningEffort: true, vision: true } },
        supportedReasoningEfforts: ["low", "high"],
        defaultReasoningEffort: "high",
      },
    ];
  }
  readonly rpc = {
    sessions: {
      readPersistedEvents: async (input?: Readonly<Record<string, unknown>>) => {
        this.record("sessions.readPersistedEvents", input);
        return (
          this.pages.shift() ?? { events: [], cursor: "end", hasMore: false, cursorStatus: "ok" }
        );
      },
    },
  };
  readonly session: SdkSession = {
    get sessionId() {
      return "";
    },
    send: async (input) => {
      this.record("send", input);
      return this.sendHook ? this.sendHook(input) : `message${++this.serial}`;
    },
    abort: async () => {
      this.record("abort");
    },
    rpc: {
      model: {
        getCurrent: async () => ({
          modelId: this.model,
          providerId: "native-route",
          reasoningEffort: this.effort,
        }),
        switchTo: async (input) => {
          this.record("model.switchTo", input);
          this.model = String(input!.modelId);
          if (typeof input!.reasoningEffort === "string") this.effort = input!.reasoningEffort;
          return { modelId: this.model };
        },
      },
      mode: {
        get: async () => this.mode,
        set: async (input) => {
          this.record("mode.set", input);
          if (this.modeFailure) throw Error("scripted mode failure");
          this.mode = String(input!.mode);
          return { modeApplied: true, modelChanged: false, status: "applied" };
        },
      },
      permissions: {
        getMode: async () => ({ mode: this.permissions }),
        setMode: async (input) => {
          this.record("permissions.setMode", input);
          this.permissions = String(input!.mode);
          return { success: true, mode: this.permissions };
        },
        setRequired: async (input) => {
          this.record("permissions.setRequired", input);
          return { success: true };
        },
        handlePendingPermissionRequest: async (input) => {
          this.record("permission.reply", input);
          return { success: true };
        },
      },
      metadata: {
        activity: async () => ({ hasActiveWork: this.working, abortable: this.working }),
      },
      queue: {
        pendingItems: async () => ({
          items: [{ id: "q", kind: "user", displayText: "queued", agentMode: "interactive" }],
          steeringMessages: ["steer"],
        }),
        sendNow: async (input) => {
          this.record("queue.sendNow", input);
          return { steered: true };
        },
      },
      tasks: {
        refresh: async () => {
          this.record("tasks.refresh");
          return {};
        },
        list: async () => ({
          tasks: [
            {
              id: "t",
              type: "agent",
              status: "running",
              description: "task",
              model: "requested",
              resolvedModel: "actual",
              canPromoteToBackground: true,
            },
          ],
        }),
        getProgress: async () => ({ progress: { type: "agent", recentActivity: [] } }),
        getCurrentPromotable: async () => ({
          task: { id: "t", type: "agent", status: "running", description: "task" },
        }),
        cancel: async (input) => {
          this.record("tasks.cancel", input);
          return { cancelled: true };
        },
        promoteToBackground: async (input) => {
          this.record("tasks.promote", input);
          return { promoted: false };
        },
      },
      history: {
        compact: async (input) => {
          this.record("history.compact", input);
          return {
            success: true,
            tokensRemoved: 10,
            messagesRemoved: 1,
            summary: "private summary",
          };
        },
      },
      mcp: {
        listConfigured: async () => ({
          servers: [{ name: "tools", enabled: true, live: { status: "connected" } }],
        }),
        restartServer: async (input) => {
          this.record("mcp.restart", input);
          return undefined;
        },
        oauth: {
          login: async (input) => {
            this.record("mcp.login", input);
            return {
              authorizationUrl: "https://example.test/oauth?secret=private",
              status: "awaiting-browser",
            };
          },
        },
      },
      eventLog: {
        read: async (input) => {
          this.record("eventLog.read", input);
          return { events: [], cursor: "end", hasMore: false, cursorStatus: "ok" };
        },
      },
    },
  };
  async createSession(config: SessionConfig) {
    this.creates++;
    return this.bind(config);
  }
  async resumeSession(id: string, config: SessionConfig) {
    this.resumes++;
    assert.equal(config.continuePendingWork, true);
    assert.equal(config.allowTranscriptRecovery, false);
    return this.bind({ ...config, sessionId: id });
  }
  private bind(config: SessionConfig): SdkSession {
    this.config = config;
    this.sessionId = String(config.sessionId);
    return { ...this.session, sessionId: this.sessionId };
  }
  emit(type: string, data: Readonly<Record<string, unknown>>, agentId?: string): void {
    this.config!.onEvent({
      id: `event${++this.serial}`,
      type,
      data,
      ...(agentId === undefined ? {} : { agentId }),
    });
  }
}
export async function fixture(
  run: (value: Awaited<ReturnType<typeof make>>) => Promise<void>,
  patch: Partial<CopilotOptions> = {},
) {
  const value = await make(patch);
  try {
    await run(value);
  } finally {
    for (const allocation of value.allocations)
      if (allocation.options.kind === "agent" && allocation.openingValue)
        await value.adapter.native.stop(allocation.capsule()).catch(() => {});
    await tick();
    await Promise.resolve(value.adapter.native.close()).catch(() => {});
    await rm(value.directory, { recursive: true, force: true });
  }
}
async function make(patch: Partial<CopilotOptions>) {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-copilot-"));
  const allocations: Allocation[] = [],
    clients: Client[] = [],
    owners: InteractionOwner[] = [];
  const adapter = createCopilotAdapter({
    binary: "/scripted/copilot",
    packageRoot: "/scripted/package",
    directory,
    homeRoot: join(directory, "homes"),
    environment: { TEST_SECRET: "private" },
    provider: { id: "route", copilotOnly: true, config: {} },
    requireCopilotOnly: true,
    allocation: {
      allocate(input) {
        const allocation = new Allocation(input, allocations.length);
        allocations.push(allocation);
        return allocation;
      },
      async inspectOpening(capsule) {
        const owner = allocations.find(
          (value) => canonical(value.capsule()) === canonical(capsule),
        );
        return owner?.sealed
          ? {
              ...capsule,
              state: "stopped",
              scope: "nativeTree",
              noAutomaticContinuation: true,
              acquisitionSealed: true,
            }
          : owner
            ? {
                ...capsule,
                stop: async () => ({
                  ...capsule,
                  identity: await owner.stop(),
                  state: "stopped",
                  scope: "nativeTree",
                  noAutomaticContinuation: true,
                  acquisitionSealed: true,
                }),
              }
            : null;
      },
    },
    client() {
      const client = new Client();
      clients.push(client);
      return client;
    },
    interactions(native, attachment) {
      const owner = new InteractionOwner(native, attachment);
      owners.push(owner);
      return owner;
    },
    ...patch,
  });
  return {
    adapter,
    directory,
    allocations,
    clients,
    owners,
    async open(generation = 1, nativeSession: string | null = null) {
      const opening = { scope, generation, operationId: `open${generation}` };
      const held = await adapter.native.prepare({
        opening,
        cwd: directory,
        mode: nativeSession === null ? "create" : "reopen",
        selectionSource: "requested",
        selection: copilotSelectionSchema.parse({ model: "m" }),
      });
      if ("state" in held) throw Error("Unexpected prepare refusal");
      const capsule = { opening: held.opening, identity: held.identity };
      const bindings: RunRef[] = [];
      const result = await adapter.native.open({
        capsule,
        cwd: directory,
        mode: nativeSession === null ? "create" : "reopen",
        nativeSession,
        selectionSource: "requested",
        selection: copilotSelectionSchema.parse({
          kind: "copilot",
          model: "m",
          effort: "high",
          mode: "interactive",
          permissions: "allow-all",
        }),
        commitBinding(value) {
          bindings.push(value);
        },
      });
      return { capsule, run: result.run, bindings, client: clients.at(-1)!, owner: owners.at(-1)! };
    },
  };
}
export function custody(): ReaderCustodyPort & {
  log: string[];
} {
  let state: Awaited<ReturnType<ReaderCustodyPort["read"]>> = { state: "none" };
  const log: string[] = [];
  return {
    log,
    async read() {
      return state;
    },
    async begin(run, opening) {
      log.push("begin");
      state = { state: "allocating", run, opening };
    },
    async owned(run, capsule) {
      log.push("owned");
      state = { state: "owned", run, capsule };
    },
    async released(_proof: OpeningStopProof) {
      log.push("released");
      state = { state: "none" };
    },
  };
}
