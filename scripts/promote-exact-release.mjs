import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const githubRegistry = "https://npm.pkg.github.com";

export async function promoteExactRelease({
  sourceDirectory,
  artifactDirectory,
  tag,
  commit,
  repository,
  registry = githubRegistry,
  environment = process.env,
  spawn = spawnSync,
  wait = (milliseconds) => new Promise((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  }),
}) {
  assert(registry === githubRegistry, `unsupported registry ${registry}`);
  assert(typeof environment.NODE_AUTH_TOKEN === "string" && environment.NODE_AUTH_TOKEN.length > 0,
    "NODE_AUTH_TOKEN is required");
  const version = stableTagVersion(tag);
  assert(/^[0-9a-f]{40}$/.test(commit), "RELEASE_COMMIT must be a full Git object ID");
  assert(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), "invalid RELEASE_REPOSITORY");

  const source = resolve(sourceDirectory);
  const artifactsRoot = resolve(artifactDirectory);
  const checkedOutCommit = runCaptured(
    "git",
    ["rev-parse", "HEAD"],
    { cwd: source, environment, spawn, label: "git rev-parse" },
  ).trim();
  assert(checkedOutCommit === commit, "tagged source checkout differs from the verified tag commit");

  const rootManifest = readJson(resolve(source, "package.json"));
  const releaseConfig = readJson(resolve(source, "release-packages.json"));
  const artifactManifest = readJson(resolve(artifactsRoot, "pack-manifest.json"));
  assert(rootManifest.version === version, "tag differs from the root package version");
  assert(releaseConfig.schemaVersion === 1 && Array.isArray(releaseConfig.packages),
    "unknown release package manifest");
  assert(releaseConfig.packages.length > 0, "release package manifest is empty");
  assert(artifactManifest.schemaVersion === 2, "unknown packed artifact manifest");
  assert(artifactManifest.repository === repository, "packed artifact repository differs");
  assert(artifactManifest.commit === commit, "packed artifact commit differs");
  assert(artifactManifest.version === version, "packed artifact version differs");
  const expectedNode = readFileSync(resolve(source, ".node-version"), "utf8").trim();
  const expectedNpm = /^npm@(\d+\.\d+\.\d+)$/.exec(rootManifest.packageManager ?? "")?.[1];
  assert(
    artifactManifest.toolchain?.node === expectedNode &&
      artifactManifest.toolchain?.npm === expectedNpm,
    "packed artifact toolchain differs from tagged source",
  );
  assert(Array.isArray(artifactManifest.packages), "packed artifact packages must be an array");
  assert(artifactManifest.packages.length === releaseConfig.packages.length,
    "packed artifact set is incomplete");

  const names = new Set();
  const workspaces = new Set();
  const filenames = new Set();
  const artifacts = releaseConfig.packages.map((entry) => {
    assert(isPlainObject(entry), "invalid release package entry");
    assert(
      typeof entry.name === "string" &&
        /^@arduano\/agent-multiplex-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name),
      `release package is outside the Agent Multiplex namespace: ${entry.name}`,
    );
    assert(!names.has(entry.name), `duplicate release package ${entry.name}`);
    assert(typeof entry.workspace === "string" && /^(?:apps|packages)\/[^/]+$/.test(entry.workspace),
      `unsafe release workspace ${entry.workspace}`);
    assert(!workspaces.has(entry.workspace), `duplicate release workspace ${entry.workspace}`);
    names.add(entry.name);
    workspaces.add(entry.workspace);

    const packageManifest = readJson(resolve(source, entry.workspace, "package.json"));
    assert(packageManifest.name === entry.name, `${entry.workspace}: package name differs`);
    assert(packageManifest.version === version, `${entry.name}: package version differs`);
    const matches = artifactManifest.packages.filter((candidate) => candidate?.name === entry.name);
    assert(matches.length === 1, `${entry.name}: expected exactly one packed artifact`);
    const artifact = matches[0];
    assert(artifact.workspace === entry.workspace, `${entry.name}: packed workspace differs`);
    assert(artifact.version === version, `${entry.name}: packed version differs`);
    const expectedFilename = npmTarballFilename(entry.name, version);
    assert(artifact.filename === expectedFilename && basename(artifact.filename) === artifact.filename,
      `${entry.name}: unsafe packed filename`);
    assert(!filenames.has(artifact.filename), `duplicate packed filename ${artifact.filename}`);
    filenames.add(artifact.filename);

    const validated = validateArtifactBytes(artifactsRoot, artifact);
    const packedManifest = JSON.parse(execFileSync(
      "tar",
      ["-xOzf", validated.path, "package/package.json"],
      { cwd: source, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    ));
    assert(canonicalJson(packedManifest) === canonicalJson(packageManifest),
      `${entry.name}: packed package manifest differs from tagged source`);
    return Object.freeze({
      name: entry.name,
      version,
      integrity: artifact.integrity,
      path: validated.path,
    });
  });
  assert(artifactManifest.packages.every((artifact) => names.has(artifact?.name)),
    "packed artifact manifest contains an unexpected package");
  const actualTarballs = readdirSync(artifactsRoot)
    .filter((filename) => filename.endsWith(".tgz"))
    .sort();
  assert(canonicalJson(actualTarballs) === canonicalJson([...filenames].sort()),
    "release evidence contains an unexpected tarball set");

  const expectedChecksums = `${artifactManifest.packages
    .map(({ sha256, filename }) => `${sha256}  ${filename}`)
    .join("\n")}\n`;
  assert(readFileSync(resolve(artifactsRoot, "SHA256SUMS"), "utf8") === expectedChecksums,
    "SHA256SUMS differs from the packed artifact manifest");

  const npmEnvironment = {
    ...environment,
    npm_config_registry: registry,
    npm_config_loglevel: "error",
  };

  // Finish the complete read-only preflight before changing any dist-tag.
  const preflight = artifacts.map((artifact) => {
    const state = readRegistryState(artifact, {
      cwd: source,
      environment: npmEnvironment,
      registry,
      spawn,
    });
    validateRegistryCandidate(artifact, state);
    return Object.freeze({ artifact, state });
  });
  console.log(`Verified exact registry bytes and next tags for ${preflight.length} packages.`);

  for (const { artifact } of preflight) {
    validateArtifactIntegrity(artifact);
    const current = readRegistryState(artifact, {
      cwd: source,
      environment: npmEnvironment,
      registry,
      spawn,
    });
    validateRegistryCandidate(artifact, current);
    if (current.distTags.latest === artifact.version) continue;
    runCaptured(
      "npm",
      [
        "dist-tag",
        "add",
        `${artifact.name}@${artifact.version}`,
        "latest",
        "--registry",
        registry,
      ],
      {
        cwd: source,
        environment: npmEnvironment,
        spawn,
        label: `npm dist-tag add for ${artifact.name}@${artifact.version}`,
      },
    );
  }

  for (const artifact of artifacts) {
    let verified = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const state = readRegistryState(artifact, {
        cwd: source,
        environment: npmEnvironment,
        registry,
        spawn,
      });
      if (
        state.integrity === artifact.integrity &&
        state.distTags.next === artifact.version &&
        state.distTags.latest === artifact.version
      ) {
        verified = true;
        break;
      }
      if (attempt < 5) await wait(Math.min(2 ** attempt, 10) * 1_000);
    }
    assert(verified, `${artifact.name}@${artifact.version}: next/latest verification failed`);
  }
  console.log(`Verified next and latest at ${version} for ${artifacts.length} packages.`);
}

