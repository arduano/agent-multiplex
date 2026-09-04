import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  newCommandId,
  newLaunchId,
  newRuntimeEpoch,
  newSessionId,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  type AdapterScopeId,
  type HarnessCatalogEntry,
  type HarnessCommand,
  type HarnessResumeOptions,
  type HarnessSpawnOptions,
  type JsonValue,
  type LaunchRecord,
  type NativeHistoryRequest,
  type NativeHistoryResult,
  type NativeInventoryItem,
  type NativeModel,
  type RuntimeEpoch,
  type SessionRuntimeStatus,
} from "@arduano/agent-multiplex-protocol";
import {
  AllowedPathPolicy,
  NativePathPolicy,
  RuntimeNodeService,
  RuntimeNodeStore,
  type AdapterEvent,
  type AdapterSession,
  type AgentAdapter,
} from "@arduano/agent-multiplex-runtime-node-core";
import { describe, expect, it } from "vitest";

const fixture = () => {
  const base = mkdtempSync(join(tmpdir(), "agent-multiplex-native-paths-"));
  const root = join(base, "root");
  const project = join(root, "project");
  const projectAlias = join(root, "project-alias");
  const asset = join(project, "asset.png");
  const assetAlias = join(root, "asset-alias.png");
  const outside = join(base, "outside");
  const outsideAsset = join(outside, "outside.png");
  mkdirSync(project, { recursive: true });
  mkdirSync(outside);
  writeFileSync(asset, "asset");
  writeFileSync(outsideAsset, "outside");
  symlinkSync(project, projectAlias, "dir");
  symlinkSync(asset, assetAlias, "file");
  return { root, project, projectAlias, asset, assetAlias, outside, outsideAsset };
};

