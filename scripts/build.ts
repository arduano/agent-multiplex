import { execFileSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { command, run } from "cmd-ts";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);

async function buildPackage(): Promise<void> {
  // Only this checkout's declared generated output is replaced.
  await rm(new URL("dist/", root), { recursive: true, force: true });
  execFileSync(
    process.execPath,
    [require.resolve("typescript/bin/tsc"), "--project", "tsconfig.json"],
    { cwd: root, stdio: "inherit", timeout: 60_000, killSignal: "SIGKILL" },
  );
}

await run(
  command({
    name: "multiplex-build",
    description: "Build the public package from this checkout.",
    args: {},
    handler: buildPackage,
  }),
  process.argv.slice(2),
);
