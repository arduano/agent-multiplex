# Shared native stream stress qualification — October 2, 2026

## Boundary

The added disposable fixtures qualify source checkpoint
`d23d6ea1052d5b8318c9c5cade9fba235f97a8ee` with real runtime store/service,
reverse event pump, child control, Root catalog/service and Gateway projection.
Read/subscription ports are in process; native adapters emit synthetic events.
No credentials, vendor SDK/model, network enrollment, installed state or owner
session actions are involved. This adds regression tests, not a new runtime
implementation or a proof of the original Windows incident.

## Passing cases

For **both Codex and Copilot**, the mixed stress case starts 18 logical sessions:
six active, six stopped and six archived. Retired rings precede active output.
Each active session emits 41 ordered native items, including eight explicitly
owned synthetic subagent items. Three distinct reverse-feed losses and three
child-control reconnects with Gateway refresh occur during the stream.

All **246 native items per harness** arrive at Root and Gateway exactly once,
in each owning session's sequence/epoch, retaining native child payloads and
Root authority/origin provenance. Stopped/archived bytes are absent. Fresh
primary synthetic history remains readable, reverse-feed cursors reach sequence
40 for all six active sessions, and runtime heartbeat remains healthy. Only the
three injected connection failures occur; no negative acknowledgements,
unsolicited gaps or child-pump errors are accepted.

Two additional harness cases replace a native handle through supported
Stop/Resume. They prove old listeners are retired, stale child epoch bytes are
fenced, and replacement output starts at sequence zero. A registered replacement
runtime boot rejects both old-boot bytes and uncertified epochs. Fresh
authenticated inventory establishes the new binding before valid bytes from
the new boot are accepted; no identity or boot fence is relaxed.

Command:

```bash
node node_modules/typescript/bin/tsc -b packages/transport-p2prpc packages/adapter-mock
node node_modules/vitest/vitest.mjs run \
  packages/transport-p2prpc/test/runtime-replay-stress.test.ts \
  packages/transport-p2prpc/test/runtime-replay-starvation.test.ts \
  packages/transport-p2prpc/test/runtime-node-bridge.test.ts \
  packages/control-node-core/test/event-hub-native-dedup-v3.test.ts \
  --maxWorkers=1 --minWorkers=1
```

The focused build and **25 tests / four files** pass. Corrected focused receipt
`receipts/b16-b12-stress-20261002/focused-corrected.log` has SHA-256
`84eb89286ea709970bf84f0794bf562b6dfbb87e0abdfb98320bc5ce4a228dcb`.
All local receipts are private and retain the preliminary fixture failures:
new boot registration correctly invalidated the old epoch, so the test needed
fresh authenticated inventory; the synthetic adapter's inventory then needed
its required `lastActivityAt` field. Neither was a product correction.

Combined source/release gates, published consumers, exact deployed peers and
native Windows/WSL acceptance remain coordinator-owned distinct qualifications.
Production replay/mailbox limits, schemas, migrations and dependency pins are
unchanged. This bounded test does not claim arbitrary load tolerance or recover
an unproved binding/interaction by skipping a rejected event.
