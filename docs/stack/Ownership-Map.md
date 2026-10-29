# State, module and test ownership

Read this map with the numbered PR diffs. Observing state does not grant authority
to change it. A disconnected viewer owns neither a native lifetime nor an
operation outcome.

The journal's [`module contract`](../../src/storage/README.md) separates portable
borrowed read/write ports from its Node SQLite implementation and POSIX file
boundary. Lifecycle and Catalog own their domain records and use those ports;
the composing process owns storage construction and close. An auxiliary reader
custody bridge receives only checkpoint read/save capabilities. No generic
owner imports the concrete SQLite class merely to express its dependency.

| Owner                       | State and lifetime                                                                  | Effect admitted by                                                 | Decisive oracle                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| protocol02                  | Logical scope, immutable original and lifetime identity                             | None; pure values                                                  | Collision-free scope and canonical JSON                                                     |
| OriginalJournal03/06        | One private SQLite writer; permanent original IDs, dispatch state, checkpoints      | Atomic original/checkpoint transaction; at most one dispatch claim | Killed writer, real SQLite refusal/rollback, duplicate never restores a snapshot            |
| runtime04                   | Parked native tree and containment identity                                         | Explicit allocation/open capsule                                   | Actual owned child exit; exact containment proof; failed cleanup retains custody            |
| typed Host05                | Static plugin composition, authenticated session/route context                      | Admitted typed procedure                                           | Cross-vendor compile failures; route/principal/epoch/record fences                          |
| DefaultLifecycle06          | Logical session, exact native generation, work and resource readiness               | Existing original journal                                          | Reentrant Stop before acquisition; late opening; early native-ID commit; positive Stop only |
| HistoryWindow/acquisition07 | One native capture, row order and bounded exception frontier                        | Native observations; explicit readonly exception                   | Missing prefix/final evidence, reset fences, honest older boundary, actual held read budget |
| FileStore08                 | Immutable scoped bytes, captures, references and actual leases                      | Explicit capture/upload/read                                       | Real filesystem quotas, leases, retirement and collection                                   |
| InteractionOwner09          | One-use native request incarnation and pending decision                             | Native callback; exact admitted answer                             | ID reuse, withdrawal, confirmation distinct from submission, Extra info                     |
| MCP owner09                 | One actual reload/login resource                                                    | Existing native original                                           | Bounded admission, actual work/cleanup, no second journal                                   |
| Codex10 / Copilot11         | Vendor attachment, reverse RPCs, child history, native input holds and read helpers | Lifecycle's parked capsule and admitted original                   | Scripted actual protocol envelopes, exact read/Stop races; no claimed vendor execution      |
| Catalog12                   | Root metadata, logical identity and Create/Archive workflow                         | Separate Root journal; Host owns native effect                     | Real two-owner SQLite workflow, request-hash reconciliation, metadata CAS                   |
| Gateway13                   | Topology, grants, route epoch and borrowed channel leases                           | Authenticated route admission; HTTP exposes topology only          | Route replacement and quiet channel cleanup remain Gateway-owned                            |
| transport14                 | Published physical peer plus one retained browser logical bridge/file engine        | Verified delegation, pinned Host and per-operation authorization   | Native carrier and borrowed-peer custody remain separate from logical observation release   |
| retained client15           | One entry per logical session: draft, originals, pin, projection and feed           | Durable local preparation before one dispatch                      | Unknown original reconciliation, switched views, StrictMode inert rendering                 |
| SessionView/viewport15      | Independent reading anchor and follow-latest intent                                 | User gesture or explicit local Send                                | Actual browser geometry, End/no-motion, older anchor and A/B/A                              |
| Chat16                      | Scoped theme, local form draft and releasable preview DOM                           | Explicit user actions through injected ports                       | Typed forms, real React, opaque HTML; actual browser input/geometry follows21               |
| ConversationFeature17       | Binding of existing state/history/interaction owners                                | Mount observes; explicit exception reads only                      | Real lifecycle/tRPC/client composition, zero happy-path history reads                       |
| HostAssetOwner18            | Bounded upload intents, immutable publication and native/read leases                | Exact scoped intent plus authenticated peer file capability        | Publication witness and store custody; the dependency owns binary transfer/resume           |
| Reference application19     | Application composition, UI peer and explicit HTTP/WS/process lifetime              | Explicit CLI/module boot and authenticated bridge admission        | Scripted business owners; separate Gateway/Host endpoints and explicit cleanup              |
| remote catalog20            | Bounded retained Root metadata projection; Root remains authority                   | Authenticated typed original operations; observer reconnect only   | Real SQLite/HTTP lost-reply and scoped CAS                                                  |
| attachment drafts21         | Confirmed files belong to SessionEntry; pending uploads own actual resources        | Explicit picker/drop/paste and exact draft snapshot                | Real files and actual React gesture/Send/late edit cases                                    |
| child streams22             | Bounded proved readonly history views and independent anchors                       | Parent-owned native scope; no child mutation surface               | Actual native codecs plus typed read-only routing, holds and churn                          |
| file links23                | Authorized references/captures and renderer preview leases                          | Server-injected workspace authority; explicit preview gesture      | Actual files, traversal/symlink/fencing and late lease cleanup                              |
| Nix24                       | Immutable public payload only                                                       | Exact public source/lock build                                     | Offline locked extraction, closure/help and artifact inventory                              |

