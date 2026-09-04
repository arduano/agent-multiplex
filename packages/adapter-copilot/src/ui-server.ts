import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { createServer, Socket } from "node:net";
import { promisify } from "node:util";

import {
  CopilotClient,
  RuntimeConnection,
  type CopilotClientOptions,
  type ModelInfo,
  type ProviderConfig,
  type ResumeSessionConfig,
  type SessionConfig,
  type SessionMetadata,
} from "@github/copilot-sdk";
import {
  adapterScopeIdSchema,
  type AdapterScopeId,
} from "@arduano/agent-multiplex-protocol";
import {
  sanitizedTerminalEnvironment,
  terminalProcessFromPty,
  type TerminalProcess,
  type TerminalProvider,
  type TerminalProviderOpenRequest,
} from "@arduano/agent-multiplex-runtime-node-core";
import * as nodePty from "node-pty";

import {
  CopilotAgentAdapter,
  type CopilotAdapterClient,
  type CopilotAdapterOptions,
  type CopilotRuntimeStatus,
} from "./adapter.js";
import type { CopilotNativeSession } from "./session.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/** The hidden UI-server integration is tested only against this exact CLI. */
export const EXPERIMENTAL_COPILOT_UI_SERVER_VERSION = "1.0.81";

const START_TIMEOUT_MS = 10_000;
const FOREGROUND_TIMEOUT_MS = 5_000;

interface ForegroundCopilotClient extends CopilotAdapterClient {
  getForegroundSessionId(): Promise<string | undefined>;
  setForegroundSessionId(sessionId: string): Promise<void>;
}

export interface CopilotUiServerRuntimeOptions {
  readonly adapterScopeId?: string | AdapterScopeId;
  readonly binary?: string;
  readonly args?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly workingDirectory: string;
  readonly baseDirectory?: string;
  readonly provider?: ProviderConfig;
  readonly defaultModel?: string;
  readonly expectedVersion?: string;
  readonly logLevel?: CopilotClientOptions["logLevel"];
  /** SDK options assembled by CopilotAdapter, including its model callback. */
  readonly clientOptions: CopilotClientOptions;
  /** Test seam; production uses the SDK client connected to loopback TCP. */
  readonly clientFactory?: (
    options: CopilotClientOptions,
  ) => ForegroundCopilotClient;
}

export interface ExperimentalCopilotRuntimeOptions
  extends Omit<CopilotAdapterOptions, "clientFactory"> {
  /** Bootstrap cwd only; each SDK-created session still supplies its own cwd. */
  readonly workingDirectory: string;
  readonly binary?: string;
  readonly args?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly expectedVersion?: string;
}

export interface ExperimentalCopilotRuntimeBundle {
  readonly adapter: CopilotAgentAdapter;
  readonly terminalProvider: CopilotUiServerRuntime;
}

/**
 * Constructs and probes the opt-in TUI-owned Copilot runtime before it is
 * advertised. Callers can catch a failure and instantiate the ordinary
 * structured adapter without ever exposing a broken terminal capability.
 */
export async function createExperimentalCopilotRuntime(
  options: ExperimentalCopilotRuntimeOptions,
): Promise<ExperimentalCopilotRuntimeBundle> {
  let runtime: CopilotUiServerRuntime | undefined;
  const adapter = new CopilotAgentAdapter({
    ...(options.adapterScopeId === undefined
      ? {}
      : { adapterScopeId: options.adapterScopeId }),
    ...(options.clientOptions === undefined
      ? {}
      : { clientOptions: options.clientOptions }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.defaultModel === undefined
      ? {}
      : { defaultModel: options.defaultModel }),
    ...(options.providerModels === undefined
      ? {}
      : { providerModels: options.providerModels }),
    ...(options.runtimeEpochFactory === undefined
      ? {}
      : { runtimeEpochFactory: options.runtimeEpochFactory }),
    clientFactory: (clientOptions) => {
      if (runtime) throw new Error("Copilot adapter requested more than one UI runtime");
      runtime = new CopilotUiServerRuntime({
        workingDirectory: options.workingDirectory,
        clientOptions,
        ...(options.adapterScopeId === undefined
          ? {}
          : { adapterScopeId: options.adapterScopeId }),
        ...(options.binary === undefined ? {} : { binary: options.binary }),
        ...(options.args === undefined ? {} : { args: options.args }),
        ...(options.environment === undefined
          ? {}
          : { environment: options.environment }),
        ...(options.clientOptions?.baseDirectory === undefined
          ? {}
          : { baseDirectory: options.clientOptions.baseDirectory }),
        ...(options.provider === undefined ? {} : { provider: options.provider }),
        ...(options.defaultModel === undefined
          ? {}
          : { defaultModel: options.defaultModel }),
        ...(options.expectedVersion === undefined
          ? {}
          : { expectedVersion: options.expectedVersion }),
        ...(options.clientOptions?.logLevel === undefined
          ? {}
          : { logLevel: options.clientOptions.logLevel }),
      });
      return runtime;
    },
  });
  const terminalProvider = runtime;
  if (!terminalProvider) {
    throw new Error("Copilot adapter did not construct its UI runtime");
  }
  try {
    await terminalProvider.start();
  } catch (error) {
    await adapter.close().catch(() => undefined);
    throw error;
  }
  return { adapter, terminalProvider };
}

