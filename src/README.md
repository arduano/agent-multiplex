# Source modules and runtime roles

Top-level folders describe coherent features. Runtime subfolders distinguish the
parts that execute at a Gateway, a Host or a consumer without splitting one
feature across unrelated top-level role trees.

| Module                                                  | Runtime role and public entry                                                                                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `protocol`, `history`, `interactions`, `files`          | Portable values, state owners and contracts used by both ends; Node file storage is explicitly `./files/node`                           |
| `storage`                                               | Portable borrowed ports at `./storage/contracts`; Node SQLite construction at `./storage`                                               |
| `host`, `runtime`, `codex`, `copilot`                   | Host composition, native custody and vendor adapters; portable contracts stay separate from Node construction                           |
| `catalog`, `catalog-remote`                             | Root metadata authority and its remote projection; authority is `./catalog/node` and `./catalog-remote/node`                            |
| `gateway/server`                                        | Authenticated routing, tRPC router and HTTP adapter, exported explicitly through `./gateway/node`; `./gateway` is portable contracts    |
| `transport/client`                                      | HTTP client and retained observation supervision, exported through `./transport` and `./transport/http`                                 |
| `transport/node`                                        | Published pinned Iroh/p2prpc integration used by Hosts and Gateways, exported through `./transport/p2prpc`                              |
| `client`, `react`, `chat`, `attachments`                | Retained consumer state, hooks, conversation rendering and draft upload gestures                                                        |
| `assets`, `conversation`, `child-streams`, `file-links` | Feature integration with portable consumer entries and explicit `./node` Host entries                                                   |
| `reference/server`                                      | Explicit consuming application, HTTP process, private state paths and auxiliary reader custody                                          |
| `reference/ui`                                          | Reference React layout, browser persistence and explicit browser boot; reusable UI is `./reference/ui`                                  |
| `codex/protocol`, `codex/capture.ts`                    | Pinned native types/codecs and the bounded native-state reducer shared by Host capture and client hydration                             |
| `codex/client`, `codex/react`                           | One retained observation per exact run, native read-page evidence, independent views and thin React bindings                            |
| `reference/codex/server`                                | Concrete Codex Host extension and separate Gateway-owned routes; portable associated router types are in `reference/codex/contracts.ts` |

Within a feature, `contracts.ts`, `index.ts` and `node.ts` are deliberate entry
boundaries. Implementation files under `server/` and `node/` are not deep-import
APIs for other modules. Package specifiers are stable even when their compiled
implementation paths move. The CLI remains `dist/reference/cli.js`, and bundled
reference assets remain `dist/reference/web/`.

Client and portable runtime imports must not reach server implementations, native
adapters or Node builtins. Type-only references to an actual composed router are
separate from runtime imports. Contracts do not acquire resources; observation
cancellation never closes an admitted effect or another consumer's shared peer.

The source-boundary checker verifies public crossings, portable runtime closures
and cycles. Owner tests remain beside their coherent feature under `test/`;
folder moves do not justify another owner, journal, state store or test campaign.

Read [the contract review map](../docs/stack/Interfaces.md) before implementation.
Each feature promotes `contracts.ts` and, where needed, `node-contracts.ts`;
private owners live below these named interfaces. Package facades expose selected
factories without turning the concrete owner into a borrowed capability.
