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
Final local logs are `/tmp/stale-feed37-combined-typecheck-20261008.log`,
`/tmp/stale-feed37-combined-tests-final-20261008.log` and
`/tmp/stale-feed37-focused-final-20261008.log`. The original broad failure remains
`/tmp/stale-feed37-combined-tests-20261008.log` and is not relabelled.

## Release and installed acceptance

Lockstep package version is `0.2.4-hotfix.37`; independent published transport
remains `0.3.0-renewal.2`. No protocol, durable schema, migration or native SDK/CLI
pin changes are introduced by this narrow repair. Candidate distribution retains
signed source and exact public URL/SRI pins; official hosted CI/main/registry
promotion is separate and its existing gates are not waived.

The consumer must rebuild immutable payloads, then qualify installed feeds,
commands and fresh diagnostic append/health during the separately authorized
maintenance window. Fresh historical side-file presence alone cannot establish
current-run diagnostic health. Retain original failed receipts and recovery.
