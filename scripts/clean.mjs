import { readFileSync, rmSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
);

if (manifest.name !== "agent-multiplex" || !Array.isArray(manifest.workspaces)) {
  throw new Error("refusing to clean outside the agent-multiplex workspace root");
}

const archivedWorkspaces = ["apps/host", "packages/host-core"];
const workspacePaths = [...manifest.workspaces, ...archivedWorkspaces];

for (const workspacePath of workspacePaths) {
  if (!/^(apps|packages)\/[^/]+$/.test(workspacePath)) {
    throw new Error(`refusing unsafe workspace path ${JSON.stringify(workspacePath)}`);
  }
  const outputPath = resolve(repositoryRoot, workspacePath, "dist");
  const repositoryRelative = relative(repositoryRoot, outputPath);
  if (repositoryRelative !== `${workspacePath}/dist`) {
    throw new Error(`refusing unsafe output path ${JSON.stringify(outputPath)}`);
  }
  rmSync(outputPath, { recursive: true, force: true });
  rmSync(resolve(repositoryRoot, workspacePath, ".tsbuildinfo"), { force: true });
}

console.log(
  `Removed generated output for ${manifest.workspaces.length} active workspaces and ${archivedWorkspaces.length} archived v2 workspaces.`,
);
