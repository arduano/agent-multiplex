import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ModelInfo,
  ResumeSessionConfig,
  SessionConfig,
  SessionMetadata,
} from "@github/copilot-sdk";
import { afterEach, describe, expect, it } from "vitest";

import type {
  CopilotAdapterClient,
  CopilotRuntimeStatus,
} from "../src/adapter.js";
import type { CopilotNativeSession } from "../src/session.js";
import {
  CopilotUiServerRuntime,
  EXPERIMENTAL_COPILOT_UI_SERVER_VERSION,
} from "../src/ui-server.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("experimental Copilot UI-server", () => {
  it("pins the executable version before starting the hidden server", async () => {
    const fixture = fakeCopilot("1.0.80");
    const runtime = runtimeFor(fixture, new FakeForegroundClient("first"));
    await expect(runtime.start()).rejects.toThrow(
      `requires CLI ${EXPERIMENTAL_COPILOT_UI_SERVER_VERSION}`,
    );
    expect(readOptional(fixture.argumentsFile)).toBeUndefined();
    await runtime.forceStop();
  });

  it("binds loopback, disables auto-update, and switches foreground sessions", async () => {
    const fixture = fakeCopilot(EXPERIMENTAL_COPILOT_UI_SERVER_VERSION);
    const client = new FakeForegroundClient("first-session");
    const runtime = runtimeFor(fixture, client);
    await runtime.start();

    const firstProcess = await runtime.open({
      target: terminalTarget(),
      harness: "copilot",
      adapterScopeId: runtime.adapterScopeId,
      vendorSessionId: "first-session",
      cwd: fixture.directory,
      dimensions: { columns: 90, rows: 25 },
      foregroundSwitch: false,
    });
    const secondProcess = await runtime.open({
      target: terminalTarget(),
      harness: "copilot",
      adapterScopeId: runtime.adapterScopeId,
      vendorSessionId: "second-session",
      cwd: fixture.directory,
      dimensions: { columns: 100, rows: 30 },
      foregroundSwitch: true,
    });

    expect(secondProcess).toBe(firstProcess);
    expect(client.foregroundChanges).toEqual(["second-session"]);
    const invocation = JSON.parse(readFileSync(fixture.argumentsFile, "utf8")) as {
      args: string[];
      host: string;
    };
    expect(invocation.host).toBe("127.0.0.1");
    expect(invocation.args).toContain("--no-auto-update");
    expect(invocation.args).toContain("--ui-server");
    expect(invocation.args).toContain("--no-auto-login");
    expect(runtime.capabilities).toMatchObject({
      terminate: false,
      restart: false,
      foregroundSwitch: true,
    });

    await runtime.forceStop();
    expect(client.forceStops).toBe(1);
  });
});

class FakeForegroundClient implements CopilotAdapterClient {
  public readonly foregroundChanges: string[] = [];
  public forceStops = 0;

  public constructor(private foreground: string) {}

  public async start(): Promise<void> {}
  public async stop(): Promise<Error[]> { return []; }
  public async forceStop(): Promise<void> { this.forceStops += 1; }
  public async getStatus(): Promise<CopilotRuntimeStatus> {
    return { version: EXPERIMENTAL_COPILOT_UI_SERVER_VERSION, protocolVersion: 3 };
  }
  public async listModels(): Promise<ModelInfo[]> { return []; }
  public async listSessions(): Promise<SessionMetadata[]> { return []; }
  public async createSession(_config: SessionConfig): Promise<CopilotNativeSession> {
    throw new Error("not used by UI-server test");
  }
  public async resumeSession(
    _sessionId: string,
    _config: ResumeSessionConfig,
  ): Promise<CopilotNativeSession> {
    throw new Error("not used by UI-server test");
  }
  public async getForegroundSessionId(): Promise<string | undefined> {
    return this.foreground;
  }
  public async setForegroundSessionId(sessionId: string): Promise<void> {
    this.foregroundChanges.push(sessionId);
    this.foreground = sessionId;
  }
}

function runtimeFor(
  fixture: ReturnType<typeof fakeCopilot>,
  client: FakeForegroundClient,
): CopilotUiServerRuntime {
  return new CopilotUiServerRuntime({
    workingDirectory: fixture.directory,
    binary: fixture.binary,
    environment: {
      ...process.env,
      FAKE_COPILOT_VERSION: fixture.version,
      FAKE_COPILOT_ARGUMENTS_FILE: fixture.argumentsFile,
    },
    provider: {
      type: "openai",
      baseUrl: "http://provider.invalid/v1",
      apiKey: "local-test-key",
      wireApi: "responses",
      transport: "http",
    },
    defaultModel: "gpt-5.6-sol",
    clientOptions: { logLevel: "none" },
    clientFactory: () => client as never,
  });
}

function fakeCopilot(version: string): {
  directory: string;
  binary: string;
  argumentsFile: string;
  version: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "agent-multiplex-copilot-ui-"));
  temporaryDirectories.push(directory);
  const binary = join(directory, "copilot.mjs");
  const argumentsFile = join(directory, "arguments.json");
  writeFileSync(binary, String.raw`#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";

if (process.argv.includes("--version")) {
  console.log("GitHub Copilot CLI " + process.env.FAKE_COPILOT_VERSION + ".");
  process.exit(0);
}
const args = process.argv.slice(2);
const host = args[args.indexOf("--host") + 1];
const port = Number(args[args.indexOf("--port") + 1]);
writeFileSync(process.env.FAKE_COPILOT_ARGUMENTS_FILE, JSON.stringify({ args, host, port }));
process.stdout.write("fake Copilot UI\r\n");
const server = createServer((socket) => socket.on("data", () => undefined));
server.listen(port, host);
const stop = () => server.close(() => process.exit(0));
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
`, { mode: 0o700 });
  chmodSync(binary, 0o700);
  return { directory, binary, argumentsFile, version };
}

function terminalTarget() {
  return {
    sessionId: "01990f1b-9200-7000-8000-000000000011" as never,
    runtimeNodeId: "01990f1b-9200-7000-8000-000000000012" as never,
    bindingRevision: 1,
  };
}

function readOptional(filename: string): string | undefined {
  try {
    return readFileSync(filename, "utf8");
  } catch {
    return undefined;
  }
}
