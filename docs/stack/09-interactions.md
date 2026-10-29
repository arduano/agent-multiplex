# 09 — Native callbacks, optional suggestions and MCP

This browser-safe layer owns exact callback capabilities and separately retained
MCP management work. It imports only the protocol entry point. Definitions,
construction, reading and subscribing perform no I/O. Concrete native methods,
wire encoding, child ancestry, transport, persistence and React are later layers.

## Callback ownership and forms

`InteractionOwner` belongs to one exact `{run, attachment}`. A harness supplies a
private opaque capability object, normalized prompt, proved native-agent owner
and reply function through structural `CallbackSink`. The public reference binds
that run, attachment and monotonically assigned incarnation. Vendor request IDs
alone never identify capabilities. Overlapping ID reuse with a new capability
fences both without replying to either. An adapter's claim of child ancestry is
trusted input here; checking a different native ID does not establish ancestry.

The public discriminants are `codex.command`, `codex.file`, `codex.permission`,
`codex.question`, `codex.elicitation`, `copilot.permission`, `copilot.question`,
`copilot.plan` and `copilot.elicitation`. Offered decisions/actions retain exact
identity. Codex permission responses choose deny/turn/session for the requested
capability; this layer does not invent subsets or broader grants. Adapters retain
the native decision payload privately and encode only the validated selection.

Question answers preserve each question's selected native values and separate
`extraInfo`. Native adapters must preserve that order when appending context;
equal selection/context strings are still distinct positions. Copilot freeform
and offered-choice semantics remain different, including whether extra context
is supported. Missing required answers, an empty selection, false, zero and an
explicit empty string are not interchangeable. No default is silently submitted.

The primitive form subset validates strings/enums, finite numbers/integers,
booleans and arrays of offered strings, with exact requested field names and
constraints. JSON Schema string lengths count Unicode code points. Unsupported
nested schemas or constraints fail closed instead of being silently removed.
Field errors and final dispatch share validation. Unsupported elicitations can
decline/cancel but cannot accept; verification DTOs expose only a validated HTTP(S)
origin. The exact verification URL, which may contain a secret, stays with the
adapter for a later scoped verification-address boundary.

`dispatch(reference, original, answer)` runs on the existing lifecycle's **fresh
durably admitted original** path. This owner validates original scope/identity;
it does not establish persistence or replace the original journal. The same
response joins one submission. A different answer/original conflicts. Returned
submission is weaker than positive native settlement. Lost writes stay unknown
without retry. An exact native confirmation wins over a later failing write.
Viewer detach and disconnect never deny or cancel callbacks. Only a matching
positive `confirmedStopped` proof retires the exact run/attachment.

Defaults retain 128 unresolved capabilities and 32 recent terminal metadata
entries, with 64 listeners, 64 KiB normalized prompt and 16 KiB answer limits.
Capacity counts unresolved custody, not lifetime operations. Terminal native
reply closures are released; bounded canonical answer identity remains private
for exact recent duplicate/conflict checks. Evicted references fail closed.
Permanent original deduplication belongs to the Host journal, not this RAM cache.

## Optional presentation

`optionalQuestions` accepts only recorded structured `{title, options}` data:
eight questions/eight options, whole strings up to 500/200 characters, bounded
12 KiB presentation and honest omission counts. Suggestions stage ordinary draft
text in a later client; they are not blocking callbacks or hidden Sends.
`proposedPlan` recognizes one complete pair of standalone `<proposed_plan>`
markers outside code fences. It provides display structure only. A native plan
occurrence, current mode, complete body and current-root provenance are still
required by a later plan action. Plain prose and bullet-question heuristics are
intentionally retired because they cannot prove native semantics.

## MCP resource owner

Static `PrivateMcpServer` descriptors cover local stdio and HTTP startup. The
allowlisted public projection excludes commands, args, cwd, environment, headers,
URLs and private-configuration hashes. Enabled routine tools acquire no extra
framework approval. A real server-requested confirmation always enters the exact
callback owner; it is never bypassed by routine-tool policy.

`McpOwner<Reload, Login>` receives adapter-specific typed ports. Explicit fresh
journal-original dispatch starts one login/reload operation. The owner retains it
through observer expiry, abort, lost replies and viewer unmount, without retry or
another outbox. Public handles only observe; their snapshots contain no input or
private result. Submitted is weaker than confirmed. Unknown operations remain
protected, and positive Stop cannot free an outstanding native call's actual
reservation. Defaults bound unresolved/actual work to eight, recent terminal
metadata to 32 and listeners to 64. Lifecycle remains responsible for permanent
original deduplication and custody across process restart.

