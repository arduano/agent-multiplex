# 20 — Typed remote Root catalog

This layer exposes the existing12 Catalog authority through its actual typed
tRPC router and an explicit authenticated HTTP endpoint. It adds no catalog,
journal, workflow, native lifecycle or mutation retry owner. The official Fetch
adapter receives that router and its authenticated context directly. A fake
native session, default lifecycle and Gateway selected-Host mount are unnecessary.

## Public contract

`./catalog-remote` exports browser-only DTOs and RetainedCatalog. The Node entry
exports catalogRouter and catalogEndpoint. The separate typed client entry
exports `createCatalogClient(remote: TRPCClient<CatalogRouter>)`, which keeps
only the domain-specific catalog feed adapter. Applications/fixtures construct
that actual client with `createTRPCClient` and official links directly; there is
no generic framework HTTP client/link factory. The application supplies the Root's
ordinary HTTP endpoint URL. Inferred server/router declarations
require Node ambient types, like other typed tRPC consumer contracts. The standalone retained projection has no such dependency.

The router offers paged list/get, bounded absolute-snapshot watch, exact original
lookup, explicit Create, revision-CAS metadata patch, Create reconciliation,
Archive publication and exact Archive reconciliation. Connection/principal come
only from the authenticated actor; requests cannot select them. Authorized target
Hosts filter listings and fence all per-session operations. Create additionally
requires an injected target/owner/contract policy. The Root must own the same
authority as its route. Exact route epoch and contract/composition are checked
again by the authority's endpoint context; native session targets are rejected.

Application authentication derives delegated rights from verified transport
state. Claimed request headers or routing metadata are not authentication. Applications
supply public Root descriptor identities and auth/revocation policy; generic catalog
code does not invent login, pairing, private sharing or a universal topology.
Revoking/closing the endpoint seals new admission and releases its exact watches;
actual already-admitted Catalog calls remain owned and settle before close.
The endpoint does not close an injected Catalog or its journal.

A watch publishes the scoped query immediately, then coalesces only whole
absolute snapshots. It retains one latest result and one waiting next(), with64
observers by default. Quiet return releases only that observer. A page has at
most100 rows; serialized snapshots are bounded to1MiB by default. Overflow is a
refusal, not invented completeness or silent metadata truncation. Pagination,
matching count and unobserved pins retain12's explicit snapshot coverage.

RetainedCatalog is one bounded projection separate from per-conversation
RetainedWorkspace. Construction is inert; explicit commit opens observations
through the existing ObservationSupervisor. Disconnect preserves last rows
marked stale, and reconnect observes a new authoritative snapshot. No mutation
is reachable from this owner. It verifies authority/account identity and row/
byte/count bounds before publishing. Dispose/close clears its projection and
seals late delivery while awaiting actual observer release. Query/pin selection
is captured once; changing it uses another explicitly owned projection.

Create, metadata patch and Archive publication use the caller's original ID in
Catalog's existing journal. Lost replies are checked through original lookup or
exact read-only reconciliation. Observer reconnect never calls a mutation. CAS
conflict remains a positive refused receipt. Archive publication reads existing
Host Archive evidence; it cannot issue Archive or Stop on that Host.

## Separation from the Host bridge

Gateway13 exposes only its own topology over ordinary HTTP tRPC. Its separate
WebSocket route relays a native Host bridge; that bridge terminates actual Host
RPC/files and has no authority over Catalog records. A Root's ordinary typed
HTTP endpoint therefore remains independent of browser bridge admission and
per-peer file ledgers. Connection/principal scope comes from the selected
endpoint's verified authentication, never from a logical bridge peer ID.

RetainedCatalog's observer can reconnect for a fresh authoritative listing.
That does not create a Host channel, refresh a native lifetime or replay Create,
metadata changes or Archive publication. A short browser carrier outage, bridge
TTL expiry, page reload and a fresh Host process have different lifetimes; none
allows Root to infer the outcome of an unknown Host effect from present topology.
Exact Host original evidence remains the Create/Archive reconciliation boundary.

## Historical focused proof and limits

At the original layer checkpoint, focused strict NodeNext/ES2023 compilation
passed for its source and tests. The actual SQLite→Root router→Gateway→loopback Node HTTP→typed tRPC client case
passed in1.292s after namespace/disposal hardening. It proves a lost Create reply
is resolved by exact original lookup with one scripted Host Create, authenticated
account isolation, CAS rename/refusal, stale rows during disconnection, fresh
snapshot after reconnect without replay, and existing Host Archive proof
publication. A second pure retained-owner oracle passed in1.5ms: construction is
inert, foreign authority cannot replace its projection, disposal redacts rows,
and late delivery stays fenced. A compile-time counterexample rejects a native
Stop on the Root catalog router. Earlier12 catalog invariants were not copied.

The Host creation/proof port is scripted; this is real SQLite/HTTP/router/client
integration, not native Host or provider qualification. No native CLI, model,
provider request, production service, private application or live identity was
used. Both observer owners, Gateway/endpoint, HTTP listener and SQLite writer
closed, and the disposable directory was removed. Dynamic application list/
creation UI, private delegation policy and native/platform acceptance remain
consumer/integration work. No existing deployment or older module changed.

## F07 contract-first amendment

The actual tRPC router and endpoint borrow `CatalogAuthorityPort`; private
authority options are not inspected. `node-contracts.ts` names endpoint
authentication/authorization inputs. Inferred router types remain derived from
the real endpoint, and the browser projection remains a consumer rather than
another catalog authority.

## F08 — Actual tRPC boundary

The catalog endpoint exposes its actual router/context; its domain client
accepts `TRPCClient<CatalogRouter>`. Manual RPC invocation, JSON result cloning
and Gateway-specific watch wrappers are removed. The actual service tracks
admitted resolver settlement and owns its quiet observer cleanup. Request abort
closes the actual producer; closing an endpoint cannot close Root/native custody.
Already aborted requests are refused before procedure admission; an admitted
Create remains owned until settlement. The loopback oracle retains exact
lost-Create receipts and one effect, scope/error redaction, recovery and cleanup.
It composes official clients/links at the fixture site and uses a finite
five-second positive-freshness deadline because pinned EventSource waits three
seconds before reconnecting. Earlier checkpoint results above remain historical;
this source/fixture simplification is not a renewed native or browser claim.

## F09 endpoint simplification

The current endpoint composition uses its own actual router with the official
Fetch adapter and ordinary typed client. It has no dependency on selected-Host
HTTP mounting in Gateway13. Scope, immutable originals, authority, CAS, quiet
observer cleanup and no replay remain the domain contracts. A session target is
refused by the catalog endpoint. The source gate for this amendment is separate
from the historical timing records above; no new transport or rollout claim is
made here.
