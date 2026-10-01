# Independent runtime replay review and installed peer boundary

This review covers source candidate
`90bd21077b4f98a6c49ead67751bb1c9ce06913e`. It does not qualify publication,
native SDK/model behavior, installed activation, or the original Windows
incident's exact triggering event. No installed service, owner session,
credential, private state or public route was changed.

## Review findings

The correction preserves the relevant identity and durability fences:

- Native retirement deletes only one session's ephemeral replay ring, after
  stopped/archive state is committed and before its new advertisement. It
  changes neither native history nor durable runtime/operation state.
- Existing subscribers keep their already captured prefix and live queue.
  Adapter events queued after handle replacement are rejected by the existing
  active-binding identity check. Retiring a ring cannot resurrect an old handle.
- Terminal archived replay is acknowledged only after the existing authenticated
  endpoint/runtime/boot checks and session-owner check. A native event's harness
  must also match the tombstone. Its epoch need not match a dead binding because
  no bytes are published and no row is restored.
- Unknown session bindings remain negative acknowledgments. Stale open epochs,
  foreign owners, wrong boot IDs and unregistered endpoints remain fenced.
- Cursor commitment, bounded queues, generic retry and reconnect behavior are
  unchanged. A proven retirement removes the poison from future subscriptions;
  it does not authorize arbitrary event skipping.

Two extra race regressions delay an already captured native event while the
binding is stopped or archived. A stopped item remains `FENCED`, and the next
subscription delivers the unrelated live session. Archived bytes are consumed
without publication or resurrection. In the archive fixture, an older queued
nonterminal archive receipt conflicts with the externally settled terminal
receipt, correctly causing one reconnect; it then disappears from replay.
The correction does not weaken that independent operation-record conflict.

## Codex terminal delivery contract

The full-suite coordinator identified an older test which cold-subscribes after
app-server exit and expects the retired native `runtime-exited` item. That
expectation contradicts the new retirement boundary and recreates the invalid
old-epoch replay beneath a stopped catalog binding with `runtimeEpoch:null`.

`CodexSession.runtimeExited()` emits error status, the native diagnostic, then
stopped status. An observer already attached before exit must receive the
diagnostic in order followed by stopped/stale interaction evidence. A fresh
observer after exit must receive the durable stopped binding and retained stale
interaction, without retired native replay. The coordinator owns updating this
contract test and completing full gates. Do not retain a poisoned ring merely
to satisfy the old cold-replay expectation. Mixed proof remains conditional
on that full-suite contract correction and successful final gates.

## Exact mixed peer exercise

The opt-in regression
[`runtime-replay-mixed.test.ts`](../../tests/qualification/runtime-replay-mixed.test.ts)
imports the actual immutable installed modules, rather than substituting this
checkout's Root or Gateway:

| Role | Exact package/version |
| --- | --- |
| NAS Root | `796b9m5137202q93xb9fh8pd7m8hqnvy-leo-multiplex-v6-0.1.0`, control core `0.2.4-hotfix.22` |
| NAS Gateway | `b5g2zbqszhcdqm0qlvfk88r4b2rvyxf7-leo-multiplex-v6-0.1.0`, gateway core `0.2.4-hotfix.23` |
| Candidate Host | The reviewed runtime and local control source at `90bd210`; source graph is still `.23` pending coordinated release preparation |

Real runtime/store/event hub, local control/catalog, the reverse event pump,
old Root service/catalog and old Gateway projection run against a synthetic
adapter and an in-process subscription shim. The Root child link uses its
actual authenticated parent fence and snapshot/aggregate functions. There are
no vendor processes, provider calls, real tickets or transport connections.

Eight mixed cases cover synthetic Codex and Copilot, each after Stop, native
stopped status, Archive and replacement Resume. Each confirms three exact
native sequences, live delivery after child resynchronization, fresh history
agreement, online/reachable routing and the NAS Root authority/provenance.
The original replay and added race/security regressions also pass:
**16 tests / two files, one worker**.

Restoring the previous `.23` runtime/local-control sources in this isolated
worktree made the four Codex mixed cases fail with zero unrelated native
delivery. The production sources were restored byte-for-byte afterward.
The baseline result is a failing diagnostic receipt, not qualification.

This establishes that the B16 Host runtime and local-control correction can
operate with the installed `.22` Root and `.23` Gateway at this synthetic
boundary. B16 changes no wire schema, native/transport pin, profile hash or
migration. Its runtime retirement belongs on the Host runtime; its terminal
runtime-ingress acknowledgment belongs on that Host's local control. Root
ingests the child's aggregate stream, not its runtime reverse ingress, so the
Root does not need this runtime-ingress change to relay corrected Host output.
The Gateway has no B16 ingestion correction to install.

Older Root child-pump fencing still rejects already captured events outside the
current subtree/epoch and requires ordinary authenticated resynchronization.
This review does not relax that boundary or prove every child transport race.
The separately known B1 child-archive projection bug also remains in installed
Root `.22`: it can store an archived child row without publishing its derived
canonical `session.upsert`. A Host-only B16 rollout does not claim that B1 Root
repair. A Root update for B1 remains a separate maintenance scope.

## Repeating the exact exercise

Provide two explicit immutable package directories. Without them the mixed
test is skipped; it never silently uses new local peers.

```bash
MUX_MIXED_ROOT_PACKAGE=/nix/store/796b9m5137202q93xb9fh8pd7m8hqnvy-leo-multiplex-v6-0.1.0/lib/leo-multiplex/node_modules/@arduano/agent-multiplex-control-node-core \
MUX_MIXED_GATEWAY_PACKAGE=/nix/store/b5g2zbqszhcdqm0qlvfk88r4b2rvyxf7-leo-multiplex-v6-0.1.0/lib/leo-multiplex/node_modules/@arduano/agent-multiplex-gateway-core \
node node_modules/vitest/vitest.mjs run \
  tests/qualification/runtime-replay-mixed.test.ts \
  packages/transport-p2prpc/test/runtime-replay-starvation.test.ts \
  --maxWorkers=1 --minWorkers=1
```

Before Host activation: complete full source gates and package the exact
coordinated Host graph; repeat against the exact deployed peer packages.
After activation: use disposable native Copilot sessions to confirm streaming
and fresh history across Stop/Archive/Resume of a different disposable session,
reconnect and independent NAS Gateway command routing. Preserve retained owner
bindings and history without sending them synthetic prompts. No live model or
installed acceptance is claimed here.

## Private qualification receipts

Receipts remain under the ignored namespace
`receipts/b16-mixed-review-20261001` in the isolated review worktree.
They contain synthetic test output and source/module hashes, not fleet secrets
or owner transcript content.

| Receipt | SHA-256 |
| --- | --- |
| Exact source/module inventory | `33137f98f953f6207de9dc729e7272392413e2c6014d2221eca6c72f5ea30bd2` |
| Both-harness passing focused gate | `9db1a60373ed2b9c30182063c76d3cf318a4cbcae033d77d9a2679e9e70da897` |
| Previous-source failing mixed exercise | `c3026e08c3004ac1fb1cb20b78f6997ba48025919209653ab8ab22d32ef58bfa` |

Initial fixture-only failures used a wrong parent-target fence, too-short
synthetic operation hash and overstrict heartbeat equality. A later race test
incorrectly expected no reconnect after a queued archive-record conflict.
Those assertions were corrected before the passing receipt above; no
production change was made to satisfy them.
