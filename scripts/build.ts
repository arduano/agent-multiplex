import { execFileSync } from "node:child_process";
import { copyFile, rm } from "node:fs/promises";
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
  for (const name of ["LICENSE", "NOTICE", "provenance.json"]) {
    await copyFile(
      new URL(`src/codex/protocol/${name}`, root),
      new URL(`dist/codex/protocol/${name}`, root),
    );
  }
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
