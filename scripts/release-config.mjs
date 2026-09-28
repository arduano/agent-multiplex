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
/**
 * The owner authorized a five-minute soak for the 0.2.1 Windows patch only.
 * It does not qualify p2prpc's 15-minute authenticated-session renewal boundary.
 * All other releases retain the full renewal qualification minimum.
 */
export const releaseNativeMinimumSoakMs = releaseVersion === "0.2.1" ? 300_000 : 930_000;
export const githubRegistry = "https://npm.pkg.github.com";
export const repositoryUrl = "git+https://github.com/arduano/agent-multiplex.git";
export const homepageUrl = "https://github.com/arduano/agent-multiplex#readme";
export const bugsUrl = "https://github.com/arduano/agent-multiplex/issues";

const irohRelease = "https://github.com/arduano/iroh-http/releases/download/leo-v6-iroh-0.6.2-d799fa3/";
export const reviewedIrohClosure = Object.freeze([
  Object.freeze({
    name: "@momics/iroh-http-node",
    url: `${irohRelease}iroh-http-node-0.6.2-fork-linux-win-x64.tgz`,
    integrity: "sha512-CPRn15sDElYcARIbGcdJJtQj1jH9er3ytl7xkXqUSSk6GjsL8xwLrrGKi2izP58XZMjkCQKJA7xi7Be2Z8Q99Q==",
  }),
  Object.freeze({
    name: "@momics/iroh-http-shared",
    url: `${irohRelease}iroh-http-shared-0.6.2-fork.tgz`,
    integrity: "sha512-LI6vNhKQQZBJV+pC3w/yNxXQoP+pMpmYVHrOo9Y3IHFbMnvkWhV1qzArOn34lQ8JU/pbEMdHVHgZYwmTFnDIDQ==",
  }),
]);
export const reviewedKoffi = Object.freeze({
  version: "3.2.1",
  integrity: "sha512-0qE3lZ8jllRqPN4Ob6Ajl7c2bJSJDhQWuKLGP5hIEpHLllJWv1ydHFMhHmHc5p/W9GticKVDbYzZd7TBoQ4CZg==",
});

export function assertReviewedIrohManifest(manifest) {
  for (const { name, url } of reviewedIrohClosure) {
    assert(manifest.dependencies?.[name] === url, `root must pin the reviewed ${name} URL`);
    assert(manifest.overrides?.[name] === `$${name}`, `root must override transitive ${name}`);
  }
}

export function assertReviewedIrohLock(lock) {
  assert(lock.lockfileVersion === 3, "consumer lock must use format 3");
  assert(lock.packages && typeof lock.packages === "object", "consumer lock has no packages");
  for (const { name, url, integrity } of reviewedIrohClosure) {
    assert(lock.packages?.[""]?.dependencies?.[name] === url, `consumer lock root differs for ${name}`);
    const path = `node_modules/${name}`;
    const expected = lock.packages?.[path];
    assert(expected?.version === "0.6.2" && expected.resolved === url && expected.integrity === integrity,
      `consumer lock differs from reviewed ${name}`);
    for (const [nestedPath, nested] of Object.entries(lock.packages)) {
      if (nestedPath !== path && nestedPath.endsWith(`/${path}`)) {
        assert(nested.version === expected.version && nested.resolved === url && nested.integrity === integrity,
          `nested consumer ${name} differs from reviewed fork`);
      }
    }
  }
}

export function assertReviewedKoffiLock(lock) {
  const root = readJson("package-lock.json").packages?.["node_modules/koffi"];
  assert(root?.version === reviewedKoffi.version && root.integrity === reviewedKoffi.integrity,
    "root koffi differs from reviewed lock");
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "node_modules/koffi" || path.endsWith("/node_modules/koffi")) {
      assert(entry.version === reviewedKoffi.version && entry.integrity === reviewedKoffi.integrity,
        "isolated consumer koffi differs from reviewed lock");
    }
  }
}

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
