# Framework interface review map

Read a feature's contract first, then its private owner, then its integration.
This map describes the current source interfaces. Each numbered PR introduces only its own
prerequisites; amendments stay in that owning PR. Public subpaths ending in
`node-contracts` or `sdk-contracts` remain Node conditional. Portable contracts do
not import a factory, native SDK, database or React implementation.

| PR    | Contract                                                                             | Owner and boundary                                                                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 02    | `protocol/index.ts`                                                                  | Original identity, canonical JSON, receipt and observation primitives. No process or persistence owner.                                                                                                      |
| 03    | `storage/contracts.ts`                                                               | Borrowed journal operations; SQLite remains behind `storage/index.ts`. The composition owns one writer and its final close.                                                                                  |
| 04    | `runtime/contracts.ts`, `runtime/node-contracts.ts`                                  | Native opening/allocation custody and platform command ports. The acquired containment handle stays nominal; an empty observer is not Stop proof.                                                            |
| 05    | `host/contracts.ts`                                                                  | Static definitions, public schemas, activation/context, readiness and exact failed-activation recovery. The concrete router is inferred from actual tRPC composition.                                        |
| 06    | `host/contracts.ts`, `host/node-contracts.ts`                                        | Native command/message/requested-selection/observed-selection schemas, workspace strategy and lifecycle options. Private lifecycle records/codecs and Node workspace allocation stay below the contract.     |
| 07    | `history/contracts.ts`                                                               | Transcript values, read-only snapshots/feed, fenced read publication, acquisition handles and a borrowed read budget. The same history owner retains ordering, opaque fence identity and subscriber cleanup. |
| 08    | `files/contracts.ts`, `files/node-contracts.ts`                                      | Immutable file values/read leases; lookup/capture/access and owned maintenance. A stable resource identity ties a borrowed capability to the actual store.                                                   |
| 09    | `interactions/contracts.ts`                                                          | Callback/reply custody, forms, optional prompts and MCP management inputs/outcomes/handles. Implementations and schema validation stay private; no second effect journal.                                    |
| 10    | `codex/contracts.ts`, `codex/node-contracts.ts`                                      | Codex schemas/DTOs, narrow router reads, one-connection RPC requests, wire/reader/media ports and explicit private startup options. The adapter retains native lifetime and read/input leases.               |
| 11    | `copilot/contracts.ts`, `copilot/node-contracts.ts`, `copilot/sdk-contracts.ts`      | Copilot schemas and typed read DTOs, adapter/read-only history capabilities and the pinned SDK protocol seam. No Codex controls or fabricated native facts.                                                  |
| 12    | `catalog/contracts.ts`, `catalog/node-contracts.ts`                                  | Root metadata/creation workflow and borrowed `CatalogAuthorityPort`. Public authority is a fact; private journal/Host factory options stay with the owner.                                                   |
| 13    | `gateway/contracts.ts`, `gateway/node-contracts.ts`                                  | The Gateway owns its topology router, grants, epoch fencing and borrowed channel leases. Its HTTP adapter does not remount selected Host procedures.                                                         |
| 14    | `transport/contracts.ts`, `transport/node-contracts.ts`                              | Observation/relay contracts, bridge routing metadata and verified delegation. Published p2prpc terminates actual Host RPC/files; a route release cannot close its borrowed physical peer.                    |
| 15    | `client/contracts.ts`, `react/contracts.ts`                                          | Retained read/draft/original/view/anchor ports and hook inputs. The workspace alone owns entries, residency and final retirement; render/mount has no admission authority.                                   |
| 16    | `chat/contracts.ts`                                                                  | Chat, read-only transcript, native forms, Markdown/media and shared presentation inputs. Renderers see view capabilities rather than owner constructors or residency internals.                              |
| 17    | `conversation/contracts.ts`, `conversation/node-contracts.ts`                        | Borrowed lifecycle/history/budget and `ConversationService` for its actual tRPC router. Coordinates reads and observations; it cannot Resume/Send or close a native lifetime.                                |
| 18    | `assets/contracts.ts`, `assets/node-contracts.ts`                                    | Business upload/status and peer file capabilities, media and prepared native inputs. Construction transfers the exact store to one asset owner; binary transfer belongs to published PeerFiles.              |
| 19    | `reference/contracts.ts`, `reference/node-contracts.ts`, `reference/ui/contracts.ts` | Explicit scripted consuming app, inert application-factory ABI, disjoint mutable paths and UI descriptors. Composition retains real owners while exposing only their borrowed facets.                        |
| 20    | `catalog-remote/contracts.ts`, `catalog-remote/node-contracts.ts`                    | Authenticated catalog endpoint options, listing/feed and retained metadata projection. Remote views borrow authority; they never become an additional Root.                                                  |
| 21    | `attachments/contracts.ts`                                                           | Draft upload/transfer controller tied to opaque exact owner identity. UI has transfer gestures; composition retains the upload owner's cleanup.                                                              |
| 22    | `child-streams/contracts.ts`, `child-streams/node-contracts.ts`                      | Positively proved child inventory, borrowed native history and read-only transcript view. No fake parent state or independent child native lifetime.                                                         |
| 23    | `file-links/contracts.ts`, `file-links/node-contracts.ts`                            | Scoped history occurrence resolution and borrowed capture-plus-preview capability from the same asset owner. No inspection of another owner's options/store.                                                 |
| 24–25 | Existing feature contracts                                                           | Packaging and acceptance compose/qualify these interfaces. They introduce no new business owner or generic framework.                                                                                        |

## Native intent and observation

