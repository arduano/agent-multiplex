# Module boundaries

Self-contained business logic and platform machinery belong in self-contained
modules, even when the application using them is small. A narrow public interface
should let a reviewer understand the caller without reading the implementation.
Complex internals are a reason to isolate their owner, rather than distribute
that owner's decisions across higher layers.

A module owns one coherent responsibility, its state and cleanup, private
implementation types, dependencies, and the tests that prove its unique
invariants. Consumers import only the public entrypoint. Do not expose a database,
process handle, platform-specific state, or broad mutable context merely to avoid
writing a small domain-level operation. Composition supplies explicit resources
or ports; importing a definition acquires no resources.

Use a separate package when independent consumption, a dependency firewall or a
clear platform boundary benefits from package exports and its own manifest.
Otherwise an explicitly checked module inside the package is sufficient. Avoid
parallel registries, wrapper layers and generic plugin systems that do not remove
an actual responsibility from their callers.

For each extraction, record the owner, public operations and immutable data,
required ports, failure/uncertainty semantics, cleanup obligations and decisive
oracles. Move the existing behavior and its tests together before adding features.
An extraction should reduce the caller's knowledge of internals and preserve the
single owner of every lifetime and effect.

## Validation belongs to schemas

Harnesses expose their actual typed tRPC routers. Codex, Copilot and future
harnesses retain their own request, result, event, history and callback semantics;
a normalized conversation projection is an optional UI adapter. The framework
does not require a universal agent-command or transcript schema. Client types
come from the concrete router after lifecycle and customization composition.
TypeScript generics preserve those router types; they do not reconstruct endpoint
maps or generate types from discovery JSON.

Host-side extensions execute on the Host. Gateway-owned routes execute on the
Gateway with authenticated Host selection and grants. Their handlers and runtime
dependencies remain separate; an inert ID/version can associate a Host
definition with the type inferred from its actual Gateway router. Shared
observation and operation metadata must not change native semantics: a local
capture cursor is not a native history watermark, a receipt is not completed
agent work, and replaying observations never replays effects.

Use Zod for structured inputs at a module boundary: object shape, unknown keys,
primitive types, bounds and structural alternatives. Infer decoded types from the
schema where possible. Share the module's schema rather than rebuilding the same
contract with repeated property walks, key lists or type checks in its callers.

After decoding, ordinary explicit code enforces decisions that need current
state: who owns a callback, whether a generation is stale, whether an operation
may advance, or whether a caller holds the required capability. Canonicalization,
byte accounting, platform observations and native protocol framing are their own
operations; they should not be disguised as an additional schema framework.

## Portable and server roles

Keep a feature's browser/portable contract and its server implementation behind
separate public entries. A Node-conditional package export may expose that
feature's `node.ts` facade or its `server/` or `node/` implementation directory.
Public portable and UI exports must never load those paths or a `node:` builtin,
including through another feature's public entry. The directory rule also
protects implementations that reach native dependencies through external packages
rather than direct builtin imports.

The boundary command derives portable roots from the actual package exports,
maps their emitted JavaScript to source, and follows runtime imports, reexports
and literal dynamic imports. Node-conditional branches and declaration files do
not create portable roots. Computed dynamic imports cannot establish a portable
closure and belong behind a Node-only entry. This checks the source graph; the
browser bundle and consumer checks separately cover external dependency graphs
and public types.

Use declaration-level `import type` and `export type` for cross-role type links.
Under the pinned TypeScript `verbatimModuleSyntax` setting, named-only forms such
as `import { type Contract }` and `export { type Contract }` still emit an empty
runtime import/export and therefore load the referenced module. They do not
bypass the role boundary. Type links must still use a feature's declared public
entry; a type-only import is not permission to reach into another feature's
private implementation.

## Read contracts before implementations

Each feature puts its public values, schemas, capabilities and outcomes in
`contracts.ts`. Host-only construction inputs and private resource ports live in
`node-contracts.ts`; a vendor bridge may have a separate `sdk-contracts.ts` when
that is a real protocol boundary. `index.ts` and `node.ts` deliberately export
those contracts and selected factories. Implementations live below `client/`,
`server/` or `internal/` according to their actual role. Do not create empty
layers or an independent package merely to rename a helper.

Contracts import other contracts, rather than importing concrete owners and
renaming them as interfaces. A borrowed port includes the operations its caller
needs, excluding configuration, residency, mutation and cleanup rights it does
not own. Composition keeps the actual owner and its close obligation. TypeScript
structural substitution is useful here: a caller can implement the port without
inheriting another module's private fields. Restrict a raw vendor boundary to its
actual SDK/RPC protocol and decode its results within that native adapter.

The boundary checker rejects contract-to-implementation links, including
`import type` and inline `import(...)` types. Reviewed exceptions derive Host, native client and
demo router types from their actual composed tRPC routers, and systemd allocation
requires the actual acquired `HostContainment` capability. Replacing these with
copied endpoint declarations or a forgeable structural handle would weaken the
contract. These exceptions name their exact source, target and symbol.
Cross-feature implementation imports cannot be disguised as a nested `index.ts`;
additional public entries must be deliberate package exports.

A narrower port must preserve identity as well as methods. A matching session
scope does not prove a draft belongs to the mounted view. A copied read-fence
object does not authorize a page publication. A second structurally similar
journal, file store, containment handle or read budget cannot replace the exact
one held by its owner. Keep these identities opaque and qualify substitution at
their owners. Validate requested native settings before admitting their original;
keep incomplete observed facts distinct from requested defaults.

The completed framework's [interface map](Interfaces.md) gives the review order
and the owner of each public seam. Its individual PR notes record the checks
that establish each boundary.

## tRPC is the procedure contract

Applications use actual tRPC routers and clients across HTTP and p2prpc. Never
create a second business RPC interface with string paths, operation kinds and
JSON input/output. Routing target, delegated identity and session fences are
transport metadata; they do not replace or wrap a procedure's input. Each Host
retains its own router, parsers, middleware, native differences and
original-operation owner.

Compose official `createTRPCClient`, HTTP links and their options directly in the
consuming application. Let those APIs enforce the selected router's input,
output and transformer contract. The framework's HTTP helper only builds the
bridge routing URL; it does not add generic client/link factories or duplicate their
option types, codecs, deadlines or tests.

The Host binding registers the actual router. A browser calls the published
p2prpc `connectBridge<ActualHostRouter>` directly. A Gateway borrows only native
`openBridge`; the published relay forwards binary bytes without interpreting
procedure paths, values or file chunks. Gateway routing/delegation leases remain
separate from application sessions and native lifetime. The Host verifies the
actual Gateway plus the delegated application namespace and authorizes every
operation. No copied router, generic invocation envelope or custom client link
exists. File-only consumers use the upstream portable file entry rather than
pulling typed-router declarations into generic UI contracts.

State transport capabilities honestly. Official HTTP JSONL links support streamed
results; the pinned p2prpc dependency supports unary calls and subscriptions.
Types do not make unsupported wire values work or qualify a distributed path
that has not been composed. Connect request abort to the actual subscription
producer so quiet `next()` cannot trap cleanup behind an outer generator.
Observation cancellation never cancels admitted work. Retain tests for these
framework ownership and recovery invariants; leave SDK procedure inference and
serialization to tRPC's own tests.
