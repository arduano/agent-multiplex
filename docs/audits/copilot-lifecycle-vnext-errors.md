# Command errors and native replay audit

Audit baseline: `c28811b320f436acbec332b00199716a3c62cfa7`, assigned
`feat/copilot-session-lifecycle-vnext-20260922` worktree. The supplied `BRIEF.md`,
`CURRENT-AUDIT.md`, and `STABILITY-CONTEXT.md` passed their supplied
`SHA256SUMS`. No production state, credentials, private conversations or sibling
transport worktree were read. Security policy and third-party notices were
reviewed; this work adds no dependency or vendor implementation.

## Evidence and corrections

| Supplied assertion | Verdict | Exact source evidence and resulting change |
| --- | --- | --- |
| Control native replay omits a requested-ahead gap | Confirmed | `ControlNodeEventHub.#subscribe` previously compared only the oldest retained sequence; a same-epoch cursor ahead of the latest sequence silently received no recovery signal. The hub now reports `nativeGap` before continuing live delivery. |
| Missing native ring is safe to ignore | Disproved as a recovery assumption | Iterating only `#rings` omitted a requested session after its ring was lost. Requested selected sessions without a ring now emit a gap. An unselected cursor entry does not create a gap for another subscription. |
| Runtime and gateway already check requested-ahead cursors | Confirmed, conditional | Runtime `RuntimeNodeEventHub.subscribe` checks retained rings; gateway `AccessGatewayProjection.#nativeReplay` checks `#nativeSeen`. Those checks prove coverage for observed sessions, not sessions missing from those maps. This patch changes the control hub only. |
| Generic command receipts persist raw error strings | Confirmed | Runtime `#journal`, control `#dispatch`, and restart/boot recovery paths stored arbitrary exception messages or stringified values. All generic command receipt constructors now use the fixed-text `CommandError` contract. |
| Thrown RPC errors are uniformly safe and retain native attribution | Disproved as a generalization | Control `asTrpcError` recognizes allowlisted remote tRPC codes and sanitizes foreign messages; runtime `toTRPC` forwards known local messages and rethrows unknown errors. Durable typed command receipts are now safe, but arbitrary thrown native-read errors and launch/archive records remain separate unresolved boundaries. |
| A successful command response proves lifecycle completion | Disproved | The command journal settles adapter execution/result storage. Native turn, task, interaction and queue state remain independent. `outcomeUnknown` remains uncertain even if an error's allowlisted code is `FENCED`. |
| A gateway transport renewal permits command retransmission | Disproved | Gateway command routing dispatches once; control recovery reads the same command identity. Renewal must preserve this rule independently of subscription resumption. |

## Normative error boundary

`CommandRecord.error` is an optional **object**, never a string or compatibility
union. Its fields are `code`, `stage`, `certainty`, `diagnosticId`, and `message`.
The schema enforces a fixed public message for each allowlisted code, rejects
extra properties, and rejects error certainty inconsistent with command state.

| Input | Durable output | Authority |
| --- | --- | --- |
| Definite native rejection | `failed`, `certainty=definiteFailure` | Owning runtime command journal |
| Adapter/provider reports ambiguous side effect | `outcomeUnknown`, `certainty=outcomeUnknown` | Owning runtime command journal |
| Native success followed by unrecordable result | `outcomeUnknown`, `stage=recording` | Owning runtime command journal |
| Forwarding link fails after dispatch | `outcomeUnknown`, `stage=dispatch` | Forwarding control receipt; later runtime receipt can refine it |
| Restart or replaced runtime boot interrupts admission | `outcomeUnknown`, `stage=recovery` | Recovering owner; no redispatch |
| Native exception includes unknown code, private text or nested cause | Fixed `NATIVE_FAILURE` / `OUTCOME_UNKNOWN` message | Boundary constructor ignores text and arbitrary properties |
| Read-only recovery finds a terminal receipt | Preserve its code, certainty and diagnostic identity | Runtime receipt accepted by exact command request and route fences |

Only own data properties on an `Error` are considered for code classification;
getters, remote-shaped plain objects, exception names, messages, stack and causes
are not inspected. Stage and certainty come from the command owner. A code never
grants mutation retry permission. Diagnostic IDs identify receipt failures; this
change intentionally creates no new raw diagnostic logging or secret retention.

