# Copilot task observation diagnostics hotfix.30 — October 4, 2026

Published immutable signed [GitHub prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-10-04.3), exact artifact source `b5fd14da32fb74ebe2a828429e6975047f4b7d71`, lockstep `0.2.4-hotfix.30`. The existing owner deployment allowance applies. Published `.29` remains unchanged; no stable npm latest promotion or native/deployed acceptance is claimed.

## Scope and qualification

The diagnostic correction adds fixed current-revision failure reasons and bounded known schema field paths, validation codes and actual value types. Adapter malformed/oversized/wire failures, lifecycle projection rejection and generic native-read failures remain distinct. Stale revisions, retired bindings and generation fences omit new failure metadata. Strict task schemas, genuine uncertainty, retry/watchdog timing, public/persisted shapes, migrations and exact SDK/CLI/transport pins are unchanged. See [the original failed child receipt investigation](copilot-child-task-observation-20261004.md).

Typecheck, **1,412 tests / 137 passing files** (eight tests/one file skipped), build, checkpoint/docs/release/secrets, all **16** role-isolated packed consumers and SBOM generation passed. The reviewed public-transport consumer verifier retains exact URL/version/SRI and reviewed Iroh/Koffi identities, declaration/import/browser/CLI probes. All **19** independently downloaded public assets byte-match the qualified local set. The tag passed the existing fixed trusted-public-key verifier before publication. No model, deployed restart or production fixture was used for these gates.

Consumer logging must explicitly preserve the optional private fields; old records remain supported. The original lost rejected response and historical recurring Copilot cause remain unproved. New native reproduction/capture and sustained production health checks remain consumer-owned; metadata instrumentation alone is not a behavioral repair.

## Evidence digests

| Evidence | SHA-256 |
| --- | --- |
| `SHA256SUMS` | `86056df5d1d833a714513b50123206f4f9a7d1ee31c704615eb8096afbc0b8da` |
| `pack-manifest.json` | `e1b15ec060ae0168d0d1ff45da392b7d1211a0aad9d8c8c4c8d63ffe80bce5dd` |
| `sbom.cdx.json` | `724b41ef07e2a9fc79d10dc98ad2b2a63758c8c6011da2f1ed7d670d68d117b9` |

Private source/package/public-equality receipts are in Leo `receipts/all-backlog-20261004/framework30-gates-*`, `published30-verified-safe.json` and this release worktree's `receipts/all-backlog-20261004/package/`. These source/dependency gates do not reclassify either failed installed `.29` child acceptance. Public tag/artifact bytes are immutable.
