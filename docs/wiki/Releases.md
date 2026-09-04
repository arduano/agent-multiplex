# Releases and compatibility

Protocol v4 is the maintained network boundary. Protocol-v2 host/worker/Fleet
APIs and protocol-v3 peers are not compatibility aliases. A release identity
is the exact Git tag, source commit, package manifest, and recorded artifact
digests.

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
2. Start from an identifiable clean source tree and regenerate Codex protocol
   bindings; require a byte-identical tree unless
   the pin intentionally changed.
3. Review dependency licenses and update `THIRD_PARTY_NOTICES.md`.
4. Run:

   ```bash
   npm ls --workspaces --depth=0
   npm ci --strict-allow-scripts
   npm run check:docs
   npm run check:release
   npm run typecheck
   npm test
   npm run check:checkpoint
   npm audit --omit=dev --audit-level=high
   ```

5. Run deterministic protocol-v4 tree and 100-session mock qualifications.
6. Run the real four-container Codex/Copilot qualification for native-facing
   changes, and the 930-second soak for retained deployment upgrades.
7. Scan successful and failed receipts for raw tickets, bearer/shared secrets,
   terminal lease secrets, provider keys/endpoints, auth homes, and URL tokens.
8. Record exact source/p2prpc digests, Node/Docker/native versions, topology,
   checks, limitations, cleanup, and SHA-256 inventory.
9. Build the distributable once from that candidate and validate those exact
   bytes:

   ```bash
   npm run build
   npm run release:pack
   npm run release:verify
   npm run release:sbom
   npm run check:secrets
   ```

   `release:pack` requires a clean Git worktree, writes one tarball per package,
   and records SHA-256 plus npm integrity in `release-artifacts/`. Verification
   runs publint, Are the Types Wrong, isolated JavaScript/TypeScript consumers,
   browser bundling, and every packaged executable's help/version path.

## Tag and publication flow

All workspace versions move together and must exactly match the root version.
Create `v<version>` only on `main`, after both main-branch CI and the Docker
qualification workflow have succeeded for that exact commit. Publication asks
the Actions API for the tag SHA directly and revalidates the selected run, so a
newer success cannot accidentally qualify an older tag. Run
`npm run check:tag -- v0.1.0` to validate the name locally.

Pushing the tag runs the publication workflow. It rechecks the main ancestry
and exact qualification SHA, installs with the script allowlist, rebuilds,
packs and verifies one artifact set, generates a CycloneDX SBOM, scans source
for high-confidence credentials, attests every tarball, publishes all packages
under `next`, verifies their registry integrities, and only then promotes the
whole set to `latest`. It then installs the complete graph from the registry in
a fresh consumer, reruns JavaScript, TypeScript, browser, and executable smoke
tests, and requires public visibility for every package before creating the
GitHub Release. An interrupted run is safe to rerun: existing versions must
have the candidate's exact integrity or publication fails closed.

GitHub may require the owner to make newly created packages public in package
settings on their first publication. If the visibility gate stops the run,
change every package listed by the error to public and rerun the workflow for
the same tag. Recovery verifies each immutable registry integrity instead of
attempting to publish that version again.

The GitHub Release keeps the tarballs, checksums, package manifest, SBOM, and
publication receipt together. A rerun validates an existing release before
replacing its assets, then downloads every asset and compares it byte-for-byte
with the verified candidate. All release commands name the repository
explicitly so recovery does not depend on a checkout-derived CLI context.
Public visibility does not remove GitHub npm's token requirement. Give
downstream Actions repositories explicit package access, or provide a
least-privilege classic PAT with `read:packages`.

## Current qualification evidence

As of 2026-09-04, the latest successful protocol-v4 receipts are:

- `receipts/protocol-v4-control-tree/20260904T144640Z-9c986260721b` — four
  containers, authority/branch/warm-source routing, queued metadata, failover and
  recovery.
- `receipts/protocol-v4-mock-docker-scale/20260904T145242Z-888a878a22d5` — 12
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
alone—is required to reproduce that boundary.

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
