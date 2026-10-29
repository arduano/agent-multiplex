# 10 — Explicit Codex app-server adapter

This layer supplies the actual Codex `0.162.1` stdio implementation behind the
structural NativePort. It does not introduce another session journal, lifecycle,
retry loop or process registry. The default lifecycle from06 owns the adapter,
its parked native openings, its read helpers and its final close. Definition,
import and constructor are inert. The first native admission is `prepare`, which
parks custody; `open` launches only after06 has committed that capsule.

## Native API lifecycle reference

The [concise native data lifecycle](../codex-api/API-Data-Lifecycle.md) links
each data class to its [revision-pinned source rationale](../codex-api/API-Data-Lifecycle-Sources.md).
The rationale separates wire declarations, implementation behavior, upstream
test-source oracles and absent guarantees at Codex 0.162.1 /
`092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`. Its version-update procedure
requires reviewing the producing/consuming code and updating both documents.

This reference describes the native target, not full adapter parity or new
runtime qualification. The documentation amendment changes no product/test/
dependency/build input. Implementation reconciliation remains for owner
discussion; no native session/model/provider campaign, merge or deployment is
part of this amendment.

## Public contract and module map

The browser entry `./codex` contains schemas and DTO types only. `./codex/node`
contains the Node factories, actual wire, cold-reader factory and typed router.
There are no old primitive imports, sibling dependencies or closed global
Codex/Copilot dispatch unions. A concrete Host's inferred native router exposes
only that adapter's actual controls. Query endpoints preserve their exact result
types: model choices do not return an unrelated goal/terminal union.

| Module          | Responsibility                                                                     | Authoritative owner                                     |
| --------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------- |
| contracts       | Desired selection, partial observed selection, messages, commands and read DTOs    | Pure browser-safe schema                                |
| adapter         | Native bindings, live attachment, prepared input holds and explicit resource close | Selected lifecycle owns this whole adapter              |
| rpc             | Pinned initialize, actual NDJSON framing, one dispatch, exact reverse capability   | One actual wire; no reconnect                           |
| commands        | Native command/body and response encoding                                          | Caller must supply an admitted original                 |
| reads           | Native model catalog, goals, terminals and MCP inventory                           | Exact active run or explicit sessionless reader         |
| history/lineage | Item/delta/turn/error normalization and proved child scopes                        | One HistoryWindow per proved native stream              |
| reader          | Explicit stopped-history/catalog exception process                                 | Injected durable reader lease and exact opening capsule |
| callbacks       | Private native decision/answer encoding and nine-kind interaction bridge           | InteractionOwner from09 owns the one-use capability     |
| config          | Private explicit provider/MCP/native policy configuration                          | Host operator supplies paths, profile and credentials   |
| router          | Authenticated typed native tRPC controls and private link reads                    | Lifecycle's original journal; router owns no effect     |

The host composes `codexHarness(options)`, `defaultLifecycle({native:
harness.adapter, journal, workspace, selection})` and
`codexRouter(sessions, harness.adapter)` through05. The trusted composition
installs `options.observe` as a structural sink into
`sessions.observe(value.run.scope, value)`; callback delivery uses the separate
structural CallbackSink from09. Both are mandatory integration responsibilities
when those features are enabled; the adapter does not import concrete owners.
A Host process, not a React mount, owns this composition.

## Native behavior retained

