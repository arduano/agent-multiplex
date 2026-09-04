import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedWorkspaces = [
  "packages/protocol",
  "packages/storage-sqlite",
  "packages/control-node-core",
  "packages/runtime-node-core",
  "packages/gateway-core",
  "packages/transport-p2prpc",
  "packages/client",
  "packages/client-p2prpc",
  "packages/adapter-codex",
  "packages/adapter-copilot",
  "packages/adapter-mock",
  "apps/control-node",
  "apps/runtime-node",
  "apps/gateway",
  "apps/cli",
  "apps/web",
];
const archivedWorkspaces = ["apps/host", "packages/host-core"];
const archivedProtocolV2Tests = [
  "tests/e2e.test.ts",
  "tests/host-app-config.test.ts",
  "tests/host-app.test.ts",
  "tests/host-core-authority.test.ts",
  "tests/host-core-child-reconnect.test.ts",
  "tests/host-core-metadata-monotonic.test.ts",
  "tests/host-core-topology.test.ts",
  "tests/host-core-v2-service.test.ts",
  "tests/host-core.test.ts",
  "tests/host-parent.test.ts",
];
const maintainedDockerBuilds = [
  "tests/docker-v3-tree/Dockerfile",
  "tests/docker-mock-scale/Dockerfile",
  "tests/docker-live-four-container/Dockerfile",
];

const rootManifest = readJson("package.json");
assert(rootManifest.name === "agent-multiplex", "unexpected root package name");
assert(
  process.versions.node.split(".").map(Number)[0] >= 24,
  `Node.js 24 or newer is required; found ${process.version}`,
);
assertSameSet(rootManifest.workspaces, expectedWorkspaces, "active workspace set");

const rootTsconfig = readJson("tsconfig.json");
const projectReferences = (rootTsconfig.references ?? []).map((entry) => entry.path);
assertSameSet(projectReferences, expectedWorkspaces, "TypeScript project-reference set");

const lockfile = readJson("package-lock.json");
assert(lockfile.lockfileVersion === 3, "package-lock.json must use lockfile version 3");
const lockedWorkspaces = Object.keys(lockfile.packages ?? {}).filter((path) =>
  /^(apps|packages)\/[^/]+$/.test(path),
);
assertSameSet(lockedWorkspaces, expectedWorkspaces, "locked workspace set");

