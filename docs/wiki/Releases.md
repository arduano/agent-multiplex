# Releases and compatibility

Protocol v4 is the maintained network boundary. Protocol-v2 host/worker/Fleet
APIs and protocol-v3 peers are not compatibility aliases. A release identity
is the exact Git tag, source commit, package manifest, and recorded artifact
digests.

The pre-`0.1.0` protocol-v4 tree is a coordinated release candidate, not a
published compatibility promise. The first immutable `0.1.0` package set and
tag establish the supported v4 wire baseline; do not mix earlier untagged
builds with that release.

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

6. Run deterministic protocol-v4 tree and 100-session mock qualifications.
7. After the candidate is merged, check out a clean `main` that exactly equals
   `origin/main`, then run the real four-container Codex/Copilot qualification.
   The runner records that exact commit in the receipt and refuses a dirty
   worktree. Also run the 930-second soak for retained deployment upgrades.
8. Independently validate the successful receipt and record the owner-attested
   exact-commit status consumed by publication:

   ```bash
   AGENT_MULTIPLEX_LIVE_SOAK_MS=930000 \
     npm run test:docker:v4:live:four
   npm run release:native-status -- \
     receipts/protocol-v4-live-four-container/<successful-run-id>
   ```

   Add `--check-only` to validate without writing GitHub state. The recorder
   requires clean exact `origin/main`, snapshots and rehashes the complete
   receipt inventory, checks topology, native controls, cleanup, secret
   isolation, Node, protocol, the locked p2prpc identity, and a completed soak
   of at least 930 seconds. Shorter ordinary live runs cannot authorize a
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
Run `npm run check:tag -- v0.1.0` to validate the name locally.

Release tags must be annotated and SSH-signed by a key listed in
`.github/release-signers`. Configure Git's SSH signing once, then create and
locally verify the tag without moving it afterward:

```bash
git config gpg.format ssh
git config user.signingkey /absolute/path/to/release-signing-key.pub
git tag -s v0.1.0 -m "Agent Multiplex v0.1.0"
git -c gpg.ssh.allowedSignersFile=.github/release-signers verify-tag v0.1.0
test "$(git rev-parse 'v0.1.0^{}')" = "$(git rev-parse HEAD)"
git push origin v0.1.0
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
gh release download v0.1.0 \
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
compare `npm view <package>@0.1.0 dist.integrity` with that manifest before
installing. Never copy the token into a URL, lockfile, receipt, or release asset.

## Current qualification evidence

As of 2026-09-04, the latest successful protocol-v4 receipts are:

- `receipts/protocol-v4-control-tree/20260904T173822Z-c7222b0a5c27` — four
  containers, authority/branch/warm-source routing, queued metadata, failover and
  recovery.
- `receipts/protocol-v4-mock-docker-scale/20260904T174423Z-849005dd923a` — 12
  containers, 10 runtimes, 100 sessions, 100 launches and sends, 3,600 native
  events, zero gaps/duplicates, partition recovery, CAS, and UI checks.
- `receipts/protocol-v4-live-four-container/20260904T105705Z-ac36786c6521` — one
  control, one gateway, real Codex and Copilot runtimes, 280 native events,
  native history, Codex model/plan/question/interrupt, metadata, terminal, and
  browser checks.

The live receipt records Node `24.20.0`, Codex CLI `0.152.0`, Copilot `1.0.81`,
protocol 4, and p2prpc base revision
`6220c97d2ec5a3fd463c4265d059e4f5896c1ec1` plus a staged-package SHA-256. Its
p2prpc source state was dirty, so the recorded package digest—not the commit
alone—is required to reproduce that boundary. It predates the terminal replay
and browser WebSocket egress hardening in this candidate, so publication is
blocked until a fresh four-container live receipt for the exact merged commit
has been validated and recorded with `release:native-status`.

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
