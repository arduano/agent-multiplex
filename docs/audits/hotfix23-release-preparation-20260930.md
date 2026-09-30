# Hotfix.23 B1/B12 release qualification and staging boundary

This record qualifies a new **unpublished** coordinated package graph. Publication
and consumer staging are owned by Leo's release operator; no installed service
or owner session was changed by these framework checks.

## Source and change scope

The 16-package graph moves together to `0.2.4-hotfix.23`. Exact artifact source:
`a36c000814c344fce1d5ad3d45ed344c6d0a79cc`, isolated branch
`qualify/release-hotfix23-20260930`. Compared with
`df7c93dffbba0859dd57884f638d0feb16de2c6e`, all tracked changes are the
version replacement in root/16 package manifests, their internal edges and the
lockfile. An exact byte assertion checked the complete 18-file diff. Functional
code, external dependencies, native transport pins, protocol version, released
profile hashes, migration bodies and public lifecycle schemas were untouched by
this release preparation.

Relative to the published `.22` artifact source, this candidate includes:

- Sanitized definitive child errors across isolated authority worker IPC,
  preserving truly uncertain mutation outcomes.
- Canonical archived-session events when Root imports a child Archive,
  refreshing warm Gateway projections without inferring Archive in the Gateway.
- Exact canonical metadata bootstrap for retained native bindings omitted by
  discovery, preserving native availability and using the current Root authority.
- Fixed private payload-validation categories on the native-gap logging hook.
  No diagnostic field is added to persisted/public lifecycle objects.

The original owner's Copilot stall trigger remains unproven. Synthetic overflow
reproduction explains a possible admission failure and improves future logging;
it does not fix oversized native events or claim a recovered native history.

## Exact source and package evidence

Node **24.19.0** / npm **11.17.0** passed:

- Offline strict `npm ci` and the 16-workspace dependency graph.
- Typecheck, production pretest build, **1,162 tests / 124 files**, all passing,
  posttest/checkpoint, docs/release metadata and secret checks.
- One clean pack of all 16 modules; all 16 role-isolated consumers; **11
  packaged B1 regressions**; CycloneDX 1.6 SBOM with **506 components** and
  all **125 web-bundled identities**.

Local receipts and hashes:

| Receipt or artifact | SHA-256 |
| --- | --- |
| `receipts/hotfix23-source-20260930/summary.json` | `1cf9ac888a265922e58a909679d6dca6dc16f9816e8bf45f6afece9e495bd461` |
| `receipts/hotfix23-packed-20260930/summary.json` | `74dfb4d9eafb5a9c2b8ef2003d0f0ef6b35a688c674cccb171220b4c143fdfdd` |
| `receipts/hotfix23-docker-20260930-2/summary.json` | `d2bb97e6f17457ae3f05050fa210bdf9ec0beec1a7ffb97f6f93aa88335c5b08` |
| `receipts/hotfix23-docker-20260930-2/independent-inventory-verification.json` | `1b525728d10e19e35d2a6c61b2f2679391e340e3a3fa395b6abb2ddcc66f6b97` |
| `release-artifacts/pack-manifest.json` | `f2b8726b7a5b42aff3e02fdc510136f2468ccbe198364cdb371aefb23f095286` |
| `release-artifacts/SHA256SUMS` | `612ed0504c9a2d34dc93efeedd194b410a00240b45f935ef1c80c9080655987d` |
| `release-artifacts/sbom.cdx.json` | `77b507a8ec804c4be11b3e1af302143634f9ef44ca868f1a1563c88edec4df38` |

The receipt directories and release artifacts are local and gitignored. The
complete package SHA-256/SHA-512 inventory remains in the retained artifact
manifest; a fresh clone can use the source-bound facts here and later verified
release assets, rather than assume local receipt files are present.

All qualification used synthetic/disposable state with no model calls or live
service actions. Linux SQLite fixtures used process-only `TMPDIR=/dev/shm` and
one worker; this did not change deployed storage. Broad suites were serialized
with `/tmp/leo-qualification-nas-gates.lock`.