function readRegistryState(artifact, { cwd, environment, registry, spawn }) {
  const packageSpec = `${artifact.name}@${artifact.version}`;
  const output = runCaptured(
    "npm",
    [
      "view",
      packageSpec,
      "dist.integrity",
      "dist-tags",
      "--json",
      "--registry",
      registry,
    ],
    { cwd, environment, spawn, label: `npm view for ${packageSpec}` },
  ).trim();
  assert(output.length > 0, `${packageSpec}: registry returned an empty response`);
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error(`${packageSpec}: registry returned invalid JSON`);
  }
  assert(isPlainObject(value), `${packageSpec}: registry returned an invalid response`);
  assert(typeof value["dist.integrity"] === "string",
    `${packageSpec}: registry omitted dist.integrity`);
  assert(isPlainObject(value["dist-tags"]), `${packageSpec}: registry omitted dist-tags`);
  for (const [name, taggedVersion] of Object.entries(value["dist-tags"])) {
    assert(typeof taggedVersion === "string", `${packageSpec}: invalid ${name} dist-tag`);
    parseSemver(taggedVersion);
  }
  return Object.freeze({
    integrity: value["dist.integrity"],
    distTags: Object.freeze({ ...value["dist-tags"] }),
  });
}

function validateRegistryCandidate(artifact, state) {
  assert(state.integrity === artifact.integrity,
    `${artifact.name}@${artifact.version}: registry SHA-512 integrity differs`);
  assert(state.distTags.next === artifact.version,
    `${artifact.name}@${artifact.version}: next does not select the exact release`);
  const latest = state.distTags.latest;
  if (latest !== undefined) {
    assert(compareSemver(latest, artifact.version) <= 0,
      `${artifact.name}@${artifact.version}: refusing to move latest backward from ${latest}`);
  }
}

