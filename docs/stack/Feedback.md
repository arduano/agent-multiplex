# Review feedback

This ledger records owner feedback while the public reconstruction stack is under
review. An item is addressed only after its code/documentation and bounded checks
are published; earlier evidence remains tied to its original source.

| ID  | Feedback                                                                                                                                                                          | Owner layer                                | Status    | Resolution                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 | Use `.ts` for non-JSX files, executed with `tsx`; reserve `.tsx` for actual JSX.                                                                                                  | 02, 04, 16, 19, 24, 25                     | Addressed | Fifteen non-JSX paths renamed; strict source/build, consumer, browser, Nix and layer gates pass. Existing stack amended.                                                                                    |
| F02 | Separate PR 03's durable journal into self-contained machinery with a strict public interface; consider an independent package only where it clarifies ownership.                 | 03 and its consumers                       | Addressed | Portable structural journal ports now isolate SQLite/private-file construction and cleanup. Writer identity survives faithful wrappers; original durability algorithms are unchanged.                       |
| F03 | Make interface-strict modules the default for self-contained business or platform logic, and update core documentation.                                                           | 02 and module review notes                 | Addressed | Document the module rule and use the journal extraction as a concrete audit.                                                                                                                                |
| F04 | Replace repetitive handwritten shape/type/key validation with Zod, starting with `src/interactions/internal/forms.ts`; keep only genuine state-dependent rules in explicit logic. | 09 and core guidance                       | Addressed | Strict Zod forms preserve code-point bounds, accessor safety, error categories and own dictionary keys. Five other codec areas remain queued below.                                                         |
| F05 | Use framework-neutral tRPC routers/adapters end to end over p2prpc and Gateway-to-browser; remove the parallel hand-rolled HTTP protocol.                                         | 13, 14, 15, 19, 20 and integration oracles | Addressed | Preserve authentication, routing fences, exact originals and observer cancellation through the tRPC transport adapters.                                                                                     |
| F06 | Make Gateway server, browser/client and shared portable roles visible in the source folder layout without scattering feature ownership.                                           | 13, 19 and import-boundary tooling         | Addressed | Group Gateway implementation in `gateway/server/`, reference process composition in `reference/server/`, keep `reference/ui/` and existing client modules separate, and enforce the runtime graph boundary. |
| F07 | Promote feature contracts, isolate coherent owners and preserve exact capabilities.                                                                                               | 04–23 and boundary tooling                 | Addressed | Root contracts, private implementations, concrete native schemas and borrowed UI/service/resource ports; see [interface map](Interfaces.md).                                                                |
| F08 | Use actual tRPC routers/clients; infer generic type-only contracts from tRPC internals.                                                                                           | 02, 05, 13–15, 19–20 and acceptance        | Addressed | Remove the generic RPC envelope and wrapper routers; actual typed endpoints, official HTTP links and direct p2p Host binding replace them.                                                                  |

## F04 follow-up inventory

The forms rewrite is the first implementation. These related module-sized items
are recorded as **queued**, rather than claimed fixed by that rewrite:

- **Client ingress codecs:** `src/client/internal/session-entry.ts` and
  `src/client/internal/validation.ts`. Decode command, persisted-entry, receipt and file
  descriptor structures once. Keep current-run scope, monotonic outcomes, byte
  admission and restored-pending uncertainty with SessionEntry.
- **Separate vendor codecs:** `src/codex/server/reads.ts` and `src/copilot/server/reader.ts`. Use
  each vendor's schemas for models, observed settings, goals/terminals/MCP and
  queue/tasks. Preserve accepted future native fields through deliberate projection;
  keep cursor, expected-thread and lease checks with the adapter.
- **History frame codecs:** `src/history/validation.ts`. Schema row/body/edge/gap/
  activity containers while retaining merge order, revisions, gaps and scope
  decisions. Reconcile its canonical walker separately with protocol guarantees.
- **MCP configuration codecs:** `src/interactions/internal/mcp.ts` and Codex configuration
  input. Separate private transport configuration from the allowlisted public
  projection; keep policy, redaction and lifecycle responsibilities explicit.
- **Remote Catalog snapshots:** `src/catalog-remote/client/retained.ts`. Decode complete
  portable listing/entry shapes before publication. RetainedCatalog continues
  to own row/byte limits, expected Root identity and reconnect/stale behavior.

Descriptor-aware canonicalization, UTF-8 budgets, exact lifetime proofs, private
filesystem handling, native RPC framing and stream ordering remain explicit
algorithms. Zod does not prove authority, completion or effect ownership. Schema
work must preserve existing error categories and unknown/unsupported facts; it
must not execute getters or coerce missing observations into authoritative values.

## D01 — Native tRPC streamed return values

