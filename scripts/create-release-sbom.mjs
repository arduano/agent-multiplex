import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assert,
  assertReleaseToolchain,
  releasePackages,
  releaseVersion,
  repositoryRoot,
} from "./release-config.mjs";
import { validateReleaseArtifactSet } from "./release-artifact-validation.mjs";
import { bundledWebPackageIdentities } from "./web-third-party-licenses.mjs";

const outputDirectory = resolve(
  repositoryRoot,
  process.argv[2] ?? "release-artifacts",
);
const output = resolve(outputDirectory, "sbom.cdx.json");

assertReleaseToolchain();
validateReleaseArtifactSet(outputDirectory);

// This is deliberately a release-build SBOM, not merely `npm --omit=dev`.
// The web package ships precompiled JavaScript, CSS, and fonts whose source
// packages are build-time dependencies and therefore absent from a
// production-only npm tree. Including the complete locked build graph is a
// conservative, mechanically reproducible inventory of both installed runtime
// code and code/assets incorporated into the published tarballs.
execFileSync(
  resolve(repositoryRoot, "node_modules/.bin/cyclonedx-npm"),
  [
    "--output-file", output,
    "--output-format", "JSON",
    "--spec-version", "1.6",
    "--output-reproducible",
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);

const sbom = JSON.parse(readFileSync(output, "utf8"));
assert(sbom.bomFormat === "CycloneDX", "release SBOM is not CycloneDX");
assert(sbom.specVersion === "1.6", "release SBOM uses another spec version");
assert(Array.isArray(sbom.components), "release SBOM has no component inventory");

const identities = new Set(sbom.components.map(componentIdentity));
for (const { name } of releasePackages) {
  assert(
    identities.has(`${name}@${releaseVersion}`),
    `release SBOM omits published package ${name}@${releaseVersion}`,
  );
}

const bundledIdentities = bundledWebPackageIdentities();
for (const identity of bundledIdentities) {
  assert(
    identities.has(identity),
    `release SBOM omits web-bundled component ${identity}`,
  );
}

console.log(
  `Created release-build SBOM with ${sbom.components.length} components; ` +
    `verified all ${releasePackages.length} packages and ` +
    `${bundledIdentities.length} web-bundled component identities.`,
);

function componentIdentity(component) {
  assert(
    component !== null && typeof component === "object" &&
      typeof component.name === "string" &&
      typeof component.version === "string",
    "release SBOM contains a component without an exact npm identity",
  );
  const name = typeof component.group === "string" && component.group.length > 0
    ? `${component.group}/${component.name}`
    : component.name;
  return `${name}@${component.version}`;
}
