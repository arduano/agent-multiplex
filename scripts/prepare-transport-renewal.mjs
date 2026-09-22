import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Develop the independent dependency without editing its checkout or changing
// any release dependency pin. All writes remain in this worktree.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(resolve(root, "transport-candidate/manifest.json"), "utf8"));
const upstream = resolve(process.argv[2] ?? resolve(root, "../p2prpc"));
const patchPath = resolve(root, "transport-candidate", manifest.patch);
const patch = readFileSync(patchPath);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const run = (command, args, cwd, options = {}) => execFileSync(command, args, {
  cwd, stdio: "inherit", ...options,
});
mkdirSync(resolve(root, "receipts/p2prpc-renewal"), { recursive: true });
const source = mkdtempSync(resolve(root, "receipts/p2prpc-renewal/build-"));
const archive = run("git", ["archive", manifest.upstreamCommit], upstream, {
  stdio: "pipe", maxBuffer: 32 * 1024 * 1024,
});
run("tar", ["-x", "-C", source], root, { input: archive, stdio: ["pipe", "inherit", "inherit"] });
run("git", ["init", "--quiet"], source);
run("git", ["apply", "--check", patchPath], source);
run("git", ["apply", patchPath], source);
const candidateManifestPath = resolve(source, "packages/core/package.json");
const candidateManifest = JSON.parse(readFileSync(candidateManifestPath, "utf8"));
if (candidateManifest.version !== manifest.candidateVersion) throw new Error("Candidate version disagrees with patch");
run("npm", ["ci", "--ignore-scripts"], source);
run("npm", ["run", "build"], source);
const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--workspace", "@arduano/p2prpc-core"], source, {
  encoding: "utf8", stdio: "pipe",
}));
const tarball = resolve(source, packed[0].filename);
const artifact = readFileSync(tarball);
copyFileSync(tarball, resolve(root, "transport-candidate/p2prpc-core.tgz"));
writeFileSync(resolve(root, "transport-candidate/artifact.json"), JSON.stringify({
  schemaVersion: 1,
  upstreamCommit: manifest.upstreamCommit,
  patchSha256: digest(patch),
  version: candidateManifest.version,
  sha256: digest(artifact),
  integrity: `sha512-${createHash("sha512").update(artifact).digest("base64")}`,
  renewalContract: manifest.renewalContract,
}, null, 2) + "\n");
run(process.execPath, [resolve(root, "scripts/install-transport-renewal.mjs")], root);
console.log(`Candidate source retained at ${source}; dependency pins unchanged.`);
