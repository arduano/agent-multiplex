# Runtime native replay starvation — October 1, 2026

## Scope

This isolated source candidate starts from published `.23` qualification
checkpoint `5b8cb1530e4b3fd6040ae611d28b7c5e9cd8ad12`. It neither changes
published package bytes nor deploys a role. Protocol/schema/version/profile
hashes, migrations and native/transport dependency pins are unchanged.
`SECURITY.md` and `THIRD_PARTY_NOTICES.md` were reviewed; no new dependency or
third-party implementation is introduced.

The Leo owner reported that **Tariff fixes stack** accepted a prompt and reached
Finished while the conversation remained at older messages; an explicit history
reload revealed the new reply. Leo's protected simultaneous observation found no
native events at Windows Host control, NAS Root or NAS Gateway while fresh
native history contained the new work. Three archived Windows records existed
in Root catalog. These facts locate the failure before Host control publication
but do **not** prove which item, if any, blocked its runtime pump. No live
runtime ring was inspected, SDK payload captured or role/session changed here.

## Deterministic reproduction

The committed regression is
[`runtime-replay-starvation.test.ts`](../../packages/transport-p2prpc/test/runtime-replay-starvation.test.ts).
It uses real `RuntimeNodeService`, its real `RuntimeNodeEventHub` and store,
real `ControlNodeService`/SQLite catalog and real `RuntimeNodeEventPump`.
A small in-memory synthetic adapter emits native items and retains synthetic
history; an in-process subscription shim replaces the network. It uses no
vendor SDK, subprocess, credentials or model call. Retry delay is reduced to
1 ms and the assertion window is bounded to 300 ms.

1. Launch a synthetic session and emit its first reply into the runtime ring.
2. Retire that session through supported Stop, native stopped status, Archive
   after Stop, or Stop/Resume with a new native epoch.
3. Launch a second session and emit a new reply.
4. Independently confirm the runtime heartbeat succeeds and fresh native history
   reads the second reply.
5. Attach the real reverse-feed pump with an empty native cursor, as after a
   control process restart. Binding advertisements precede native-ring replay.

Unchanged `.23` fails all four delivery assertions:

| Retired session | Replayed rejection | Second session's native delivery |
| --- | --- | --- |
| Stopped | Old native epoch versus catalog `null`: `FENCED` | Zero attempts |
| Archived | Canonical tombstone returns `accepted:false` | Zero attempts |
| Resumed | Old native epoch versus replacement epoch: `FENCED` | Zero attempts |
| Native stopped status | Old native epoch versus catalog `null`: `FENCED` | Zero attempts |

The archived loop is silent: `RuntimeNodeEventPump` invokes its error hook only
when an error is supplied; its negative-acknowledgement path supplies none.
Each rejection ends the whole runtime subscription without committing that
native cursor, and reconnection replays the same retired ring before reaching
the healthy session. Inventory/presence and history remain independently usable.
The archived-terminal acknowledgment assertion also fails on the baseline;
the unknown-session/stale-open-epoch safeguard already passes.

An initial fixture reused a native ID after release, making its next launch
outcome unknown. That fixture defect was corrected with a monotonic ID counter.
The original diagnostic and corrected failing receipts are retained separately;
only the corrected final regression is evidence for the defect.

Installed `.22` source was read-only compared at the relevant event-hub replay,
control ingestion and event-pump rejection paths: it has the same mechanism.
No installed `.22` model or native service qualification is claimed.

## Narrow correction

- `RuntimeNodeEventHub.retireNativeSession` releases only one session's
  in-memory native ring. Explicit Stop/native stopped status, successful Archive
  and installation of a new handle call it. Existing live queues retain their
  causal order; active epochs still replay normally with sequence zero and
  deduplication.
- `ControlNodeService.publishRuntimeEvent` treats a known archived native replay
  as terminal after the existing authenticated runtime/boot fence, session-owner
  check and native harness check. It returns `accepted:true` without publishing
  or restoring any session. This also handles an already captured/in-flight
  archived replay.
- Missing bindings still return `accepted:false`; wrong owner, boot, harness
  and open-session epoch remain `FENCED`. The event pump's ordering, cursor
  commitment, bounded queues and generic retry behavior are unchanged.

This is not an arbitrary skip-on-error policy. Only a runtime's own retired
ring or a validated canonical archive supplies terminal evidence. An unknown
binding can still pause the reverse feed until binding reconciliation succeeds;
that uncertainty must not be bypassed.

## Qualification and remaining gates

The targeted TypeScript project build and focused regression/bridge/control
hardening/runtime launch/startup suites passed 71 tests across five files with
one worker. Exact receipt hashes and source/test inventory are recorded in the
[checkpoint](../checkpoint-v4.md#isolated-runtime-replay-starvation-candidate--2026-10-01).
The checkpoint gate identified unbuilt unrelated role outputs after the focused
build; its failure receipt is retained and broad gates await coordinator
scheduling. Broad source gates,
independent review, coordinated publication, packed consumers and installed
qualification remain separate. No original Windows root cause or live repair
is claimed from this synthetic reproduction.

```bash
node node_modules/typescript/bin/tsc -b packages/transport-p2prpc packages/adapter-mock
node node_modules/vitest/vitest.mjs run \
  packages/transport-p2prpc/test/runtime-replay-starvation.test.ts \
  packages/transport-p2prpc/test/runtime-node-bridge.test.ts \
  packages/control-node-core/test/hardening-v3.test.ts \
  packages/runtime-node-core/test/v4-launch-provider.test.ts \
  packages/runtime-node-core/test/startup-reattach.test.ts \
  --maxWorkers=1 --minWorkers=1
```
