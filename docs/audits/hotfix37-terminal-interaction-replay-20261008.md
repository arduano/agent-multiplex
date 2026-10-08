# Terminal interaction replay repair `.37` — October 8, 2026

Source/disposable acceptance only. Installed personal roles remain `.35`; the
consumer's existing `.36` architecture payloads also reproduce this defect.
No live service, session, authentication, private-state edit or model request
belongs to this repair.

## Defect and maintained contract

A native stopped event advertises `runtimeEpoch:null` before retiring pending
interactions. The original terminal receipt retains its former epoch. Strict
catalog ingestion rejects it; the event pump aborts the shared subscription.
Reconnect publishes current binding snapshots and then the same cached receipt
before native replay. Accepted snapshots reset retry backoff, permitting repeated
250 ms default retries and starving unrelated healthy native sessions.

Runtime `events()` now captures current bindings once and replays only terminal
receipts matching session epoch and harness. Pending mismatches remain visible;
the separate bounded receipt cache preserves original-ID duplicate resolution
without dispatching into a replacement native handle.

Control's authenticated runtime-event ingress consumes obsolete terminal
`stale`/`resolved`/`expired` epoch records as `accepted:true` without publishing or
mutating catalog state, after enrollment/boot, runtime owner and harness checks.
Unknown sessions retain `accepted:false`; pending epoch mismatches and foreign
boot/owner/harness events remain rejected. Direct service/catalog interaction
publication stays strict. No general `FENCED` catch or retry fallback is added.

Six real Runtime/catalog/service/pump integration cases deliberately inject
legacy terminal replay so Runtime filtering cannot hide Control correctness.
They cover Codex and Copilot with native Stop, explicit Stop and replacement
epoch; healthy native replay/live/reconnect delivery advances the exact cursor.
Catalog/feed, launch/archive/command and interaction receipts remain unchanged;
duplicate resolution invokes native work once. Synthetic adapters/transport use
disposable state, not SDK/model or production network acceptance.

## Focused evidence and original failures

Runtime source tests pass 60/60; before correction the targeted baseline retains
six failures and 53 passes. A compiled Runtime pass also passes 60/60.
Control ingress tests pass 22/22. Its final focused combined pass is 114 tests;
the 28 new ingress/pump cases pass, while the exact-base negative control retains
18 expected failures. Checksummed Control receipts are retained privately at
`receipts/stale-interaction-control-ingress-20261008/qualification.json` in its
isolated producer checkout.

Initial pump fixture failures include a terminal-event observer race and read
snapshot timestamps. Waiting for the exact event and comparing catalog values
separately from read timestamps repairs those fixture assertions; production
deadlines/fences are unchanged. The first broad candidate run also retains its
Codex cold-replay test failure: its old assertion required the obsolete replay
being removed. The corrected case still requires the exact stale live event and
orders Resume/native delivery after the stopped snapshot.

Independent review confirms synchronous snapshot/listener capture, authenticated
ingress ordering, strict pending/direct fences and bounded resolution retention.
Archive/captured-snapshot/in-flight-eviction permutations are not exhaustive
qualification claims. The consumer's exact production poisoned interaction and
separate Gateway transport interruptions remain unproved.

The final combined source passes typecheck, production build, **1,654 tests / 150
files** (eight tests/one file skipped), checkpoint/docs/release/secrets checks.
All 99 tests in the four directly affected Runtime/Control/pump/Codex files pass.
All **16** packed packages pass role-isolated consumer qualification with the
exact published transport dependency, including declaration/import/CLI surfaces
and the configured publint/ATTW checks. The release-build SBOM contains **498
components**, verifying all16 packages and125 web-bundled component identities.
The successful typecheck, full/focused test, packed-consumer and SBOM logs,
together with the original broad test failure, are preserved and checksummed in
the consumer's ignored
`receipts/stale-feed37-qualification-20261008/producer-final-gates-a048171/`.
The original failure remains failed; this receipt does not qualify production
network paths or native model behavior.

## Exact published distribution

