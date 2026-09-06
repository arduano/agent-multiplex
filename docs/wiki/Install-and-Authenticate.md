# Install and authenticate

The simplest supported deployment is one authority control node, one or more
runtime nodes, and one access gateway. Put all three roles on one machine first;
add machines only after the local topology is healthy.

## Prerequisites

- Node.js 24 or newer.
- Authenticated read access to the `@arduano` GitHub Packages scope.
- A native build toolchain for SQLite and `node-pty` dependencies.
- Docker for qualification runs.
- Codex authentication on every Codex runtime, and GitHub Copilot credentials or
  a configured BYOK provider on every Copilot runtime.

The qualified environment is Linux x86-64 in Docker with Node 24. Other
environments are not implied by upstream binary availability; see
[Packages and environments](Packages-and-Environments.md).

## Authenticate npm and build the source checkout

GitHub's npm registry requires a token for public as well as private packages.
Use a classic personal access token with `read:packages`, or the repository's
`GITHUB_TOKEN` in Actions after package access has been granted. Put token
interpolation in your user npm config, never a literal credential in this
repository:

```ini
@arduano:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

For this repository's workflows, store that least-privilege token as the
Actions and Dependabot repository secret `PACKAGES_READ_TOKEN`. Publication of
Agent Multiplex itself continues to use the tag workflow's short-lived
repository `GITHUB_TOKEN`; the long-lived token is read-only.

```bash
npm ci --strict-allow-scripts
npm run check:docs
npm run check:release
npm run typecheck
npm test
npm run check:checkpoint
```

The node transport pins `@arduano/p2prpc-core` exactly. The sibling
`../p2prpc` checkout is used to develop and qualify transport changes, but a
release candidate must not contain a `file:` dependency. Release p2prpc first,
then update this repository's exact version and lockfile.

Use the [current public release](Current-State.md#release-and-compatibility-baseline).
Install only the role needed on each machine and pin every package to the same
release version:

```bash
npm install --global @arduano/agent-multiplex-control-node@0.2.0
npm install --global @arduano/agent-multiplex-runtime-node@0.2.0
npm install --global @arduano/agent-multiplex-gateway@0.2.0
npm install --global @arduano/agent-multiplex-cli@0.2.0
```

Use the corresponding `agent-multiplex-control-node`,
`agent-multiplex-runtime-node`, `agent-multiplex-gateway`, and
`agent-multiplex` executables. The daemons use the environment configuration
documented below; the CLI exposes `--help` and `--version`. Install library
packages locally in an embedding application instead of globally. Package
versions are lockstep; do not compose different Agent Multiplex versions unless
that exact mixed graph was qualified.

## Create credentials

Use independent credentials for different layers:

1. A 32-byte-or-longer shared secret authenticates Multiplex nodes in one trust
   domain.
2. Each p2prpc target is independently pinned by endpoint ID. A ticket is only
   a reachability locator and never substitutes for the pin.
3. Each gateway user or device receives a separate bearer token and the minimum
   action scopes it needs.
4. Harness and model-provider credentials stay on the runtime node.

For a local shell, generate secrets without writing them into command history:

```bash
umask 077
openssl rand -base64 48 > .agent-multiplex/shared-secret
openssl rand -base64 48 > .agent-multiplex/gateway.token
```

Load them through a secret manager or protected file. Never commit `.env`, raw
tickets, tokens, native auth homes, or provider keys.

## Bootstrap in order

1. Start the authority control node with only the required enrollment aperture
   enabled. Record its logical control-node ID, endpoint ID, and ticket through
   a trusted channel.
2. Start each runtime with the endpoint ID and ticket as separate values. Keep
   `AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS` narrow.
3. Confirm every runtime is online, then disable runtime enrollment.
4. Enable access-gateway enrollment and set the control-side grant ceiling.
5. Start the gateway with independently pinned source entries. Confirm one or
   more sources are `selected`, then disable gateway enrollment.
6. Bind control-node HTTP to loopback. Publish only an authenticated gateway.

The complete environment-variable template is [`.env.example`](../../.env.example);
the detailed bootstrap and failure procedures are in the
[deployment runbook](../deployment-v4.md).

## Gateway scopes

Both the gateway-to-control enrollment and the user's bearer credential must
grant an action. The effective permission is their intersection.

| Scope | Allows |
| --- | --- |
| `read` | Fleet, session, operation, interaction, and history reads |
| `agent-launch` | Durable launch admission |
| `agent-archive` | Stopped-session archive admission |
| `agent-control` | Refresh, resume, stop, commands, and interaction responses |
| `metadata-propose` | Fenced metadata proposals |
| `terminal-view` | Read-only attachment to an existing managed PTY |
| `terminal-control` | PTY open, lease, input, resize, and supported termination |
| `topology-admin` | Destructive topology recovery actions |
| `authority-admin` | Explicit detached-branch promotion |

Grant `topology-admin` and `authority-admin` only to a dedicated recovery
credential. A gateway remains zero-authority even when it is allowed to propose
these operations.

## Harness authentication

Applications embedding the control daemon can receive private provisioning
material with `runControlNode(config, signal, { onReady, printTicket: false })`.
Persist the callback's endpoint/locator in an owner-only configuration file;
do not scrape or publish process output for pairing.

Codex uses the authenticated native installation available to the runtime
process. The runtime supervises `codex app-server` on a private Unix socket;
neither its auth home nor socket is exposed to the control node or gateway.

Copilot uses its runtime-local SDK credentials. For an OpenAI-compatible BYOK
provider, configure `AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BASE_URL`,
`_MODEL`, `TYPE=openai`, `WIRE_API=responses`, `TRANSPORT=http`, and exactly one
credential-file variable. Provider secrets never belong in launch input or
session metadata.

For ordinary corporate GitHub Copilot access, omit BYOK configuration and run
the pinned CLI's `copilot login` locally under the same account and
`COPILOT_HOME` used by the SDK. Browser OAuth is the desktop default; the CLI
also supports `login --device-code` and `login --host https://company.ghe.com`
for Enterprise Cloud data residency. The SDK's `useLoggedInUser: true` uses
that native sign-in. Tokens and the native auth directory stay on the runtime.
An embedding that specifically promises saved-account authentication must remove
inherited `COPILOT_PROVIDER_*`, `COPILOT_OFFLINE`, `COPILOT_GITHUB_TOKEN`,
`GH_TOKEN`, `GITHUB_TOKEN`, and SDK token overrides from the native child
environment: they can otherwise override the selected account or model routing.
Keep approved corporate proxy and CA configuration intact.

