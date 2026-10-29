# Feature and decision ledger

This is a new generic framework API, not a drop-in replacement for the retained
implementation. Personal Multiplex is neither changed nor required to compile.
The reference commit61d90fd supplies native protocol/design evidence; no old
runtime, native home, deployment config or uncommitted source is imported.

| Capability                                                                 | New home             | Disposition and intentional semantics                                                                                                      |
| -------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Root identity/catalog, organization, custom data                           | 12/20                | Implemented separate authority; metadata is scoped/CAS; actual native proof comes from Host                                                |
| Lifecycle/workspace policy                                                 | 05/06                | Static typed plugin only; default plugin shipped, no lifecycle hidden in Gateway                                                           |
| Codex controls/model catalog/modes/reasoning/access                        | 10                   | Pinned actual native API; selected provider explicit; full-access/on-request Create default                                                |
| Copilot models/modes/tasks/access                                          | 11                   | Separate native API and SDK; unsafe atomic Resume override refuses before allocation                                                       |
| Start/Send/steer/queue/interrupt/continue/Stop/Reopen/archive              | 06/10/11             | Meaningful vendor distinctions; Continue is explicit and can follow terminal network failure; Stop requires positive tree retirement       |
| Native children/lineage and child streams                                  | 10/11/22             | Bounded proved native scopes; no heuristic parent attribution or false root-idle completion                                                |
| Streaming/recent/older/cold history                                        | 07/10/11/17          | Retained happy path; explicit100-entry exception baseline/paging; no Resume to read history                                                |
| Native errors/compaction/working state                                     | 07/10/11/16          | Evidence-based history; no fake final text or perpetual missing-final badge                                                                |
| Questions/Extra info/plans/approvals/MCP confirmations                     | 09/10/11/16          | Exact capabilities and explicit plan action; answer submission differs from confirmed resolution                                           |
| Goal/task/queue and background native terminals                            | 10/11                | Actual harness commands/read surfaces where supported; a terminal is not transcript truth                                                  |
| MCP settings/inventory/reload/login                                        | 09/10/11             | Explicit native/resource ownership; application supplies private config and login presentation                                             |
| File/image upload, native tool images, referenced files                    | 08/10/11/14/18/21/23 | Published peer.files owns binary transfer/resume; business upload intents, immutable publication, authorized capture and quotas stay local |
| Text/image/HTML/PDF/Mermaid previews                                       | 08/16/19             | Safe renderer ports, real scoped bytes; HTML opaque and diagrams strict; PDF uses browser-native frame                                     |
| Gateway auth/sharing/permissions                                           | 05/13/14             | Verified principals/grants plus Host fencing; no hard-coded private login/account topology                                                 |
| Shared physical peers and multiple relay configuration                     | 14                   | Pinned published dependencies; one auth token per endpoint's relay set; distinct token sets require distinct nodes                         |
| Retained sessions/pins/drafts/multiple viewers                             | 15/17                | One shared entry, independent view anchors; unmount never closes the Host                                                                  |
| React hooks and embeddable themeable chat                                  | 15/16                | Real React/external-store subscriptions; Radix primitives; consumer owns surrounding application navigation                                |
| Generic reference UI and process entry                                     | 19                   | Model-free runnable consumer, not a production fleet/application replacement                                                               |
| Immutable deployment payload and explicit private state                    | 19/24                | Public Nix source and lock; agent data separate from machine credentials; no automatic migration or service cutover                        |
| Private accounts, VM workspace allocation, fleet manifests, push/watch/PWA | Consumer application | Personal/business policy excluded from generic repo; typed extension/router ports remain available                                         |
| Platform-level create-agent tooling                                        | Consumer extension   | Personal prototype is not moved into core; native child support remains in adapters                                                        |
| TUI and generation compatibility wrappers                                  | Retired              | Owner deprecated TUI; no V5/V6/V7 topology/module count compatibility requirement                                                          |

## Deliberate simplifications

One package/lock with explicit optional module entries replaces a package for
every small primitive. Static composition preserves end-to-end custom types
without a global vendor union or dynamic plugin registry. Each Host owns its
native lifetime; Gateway routes and observes. Existing SQLite transactions own
originals and checkpoints together. There is no second outbox, recovery registry,
client catalog authority or automatic mutation replay.

Optional questions require explicit structured native markers. Ordinary prose
and Markdown bullets do not become executable controls by heuristic. Missing
native evidence stays missing; renderers never manufacture completion. Cached
model choices do not silently become selected settings. Fresh definitions,
imports, React rendering and reconnect remain inert with respect to effects.

## Actual transport boundary

Gateway HTTP uses the official tRPC Fetch adapter for the Gateway's own topology
router. An authenticated WebSocket route relays a leased native bridge channel.
The browser's `connectBridge<ActualHostRouter>` calls the actual Host router over
published p2prpc0.3.1; no selected-Host HTTP mount, copied router, universal RPC
envelope or custom client link remains. The Host derives application scope and
grants from verified delegation. Routing/contract/session metadata stays outside
the actual procedure input, and per-operation Host admission remains authoritative.

One retained browser peer spans conversation switches. The same peer's files
capabilities carry bytes; assets retains only begin/status/abort/acquire business
operations. Portable file types and Blob helpers come from the dependency's
`/files` entry. Native capture/input holds and immutable FileStore publication
remain separate from transport completion. Root Catalog uses its own actual
router and official HTTP composition, independently of Host channel routing.

Carrier reattachment preserves only a still-valid, same-identity Host bridge
entry. Its secret and ledgers are not durable session/catalog state. Reload
creates a fresh logical peer; bounded entries can remain charged until expiry or
revocation. After Host-process restart, an old secret is unknown. Fresh admission
and exact receipt lookup must not silently become a resumed mutation or an
invented file-transfer success. Long TTL expiry, repeated reload capacity and
fresh-process recovery remain explicit integration boundaries; the current
source gate is not a qualification claim for them.

## Qualification gaps retained visibly

Implemented source is not fresh live-vendor qualification. Codex0.162.1 and
CopilotSDK1.0.19/CLI1.0.95 are pinned, but this stack invokes neither real agent nor
provider. Scripted protocol, actual owned child/SQLite/files, browser and Iroh
proofs have distinct records. Actual containment on every target OS, real MCP
servers, installed fleet outages, capacity, auth renewal and multi-relay paths
require their own finite campaign before an application rollout.

The historical two-viewer/cross-viewer P14 transport case remains **unresolved**.
The new owned two-endpoint loopback oracle qualifies a narrower direct topology;
it does not close the old multi-hop/relay/auth-renewal defect. Two configured
relay URLs are not proof that both physical relay paths were exercised. PDF
frame/bytes/download are proved; a rendered PDF page on every platform is not.
No production readiness, Personal compatibility, migration or deployment claim
is made by publishing this review stack.

The final coverage review added explicit generic integrations rather than hiding
missing paths behind private-consumer responsibility:20 exposes the actual Root
catalog through typed authenticated remote observation,21 keeps confirmed file
drafts in the existing session entry with separate actual upload custody,22
retains proved readonly child histories and anchors, and23 resolves explicitly
authorized native links through the existing FileStore. These layers do not add
another native session registry, command journal or automatic Resume policy.