The Codex public path now follows the pinned native protocol through its actual
tRPC router and harness-specific retained browser model. Its native DTOs and
generated codecs live in `codex/protocol`, transport additions in
`codex/native-contracts.ts`, and client/React behavior in `codex/client` and
`codex/react`. Shared flat history and conversation DTOs remain optional
presentation facilities for the scripted reference and existing adapters; they
are not the required Codex client truth. Lifecycle public routes own native
creation/reopening/Stop/archive while harness procedures borrow the same
original journal for their own effects.

Host customizations retain their actual `extensions` router types. A type-only
`GatewayContract<typeof actualRouter>` associates the creation definition with
Gateway-owned routes without importing their handlers into the Host. Gateway
middleware validates the selected Host, profile, route and grants; discovery
selects a known compiled contract rather than manufacturing TypeScript APIs.

The lifecycle receives four real adapter schemas. A Send message or requested
selection is decoded and canonicalized before durable admission; invalid input
creates neither a journal original nor a native effect. Parsed schema outputs
retain the adapter's types through the real tRPC router. Codex and Copilot remain
different contracts rather than variants of one universal command surface.

`selectionSource: "requested" | "observed"` distinguishes intent from facts in
lifecycle state and explicit native opening inputs. An observed selection may
omit a model or permission fact: that absence is not a requested default. Native
reopening retains the actual adapter's existing requirements and may positively
refuse unsupported or unobserved settings before allocation. This is an API and
lifecycle record-version break in an unmerged reconstruction; no installed state
is migrated or native work resumed by these amendments.

## Identity and cleanup

The retained workspace owns one entry per identity. A view has a detachable
observation lease and its own scroll anchor; neither close nor switching cancels
an admitted original. Upload preparation is associated with the exact draft
owner. Child transcript rendering uses the same presentation contract without
claiming a parent-session mutation interface.

History reads retain their real issuing window/fence and shared budget. File
capture and preview use the same owned store, leases and resource identity.
`HostAssetOwner` owns that store after construction; composition must not also
close it. Read-only history and borrowed file ports omit owner reset/GC/close
methods. The actual owning implementation still performs them when authorized.

Routers borrow capabilities. Composition retains native adapters, feature owners,
journals and actual cleanup handles. Authentication/route checks, durable original
admission and exact outcome reconciliation remain at their original owners.
No extraction introduces another journal, recovery queue, state registry,
permission policy or transport implementation.

## Decisive checks

Unique regression oracles cover schema refusal before admission, real inferred
router inputs, partial observed facts, structural owner substitution, copied
read-fence rejection, one file-store close, exact draft binding, read-only child
rendering, ordinary class-method receivers and borrowed peer cleanup. Existing
lifetime/effect/history/error cases remain at their owners. The boundary checker additionally rejects private
implementation imports and contract aliases to concrete owners, while retaining
the two explicit router/containment exceptions. Source, consumer, browser and
packaging results are recorded separately in the acceptance note and evidence;
source refactoring does not qualify unresolved transport/native cases.

## F08 — Use the actual tRPC API

The Gateway owns its topology router and transport-neutral route leases.
Transport14 composes the published p2prpc bridge; browsers call the actual Host
router through `connectBridge<ActualHostRouter>`. Host context authenticates the
stable namespace and grants; actual bridge context supplies per-peer file
capabilities explicitly. The existing Host middleware is reusable by extension
builders with a richer context. No mutable context registry or copied router is
needed. The Root catalog may expose its own ordinary HTTP tRPC endpoint.

The browser composition retains one actual peer across session/view switches.
Retained workspace owners still own drafts, originals, histories and anchors.
Binary file transfer belongs to the dependency; asset18 retains scoped immutable
publication, quotas and leases. `FileStore.put` witnesses irreversible publication
before fallible directory durability work. Contract limits and actual current
qualification belong to14/18/19/25; types alone do not qualify a transport path.

## F09 transport and DTO boundaries

`GatewayRouter` is the actual topology API served by official HTTP tRPC. The
separate authenticated `/host` WebSocket route owns a route lease while relaying
the published native bridge channel. It does not mount or reconstruct Host
routers. `connectBridge<ActualHostRouter>` exposes the actual typed Host RPC and
its authenticated files facet. The application owns that browser peer; retained
session/view owners borrow it. Session switching does not create another peer or
close a physical Gateway-to-Host connection. Root Catalog can expose its own
actual router with official HTTP adapters and links, separately from this path.

`hostBridge` supplies `{...hostContext, bridge}` explicitly from verified
application delegation and the actual peer context. Extensions that need file
capabilities compose their richer tRPC context with the existing Host middleware
and reject missing bridge context. No mutable context registry, generic resource
bag or cast in the kernel supplies that authority. p2prpc0.3.1's `/files` entry
lends actual file contracts/Blob helpers without importing the RPC client graph.

Conversation state intentionally copies its outer `scope` when constructing the
public DTO. The nested `run.scope` can be the same logical value without sharing
the same object instance: the dependency's bounded JSON codec rejects repeated
object aliases as well as cycles. This local copy makes the owned DTO a tree.
It neither changes identity nor introduces recursive normalization, result
cloning, router wrappers or a second serialization policy. Each domain owner
remains responsible for constructing valid bounded public values.

Bridge resumption is bounded, authenticated and process-local. Its in-memory
secret is reused for a valid carrier reattachment, not persisted as session
identity. Reloads create fresh peers and can temporarily consume the Host's
bounded retained-peer capacity. Expired delegation or a fresh Host process can
refuse an old secret. Composition must distinguish those outcomes from a short
carrier outage, establish fresh admission when appropriate and reconcile exact
business originals without replay. These limits are not closed by type safety
or the currently running source gate.
