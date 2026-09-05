# Agent Multiplex operator and developer guide

Agent Multiplex is a private distributed control plane for Codex and GitHub
Copilot sessions. Native app servers stay on runtime machines; control nodes own
the catalog and metadata; zero-authority gateways give CLIs, browsers, mobile
clients, and internal tools one typed surface.

This page is the documentation router. A new coding-agent session should read
[Current state and fresh-session handoff](Current-State.md) first, then open
only the topic and deep design for the role it will change.

## Choose a path

- **Operator:** [install and authenticate](Install-and-Authenticate.md), then
  [operations](Operations.md), [backup and recovery](Backups-Upgrades-and-Recovery.md),
  and [security](Security.md).
- **Embedder:** [packages and environments](Packages-and-Environments.md), then
  [clients and gateway embedding](Clients-and-Gateway-Embedding.md) or
  [paired launch extensions](Paired-Launch-Extensions.md).
- **Contributor or coding agent:** [current state](Current-State.md), then the
  topic page and normative design for the role being changed.
- **Release maintainer:** [the immutable release checkpoint](../checkpoint-v4.md),
  then [releases and compatibility](Releases.md).

## Find a topic

| Goal | Guide |
| --- | --- |
| Catch up in a fresh coding-agent session | [Current state and fresh-session handoff](Current-State.md) |
| Install a local topology and configure trust | [Install and authenticate](Install-and-Authenticate.md) |
| Find the right package and supported environment | [Packages and environments](Packages-and-Environments.md) |
| Understand authority, aggregation, and routing | [Architecture and data roles](Architecture-and-Data-Roles.md) |
| Build a CLI, dashboard, or bespoke gateway | [Clients and gateway embedding](Clients-and-Gateway-Embedding.md) |
| Add a PR reviewer, container launcher, or scheduler | [Paired launch extensions](Paired-Launch-Extensions.md) |
| Upload images or display runtime output images | [Images and native payloads](Images-and-Native-Payloads.md) |
| Work with running, stopped, and archived sessions | [Lifecycle, metadata, and search](Lifecycle-Metadata-and-Search.md) |
| Understand Codex, Copilot, mock, and PTY behavior | [Adapters and terminals](Adapters-and-Terminals.md) |
| Run and monitor a deployment | [Operations](Operations.md) |
| Protect and migrate persistent state | [Backups, upgrades, and recovery](Backups-Upgrades-and-Recovery.md) |
| Review the deployment threat model | [Security](Security.md) |
| Diagnose common failures | [Troubleshooting](Troubleshooting.md) |
| Qualify and publish a version | [Releases](Releases.md) |

## Documentation map

Changing facts have one owner so a fresh session does not need to reconcile
several near-duplicate summaries:

- [Current state](Current-State.md) — release baseline, implemented surface,
  settled decisions, known gaps, code map, and session-start checklist.
- The topic pages above — operator, integration, security, and troubleshooting
  guidance.
- [Data roles](../design/data-roles-v4.md) — authority, topology, projection,
  routing, and persistence invariants.
- [Images](../design/images-v5.md) — byte storage, native envelopes, and v5 upgrades.
- [Launch extensions](../design/launch-extensions-v4.md) — plugin/provider
  contracts and operation state machines.
- [Protocol-v4 checkpoint](../checkpoint-v4.md) — exact qualification and
  release evidence.
- [Deployment runbook](../deployment-v4.md) — detailed personal-deployment and
  failure guidance.
- [Original harness research](../research/agent-harness-servers-and-multiplexing.md)
  — upstream capabilities and alternatives considered.

Historical protocol-v2 sources under `apps/host` and `packages/host-core` are
design evidence only. They are outside the workspace and must not be imported,
repaired, or treated as compatibility APIs.

The older `docs/design/multiplex-architecture.md` and
`docs/design/nested-hosts.md` sketches are also historical input. They stay out
of active navigation; use the maintained designs above as implementation truth. The `*-v4.md`
filenames remain stable even where their shared invariants now apply to v5.
