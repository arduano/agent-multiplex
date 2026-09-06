# Releases and compatibility

Protocol v5 is the coordinated `v0.2.0` package boundary. Its signed source passed
the exact-commit qualification gates and publication completed successfully.
Protocol v5 peers must not be mixed with v4 or earlier peers. A release identity
is the exact Git tag, source commit, package manifest, and recorded artifact
digests.

[Current state](Current-State.md#release-and-compatibility-baseline) owns the
current publication state. The [checkpoint](../checkpoint-v4.md#protocol-v5-release-qualification-2026-09-05)
owns immutable source/tag identities, workflow results, receipt digests, and
artifact verification. Historical `v0.1.0` evidence is retained separately there.

The public graph contains 16 packages under `@arduano/agent-multiplex-*` and
pins `@arduano/p2prpc-core@0.2.1` exactly. GitHub Packages requires
authentication even for public installs. Local readers need a classic token
with `read:packages`. This repository's CI and Dependabot use the
`PACKAGES_READ_TOKEN` secret because their repository-scoped tokens do not
implicitly receive access to the independently published p2prpc package.

## Versioning rules

- A wire-incompatible schema, authority rule, operation identity, or stream
  semantic requires a new protocol version.
- A launch profile changes compatibility when provider ID, profile ID, contract
  version, or canonical request-schema hash changes.
- A provider implementation change records a new implementation version and
  must preserve or explicitly reject recovery of pending prior work.
- SQLite migrations are immutable append-only identities; never edit a released
  row name or body.
- Codex and Copilot pins are qualification boundaries even when Multiplex's wire
  protocol is unchanged.

## Candidate checklist

1. Release and qualify any required p2prpc change first. Confirm the exact
   `@arduano/p2prpc-core` version exists and grants this repository read access.
2. Use the exact release toolchain recorded by the repository: Node
   `24.19.0` from `.node-version` and npm `11.17.0` from `packageManager`.
   Runtime packages support the wider `>=24.0.0` engine range, but only this
   exact pair is permitted to create release artifacts. CI, Docker
   qualification, and publication install and verify the same pair.
3. Start from an identifiable clean source tree and regenerate Codex protocol
   bindings; require a byte-identical tree unless the pin intentionally
   changed.
4. Review dependency licenses and update `THIRD_PARTY_NOTICES.md`. The web
   build regenerates `apps/web/THIRD_PARTY_LICENSES.txt` from the exact browser
   bundle; `check:release --artifacts` fails if that shipped notice is stale.
   The Codex adapter separately ships its pinned generated-schema attribution,
   Apache-2.0 license, and upstream NOTICE.
5. Run:

   ```bash
   npm ls --workspaces --depth=0
   npm ci --strict-allow-scripts
   npm run check:docs
   npm run check:release
   npm run typecheck
   npm test
   npm run check:checkpoint
   npm audit --audit-level=high
   ```

6. Run deterministic current-source tree and 100-session mock qualifications.
7. After the candidate is merged, check out a clean `main` that exactly equals
   `origin/main`, then run the real four-container Codex/Copilot qualification.
   The runner records that exact commit in the receipt and refuses a dirty
   worktree. Normally run the 930-second soak for retained deployment upgrades.
   The owner authorized a **300-second soak for `0.2.1` only** to unblock
   Windows installation, with subsequent laptop UAT. This patch qualification
   does not cross or requalify p2prpc's 15-minute authenticated-session renewal
   boundary; later versions retain the 930-second release minimum.
8. Independently validate the successful receipt and record the owner-attested
   exact-commit status consumed by publication:

   ```bash
   # 0.2.1 only; use 930000 for other releases.
   AGENT_MULTIPLEX_LIVE_SOAK_MS=300000 \
     npm run test:docker:v4:live:four
   npm run release:native-status -- \
     receipts/protocol-v4-live-four-container/<successful-run-id>
   ```

   Add `--check-only` to validate without writing GitHub state. The recorder
   requires clean exact `origin/main`, snapshots and rehashes the complete
   receipt inventory, checks topology, native controls, cleanup, secret
   isolation, Node, protocol, the locked p2prpc identity, and a completed soak
   of at least 930 seconds, except for the explicit 300-second `0.2.1` policy
   in `scripts/release-config.mjs`. Other shorter runs cannot authorize a
   release. The recorder requires `gh` to be logged in as the repository
   owner's numeric GitHub identity before it creates the success status. The
   permanent status description records the run ID and SHA-256 of
   `SHA256SUMS`, so it can be correlated with the retained local receipt without
   publishing credential-adjacent test evidence.
9. Scan successful and failed receipts for raw tickets, bearer/shared secrets,
   terminal lease secrets, provider keys/endpoints, auth homes, and URL tokens.
10. Record exact source/p2prpc digests, Node/Docker/native versions, topology,
   checks, limitations, cleanup, and SHA-256 inventory.
11. Build the distributable once from that candidate and validate those exact
   bytes:

   ```bash
   npm run build
   npm run release:pack
   npm run release:verify
   npm run release:sbom
   npm run check:secrets
   ```

   `release:pack` requires a clean Git worktree, writes one tarball per package,
   and writes artifact-manifest schema v2. The manifest binds the source commit,
   exact Node/npm pair, package/workspace/filename set, sizes, SHA-1, SHA-256,
   and SHA-512 npm integrity. `SHA256SUMS` is derived from the same bytes.

   `release:verify` independently recomputes those values and checks each of the
   16 packages in a separate role-scoped consumer containing only that package
   and its declared transitive package dependencies. It runs publint, Are the
   Types Wrong, JavaScript import and TypeScript declaration checks, the public
   browser bundle check where applicable, and every packaged executable's
   help/version path. It deliberately does not install one complete workspace
   graph that could hide a missing published dependency.

   `release:sbom` creates a reproducible CycloneDX 1.6 release-build inventory.
   It conservatively includes the complete locked build graph because the web
   tarball contains precompiled code, CSS, and fonts from development-time
   packages that a production-only npm dependency walk cannot see. The command
   fails unless all 16 published packages and every component discovered in the
   compiled web source maps/assets occur in the SBOM. Presence in this
   release-build inventory does not mean a package is installed downstream.

## Tag and publication flow

All workspace versions move together and must exactly match the root version.
Create `v<version>` only on `main`, after main-branch CI, CodeQL's push run, the
deterministic Docker qualification workflow, and the owner-recorded native
four-container qualification have succeeded for that exact commit.
Publication asks the Actions API for the tag commit directly and revalidates
each selected run, so a newer success cannot accidentally qualify an older tag.
Derive the tag from the already-reviewed lockstep root version and validate it
locally before creating it.

Release tags must be annotated and SSH-signed by a key listed in
`.github/release-signers`. Configure Git's SSH signing once, then create and
locally verify the tag without moving it afterward:

```bash
release_tag="v$(jq -r '.version' package.json)"
npm run check:tag -- "$release_tag"
git config gpg.format ssh
git config user.signingkey /absolute/path/to/release-signing-key.pub
git tag -s "$release_tag" -m "Agent Multiplex $release_tag"
git -c gpg.ssh.allowedSignersFile=.github/release-signers \
  verify-tag "$release_tag"
test "$(git rev-parse "$release_tag^{}")" = "$(git rev-parse HEAD)"
git push origin "$release_tag"
```

The workflow rejects lightweight tags, invalid or unlisted signatures, tags
which peel anywhere except the workflow commit, non-`main` ancestry, or a tag
commit without all three exact-SHA prerequisite runs. Do not create the tag on a
candidate branch in the hope that later merging will qualify it.

Pushing the tag runs the publication workflow. It rechecks the signature,
main ancestry, exact CI/CodeQL/deterministic-qualification SHAs, and the latest
owner-created native qualification status for that SHA, installs with the script
allowlist, rebuilds, packs and verifies one artifact set, generates a CycloneDX
SBOM, scans source for high-confidence credentials, and attests every tarball.
Immediately before the first registry mutation it independently validates the
complete package set; it also rehashes each tarball at its individual publish
and promotion boundaries. It publishes all packages under `next`, verifies
their registry integrities, and only then promotes the whole set to `latest`.
Prereleases remain on `next`. Rerunning an older stable tag verifies its bytes
without moving `latest` backward; a mixed newer/older `latest` state fails
closed instead of guessing how to repair it. npm applies dist-tag changes one
package at a time, so consumers should pin exact versions during a promotion;
an interruption can temporarily leave mixed `latest` selectors until the
idempotent recovery pass completes.
It then verifies each registry package in the same separate role-scoped
consumer, reruns JavaScript, TypeScript, browser, and executable smoke tests,
and requires public visibility for every package before creating the GitHub
Release. An interrupted run is safe to rerun: existing versions must have the
candidate's exact integrity or publication fails closed.

GitHub may require the owner to make newly created packages public in package
settings on their first publication. If the visibility gate stops the run,
change every package listed by the error to public and rerun the workflow for
the same tag. Recovery verifies each immutable registry integrity instead of
attempting to publish that version again.

If a defect in an already-tagged publication workflow leaves every stable
package intact under `next` but prevents the complete `latest` promotion, run the
default-branch **Recover exact release dist-tags** workflow with the existing
signed `vMAJOR.MINOR.PATCH` tag and the numeric ID of its retained release
evidence artifact. The artifact ID avoids ambiguity between rerun artifacts
with the same display name. This is a deliberately narrower escape hatch: it
requires the artifact to belong to the completed tag-push publication run,
matches its manifest and every tarball to the signed source, then requires every
exact registry SHA-512 and `next` selector to match before changing any package.
It refuses prerelease tags and refuses to move `latest` backward. An interrupted
per-package promotion may be temporarily mixed but is idempotently recoverable;
the final pass requires both `next` and `latest` to select the exact version for
the complete manifest. The workflow never moves or recreates a tag and contains
no package publication path.

The GitHub Release keeps the tarballs, checksums, package manifest, SBOM, and
publication receipt together. A rerun validates an existing release before
adding any missing assets; it never replaces established public bytes. The
publication receipt is deterministic for the source commit and registry
integrities. Recovery then downloads every asset and compares it byte-for-byte
with the verified candidate. All release commands name the repository explicitly
so recovery does not depend on a checkout-derived CLI context.
Public visibility does not remove GitHub npm's token requirement. Give
downstream Actions repositories explicit package access, or provide a
least-privilege classic PAT with `read:packages`.

## Verify downloaded release bytes

Treat a GitHub Release as a convenience distribution of the workflow's exact
artifacts, not as a substitute for verification. With an authenticated GitHub
CLI, download one tag, check every published tarball against the release
inventory, and verify GitHub's cryptographically signed build-provenance
attestation for each tarball:

```bash
release_dir="$(mktemp -d)"
gh release download v0.2.0 \
  --repo arduano/agent-multiplex \
  --dir "$release_dir"
(
  cd "$release_dir"
  sha256sum --check SHA256SUMS
)
for artifact in "$release_dir"/*.tgz; do
  gh attestation verify "$artifact" \
    --repo arduano/agent-multiplex
done
```

`pack-manifest.json` additionally records each npm SHA-512 integrity. A
downstream automation that consumes GitHub Packages should pin the exact
version, keep a least-privilege `read:packages` token outside source, and may
compare `npm view <package>@0.2.0 dist.integrity` with that manifest before
installing. Never copy the token into a URL, lockfile, receipt, or release asset.

## Qualification evidence

Use the [checkpoint](../checkpoint-v4.md) for current and historical run
identities and outcomes. The exact-source native release receipt must pass its
independent recorder before publication; a successful deterministic or offline
native test does not substitute for that gate. Conversely, the ordinary native
release suite does not claim checks absent from its recorded scope, such as a
new external-model image-prompt trial.

## What the evidence does not prove

- Public multi-tenant isolation or an organizational identity provider.
- Capacity for 100 real model processes; mock scale measures the control path.
- Runtime or live-session migration between machines.
- Arbitrary platform support beyond the qualified Linux Docker environment.
- Stability of future Codex app-server or hidden Copilot UI-server interfaces.
- Correctness of a bespoke launch provider that has not run its own crash,
  cleanup, and end-to-end qualification.

Keep failed receipt directories as diagnostics, but never cite them as release
evidence. A passing old receipt does not qualify changed source or dependencies.
The complete `receipts/` tree is intentionally gitignored because even scrubbed
native-run material is operationally sensitive and bulky. A fresh clone will
not contain these paths; use the tracked checkpoint, immutable commit status,
workflow links, Release assets, and recorded inventory digest for portable
evidence.