| Pin | Value |
| --- | --- |
| Framework lockstep | `0.2.4-hotfix.37`, all16 packages |
| Artifact source | `a048171c590c503c957bce15f8812d4c3be1f65e` |
| SSH-signed prerelease | [`owner-candidate-2026-10-08.2`](https://github.com/arduano/agent-multiplex/releases/tag/owner-candidate-2026-10-08.2) |
| Verified signed tag object | `bf64aa302a7895412256417b26e2051b914a6c2c` |
| Pack manifest SHA256 | `778b9b4b343d6c45bdab580ad50c5931bed392f8259dc2ab36b3d5584baf1437` |
| Independent transport | `@arduano/p2prpc-core@0.3.0-renewal.2`, unchanged signed `owner-candidate-2026-10-08.1` URL/SRI |
| Preserved framework main | `c95e5a0483aa2601e101dcfe9b2809d7deba7679` |

The public [pack manifest](https://github.com/arduano/agent-multiplex/releases/download/owner-candidate-2026-10-08.2/pack-manifest.json)
binds all16 tarballs and their SHA256/SRI identities to the artifact source.
The changed ingress/runtime package pins are:

| Package | Published tarball | SRI |
| --- | --- | --- |
| Control core | [control-node-core `.37`](https://github.com/arduano/agent-multiplex/releases/download/owner-candidate-2026-10-08.2/arduano-agent-multiplex-control-node-core-0.2.4-hotfix.37.tgz) | `sha512-8zEJiN7bbqkaLnCUmdHxJT70p45qthG3BWwq1wjTMH4MRYPD8XVOUn5UwflzrqPdDGFPqJLkdd5j3QD2hkcYXg==` |
| Runtime core | [runtime-node-core `.37`](https://github.com/arduano/agent-multiplex/releases/download/owner-candidate-2026-10-08.2/arduano-agent-multiplex-runtime-node-core-0.2.4-hotfix.37.tgz) | `sha512-XLOEkiNm/zoM8g6KjkEHpVFhLCCR0TqHFZxQtMtRRyTTqq65uapBp3C0C0G2K16DVZhF+axd+sJ3sfIgFF3t8A==` |

All **19** anonymously downloaded public assets match the qualified local bytes:
16 tarballs, checksums, manifest and SBOM. Trusted signature verification and
remote tag/source equality pass. GitHub reports platform immutability disabled;
operator procedure freezes this candidate and consumers retain exact URL/SRI
pins. This documentation commit does not change the signed artifact source or
repack its bytes.

The first public verifier completed all19 download comparisons, then failed its
remote-tag assertion because its disposable SHA/ref map was reversed. A separate
corrected verifier checks the retained metadata, downloads, signature and refs;
the original failed receipt is preserved. No publication was replayed.

## Evidence digests

| Evidence | SHA256 |
| --- | --- |
| Public `SHA256SUMS` | `d40b0f00739d9c9a4635cb9bc1a8ab7512c1e3c013d0d88dab2f14a85af7efb9` |
| Public `sbom.cdx.json` | `f400323a8d791e793a71c49fb34fe3f92a98f1e6b2bbcc2ddbcb160de7572169` |
| Final full test log | `d967983e97520baa701d1bb82766f6c5f4a6d200769f5156204ba2d8be661afd` |
| Final 99-case focused log | `d3844a294c18ede55c09ad30ab0d3162985f7b1e05429c214845c963e4c6305f` |
| Packed consumer verifier log | `84037e34075356cf05e897bff94d485b9478b41d5369ca4d78d63942d7e325b8` |
| Retained source/package summary | `dd9709fbe934e4d995e124f3ead2463c1bec11f3bedeb9773fc085c818ac93d9` |
| Public-release inventory | `04adaf735cb3bf5433eacde3d78ecd0ccd540afcc56b72a5be0191e97b5b66f3` |

Public metadata/downloads and the corrected signed-source proof are retained in
the consumer's ignored `receipts/stale-feed37-qualification-20261008/`, including
`public-release37.json`, `public-first-failure.json` and `published37/`.

## Release and installed acceptance

Lockstep package version is `0.2.4-hotfix.37`; independent published transport
remains `0.3.0-renewal.2`. No protocol, durable schema, migration or native SDK/CLI
pin changes are introduced by this narrow repair. Candidate distribution retains
signed source and exact public URL/SRI pins; official hosted CI/main/registry
promotion is separate and its existing gates are not waived.
Hosted CI billing remains blocked by owner decision.

The consumer must rebuild immutable payloads, then qualify installed feeds,
commands and fresh diagnostic append/health during the separately authorized
maintenance window. Fresh historical side-file presence alone cannot establish
current-run diagnostic health. Retain original failed receipts and recovery.
