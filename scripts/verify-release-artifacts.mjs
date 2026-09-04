import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";

import {
  assert,
  packageManifest,
  releasePackages,
  releaseVersion,
  repositoryRoot,
  rootManifest,
} from "./release-config.mjs";

const outputDirectory = resolve(repositoryRoot, process.argv[2] ?? "release-artifacts");
const verifyRegistry = process.env.AGENT_MULTIPLEX_VERIFY_REGISTRY === "1";
assert(
  typeof process.env.NODE_AUTH_TOKEN === "string" && process.env.NODE_AUTH_TOKEN.length > 0,
  "NODE_AUTH_TOKEN with GitHub Packages read access is required",
);
const manifest = JSON.parse(
  readFileSync(resolve(outputDirectory, "pack-manifest.json"), "utf8"),
);
assert(manifest.version === releaseVersion, "artifact version differs from source");
assert(manifest.packages.length === releasePackages.length, "artifact set is incomplete");

const publint = resolve(repositoryRoot, "node_modules/.bin/publint");
const attw = resolve(repositoryRoot, "node_modules/.bin/attw");
for (const artifact of manifest.packages) {
  const tarball = resolve(outputDirectory, artifact.filename);
  run(publint, [tarball, "--strict"]);
  const entry = releasePackages.find(({ name }) => name === artifact.name);
  assert(entry !== undefined, `unknown artifact ${artifact.name}`);
  const packageJson = packageManifest(entry);
  if (packageJson.types || containsTypesExport(packageJson.exports)) {
    run(attw, [tarball, "--profile", "esm-only", "--no-definitely-typed"]);
  }
}

const directory = mkdtempSync(resolve(tmpdir(), "agent-multiplex-packed-consumer-"));
try {
  const installTargets = manifest.packages.map((artifact) => verifyRegistry
    ? `${artifact.name}@${artifact.version}`
    : resolve(outputDirectory, artifact.filename));
  writeFileSync(resolve(directory, "package.json"), `${JSON.stringify({
    name: "agent-multiplex-packed-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    allowScripts: {
      "esbuild@0.25.12": true,
      "esbuild@0.28.2": true,
      "fsevents@2.3.3": false,
      "koffi@3.2.1": true,
      "msgpackr-extract@3.0.4": true,
      "node-pty@1.1.0": true,
    },
    devDependencies: {
      "@types/node": rootManifest.devDependencies["@types/node"],
      "@types/ws": rootManifest.devDependencies["@types/ws"],
    },
  }, null, 2)}\n`);
  const npmrc = [
    "@arduano:registry=https://npm.pkg.github.com",
    "fund=false",
    "audit=false",
    "strict-allow-scripts=true",
    ...(process.env.NODE_AUTH_TOKEN
      ? ["//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}"]
      : []),
    "",
  ].join("\n");
  const npmrcPath = resolve(directory, ".npmrc");
  writeFileSync(npmrcPath, npmrc, { mode: 0o600 });

  run("npm", ["install", "--strict-allow-scripts", ...installTargets], {
    cwd: directory,
    env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrcPath },
  });

  const libraries = releasePackages.filter(({ workspace }) =>
    workspace.startsWith("packages/") || workspace === "apps/web");
  writeFileSync(
    resolve(directory, "imports.mjs"),
    `${libraries.map(({ name }, index) => `import * as package${index} from ${JSON.stringify(name)};`).join("\n")}\n` +
      `${libraries.map((_, index) => `if (!Object.isFrozen(package${index})) void package${index};`).join("\n")}\n` +
      `console.log("Imported ${libraries.length} release packages.");\n`,
  );
  run("node", ["imports.mjs"], { cwd: directory });

  writeFileSync(
    resolve(directory, "consumer.ts"),
    `${libraries.map(({ name }, index) => `import type * as Package${index} from ${JSON.stringify(name)};`).join("\n")}\n` +
      `${libraries.map((_, index) => `type Used${index} = keyof typeof Package${index};`).join("\n")}\n` +
      `export type AllExports = [${libraries.map((_, index) => `Used${index}`).join(", ")}];\n`,
  );
  writeFileSync(resolve(directory, "tsconfig.json"), `${JSON.stringify({
    compilerOptions: {
      target: "ES2023",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
    },
    files: ["consumer.ts"],
  }, null, 2)}\n`);
  run(process.execPath, [resolve(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], {
    cwd: directory,
  });

  writeFileSync(
    resolve(directory, "browser.mjs"),
    `import { createAccessClient, launchRequest, watchAccess } from "@arduano/agent-multiplex-client";\n` +
      `globalThis.__agentMultiplexBrowserSmoke = { createAccessClient, launchRequest, watchAccess };\n`,
  );
  run(resolve(repositoryRoot, "node_modules/.bin/esbuild"), [
    "browser.mjs",
    "--bundle",
    "--platform=browser",
    "--format=esm",
    "--outfile=browser-bundle.mjs",
    "--log-level=warning",
  ], { cwd: directory });
  const bundle = readFileSync(resolve(directory, "browser-bundle.mjs"), "utf8");
  for (const forbidden of ["node:crypto", "node-pty", "@momics/iroh", "@arduano/p2prpc-core"]) {
    assert(!bundle.includes(forbidden), `browser bundle contains native dependency ${forbidden}`);
  }

  for (const entry of releasePackages) {
    const bins = packageManifest(entry).bin ?? {};
    for (const name of Object.keys(bins)) {
      const executable = resolve(directory, "node_modules/.bin", name);
      chmodSync(executable, 0o755);
      run(executable, ["--help"], {
        cwd: directory,
        env: { ...process.env, PATH: `${resolve(directory, "node_modules/.bin")}${delimiter}${process.env.PATH ?? ""}` },
      });
      const reportedVersion = execFileSync(executable, ["--version"], {
        cwd: directory,
        encoding: "utf8",
        timeout: 120_000,
      }).trim();
      assert(
        reportedVersion === releaseVersion || reportedVersion.endsWith(` ${releaseVersion}`),
        `${name} --version returned ${JSON.stringify(reportedVersion)} instead of ${releaseVersion}`,
      );
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log(`Verified ${manifest.packages.length} packed packages in isolated consumers.`);

function containsTypesExport(value) {
  if (typeof value === "string" || value === null || value === undefined) return false;
  if (typeof value !== "object") return false;
  if (Object.hasOwn(value, "types")) return true;
  return Object.values(value).some(containsTypesExport);
}

function run(command, arguments_, options = {}) {
  execFileSync(command, arguments_, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    stdio: "inherit",
    timeout: 120_000,
  });
}