| Surface          | Actual protocol behavior                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create           | initialize/version check; thread/start with selected provider/model/policy; positive native ID committed before initial settings; fresh quiescence required |
| Reopen           | Explicit thread/resume of the same ID with excludeTurns; may continue native work; no original user prompt replay                                           |
| Send             | turn/start with exact original clientUserMessageId and scoped prepared inputs                                                                               |
| Steer / queue    | Distinct turn/steer expected-turn fence and thread/queue/add original echo; no substitute Send                                                              |
| Interrupt / Stop | turn/interrupt requests a turn interruption; Stop requires the runtime's exact sealed native-tree proof                                                     |
| Continue         | Explicit empty-input turn/start only after positive idle/terminal failure; intermittent network failure can therefore be continued; never automatic         |
| Settings         | thread/settings/update versus model/effort turn/settings/update; actual nested settings notifications update observed values; ACK is not observed selection |
| Models           | Complete bounded native model/list pages and reasoning efforts; no static model list or fallback provider                                                   |
| Goal             | thread/goal/get/set/clear with actual status/budget/usage fields and echoed patch validation                                                                |
| Terminals        | Native background terminal list, terminate and clean; no terminal output transcript substitute                                                              |
| Compact          | thread/compact/start plus explicit contextCompaction history notices                                                                                        |
| MCP              | Explicit private stdio/HTTP configuration, inventory, reload, OAuth login, native approvals/elicitation and confirmations                                   |
| Questions        | Per-question native options and Extra info preserved, including identical label/freeform strings; optional message callouts retained                        |
| Plans            | Native plan item/text and phase metadata retained; selecting/implementing a plan remains an explicit UI/lifecycle command                                   |
| Children         | Native parent/context chain proof, bounded out-of-order metadata buffer, separate history streams and exact root/child callback ownership                   |

Only explicitly supplied environment/provider configuration is used. The managed
home stays private, full-access/on-request defaults are written once, retries
are disabled, and selected Copilot-only provider policy is enforced. Existing
arbitrary configuration is refused rather than overwritten. The pinned CLI is a
consumer-supplied explicit binary/package root; its presence is not implied by
installing a browser entry. No model/provider fallback or ambient home import
exists. Native may append its narrowly validated project-trust metadata.

## Ownership and previous counterexamples

A native thread ID is already real before the next settings RPC can fail.
`open.commitBinding(run)` synchronously commits only that identity in06's same
journal; it does not mark Running or overwrite saved selection intent. Lost
initial-settings replies therefore preserve the exact ID for explicit Stop and
Reopen. Final open and later observations supply actual control facts. Unknown
observed settings remain absent rather than inheriting a trusted-looking value.
In particular, Reopen refuses missing observed permissions before launching;
an operator must explicitly reconcile that policy instead of silently granting
full access. Lifecycle Reopen accepts an explicit selection override in its
immutable original, which the adapter validates before allocating. A desired
Create selection still gets the trusted default.

Runtime allocation references use runtime canonical bytes, not JSON insertion
order. A real delegated backend rejects a different serialization of the same
object. A failed home/configuration check occurs before allocation. Native tree
retirement and attachment/input cleanup are different facts: positive Stop can
be returned while cleanup remains owned, and update readiness remains blocked
until actual cleanup settles. Input preparation is tracked while awaiting its
real promise; Stop can win during that await, and the late result cannot Send.
Inputs remain leased through unknown native outcomes; a known predispatch refusal
releases them. A turn completion that overtakes its Send ACK still releases the
exact hold. Queued inputs with no proved turn correlation remain retained until
native correlation or Stop, with an explicit capacity refusal rather than expiry.

An idle cached read helper is ready _to close_, rather than already empty. Close
retires its exact read-only tree and awaits cleanup. An in-flight read,
initialization or failed cleanup blocks readiness. Helpers have a finite native
lifetime and call count; successful retirement removes their lease from adapter
capacity. Failed cleanup retains the exact rejected close and licenses no blind
replacement. A cold history query uses only thread/read and native timeline/item
read methods; it cannot Resume or Send. Reader ancestry must reach the selected
root in the same read job.

The adapter admits the inert helper into its existing reader set before any
asynchronous validation. A second helper for the same logical scope, including
another generation or model-catalog request, refuses `BUSY` before allocation;
it cannot stop the first reader by presenting its persisted capsule as prior
custody. Share the retained conversation binding or close the helper explicitly.
Actual positive close releases capacity. Direct low-level `CodexReader`
construction instead requires the consumer to own an exclusive lease through
close. The paired Codex/Copilot same-scope race oracles and focused strict compile
passed (two cases,245ms); vendor/model allocations remain zero.

Wire loss never proves native Stop. Original RPCs are never retried. Reverse IDs
preserve JSON kind (`1` differs from `"1"`) and opaque incarnation; overlapping
reuse fences both capabilities. A submitted answer is not confirmed by its write
ACK. Only native resolution settles it; native withdrawal before an answer
confirms that exact capability as rejected, while wire loss remains unknown.
Popup verification links stay private and ephemeral, outside receipts/history;
explicit exact-run link queries require control permission as well as read.