`getStatus()` proves native runtime startup, not authentication or entitlement.
A local diagnostic can request SDK `getAuthStatus()` and `listModels()` without
creating a session or making a model call. Corporate CLI enablement, sign-in,
and network policy still need validation on the actual managed laptop.

## Windows Copilot embedding

Windows x64 startup support is being qualified separately from the Linux release
baseline. Use structured Copilot and leave the experimental TUI disabled. The
pinned Iroh package has a Windows x64 binary; it has no Windows ARM64 binary.
Codex's current Unix-socket supervisor remains unsupported on native Windows.

Before an embedding writes identities or starts either daemon, create its new
private state directories with `ensurePrivateDirectorySync` from
`@arduano/agent-multiplex-storage-sqlite`. On Windows this uses the installed
Windows PowerShell and .NET ACL APIs to create protected inheritable access for
the current user, SYSTEM, and Administrators. Existing directories are validated
without silently rewriting their ACLs. `assertPrivateFileSync` and
`assertPrivateFilesSync` validate existing private files. Unsafe ACLs, reparse
points, unavailable PowerShell, and policies that prevent validation fail closed.
The helper does not change execution policy or require administrator elevation.
Use local state outside shared/synced folders and preserve its ACLs when backing up.

The Windows CI smoke checks the exact source and dependency boundary without
credentials or model prompts. Its passing receipt covers native imports,
SQLite ownership/reopen, private ACLs, retained image upload/read, and structured
Copilot status/shutdown. It does not qualify corporate authentication or egress.
Windows output-image file snapshots remain explicitly unsupported; uploaded
image bytes retain their normal runtime ownership. See [image limits and
durability](Images-and-Native-Payloads.md).

## First health check

```bash
npm run dev:cli -- --http-url http://127.0.0.1:4318/trpc describe
npm run dev:cli -- --http-url http://127.0.0.1:4318/trpc sources
npm run dev:cli -- --http-url http://127.0.0.1:4318/trpc runtime-nodes
```

For an authenticated gateway, add `--auth-token` or set
`AGENT_MULTIPLEX_AUTH_TOKEN`. Do not put bearer credentials in query strings.
The web client's `#token=` fragment is a local-prototype convenience with
browser-history and screenshot exposure; it is not a production login design.
