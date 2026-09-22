import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidate = resolve(root, "transport-candidate");
const manifest = JSON.parse(readFileSync(resolve(candidate, "manifest.json"), "utf8"));
const artifact = JSON.parse(readFileSync(resolve(candidate, "artifact.json"), "utf8"));
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const tarball = resolve(candidate, "p2prpc-core.tgz");
if (artifact.upstreamCommit !== manifest.upstreamCommit || artifact.version !== manifest.candidateVersion ||
    artifact.renewalContract !== manifest.renewalContract || artifact.sha256 !== digest(tarball) ||
    artifact.patchSha256 !== digest(resolve(candidate, manifest.patch))) {
  throw new Error("Transport artifact does not match the reviewed source patch; prepare it again");
}
// No npm install or lockfile mutation: replace only the disposable installed
// dependency, rejecting symlinks so another checkout cannot be altered.
const installed = resolve(root, "node_modules/@arduano/p2prpc-core");
for (const path of [resolve(root, "node_modules"), resolve(root, "node_modules/@arduano"), installed]) {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing linked install directory: ${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
// Retain npm's nested dependency installation (notably core's superjson).
rmSync(resolve(installed, "dist"), { recursive: true, force: true });
mkdirSync(installed, { recursive: true });
execFileSync("tar", ["-xzf", tarball, "--strip-components=1", "-C", installed], { stdio: "inherit" });
const { SESSION_RENEWAL_CONTRACT } = await import("@arduano/p2prpc-core");
if (SESSION_RENEWAL_CONTRACT !== manifest.renewalContract) throw new Error("Transport renewal contract mismatch");
console.log(`Installed local transport ${artifact.version}; sha256=${artifact.sha256}`);