History uses the same completed-item codec for live and explicit native pages.
Native timeline windows are already ascending internally; the adapter validates
position/kind/byte-ID order and never reverses them. Canonical item entries prove
completion even without timestamps, while a parent turn's completion cannot
finish a missing item. Tool failed/interrupted states, itemless failed turns,
compaction, missing delta prefixes and unsupported realtime entries remain
explicit. Foreign thread/turn IDs are rejected. A bad buffered ancestry record
is removed without blocking later independent proofs. Contradictory child
metadata quarantines that branch; bounded quarantine overflow fences new child
ownership rather than growing memory indefinitely.

## Qualification and limits

Focused strict compilation of all10 source and both test files passes with
NodeNext/ES2023, strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes,
noImplicitOverride and verbatimModuleSyntax. The explicit command is:

```sh
node node_modules/typescript/bin/tsc --target ES2023 --lib ES2023,DOM,DOM.Iterable --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noImplicitOverride --verbatimModuleSyntax --rootDir . --outDir .cache/codex-check --declaration false src/codex/node.ts test/codex/adapter.test.ts test/codex/reconciliation.test.ts
```

The ten adapter tests passed together after the initial Stop-proof projection
repair (178ms in the affected-source rerun). They cover allocator canonical
reference, parked-before-open, real method encoding, Stop versus preparation,
completion-before-ACK, exact native question resolution, timeline/child identity,
cold reader recycling, wire loss/reverse reuse, actual Node stdio framing and
unsupported native elicitation. The Node fixture launches only our disposable
JavaScript echo child and awaits its actual exit; it does not launch Codex.

The ten reconciliation tests passed in bounded focused selections, not a claimed
new all-framework qualification campaign. The actual composed SQLite/default
lifecycle/Host/tRPC oracle passed in7.554s after correcting its fixture's missing
authenticated session claim. It proves persisted identity after a lost initial
settings reply, explicit Stop/Reopen, observed working→idle, typed model reads,
exact duplicate Send after a later generation and stale-run refusal. Other
focused cases prove idle-reader readiness versus actual reads, sticky native
instructions, private OAuth links, unknown Send input custody, partial/terminal
history evidence, pinned-version refusal, no allocation on invalid configuration,
JSON-kind reverse identity/withdrawal, and no implicit permission escalation.
Each source change triggered only its affected focused checks. Cross-family
native calls and invalid collaboration input are compile-time counterexamples.

All model/provider calls and vendor-agent allocations in this layer's checks are
**zero**. SQLite and temporary native homes are test-owned and removed. Scripted
allocations/wires are explicitly stopped/closed, and the owned Node framing
fixture is reaped. Earlier generic lifecycle/runtime tests remain with06/04;
this layer does not duplicate their entire fault matrix or import old campaigns.

The following are intentionally **not qualified** by these source tests:

- Real Codex0.162.1/provider/model operation, real MCP server/CLI confirmation,
  platform containment and full concrete runtime-launcher integration. The wire
  and adapter are implemented, but mocks and an echo child cannot prove these.
- Fleet/gateway/browser/Iroh/two-viewer or production deployment behavior; later
  numbered layers own their composed acceptance and must preserve known defects.
- Actual vendor-produced image bytes and live provider preview behavior. The
  media integration amendment below qualifies scripted native envelopes against
  real scoped files; it does not qualify a running vendor agent. No raw local
  path is accepted by the public message schema.
- The advanced UI for an operator-selected Reopen override. The lifecycle and
  concrete Codex override paths are source-qualified; a missing override refuses
  before allocation instead of selecting trusted permissions implicitly.

The repository-wide checkpoint and published package export changes belong to
the integration owner after this layer freezes. Passing these focused source
checks is not a claim that a published/installable native Host was qualified.

## Provenance and test replacement

Sound behavior references are the retained61d90fd commit's
`primitives/v8-harness-codex/src/{request-contract,invocation,rpc,access,models,mcp-config}.ts`
and `primitives/v8-history/src/native/codex/{history,lineage,questions,errors}.ts`.
The new code reuses their pinned native method/field semantics, sticky
collaboration rule, byte-ordered timeline completion evidence and lineage proof;
it does not import their default/session/recovery topology. No reference native
home or model campaign was opened. Legacy adapter/session test permutations are
replaced here by the named native-boundary counterexamples above. Generic owner
invariants remain tested once at03/04/06/07/08/09.