The role-isolated public-transport verifier was copied byte-for-byte from the
reviewed prior receipt: SHA-256
`31b2593ffd60b1f91da78f027e826da29dc945e3f1b4ef21ae5925e944f985af`.
Every consumer asserts the published `p2prpc-core@0.3.0-renewal.1`
URL/version/SHA-512 and reviewed Iroh/Koffi closure under strict script policy.
The B1 packaged helper changes only its output receipt directory, and exercises
11 retained-binding/bootstrap/Archive cases against installed local tarballs.
Registry authentication and a native-model release gate remain unqualified.

Current-source deterministic Docker **tree and 10-runtime/100-session scale
passed**. Each successful receipt contains 48 independently rehashed files;
exact test containers, networks and images were removed. Tree inventory
SHA-256: `5bc8c211a174c348692e105acb4c31630723c2a4e177c0129bb024a2392e77e4`.
Scale inventory SHA-256:
`aa0f38254ba011c74fc3489d2c1695ae074011c6de17de236336c184d377229b`.

The first tree run built and attached its isolated topology but failed browser
capture because its obsolete default Chrome executable was absent. Its original
failed receipt is retained. A new run used the existing supported process-only
`AGENT_MULTIPLEX_CHROME_EXECUTABLE=/run/current-system/sw/bin/chromium`
override (Chromium 152.0.7977.82); source/browser policy was unchanged. The
private fixture subnets `10.203.83.0/24` and `10.203.84.0/24` were independently
checked unused before creation. Read-only tracked `.npmrc` was passed as the
BuildKit secret; no credentials or global npm policy changed. Successful runs:

- `receipts/protocol-v4-control-tree/hotfix23-tree-20260930-2/`.
- `receipts/protocol-v4-mock-docker-scale/hotfix23-scale-20260930-1/`.

These are mocked harness/control-plane qualifications, not native inference,
real-model capacity, installed Linux/Windows acceptance or registry auth proof.

## Safe release and staging procedure

1. Review the retained source/packed/Docker receipts and their independent
   hashes. The existing `.22` assets and branches remain rollback evidence;
   do not overwrite them. The `.23` artifacts were packed once from the clean
   exact source above; use those bytes without rebuilding after review.
2. Recheck that `hotfix-2026-09-30.1` remains an unused remote tag/release.
   It was absent at preparation. Sign and publish only under explicit applicable
   owner release authorization and the prerelease exception in
   [the release guide](../wiki/Releases.md#temporary-urgent-deployment-exception-2026-09-07).
   Hosted CI is intentionally blocked by billing; do not label local evidence a
   hosted CI or native-model success. Publication must bind the signed tag to
   the artifact source, even when later documentation commits exist.
3. Before any upload, verify all 16 tarballs independently against the source
   manifests, recorded sizes, SHA-1/SHA-256 and npm SHA-512. Asset identity is
   the source/version/manifest/byte set, not merely a tag name. Upload missing
   immutable assets only; refuse any existing different bytes.
4. Independently download the resulting complete asset set and compare every
   byte. Then Leo may pin exact **published** URLs/integrities and qualify its
   full consumer graph, Linux Nix closure and protected native Windows payload.
   An unpublished local `file:` graph is acceptable only in disposable package
   qualification and is not a deployment dependency.
5. Stage the final immutable payloads without activating them. Retain stopped
   backups, current installed pins and protected updater receipts for the
   independently operated maintenance window. Windows continues to use installed
   Node and its fixed permanent task; an independent route performs any stop.

No tag, package publication, `latest` promotion, framework-main merge, installed
activation or model qualification was performed by this component lane.

## Preparation diagnostic

`npm version 0.2.4-hotfix.23 --workspaces --include-workspace-root --no-git-tag-version --ignore-scripts`
changed the root/workspace versions, then failed with E401 while resolving old
internal dependency edges against GitHub Packages. The private-registry error
contained no token. Internal edges alone were updated to the new lockstep
version and `npm install --package-lock-only --ignore-scripts --offline --no-audit --no-fund`
regenerated the lock successfully. The exact-diff assertion and offline strict
`npm ci` subsequently passed. The original failure is preserved in the
preparation receipt; no credential/global configuration was changed.
