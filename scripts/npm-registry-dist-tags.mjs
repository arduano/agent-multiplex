import { spawnSync } from "node:child_process";

/**
 * Read package-level dist-tags through a version that is already known to
 * exist. GitHub Packages can return exit 0 with empty stdout for a bare
 * package name when the package has `next` but no `latest` tag yet.
 */
export function readRegistryDistTags(
  name,
  version,
  { registry, cwd, environment, spawn = spawnSync },
) {
  const packageSpec = `${name}@${version}`;
  const result = spawn(
    "npm",
    ["view", packageSpec, "dist-tags", "--json", "--registry", registry],
    { cwd, encoding: "utf8", env: environment },
  );
  if (result.status !== 0) {
    throw new Error(
      `npm view failed for ${packageSpec} dist-tags: ${result.stderr.trim()}`,
    );
  }

  const output = result.stdout.trim();
  if (output.length === 0) {
    throw new Error(`${packageSpec}: registry returned empty dist-tags`);
  }

  let value;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `${packageSpec}: registry returned invalid dist-tags JSON: ${error.message}`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${packageSpec}: registry returned invalid dist-tags`);
  }
  return value;
}