/**
 * Experimental stock Copilot TUI plus SDK server.
 *
 * Copilot has no supported command that attaches its TUI to an existing
 * headless runtime. Hidden `--ui-server` reverses ownership: the TUI owns the
 * runtime from startup and the structured adapter connects as a sibling SDK
 * client. This class intentionally stays opt-in and exact-version pinned.
 */
export class CopilotUiServerRuntime
implements CopilotAdapterClient, TerminalProvider {
  public readonly harness = "copilot" as const;
  public readonly backend = "copilot-ui-server" as const;
  public readonly sharing = "adapterScope" as const;
  public readonly capabilities = {
    write: true,
    resize: true,
    // The TUI process is also the SDK runtime. Killing it would stop every
    // structured session in the adapter scope.
    terminate: false,
    restart: false,
    foregroundSwitch: true,
  } as const;
  public readonly adapterScopeId: AdapterScopeId;

  readonly #options: CopilotUiServerRuntimeOptions;
  readonly #binary: string;
  readonly #environment: Record<string, string>;
  #client: ForegroundCopilotClient | undefined;
  #process: nodePty.IPty | undefined;
  #terminalProcess: TerminalProcess | undefined;
  #disposeProcessExit: (() => void) | undefined;
  #processExited = true;
  #starting: Promise<void> | undefined;
  #closed = false;

  public constructor(options: CopilotUiServerRuntimeOptions) {
    this.#options = options;
    this.adapterScopeId = adapterScopeIdSchema.parse(
      options.adapterScopeId ?? "copilot:default",
    );
    this.#binary = options.binary ?? bundledCopilotLoader();
    this.#environment = uiServerEnvironment(options);
  }

  public async start(): Promise<void> {
    if (this.#closed) throw new Error("Copilot UI-server runtime is closed");
    if (this.#client) {
      if (this.#processExited) {
        throw new Error("Copilot UI-server TUI exited; restart the runtime node to recover");
      }
      return;
    }
    if (this.#starting) return this.#starting;
    this.#starting = this.#start();
    try {
      await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #start(): Promise<void> {
    await assertCliVersion(
      this.#binary,
      this.#options.expectedVersion ?? EXPERIMENTAL_COPILOT_UI_SERVER_VERSION,
      this.#environment,
    );
    const port = await unusedLoopbackPort();
    const args = [
      ...(this.#options.args ?? []),
      "--ui-server",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-auto-update",
      ...(this.#options.provider ? ["--no-auto-login"] : []),
      ...(this.#options.provider
        ? [
            "--secret-env-vars=COPILOT_PROVIDER_API_KEY," +
              "COPILOT_PROVIDER_BEARER_TOKEN,COPILOT_PROVIDER_HEADERS",
          ]
        : []),
      ...(this.#options.logLevel && this.#options.logLevel !== "none"
        ? ["--log-level", this.#options.logLevel]
        : ["--log-level", "error"]),
      ...(this.#options.defaultModel
        ? ["--model", this.#options.defaultModel]
        : []),
      "-C",
      this.#options.workingDirectory,
    ];
    const process = nodePty.spawn(this.#binary, args, {
      name: "xterm-256color",
      cwd: this.#options.workingDirectory,
      env: this.#environment,
      cols: 100,
      rows: 30,
    });
    this.#process = process;
    this.#processExited = false;
    const exitSubscription = process.onExit(() => {
      if (this.#process === process) this.#processExited = true;
    });
    this.#disposeProcessExit = () => exitSubscription.dispose();
    this.#terminalProcess = terminalProcessFromPty(process);

    let client: ForegroundCopilotClient | undefined;
    try {
      await waitForLoopback(port, () => this.#processExited);
      // In current hidden UI-server builds, setting COPILOT_CONNECTION_TOKEN
      // makes `connect` fail with AUTHENTICATION_NOT_CONFIGURED. Keep the
      // randomly selected server loopback-only and do not expose its address.
      const clientOptions: CopilotClientOptions = {
        mode: this.#options.clientOptions.mode ?? "copilot-cli",
        ...(this.#options.clientOptions.logLevel === undefined
          ? {}
          : { logLevel: this.#options.clientOptions.logLevel }),
        ...(this.#options.clientOptions.onListModels === undefined
          ? {}
          : { onListModels: this.#options.clientOptions.onListModels }),
        connection: RuntimeConnection.forUri(`127.0.0.1:${port}`),
      };
      client = this.#options.clientFactory?.(clientOptions) ??
        (new CopilotClient(clientOptions) as unknown as ForegroundCopilotClient);
      await client.start();
      const status = await client.getStatus();
      if (!Number.isSafeInteger(status.protocolVersion)) {
        throw new Error("Copilot UI-server did not report a protocol version");
      }
      await waitForForeground(client, () => this.#processExited);
      if (this.#closed || this.#process !== process || this.#processExited) {
        throw new Error("Copilot UI-server runtime closed during startup");
      }
      this.#client = client;
    } catch (error) {
      await client?.forceStop().catch(() => undefined);
      this.#killPty(process);
      throw error;
    }
  }

  public async stop(): Promise<Error[]> {
    if (this.#closed) return [];
    this.#closed = true;
    if (this.#starting) {
      // Interrupt startup loops first. A completed runtime is stopped through
      // the SDK below before its TUI owner is killed.
      this.#killPty();
      await this.#starting.catch(() => undefined);
    }
    const client = this.#client;
    this.#client = undefined;
    const errors: Error[] = [];
    if (client) {
      try {
        errors.push(...await client.stop());
      } catch (error) {
        errors.push(asError(error));
      }
    }
    this.#killPty();
    return errors;
  }

  public async forceStop(): Promise<void> {
    this.#closed = true;
    if (this.#starting) {
      this.#killPty();
      await this.#starting.catch(() => undefined);
    }
    const client = this.#client;
    this.#client = undefined;
    await client?.forceStop().catch(() => undefined);
    this.#killPty();
  }

  public async getStatus(): Promise<CopilotRuntimeStatus> {
    await this.start();
    return this.#requireClient().getStatus();
  }

  public async listModels(): Promise<ModelInfo[]> {
    await this.start();
    return this.#requireClient().listModels();
  }

  public async listSessions(): Promise<SessionMetadata[]> {
    await this.start();
    return this.#requireClient().listSessions();
  }

  public async createSession(config: SessionConfig): Promise<CopilotNativeSession> {
    await this.start();
    return this.#requireClient().createSession(config);
  }

  public async resumeSession(
    sessionId: string,
    config: ResumeSessionConfig,
  ): Promise<CopilotNativeSession> {
    await this.start();
    return this.#requireClient().resumeSession(sessionId, config);
  }

  public async open(request: TerminalProviderOpenRequest): Promise<TerminalProcess> {
    await this.start();
    const client = this.#requireClient();
    if (await client.getForegroundSessionId() !== request.vendorSessionId) {
      await client.setForegroundSessionId(request.vendorSessionId);
      await waitForExpectedForeground(
        client,
        request.vendorSessionId,
        () => this.#processExited,
      );
    }
    const terminal = this.#terminalProcess;
    if (!terminal) throw new Error("Copilot UI-server terminal is unavailable");
    terminal.resize(request.dimensions);
    return terminal;
  }

  /** Adapter.stop owns this shared process; broker shutdown must not kill it. */
  public async close(): Promise<void> {}

  #requireClient(): ForegroundCopilotClient {
    const client = this.#client;
    if (!client) throw new Error("Copilot UI-server SDK client is unavailable");
    return client;
  }

  #killPty(expected?: nodePty.IPty): void {
    const process = this.#process;
    if (expected && process !== expected) {
      try { expected.kill(); } catch { /* already exited */ }
      return;
    }
    this.#process = undefined;
    this.#terminalProcess = undefined;
    this.#processExited = true;
    this.#disposeProcessExit?.();
    this.#disposeProcessExit = undefined;
    try { process?.kill(); } catch { /* already exited */ }
  }
}

function uiServerEnvironment(
  options: CopilotUiServerRuntimeOptions,
): Record<string, string> {
  const environment = sanitizedTerminalEnvironment(options.environment);
  // Current hidden UI-server builds reject SDK clients when this otherwise
  // supported headless-server token is set. The listener below is therefore
  // random and strictly loopback-only, and its address never leaves this class.
  delete environment.COPILOT_CONNECTION_TOKEN;
  environment.TERM = "xterm-256color";
  if (options.baseDirectory) environment.COPILOT_HOME = options.baseDirectory;
  if (options.defaultModel) environment.COPILOT_MODEL = options.defaultModel;
  const provider = options.provider;
  if (!provider) return environment;
  if (provider.bearerTokenProvider) {
    throw new TypeError(
      "Copilot UI-server cannot lower a bearerTokenProvider callback into its child environment",
    );
  }
  environment.COPILOT_PROVIDER_BASE_URL = provider.baseUrl;
  environment.COPILOT_PROVIDER_TYPE = provider.type ?? "openai";
  environment.COPILOT_PROVIDER_WIRE_API = provider.wireApi ?? "completions";
  environment.COPILOT_PROVIDER_TRANSPORT = provider.transport ?? "http";
  if (provider.apiKey) environment.COPILOT_PROVIDER_API_KEY = provider.apiKey;
  if (provider.bearerToken) {
    environment.COPILOT_PROVIDER_BEARER_TOKEN = provider.bearerToken;
  }
  if (provider.azure?.apiVersion) {
    environment.COPILOT_PROVIDER_AZURE_API_VERSION = provider.azure.apiVersion;
  }
  if (provider.headers && Object.keys(provider.headers).length > 0) {
    environment.COPILOT_PROVIDER_HEADERS = Object.entries(provider.headers)
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n");
  }
  if (provider.modelId) environment.COPILOT_PROVIDER_MODEL_ID = provider.modelId;
  if (provider.wireModel) environment.COPILOT_PROVIDER_WIRE_MODEL = provider.wireModel;
  if (provider.maxPromptTokens !== undefined) {
    environment.COPILOT_PROVIDER_MAX_PROMPT_TOKENS = String(provider.maxPromptTokens);
  }
  if (provider.maxOutputTokens !== undefined) {
    environment.COPILOT_PROVIDER_MAX_OUTPUT_TOKENS = String(provider.maxOutputTokens);
  }
  return environment;
}

function bundledCopilotLoader(): string {
  try {
    return require.resolve("@github/copilot/npm-loader.js");
  } catch (cause) {
    throw new Error(
      "Copilot UI-server requires @github/copilot or an explicit binary path",
      { cause },
    );
  }
}

async function assertCliVersion(
  binary: string,
  expected: string,
  environment: Record<string, string>,
): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(binary, ["--version"], {
      env: environment,
      timeout: 5_000,
      maxBuffer: 16_384,
    }));
  } catch (cause) {
    throw new Error("Could not probe the experimental Copilot CLI version", { cause });
  }
  const actual = /GitHub Copilot CLI\s+([^\s.]+(?:\.[^\s.]+)+)/.exec(stdout)?.[1];
  if (actual !== expected) {
    throw new Error(
      `Copilot UI-server requires CLI ${expected}; the configured binary reports ${actual ?? "an unknown version"}`,
    );
  }
}

async function unusedLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a Copilot UI-server loopback port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForLoopback(port: number, exited: () => boolean): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = new Socket();
        socket.once("error", reject);
        socket.connect(port, "127.0.0.1", () => {
          socket.destroy();
          resolve();
        });
      });
      return;
    } catch {
      if (exited()) {
        throw new Error("Copilot UI-server exited before opening its loopback port");
      }
      await delay(25);
    }
  }
  throw new Error("Timed out waiting for the Copilot UI-server loopback port");
}

async function waitForForeground(
  client: ForegroundCopilotClient,
  exited: () => boolean,
): Promise<string> {
  const deadline = Date.now() + FOREGROUND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const sessionId = await client.getForegroundSessionId();
    if (sessionId) return sessionId;
    if (exited()) {
      throw new Error("Copilot UI-server exited before exposing a foreground session");
    }
    await delay(50);
  }
  throw new Error("Copilot UI-server did not expose a foreground session");
}

async function waitForExpectedForeground(
  client: ForegroundCopilotClient,
  expected: string,
  exited: () => boolean,
): Promise<void> {
  const deadline = Date.now() + FOREGROUND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await client.getForegroundSessionId() === expected) return;
    if (exited()) {
      throw new Error("Copilot UI-server exited while switching foreground session");
    }
    await delay(50);
  }
  throw new Error("Copilot UI-server did not acknowledge the foreground session switch");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
