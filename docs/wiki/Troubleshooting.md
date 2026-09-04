# Troubleshooting

Start with the data role that owns the failed fact. Gateway errors describe
projection/routing, control errors describe authority/catalog, runtime errors
describe native binding/provider state, and adapter errors describe the harness.

## Minimal diagnostic set

```bash
agent-multiplex describe
agent-multiplex sources
agent-multiplex control-nodes
agent-multiplex runtime-nodes
agent-multiplex sessions --state running,stopped
agent-multiplex interactions
agent-multiplex watch --heartbeats
```

Add `--json` for exact IDs, fences, revisions, operation states, and timestamps.
Retain gateway, control, runtime, adapter, and provider logs for the same window,
then scrub them before sharing.

## `Valid bearer authentication is required`

- Confirm the URL points at `/trpc`, not the control's p2p endpoint.
- Supply `Authorization: Bearer <token>` for HTTP and the same value in
  WebSocket connection parameters.
- In the CLI, use `--auth-token` or `AGENT_MULTIPLEX_AUTH_TOKEN`.
- Confirm the credential exists in the gateway auth file and the token file is
  readable by the gateway process.
- Confirm a non-loopback gateway was not started without auth.

Do not move the bearer to a query parameter. The web `#token=` fragment is only
a local prototype input and may still be exposed in browser artifacts.

## `Web Crypto SHA-256 is unavailable in this environment`

Current browser mutation helpers use `SubtleCrypto` when available and an
audited `@noble/hashes` SHA-256 fallback otherwise, with tests proving exact
Node digest parity. Seeing this message means the browser loaded a stale web
bundle: rebuild the web workspace, restart the asset-serving gateway, and clear
the browser cache. HTTPS is still strongly recommended because bearer-token
transport and browser storage need a secure origin even though request hashing
no longer depends on one.

## `Native history unavailable`

Inspect the owning runtime and adapter rather than reading vendor files.

- Confirm the session's runtime is online and its boot/binding revision is
  current.
- Check runtime heartbeat/reconnect and the app server or SDK process.
- A short p2prpc renewal window may return one retryable 503; the web UI retries
  for a bounded 11.5 seconds.
- A persistent error or `INTERNAL_SERVER_ERROR` is not normal renewal. Preserve
  the three role logs and verify endpoint enrollment and native history calls.
- Archived sessions intentionally have no native-history route.

## Agent uses an unexpected model after reload

The canonical session records only settings acknowledged by the harness. Check
the session's `harnessSettings`, the launch's requested native options, and
adapter `settings` events. Do not treat a UI select's local default as proof of
native state. If the harness does not acknowledge persistence, display that
uncertainty rather than inventing a catalog setting.

## No launch profile or model

- Use `launchProfiles.list` for the selected runtime and harness.
- Confirm the runtime registered the provider/backend and advertises it as
  available.
- Match provider ID, profile ID, contract version, and schema hash exactly.
- Check runtime allowed roots and backend selection.
- Models are profile- and harness-dependent; do not assume a global model list.

## Launch is stuck or `outcomeUnknown`

Query `launches.get` with the same launch ID. Inspect provider checkpoint,
external resource identity, and runtime logs. Never generate a new request to
"retry" an ambiguous native start. A provider must explicitly prove
`retryPreparation`, return a prepared result, or declare ambiguity.

## Session will not archive

Stop first and confirm a non-active binding with `runtimeStatus=stopped`.
`unavailable` is not cleanup proof. Query the archive operation and inspect
backend then provider release. `failed` leaves the session stopped;
`outcomeUnknown` requires external reconciliation.

## Metadata conflict or a queued patch that does not settle

- Fetch the current metadata snapshot and per-key revisions.
- Check the patch's expected realm/control/epoch fence.
- On `conflicted`, decide from the returned canonical values and submit a new
  intentional operation with current CAS revisions.
- On `queued`, inspect branch-to-authority connectivity and delivery/outbox
  progress. Disconnection never promotes the branch.
- Archived metadata settles only at authority and is never delivered to the
  released runtime.

## Gateway source is suppressed or conflicting

Suppression is expected when a selected ancestor covers the same subtree; the
descendant remains warm. `conflict` is different: retain both snapshots and find
the authority, identity, binding, metadata, or operation fork. Do not fix it by
raising priority or concatenating results.

## Runtime cannot reach control after restart

Confirm the configured endpoint ID still matches the preserved control identity.
The ticket may contain an obsolete ephemeral direct address; use a stable p2p
bind or refreshed locator for the same pinned endpoint. Re-enrolling a different
endpoint is a trust change, not ordinary reconnect.

## Terminal unavailable

- The session must have a current active structured binding.
- Both source and bearer grants need `terminal-view` or `terminal-control`.
- Check the runtime process-wide terminal limit.
- Codex needs the supervised private app server.
- Copilot terminal support is opt-in, exact-version experimental, and may
  deliberately fall back to structured-only mode.
- Runtime restart removes every PTY and lease by design.

## Build or checkpoint failure

Confirm `NODE_AUTH_TOKEN` can read the `@arduano` GitHub Packages scope and that
the pinned `@arduano/p2prpc-core` version exists and grants this repository
access. Reinstall from the lockfile, then run `npm run clean`, `npm run
typecheck`, and `npm run check:checkpoint`. Develop an unpublished transport
change in `../p2prpc`, but release it before changing this repository's exact
registry dependency. Do not restore stale `dist` files or add archived v2
packages back to the workspace to make a build pass.
