# Security policy

Agent Multiplex is intended for trusted personal and internal deployments. Its
shared-secret node enrollment and bearer-authenticated gateway are not a public
multi-tenant identity system. Deploy an identity-aware edge and normal network,
host, secret, and audit controls where organizational users are involved.

## Supported versions

| Version | Security fixes |
| --- | --- |
| `0.1.x` (v4 release) and current protocol-v5 development | Yes |
| Protocol v3 and earlier | No |
| Archived protocol-v2 host/worker source | No |

Because Codex app-server and the optional Copilot TUI bridge use pinned upstream
interfaces, include exact Codex/Copilot, Node, p2prpc, and Agent Multiplex source
versions in every report.

## Report privately

Do not open a public issue containing exploit details, credentials, private
transcripts, endpoint identities/locators, unredacted logs, or receipts.

Use GitHub's **Security → Advisories → Report a vulnerability** flow for this
repository when private vulnerability reporting is enabled. Otherwise contact
the repository owner through a trusted private channel already established for
the deployment. Include:

- affected source revision and dependency versions;
- affected role, topology, and deployment platform;
- impact and prerequisites;
- minimal reproduction or proof, scrubbed of real secrets and user data;
- whether an operation may have reached `outcomeUnknown`;
- any mitigation or patch proposal.

Rotate every shared secret, bearer/provider token, terminal lease, native auth
credential, or endpoint key disclosed in a report. If an endpoint private key
is exposed, treat the enrolled endpoint identity as compromised rather than
only rotating its reachability ticket.

This project currently offers no bug bounty or response-time SLA. Maintainers
will acknowledge and coordinate fixes on a best-effort basis before public
disclosure.

## Security boundaries

- Control nodes are trusted canonical metadata/catalog authorities.
- Runtimes are trusted with allowed workspaces, native harness credentials,
  provider secrets, app-server output, and the runtime account's OS authority.
- Gateways are zero-authority protocol actors but can observe all data granted by
  their sources and route powerful actions.
- Gateway plugins, runtime providers/backends, and adapters are trusted
  in-process modules. They are not tenant sandboxes.
- A statically injected runtime path policy is also trusted application code
  and may broaden filesystem admission beyond configured roots. Remote requests
  cannot install one. Default root fencing, native identity/provider guards and
  separate image snapshot confinement remain enforced by their owning layers.
- p2prpc endpoint IDs are independently pinned; tickets and discovery data are
  locators, not identity.
- Terminal output is opaque and unredacted. `terminal-control` is equivalent to
  typing at a native agent under the runtime account.
- Image `read` includes immutable bytes and first-display snapshots inside the
  session workspace plus explicitly configured image output roots. Uploads use
  `agent-control`; quotas and exact binding/boot/source fences bound the operation.
- SVG is transferred as bytes. Runtime code never renders/converts it or fetches
  remote URLs; clients must use an inert image context rather than markup
  injection, frames, or document navigation.
- Allowed-root validation is a path policy, not process, network, credential, or
  filesystem isolation.

## Required deployment practices

- Keep control-node HTTP on explicit loopback and expose only an authenticated,
  TLS-protected gateway.
- Use distinct gateway bearers per person/device and minimum scopes at both the
  source grant and downstream credential ceilings.
- Close enrollment apertures immediately after expected endpoint pins are
  durable.
- Keep runtime roots narrow and provider/harness credentials runtime-local.
- Never publish Codex's private Unix socket or Copilot's experimental loopback
  UI-server.
- Protect SQLite databases, WAL/SHM files, endpoint identities, backups, logs,
  retained image directories, and native histories as sensitive data.
- On Windows, create private state with protected inheritable DACLs restricted
  to the current user, SYSTEM, and Administrators. Validate existing file ACLs
  too; restricting a parent does not remove a child's broader Windows access.
  Unsupported ACL inspection and unsafe restored state must fail closed. Do
  not bypass managed execution policy to run the ACL helper or native harness.
- Never store secrets, transcripts, terminal bytes, or provider checkpoints in
  session metadata.
- Reconcile `outcomeUnknown` by its stable operation/resource identity; do not
  blindly retry a potentially committed action.
- Treat a gateway `conflict` as a correctness incident; source priority cannot
  repair an authority or immutable-record fork.
- Requalify the exact native and p2prpc dependency boundary before upgrades.

The concise threat model and operator checklist are in
[`docs/wiki/Security.md`](docs/wiki/Security.md); deployment details are in
[`docs/deployment-v4.md`](docs/deployment-v4.md).

Bespoke gateways can statically compose an externally authenticated HTTP/WS edge.
That trusted edge must verify credentials, assign action scopes, enforce origins
and connection expiry, and retain the reference byte bounds. Declaring an external
edge is not a remote or environment-controlled authentication bypass; the reference
daemon retains its bearer/explicit-loopback policy.
