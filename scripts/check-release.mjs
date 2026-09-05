import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
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
  releaseDockerBaseImage,
  releaseNativeMinimumSoakMs,
  releaseNodeVersion,
  releaseNpmVersion,
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
assert(/^\d+\.\d+\.\d+$/.test(releaseNodeVersion), ".node-version must be an exact Node version");
assert(rootManifest.packageManager === `npm@${releaseNpmVersion}`, "packageManager must pin npm exactly");
assert(
  rootManifest.scripts?.["release:native-status"] ===
    "node scripts/record-native-qualification.mjs",
  "release:native-status must use the reviewed native qualification recorder",
);
assert(
  new RegExp(`^node:${releaseNodeVersion.replaceAll(".", "\\.")}-[^@]+@sha256:[0-9a-f]{64}$`)
    .test(releaseDockerBaseImage),
  "release Docker base must pin the exact Node version and OCI digest",
);
assert(
  releaseNativeMinimumSoakMs === 930_000,
  "native release qualification must cross the 15-minute authenticated-session boundary",
);

const qualificationDockerfiles = [
  "tests/docker-v3-tree/Dockerfile",
  "tests/docker-mock-scale/Dockerfile",
  "tests/docker-live-four-container/Dockerfile",
];

const nativeStatusContext =
  "Agent Multiplex / Native four-container qualification";
