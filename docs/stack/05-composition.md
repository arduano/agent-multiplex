# 05 — Static typed Host composition

This layer adds the kernel that activates one selected lifecycle, one harness
definition and named trusted static extensions. It does not implement a native
agent, workspace allocation, catalog, transport, retry loop or client store.

## Contract and ownership

`defineHost` validates inert public identity and retains the supplied factories;
it opens no storage, invokes no factory and starts no process. `activateHost`
explicitly opens the lifecycle, then builds its native and extension routers.
Native families are inferred string literals, not a closed Codex/Copilot union.
An adapter can add structural ports to its harness definition without importing
any default lifecycle, interaction or history owner.

The selected lifecycle returns the actual session owner and its router. Its
`readiness` and `close` govern native/effect resources; the kernel has no Stop,
Resume, adoption, fallback adapter or effect journal. Extensions depend on that
same session owner. Factories own partial acquisition until they return. The
kernel takes custody of every returned owner before validating extension names
or metadata, including owners returned under later invalid keys.

The actual tRPC router contains `system`, `lifecycle`, `native` and `extensions`.
The existing admission guard is also exported as the actual tRPC
`hostMiddleware`. Extensions with a richer context reuse that middleware through
their own builder; there is no copied authorization guard or generic context bag.
The kernel's authenticated context stays independent of transport capabilities.
`HostRouter<typeof definition>` and the type-only `PublicHostContract` preserve
native input/output and extension DTO inference. A future Claude Host's client
cannot call Codex methods or an unregistered VM extension. TypeScript is not an
authentication or permission boundary.

Host customizations use the existing `extensions` namespace. A separate optional
`gateway: GatewayContract<typeof actualGatewayRouter>` associates Gateway-local
custom routes at definition time. The contract value contains only ID/version;
its optional unique-symbol witness carries the actual tRPC router type without
loading or serializing handlers. A contract module can type-import the actual
Gateway router while a Host imports only the inert identity value.
`PublicHostContract<typeof definition>["gatewayRouter"]` preserves that inferred
client contract. The manifest and composition identity include the Gateway
contract ID/version, so a different customization cannot use the same route
proof. No Gateway handler is mounted or activated by the Host. Layer13 supplies
the actual Gateway runtime and mounting; discovery selects already compiled
contracts and does not generate types or executable code.

Lifecycle, native and extension routers must use `hostProcedure`. Its gate
requires an active kernel context and read/control authority, then retains
finite procedure admission through actual procedure settlement. Domain owners
enforce finer scope and original admission. A subscription's returned stream
retains its own observer lease; returning a stream is not an admitted native
effect. Future transport code must use the selected Host's `context(call)` with
its own router, rather than constructing or mixing contexts.

## Failure and close rules

The context gate checks exact configured authority/Host/owner/route epoch,
expected public contract/composition and any requested session generation. It
checks activity again after asynchronous authentication, snapshots authenticated
values and supplies a nonserialized activation capability. An old saved context
cannot admit a procedure after close. The gateway/Host verifier still owns
proof cryptography, revocation and actual native-generation authorization.

Close seals admission before observing readiness. In-flight finite procedures
refuse close. A mere readiness observation cannot prove the fence remains idle;
its result is checked again after awaiting owners. A readiness refusal performs
no resource release and leaves the Host usable. Successful close releases unique
extension owners in reverse declaration order, then the lifecycle dependency.
Aliases close their actual owner once. Close is idempotent after success.

A failed release is retained and never retried automatically. Its lifecycle
dependency remains owned; close/readiness cannot invent success. A failed
activation that cannot release returned resources throws `HostActivationError`.
`recoveryFor` restores the actual session-owner type only for the exact static
definition object; a similar manifest cannot adopt another activation. This
provides selected lifecycle controls without inventing a kernel-level Stop.

The manifest contains only public plugin identities, native family and sorted
extension identities. Private options and storage never enter composition
identity. Stored plugin ID/record-version incompatibility refuses; base
lifecycle/harness incompatibility refuses before opening the lifecycle.

## Source provenance and coverage decisions

The ownership algorithm is adapted from retained source commit
`61d90fd1cb356ccf15a7d681f8d896e38196ef9d`,
`primitives/v8-plugins/src/{contracts,host,router}.ts`. The new boundary removes
the separate plugin package, runtime kind tags, generic original-mutation helper
and restart helper. The journal remains the only place for durable originals;
native restart policy belongs to the selected lifecycle. Public contracts use
structural ports and expose the real router through a type-only projection.

The focused replacement suite is `test/host/composition.test.ts`: inert
definitions, inferred native/custom APIs, exact auth fences, close/authentication
races, procedure admission, all-returned-owner transfer, exact typed activation
recovery, failed-close nonreplay, manifest privacy and pre-open record refusal.
It replaces overlapping old kernel examples for these unique invariants.
It does not retire native/transport/SQLite or UI coverage; those owners are not
implemented by this PR.

## Qualification

Focused strict isolated TypeScript compilation passes with TypeScript 5.9.2,
tRPC 11.18.0 and Zod 4.1.5. The exact command compiles only these three Host
files and `test/host/composition.test.ts` into `.cache/composition-check` using
the repository's strict compiler options. Node's test runner then runs only the
emitted composition test with a 15-second per-test bound and concurrency one.
All ten focused cases pass. The integration owner separately checks this layer
with its declared dependency lock and complete checkpoint.

This suite uses scripted resource owners and actual tRPC callers, with zero
native allocations, model calls, fleet commands, HTTP servers or file-store
state. Its deferred operations are explicitly settled or retained as refused
resource ownership; no native lifetime exists to retire. It makes no native,
platform or deployment acceptance claim.

Independent checkpoint: source commit `5993b0c` archived with SHA-256
`d18387e8c339030256d575671e4c6937470436c08b03a6d836c4b34da0407770`.
Its own locked install and `npm run check` passed strict types,21 source modules,
all27 tests and clean build. Ten new composition oracles exercise actual tRPC
callers, compile-time negative harness/extension cases, cleanup custody and
admission/readiness races. No native/model/service actions. This later evidence
annotation changes documentation only.

## F07 interface isolation amendment

The public portable `host/contracts.ts` owns static composition, activation
recovery and typed consumer contracts. Server activation and tRPC construction
live in `host/server/composition.ts`; the public `host/index.ts` remains the
explicit Node constructor facade. `HostActivationRecovery` describes the actual
retained acquired resources after failure; moving its declaration does not add
another recovery owner or weaken exact-definition recovery identity.

Activation no longer advertises an unused `storage: unknown` dependency bag.
Lifecycle definitions close over their actual declared ports, while activation
supplies the exact Host route. Private configuration remains outside public
composition identity. Admission, authentication, failed-activation custody and
close ordering remain with the same activation owner.

## F08 — Actual tRPC boundary

The actual Host router owns safe standard-code error formatting and native
tRPC SSE settings. Its admission middleware binds subscription results to the
actual procedure signal with `closeOnAbort`, rather than relying on an outer SSE
generator to interrupt a quiet `next()`. Native effect admission and lifetime
ownership remain separate from this observation cleanup.