## Distributed uncertainty

An original starts local and immutable. Once the Host journal admits it, the Host
owns reconciliation even if the viewer disappears. A transport ACK is no proof
of completed work. An unknown result remains associated with that original; a
reconnect reads its exact receipt and never invents a replacement Send. The
client keeps the conversation visible, reconnects observation and exposes a
specific operation problem only when it requires user action.

A Root Create workflow can be unknown independently of its Host Create effect.
Root asks for that original's proof, not today's session state. A native ID is
committed as soon as observed, before later initialization/settings can fail.
The Host retains allocated trees and pending cleanup until exact proof; idle,
EOF, lost attachment and elapsed time never become Stop certificates.

Normal history flows from the retained native capture through one shared client
entry. Initial unknown boundaries, reconnect gaps and explicit older paging are
bounded readonly exceptions. Stale same-session rows may remain visible while a
new capture is unobserved; they never acquire a new authoritative origin merely
because the UI still displays them. Root stream names are adapter-owned, not a
universal equality with native thread IDs.

## Current transport composition

The Gateway's official HTTP tRPC endpoint exposes its own topology router.
Actual Host procedures are not selected and remounted beneath that endpoint.
A separate authenticated WebSocket route acquires one Gateway route lease and
relays bytes to the borrowed native peer's openBridge capability. The published
p2prpc bridge terminates on the Host's actual router; the Gateway has no router
inventory, procedure envelope, transfer ID ledger or file spool.

Application composition retains one browser peer across session/view switches.
Its RPC and files facets share the Host-issued logical peer and verified delegated
namespace. A logical carrier closing releases its route lease after actual
channel closure; it does not close the borrowed physical Gateway-to-Host peer,
Stop a native agent or resolve an admitted original. ObservationSupervisor
reopens only repeatable observations. Binary transfer resumption belongs to
p2prpc0.3.1;08/18 own immutable publication, quotas and resource holds. Portable
file consumers import the dependency's `/files` entry independently of its typed
RPC/browser declaration graph.

A Root Catalog remains a distinct authority with its own actual router/context.
It can use the official HTTP Fetch adapter and official client links directly.
Neither a fake Host/session nor selected-Host HTTP forwarding is needed to expose
it. Topology presence, an open bridge, native activity and receipt outcomes are
separate facts with separate owners.

## Bridge lifetime boundaries

The retained browser peer keeps its resumption secret in memory. A short carrier
loss can reattach to the same Host entry, retaining that engine's file ledgers;
no RPC mutation is replayed. Session switching reuses that peer. A full page
reload creates a new browser peer rather than restoring a persisted secret.
Host logical peers and their retained cleanup/ledgers have explicit capacity and
expiry bounds; repeated reloads can consume that capacity until expiry or
explicit revocation. Closing a socket does not prove those retained Host records
have already retired.

Delegation expiry, an unknown resumption secret and a fresh Host-process restart
are not equivalent to a temporary carrier failure. Host bridge entries are
process-local. An old browser peer cannot claim its ledger survived a new Host
process; application composition must establish fresh authenticated admission
and reconcile retained business originals without resending them. These are
explicit limits, not a claim that the current gate qualifies arbitrary TTL,
reload-capacity or fleet restart recovery.

## Test reduction rule

Keep the real-owner oracle once. Integration tests demonstrate wiring and a small
number of cross-owner races; they do not repeat the entire leaf fault matrix.
A replacement names the old accidental behavior and the stronger invariant.
Numbered notes record retained algorithms and exact source provenance. Retired
prototype permutations do not silently become requirements. A passing mock is
never evidence for a vendor, installed service or physical transport topology.
