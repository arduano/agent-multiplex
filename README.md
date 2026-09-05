# Agent Multiplex

Agent Multiplex is a private, distributed control plane for Codex and GitHub
Copilot agent sessions. Native app servers stay on runtime machines while one
typed access API serves CLIs, browsers, mobile clients, and bespoke internal
dashboards.

The maintained package graph uses protocol v5. Upgrade all roles together when
adopting v5; see the [current release baseline](docs/wiki/Current-State.md#release-and-compatibility-baseline).
Archived protocol-v2 `host`,
`worker`, `observer`, and `Fleet` APIs remain outside the maintained boundary.

## Start here

- New maintainer or coding-agent session: read the root
  [agent instructions](AGENTS.md), then the
  [current-state handoff](docs/wiki/Current-State.md).
- Operator, embedder, or contributor: choose a path from the
  [operator and developer wiki](docs/wiki/Home.md).
- Installation: use [Install and authenticate](docs/wiki/Install-and-Authenticate.md).
- Production-risk review: read [Security](docs/wiki/Security.md) and the
  [personal deployment runbook](docs/deployment-v4.md).
- Exact qualification and publication evidence: use the
  [release checkpoint](docs/checkpoint-v4.md).

The documentation has explicit owners: Current State holds fresh-session facts,
wiki topic pages hold operational guidance, `docs/design/` holds detailed
invariants, and the checkpoint is only the evidence ledger.

## Topology

```text
CLI / web / mobile / bespoke dashboard
                  |
          HTTP + WebSocket
                  |
      access gateway (zero authority)
          /          |          \
       p2prpc      p2prpc      p2prpc
        /             |            \
 authority control   branch      another realm
        |              |
        +---- strict control tree ----+
                       |
                  runtime nodes
                  /           \
          Codex app server   Copilot SDK
```

- A **control node** is the canonical catalog and metadata authority for its
  realm. Controls form a strict tree.
- A **runtime node** owns native processes, bindings, durable operation state,
  and optional ephemeral terminals.
- An **access gateway** owns no domain data. It projects one or more control
  sources, suppresses redundant descendants, and routes authorized actions.
- A **harness adapter** preserves native Codex or Copilot models, modes, events,
  interactions, commands, and history semantics.

Native history always comes from the owning app server or SDK. Multiplex never
parses vendor session files or treats terminal scrollback as history. See the
[data-role design](docs/design/data-roles-v4.md) and
[launch-extension design](docs/design/launch-extensions-v4.md) for normative
contracts.

## Packages

The repository publishes 16 lockstep `@arduano/agent-multiplex-*` packages:

| Layer | Workspaces |
| --- | --- |
| Contracts and storage | `packages/protocol`, `packages/storage-sqlite` |
| Role cores | `packages/control-node-core`, `packages/runtime-node-core`, `packages/gateway-core` |
| Transport and clients | `packages/transport-p2prpc`, `packages/client`, `packages/client-p2prpc` |
| Native adapters | `packages/adapter-codex`, `packages/adapter-copilot`, `packages/adapter-mock` |
| Reference apps | `apps/control-node`, `apps/runtime-node`, `apps/gateway`, `apps/cli`, `apps/web` |

`apps/host` and `packages/host-core` are archived protocol-v2 evidence outside
the active workspace. The complete package map and supported environments are
in [Packages and environments](docs/wiki/Packages-and-Environments.md).

## Install and verify a checkout

Node 24 or newer is required. GitHub Packages requires authenticated
`read:packages` access even for public packages:

```ini
@arduano:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

Then run:

```bash
npm ci --strict-allow-scripts
npm run check:docs
npm run check:release
npm run typecheck
npm test
npm run check:checkpoint
```

The exact transport is the independently released
`@arduano/p2prpc-core@0.2.1`. Use the sibling `../p2prpc` checkout only for
source development; release candidates must not use a `file:` dependency.

## Operating boundary

The smallest supported deployment is one durable control authority, one or
more runtimes, and one authenticated access gateway. The reference direct
launch profile starts Codex or Copilot in an existing allowed directory and
advertises no isolation. Placement, worktree/container creation, scheduling,
quotas, and repository policy belong in paired gateway/runtime extensions.

Running and stopped sessions stay in normal views; archived sessions move to
explicit bounded cold search. Metadata is a flat namespaced JSON key/value
document and all canonical revisions come from the control authority.

This project targets trusted personal or internal networks. Shared-secret
enrollment and bearer authentication are not public multi-tenant identity or
tenant isolation. Keep direct control HTTP loopback-only, expose only a scoped
gateway, and keep harness/provider credentials on runtime nodes.

## Project policy

Agent Multiplex is available under the [MIT License](LICENSE). Third-party
runtimes and dependencies retain their own terms; see
[third-party notices](THIRD_PARTY_NOTICES.md). Read [SECURITY.md](SECURITY.md)
before exposing a gateway or sharing operational evidence.
