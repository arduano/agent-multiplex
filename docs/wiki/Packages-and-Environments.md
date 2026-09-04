# Packages and supported environments

Use the narrowest package that owns the behavior being changed. The protocol is
transport-compatible data; the core packages are transport-neutral services;
apps are reference composition roots.

## Package map

| Package or app | Owns | Does not own |
| --- | --- | --- |
| `@arduano/agent-multiplex-protocol` | Zod schemas, IDs, streams, lifecycle and tRPC-compatible contracts | Persistence, routing, native SDK calls |
| `@arduano/agent-multiplex-storage-sqlite` | Hardened single-writer SQLite lifecycle, migration ledger, integrity, checkpoint, backup | Domain schema or replication policy |
| `@arduano/agent-multiplex-control-node-core` | Canonical catalog/metadata, branch replication, recursive routing, operation records | Agent processes or gateway authentication |
| `@arduano/agent-multiplex-runtime-node-core` | Bindings, path policy, launch/provider/backend registry, durable runtime journals, terminal broker | Canonical metadata or multi-source selection |
| `@arduano/agent-multiplex-gateway-core` | Validated multi-source projection, overlap suppression, routing, restricted launch-plugin port | Domain authority or native execution |
| `@arduano/agent-multiplex-transport-p2prpc` | Authenticated endpoint-pinned node links using p2prpc | Browser auth or application policy |
| `@arduano/agent-multiplex-client` | Browser-safe HTTP/WS client construction, command helpers, cursor-aware watches | Node p2prpc or UI state |
| `@arduano/agent-multiplex-client-p2prpc` | Node-only direct p2prpc control-source client | Browser bundles or gateway projection |
| `@arduano/agent-multiplex-adapter-codex` | Codex app-server RPC, native events/history/interactions, shared-server terminal | Catalog authority or workspace provisioning |
| `@arduano/agent-multiplex-adapter-copilot` | Copilot SDK sessions, events/history/interactions, BYOK, experimental TUI bridge | Catalog authority or generic provider policy |
| `@arduano/agent-multiplex-adapter-mock` | Deterministic test sessions and streams | Capacity prediction for real agents |
| `apps/control-node` | Reference authority/branch daemon and loopback HTTP edge | Public internet edge |
| `apps/runtime-node` | Reference runtime composition and reconnect loop | Scheduling or multi-runtime placement |
| `apps/gateway` | Reference authenticated HTTP/WS edge and web asset server | Dynamic plugin loading |
| `apps/cli` | Operator CLI | Durable state |
| `apps/web` | React operator workspace | Canonical transcript or metadata storage |

`apps/host` and `packages/host-core` are archived protocol-v2 evidence. They are
not workspaces and are never valid dependencies for protocol v4.

The published `@arduano/agent-multiplex-web` package contains the already-built
browser assets in `dist/client` as well as its small Node asset-serving entry
point. React, Vite, Tailwind, xterm, icons, fonts, and the rest of the browser
build graph are development inputs and are not installed into a downstream
runtime. The package ships the corresponding generated
`THIRD_PARTY_LICENSES.txt` both at its package root and beside the served browser
assets. Rebuild the web workspace only when producing a new package candidate;
consumers should serve or compose the packaged output rather than rebuilding it.

## Supported and qualified environment

| Surface | Current boundary |
| --- | --- |
| Node.js runtime | 24 or newer |
| Reproducible release toolchain | Node `24.19.0`, npm `11.17.0` |
| Qualification container base | `node:24.19.0-bookworm-slim` at OCI index digest `sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df` |
| Module system | TypeScript/JavaScript ESM |
| Wire contract | Agent Multiplex protocol 4 |
| Node transport | Exact `@arduano/p2prpc-core@0.2.1` package (p2prpc v1 API) |
| Qualified OS | Linux x86-64 Docker |
| Qualified Codex | `@openai/codex` / CLI `0.152.0` |
| Qualified Copilot | SDK/CLI package `1.0.81`; SDK `1.0.11` |
| Browser | Modern browser with WebSocket; SHA-256 uses Web Crypto or the bundled `@noble/hashes` fallback |
| Persistence | Local filesystem with SQLite locking and durable rename semantics |

The latest real receipt used Node `24.20.0` and Docker Server `29.7.2`. Exact
receipt and p2prpc digests are in [Releases](Releases.md).

macOS may satisfy the POSIX and native-module assumptions, but it has not been
qualified by the retained Docker receipts. The maintained Codex supervisor uses
a Unix-domain socket, so native Windows runtime support is not currently
claimed. Control/gateway source may compile on other upstream-supported
platforms, but treat that as unqualified until the full relevant suite passes.

## Repository checks

```bash
npm ls --workspaces --depth=0
npm ci --dry-run --ignore-scripts
npm run typecheck
npm test
npm run check:checkpoint
```

Build, typecheck, and test begin by deleting active workspace `dist/` trees.
This prevents renamed or removed modules from surviving an incremental build.
`check:checkpoint` verifies exactly 16 active v4 workspaces, the lockfile and
project references, archive exclusion, package entry points, the exact p2prpc
dependency, Docker build inputs, and compiler-output provenance.

## Choosing a layer

- Add a wire-visible field or procedure only in `protocol`, then implement it on
  every relevant role and transport.
- Add catalog or authority behavior in `control-node-core`.
- Add process, provider, binding, or terminal behavior in `runtime-node-core`.
- Add source overlap, selection, or route behavior in `gateway-core`.
- Add harness semantics in its adapter without flattening another harness to
  match it.
- Add company workflow policy as paired extension code, not a protocol field.
- Add presentation behavior in a client or bespoke gateway/UI.
