# Security

Agent Multiplex targets trusted personal and internal networks. It is not a
public multi-tenant identity plane. Use a properly authenticated gateway and
normal organizational network/identity controls at every wider boundary.

## Trust model

- The control node is trusted with canonical session metadata, topology, and
  operation state.
- Runtime nodes are trusted with local filesystem roots, harness credentials,
  native output, and the OS authority of their agent processes.
- Gateway code is trusted with all data visible through its sources, but has no
  protocol authority to commit that data by itself.
- Statically imported plugins/providers/backends are trusted application code,
  not sandboxed tenant extensions.
- Clients and network inputs are untrusted and must pass authentication, schema,
  action-scope, ownership, and generation fences.

## Authentication layers

Node links use a shared-secret principal plus independently pinned Iroh endpoint
identity. Tickets, DNS, mDNS, and relay hints are locators only. Enrollment is
explicit and durable; close each enrollment aperture after bootstrap.

The public gateway uses bearer credentials. Use one token per person/device,
short minimum scope lists, TLS at the HTTP edge, protected token files, and an
external identity proxy where organizational access and revocation are needed.
Both the source enrollment and downstream bearer must grant an action.

Keep harness and provider credentials on the runtime. Never send them as launch
input, metadata, headers intended for plugins, or terminal receipts.

## Sensitive capabilities

- `agent-launch` can allocate compute and run an agent in an allowed workspace.
- `agent-control` can prompt, steer, interrupt, resume, or stop a native agent.
- `agent-archive` can release provider/backend resources and remove hot access.
- `metadata-propose` can alter searchable authority-owned workflow links.
- `terminal-view` exposes unredacted PTY output.
- `terminal-control` is keyboard access under the runtime account.
- topology and authority administration can create an intentional divergent
  realm and belong on a separate recovery credential.

Allowed-root checks constrain launch/resume paths but do not sandbox the native
harness. The agent still has the runtime account's OS, repository, network, and
credential permissions unless a provider creates a stronger boundary.

## Secret handling

Never commit or retain in shareable receipts:

- shared secrets, bearer tokens, terminal lease secrets, raw p2prpc tickets;
- Codex or Copilot auth homes;
- OpenAI-compatible provider API keys or bearer tokens;
- browser URLs containing the local `#token=` convenience fragment;
- raw terminal canaries or unredacted logs that may contain commands/output.

URL fragments are not sent in HTTP requests or `Referer`, but remain visible to
browser history, extensions, screenshots, copy/paste, and anyone receiving the
URL. Use an actual login/token-storage design outside local prototypes.

## Durable and ephemeral data

SQLite files and endpoint identities are sensitive operational data. Protect
file permissions, backups, WAL/SHM files, and logs. Session metadata is not a
secret store and is replicated through controls/gateways.

Terminal bytes and lease secrets are intentionally memory-only, but viewers see
opaque unredacted output. Native history comes directly from the harness and may
also contain source, prompts, tool output, or secrets. Apply access and retention
policy at the client/edge.

## Network exposure

- Keep direct control-node HTTP on an explicit loopback IP.
- A gateway refuses unauthenticated non-loopback binds; keep that invariant in
  bespoke gateways.
- Publish neither runtime app-server sockets nor Copilot's experimental
  loopback UI-server.
- Treat Tailscale as transport reachability, not application authorization.
- Use TLS for browser/gateway traffic that leaves the local host.

## Dependency and extension risk

Codex app-server transport and Copilot stock-TUI integration depend on upstream
experimental interfaces and exact pins. The Copilot CLI has its own non-MIT
license and redistribution conditions. Review [third-party notices](../../THIRD_PARTY_NOTICES.md)
and requalify exact versions before distribution or upgrade.

The reference web UI keeps runtime stylesheet elements behind a per-response
nonce. In particular, xterm creates styles while opening a native terminal;
keep the nonce-only `style-src-elem` policy and rerun the real browser CSP proof
when changing xterm or its initialization. Do not compensate for a library
regression by adding `unsafe-inline`.

Plugins, providers, and adapters execute in-process. Do not dynamically load
network-supplied or tenant packages. Review their filesystem/network behavior,
secret access, logs, cleanup idempotency, and crash recovery as part of the
deployed binary.

## Reporting

Do not post credentials, private transcripts, exploitable endpoint details, or
unredacted receipts in a public issue. Follow the root [security policy](../../SECURITY.md)
and rotate every credential or endpoint key included in a report.
