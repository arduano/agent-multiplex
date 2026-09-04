import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { execFileSync } from "node:child_process";

import {
  assert,
  packageManifest,
  releasePackages,
  releaseVersion,
  repositoryRoot,
} from "./release-config.mjs";

const arguments_ = process.argv.slice(2);
const allowDirty = arguments_.includes("--allow-dirty");
const outputArgument = arguments_.find((value) => !value.startsWith("--"));
const outputDirectory = resolve(repositoryRoot, outputArgument ?? "release-artifacts");

if (!allowDirty) {
  const status = execFileSync("git", ["status", "--porcelain=v1"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert(status.trim() === "", "release artifacts require a clean Git worktree");
}

const requiredVersion = process.env.RELEASE_VERSION;
if (requiredVersion !== undefined) {
  assert(
    requiredVersion === releaseVersion || requiredVersion === `v${releaseVersion}`,
    `RELEASE_VERSION ${requiredVersion} differs from ${releaseVersion}`,
  );
}

rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(outputDirectory, { recursive: true });

execFileSync(process.execPath, [
  resolve(repositoryRoot, "scripts/check-release.mjs"),
  "--artifacts",
], { cwd: repositoryRoot, stdio: "inherit" });

let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
} catch {
  if (!allowDirty) throw new Error("release artifacts require Git provenance");
}

const artifacts = [];
for (const entry of releasePackages) {
  const output = execFileSync(
    "npm",
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      outputDirectory,
      "--workspace",
      entry.workspace,
    ],
    { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const packed = JSON.parse(output);
  assert(Array.isArray(packed) && packed.length === 1, `${entry.name}: npm pack returned an unexpected result`);
  const metadata = packed[0];
  assert(metadata.name === entry.name, `${entry.name}: packed name differs`);
  assert(metadata.version === releaseVersion, `${entry.name}: packed version differs`);
  const filename = resolve(outputDirectory, metadata.filename);
  assert(statSync(filename).isFile(), `${entry.name}: tarball was not created`);
  const forbidden = metadata.files.filter(({ path }) =>
    path.endsWith(".tsbuildinfo") ||
    path.includes("/.env") ||
    path.startsWith("receipts/") ||
    path.includes("/receipts/") ||
    path.startsWith("node_modules/") ||
    path.includes(".sqlite") ||
    path.includes(".identity"),
  );
  assert(forbidden.length === 0, `${entry.name}: forbidden package files: ${forbidden.map(({ path }) => path).join(", ")}`);
  const contents = readFileSync(filename);
  artifacts.push({
    workspace: entry.workspace,
    name: entry.name,
    version: releaseVersion,
    filename: basename(filename),
    size: metadata.size,
    unpackedSize: metadata.unpackedSize,
    fileCount: metadata.entryCount,
    shasum: metadata.shasum,
    integrity: metadata.integrity,
    sha256: createHash("sha256").update(contents).digest("hex"),
  });
}

const unexpected = readdirSync(outputDirectory).filter((filename) =>
  filename.endsWith(".tgz") && !artifacts.some((artifact) => artifact.filename === filename),
);
assert(unexpected.length === 0, `unexpected tarballs: ${unexpected.join(", ")}`);

const manifest = {
  schemaVersion: 1,
  repository: "arduano/agent-multiplex",
  commit,
  version: releaseVersion,
  packages: artifacts,
};
writeFileSync(
  resolve(outputDirectory, "pack-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o644 },
);
writeFileSync(
  resolve(outputDirectory, "SHA256SUMS"),
  `${artifacts.map(({ sha256, filename }) => `${sha256}  ${filename}`).join("\n")}\n`,
  { mode: 0o644 },
);

console.log(`Created ${artifacts.length} immutable package artifacts in ${outputDirectory}.`);
