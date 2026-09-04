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
  releasePackages,
  releaseVersion,
  repositoryRoot,
} from "./release-config.mjs";
import { validateReleaseArtifactSet } from "./release-artifact-validation.mjs";

const outputDirectory = resolve(repositoryRoot, process.argv[2] ?? "release-artifacts");
const verifyRegistry = process.env.AGENT_MULTIPLEX_VERIFY_REGISTRY === "1";
assert(
  typeof process.env.NODE_AUTH_TOKEN === "string" && process.env.NODE_AUTH_TOKEN.length > 0,
  "NODE_AUTH_TOKEN with GitHub Packages read access is required",
);
const { artifacts } = validateReleaseArtifactSet(outputDirectory);

const publint = resolve(repositoryRoot, "node_modules/.bin/publint");
const attw = resolve(repositoryRoot, "node_modules/.bin/attw");
for (const artifact of artifacts) {
  run(publint, [artifact.path, "--strict"]);
  if (artifact.packageJson.types || containsTypesExport(artifact.packageJson.exports)) {
    run(attw, [artifact.path, "--profile", "esm-only", "--no-definitely-typed"]);
  }
}

for (const artifact of artifacts) verifyIsolatedConsumer(artifact);

console.log(`Verified ${artifacts.length} packed packages in role-isolated consumers.`);

function verifyIsolatedConsumer(subject) {
  const directory = mkdtempSync(resolve(tmpdir(), "agent-multiplex-packed-consumer-"));
  try {
    const dependencies = verifyRegistry
      ? { [subject.name]: subject.version }
      : Object.fromEntries(
        internalDependencyClosure(subject).map((artifact) => [
          artifact.name,
          `file:${artifact.path}`,
        ]),
      );
    writeFileSync(
      resolve(directory, "package.json"),
      `${JSON.stringify({
        name: `agent-multiplex-consumer-${safeName(subject.name)}`,
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
        dependencies,
      }, null, 2)}\n`,
    );
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

    run("npm", [
      "install",
      "--strict-allow-scripts",
    ], {
      cwd: directory,
      env: { ...process.env, NPM_CONFIG_USERCONFIG: npmrcPath },
      timeout: 300_000,
    });

    if (subject.workspace.startsWith("packages/") || subject.workspace === "apps/web") {
      writeFileSync(
        resolve(directory, "imports.mjs"),
        `import * as subject from ${JSON.stringify(subject.name)};\n` +
          `if (typeof subject !== "object") throw new Error("package namespace was not loaded");\n`,
      );
      run("node", ["imports.mjs"], { cwd: directory });
    }

    if (subject.packageJson.types || containsTypesExport(subject.packageJson.exports)) {
      writeFileSync(
        resolve(directory, "consumer.ts"),
        `import type * as Subject from ${JSON.stringify(subject.name)};\n` +
          `export type PublicKeys = keyof typeof Subject;\n` +
          declarationDependencyProbe(subject),
      );
      writeFileSync(resolve(directory, "tsconfig.json"), `${JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          // @trpc/server@11.18.0's published ws adapter declaration is not
          // internally strict-clean against @types/ws's ESM condition. ATTW
          // validates our ESM surface; explicit probes below still ensure
          // declaration-only Node/ws dependencies resolve in the consumer.
          skipLibCheck: true,
        },
        files: ["consumer.ts"],
      }, null, 2)}\n`);
      run(process.execPath, [resolve(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], {
        cwd: directory,
      });
    }

    if (subject.name === "@arduano/agent-multiplex-client") {
      verifyBrowserBundle(directory);
    }

    for (const name of Object.keys(subject.packageJson.bin ?? {})) {
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
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function verifyBrowserBundle(directory) {
  writeFileSync(
    resolve(directory, "browser.mjs"),
    `import { createAccessClient, launchRequest, watchAccess } from "@arduano/agent-multiplex-client/browser";\n` +
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
}

function internalDependencyClosure(subject) {
  const byName = new Map(artifacts.map((artifact) => [artifact.name, artifact]));
  const selected = new Set();
  const pending = [subject.name];
  while (pending.length > 0) {
    const name = pending.pop();
    if (selected.has(name)) continue;
    const artifact = byName.get(name);
    assert(artifact !== undefined, `${subject.name}: missing internal dependency artifact ${name}`);
    selected.add(name);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      for (const dependency of Object.keys(artifact.packageJson[field] ?? {})) {
        if (byName.has(dependency)) pending.push(dependency);
      }
    }
  }
  return releasePackages
    .map(({ name }) => byName.get(name))
    .filter((artifact) => artifact !== undefined && selected.has(artifact.name));
}

function safeName(name) {
  return name.replace(/^@/, "").replaceAll(/[^a-z0-9-]+/g, "-");
}

function declarationDependencyProbe(subject) {
  let source = "";
  if (subject.packageJson.dependencies?.["@types/node"]) {
    source += `import type { DatabaseSync } from "node:sqlite";\n` +
      `type NodeDeclarationProbe = [DatabaseSync, NodeJS.ProcessEnv];\n`;
  }
  if (subject.packageJson.dependencies?.["@types/ws"]) {
    source += `import type { WebSocket, WebSocketServer } from "ws";\n` +
      `type WsDeclarationProbe = [WebSocket, WebSocketServer];\n`;
  }
  return source;
}

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
    timeout: options.timeout ?? 120_000,
  });
}
