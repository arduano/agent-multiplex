# Agent Multiplex

A public framework for native coding-agent Hosts, authenticated gateways and
retained clients. It contains no accounts, private topology, business workflow or
sibling-repository dependency. This reconstruction intentionally changes APIs.

Start with the [numbered review stack](docs/stack/README.md). PR01 is literally an
empty Git tree; the remaining draft PRs introduce owners in dependency order.
Review each against its direct parent. Existing installations and Personal
Multiplex remain unchanged.

## Run the reference application

Use Node24.19.0 and npm11.17.0. Scripts use `.ts`, executed with `tsx`; `.tsx` is reserved for JSX.
Every command-line entrypoint uses `cmd-ts`. Prettier and ESLint run as part
of the normal check:

```sh
npm ci --ignore-scripts
npm run check
node dist/reference/cli.js demo
```

Open the printed loopback address. This disposable UI uses real SQLite, scoped
files, Root/Host routing, authenticated browser/Iroh streams, retained React state and chat components
with an explicitly **scripted, model-free** provider. SIGINT/SIGTERM retires its
owned sessions and removes its disposable state. It does not enroll a fleet,
read an existing agent home or invoke Codex/Copilot. The install retains optional platform bindings required by native transports.
Installing vendor artifacts does not invoke or qualify a vendor/provider.

The public Nix flake builds the immutable payload on x86_64-linux. All package
artifacts come from the committed HTTPS/SRI lock, with no dependency install
scripts or private/local source inputs. `nix build` produces `bin/multiplex`;
`nix run -- --help` describes the explicit process entry.

## Public boundaries

| Entry                                                      | Responsibility                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| `protocol`, `storage/contracts`, `runtime`                 | Identity, durable originals and native-tree custody                     |
| `host`, `host/contracts`                                   | Static typed lifecycle/workspace/harness/extension plugins              |
| `codex`, `codex/node`; `copilot`, `copilot/node`           | Separate native schemas, adapters and inferred controls                 |
| `codex/protocol`, `codex/native-contracts`                 | Revision-pinned native DTOs, observation and callback contracts         |
| `codex/client`, `codex/react`                              | Retained native Codex observations, independent history views and hooks |
| `history`, `interactions`                                  | Streamed evidence, bounded readonly exceptions and exact decisions/MCP  |
| `files`, `files/node`; `assets`, `assets/node`             | Scoped immutable bytes, captures, uploads and leases                    |
| `catalog`, `catalog/node`; `catalog-remote`                | Root authority and bounded authenticated remote browsing                |
| `gateway`, `gateway/node`; `transport`, `transport/p2prpc` | Grants, routing, HTTP and published pinned Iroh peers                   |
| `client`, `client/contracts`, `react`                      | One retained session owner, browser contracts and thin hooks            |
| `chat`, `chat/styles.css`                                  | Embeddable theme, composer, native forms and safe rich previews         |
| `conversation`, `conversation/node`                        | State/history/decision integration without a second journal             |
| `attachments`, `child-streams`, `file-links`               | Retained file drafts, readonly children and authorized native links     |
| `reference`, `reference/ui`, `reference/node`              | Public consuming composition and explicit process setup                 |
| `reference/codex`, `reference/codex/node`                  | Codex Host customization and associated Gateway router example          |

Use the declared package subpaths. The journal's portable `storage/contracts`
entry exposes receipt/checkpoint operations; `storage` supplies the private
SQLite implementation. Lifecycle and Catalog depend on the operations, while
application composition constructs and closes the concrete writer. See the
[module boundary rules](docs/stack/Modularity.md). Browser entries do not import Node code.
The generic React/chat contracts compile without Node ambient declarations;
the optional inferred tRPC client/reference-router surfaces also require Node
TypeScript declarations. Node entries own explicit resources and are never
started by import, rendering, reconnect or a UI unmount.

Host procedures use their actual tRPC router and its inferred client. A browser
calls `connectBridge<ActualHostRouter>` from published p2prpc; the Gateway relays
binary bytes to an authenticated native Peer. It owns route leases and delegated
admission, while the Host independently authorizes every RPC/file operation.
There are no copied Gateway procedures, generic RPC envelopes or custom file
chunk protocols. Routing metadata stays outside procedure input. The Gateway's
own topology and a Root's explicit catalog endpoint use ordinary official tRPC
HTTP adapters/clients. Pinned p2prpc supports unary calls and subscriptions;
nested execution-valued results remain an HTTP-only capability. See
[the contract rules](docs/stack/Modularity.md#trpc-is-the-procedure-contract).

Codex clients consume the actual native-shaped router: native parameters,
results, item types, callbacks and settings remain Codex-shaped. The retained
Codex client shares one bounded observation per exact run and keeps native read
pages separate from live capture; neither is a native read/live watermark.
Lifecycle routes own creation, Reopen, Stop and archive. Harness routers own
messaging and native controls. The normalized chat/history path remains an
optional presentation integration, not the Codex protocol authority. Copilot
has its own existing router; this amendment does not convert its SDK API.

At Host creation, ordinary tRPC router composition adds Host extensions. A typed
Gateway contract can associate separate Gateway-owned routes without importing
their handlers into the Host runtime. The concrete Codex demo shows both paths
and their inferred clients in [layer 19](docs/stack/19-reference.md); it is an
example composition, not another plugin registry or native provider.

Applications provide authentication, private provider configuration, exact
runtime containment and workspace policy. New managed Codex defaults to full
access/on-request; explicit native/provider/tool policy remains authoritative.
Reopen may continue native work and is always explicit. Continue, Interrupt,
Stop and Archive are distinct operations. A missing reply never licenses a new
Send; exact original receipts reconcile independently of current session state.

## Processes and mutable state

```sh
multiplex run application.ts /absolute/agents-state /absolute/system-state
```

The trusted application module exports `create({paths})`, returning its
**authenticated** Fetch handler and actual `close()` owner. The CLI creates no
ambient login/provider configuration. Immutable package payload, agent/session
data and system credentials/pairing are separate. Mutable directories must be
canonical, private, account-owned and disjoint. Service enrollment, updates,
security policy and migrations remain explicit application/operator work.

## Validation and limits

`npm run check` runs Prettier, ESLint, strict types, public module/cycle checks, unique owner tests
and the reference UI build. Tests use disposable files/SQLite, scripted native
protocols and finite owned Node children. Explicit browser and owned Iroh checks
have separate commands/receipts. The [feature/decision ledger](docs/stack/Feature-and-Decisions.md)
and [ownership map](docs/stack/Ownership-Map.md) explain coverage and deliberate
retirements; the final review layer records exact evidence.

Codex0.162.1 and CopilotSDK1.0.19/CLI1.0.95 are pinned source integrations. Real
vendor/provider operation, every target OS, deployed fleet recovery, two real
relay paths and the historical cross-viewer transport defect are not silently
qualified by scripted or direct-loopback tests. Publishing this draft stack is
not a production-readiness, deployment or Personal compatibility claim.