function validateArtifactBytes(directory, artifact) {
  assert(typeof artifact.integrity === "string" && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(artifact.integrity),
    `${artifact.name}: invalid packed SHA-512 integrity`);
  assert(typeof artifact.sha256 === "string" && /^[0-9a-f]{64}$/.test(artifact.sha256),
    `${artifact.name}: invalid packed SHA-256`);
  assert(typeof artifact.shasum === "string" && /^[0-9a-f]{40}$/.test(artifact.shasum),
    `${artifact.name}: invalid packed SHA-1`);
  assert(Number.isSafeInteger(artifact.size) && artifact.size > 0,
    `${artifact.name}: invalid packed size`);
  const path = resolve(directory, artifact.filename);
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${artifact.name}: tarball is not a regular file`);
  const bytes = readFileSync(path);
  assert(bytes.byteLength === artifact.size, `${artifact.name}: tarball size differs`);
  assert(`sha512-${createHash("sha512").update(bytes).digest("base64")}` === artifact.integrity,
    `${artifact.name}: tarball SHA-512 differs`);
  assert(createHash("sha256").update(bytes).digest("hex") === artifact.sha256,
    `${artifact.name}: tarball SHA-256 differs`);
  assert(createHash("sha1").update(bytes).digest("hex") === artifact.shasum,
    `${artifact.name}: tarball SHA-1 differs`);
  return Object.freeze({ path });
}

function validateArtifactIntegrity(artifact) {
  const stat = lstatSync(artifact.path);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${artifact.name}: tarball is not a regular file`);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(artifact.path)).digest("base64")}`;
  assert(integrity === artifact.integrity, `${artifact.name}: tarball changed after preflight`);
}

function runCaptured(command, arguments_, { cwd, environment, spawn, label }) {
  const result = spawn(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit status ${result.status ?? "unknown"}`);
  }
  return result.stdout;
}

function stableTagVersion(tag) {
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(tag ?? "");
  assert(match !== null, "RELEASE_TAG must be an exact stable vMAJOR.MINOR.PATCH tag");
  return match[1];
}

export function compareSemver(left, right) {
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
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  assert(match !== null, `invalid semantic version ${version}`);
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function npmTarballFilename(name, version) {
  return `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
}

function readJson(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  assert(isPlainObject(value), `${path}: expected a JSON object`);
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const [sourceDirectory, artifactDirectory] = process.argv.slice(2);
  assert(typeof sourceDirectory === "string" && typeof artifactDirectory === "string",
    "usage: promote-exact-release.mjs <tagged-source> <release-artifacts>");
  await promoteExactRelease({
    sourceDirectory,
    artifactDirectory,
    tag: process.env.RELEASE_TAG,
    commit: process.env.RELEASE_COMMIT,
    repository: process.env.RELEASE_REPOSITORY,
  });
}