describe("NativePathPolicy", () => {
  it("fences Codex native session, turn, sandbox, and local-input paths", async () => {
    const paths = fixture();
    const policy = new NativePathPolicy(new AllowedPathPolicy([paths.root]));

    await expect(
      policy.spawn({
        harness: "codex",
        cwd: paths.project,
        native: { runtimeWorkspaceRoots: [paths.projectAlias] },
      }),
    ).resolves.toMatchObject({
      native: { runtimeWorkspaceRoots: [realpathSync(paths.project)] },
    });
    await expect(
      policy.spawn({
        harness: "codex",
        cwd: paths.project,
        native: { cwd: paths.outside },
      }),
    ).rejects.toThrow("native.cwd is runtime-node-controlled");
    await expect(
      policy.resume({
        harness: "codex",
        vendorSessionId: "thread-1",
        cwd: paths.project,
        native: { path: paths.asset },
      }),
    ).rejects.toThrow("cannot select a rollout");
    await expect(
      policy.resume({
        harness: "codex",
        vendorSessionId: "thread-1",
        cwd: paths.project,
        native: { history: [] },
      }),
    ).rejects.toThrow("cannot replace the bound thread");
    await expect(
      policy.spawn({
        harness: "codex",
        cwd: paths.project,
        native: {
          environments: [{ environmentId: "remote", cwd: paths.project }],
        },
      }),
    ).rejects.toThrow("cannot fence environment-native paths");
    await expect(
      policy.spawn({
        harness: "codex",
        cwd: paths.project,
        native: {
          selectedCapabilityRoots: [
            {
              id: "outside",
              location: { type: "environment", environmentId: "remote", path: "/" },
            },
          ],
        },
      }),
    ).rejects.toThrow("cannot fence environment-native paths");

    const command = await policy.command({
      harness: "codex",
      command: {
        type: "send",
        input: [
          { type: "localImage", path: paths.assetAlias },
          { type: "localAudio", path: paths.assetAlias },
          { type: "skill", name: "example", path: paths.assetAlias },
          { type: "mention", name: "example", path: paths.assetAlias },
        ],
        native: {
          cwd: paths.projectAlias,
          runtimeWorkspaceRoots: [paths.projectAlias],
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: [paths.projectAlias],
          },
        },
      },
    });
    expect(command).toMatchObject({
      command: {
        input: [
          { path: realpathSync(paths.asset) },
          { path: realpathSync(paths.asset) },
          { path: realpathSync(paths.asset) },
          { path: realpathSync(paths.asset) },
        ],
        native: {
          cwd: realpathSync(paths.project),
          runtimeWorkspaceRoots: [realpathSync(paths.project)],
          sandboxPolicy: { writableRoots: [realpathSync(paths.project)] },
        },
      },
    });

    await expect(
      policy.command({
        harness: "codex",
        command: {
          type: "send",
          input: [{ type: "localImage", path: paths.outsideAsset }],
        },
      }),
    ).rejects.toThrow("outside configured allowed roots");
    await expect(
      policy.command({
        harness: "codex",
        command: {
          type: "send",
          input: "unsafe sandbox root",
          native: {
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: [paths.outside],
            },
          },
        },
      }),
    ).rejects.toThrow("outside configured allowed roots");
  });

  it("fences Copilot native configuration and message attachments", async () => {
    const paths = fixture();
    const policy = new NativePathPolicy(new AllowedPathPolicy([paths.root]));

    for (const native of [
      { workingDirectory: paths.outside },
      { additionalDirectories: [paths.outside] },
      { provider: { baseUrl: "https://provider.example/v1", apiKey: "secret" } },
      { providers: [{ name: "private", baseUrl: "https://provider.example/v1" }] },
    ]) {
      await expect(
        policy.spawn({ harness: "copilot", cwd: paths.project, native }),
      ).rejects.toThrow(/runtime-node-controlled|runtime-node-local/);
    }

    await expect(
      policy.spawn({
        harness: "copilot",
        cwd: paths.project,
        native: {
          configDirectory: paths.projectAlias,
          extensionSdkPath: paths.projectAlias,
          skillDirectories: [paths.projectAlias],
          pluginDirectories: [paths.projectAlias],
          instructionDirectories: [paths.projectAlias],
          largeOutput: { outputDirectory: paths.projectAlias },
          mcpServers: {
            local: { type: "stdio", command: "server", workingDirectory: paths.projectAlias },
          },
          customAgents: [
            {
              name: "reviewer",
              prompt: "review",
              enabled: true,
              mcpServers: {
                nested: {
                  type: "stdio",
                  command: "server",
                  workingDirectory: paths.projectAlias,
                },
              },
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      native: {
        configDirectory: realpathSync(paths.project),
        extensionSdkPath: realpathSync(paths.project),
        skillDirectories: [realpathSync(paths.project)],
        pluginDirectories: [realpathSync(paths.project)],
        instructionDirectories: [realpathSync(paths.project)],
        largeOutput: { outputDirectory: realpathSync(paths.project) },
        mcpServers: {
          local: { workingDirectory: realpathSync(paths.project) },
        },
        customAgents: [
          {
            mcpServers: {
              nested: { workingDirectory: realpathSync(paths.project) },
            },
          },
        ],
      },
    });

    await expect(
      policy.spawn({
        harness: "copilot",
        cwd: paths.project,
        native: { pluginDirectories: [paths.outside] },
      }),
    ).rejects.toThrow("outside configured allowed roots");

    await expect(
      policy.command({
        harness: "copilot",
        command: {
          type: "send",
          prompt: {
            prompt: "look",
            attachments: [{ type: "file", path: paths.assetAlias }],
          },
          native: {
            attachments: [
              { type: "selection", filePath: paths.assetAlias, displayName: "asset" },
            ],
          },
        },
      }),
    ).resolves.toMatchObject({
      command: {
        prompt: { attachments: [{ path: realpathSync(paths.asset) }] },
        native: { attachments: [{ filePath: realpathSync(paths.asset) }] },
      },
    });
    await expect(
      policy.command({
        harness: "copilot",
        command: {
          type: "steer",
          prompt: "look elsewhere",
          native: {
            attachments: [
              { type: "selection", filePath: paths.outsideAsset, displayName: "outside" },
            ],
          },
        },
      }),
    ).rejects.toThrow("outside configured allowed roots");
  });

  it("is enforced by RuntimeNodeService before native adapter dispatch", async () => {
    const paths = fixture();
    const store = new RuntimeNodeStore(":memory:");
    const runtimeNodeId = newRuntimeNodeId();
    const adapter = new RecordingCodexAdapter();
    const service = new RuntimeNodeService({
      store,
      runtimeNodeId,
      runtimeNodeBootId: newRuntimeNodeBootId(),
      name: "native path runtime node",
      allowedRoots: [paths.root],
      adapters: [adapter],
    });

    const rejectedSpawn = await launchSession(service, {
      launchId: newLaunchId(),
      payloadHash: "native-cwd-rejected",
      sessionId: newSessionId(),
      runtimeNodeId,
      request: {
        harness: "codex",
        cwd: paths.project,
        native: { cwd: paths.outside },
      },
      metadata: {},
    });
    expect(rejectedSpawn).toMatchObject({
      state: "failed",
      error: expect.stringContaining("runtime-node-controlled"),
    });
    expect(adapter.spawnOptions).toHaveLength(0);

    const sessionId = newSessionId();
    const spawned = await launchSession(service, {
      launchId: newLaunchId(),
      payloadHash: "native-roots-accepted",
      sessionId,
      runtimeNodeId,
      request: {
        harness: "codex",
        cwd: paths.project,
        native: { runtimeWorkspaceRoots: [paths.projectAlias] },
      },
      metadata: {},
    });
    expect(spawned.state).toBe("succeeded");
    expect(adapter.spawnOptions[0]).toMatchObject({
      native: { runtimeWorkspaceRoots: [realpathSync(paths.project)] },
    });

    const acceptedSend = await service.execute({
      commandId: newCommandId(),
      payloadHash: "local-input-accepted",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
      request: {
        harness: "codex",
        command: {
          type: "send",
          input: [{ type: "localImage", path: paths.assetAlias }],
        },
      },
    });
    expect(acceptedSend.state).toBe("succeeded");
    expect(adapter.session?.requests[0]).toMatchObject({
      command: { input: [{ path: realpathSync(paths.asset) }] },
    });

    const rejectedSend = await service.execute({
      commandId: newCommandId(),
      payloadHash: "local-input-rejected",
      sessionId,
      runtimeNodeId,
      bindingRevision: 1,
      request: {
        harness: "codex",
        command: {
          type: "send",
          input: [{ type: "localImage", path: paths.outsideAsset }],
        },
      },
    });
    expect(rejectedSend).toMatchObject({
      state: "failed",
      error: expect.stringContaining("outside configured allowed roots"),
    });
    expect(adapter.session?.requests).toHaveLength(1);

    await service.close();
    store.close();
  });
});

async function launchSession(
  service: RuntimeNodeService,
  request: {
    launchId: ReturnType<typeof newLaunchId>;
    payloadHash: string;
    sessionId: ReturnType<typeof newSessionId>;
    runtimeNodeId: ReturnType<typeof newRuntimeNodeId>;
    request: HarnessSpawnOptions;
    metadata?: Readonly<Record<string, JsonValue>>;
  },
): Promise<LaunchRecord> {
  const descriptor = service.listLaunchProfiles().find((profile) =>
    profile.available && profile.harnesses.includes(request.request.harness));
  if (!descriptor) throw new Error("no matching launch profile");
  const { harness, ...input } = request.request;
  service.createLaunch({
    launchId: request.launchId,
    payloadHash: request.payloadHash,
    sessionId: request.sessionId,
    runtimeNodeId: request.runtimeNodeId,
    profile: {
      providerId: descriptor.providerId,
      profileId: descriptor.profileId,
      contractVersion: descriptor.contractVersion,
      requestSchemaHash: descriptor.requestSchemaHash,
    },
    harness,
    input,
    ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
  });
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const record = service.getLaunch(request.launchId);
    if (record && ["succeeded", "failed", "outcomeUnknown"].includes(record.state)) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for launch");
}

class RecordingCodexAdapter implements AgentAdapter {
  public readonly harness = "codex" as const;
  public readonly adapterScopeId = "recording:codex" as AdapterScopeId;
  public readonly spawnOptions: HarnessSpawnOptions[] = [];
  public readonly resumeOptions: HarnessResumeOptions[] = [];
  public session: RecordingSession | undefined;

  public async describe(): Promise<HarnessCatalogEntry> {
    return {
      harness: "codex",
      adapterScopeId: this.adapterScopeId,
      available: true,
      capabilities: [],
    };
  }

  public async listModels(): Promise<NativeModel[]> {
    return [];
  }

  public async listSessions(): Promise<NativeInventoryItem[]> {
    return [];
  }

  public async spawn(options: HarnessSpawnOptions): Promise<AdapterSession> {
    if (options.harness !== "codex") throw new Error("wrong harness");
    this.spawnOptions.push(options);
    this.session = new RecordingSession("recorded-thread", options.cwd, this.adapterScopeId);
    return this.session;
  }

  public async resume(options: HarnessResumeOptions): Promise<AdapterSession> {
    if (options.harness !== "codex") throw new Error("wrong harness");
    this.resumeOptions.push(options);
    this.session = new RecordingSession(
      options.vendorSessionId,
      options.cwd ?? null,
      this.adapterScopeId,
    );
    return this.session;
  }

  public async close(): Promise<void> {}
}

class RecordingSession implements AdapterSession {
  public readonly harness = "codex" as const;
  public readonly runtimeEpoch: RuntimeEpoch = newRuntimeEpoch();
  public readonly requests: HarnessCommand[] = [];
  readonly #listeners = new Set<(event: AdapterEvent) => void>();
  #status: SessionRuntimeStatus = "idle";

  public constructor(
    public readonly vendorSessionId: string,
    public readonly cwd: string | null,
    public readonly adapterScopeId: AdapterScopeId,
  ) {}

  public status(): SessionRuntimeStatus {
    return this.#status;
  }

  public subscribe(listener: (event: AdapterEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async execute(request: HarnessCommand): Promise<JsonValue> {
    this.requests.push(request);
    return { accepted: true };
  }

  public async readNativeHistory(
    request: NativeHistoryRequest,
  ): Promise<NativeHistoryResult> {
    return {
      harness: request.harness,
      vendorSessionId: this.vendorSessionId,
      payload: [],
      complete: true,
    };
  }

  public async stop(): Promise<void> {
    this.#status = "stopped";
  }
}