## Declarative form validation

Layer09 owns strict Zod schemas for normalized primitive fields, the supported
native form subset, all nine prompts and their answer shapes. Unknown keys,
scalar types and bounds decode at that boundary. Canonical JSON still rejects
accessors, non-data values and byte/structure excess before schema decoding;
public failures keep closed INVALID/UNSUPPORTED codes and field errors contain
only fixed messages. Returned DTOs remain frozen.

Offered-choice membership, exact question ownership, supported-mode decisions
and answer submission remain explicit domain rules. String answer lengths count
Unicode code points. Per-question extra information stays separate from selected
values. Named dictionaries decode through entry tuples so a legitimate own
`__proto__` field is validated and preserved rather than silently omitted by a
record parser. This change adds no capability, reply, persistence or native work.

Focused strict compilation, scoped ESLint and all14 existing/adjacent interaction
owner oracles pass after this replacement. The added form case preserves strict
unknown-key refusal, native field names, accessor nonexecution, Unicode lengths
and the existing large-plan limit. This is model-free source validation; native
wire, provider and browser qualification remain separate.

## Provenance and checks

Reference: `61d90fd1cb356ccf15a7d681f8d896e38196ef9d`,
`primitives/v8-interactions/src/{contracts,native,owner}.ts`,
`primitives/v8-mcp/src/{contracts,owner,read-pool}.ts` and
`primitives/v8-history/src/native/codex/questions.ts`. This replacement retains
exact capability, primitive validation, real-operation and observer-lifetime
invariants without the old Session/client workspace or vendor normalizers.
V7's `apps/web/src/client/interaction-questions.ts` and
`virtual-transcript.tsx` establish per-question extra context and optional draft
suggestions; their permissive fallback IDs and prose inference are not authority.

Focused strict compile plus 13 model-free tests cover all nine forms, exact
choices/context, unsupported schemas, missing/empty distinctions, once-only
dispatch, overlapping ID reuse, early confirmation, Stop fencing, unknown
capacity, rolling terminal metadata, secret-free MCP DTOs, retained login work,
expiry/abort and explicit markup. The initial owner test caught canonical answer
identity being dropped at confirmation; retaining bounded recent identity fixed
exact duplicate observation without redispatch.

```sh
node node_modules/typescript/bin/tsc --target ES2023 --lib ES2023,DOM,DOM.Iterable --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --verbatimModuleSyntax --noImplicitOverride --noFallthroughCasesInSwitch --types node --rootDir . --outDir .build/interactions-lane src/interactions/index.ts test/interactions/owner.test.ts test/interactions/forms.test.ts test/interactions/mcp.test.ts test/interactions/optional.test.ts
node --test --test-concurrency=1 --test-timeout=10000 .build/interactions-lane/test/interactions/owner.test.js .build/interactions-lane/test/interactions/forms.test.js .build/interactions-lane/test/interactions/mcp.test.js .build/interactions-lane/test/interactions/optional.test.js
```

No native process/model/provider, network, installed state or service is used.
Native callback mapping, native confirmations, live MCP login/reload and browser
form rendering remain separately qualified adapter/client/UI responsibilities.

Independent checkpoint: the unmodified interaction code at source `3fc93f0`
was archived (SHA-256 `48bf2d21b179209a02d96f7f753eff740d00afc887e8ecb23c343cc48b6aef1f`)
and passed own locked install, strict types,40-module boundaries, all13 focused
interaction/form/optional/MCP cases and clean build. After the06/07 ownership
amendments, the same interaction commit was replayed as `b49067c`; a separate
archive (SHA-256 `de74b0acf1ae33f4f5f5f7ffd789fd4b899c771a49e9082a229c6c79c835de0f`)
passes strict types,40-module boundaries and build against that revised ancestry.
The unchanged13 owner oracles were not rerun for the ancestry-only replay. This
later annotation changes documentation only. No native/model/network effects.

Integration adds the structural `CallbackDispatcher` interface matching the
existing InteractionOwner.dispatch method. Adapters can consume the lifecycle's
exact admitted original without importing a concrete callback owner or creating
another journal. No callback ownership/state implementation changes here.

## F07 contract-first amendment

Callback/MCP options and handles now live in `interactions/contracts.ts`; the same owners, schema decoders and optional-prompt algorithms live under `internal/`. The facade names each public operation; no second journal, dispatcher or model/session owner was added.
