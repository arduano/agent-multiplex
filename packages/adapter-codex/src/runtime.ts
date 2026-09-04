import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AdapterScopeId } from "@arduano/agent-multiplex-protocol";
import {
  sanitizedTerminalEnvironment,
  terminalProcessFromPty,
  type TerminalProcess,
  type TerminalProvider,
  type TerminalProviderOpenRequest,
} from "@arduano/agent-multiplex-runtime-node-core";
import * as nodePty from "node-pty";

import { CodexAdapter, type CodexAdapterOptions } from "./adapter.js";
import { CodexRpcClient, CodexUnixSocketRpcConnection } from "./rpc.js";

const START_TIMEOUT_MS = 10_000;

export interface CodexAppServerSupervisorOptions {
  binary?: string;
  args?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  socketDirectory?: string;
}

/** One worker-local Codex app server shared by the JSON-RPC adapter and TUIs. */
export class CodexAppServerSupervisor {
  readonly #binary: string;
  readonly #configuredArgs: readonly string[];
  readonly #environment: Record<string, string>;
  readonly #cwd: string | undefined;
  readonly #configuredSocketDirectory: string | undefined;
  #directory: string | undefined;
  #socketPath: string | undefined;
  #server: ChildProcessWithoutNullStreams | undefined;
  #starting: Promise<void> | undefined;
  #closed = false;
  #stderr = "";

  public constructor(options: CodexAppServerSupervisorOptions = {}) {
    this.#binary = options.binary ?? "codex";
    this.#configuredArgs = options.args ?? [];
    this.#environment = sanitizedTerminalEnvironment(options.environment);
    this.#cwd = options.cwd;
    this.#configuredSocketDirectory = options.socketDirectory;
  }

  public get binary(): string {
    return this.#binary;
  }