Owner note: tRPC can return an AsyncIterator or deferred Promise inside a query
or mutation result; do not invent a subscription when a streamed operation fits
better. The pinned HTTP11.18 implementation supports this through
[httpBatchStreamLink](https://trpc.io/docs/client/links/httpBatchStreamLink).

The pinned `@arduano/p2prpc-core`0.3.0-renewal.2 link has a different capability:
query/mutation responses are unary, nested Promise/iterator values are not
supported wire data, and a second unary data frame is rejected. This is verified
from the installed published codec/link, not a live transport qualification.
Subscriptions remain the shared primitive for the current long-lived feeds.
No custom stream tunnel or dependency rewrite is introduced to emulate missing
transport support. Future query/mutation stream APIs must state their actual
transport requirements; HTTP support alone does not establish p2prpc support.

## F07 — Contract-first feature boundaries

Status: addressed; combined source, prefix, consumer and browser checks pass.
The owner authorized the [triaged interface map](Interfaces.md) after its read-only
review. Amendments belong to each feature's existing numbered PR; no extra
framework/package, journal, registry or state owner is introduced.

- Lifecycle/native schemas validate Send and requested settings before admission,
  preserve real router inference and distinguish requested intent from partial
  observed facts. The record-version/API break is explicit.
- File/asset/history ports distinguish borrowed capability from owned cleanup;
  exact store, lease, read-fence and budget identities remain authoritative.
- Native adapters expose named RPC/SDK/read/media ports and typed domain results;
  private startup inputs and implementation folders stay separate.
- Retained client, hooks and renderers receive read/draft/anchor/submission ports;
  only composition holds residency and owner-close controls. Child transcript
  rendering does not fabricate parent-session state.
- Catalog, routing and conversation routers borrow their actual service API.
  Application and UI composition inputs are inert root-level contracts.
- The existing checker now rejects contracts that alias concrete owners, private
  nested-index imports and accidental portable runtime dependencies. Exact
  acquired containment and derived tRPC router types remain reviewed exceptions.

F04's five queued codec rewrites remain queued. Promoting a schema/DTO or changing
a type boundary does not claim those wider vendor/history/client codecs fixed.
No Personal API compatibility, installed-state migration, native/model session,
service, deployment, merge or unresolved P14 transport qualification is implied.

## F08 — Proper tRPC across both paths

Owner instruction: “we must use proper trpc. If you want a generic type-only
contract, then do type inference from trpc's internals.” The actual routers own
procedure names, input/output types, parsers and middleware. The Gateway owns
routing metadata and authorization, with actual tRPC clients on either side.
See the owning-layer notes and [interface map](Interfaces.md). F07's original
source/consumer/browser evidence remains historical; current source and runtime
evidence is recorded separately after the F08 checkpoint.

The quiet HTTP cancellation counterexample exposed a real producer-lifetime
requirement: an outer SSE generator cannot close a producer while its `next()`
is held. Actual Host/Catalog procedure abort now closes that exact iterator.
Old envelope-based tests are replaced by real procedure-path, method, schema,
receipt, grant, routing, privacy and cancellation oracles, preserving their unique
invariants. F04's queued wider codecs and historical P14 remain unresolved.

### Simplicity and test retirement

Owner follow-up: do not hand-roll links or types, and do not add redundant tests
for complications introduced by our own approach. Applications now compose
`createTRPCClient` and official links directly. The generic HTTP client factory,
copied option/transformer types, remote router reconstruction, procedure inventory
and custom forwarding buffer are removed. Remote exposure belongs to explicit
application tRPC resolvers calling the borrowed typed peer client.

The entire procedure-client wrapper test suite and generated-router-only checks
are retired with those implementations. We do not replace them with tests of
dependency methods, null/undefined serialization or transformer configuration.
Existing owner-level authorization, exact original, route fence, observer custody
and real HTTP/browser recovery oracles remain. Simplicity is a design constraint,
not another behavior to instrument.

## F09 — Standalone end-to-end bridge

Owner authorized merging p2prpc48, then amending this same stack. Browser/Host
procedures use the actual Host router and published bridge; Gateway owns routing
leases, not proxy resolvers. Binary files use the existing dependency engine;
asset business scope/quota/publication/native-input ownership remains. The
interface map and13/14/18/19 describe the contract. No Personal compatibility,
Multiplex merge or deployment is included. Explicit upstream lifetime/capacity
limits remain visible while further hardening is deferred.

## F10 — Harness-shaped Codex routers and demo extensions

Owner authorized implementation of harness-shaped APIs with ordinary composable
tRPC routers and concise TypeScript generics, focusing on Codex and demo
extensions. Native Codex DTOs and generated Zod codecs are pinned to the source
revision documented in10. There is no universal native schema, copied client
method inventory, router reconstruction or replacement transport.

Lifecycle routes retain Create/Reopen/Stop/archive and exact-original reads.
Messaging and native controls belong to each harness router. The same durable
original journal admits effects before dispatch; native callbacks borrow the
existing one-shot reply capability. The shared native capture reducer feeds a
retained Codex client with independent history pages/anchors and thin React
bindings. History reads are evidence, not native stream watermarks. The old
normalized history/interaction integration remains optional presentation.

Creation-time Host extensions compose actual routers. An inert Gateway identity
and inferred associated router type connect Gateway-owned additions without
importing their server implementation into the Host runtime. The Codex example
shows a Host workspace read and Gateway summary. Compiled types flow through
ordinary official tRPC clients and published p2prpc, not runtime-generated APIs.

Removed public lifecycle Send/control and old Codex facade type cases are
replaced by native-router inference and actual adapter/journal oracles. Existing
unique native allocation, Stop, original, callback privacy and presentation
checks remain with their owners. No test is added merely to assert a deleted
wrapper is absent. Exact current source/browser/consumer evidence and retained
failures are in Evidence.json; this entry makes no native-provider, real-relay,
Personal compatibility, merge or deployment claim.
