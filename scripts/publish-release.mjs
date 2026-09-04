import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import {
  assert,
  githubRegistry,
  releasePackages,
  releaseVersion,
  repositoryRoot,
} from "./release-config.mjs";

const outputDirectory = resolve(repositoryRoot, process.argv[2] ?? "release-artifacts");
const manifestPath = resolve(outputDirectory, "pack-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const token = process.env.NODE_AUTH_TOKEN;

assert(typeof token === "string" && token.length > 0, "NODE_AUTH_TOKEN is required");
assert(manifest.version === releaseVersion, "artifact and source versions differ");
assert(manifest.packages.length === releasePackages.length, "artifact package set is incomplete");

const environment = {
  ...process.env,
  npm_config_registry: githubRegistry,
  npm_config_loglevel: "notice",
};
const staged = [];

for (const artifact of manifest.packages) {
  const expected = releasePackages.find((entry) => entry.name === artifact.name);
  assert(expected !== undefined, `unexpected artifact ${artifact.name}`);
  const existing = registryIntegrity(artifact.name, artifact.version);
  if (existing !== null) {
    assert(existing === artifact.integrity, `${artifact.name}@${artifact.version} already exists with different bytes`);
    console.log(`Verified existing ${artifact.name}@${artifact.version}.`);
  } else {
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
// integrity. This keeps an interrupted release recoverable without exposing a
// mixed-version latest graph.
for (const artifact of staged) waitForIntegrity(artifact);
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

const report = {
  schemaVersion: 1,
  registry: githubRegistry,
  version: releaseVersion,
  verifiedAt: new Date().toISOString(),
  packages: staged.map(({ name, version, integrity }) => ({ name, version, integrity })),
};
writeFileSync(resolve(outputDirectory, "publication.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Promoted ${staged.length} packages to latest.`);

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
