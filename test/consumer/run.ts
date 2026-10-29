#!/usr/bin/env -S tsx
/** Explicit packaging qualification; no vendor CLI/model/endpoint is invoked. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { command, optional, positional, run, string, type Type } from "cmd-ts";

const pathType: Type<string, string> = {
  ...string,
  async from(value) {
    if (value.trim().length === 0) throw Error("An explicit nonempty path is required");
    return value;
  },
};
const cli = command({
  name: "consumer-qualification",
  description: "Install and inspect one built package in an isolated consumer.",
  args: {
    checkpoint: positional({ type: optional(pathType), displayName: "built-checkpoint" }),
  },
  handler: async ({ checkpoint }) => {
    const exec = promisify(execFile),
      source = resolve(checkpoint ?? ".");
    const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as {
      name: string;
      version: string;
      dependencies: Record<string, string>;
    };
    await access(join(source, "dist/index.js"));
    const temporary = await mkdtemp(join(tmpdir(), "multiplex-public-consumer-"));
    const env = { ...process.env };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;
    const started = Date.now();
    let result: unknown, failure: unknown;
    async function execute(binary: string, args: string[], cwd: string, timeout: number) {
      return exec(binary, args, { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024 });
    }
    async function cleanupOwnedConsumer(): Promise<void> {
      await rm(temporary, { recursive: true, force: true });
      try {
        await access(temporary);
        throw Error("Owned consumer cleanup failed");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }
    try {
      const packed = JSON.parse(
        (
          await execute(
            "npm",
            ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
            source,
            30000,
          )
        ).stdout,
      ) as { filename: string; integrity: string }[];
      assert.equal(packed.length, 1);
      const artifact = packed[0];
      assert.ok(artifact);
      const consumer = join(temporary, "consumer");
      await mkdir(consumer);
      await writeFile(
        join(consumer, "package.json"),
        JSON.stringify({ name: "multiplex-independent-consumer", private: true, type: "module" }),
      );
      const installation = await execute(
        "npm",
        [
          "install",
          "--ignore-scripts",
          "--include=optional",
          "--no-audit",
          "--no-fund",
          join(temporary, artifact.filename),
        ],
        consumer,
        180000,
      );
      // Only explicit qualification tooling resolves outside the isolated consumer.
      // Framework imports, published dependency pins and native bindings do not.
      const inspector = (await readFile(new URL("./inspect.ts", import.meta.url), "utf8")).replace(
        'from "cmd-ts"',
        `from ${JSON.stringify(import.meta.resolve("cmd-ts"))}`,
      );
      const expected = join(consumer, "expected.json"),
        inspect = join(consumer, "inspect.ts");
      await writeFile(
        expected,
        JSON.stringify({
          name: manifest.name,
          version: manifest.version,
          dependencies: manifest.dependencies,
        }),
      );
      await writeFile(inspect, inspector);
      const inspected = await execute(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), inspect, "--expected", expected],
        consumer,
        30000,
      );
      result = {
        artifact: artifact.integrity,
        install: installation.stdout.trim(),
        ...(JSON.parse(inspected.stdout) as Record<string, unknown>),
      };
    } catch (error) {
      failure = error;
    } finally {
      await cleanupOwnedConsumer();
    }
    console.log(
      JSON.stringify(
        {
          source,
          elapsedMs: Date.now() - started,
          cleanup: { path: temporary, removed: true },
          result,
        },
        null,
        2,
      ),
    );
    if (failure) throw failure;
  },
});
await run(cli, process.argv.slice(2));