Gateway projections and access contracts preserve typed receipt data. CLI and
browser render the fixed message; the CLI also shows code and diagnostic ID.
The existing command ID and payload hash remain the reconciliation identity.

## Maintenance migration

| Store/package | Migration or consumer requirement |
| --- | --- |
| Protocol | Clean object error contract; all services/clients upgrade together under protocol v6. |
| Runtime SQLite | Append version 6, `runtime-node-store-v6-command-errors`. |
| Control SQLite | Append version 7, `control-node-v6-command-errors`; rotate feed and discard old replay/import checkpoints. |
| Runtime/control stored receipts | Discard old freeform error text, retain state/request/hash/result/timestamps, and create deterministic fixed public error text with command ID as diagnostic ID. Equal replicated receipts convert identically. |
| Gateway | No authoritative migration; obtain a fresh validated source snapshot after feed rotation. |
| Browser/direct clients | Accept object errors only and recover by original command ID. |

Conversion does not parse legacy error prose or infer a historical cause. Failed
legacy receipts become generic definite failures; unknown legacy receipts remain
unknown. A nonterminal legacy row containing an error is rejected transactionally.
Released migration names/order remain intact. Back up all authority/runtime
stores before the coordinated offline upgrade; old binaries cannot open the
newer schema. Rollback requires restoring the matching pre-upgrade store set and
must not replay ambiguous commands. Scrubbing live rows is not secure erasure of
preexisting backups/WAL/filesystem remnants; those remain protected operator data.

## Transport renewal boundary

The independently owned renewal implementation must keep command identity,
payload hash, binding revision, runtime epoch, authority/feed identity and
subscription cursor semantics unchanged during same-generation renewal. A lost
command reply is uncertain and must be reconciled by read. A stream gap, missing
ring, expired cursor or changed generation must produce recovery evidence rather
than synthetic completion. A control gap does not prove runtime failure or SDK
failure. This work neither inspects nor duplicates the transport renewal branch.

## Tests and remaining limits

The protocol tests reject secret sentinels, hostile code getters, arbitrary extra
fields, legacy string errors and certainty mismatches. Runtime regression tests
inject synthetic native exceptions, prove receipt persistence through restart,
and prove repeated reads of the original command never execute again. Control
tests prove dispatch exception prose is absent from receipts and control events,
then accept a later authoritative terminal receipt. Gateway tests preserve the
typed error and diagnostic ID during recovery. Replay tests cover requested-ahead,
missing, expired and unselected rings and epoch-scoped sequence comparison.
Migration tests prove deterministic runtime/control conversion and feed rotation.

Exact executed commands and outcomes belong to the final run receipt and
handoff. No model/native qualification is claimed. No SDK capability can restore
private native error text that an upstream IPC layer already discarded; adding
typed native-read errors is separate work. Launch/archive public errors and
arbitrary thrown RPC/native-read errors are **not** migrated by this generic
command receipt change and must not be represented as fully sanitized.

Focused implementation-stage executions (2026-09-22; the final combined-source
receipt supersedes these concurrent-worktree checks):

```text
npx tsc -b packages/protocol packages/storage-sqlite packages/runtime-node-core packages/control-node-core packages/gateway-core --pretty false
  PASS (before final protocol descriptor migration)
npx vitest run packages/protocol/test/command-error.test.ts packages/control-node-core/test/event-hub-native-dedup-v3.test.ts packages/control-node-core/test/command-error-migration.test.ts packages/control-node-core/test/hardening-v3.test.ts packages/gateway-core/test/projection.test.ts tests/runtime-node-core.test.ts tests/native-path-policy.test.ts tests/runtime-images.test.ts
  PASS: 8 files, 161 tests (15:49:44 runner time)
npx vitest run packages/client/test/command-error-wire.test.ts tests/storage-sqlite.test.ts
  PASS: 2 files, 12 tests (15:51:08 runner time)
```

The real HTTP regression verifies access-client serialization preserves the
entire typed error object, including certainty and diagnostic ID. During test
migration an existing insecure-directory fixture depended on the process umask;
it now explicitly chmods its disposable test directory to 0755 so the rejection
test remains meaningful under umask 077. This changes no production permission
policy. Earlier failed runs were diagnostics: one unmigrated launch-error
expectation, one legacy migration fixture retaining newer ledger rows, one
incorrect HTTP input shape, and stale control-schema expectations were
corrected. The coordinated protocol-v6 control store ends at version 7.
