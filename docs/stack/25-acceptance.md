# 25 — Harness-shaped Codex API acceptance

The same 25 draft PRs #47–#71 remain native GitHub stack #72. Each layer builds
on its immediate predecessor; 01 remains a literal empty repository. The current
amendment implements the owner's harness-shaped API direction, focusing on Codex
and concrete extension examples. It is an intentional API break, not a Personal
Multiplex compatibility or deployment change.

## Contract and review order

| Layer | Current amendment                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------ |
| 03    | Typed native results use the existing durable original receipt/journal.                                      |
| 05    | Creation-time Host extensions and an associated inferred Gateway router contract.                            |
| 06    | Public lifecycle is Create/Reopen/Stop/archive/state/original lookup; native controls belong to the harness. |
| 10    | Pinned native Codex DTOs/codecs, actual router, native callback custody and bounded native capture.          |
| 11    | Remove the obsolete universal lifecycle typing fixture; Copilot keeps its separate existing SDK router.      |
| 13    | Actual Gateway-owned routes with authenticated selected-Host context and route leases.                       |
| 15    | Native Codex retained state, independent native history views and thin React bindings.                       |
| 17    | Keep the normalized conversation integration as optional presentation.                                       |
| 19    | Concrete Codex Host/Gateway extensions and actual scripted HTTP/browser/Iroh composition.                    |
| 25    | Current source identities, qualification, limitations and historical evidence.                               |

The actual tRPC routers define inputs, results and inferred clients. The native
Codex surface selects 23 upstream methods, 27 notification kinds and five native
callback families from Codex 0.162.1, revision
`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`. Selected schemas retain their native
fields; no universal Codex-like model is imposed on Copilot or future harnesses.
The generated reachable closure is isolated and collapsed in GitHub review;
the handwritten router, contracts and offline generator are the review boundary.
The [native lifecycle reference](../codex-api/API-Data-Lifecycle.md) and its
[pinned source rationale](../codex-api/API-Data-Lifecycle-Sources.md) describe the
larger native API, not a claim that every upstream operation is implemented.

One lifecycle owns native allocation/Stop and one journal owns originals. Native
mutations validate before durable admission and never retry to recover a reply.
A succeeded receipt records a native operation result, not completed agent work.
Native callback answers borrow the existing one-shot native reply handle; a
submitted answer is not proof of native acceptance. Private elicitation data is
control-only and excluded from public history/capture.

Host extensions execute on the Host. Associated custom Gateway routes execute
on the Gateway with its own resources; Host imports only an inert ID/version
and type-only inference. The manifest binds that customization into composition
identity. Published p2prpc transparently carries native Host RPC/files through
the Gateway; there are no copied endpoints, custom links or replacement file
protocols. Gateway-local routes use the official tRPC HTTP adapter/client.

## History and client ownership

Host and browser share one native capture reducer. A snapshot contains assembled
native state and a bounded raw suffix; the suffix is not replayed over assembled
state. Host replay and assembled state each retain at most 256 KiB; a native
frame is capped at 768 KiB, below the published logical bridge's 1 MiB limit.
Oversized retention is explicit omission, not an invented complete transcript.
Native item completion can repair a body; turn completion does not prove every
tool or child has completed. Historical native reads never become live delta
bases or establish a native read/live watermark.

The retained Codex entry shares one observation per exact run. Views keep their
own selected thread, pages, cursors and anchors; pins retain observation across
switches and unmounts. Reconnect reopens observation with the latest Host cursor
without replaying effects. A newly created, non-omitted root has an explicit
empty baseline and needs no history read. Otherwise captured content supplies
the baseline, or the first committed view makes a shared passive native read of
missing metadata and up to 100 recent full turns. Older pages, invalidation and
explicit retry remain native read exceptions. Concurrent read failures remain
visible; failed promises do not permanently latch retries. Native revision and
attachment facts are local capture evidence, not native continuity guarantees.

## Qualification and test decisions

[Evidence.json](Evidence.json) records exact current source, package and browser
receipts; [Source-Seal.json](Source-Seal.json) hashes non-review build/test inputs.
Historical evidence and failures keep their original identities. The current
source suite uses disposable state, scripted providers and finite owned children.
No model/provider or existing-session operation is needed for these checks.

The decisive owner oracles cover native DTO forwarding/results, exact-original
deduplication, callback privacy and single reply, cold child ancestry without
Resume, derived-presentation independence, bounded capture/slow viewers,
creation provenance and acknowledged or refused Reopen settings. Native-client
oracles cover retained sharing, independent pages/anchors, reversion fences,
replay rollover, read failures/retry and real React commit/StrictMode behavior.
The offline generator reproduces all 243 checked-in files byte for byte.

The final Chromium journey uses the actual Codex adapter with scripted wires,
the published p2prpc bridge, one WebSocket Gateway and two real local direct-Iroh
endpoints. It checks typed Host/Gateway additions, three native Sends across two
sessions, streaming, retained React switching/remounting, pinned state, one
viewer closing while another remains usable, and zero initial native history
reads for fresh roots. Both peers/endpoints, browser, listener, scripted native
owners and temporary state must close. It is not a physical relay or real Codex
provider qualification. Earlier browser r1 remains evidence of its earlier
bundle rather than inheriting final-source claims.

Removed public lifecycle Send/control typing fixtures and old Codex facade-only
cases are replaced by native-router inference and actual adapter/journal checks.
Unique lifetime, Stop, callback, original and optional-presentation oracles are
retained at their owners. No suite is added to assert a deleted wrapper is absent
or that a dependency's own type system works.

## Limits

This amendment does not implement all 173 upstream Codex methods, a native-shaped
Copilot SDK redesign, native provider qualification, browser reload persistence,
Personal integration or a fleet rollout. Managed lifecycle policy remains narrower
than all native settings; unrepresentable observed/requested combinations refuse
rather than defaulting or being silently ignored. Current Nix source is unchanged;
old failed Nix/build and earlier installed/browser records retain their source IDs.

Logical bridge authentication still expires independently of carrier activity,
and reload can consume a new retained logical slot. Historical P14/cross-viewer,
auth-renewal, fresh Host identity discovery and two-physical-relay cases remain
unresolved. The new local two-viewer example does not close those historical
production cases. No merge, deployment, service restart, provider configuration
or operation on existing native sessions is part of this work.
