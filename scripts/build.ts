import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { command, run } from "cmd-ts";
import { build, stop } from "esbuild-wasm";

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
  await copyFile(new URL("src/chat/styles.css", root), new URL("dist/chat/styles.css", root));

  const assets = new URL("dist/reference/web/", root);
  await mkdir(assets, { recursive: true });
  try {
    const bundled = await build({
      absWorkingDir: fileURLToPath(root),
      entryPoints: ["src/reference/ui/boot.ts"],
      bundle: true,
      platform: "browser",
      format: "esm",
      jsx: "automatic",
      target: "es2023",
      outfile: fileURLToPath(new URL("app.js", assets)),
      metafile: true,
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    });
    for (const output of Object.values(bundled.metafile.outputs)) {
      if (output.imports.some((value) => value.path.startsWith("node:"))) {
        throw Error("Browser bundle imports Node");
      }
    }
  } finally {
    await stop();
  }
  await writeFile(
    new URL("app.css", assets),
    (await readFile(new URL("src/chat/styles.css", root), "utf8")) +
      "\n" +
      (await readFile(new URL("src/reference/ui/styles.css", root), "utf8")),
  );
  await copyFile(
    new URL("src/reference/ui/styles.css", root),
    new URL("dist/reference/ui/styles.css", root),
  );
  await writeFile(
    new URL("index.html", assets),
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Multiplex reference</title><link rel="stylesheet" href="/app.css"><style>html,body,#app{height:100%;width:100%;margin:0;overflow:hidden}</style></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>',
  );
  await chmod(new URL("dist/reference/cli.js", root), 0o755);
}

await run(
  command({
    name: "multiplex-build",
    description: "Build the public package and browser reference from this checkout.",
    args: {},
    handler: buildPackage,
  }),
  process.argv.slice(2),
);
