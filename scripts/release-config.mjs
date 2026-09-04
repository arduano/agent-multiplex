import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function readJson(path) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8"));
}

export const rootManifest = readJson("package.json");
export const releaseConfig = readJson("release-packages.json");
export const releasePackages = Object.freeze(
  releaseConfig.packages.map((entry) => Object.freeze({ ...entry })),
);

export const releaseVersion = rootManifest.version;
export const releaseNodeVersion = readFileSync(
  resolve(repositoryRoot, ".node-version"),
  "utf8",
).trim();
const packageManagerMatch = /^npm@(\d+\.\d+\.\d+)$/.exec(
  rootManifest.packageManager ?? "",
);
assert(packageManagerMatch !== null, "packageManager must pin an exact npm version");
export const releaseNpmVersion = packageManagerMatch[1];
export const releaseDockerBaseImage =
  "node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df";
/** Cross p2prpc's default 15-minute authenticated-session boundary. */
export const releaseNativeMinimumSoakMs = 930_000;
export const githubRegistry = "https://npm.pkg.github.com";
export const repositoryUrl = "git+https://github.com/arduano/agent-multiplex.git";
export const homepageUrl = "https://github.com/arduano/agent-multiplex#readme";
export const bugsUrl = "https://github.com/arduano/agent-multiplex/issues";

export function packageManifest(entry) {
  return readJson(`${entry.workspace}/package.json`);
}

export function requiredPackageNoticePaths(workspace) {
  if (workspace === "apps/web") {
    return [
      "LICENSE",
      "THIRD_PARTY_LICENSES.txt",
      "dist/client/THIRD_PARTY_LICENSES.txt",
    ];
  }
  if (workspace === "packages/adapter-codex") {
    return [
      "LICENSE",
      "THIRD_PARTY_NOTICES.md",
      "licenses/OpenAI-Codex-Apache-2.0.txt",
      "licenses/OpenAI-Codex-NOTICE.txt",
    ];
  }
  return [];
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertReleaseToolchain() {
  assert(
    process.version === `v${releaseNodeVersion}`,
    `release packaging requires Node ${releaseNodeVersion}; found ${process.version}`,
  );
  const npmVersion = execFileSync("npm", ["--version"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
  assert(
    npmVersion === releaseNpmVersion,
    `release packaging requires npm ${releaseNpmVersion}; found ${npmVersion}`,
  );
}