## Pre-allocation refusal and explicit Reopen selection amendment

The06 preparation contract now includes the opening mode and intended selection.
The adapter can positively refuse known invalid local selection/configuration,
capacity, a pending reader or unfinished same-scope cleanup _before_ parking.
These certificates refer only to absence of the requested new native allocation;
they do not assert that unrelated old resources are gone. Pure configuration
validation makes no native RPC. Home I/O, reader-retirement failures and anything
after native allocation remain exceptions with unknown outcome. There is no
separate preflight API or required native inspection round trip.

The lifecycle restores its prior stopped custody after a positive Reopen
refusal. An explicit permission/model override must be selected again on a new
original; refusal does not silently apply it. The Codex input-race oracle now
proves BUSY acquires no new allocation while input preparation is outstanding,
and a later fresh attempt can park after actual release. The unknown-permission
oracle now proves missing policy refuses with no allocation and an explicit
owner selection opens the same native thread successfully. The invalid local
configuration case still allocates zero native resources. Strict focused compile
and these three affected cases passed; previous adapter qualification was not
replayed. UI exposure of this deliberate advanced action belongs to16.

## Conversation integration seam

Typed native `answer` now delegates to the exact CallbackDispatcher retained with
its CallbackSink. The06 lifecycle passes the original's already-admitted
scope/ID/hash identity to NativePort.command; no command creates another journal
or calculates a replacement hash. A submitted callback reply succeeds as
submission only; its actual native resolution independently confirms acceptance.
The typed Codex answer schema excludes Copilot answer kinds. A live
`historyRead(run, stream?)` port now reads the actual retained app-server timeline
for the proved root/child scope, with before/after run and ancestry fences.
The07 acquisition owner supplies the shared actual-I/O budget and public cursor;
this method does not fetch during construction, attach or render. Stopped history
still uses the explicit sessionless reader, never this live attachment.

The affected actual SQLite/lifecycle/tRPC oracle passed in6.145s after the06
identity projection correction. It now proves a typed native answer uses the
same durable admitted hash, duplicate answer delivery writes the reverse reply
once, native resolution confirms it, and live history acquisition uses the real
retained timeline method. Earlier assertions waited only for scripted attachment
cleanup to settle before explicit Reopen; BUSY remains a real positive refusal.

## Media integration amendment

The concrete adapter now injects a structural media materializer returning08
StoredFile descriptors. Native `imageView` paths, user/response images, MCP images,
dynamic inputImage results and imageGeneration output are recognized at their
pinned protocol locations. Tool arguments are never recursively treated as file
authority. The materializer alone authorizes a private native path or decodes
inline bytes; no image base64/private path enters public history metadata.

Live capture publishes bounded placeholders, then replaces only the matching
asset in the latest row. It cannot overwrite newer text, status or native turn
facts. At most four actual captures and128 resident descriptors are retained;
settled unneeded entries retire instead of imposing a lifetime image counter.
Stop seals publication and retains pending capture jobs in actual auxiliary
cleanup after positive native-tree retirement. Same-scope Reopen stays busy while
that cleanup remains unproved. Both active and explicit cold history pages
materialize under their existing read/publication fences; final projection is
lookup-only and cannot admit a second batch after preparation settles. Saturated
images remain explicitly unavailable. Cold readers still
never Resume. Their close/readiness includes actual media work. Missing or
refused authority is local asset unavailability, not invented file access.

The10 layer declares only its local structural capture types over08StoredFile and
protocolJson/RunRef; it has no dependency on the later assets owner.18 supplies
the concrete FileStore integration. Four focused real-filesystem/scripted-wire
oracles verify immutable live media, exact latest-row/Stop races, cold child
images without Resume, unavailable private paths without a materializer and a
six-image cold page that retains no unowned/pending capture after publication.
Source behavior references exact retained61d90fd
`packages/adapter-codex/src/images.ts`. No vendor/provider/native process was
executed for these additional checks.

