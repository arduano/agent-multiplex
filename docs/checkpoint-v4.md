# Release qualification checkpoint

Status: signed `v0.2.0` source qualified and published as of 2026-09-05.

This document records release qualification and separately scoped development
evidence. Its filename remains stable for existing links. It is not a second
architecture guide. Start a new development session with
[`wiki/Current-State.md`](wiki/Current-State.md), then use the role-specific
wiki and design documents linked at the end of this page.

## Protocol-v5 release qualification (2026-09-05)

| Evidence | Identity |
| --- | --- |
| Signed annotated tag | `v0.2.0`; tag object `cf4d8a3fa9221587bd96adc058d631e0a7fd4b34` |
| Peeled source commit | `0e043478538a30a0a42fd854f5f5c8a14309cbf0` |
| Wire/package boundary | Protocol `5`; 16 lockstep packages at `0.2.0` |
| CI | [Run `33955393265`](https://github.com/arduano/agent-multiplex/actions/runs/33955393265), passed on the exact source commit |
| CodeQL | [Run `33955393288`](https://github.com/arduano/agent-multiplex/actions/runs/33955393288), passed on the exact source commit |
| Deterministic Docker | [Run `33955393260`](https://github.com/arduano/agent-multiplex/actions/runs/33955393260), passed on the exact source commit |
| Native qualification | Owner-recorded `Agent Multiplex / Native four-container qualification` [success status](https://github.com/arduano/agent-multiplex/commit/0e043478538a30a0a42fd854f5f5c8a14309cbf0) |
| Publication | [Run `33956925510`](https://github.com/arduano/agent-multiplex/actions/runs/33956925510), passed on the exact source commit |
| GitHub Release | [`v0.2.0`](https://github.com/arduano/agent-multiplex/releases/tag/v0.2.0), published 2026-09-05 at 09:09:07 UTC with 21 assets |

The qualifying native receipt is
`receipts/protocol-v4-live-four-container/20260905T084042Z-1429aa03a5d9`.
The historical directory name is retained by the runner; its manifest explicitly
records protocol **5** and the exact source commit above. The requested
930,000 ms soak completed, with fresh post-soak native Codex and Copilot replies.
The independent recorder validated the scrubbed inventory before creating the
owner status. SHA-256 of `SHA256SUMS` is
`79e7bfff5878448ef574f1d888024a8a11a000644eb8cb31bbb9f093a18ee077`.

The run used Node `24.19.0`, Docker Server `29.7.2`, Codex CLI `0.152.0`,
Copilot SDK `1.0.11`, Copilot CLI package `1.0.81`, and exact public
`@arduano/p2prpc-core@0.2.1`; transport/native pins are unchanged. It exercised
the four-container native control, streaming/history, browser, terminal,
metadata, and renewal checks. Cleanup removed the disposable containers,
network, image, relay, and runtime state; no material user data was removed.
The manifest records `credentialMaterialRecorded=false`.

All 16 tarballs packed from this exact source match the consumer's locked
artifact integrities. The publication workflow completed packed-consumer and
registry-consumer verification, package attestation, exact-artifact publication
and `latest` promotion, public-package visibility checks, and exact GitHub
Release creation/recovery. The Release API independently confirms 21 uploaded
assets. These are the `v0.2.0` workflow results; the separate manual
registry/Release byte-equality and provenance audit below belongs to `v0.1.0`.

This release qualification does not erase the narrower outcomes of the earlier
image trials. Those receipts retain their original implementation fingerprints;
the live release suite is not an additional external-model image-prompt suite.
Raw receipt trees remain local and gitignored. The tracked identities, public
workflow links, immutable owner status, and inventory digest form the portable
audit trail.

## Historical v0.1.0 release identity

| Evidence | Identity |
| --- | --- |
| Signed annotated tag | `v0.1.0`; tag object `da9497ed9ae5e020dd51ec21523bf91139f811e7` |
| Peeled source commit | `38236480a88e5a7f350097b1bc43fd9a7674096d` |
| GitHub Release | [`Agent Multiplex v0.1.0`](https://github.com/arduano/agent-multiplex/releases/tag/v0.1.0) |
| Package set | 16 public lockstep `@arduano/agent-multiplex-*` packages at `0.1.0` |
| Release assets | 16 tarballs plus `SHA256SUMS`, pack manifest, publication receipt, visibility note, and CycloneDX SBOM: 21 total |
| Transport dependency | Public `@arduano/p2prpc-core@0.2.1`, exact pin and integrity `sha512-vsSv2Wd8V/X+mykNSXK0Dfc4ygI+DuI6Wjdkmfa4kBm5j/PPkm4ekX0+ngwQeKuQ0DQ9EmmWRlk4RGu45DfD7A==` |
| Release toolchain | Node `24.19.0`, npm `11.17.0` |

This historical release established the protocol-v4 baseline. Its qualification
does not cover protocol-v5 changes. The table above identifies only the immutable
`v0.1.0` release; current qualification is recorded separately above.

### Exact-commit gates

The signed release commit passed all required gates before publication:

- [CI run `33923601798`](https://github.com/arduano/agent-multiplex/actions/runs/33923601798);
- [CodeQL run `33923601886`](https://github.com/arduano/agent-multiplex/actions/runs/33923601886);
- [deterministic Docker qualification run `33923601753`](https://github.com/arduano/agent-multiplex/actions/runs/33923601753);
- owner-recorded `Agent Multiplex / Native four-container qualification`
  status for the same commit;
- [publication run `33925122627`](https://github.com/arduano/agent-multiplex/actions/runs/33925122627),
  completed successfully on attempt 3.

The tagged workflow independently rebuilt the source, typechecked and tested
it, built one complete artifact set, validated every packed consumer, generated
the SBOM, scanned tracked source for credentials, attested every tarball,
reconciled exact registry bytes, installed every package through a clean
registry-backed consumer, required public visibility, created the Release, and
re-downloaded every asset for byte comparison.

The initial publication exposed a registry edge case: a bare-package
`npm view ... dist-tags` query can return empty output when only `next` exists.
The current default-branch recovery workflow instead queries the exact version,
binds a numeric retained artifact to the signed tag-push run, verifies all 16
registry SHA-512 values and `next` selectors before mutation, and then performs
an idempotent `latest` promotion. Recovery run
[`33929719531`](https://github.com/arduano/agent-multiplex/actions/runs/33929719531)
completed successfully. No package was republished and the tag was never moved.

### Retained qualification receipts

These passing local receipts cover distinct boundaries:

- `receipts/protocol-v4-control-tree/20260904T173822Z-c7222b0a5c27` — four
  containers with authority/branch topology, two overlapping gateway sources,
  queued metadata through authority loss, warm descendant failover and recovery,
  and three exact native-delta reconstructions.
- `receipts/protocol-v4-mock-docker-scale/20260904T200448Z-a3183b58086d` — 12
  containers, 10 runtimes, 100 sessions, 100 launches and prompts, 3,600
  contiguous native events, cursor and runtime-partition recovery, three
  fleet-wide metadata CAS rounds, UI checks, and a 15-second soak.
- `receipts/protocol-v4-live-four-container/20260904T220013Z-716384c05b18` —
  exact signed release commit, one control, one gateway, real Codex and Copilot
  runtimes, two sessions, 641 native events, and a requested/performed
  930-second liveness soak.

The live receipt proves:

- native Codex and Copilot launch, streaming, history, and fresh post-renewal
  prompts;
- Codex model persistence across reload, plan mode, a native user question and
  answer, running-command visibility, interruption, and continued structured
  use after closing a stock TUI;
- metadata initialization and UI-originated CAS updates under the sole control
  authority;
- exact raw terminal replay to two viewers, keyboard lease behavior, terminal
  termination without stopping structured chat, and absence of terminal
  canaries from durable surfaces;
- gateway-only publication, bearer enforcement, source/runtime/session
  projection, browser reload and native-history hydration;
- desktop, compact, tablet, phone portrait/landscape layout checks and no
  serious/critical accessibility violations;
- no retained raw credential material.

Its manifest records Node `24.19.0`, Docker Server `29.7.2`, Codex CLI
`0.152.0`, Copilot CLI `1.0.81`, protocol 4, and the exact public p2prpc package
integrity above. The owner status binds the run ID to inventory SHA-256
`62630865b3d3b583c0e954bfe21c879ee1fefcfcb8fc223f59d134065741d849`.

Every cited receipt contains its own manifest and `SHA256SUMS`. Passing receipts
are evidence only for their recorded source, dependency, topology, and checks.
Failed receipt directories remain diagnostics and must never be cited as a
pass. The complete `receipts/` tree is intentionally gitignored, so a fresh
clone cannot inspect these local paths. Portable evidence is the tracked ledger
on this page plus the immutable commit status, linked Actions runs, Release
assets, and recorded inventory digest above.

### Published-artifact verification

The completed `v0.1.0` release was also audited from the consumer side:

- the remote tag object and peeled commit match the locally verified signature;
- exactly 21 uploaded Release assets match GitHub's recorded SHA-256 and size;
- `SHA256SUMS`, the artifact manifest, embedded package manifests, SHA-1,
  SHA-256, and npm SHA-512 integrity all agree for 16 tarballs;
- all 16 GitHub package records are public and linked to this repository;
- both `next` and `latest` selected `0.1.0` for the complete package set at that audit;
- registry downloads are byte-identical to Release tarballs;
- every tarball has SLSA provenance for this repository's `publish.yml`, exact
  tag ref, exact source commit, and a GitHub-hosted runner;
- all 16 packages pass separate registry-only install, import, declaration,
  browser-bundle where applicable, and packaged executable checks.

Repeated tagged workflow attempts produced multiple valid provenance statements
for the same 16 immutable subjects. Verification requires at least one exact
statement per tarball rather than an exact attestation-record count.

The five auxiliary Release assets are protected by GitHub asset digests,
cross-file identities, and workflow re-download comparison; only the tarballs
have cryptographic build-provenance attestations. Repository-level immutable
Release protection is not enabled, so maintainer mutability remains a platform
trust boundary even though the workflow refuses replacement of existing bytes.

## Reproduce repository checks

With Node 24 and authenticated `read:packages` access:

```bash
npm ci --strict-allow-scripts
npm run check:docs
npm run check:release
npm run typecheck
npm test
npm run check:checkpoint
```

Cross-role changes should also run the deterministic suites:

```bash
npm run test:docker:v4:tree
npm run test:docker:v4:mock:scale
```

Native Codex/Copilot, terminal, browser, authentication, or transport-renewal
changes require a clean exact-main live run and spend real model credits:

```bash
AGENT_MULTIPLEX_LIVE_SOAK_MS=930000 \
  npm run test:docker:v4:live:four
npm run release:native-status -- --check-only \
  receipts/protocol-v4-live-four-container/<successful-run-id>
```

Only record the owner commit status after the candidate is merged and every
receipt check passes. Never publish raw tickets, shared secrets, bearers,
terminal lease secrets, provider credentials/endpoints, native auth homes, or
token-bearing browser URLs.

## Evidence limits

This checkpoint does not prove:

- public multi-tenant identity, isolation, or internet-edge hardening;
- capacity for 100 simultaneous real model processes—the scale receipt uses
  deterministic mock agents;
- native stop, resume, or archive in the four-container live run; deterministic
  tests cover those state machines;
- runtime or live-session migration between machines, graceful online control
  detach, or archived-session restore;
- arbitrary platform support beyond the qualified Linux x86-64 container
  environment;
- stability of a future Codex app-server or hidden Copilot UI-server version;
- correctness of a bespoke launch provider without its own crash, cleanup,
  resume/history/archive, and end-to-end qualification.

## Protocol-v5 image development evidence (2026-09-05)

This earlier image-development checkpoint preceded the `0.2.0` release
candidate. Package manifests were still at `0.1.0`; the transport pin was
unchanged. Its tested implementation
fingerprint is `cb7f5bcf3a430239ed812e6290a5da6e43c779a06ab7fc3b55dfb601e9c9b830`;
the lockfile SHA-256 is
`cb245a0d96c784541b8eb73b875a5f8764e78f15eba599ee713a6712cae00903`.
The inventory covers source, configuration, scripts, and tests; documentation is
excluded so this ledger can record the completed run without changing its tested
implementation boundary.

Repository typecheck, all **594 tests in 75 files**, checkpoint, docs, release,
secret scan, and whitespace gates passed. The unchanged sibling transport source
at `6f0bac778d8944e846e50151b5e42a4a7f9982b0` independently passed typecheck and
401 tests; the application still uses public `@arduano/p2prpc-core@0.2.1`.

Passing, scrubbed, checksummed local receipts for this implementation are:

- `receipts/protocol-v5-control-tree/20260905T065907Z-4c489fe35b71`:
  routed multi-chunk transfers and retries, immutable workspace snapshots,
  ancestor failover/recovery, CLI image-only input, Markdown previews, inert SVG
  display/conversion, and image-only browser sending with native history after
  reload. The image viewer stays mounted through native streaming and restores
  focus to its opening button. All six required viewport sizes passed without
  horizontal overflow or serious/critical axe findings; landscape retained
  128 pixels of transcript, and no external image requests occurred.
- `receipts/protocol-v5-mock-docker-scale/20260905T070128Z-169e24fb0b0f`:
  100 sessions on 10 runtimes, 100 overlapping mock turns, exact native streams,
  cursor/network recovery, metadata convergence, and reference dashboard checks.
- `receipts/protocol-v5-images/20260905T070000Z`: source/dependency inventories,
  repository gate logs, linked receipt checksums and image identities, and the
  qualification scope. Implementation files remained unchanged through the final
  checks; the native offline receipt's 1,094 source/dependency files still match.

The final combined `SHA256SUMS` inventory has SHA-256
`79759348344d5193287f4d078f5359802be6105422a4033ea013cd41e8c29b88`.
All 98 linked tree, scale, and offline-native receipt files passed checksum
verification, as did the combined receipt itself.

The complete receipts remain local and gitignored. This tracked ledger retains
the tested fingerprint and outcome for a fresh clone. Earlier failed or
superseded attempts do not replace these passing receipts.

Real image trials consumed exactly four authorized turns per harness. Codex and
Copilot both recognized the synthetic shapes with mixed text/image and image-only
input. Codex passed the targeted native checks. Copilot exposed inline image
bytes in a live `model.messages_snapshot` event; its original aggregate at
`receipts/native-images-2026-09-05-targeted/aggregate.json` remains failed.
Failed Copilot attempts remain diagnostics; the earlier native checks do not
qualify the final source.

The codec fix was subsequently qualified with pinned native Copilot SDK `1.0.11`
and CLI package `1.0.81` against a loopback completion fixture. Receipt
`receipts/copilot-offline-images/2026-09-05T06-43-35-483Z-031529bc`
reproduced the exact event shape, externalized its image bytes, verified all 30
native event envelopes, and retained image references in native and resumed
history. It records source/dependency hashes and verified checksums, with no raw
prompts, endpoints, or auth homes. It used zero external model calls. At that
checkpoint, the source had not been
requalified against external model services after the fixes and that image-trial
allowance was exhausted. A later, separately authorized four-container run
qualified the exact `v0.2.0` source as recorded above; it did not repeat the
external-model image-prompt suite.

## Maintained documentation

- [Current-state handoff](wiki/Current-State.md) — start here in a fresh session.
- [Wiki home](wiki/Home.md) — task-oriented documentation router.
- [Data-role design](design/data-roles-v4.md) — normative authority, topology,
  routing, projection, and persistence rules.
- [Launch-extension design](design/launch-extensions-v4.md) — normative
  gateway-plugin/runtime-provider/backend contract.
- [Deployment runbook](deployment-v4.md) — detailed personal deployment,
  upgrade, and failure behavior.
- [Release guide](wiki/Releases.md) — versioning, publication, recovery, and
  downstream verification procedure.
