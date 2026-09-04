import { assert, releaseVersion } from "./release-config.mjs";

const reference = process.env.GITHUB_REF_NAME ?? process.argv[2];
assert(typeof reference === "string" && reference.length > 0, "a Git tag is required");
assert(reference === `v${releaseVersion}`, `tag ${reference} must exactly match v${releaseVersion}`);
console.log(`Tag ${reference} matches all release manifests.`);
