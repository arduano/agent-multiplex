# Security policy

Agent Multiplex is intended for trusted personal and internal deployments. Its
shared-secret node enrollment and bearer-authenticated gateway are not a public
multi-tenant identity system. Deploy an identity-aware edge and normal network,
host, secret, and audit controls where organizational users are involved.

## Supported versions

| Version | Security fixes |
| --- | --- |
| Protocol-v4/v5 releases and current protocol-v6 development | Yes |
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
- Answering or expiring an imported interaction preserves its admitted child
  ownership. It does not authorize identity transfer or weaken snapshot and
  terminal-response conflict checks.
- Initial receipt handoff trusts the authenticated standalone child's prior
  authority only during its first complete snapshot. The parent persists this
  admission and accepts no later invented historical receipt or changed terminal
  result. Existing subtree moves and undrained metadata work are rejected; a
  network outage never invokes handoff or promotes an attached branch.
- Runtimes are trusted with allowed workspaces, native harness credentials,
  provider secrets, app-server output, and the runtime account's OS authority.
- Gateways are zero-authority protocol actors but can observe all data granted by
  their sources and route powerful actions.
- `sessions.readLifecycle` requires `read` access. Its public v2 view is
  payload-free and contains only an opaque observation ID, status, typed health
  and host-computed action availability. Native task, queue, interaction,
  child, message and command correlation identities stay in the runtime's
  private reducer. The runtime is its only writer; control and gateway routes
  must preserve the runtime boot, binding, native epoch, sequence, and
  selected-source fences before stripping private fields.
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
- Live queue observations use `read` and may contain operator prompt text. They
  require an active binding and neither activate stopped sessions nor persist
  queue text in the catalog. Moving a queued message into a running turn requires
  `agent-control` and the durable command fence; unknown results must not be
  replaced by remove/resend.
- Native Copilot task lists/progress use the active-binding `read` boundary
  and can include commands, paths, prompt text and recent output. They never
  resume stopped sessions or grant arbitrary shell/process access. Exact-ID
  task promotion and cancellation require `agent-control` and the durable
  command fence. False acknowledgements remain no-ops; an unknown result cannot
  authorize another mutation, alternate task or process-termination fallback.
- Native context compaction requires `agent-control` and the existing durable
  command/binding fence. It can make provider/model requests and changes native
  context. It does not resume stopped sessions, grant tool permissions or add
  a synthetic user prompt. Codex start acknowledgement is not completion; native
  Copilot false results remain false. Unknown outcomes must retain their original
  operation identity without automatic retry.
- Native Codex goal observations use the same live-binding `read` boundary.
  Setting or clearing goals requires `agent-control` and a durable command ID;
  setting an active goal may cause Codex to continue work under its native
  behavior. Goal reads never resume a session or grant tool permissions.
- Copilot's `setPermissionMode` command uses `agent-control` and changes the native
  session's tool, path and URL permission mode. Native managed policy remains
  enforced by Copilot. The adapter never substitutes unconditional approval
  callbacks, resolves unrelated questions, or treats an unacknowledged toggle
  as enabled. Disabling it cannot undo work already dispatched or remove
  independently granted native approval rules.
- Image `read` includes immutable bytes and first-display snapshots inside the
  session workspace plus explicitly configured image output roots. Uploads use
  `agent-control`; quotas and exact binding/boot/source fences bound the operation.
- SVG is transferred as bytes. Runtime code never renders/converts it or fetches
  remote URLs; clients must use an inert image context rather than markup
  injection, frames, or document navigation.
- Allowed-root validation is a path policy, not process, network, credential, or
  filesystem isolation.

## Authenticated renewal review candidate

The [candidate contract](docs/design/p2prpc-renewal-vnext.md) renews credentials
before the unchanged hard expiry while retaining physical stream identity.
Generation-bound mutual transcripts, active-operation reauthorization and a
single pending handoff fence replacement. Invalid credentials, revoked endpoint
admission/policy, authority changes and unfinished expiry fail closed. No RPC
mutation is automatically replayed. Offline token revocation remains limited by
the configured verifier/introspection policy. All p2prpc consumers must upgrade
together; the candidate cannot be released with the old dependency pins.

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
- Generic durable command errors use fixed public text, an allowlisted code,
  stage, certainty and diagnostic ID. Never copy native exception text, stack or
  causes into these receipts. This does not sanitize native history, opaque
  terminal output, launch/archive errors, or arbitrary thrown RPC errors.
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


The optional authority storage worker is trusted code in the same OS process,
not an isolation boundary for hostile plugins. Its private IPC accepts only
allowlisted domain methods and authenticated endpoint context, then re-applies
committed enrollment scopes and the original router validation. No SQL endpoint,
stale authorization cache, remote worker configuration, lock deletion or automatic
mutation replay is exposed. Loopback storage health contains fixed categories and
aggregate timings only, with no native messages, SQL values or credentials.
