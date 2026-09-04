import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect as connectSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adapterScopeIdSchema,
  newRuntimeNodeId,
  newSessionId,
} from "@arduano/agent-multiplex-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

import { CodexUnixSocketRpcConnection } from "../src/rpc.js";
import {
  CodexAppServerSupervisor,
  CodexTerminalProvider,
} from "../src/runtime.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codex shared app-server runtime", () => {
  it("reports an executable spawn error without waiting for the socket timeout", async () => {
    const fixture = fakeCodexFixture();
    const supervisor = new CodexAppServerSupervisor({
      binary: join(fixture.directory, "missing-codex"),
      socketDirectory: fixture.socketDirectory,
      environment: process.env,
    });
    await expect(supervisor.start()).rejects.toThrow("Could not start the Codex app server");
    await supervisor.close();
  });

  it("uses an owner-only socket directory, drains stdout, and separates resume args", async () => {
    const fixture = fakeCodexFixture();
    mkdirSync(fixture.socketDirectory);
    chmodSync(fixture.socketDirectory, 0o755);
    const supervisor = new CodexAppServerSupervisor({
      binary: process.execPath,
      args: [fixture.script, "--global", "value", "app-server", "--server-only"],
      socketDirectory: fixture.socketDirectory,
      environment: { ...process.env, FAKE_CODEX_STDOUT_BYTES: String(512 * 1_024) },
    });

    await supervisor.start();
    expect(statSync(fixture.socketDirectory).mode & 0o777).toBe(0o700);
    await expect(canConnect(supervisor.socketPath)).resolves.toBe(true);
    expect(supervisor.resumeArgs("vendor-thread")).toEqual([
      fixture.script,
      "--global",
      "value",
      "resume",
      "--remote",
      `unix://${supervisor.socketPath}`,
      "vendor-thread",
    ]);

    await supervisor.close();
  });

  it("refuses a live Unix socket and replaces its stale remnant after owner death", async () => {
    const fixture = fakeCodexFixture();
    const socketPath = join(fixture.socketDirectory, "app-server.sock");
    const owner = spawn(
      process.execPath,
      [fixture.script, "app-server", "--listen", `unix://${socketPath}`],
      { env: process.env, stdio: "ignore" },
    );
    try {
      await eventually(async () => await canConnect(socketPath));
      const supervisor = new CodexAppServerSupervisor({
        binary: process.execPath,
        args: [fixture.script, "app-server"],
        socketDirectory: fixture.socketDirectory,
        environment: process.env,
      });
      await expect(supervisor.start()).rejects.toThrow("socket is already active");

      owner.kill("SIGKILL");
      await processExit(owner);
      expect(lstatSync(socketPath).isSocket()).toBe(true);

      await supervisor.start();
      await expect(canConnect(socketPath)).resolves.toBe(true);
      await supervisor.close();
    } finally {
      if (owner.exitCode === null) owner.kill("SIGKILL");
    }
  });

  it("cannot leak an app-server when close races startup", async () => {
    const fixture = fakeCodexFixture();
    const pidFile = join(fixture.directory, "server.pid");
    const supervisor = new CodexAppServerSupervisor({
      binary: process.execPath,
      args: [fixture.script, "app-server"],
      socketDirectory: fixture.socketDirectory,
      environment: {
        ...process.env,
        FAKE_CODEX_PID_FILE: pidFile,
        FAKE_CODEX_LISTEN_DELAY_MS: "1000",
      },
    });

    const starting = supervisor.start();
    await eventually(() => readOptional(pidFile) !== undefined);
    const pid = Number(readFileSync(pidFile, "utf8"));
    await supervisor.close();
    await expect(starting).rejects.toThrow();
    await eventually(() => !processExists(pid));
  });

  it("keeps the shared app server alive when a remote TUI exits", async () => {
    const fixture = fakeCodexFixture();
    const supervisor = new CodexAppServerSupervisor({
      binary: process.execPath,
      args: [fixture.script, "app-server"],
      socketDirectory: fixture.socketDirectory,
      environment: { ...process.env, FAKE_CODEX_TUI_EXIT_MS: "25" },
    });
    await supervisor.start();
    const provider = new CodexTerminalProvider(
      adapterScopeIdSchema.parse("codex:runtime-test"),
      supervisor,
    );
    const terminal = await provider.open({
      target: {
        sessionId: newSessionId(),
        runtimeNodeId: newRuntimeNodeId(),
        bindingRevision: 1,
      },
      harness: "codex",
      adapterScopeId: provider.adapterScopeId,
      vendorSessionId: "vendor-thread",
      cwd: fixture.directory,
      dimensions: { columns: 90, rows: 25 },
      foregroundSwitch: false,
    });
    const output: string[] = [];
    terminal.onData((data) => output.push(data));
    await new Promise<void>((resolve) => terminal.onExit(() => resolve()));

    expect(output.join("")).toContain("fake Codex TUI");
    await expect(canConnect(supervisor.socketPath)).resolves.toBe(true);
    await supervisor.close();
  });
});