const publishWorkflow = readFileSync(
  resolve(repositoryRoot, ".github/workflows/publish.yml"),
  "utf8",
);
const promotionRecoveryWorkflow = readFileSync(
  resolve(repositoryRoot, ".github/workflows/promote-exact-release.yml"),
  "utf8",
);
const ciWorkflow = readFileSync(
  resolve(repositoryRoot, ".github/workflows/ci.yml"),
  "utf8",
);
assert(
  ciWorkflow.includes("npm audit --audit-level=high") &&
    !ciWorkflow.includes("npm audit --omit=dev"),
  "CI must audit the complete release-build dependency graph",
);
assert(
  /^\s+statuses:\s+read\s*$/m.test(publishWorkflow),
  "publish workflow must be able to read commit statuses",
);
assert(
  publishWorkflow.includes(nativeStatusContext),
  "publish workflow omits the native four-container status gate",
);
assert(
  publishWorkflow.includes('.creator.login == $owner') &&
    publishWorkflow.includes('.creator.id == $ownerId') &&
    publishWorkflow.includes('.url == $statusUrl') &&
    publishWorkflow.includes(
      'test("^PASS [A-Za-z0-9][A-Za-z0-9._-]{0,47} sha256:[0-9a-f]{64}$")',
    ),
  "publish workflow must bind native status to the owner and receipt inventory",
);
assert(
  !publishWorkflow.includes("--clobber"),
  "publish workflow must never overwrite established GitHub Release assets",
);
assert(
  publishWorkflow.includes(
    "all(.assets[].name; . as $name | $expected | index($name) != null)",
  ),
  "release recovery must reject unexpected assets before uploading missing ones",
);
assert(
  /^\s+contents:\s+read\s*$/m.test(promotionRecoveryWorkflow) &&
    /^\s+packages:\s+write\s*$/m.test(promotionRecoveryWorkflow) &&
    !/^\s+(?:actions|attestations|id-token|statuses):\s+write\s*$/m.test(
      promotionRecoveryWorkflow,
    ),
  "dist-tag recovery must retain least-privilege workflow permissions",
);
assert(
  promotionRecoveryWorkflow.includes('test "$GITHUB_REF" = "refs/heads/main"') &&
    promotionRecoveryWorkflow.includes('verify-tag "refs/tags/${RELEASE_TAG}"') &&
    promotionRecoveryWorkflow.includes('git merge-base --is-ancestor "$release_commit" origin/main') &&
    promotionRecoveryWorkflow.includes(
      'env -u GITHUB_REF_NAME node scripts/check-tag-version.mjs "$RELEASE_TAG"',
    ),
  "dist-tag recovery must require a signed stable tag on main",
);
assert(
  promotionRecoveryWorkflow.includes("evidence_artifact_id:") &&
    promotionRecoveryWorkflow.includes(".workflow_run.head_sha == $sha") &&
    promotionRecoveryWorkflow.includes('.path == ".github/workflows/publish.yml"') &&
    promotionRecoveryWorkflow.includes("actions/artifacts/${ARTIFACT_ID}/zip"),
  "dist-tag recovery must bind exact evidence to the tagged publication run",
);
assert(
  promotionRecoveryWorkflow.includes("scripts/promote-exact-release.mjs") &&
    publishWorkflow.includes("group: agent-multiplex-registry-mutation") &&
    promotionRecoveryWorkflow.includes("group: agent-multiplex-registry-mutation") &&
    !/npm\s+(?:publish|unpublish|deprecate)\b/.test(promotionRecoveryWorkflow),
  "dist-tag recovery must share the publish lock and contain no package publication path",
);
const registryPublisher = readFileSync(
  resolve(repositoryRoot, "scripts/publish-release.mjs"),
  "utf8",
);
const artifactCreator = readFileSync(
  resolve(repositoryRoot, "scripts/create-release-artifacts.mjs"),
  "utf8",
);
const nativeQualificationRecorder = readFileSync(
  resolve(repositoryRoot, "scripts/record-native-qualification.mjs"),
  "utf8",
);
assert(
  artifactCreator.includes("outputDirectory === fixedOutputDirectory") &&
    artifactCreator.indexOf("outputDirectory === fixedOutputDirectory") <
      artifactCreator.indexOf("rmSync(outputDirectory"),
  "release artifact deletion must be fenced to the fixed output directory",
);
assert(
  !registryPublisher.includes("new Date") &&
    registryPublisher.includes("sourceCommit: manifest.commit"),
  "publication receipt must be deterministic for the source commit",
);
assert(
  nativeQualificationRecorder.includes(
    "manifest.livenessSoak.requestedMs >= releaseNativeMinimumSoakMs",
  ) &&
    nativeQualificationRecorder.includes(
      "manifest.livenessSoak.performed === true",
    ),
  "native status recorder must require the release liveness soak",
);
const nativeRunner = readFileSync(
  resolve(repositoryRoot, "tests/docker-live-four-container/run.sh"),
  "utf8",
);
assert(
  nativeRunner.includes('sourceCommit:$sourceCommit') &&
    nativeRunner.match(/status --porcelain=v1 --untracked-files=all/g)?.length >= 2 &&
    nativeRunner.includes("COPILOT_CLI_VERSION"),
  "native four-container runner must bind receipts to a clean source commit",
);
for (const path of qualificationDockerfiles) {
  const source = readFileSync(resolve(repositoryRoot, path), "utf8");
  const baseImages = [...source.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1]);
  assert(baseImages.length > 0, `${path}: no Docker base image found`);
  assert(
    baseImages.every((image) => image === releaseDockerBaseImage),
    `${path}: every stage must use the exact release Docker base ${releaseDockerBaseImage}`,
  );
}

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
      if (dependencyField !== "peerDependencies") {
        assert(
          /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(specification),
          `${label}: runtime dependency ${dependency} must use an exact version`,
        );
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
    assertDeclarationDependencies(entry, manifest, label);
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

const webEntry = releasePackages.find(({ workspace }) => workspace === "apps/web");
assert(webEntry !== undefined, "apps/web is missing from the release package set");
const webManifest = packageManifest(webEntry);
const webLicenseFilename = "THIRD_PARTY_LICENSES.txt";
assert(
  webManifest.files.includes(webLicenseFilename),
  `apps/web must package ${webLicenseFilename}`,
);
assert(
  existsSync(resolve(repositoryRoot, "apps/web", webLicenseFilename)),
  `apps/web/${webLicenseFilename} is missing`,
);
const codexEntry = releasePackages.find(
  ({ workspace }) => workspace === "packages/adapter-codex",
);
assert(
  codexEntry !== undefined,
  "packages/adapter-codex is missing from the release package set",
);
const codexManifest = packageManifest(codexEntry);
for (const filename of ["THIRD_PARTY_NOTICES.md", "licenses"]) {
  assert(codexManifest.files.includes(filename), `packages/adapter-codex must package ${filename}`);
  assert(
    existsSync(resolve(repositoryRoot, "packages/adapter-codex", filename)),
    `packages/adapter-codex/${filename} is missing`,
  );
}
for (const [filename, sha256] of Object.entries({
  "OpenAI-Codex-Apache-2.0.txt": "d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc",
  "OpenAI-Codex-NOTICE.txt": "9d71575ecfd9a843fc1677b0efb08053c6ba9fd686a0de1a6f5382fd3c220915",
})) {
  const path = resolve(repositoryRoot, "packages/adapter-codex/licenses", filename);
  assert(
    existsSync(path),
    `packages/adapter-codex/licenses/${filename} is missing`,
  );
  assert(
    createHash("sha256").update(readFileSync(path)).digest("hex") === sha256,
    `packages/adapter-codex/licenses/${filename} differs from OpenAI Codex 0.152.0`,
  );
}

if (requireArtifacts) {
  const { assertWebThirdPartyLicensesCurrent } = await import("./web-third-party-licenses.mjs");
  assertWebThirdPartyLicensesCurrent();
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

function assertDeclarationDependencies(entry, manifest, label) {
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  const declarationRoot = resolve(repositoryRoot, entry.workspace, "dist");
  for (const source of walk(declarationRoot)) {
    if (!source.endsWith(".d.ts")) continue;
    const contents = readFileSync(source, "utf8");
    const specifiers = [
      ...contents.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g),
      ...contents.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      if (
        specifier.startsWith(".") ||
        specifier.startsWith("#") ||
        specifier.startsWith("node:") ||
        builtinModules.includes(specifier)
      ) continue;
      const segments = specifier.split("/");
      const dependency = specifier.startsWith("@")
        ? segments.slice(0, 2).join("/")
        : segments[0];
      if (dependency === manifest.name) continue;
      assert(
        declared.has(dependency),
        `${label}: ${relative(repositoryRoot, source)} references undeclared declaration dependency ${dependency}`,
      );
    }
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