Native user-message correlation projects `native.originalId` only when the native
item explicitly publishes `clientUserMessageId`. Item IDs, text and timing never
substitute for that receipt evidence; the retained client can clear an optimistic
Send only from the exact published original identity.

Finite cold readers expose a pure `usable` fact so a retained conversation can retire an expired/exhausted helper before acquiring a new readonly attachment. The property admits no work; failed cleanup still retains the original owner.

Actual child page work now holds that native history residency until its complete RPC/media promise settles, even without a UI observer. Completed proved Codex children remain readonly-readable while callback ownership stays closed. Bounded child churn can evict the window only after actual read release. The adapter owner oracle exercises that exact race.

## F07 native contracts and typed lifecycle integration

Portable Codex settings, messages, commands, model/read DTOs and immutable media
asset descriptors live in `codex/contracts.ts`. Explicit Node construction,
request/wire, resource lease, input-materialization and control-read ports live
in `codex/node-contracts.ts`. Implementations are under `codex/server/`; the
existing public `codex/node.ts` is an explicit facade. The split changes what a
router or codec borrows: control reads receive `CodexControlReads` and codecs
receive one `CodexRequestPort`, with no private adapter options, allocation,
close, Stop or reconnect capability.

`CodexNative` carries the actual command, message, requested-selection and
observed-selection schemas through the default lifecycle. Observed model/access
facts can be absent; they are never reconstructed from trusted requested
defaults. A retained observed Reopen must positively include the needed model
and access facts or refuse before allocation. Deliberate requested overrides
remain distinct. The existing unknown-permission Reopen oracle passes raw
observed facts through that observed branch; parsing them as requested input in
a fixture would itself fill defaults and invalidate the oracle.

The native defensive malformed-Send oracle still sends the malformed raw value
to the adapter through an explicit test-only type escape. It does not parse and
throw in test setup. Direct public-path injection refuses at the actual adapter;
normal lifecycle Send now performs pure schema validation before journal
admission. Native effect uncertainty, exact original identity, parked custody,
read helper ownership, callback tokens and Stop semantics remain unchanged.

Focused F07 evidence: strict compilation of both native public entries and their
owner tests passes; the first sequential five-file mock suite passed 47 cases
and found one new fixture error. The fixture supplied a function-bearing
NativeOpening where canonical OpeningCapsule data was required; after correcting
that test input, its single affected Copilot case passes. Existing 47 cases were
not replayed. This is 48 selected unique scripted cases, not fresh native/vendor
qualification. The existing finite owned Node stdio framing child is reaped by
its oracle; provider/model/native-agent calls remain zero. The combined source
and publication checkpoint belongs to the coordinator.

## Native API and capture boundary amendment — October 29

The public Codex router now exposes native-shaped procedures. `thread.read`,
`thread.turns`, `thread.items`, `model.list`, queues, goals, background terminals,
thread/turn settings and turn start/steer/interrupt retain their pinned native
parameters and full results. Native item-anchor cursors, turn parent/root
identity, per-turn service tier, context, structured output, queued inputs,
reasoning options and granular permissions therefore survive the boundary.
The router is the public procedure contract; clients infer it through tRPC.
There is no public super-command or separate method/result registry.

The source is the exact Codex0.162.1 generated TypeScript and JSON Schema study.
`test/codex/generate-protocol.ts` copies only the selected methods' reachable
native type closure, normalizes ESM import suffixes and generates static Zod
codecs. The closure includes238 type files because Thread/ThreadItem include
native media, tools, permissions and child metadata. It does **not** advertise
238 procedures: this surface selects23 native methods and27 notification kinds.
`codex/protocol/provenance.json` records every original source hash; the vendor
Apache license and notice are retained. Run the generator offline against that
exact study, then apply repository Prettier formatting. The checked-in generated
code has no CLI, provider, native-home or sibling runtime dependency.
GitHub collapses this generated closure by default; review the pinned provenance,
generator and handwritten native contracts/router before expanding vendor DTOs.

Effects use `{originalId, run, params}`. Native input validation precedes the
existing lifecycle `sessions.command`, which durably admits the original in the
same journal before dispatch. Full native results are decoded into the shared
`Receipt<Result>`; acknowledgement is not completed model work. Turn/steer
original IDs are supplied to native correlation when omitted, and a conflicting
explicit native client-message ID refuses before dispatch. Native effects target
the managed root; selected-child history authorization grants no child controls.
No mutation is retried to recover a reply.