describe("Codex Unix WebSocket transport", () => {
  it("performs a WebSocket handshake and exchanges text frames over a Unix socket", async () => {
    const directory = temporaryDirectory();
    const socketPath = join(directory, "rpc.sock");
    const http = createHttpServer();
    const webSockets = new WebSocketServer({ noServer: true });
    let requestPath: string | undefined;
    http.on("upgrade", (request, socket, head) => {
      requestPath = request.url;
      webSockets.handleUpgrade(request, socket, head, (client) => {
        webSockets.emit("connection", client, request);
      });
    });
    webSockets.on("connection", (client) => {
      client.on("message", (data, isBinary) => {
        expect(isBinary).toBe(false);
        client.send(data.toString());
      });
    });
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(socketPath, resolve);
    });

    const connection = new CodexUnixSocketRpcConnection(socketPath, 2_000);
    const received = new Promise<string>((resolve) => connection.onMessage(resolve));
    await connection.start();
    await connection.send('{"jsonrpc":"2.0","id":1}');
    await expect(received).resolves.toBe('{"jsonrpc":"2.0","id":1}');
    expect(requestPath).toBe("/rpc");

    await connection.close();
    await new Promise<void>((resolve) => webSockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      http.close((error) => error ? reject(error) : resolve()));
  });
});

function fakeCodexFixture(): {
  directory: string;
  socketDirectory: string;
  script: string;
} {
  const directory = temporaryDirectory();
  const socketDirectory = join(directory, "socket");
  const script = join(directory, "fake-codex.mjs");
  writeFileSync(script, String.raw`
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const args = process.argv.slice(2);
if (args.includes("resume")) {
  process.stdout.write("fake Codex TUI\r\n");
  setTimeout(() => process.exit(0), Number(process.env.FAKE_CODEX_TUI_EXIT_MS ?? 10));
} else {
  const listenIndex = args.indexOf("--listen");
  const listenUri = args[listenIndex + 1];
  if (!listenUri?.startsWith("unix://")) throw new Error("missing Unix listen URI");
  const socketPath = listenUri.slice("unix://".length);
  mkdirSync(new URL(".", "file://" + socketPath).pathname, { recursive: true });
  if (process.env.FAKE_CODEX_PID_FILE) {
    writeFileSync(process.env.FAKE_CODEX_PID_FILE, String(process.pid));
  }
  const server = createServer((socket) => socket.on("data", () => undefined));
  const listen = () => server.listen(socketPath);
  const stdoutBytes = Number(process.env.FAKE_CODEX_STDOUT_BYTES ?? 0);
  const delay = Number(process.env.FAKE_CODEX_LISTEN_DELAY_MS ?? 0);
  const schedule = () => setTimeout(listen, delay);
  if (stdoutBytes > 0) process.stdout.write("x".repeat(stdoutBytes), schedule);
  else schedule();
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
`, { mode: 0o700 });
  return { directory, socketDirectory, script };
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "agent-multiplex-codex-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectSocket(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function processExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readOptional(filename: string): string | undefined {
  try {
    return readFileSync(filename, "utf8");
  } catch {
    return undefined;
  }
}

async function eventually(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition did not become true before deadline");
}
