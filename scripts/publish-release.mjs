import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import {
  assert,
  githubRegistry,
  releasePackages,
  releaseVersion,
  repositoryRoot,
} from "./release-config.mjs";
import {
  validateArtifactBytes,
  validateReleaseArtifactSet,
} from "./release-artifact-validation.mjs";
import { readRegistryDistTags } from "./npm-registry-dist-tags.mjs";

const outputDirectory = resolve(repositoryRoot, process.argv[2] ?? "release-artifacts");
const token = process.env.NODE_AUTH_TOKEN;

assert(typeof token === "string" && token.length > 0, "NODE_AUTH_TOKEN is required");
const { manifest, artifacts } = validateReleaseArtifactSet(outputDirectory);

const environment = {
  ...process.env,
  npm_config_registry: githubRegistry,
  npm_config_loglevel: "notice",
};
const staged = [];

for (const artifact of artifacts) {
  // The full set was validated before any registry mutation. Re-read this
  // package immediately before its own publish boundary as a TOCTOU fence.
  validateArtifactBytes(outputDirectory, artifact);
  const expected = releasePackages.find((entry) => entry.name === artifact.name);
  assert(expected !== undefined, `unexpected artifact ${artifact.name}`);
  const existing = registryIntegrity(artifact.name, artifact.version);
  if (existing !== null) {
    assert(existing === artifact.integrity, `${artifact.name}@${artifact.version} already exists with different bytes`);
    console.log(`Verified existing ${artifact.name}@${artifact.version}.`);
  } else {
    validateArtifactBytes(outputDirectory, artifact);
    run("npm", [
      "publish",
      resolve(outputDirectory, artifact.filename),
      "--registry",
      githubRegistry,
      "--tag",
      "next",
      "--access",
      "public",
      "--ignore-scripts",
    ]);
    waitForIntegrity(artifact);
    console.log(`Published ${artifact.name}@${artifact.version} under next.`);
  }
  staged.push(artifact);
}

// Do not move a stable tag until every package exists with the exact candidate
// integrity. This keeps an interrupted release recoverable and prevents any
// latest movement before the complete artifact set is staged. Registry
// dist-tags are still updated one package at a time.
for (const artifact of staged) {
  validateArtifactBytes(outputDirectory, artifact);
  waitForIntegrity(artifact);
}

if (releaseVersion.includes("-")) {
  console.log(`Kept prerelease ${releaseVersion} off the stable latest tag.`);
} else {
  const currentLatest = staged.map((artifact) => ({
    name: artifact.name,
    version: registryDistTags(artifact.name, artifact.version).latest ?? null,
  }));
  const newer = currentLatest.filter(({ version }) =>
    version !== null && compareSemver(version, releaseVersion) > 0
  );
  if (newer.length > 0) {
    const versions = new Set(currentLatest.map(({ version }) => version));
    assert(
      versions.size === 1 &&
        currentLatest.every(({ version }) =>
          version !== null && compareSemver(version, releaseVersion) > 0
        ),
      `refusing to repair latest from a mixed registry state: ${currentLatest
        .map(({ name, version }) => `${name}=${version ?? "missing"}`)
        .join(", ")}`,
    );
    console.log(
      `Preserved newer stable latest ${currentLatest[0].version} while verifying ${releaseVersion}.`,
    );
  } else {
    for (const artifact of staged) {
      run("npm", [
        "dist-tag",
        "add",
        `${artifact.name}@${artifact.version}`,
        "latest",
        "--registry",
        githubRegistry,
      ]);
    }
    console.log(`Promoted ${staged.length} packages to latest.`);
  }
}

const report = {
  schemaVersion: 2,
  repository: manifest.repository,
  sourceCommit: manifest.commit,
  registry: githubRegistry,
  version: releaseVersion,
  packages: staged.map(({ name, version, integrity }) => ({ name, version, integrity })),
};
writeFileSync(resolve(outputDirectory, "publication.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Recorded exact registry identities for ${staged.length} packages.`);

function registryIntegrity(name, version) {
  const result = spawnSync(
    "npm",
    ["view", `${name}@${version}`, "dist.integrity", "--json", "--registry", githubRegistry],
    { cwd: repositoryRoot, encoding: "utf8", env: environment },
  );
  if (result.status === 0) {
    const value = JSON.parse(result.stdout);
    assert(typeof value === "string" && value.startsWith("sha512-"), `${name}: registry returned invalid integrity`);
    return value;
  }
  if (/\bE404\b|404 Not Found/i.test(`${result.stdout}\n${result.stderr}`)) return null;
  throw new Error(`npm view failed for ${name}@${version}: ${result.stderr.trim()}`);
}

function registryDistTags(name, version) {
  const value = readRegistryDistTags(name, version, {
    registry: githubRegistry,
    cwd: repositoryRoot,
    environment,
  });
  for (const [tag, version] of Object.entries(value)) {
    assert(typeof version === "string", `${name}: registry returned invalid ${tag} tag`);
    parseSemver(version);
  }
  return value;
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function parseSemver(version) {
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  assert(match !== null, `registry returned invalid semantic version ${version}`);
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function waitForIntegrity(artifact) {
  let observed = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    observed = registryIntegrity(artifact.name, artifact.version);
    if (observed === artifact.integrity) return;
    if (observed !== null) break;
    execFileSync("sleep", [String(Math.min(2 ** attempt, 20))]);
  }
  throw new Error(`${artifact.name}@${artifact.version} registry integrity mismatch: ${observed ?? "missing"}`);
}

function run(command, arguments_) {
  execFileSync(command, arguments_, {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
  });
}
