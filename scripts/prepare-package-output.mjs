import { chmodSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import {
  packageManifest,
  releasePackages,
  repositoryRoot,
} from "./release-config.mjs";

for (const entry of releasePackages) {
  const buildInfo = resolve(repositoryRoot, entry.workspace, "dist/.tsbuildinfo");
  rmSync(buildInfo, { force: true });
  for (const target of Object.values(packageManifest(entry).bin ?? {})) {
    const executable = resolve(repositoryRoot, entry.workspace, target);
    if (existsSync(executable)) chmodSync(executable, 0o755);
  }
}

console.log(`Prepared build output for ${releasePackages.length} release packages.`);
