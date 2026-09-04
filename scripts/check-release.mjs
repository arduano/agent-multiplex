import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { extname, relative, resolve } from "node:path";

import {
  assert,
  bugsUrl,
  githubRegistry,
  homepageUrl,
  packageManifest,
  readJson,
  releaseConfig,
  releasePackages,
  releaseVersion,
  repositoryRoot,
  repositoryUrl,
  rootManifest,
} from "./release-config.mjs";

const requireArtifacts = process.argv.includes("--artifacts");
const archivedProtocolV2Tests = new Set([
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
]);

assert(releaseConfig.schemaVersion === 1, "unknown release-packages schema");
assert(rootManifest.private === true, "the monorepo root must stay private");
assert(rootManifest.version === releaseVersion, "invalid root release version");
assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseVersion), "root version is not semver");

const configuredPaths = releasePackages.map((entry) => entry.workspace);
assertSameSet(rootManifest.workspaces, configuredPaths, "release and workspace sets");
assert(
  new Set(releasePackages.map((entry) => entry.name)).size === releasePackages.length,
  "release package names must be unique",
);

const publicNames = new Set(releasePackages.map((entry) => entry.name));
for (const entry of releasePackages) {
  assert(/^(?:apps|packages)\/[^/]+$/.test(entry.workspace), `unsafe workspace ${entry.workspace}`);
  const manifest = packageManifest(entry);
  const label = `${entry.workspace} (${entry.name})`;
  assert(manifest.name === entry.name, `${label}: package name differs from release config`);
  assert(manifest.version === releaseVersion, `${label}: version must be ${releaseVersion}`);
  assert(manifest.private === false, `${label}: package must explicitly set private=false`);
  assert(manifest.type === "module", `${label}: only ESM packages are supported`);
  assert(manifest.license === "MIT", `${label}: license must be MIT`);
  assert(manifest.engines?.node === ">=24.0.0", `${label}: Node engine must be >=24.0.0`);
  assert(typeof manifest.description === "string" && manifest.description.length >= 12, `${label}: description is missing`);
  assert(manifest.repository?.type === "git", `${label}: repository type is missing`);
  assert(manifest.repository?.url === repositoryUrl, `${label}: repository URL is incorrect`);
  assert(manifest.repository?.directory === entry.workspace, `${label}: repository directory is incorrect`);
  assert(manifest.homepage === homepageUrl, `${label}: homepage is incorrect`);
  assert(manifest.bugs?.url === bugsUrl, `${label}: bugs URL is incorrect`);
  assert(manifest.publishConfig?.registry === githubRegistry, `${label}: GitHub Packages registry is required`);
  assert(manifest.publishConfig?.access === "public", `${label}: publish access must be public`);
  assert(Array.isArray(manifest.files) && manifest.files.includes("dist"), `${label}: dist must be packaged`);
  for (const filename of ["README.md", "LICENSE"]) {
    assert(existsSync(resolve(repositoryRoot, entry.workspace, filename)), `${label}: ${filename} is missing`);
  }

  for (const dependencyField of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const [dependency, specification] of Object.entries(manifest[dependencyField] ?? {})) {
      assert(typeof specification === "string", `${label}: invalid ${dependency} specification`);
      assert(
        !/^(?:file|link|workspace|git|github|https?):/i.test(specification) &&
          !/(?:^|[/:])github\.com(?:[/:]|$)/i.test(specification),
        `${label}: ${dependency} uses mutable/local specification ${specification}`,
      );
      if (publicNames.has(dependency)) {
        assert(specification === releaseVersion, `${label}: internal ${dependency} must use exact ${releaseVersion}`);
      }
      if (dependency === "@arduano/p2prpc-core") {
        assert(specification === "0.2.1", `${label}: p2prpc must use exact 0.2.1`);
      }
      assert(!dependency.startsWith("@agent-multiplex/"), `${label}: stale package scope ${dependency}`);
      assert(dependency !== "@p2prpc/core", `${label}: stale p2prpc package name`);
    }
  }

  if (requireArtifacts) {
    for (const target of packageTargets(manifest)) {
      const absolute = resolve(repositoryRoot, entry.workspace, target);
      assert(existsSync(absolute) && statSync(absolute).isFile(), `${label}: missing built target ${target}`);
    }
    assert(!existsSync(resolve(repositoryRoot, entry.workspace, "dist/.tsbuildinfo")), `${label}: dist/.tsbuildinfo must be removed before packing`);
    if (manifest.bin) {
      for (const target of Object.values(manifest.bin)) {
        const source = readFileSync(resolve(repositoryRoot, entry.workspace, target), "utf8");
        assert(source.startsWith("#!/usr/bin/env node\n"), `${label}: executable ${target} needs a Node shebang`);
      }
    }
  }
}

