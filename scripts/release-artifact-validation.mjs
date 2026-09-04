import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, resolve } from "node:path";

import {
  assert,
  packageManifest,
  releaseNodeVersion,
  releaseNpmVersion,
  releasePackages,
  releaseVersion,
  requiredPackageNoticePaths,
  repositoryRoot,
} from "./release-config.mjs";

/**
 * Validate the complete, irreversible npm publish input without trusting any
 * digest or package identity recorded in pack-manifest.json.
 */
export function validateReleaseArtifactSet(outputDirectory, options = {}) {
  const directory = resolve(outputDirectory);
  const manifest = parseJsonFile(resolve(directory, "pack-manifest.json"));

  assert(manifest.schemaVersion === 2, "unknown artifact-manifest schema");
  assert(manifest.repository === "arduano/agent-multiplex", "artifact repository differs from source");
  assert(manifest.version === releaseVersion, "artifact version differs from source");
  assert(
    manifest.toolchain?.node === releaseNodeVersion &&
      manifest.toolchain?.npm === releaseNpmVersion,
    "artifact toolchain differs from the pinned release toolchain",
  );
  assert(Array.isArray(manifest.packages), "artifact packages must be an array");
  assert(manifest.packages.length === releasePackages.length, "artifact set is incomplete");

  if (options.requireCurrentCommit !== false) {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
    assert(manifest.commit === commit, "artifact commit differs from checked-out source");
  } else {
    assert(
      manifest.commit === null || /^[0-9a-f]{40}$/.test(manifest.commit),
      "artifact commit is not a full Git object ID",
    );
  }

  const names = new Set();
  const filenames = new Set();
  const workspaces = new Set();
  for (const artifact of manifest.packages) {
    assert(isPlainObject(artifact), "artifact entry must be an object");
    assert(typeof artifact.name === "string" && !names.has(artifact.name), `duplicate artifact name ${artifact.name}`);
    assert(
      typeof artifact.filename === "string" && !filenames.has(artifact.filename),
      `duplicate artifact filename ${artifact.filename}`,
    );
    assert(
      typeof artifact.workspace === "string" && !workspaces.has(artifact.workspace),
      `duplicate artifact workspace ${artifact.workspace}`,
    );
    names.add(artifact.name);
    filenames.add(artifact.filename);
    workspaces.add(artifact.workspace);
  }

  const artifacts = releasePackages.map((entry) => {
    const artifact = manifest.packages.find(({ name }) => name === entry.name);
    assert(artifact !== undefined, `missing artifact ${entry.name}`);
    assert(artifact.workspace === entry.workspace, `${entry.name}: artifact workspace differs`);
    assert(artifact.version === releaseVersion, `${entry.name}: artifact version differs`);
    const expectedFilename = npmTarballFilename(entry.name, releaseVersion);
    assert(artifact.filename === expectedFilename, `${entry.name}: unexpected artifact filename`);

    const validated = validateArtifactBytes(directory, artifact);
    const packedManifest = readPackedPackageManifest(validated.path);
    assert(
      canonicalJson(packedManifest) === canonicalJson(packageManifest(entry)),
      `${entry.name}: packed package.json differs from checked-out source`,
    );

    const npmMetadata = inspectPackedArtifact(validated.path);
    assert(npmMetadata.name === entry.name, `${entry.name}: npm reports another package name`);
    assert(npmMetadata.version === releaseVersion, `${entry.name}: npm reports another package version`);
    assert(npmMetadata.filename === expectedFilename, `${entry.name}: npm reports another filename`);
    assert(npmMetadata.size === validated.size, `${entry.name}: recorded package size differs`);
    assert(npmMetadata.unpackedSize === artifact.unpackedSize, `${entry.name}: unpacked size differs`);
    assert(npmMetadata.entryCount === artifact.fileCount, `${entry.name}: file count differs`);
    assert(npmMetadata.shasum === validated.shasum, `${entry.name}: npm SHA-1 differs`);
    assert(npmMetadata.integrity === validated.integrity, `${entry.name}: npm integrity differs`);

    const packedPaths = new Set(npmMetadata.files.map(({ path }) => path));
    for (const requiredPath of requiredPackageNoticePaths(entry.workspace)) {
      assert(packedPaths.has(requiredPath), `${entry.name}: package omits ${requiredPath}`);
    }

    return Object.freeze({
      ...artifact,
      ...validated,
      packageJson: Object.freeze(packedManifest),
      files: Object.freeze(npmMetadata.files.map(({ path }) => path)),
    });
  });

  const actualTarballs = readdirSync(directory)
    .filter((filename) => filename.endsWith(".tgz"))
    .sort();
  const expectedTarballs = artifacts.map(({ filename }) => filename).sort();
  assert(
    JSON.stringify(actualTarballs) === JSON.stringify(expectedTarballs),
    `artifact directory has an unexpected tarball set: ${actualTarballs.join(", ")}`,
  );

  const expectedChecksums = `${artifacts
    .map(({ sha256, filename }) => `${sha256}  ${filename}`)
    .join("\n")}\n`;
  const checksums = readFileSync(resolve(directory, "SHA256SUMS"), "utf8");
  assert(checksums === expectedChecksums, "SHA256SUMS differs from independently computed package digests");

  return Object.freeze({
    manifest: Object.freeze(manifest),
    artifacts: Object.freeze(artifacts),
  });
}

/** Re-read and hash one tarball immediately before an irreversible operation. */
export function validateArtifactBytes(outputDirectory, artifact) {
  assert(
    basename(artifact.filename) === artifact.filename && artifact.filename.endsWith(".tgz"),
    `unsafe artifact filename ${artifact.filename}`,
  );
  const path = resolve(outputDirectory, artifact.filename);
  const stat = lstatSync(path);
  assert(stat.isFile() && !stat.isSymbolicLink(), `${artifact.name}: artifact is not a regular file`);
  const bytes = readFileSync(path);
  const actual = {
    path,
    size: bytes.byteLength,
    sha256: digest(bytes, "sha256", "hex"),
    shasum: digest(bytes, "sha1", "hex"),
    integrity: `sha512-${digest(bytes, "sha512", "base64")}`,
  };
  assert(artifact.size === actual.size, `${artifact.name}: tarball size differs from manifest`);
  assert(artifact.sha256 === actual.sha256, `${artifact.name}: tarball SHA-256 differs from manifest`);
  assert(artifact.shasum === actual.shasum, `${artifact.name}: tarball SHA-1 differs from manifest`);
  assert(artifact.integrity === actual.integrity, `${artifact.name}: tarball integrity differs from manifest`);
  return Object.freeze(actual);
}

function readPackedPackageManifest(tarball) {
  const source = execFileSync("tar", ["-xOzf", tarball, "package/package.json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const value = JSON.parse(source);
  assert(isPlainObject(value), `${tarball}: packed package.json is not an object`);
  return value;
}

function inspectPackedArtifact(tarball) {
  const output = execFileSync(
    "npm",
    ["pack", "--json", "--dry-run", "--ignore-scripts", tarball],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const values = JSON.parse(output);
  assert(Array.isArray(values) && values.length === 1, `${tarball}: npm returned unexpected metadata`);
  return values[0];
}

function npmTarballFilename(name, version) {
  return `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
}

function parseJsonFile(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  assert(isPlainObject(value), `${path} must contain a JSON object`);
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(bytes, algorithm, encoding) {
  return createHash(algorithm).update(bytes).digest(encoding);
}