`observation.snapshot/watch` expose one attachment's bounded native capture.
Snapshot contains assembled native state and a bounded raw event suffix. The
shared pure `codex/capture.ts` reducer serves Host capture and client hydration;
the suffix is not reapplied over an assembled checkpoint. A fresh viewer can
therefore receive an in-progress item after its start left the replay ring.
Host state and replay are each capped at 256 KiB, including custom observation
limits; oversized retained state is evicted with explicit omission. Their
snapshot/frame envelope stays below 768 KiB, with headroom inside the published
bridge's default 1 MiB logical control frame. The native notification input
limit remains 256 KiB. These are fixed local limits, not a second transport
configuration or a promise of complete native history.
Local attachment/revision cursors establish only Host observation order.
Coverage remains `bounded-observation`, with native continuity explicitly
unproved and omission visible. Watcher cancellation releases that watcher;
native work and capture continue. Historical reads never update this live base.
The local `coverage.openedAs` fact distinguishes created/resumed/unknown
attachments. A known-created empty root with intact capture needs no initial
history read; an empty resumed/unknown capture remains a cold-history exception.
Root creation does not prove a separately selected cold child empty.
Snapshot/frame JSON cloning also removes repeated object aliases required by
the pinned transport's plain DTO tree contract. Vendor serde_json declarations
stay unchanged; the validated read/frame boundary records its truthful JSON type
intersection for ordinary tRPC serialization.

The former HistoryWindow remains an optional derived presentation/activity
adapter for existing composition. Failure to decode a valid native item there
cannot remove the native observation or gate native-shaped controls. Root and
proved children retain exact thread identities. Cold child reads prove bounded
metadata ancestry in the existing RPC attachment; they never Resume the child
or manufacture its live callback ownership.

Native callbacks use the existing CodexRpc ReverseRequest handle and one-shot
reply guard. Control-only `callbacks.pending/watch` return the exact supported
native request DTO and opaque run/attachment/JSON-kind request-ID/incarnation
reference. `callbacks.respond` validates the matching response schema and uses
the same original journal before invoking that handle. A durable response says
only `submitted:true`; native resolution/withdrawal/wire loss remain separate
facts. Reused or stale references cannot write another answer. The optional
normalized popup adapter derives from the same handle, without becoming a
second response authority. Private elicitation URLs remain out of public
observation/history and require control access in the callback lane.

Managed creation/Reopen policy is deliberately smaller than native settings.
Explicit requested effort-only Reopen refuses before allocation when it would
require inventing sticky collaboration instructions. A complete explicit
collaboration selection applies through a separate acknowledged settings RPC;
known observed instructions remain intact. A retained observed effort without
collaboration must match the native Resume fact. Granular native permissions
remain visible in native DTOs but cannot be silently converted into the small
managed access selection: an unrepresentable observed policy blocks Reopen
before allocation. The unsupported legacy `on-failure` approval spelling is
rejected by managed selection rather than accepted and ignored or defaulted.
Full-access/on-request remains the new managed default. Native lifecycle
Create/Reopen/Stop continues to belong to06; this is no new native creation API.

The earlier public control-facade tests are updated at their real owners.
Normalized popup original-hash/dedup evidence remains an internal lifecycle
oracle; native callback custody has its own actual router/original oracle.
The removed OAuth facade's private-query wrapper test is retired; internal
private-link lifetime tests remain, and native callback control-only privacy is
verified at the new public boundary. OAuth management, all173 upstream methods,
real native/provider operation and deployment are not claimed by this subset.
The five new native API oracles use actual SQLite/default lifecycle/tRPC with
scripted native wires, plus bounded capture. They prove exact native DTO
forwarding/result preservation, same-original dedup, cold ancestry without
Resume or capture writes, one-response callback custody without a normalized
popup owner, projection independence and bounded observation cleanup/replay.
The existing sticky-instructions/Reopen and unknown-permission oracles now
cover acknowledged full Reopen selection and preallocation refusal instead of
accepted-but-unused overrides. No real Codex, model, provider, existing session
or service was exercised. Combined checkpoint evidence belongs to the stack
integration owner.