for (const source of walk(repositoryRoot)) {
  const path = relative(repositoryRoot, source);
  if (
    path === "scripts/check-release.mjs" ||
    path.startsWith("node_modules/") ||
    path.startsWith("receipts/") ||
    path.startsWith(".git/") ||
    path.includes("/dist/") ||
    path.startsWith("apps/host/") ||
    path.startsWith("packages/host-core/") ||
    archivedProtocolV2Tests.has(path)
  ) continue;
  if (![".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".yml", ".yaml"].includes(extname(source))) continue;
  const contents = readFileSync(source, "utf8");
  assert(!contents.includes("@agent-multiplex/"), `${path}: stale @agent-multiplex package scope`);
  assert(!contents.includes('"@p2prpc/core"'), `${path}: stale @p2prpc/core package name`);
  assert(
    !/@arduano\/agent-multiplex-(?:host|host-core|worker-core)(?:["'/]|$)/.test(contents),
    `${path}: references a nonexistent protocol-v2 compatibility package`,
  );
}

const generatedRoot = resolve(repositoryRoot, "packages/adapter-codex/src/generated");
for (const source of walk(generatedRoot)) {
  if (extname(source) !== ".ts") continue;
  const contents = readFileSync(source, "utf8");
  for (const match of contents.matchAll(/\bfrom\s+["'](\.\.?\/[^"']+)["']/g)) {
    assert(/\.(?:js|json|node)$/.test(match[1]), `${relative(repositoryRoot, source)}: extensionless ESM import ${match[1]}`);
  }
}

const lockfile = readJson("package-lock.json");
assert(lockfile.lockfileVersion === 3, "package-lock.json must use format 3");
const serializedLock = JSON.stringify(lockfile);
assert(!serializedLock.includes("@agent-multiplex/"), "lockfile contains the old package scope");
assert(!serializedLock.includes('"@p2prpc/core"'), "lockfile contains the old p2prpc name");
assert(!serializedLock.includes("file:../../../p2prpc"), "lockfile contains a local p2prpc dependency");

console.log(`Release metadata is valid for ${releasePackages.length} packages at ${releaseVersion}.`);

function packageTargets(manifest) {
  const values = new Set();
  for (const value of [manifest.main, manifest.types]) if (typeof value === "string") values.add(value);
  for (const value of Object.values(manifest.bin ?? {})) if (typeof value === "string") values.add(value);
  collectExportTargets(manifest.exports, values);
  return [...values].filter((value) => typeof value === "string" && value.startsWith("./dist/"));
}

function collectExportTargets(value, output) {
  if (typeof value === "string") output.add(value);
  else if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectExportTargets(child, output);
  }
}

function walk(root) {
  if (!existsSync(root)) return [];
  const output = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) output.push(absolute);
    }
  }
  return output;
}

function assertSameSet(left, right, label) {
  assert(Array.isArray(left), `${label}: first value is not an array`);
  const a = [...left].sort();
  const b = [...right].sort();
  assert(JSON.stringify(a) === JSON.stringify(b), `${label} differ:\n${JSON.stringify(a)}\n${JSON.stringify(b)}`);
}
