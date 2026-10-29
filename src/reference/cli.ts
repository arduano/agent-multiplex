#!/usr/bin/env node
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { command, option, positional, runSafely, string, subcommands, type Type } from "cmd-ts";
import { startReference, ReferenceStartupError } from "./server/application.js";
import { serve } from "./server/http.js";
import { statePaths } from "./server/paths.js";
import type { Application } from "./node-contracts.js";
export type CliArguments =
  | Readonly<{ command: "help"; message: string }>
  | Readonly<{ command: "demo"; port: number }>
  | Readonly<{
      command: "run";
      application: string;
      agentsDirectory: string;
      systemDirectory: string;
      port: number;
    }>;

class CliUsageError extends Error {}

const portType: Type<string, number> = {
  displayName: "port",
  async from(value) {
    const number = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 0 || number > 65535)
      throw Error("Port must be an integer from 0 to 65535");
    return number;
  },
};
const pathType: Type<string, string> = {
  ...string,
  async from(value) {
    if (value.trim().length === 0) throw Error("An explicit nonempty path is required");
    return value;
  },
};
function portOption() {
  const parser = option({
    long: "port",
    type: portType,
    defaultValue: () => 0,
    defaultValueIsSerializable: true,
    description: "Loopback listener port; 0 selects an available port",
  });
  return {
    ...parser,
    async parse(context: Parameters<typeof parser.parse>[0]): ReturnType<typeof parser.parse> {
      // cmd-ts applies defaults to a present option with no value as well as an
      // absent option. Only absence may select our ephemeral-port default.
      const missing = context.nodes.find(
        (node) =>
          node.type === "longOption" &&
          node.key === "port" &&
          !node.value &&
          !context.visitedNodes.has(node),
      );
      if (missing) {
        context.visitedNodes.add(missing);
        return {
          _tag: "error",
          error: {
            errors: [{ nodes: [missing], message: "Port must be an integer from 0 to 65535" }],
          },
        };
      }
      return parser.parse(context);
    },
  };
}
const cli = subcommands({
  name: "multiplex",
  description:
    "Agent Multiplex reconstruction. Demo is disposable and model-free. Run imports an explicit application that owns authentication and native shutdown; no native home, provider, login, fleet enrollment or session Resume is inferred.",
  cmds: {
    demo: command({
      name: "demo",
      description: "Start the disposable, model-free loopback reference UI",
      args: { port: portOption() },
      handler: ({ port }) => ({ command: "demo" as const, port }),
    }),
    run: command({
      name: "run",
      description: "Import an explicit application .ts/.tsx module exporting create({paths})",
      args: {
        application: positional({
          type: pathType,
          displayName: "application",
          description: "Explicit application module (.ts/.tsx supported)",
        }),
        agentsDirectory: positional({
          type: pathType,
          displayName: "agents-directory",
          description: "Private mutable agent/session data directory",
        }),
        systemDirectory: positional({
          type: pathType,
          displayName: "system-directory",
          description: "Separate private machine credentials/pairing directory",
        }),
        port: portOption(),
      },
      handler: (values) => ({ command: "run" as const, ...values }),
    }),
  },
});

/** Decode only: cmd-ts help/errors never exit the process or acquire resources. */
export async function parseArguments(args: readonly string[]): Promise<CliArguments> {
  const result = await runSafely(cli, [...args]);
  if (result._tag === "error") {
    const { exitCode, message } = result.error.config;
    if (exitCode === 0) return { command: "help", message };
    throw new CliUsageError(message);
  }
  return result.value.value;
}

/** Explicit CLI only. Modules/imports never start listeners or agents. */
export async function main(args = process.argv.slice(2)): Promise<void> {
  const input = await parseArguments(args);
  if (input.command === "help") {
    process.stdout.write(input.message + "\n");
    return;
  }
  let close: () => Promise<void>;
  if (input.command === "demo") {
    const { configureProcessSignalHandling } = await import("@momics/iroh-http-node");
    configureProcessSignalHandling("application");
    const directory = await mkdtemp(resolve(tmpdir(), "multiplex-demo-"));
    let app: Awaited<ReturnType<typeof startReference>>;
    try {
      app = await startReference({
        directory,
        port: input.port,
        assetDirectory: fileURLToPath(new URL("./web/", import.meta.url)),
      });
    } catch (error) {
      if (!(error instanceof ReferenceStartupError))
        await rm(directory, { recursive: true, force: true });
      throw error;
    }
    process.stdout.write(`Model-free disposable reference UI: ${app.url}\n`);
    close = async () => {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    };
  } else {
    const paths = await statePaths({
        agents: resolve(input.agentsDirectory),
        system: resolve(input.systemDirectory),
      }),
      filename = await realpath(resolve(input.application));
    const { tsImport } = await import("tsx/esm/api");
    const loaded: unknown = await tsImport(pathToFileURL(filename).href, import.meta.url);
    if (
      !loaded ||
      typeof loaded !== "object" ||
      !("create" in loaded) ||
      typeof loaded.create !== "function"
    )
      throw Error("Application must export create({paths})");
    const created: unknown = await loaded.create({ paths });
    if (
      !created ||
      typeof created !== "object" ||
      !("handler" in created) ||
      typeof created.handler !== "function" ||
      !("close" in created) ||
      typeof created.close !== "function"
    )
      throw Error("Application must own handler and close");
    const app = created as Application;
    let server: Awaited<ReturnType<typeof serve>>;
    try {
      server = await serve({
        handler: (request) => app.handler(request),
        port: input.port,
        ...(app.upgrade ? { upgrade: app.upgrade } : {}),
      });
    } catch (error) {
      await app.close();
      throw error;
    }
    process.stdout.write(`Authenticated application listener: ${server.url}\n`);
    close = async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => server.close()),
        Promise.resolve().then(() => app.close()),
      ]);
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Application listener cleanup is unproved",
        );
    };
  }
  let closing: Promise<void> | undefined;
  const shutdown = () => {
    if (closing) return;
    // A pending Promise cannot keep Node alive after the last listener/native
    // socket closes. Retain the process until its application owner settles.
    const keepAlive = setInterval(() => {}, 1000);
    closing = Promise.resolve()
      .then(close)
      .then(
        () => {
          process.removeListener("SIGINT", shutdown);
          process.removeListener("SIGTERM", shutdown);
        },
        () => {
          process.stderr.write("Shutdown is not proved; retained resource owner did not close.\n");
          process.exitCode = 1;
        },
      )
      .finally(() => clearInterval(keepAlive));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void main().catch((error: unknown) => {
    process.stderr.write(
      error instanceof CliUsageError
        ? error.message + "\n"
        : "Agent Multiplex failed; check the explicit application configuration.\n",
    );
    process.exitCode = 1;
  });
