# Copilot native payload gap diagnosis, September 30, 2026

This is a source candidate and synthetic qualification. No installed service,
owner session, private configuration, task, ACL or provider was changed. There
were no model calls, remote commands or reads of private native history/logs.

## Incident evidence and its limit

Leo's sanitized September 29 evidence records two native event admission
failures, with pre-externalization event/queue sizes **1,297,380** and
**1,721,340 bytes**. Both were `imageExtraction` / `schema`, with one queued
event. The existing diagnostic contains no native event type, content or schema
issue. It establishes a local framework externalization/schema rejection, but
cannot establish its precise validation rule or attribute it to an SDK RPC.
The original event remains undiagnosed; synthetic resemblance is not incident
proof.

The queued event path in
[`service.ts`](../../packages/runtime-node-core/src/service.ts) stays at
`imageExtraction` until the adapter image codec and final native envelope parse
return. Copilot's codec identifies image leaves only in known native shapes;
it does not scan opaque tool arguments/results or rewrite ordinary text. Its
standard externalizer validates the resulting envelope through the protocol
schema. That schema caps the conservative JSON/MessagePack wire estimate at
**960 KiB**, independently of pre-externalization JSON size.

## Synthetic reproduction

[`copilot-payload-gap.test.ts`](../../tests/copilot-payload-gap.test.ts) creates
bounded synthetic native events with exactly each observed pre-externalization
adapter-event byte size. It uses the real Copilot image codec, runtime service,
SQLite lifecycle journal and reducer, with a fake native handle and no SDK
process.

| Synthetic event content | Exact admission bytes | Result |
| --- | ---: | --- |
| Recognized model snapshot with retained ordinary text | 1,297,380 | `imageExtraction` / `schema` / `wireEnvelope`; no payload publication |
| Recognized model snapshot with retained ordinary text | 1,721,340 | Same rejection and continuity gap |
| Recognized model snapshot with one large inline image | 1,297,380 | One image slot; externalized envelope fits |
| Recognized model snapshot with one large inline image | 1,721,340 | One image slot; externalized envelope fits |
| Opaque structured tool result resembling an image | Over the envelope bound | Retained as native tool data; `wireEnvelope` rejection |

The image fixtures carry canonical synthetic PNG/base64 bytes. Their mock sink
reports an explicit missing-image slot, so these cases qualify image-leaf
externalization and envelope shrinking, not storage, image decoding or native
model vision behavior.

This distinguishes a retained non-image wire overflow from recognized image
bytes at the same input size. It also demonstrates why the original two byte
counts alone cannot prove overflow: recognized image leaves can disappear from
the envelope. A small event can separately fail JSON shape, image metadata or
pointer constraints.

The rejection tests also prove the runtime persists a continuity gap, retains
partial interaction completeness, refuses Send without dispatch, keeps Stop
available, and does not turn later root idle into verified interaction recovery.
No envelope bound, reducer, recovery certificate or event admission behavior is
weakened.

## Fixed private validation categories

`parseNativePayload` preserves the original Zod exception and uses a WeakMap to
associate only that exact envelope validation boundary with one fixed category.
Foreign Zod errors and untagged direct schema parsing remain unclassified; the
runtime never infers an envelope violation merely from an exception name.
Standard image externalization, image-free packing and final runtime validation
use this helper. Categories are selected in this fixed priority when several
rules reject the same payload:

| Category | Validation rule |
| --- | --- |
| `wireEnvelope` | Conservative bounded wire estimate exceeds 960 KiB |
| `imageSlotLimit` | More than 256 sidecar slots |
| `imageSlotMetadata` | Representation/path/prefix/absence metadata is inconsistent |
| `imagePointer` | Duplicate pointer or pointer does not target a null leaf |
| `imageSlotShape` | Slot or descriptor shape is invalid |
| `jsonShape` | Native JSON shape is invalid |
| `envelopeShape` | Envelope encoding or outer shape is invalid |

The runtime exports `NativeGapLogDiagnostic`, extending `NativeGapDiagnostic`
with optional `payloadFailure`, solely for `onNativeGapDiagnostic`. The
additional category is supplied only for tagged failures at `imageExtraction`.
It contains no rejected values, event type/identity, session identity, paths,
issue paths/messages or native error messages. Tests exercise all categories,
multiple failures, unrelated exceptions and content/identity/path sentinels.

**The durable/public diagnostic schema is unchanged.** The lifecycle journal,
stream and public health projection receive the original diagnostic; only the
best-effort private logging hook receives the optional extra field. Regression
checks show the actual persisted gap is accepted by the unchanged strict schema
and the richer hook object is rejected by it. This preserves rollback replay:
older `.22` binaries do not need to read new fields in retained lifecycle state.
A separate local sample check also verified acceptance of the unchanged shape
and rejection of the private extension using the retained published
`@arduano/agent-multiplex-protocol@0.2.4-hotfix.22` parser (compiled lifecycle
module SHA-256
`770ea7f8e87b707c5b349d741672df5dd18a35fa53d2ac6034764555e494e1a1`).
The diagnostic ID still correlates a private log record with public health.
There is no migration, protocol version, profile hash or dependency-pin change.

A Leo Host needs a separately reviewed logger update to retain `payloadFailure`
in its protected `copilot-native.jsonl`. Framework publication and installed
activation are separate from this source candidate. Existing deployed logs
cannot retrospectively acquire the missing category.

## Next incident and correction decision

After independent source/artifact qualification and coordinated activation,
correlate the public diagnostic ID with the private fixed category. A confirmed
`wireEnvelope` then proves an overflow after image externalization; an image or
JSON category selects a different narrow correction. The category alone does
not identify a tool, message or original native event type.

A permanent behavior correction must retain native data and certify lifecycle
continuity from actual native evidence. Do not truncate arbitrary tool output,
scan it heuristically for image-looking fields, expand the transport envelope,
or clear interaction uncertainty after an admission failure. If overflow is
confirmed, separately design a bounded native-event representation or native
snapshot policy with explicit omission and recovery semantics. No such
behavior change is claimed here.

## Qualification boundary

Focused source build and five test files passed: **38 tests**, one worker,
process-only `TMPDIR=/dev/shm`. The first run failed two new fixture cases because
the fixture included `runtimeNodeBootId` in a strict stored-session record. The
fixture was corrected; the published store validator was preserved. That failed
run is retained as a diagnostic, not passing evidence. Exact code/source commit:
`d0c855c44229d9ae65a8ec39fd0ad10d3237d90b`. Passing local receipt:
`receipts/copilot-gap-diagnosis-focused-20260930/summary.json`, SHA-256
`3160d2d58b8d623e5741495e8c1d5e714f2dffc20506f943ec29ffc08eabfd25`.
The failed fixture run is preserved at
`receipts/copilot-gap-diagnosis-diagnostic-1-20260930/summary.json`.
Repository-wide gates and packed consumers were later completed by the root:
1,162 tests / 124 files, production build/typecheck and source checks, all 16
role-isolated packed consumers through the reviewed public transport boundary,
and SBOM generation. The
[exact checkpoint](../checkpoint-v4.md#private-copilot-payload-gap-diagnostics-candidate--2026-09-30)
owns receipts and hashes. Publication and installed activation remain pending;
the original owner event's exact validation condition is still unknown.
