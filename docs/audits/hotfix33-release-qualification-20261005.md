# P0 Copilot cause-retention hotfix.33 — October 5, 2026

Published signed [GitHub prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-10-05.3),
exact artifact source `454f044a86c689d0a2af037f2d1fa1571dd34cef`, lockstep
`0.2.4-hotfix.33`. Trusted signature verification and the remote source match
pass for signed tag object `57484bfa943d10abfa91b5d791e337ccee2120f9`.
Publication completed at **2026-10-05 12:14:27 UTC**; public asset verification
completed at **12:16:01 UTC**. Framework `main` remains
`c95e5a0483aa2601e101dcfe9b2809d7deba7679`. No npm stable promotion,
attestation or installed acceptance is claimed.

## Scope and causal limits

Based on published hotfix.32 handoff source
`998128b0a9b00eaeb3c28f304554e79cdcaf16c3`, this release retains one immutable
fixed `lastInvalidatingGap` context per exact Copilot trace binding. Later trace
records retain its strict diagnostic, allowlisted native type, ephemeral flag,
payload-validation stage and wire bounds after recent16 rotation or optional
telemetry omission. Activation reports a fenced prior persisted diagnostic as
`previousBindingGap` before the new epoch replaces the lifecycle row. Attribution
requires matching logical session, runtime node and binding revision; older
boot/epoch is allowed as diagnostic history only. The old diagnostic never
becomes new lifecycle evidence. Synchronous diagnostic collection failures
cannot interrupt native activation or admission.

The release also includes [published .32's correction](hotfix32-release-qualification-20261005.md)
for native requested agent-task `model: null`. It preserves native null without
assigning the parent model. This previously proved admission defect is separate
from the current unproved Tariff interaction-gap cause.

No lifecycle reducer, interaction completeness, admission/recovery policy,
native ownership, wire/durable schema, migration, SDK/CLI or transport pin is
relaxed or changed. Exact binding/revision and genuine interaction-uncertainty
fences remain. Embeddings must explicitly retain the new optional metadata in
protected diagnostics; asynchronous tracing remains bounded and best effort.

The initiating Tariff event and its resumed interaction baseline remain
unproved. An empty permission list, empty queue, completed tasks, root idle or
history cannot certify complete pending-interaction state. The pinned supported
SDK lacks a complete snapshot across question, elicitation and plan requests.
Current callback maps also lack complete retained ownership/event provenance
and native response acknowledgement. The proposed constrained same-handle
recovery design is **not implemented**. P0 recurrence prevention remains open.
See [the investigation and design limits](copilot-gap-interaction-recovery-20261005.md)
and [the lifecycle trace contract](../design/copilot-session-lifecycle-vnext.md#private-incident-trace).

## Qualification and retained failures

Two cause-retention regressions fail against exact base source and pass with
the correction. The isolated producer passes **106 focused tests** including
strict malformed-context omission, previous-binding provenance, synchronous
diagnostic-read isolation and unchanged genuine interaction uncertainty.
Independent review of the final Runtime source and tests found no blocker.

The final coordinated serial gate passes typecheck, **1,451 tests / 138 passing
files** (eight tests/one file skipped), build and checkpoint/docs/release/secrets
checks. All **16** packed packages pass role-isolated consumer qualification,
including published declaration/import/CLI surfaces and the exact reviewed
published transport graph. SBOM generation verifies all 16 packages and 125
web-bundled component identities, producing 498 components.

Earlier results remain separate evidence:

- The isolated producer broad run reports 1,449 passing tests, two existing
  control-test failures and eight skips. Its 13 tests in those two files pass
  on isolated retry. The original failures remain retained.
- The first coordinated broad run was interrupted with exit 130 after two
  payload-gap test failures. Contention was observed but is not a proved cause.
  This receipt is not relabeled as a pass; the successful serial gate is new
  exact-source evidence.
- `npm run release:verify` first failed with transport registry E401. The
  unchanged reviewed verifier from .32 was reused under
  `receipts/p0-copilot33/package/verify-packed-published-transport.mjs` to qualify
  all 16 consumers with the exact published transport URL/integrity. Product
  dependencies and registry policy were not changed.
- The first HTTPS push failed because no username was available. A temporary
  `gh auth git-credential` helper allowed the reviewed push without global
  credential configuration changes.

All **19** independently downloaded public assets match the qualified bytes
and hashes: 16 package tarballs, `SHA256SUMS`, manifest and SBOM. Signed-tag
verification and remote source equality pass. GitHub reports `immutable=false`;
platform immutability is not enforced. Operator procedure freezes the release,
and consumers retain exact URL/SRI/hash pins. This documentation follows in a
separate commit without changing the signed artifact source or repacking bytes.

## Evidence digests

| Evidence | SHA-256 |
| --- | --- |
| `SHA256SUMS` | `b0f440d967222915cd90ed9b3271dbc6834d563a1af153d38066b85d3c121ea4` |
| `pack-manifest.json` | `e12f91977cd8e4610de02313483f2e01885c896288a3c075d90dfb3c8d03e695` |
| `sbom.cdx.json` | `93e5323e8faa40f998a44ac54fb7df8d03c85e48e6bbecd8360d0d6a4bb7ff0e` |
| Local public-release receipt | `eb420f10f090b77832b2564968751a3c40d61c58236d1167fe5527d79c3117f8` |
| Final serial test log | `bb8846e95b60e356e4b2df7a1d14faf810513d77f9a6e76b61a70775626eeb4a` |
| Packed published-transport verifier log | `72bb8660ba3dead64e72d8acccc15cf1d754c15079ea77d2ff15353ef250bfa1` |

The local public inventory and signed-source proof are in Leo's ignored
`receipts/p0-copilot33/public-release33.json`; downloaded assets are retained in
its `published33/` directory. Source/package gate logs remain under
`/tmp/p0-framework33-*`, including the original failed/interrupted logs.
The producer's ignored `receipts/p0-copilot-gap-20261005/` retains exact-base
negative controls and the failed broad/isolated-retry receipts linked in the
investigation audit. Tracked release documents provide the facts needed by a
fresh clone without publishing private receipt contents.

## Remaining acceptance

Native Windows/WSL installation, compact payload sealing and installed
qualification remain consumer-owned. Source and package publication performed
no live role restart, owner-session operation, SDK attachment or real model
call. The separate Windows diagnostic-health private-write correction belongs
to the consumer and is not included in this framework release. Its historical
production failure remains unclassified. Source diagnostics alone do not prove
future native acceptance or close the unresolved interaction-recovery cause.
