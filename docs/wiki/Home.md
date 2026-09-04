# Agent Multiplex operator and developer guide

Agent Multiplex is a private distributed control plane for Codex and GitHub
Copilot sessions. Native app servers stay on runtime machines; control nodes own
the catalog and metadata; zero-authority gateways give CLIs, browsers, mobile
clients, and internal tools one typed surface.

This wiki is the shortest safe path through protocol v4. It is written for
operators and coding agents changing or embedding the repository.

## Start here

| Goal | Guide |
| --- | --- |
| Install a local topology and configure trust | [Install and authenticate](Install-and-Authenticate.md) |
| Find the right package and supported environment | [Packages and environments](Packages-and-Environments.md) |
| Understand authority, aggregation, and routing | [Architecture and data roles](Architecture-and-Data-Roles.md) |
| Build a CLI, dashboard, or bespoke gateway | [Clients and gateway embedding](Clients-and-Gateway-Embedding.md) |
| Add a PR reviewer, container launcher, or scheduler | [Paired launch extensions](Paired-Launch-Extensions.md) |
| Work with running, stopped, and archived sessions | [Lifecycle, metadata, and search](Lifecycle-Metadata-and-Search.md) |
| Understand Codex, Copilot, mock, and PTY behavior | [Adapters and terminals](Adapters-and-Terminals.md) |
| Run and monitor a deployment | [Operations](Operations.md) |
| Protect and migrate persistent state | [Backups, upgrades, and recovery](Backups-Upgrades-and-Recovery.md) |
| Review the deployment threat model | [Security](Security.md) |
| Diagnose common failures | [Troubleshooting](Troubleshooting.md) |
| Qualify and publish a version | [Releases](Releases.md) |

## Non-negotiable v4 boundaries

- A control node is the sole canonical authority for its realm. Attachment or
  disconnection never silently changes that authority.
- A runtime node owns native bindings and process-local agent behavior. Native
  history is read through the harness API; Multiplex never parses vendor history
  files.
- A gateway has zero domain-data authority. It may observe, route, and suggest
  actions, but cannot become a control node or use another gateway as a source.
- Control nodes form a tree, not a DAG. Gateways may select several disjoint
  sources and suppress redundant descendants when an ancestor is present.
- Metadata is one flat namespaced key/value document whose values are JSON.
- Domain launch policy lives in statically composed gateway plugins and runtime
  providers. It does not belong in protocol core.
- Stop preserves a resumable logical session. Archive is a separate durable
  cleanup operation and is never inferred from age or connectivity.
- Ambiguous distributed side effects are `outcomeUnknown`; they are reconciled,
  not blindly retried.

## Canonical references

The wiki summarizes rather than replaces these documents:

- [Protocol-v4 checkpoint](../checkpoint-v4.md) — maintained boundary,
  limitations, and successful qualification receipts.
- [Data roles](../design/data-roles-v4.md) — authority, topology, projection,
  routing, and persistence invariants.
- [Launch extensions](../design/launch-extensions-v4.md) — plugin/provider
  contracts and operation state machines.
- [Deployment runbook](../deployment-v4.md) — detailed personal-deployment and
  failure guidance.
- [Original harness research](../research/agent-harness-servers-and-multiplexing.md)
  — upstream capabilities and alternatives considered.

Historical protocol-v2 sources under `apps/host` and `packages/host-core` are
design evidence only. They are outside the workspace and must not be imported,
repaired, or treated as compatibility APIs.
