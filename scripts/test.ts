import { execFileSync, spawnSync } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { command, run } from "cmd-ts";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);

async function tests(directory: string): Promise<string[]> {
  const values: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) values.push(...(await tests(file)));
    else if (entry.name.endsWith(".test.js")) values.push(file);
  }
  return values.sort();
}

async function testPackage(): Promise<void> {
  await rm(new URL(".build/", root), { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [require.resolve("typescript/bin/tsc"), "--project", "tsconfig.test.json"],
    { cwd: root, stdio: "inherit", timeout: 60_000, killSignal: "SIGKILL" },
  );
  const files = await tests(fileURLToPath(new URL(".build/test/", root)));
  if (!files.length) throw Error("No owner tests selected");
  // The runner owns/reaps this exact child. Individual tests retain their
  // existing 60s bound; a stuck runner cannot survive indefinitely.
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=2", "--test-timeout=60000", ...files],
    { cwd: root, stdio: "inherit", timeout: 600_000, killSignal: "SIGKILL" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) process.exitCode = 1;
}

await run(
  command({
    name: "multiplex-test",
    description: "Compile and run this checkout's owner tests with bounded children.",
    args: {},
    handler: testPackage,
  }),
  process.argv.slice(2),
);
