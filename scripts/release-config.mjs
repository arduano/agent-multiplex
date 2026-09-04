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
export const githubRegistry = "https://npm.pkg.github.com";
export const repositoryUrl = "git+https://github.com/arduano/agent-multiplex.git";
export const homepageUrl = "https://github.com/arduano/agent-multiplex#readme";
export const bugsUrl = "https://github.com/arduano/agent-multiplex/issues";

export function packageManifest(entry) {
  return readJson(`${entry.workspace}/package.json`);
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
