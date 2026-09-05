# Paired launch extensions

Embedded runtime applications can pass `createComponents` as the third argument
to the published `runRuntimeNode` function. The factory receives canonical
allowed roots and returns adapters, terminal providers, optional backends and
launch providers, and `includeDirectWorkspaceProvider`. The daemon continues to
own reconnect, inventory reconciliation, journals, and shutdown. Return all
constructed components only after successful preparation; the factory owns
cleanup if it throws before returning.

Use a paired extension when session creation needs domain policy: for example a
PR URL, repository authorization, worktree creation, container placement, quota,
or cleanup. The gateway half presents and validates the workflow; the runtime
half independently validates and executes it.

```text
domain client
    |
    | review.launch { prUrl, policy, target/profile selector }
    v
gateway plugin -- restricted GatewayLaunchPort --> launches.create
                                                    |
                                                    v
runtime provider --> backend --> harness adapter --> native session
```

There is no discovery protocol, package marketplace, or network-loaded code.
Both halves are trusted TypeScript modules statically imported by bespoke
application entry points.

## Define one shared contract

Put these values in a shared extension package:

- a namespaced provider ID such as `company.review`;
- a stable profile ID such as `pull-request`;
- a positive contract version;
- canonical public JSON Schema for the opaque launch input;
- a validator that returns plain JSON;
- domain metadata keys such as `review.repository` and
  `review.pull_request`.

Compute `requestSchemaHash` with `jsonSchemaSha256`. The runtime registry
recomputes it at startup. A request copies the complete profile identity, so a
matching name with a changed schema cannot silently execute.

Do not put credentials, clone tokens, provider checkpoints, container IDs, or
mutable workflow state into public launch input or metadata. Resolve secrets
from runtime-local configuration. Keep the workflow system's authoritative
state in that system and store only namespaced links in session metadata.

## Gateway half

Implement `GatewayPlugin<Router>`:

1. Validate and normalize the domain request.
2. Authorize the repository/PR and caller in application middleware.
3. Select or require an exact runtime and advertised profile.
4. Allocate retry-stable launch and logical-session IDs.
5. Build the provider input and optional initial metadata.
6. Call only `GatewayLaunchPort.create`.
7. Return the durable `LaunchRecord`; let clients poll or watch it to a terminal
   state.

The core intentionally has no scheduler. If the plugin selects a runtime, make
placement a named, testable domain policy and log the decision. A generic UI can
instead require the caller to select a runtime/profile.

Use `launchRequest` from `@arduano/agent-multiplex-client` when one call can allocate
new IDs. For a retrying job system, persist the generated request before the
first call and reuse it unchanged. Reusing a launch ID with another payload
fails closed.

## Runtime provider half

Implement `RuntimeLaunchProvider` with the same descriptor and schema:

| Hook | Responsibility |
| --- | --- |
| `validateInput` | Repeat runtime-side admission for input and harness |
| `listModels` | Optional profile-aware model discovery |
| `prepare` | Provision resources, checkpoint external effects, select backend, return native spawn options |
| `recoverPreparation` | Prove retry, return an already prepared result, or declare ambiguity |
| `compensate` | Idempotently undo a definite failure before native binding |
| `prepareResume` | Re-establish provider resources for interactive resume or temporary history access |
| `stop` | Preserve provider resources needed by a resumable stopped session |
| `release` | Idempotently release session-exclusive provider resources during archive |
| `close` | Process shutdown only; never per-session cleanup |

Call `saveCheckpoint` immediately before and after every external-effect
boundary needed for honest crash recovery. If recovery cannot prove whether an
effect happened, return `outcomeUnknown` or throw
`LaunchProviderOutcomeUnknownError`. Never guess and allocate a second resource.

`prepare` returns a `backendId`, harness-native `spawnOptions`, and optional
provider-private JSON state. The runtime journal stores this result and immutable
provider implementation version. It never becomes public session metadata.

## Backend half

A `RuntimeAgentBackend` is an opaque backend ID plus one harness adapter and an
optional idempotent per-session release hook. Register every backend and provider
when constructing `RuntimeNodeService`. Startup rejects duplicate backend IDs,
duplicate harness/adapter scopes, duplicate profile identities, and schema-hash
mismatches before serving work.

Keep provider and backend responsibilities distinct:

- Provider: worktree/container allocation, credentials, placement, resume
  substrate, and resource cleanup.
- Backend: the adapter-facing native execution target and any native
  session-specific cleanup.
- Adapter: Codex/Copilot calls, native events, interactions, and history.

Archive releases the backend first, then the provider. The provider-owned
container or worktree may still be required to reach the backend.

## Containerized PR reviewer example

For an isolated reviewer profile:

1. The gateway requires and normalizes a PR URL and review policy.
2. The runtime resolves credentials, creates a worktree, and checkpoints it.
3. It starts a container and checkpoints its immutable identity.
4. It returns the backend inside that container plus a container-local `cwd`.
5. Stop preserves the worktree/container if the profile promises resume.
6. Archive releases the native backend, removes the container/worktree
   idempotently, persists a binding tombstone, then makes the catalog row cold.

If the profile advertises per-session process isolation, the app server and
adapter-facing endpoint must live inside the container. A containerized CLI or
worktree connected to one shared host app server is density optimization, not
process isolation.

## Testing an extension

- Unit-test canonical schema hashing and both validators against the same corpus.
- Verify malformed registry entries fail before any plugin/provider side effect.
- Crash after each provider checkpoint and prove the chosen recovery result.
- Retry the exact launch request and verify one resource and one session.
- Reuse the ID with a changed field and require a payload mismatch.
- Exercise stop, resume, native history, archive release ordering, and restart
  tombstones.
- Run the extension through its mounted tRPC router, selected control path, and
  real runtime provider—not only against a fake port.

See [the complete extension contract](../design/launch-extensions-v4.md).