  public get environment(): Record<string, string> {
    return { ...this.#environment };
  }

  public get socketPath(): string {
    if (!this.#socketPath) throw new Error("Codex app server has not started");
    return this.#socketPath;
  }

  public async start(): Promise<void> {
    if (this.#closed) throw new Error("Codex app server supervisor is closed");
    if (this.#server && this.#server.exitCode === null && this.#socketPath) return;
    if (this.#starting) return this.#starting;
    this.#starting = this.#start();
    try {
      await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }

  async #start(): Promise<void> {
    if (!this.#configuredSocketDirectory && this.#directory) {
      await rm(this.#directory, { recursive: true, force: true });
      this.#directory = undefined;
      this.#socketPath = undefined;
    }
    const directory = this.#configuredSocketDirectory ??
      await mkdtemp(join(tmpdir(), "agent-multiplex-codex-"));
    if (this.#configuredSocketDirectory) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    // The UDS is an unauthenticated local control plane. Keep both generated
    // and operator-supplied directories owner-only before binding it.
    await chmod(directory, 0o700);
    const socketPath = join(directory, "app-server.sock");
    await removeStaleSocket(socketPath);
    if (this.#closed) {
      if (!this.#configuredSocketDirectory) {
        await rm(directory, { recursive: true, force: true });
      }
      throw new Error("Codex app server supervisor closed during startup");
    }
    this.#directory = directory;
    this.#socketPath = socketPath;
    this.#stderr = "";
    const child = spawn(this.#binary, serverArgs(this.#configuredArgs, socketPath), {
      ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
      env: this.#environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#server = child;
    let startupError: Error | undefined;
    child.once("error", (error) => {
      startupError = error;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-16_384);
    });
    // A listener-mode app-server should not write protocol traffic to stdout,
    // but it can still emit diagnostics there. Drain it so the child can never
    // block on a full pipe while structured sessions and TUIs are active.
    child.stdout.resume();
    try {
      await waitForSocket(
        socketPath,
        child,
        () => this.#stderr,
        () => startupError,
      );
      if (this.#closed) {
        throw new Error("Codex app server supervisor closed during startup");
      }
    } catch (error) {
      if (child.exitCode === null) child.kill("SIGKILL");
      if (this.#server === child) this.#server = undefined;
      if (!this.#configuredSocketDirectory) {
        await rm(directory, { recursive: true, force: true });
        if (this.#directory === directory) {
          this.#directory = undefined;
          this.#socketPath = undefined;
        }
      }
      throw error;
    }
  }

  public resumeArgs(vendorSessionId: string): string[] {
    return [
      ...globalArgs(this.#configuredArgs),
      "resume",
      "--remote",
      `unix://${this.socketPath}`,
      vendorSessionId,
    ];
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#stopServer(this.#server);
    await this.#starting?.catch(() => undefined);
    // Startup can cross the first read only between awaited filesystem calls.
    // Stop a child installed after that read as well.
    await this.#stopServer(this.#server);
    if (!this.#configuredSocketDirectory && this.#directory) {
      await rm(this.#directory, { recursive: true, force: true });
      this.#directory = undefined;
      this.#socketPath = undefined;
    }
  }

  async #stopServer(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
    if (!child) return;
    if (this.#server === child) this.#server = undefined;
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await waitForExit(child, 3_000);
    }
  }
}

export class CodexTerminalProvider implements TerminalProvider {
  public readonly harness = "codex" as const;
  public readonly backend = "codex-remote" as const;
  public readonly sharing = "session" as const;
  public readonly capabilities = {
    write: true,
    resize: true,
    terminate: true,
    restart: true,
    foregroundSwitch: false,
  } as const;

  public constructor(
    public readonly adapterScopeId: AdapterScopeId,
    private readonly supervisor: CodexAppServerSupervisor,
  ) {}

  public async open(request: TerminalProviderOpenRequest): Promise<TerminalProcess> {
    await this.supervisor.start();
    const pty = nodePty.spawn(
      this.supervisor.binary,
      this.supervisor.resumeArgs(request.vendorSessionId),
      {
        name: "xterm-256color",
        cwd: request.cwd,
        env: this.supervisor.environment,
        cols: request.dimensions.columns,
        rows: request.dimensions.rows,
      },
    );
    return terminalProcessFromPty(pty);
  }

  // The adapter owns the shared supervisor and closes it after its RPC client.
  public async close(): Promise<void> {}
}

export interface CodexRuntimeBundle {
  adapter: CodexAdapter;
  terminalProvider: CodexTerminalProvider;
  supervisor: CodexAppServerSupervisor;
}

/** Reference-runtime construction path for the shared app-server topology. */
export function createCodexRuntime(options: CodexAdapterOptions = {}): CodexRuntimeBundle {
  if (options.rpcClient || options.spawnProcess) {
    throw new TypeError("createCodexRuntime does not accept RPC test seams");
  }
  const supervisor = new CodexAppServerSupervisor(options);
  const rpcClient = new CodexRpcClient({
    ...(options.clientVersion === undefined
      ? {}
      : { clientVersion: options.clientVersion }),
    prepareProcess: () => supervisor.start(),
    createConnection: () => new CodexUnixSocketRpcConnection(supervisor.socketPath),
  });
  const adapter = new CodexAdapter({
    ...options,
    rpcClient,
    closeRuntime: () => supervisor.close(),
  });
  return {
    adapter,
    terminalProvider: new CodexTerminalProvider(adapter.adapterScopeId, supervisor),
    supervisor,
  };
}

function serverArgs(configured: readonly string[], socketPath: string): string[] {
  const args = withAppServerCommand(configured);
  return [...args, "--listen", `unix://${socketPath}`];
}

function withAppServerCommand(configured: readonly string[]): string[] {
  return configured.includes("app-server") ? [...configured] : [...configured, "app-server"];
}

function globalArgs(configured: readonly string[]): string[] {
  const command = configured.indexOf("app-server");
  return command < 0 ? [...configured] : configured.slice(0, command);
}

async function waitForSocket(
  socketPath: string,
  child: ChildProcessWithoutNullStreams,
  stderr: () => string,
  startupError: () => Error | undefined,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const spawnFailure = startupError();
    if (spawnFailure) {
      throw new Error(`Could not start the Codex app server: ${spawnFailure.message}`, {
        cause: spawnFailure,
      });
    }
    if (child.exitCode !== null) {
      throw new Error(
        `Codex app server exited with code ${child.exitCode}${stderr().trim() ? `: ${stderr().trim()}` : ""}`,
      );
    }
    try {
      if ((await stat(socketPath)).isSocket()) return;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the Codex app-server Unix socket");
}

/** Refuse a live owner, but remove the filesystem remnant of a dead server. */
async function removeStaleSocket(socketPath: string): Promise<void> {
  let socketStat;
  try {
    socketStat = await lstat(socketPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  if (!socketStat.isSocket()) {
    throw new Error(`Refusing to replace non-socket Codex app-server path: ${socketPath}`);
  }
  if (await unixSocketAcceptsConnections(socketPath)) {
    throw new Error(`Codex app-server socket is already active: ${socketPath}`);
  }
  await unlink(socketPath).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error;
  });
}

async function unixSocketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    // A bound but wedged owner is still live from a filesystem-ownership
    // perspective. Be conservative and never unlink it on probe timeout.
    socket.setTimeout(1_000, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    timer.unref();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String(Reflect.get(error, "code"))
    : undefined;
}