for (const workspacePath of expectedWorkspaces) {
  const manifestPath = `${workspacePath}/package.json`;
  const tsconfigPath = `${workspacePath}/tsconfig.json`;
  assert(exists(manifestPath), `${workspacePath} has no package.json`);
  assert(exists(tsconfigPath), `${workspacePath} has no tsconfig.json`);

  const manifest = readJson(manifestPath);
  for (const target of packageTargets(manifest)) {
    assert(
      exists(`${workspacePath}/${target}`),
      `${manifest.name ?? workspacePath} package target ${target} does not exist`,
    );
  }

  for (const source of walk(resolve(repositoryRoot, workspacePath, "src"))) {
    if (![".ts", ".tsx"].includes(extname(source))) continue;
    const contents = readFileSync(source, "utf8");
    assert(
      !/@arduano\/agent-multiplex-(?:host|host-core|worker-core)(?:["'/]|$)/.test(contents),
      `${relative(repositoryRoot, source)} imports an archived protocol-v2 package`,
    );
  }

  assertNoOrphanedCompilerOutput(workspacePath);
}

for (const workspacePath of archivedWorkspaces) {
  assert(
    !rootManifest.workspaces.includes(workspacePath),
    `${workspacePath} must stay outside the active workspace set`,
  );
  assert(
    !exists(`${workspacePath}/dist`),
    `${workspacePath}/dist is stale generated v2 output; run npm run clean`,
  );
}

const vitestConfig = readFileSync(resolve(repositoryRoot, "vitest.config.ts"), "utf8");
assert(
  !vitestConfig.includes('"tests/host-*.test.ts"'),
  "Vitest must not wildcard-exclude future host-named tests",
);
for (const testPath of archivedProtocolV2Tests) {
  assert(exists(testPath), `${testPath} is missing from the protocol-v2 evidence set`);
  assert(
    vitestConfig.includes(JSON.stringify(testPath)),
    `${testPath} must remain explicitly excluded from the maintained test suite`,
  );
  const contents = readFileSync(resolve(repositoryRoot, testPath), "utf8");
  assert(
    !contents.includes("@arduano/agent-multiplex-"),
    `${testPath} must retain its historical imports instead of mixing in the published v4 graph`,
  );
}

const dockerIgnore = readFileSync(resolve(repositoryRoot, ".dockerignore"), "utf8")
  .split(/\r?\n/u)
  .map((line) => line.trim());
for (const ignoredPath of [...archivedWorkspaces, "receipts"]) {
  assert(
    dockerIgnore.includes(ignoredPath),
    `.dockerignore must exclude ${ignoredPath}`,
  );
}

for (const dockerfilePath of maintainedDockerBuilds) {
  const dockerfile = readFileSync(resolve(repositoryRoot, dockerfilePath), "utf8");
  assert(
    /^COPY release-packages\.json \.\/$/mu.test(dockerfile),
    `${dockerfilePath} must copy the release workspace manifest before building`,
  );
  assert(
    /^COPY scripts\/ \.\/scripts\/$/mu.test(dockerfile),
    `${dockerfilePath} must copy the root build scripts before running npm run build`,
  );
}

const transportManifest = readJson("packages/transport-p2prpc/package.json");
const p2prpcVersion = transportManifest.dependencies?.["@arduano/p2prpc-core"];
assert(
  p2prpcVersion === "0.2.1",
  "@arduano/p2prpc-core must remain pinned to the exact independently released transport version",
);
assert(
  lockfile.packages?.["packages/transport-p2prpc"]?.dependencies?.["@arduano/p2prpc-core"] ===
    p2prpcVersion,
  "the lockfile must preserve the transport's exact @arduano/p2prpc-core pin",
);
const lockedP2prpc = lockfile.packages?.["node_modules/@arduano/p2prpc-core"];
assert(
  lockedP2prpc?.version === p2prpcVersion &&
    typeof lockedP2prpc.resolved === "string" &&
    lockedP2prpc.resolved.startsWith("https://npm.pkg.github.com/"),
  `the lockfile must resolve @arduano/p2prpc-core@${p2prpcVersion} from GitHub Packages`,
);

const siblingP2prpcManifestPath = "../p2prpc/packages/core/package.json";
if (exists(siblingP2prpcManifestPath)) {
  const siblingP2prpcManifest = readJson(siblingP2prpcManifestPath);
  assert(
    siblingP2prpcManifest.name === "@arduano/p2prpc-core" &&
      siblingP2prpcManifest.version === p2prpcVersion,
    `optional sibling p2prpc checkout must match @arduano/p2prpc-core@${p2prpcVersion}`,
  );
}

console.log(
  `Checkpoint structure is coherent: ${expectedWorkspaces.length} active v4 workspaces, 2 archived v2 workspaces, and no orphaned compiler output.`,
);

function assertNoOrphanedCompilerOutput(workspacePath) {
  const outputRoot = resolve(repositoryRoot, workspacePath, "dist");
  assert(existsSync(outputRoot), `${workspacePath} has not been built`);
  for (const output of walk(outputRoot)) {
    const outputRelative = relative(outputRoot, output);
    if (outputRelative === ".tsbuildinfo" || outputRelative.startsWith("client/")) {
      continue;
    }
    const sourceStem = sourceStemForOutput(outputRelative);
    assert(sourceStem !== null, `${workspacePath}/dist/${outputRelative} is an unknown output`);
    const sourceRoot = resolve(repositoryRoot, workspacePath, "src", sourceStem);
    assert(
      existsSync(`${sourceRoot}.ts`) || existsSync(`${sourceRoot}.tsx`),
      `${workspacePath}/dist/${outputRelative} has no current source; run npm run clean`,
    );
  }
}

function sourceStemForOutput(path) {
  for (const suffix of [".d.ts.map", ".d.ts", ".js.map", ".js"]) {
    if (path.endsWith(suffix)) return path.slice(0, -suffix.length);
  }
  return null;
}

function packageTargets(manifest) {
  const targets = new Set();
  collectTarget(manifest.main, targets);
  collectTarget(manifest.types, targets);
  if (manifest.bin && typeof manifest.bin === "object") {
    for (const target of Object.values(manifest.bin)) collectTarget(target, targets);
  }
  collectExports(manifest.exports, targets);
  return [...targets].map((target) => target.replace(/^\.\//, ""));
}

function collectExports(value, targets) {
  if (typeof value === "string") {
    // JSON exports may intentionally point at committed source rather than dist.
    collectTarget(value, targets);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const nested of Object.values(value)) collectExports(nested, targets);
}

function collectTarget(value, targets) {
  if (typeof value === "string" && !value.includes("*")) targets.add(value);
}

function walk(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current)) {
      const path = resolve(current, entry);
      if (statSync(path).isDirectory()) pending.push(path);
      else files.push(path);
    }
  }
  return files;
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
}

function exists(path) {
  return existsSync(resolve(repositoryRoot, path));
}

function assertSameSet(actual, expected, description) {
  assert(Array.isArray(actual), `${description} is not an array`);
  const left = [...actual].sort();
  const right = [...expected].sort();
  assert(
    JSON.stringify(left) === JSON.stringify(right),
    `${description} differs: expected ${right.join(", ")}; found ${left.join(", ")}`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
