# Aggregate reliability hotfix.25 — October 2, 2026

Artifact source is `0057b8ac0241d38bfea45522bec7bf95ba168459`, lockstep
`0.2.4-hotfix.25`, exact Node 24.19.0/npm 11.17.0. SSH-signed immutable
[GitHub prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-10-02.1)
uses the documented urgent hotfix exception; no npm latest or hosted/native-model
qualification claim. Signature and peeled source were independently checked.

## Changes and gates

- B17: exact optional ephemeral messages-snapshot classification, sole
  wire-envelope omission with preserved lifecycle certainty, bounded private
  diagnostic metadata. Genuine uncertainty/pending interactions remain intact.
- B18: remove only succeeded, accepted, completed no-ID legacy admissions from
  pending projection; retain immutable receipts and ambiguous/exact-ID records.
- B16: both harnesses, 18 sessions each, 246 interleaved parent/child events each,
  three reverse-feed and three child reconnects; exact delivery and fences pass.
- Development-only brace-expansion 2.1.4 → 2.1.7 resolves the newly reported high
  advisory. Protocol, migrations, profile and native/transport pins are unchanged.

All exact-source gates passed: strict offline install, typecheck, **1,247 tests**
(127 files; eight tests/one file skipped), build, checkpoint/docs/release/secrets,
high audit threshold and pinned credential-free native loopback fixture.
All **16 role-isolated consumers**, **54 packed regressions** and the
506-component/125-web-component SBOM passed. The public transport verifier
retains exact URL/version/SRI/Iroh/Koffi checks; registry authentication is not
claimed. A first focused pre-build invocation failed package resolution; no test
ran then. The first full gates failed a newly discovered high dev advisory;
production audit had zero vulnerabilities. Both failures remain retained.

Docker tree and 10-runtime/**100-session** scale passed: 100 overlapping complete
turns, **3,600 native events**, exact replay, zero gaps/duplicates and bounded
reconnect/metadata convergence. Owned containers/networks/images were removed;
pre-existing running container identities remained unchanged. One initial scale
readiness connection reset recovered through the existing bounded wait.

The ordinary `check:tag hotfix-2026-10-02.1` checker rejected the exception's
notation because it accepts only `v<version>`. It is retained as a process failure;
separate signature/source/version verification passed, without moving the tag.

## Immutable evidence

| Inventory | SHA-256 |
| --- | --- |
| Published SHA256SUMS | `c546f5963c229476898e3db2134bb20f52342b1dc319c230f11da8a17fbcfda0` |
| pack-manifest.json | `2036b19535f71b4ab19c70072c5ea8b78fcaa196aa777b50e3be6ca365177cef` |
| sbom.cdx.json | `b9ea1fe9d87372e61beb9f9f4ac1191c744033a06722ff00fb185f51cd805b25` |
| Exact source gates | `c9056e7561ce4c55dcb2af014bdaa233dabbcea92bfdb4e092d940745e11f4d9` |
| All 19 independently downloaded assets | `2ab69c38d27509be897ce72b24edb5dc6e2154dc17b032a4e2fbd4148138e8f9` |
| Docker combined proof | `2fe907a4b9522626190e844795ff51ebe3a6b267400fdad22dd362fa92d18839` |
| Tree receipt inventory | `e0e4a77357c46fc48d76d7beeda24c1378b29c0da3afd31cd751143c1fe9e471` |
| Scale receipt inventory | `612f527d77a9e91e6a823adf2249c1b3d4d8a3672b16852c3ba7c2f2752024d4` |

Private ignored receipts are under `receipts/overnight-20261002`,
`receipts/overnight-20261002-2` and the named Docker suite directories.
Every one of the 19 public assets matched local bytes on independent download.

## Limits and continuation

No deployed service/owner session or real model was changed. Original rejected
owner-event types remain unknown; actual oversized native-context qualification
and installed acceptance are distinct from synthetic regression/loopback proof.
Consumer Windows/WSL artifacts and live qualification are owned by Leo's current
handoff. Four moderate dev advisories remain in Vitest/mocker, fast-uri and
ip-address; production audit has no vulnerabilities. Preserve failure receipts.
