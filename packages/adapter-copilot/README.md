# Copilot adapter

## Empty sessions and restart

Pinned Copilot CLI `1.0.81` does not durably save a session that has never received
a user message. Its public native save operation does not force those empty
events to disk. The session remains controllable while its native handle exists,
but may be missing after native shutdown or a host restart. Multiplex does not
insert a dummy message, parse vendor files, or recreate that session silently.

The exact native missing-session load refusal is a failed resume with a recovery
message, rather than an ambiguous operation that blocks lifecycle recovery.
Stop and archive that catalog entry explicitly, then create a replacement.
Transport loss and unrecognized native failures still remain `outcomeUnknown`
under the original operation ID; absence from an inventory page is never proof
that a resume failed or permission to retry it.

`CopilotAdapter` hosts one SDK-managed Copilot CLI runtime and exposes it through
the runtime-node-core `AgentAdapter` contract. Multiple active sessions share that
runtime and its configured Copilot home/account scope.

The default SDK mode is `copilot-cli`, which intentionally exposes the normal
local coding-agent behavior and is appropriate only for the trusted personal or
internal runtime node assumed by the v1 design. Embedders can pass `clientOptions` to
select a separate `baseDirectory`, authentication, runtime connection, or the
SDK's stricter `empty` mode.

Key behavior:

- `spawn` and `resume` install event and interaction handlers before the SDK RPC,
  so startup events are buffered until runtime-node-core subscribes.
- prompts use native `enqueue`/`immediate` delivery; models and
  interactive/plan/autopilot modes use the SDK's native APIs.
- the selected model is read through native `model.getCurrent` on each attachment
  and updated by root model-change events. Delayed reads cannot replace newer
  choices, and missing native state never implies a default selection.
- mode is read through native `mode.get` on attachment and mirrored from root
  `session.mode_changed`, including native transitions out of plan mode. Newer
  native modes fence delayed reads and command acknowledgements.
- `assistant.idle` leaves ongoing commands, background agents and pending root
  interactions active; root `session.idle` marks whole-session work idle. Native
  `metadata.activity` reads on attachment and inventory reconcile missed lifecycle
  events using existing active handles, without resuming sessions.
  Failed activity reads mark unchanged running/idle observations unknown while
  retaining newer native events, errors and actionable pending input.
- permission requests use native request/completion events and the SDK's pending
  permission RPC, preserving their exact request identities. Questions,
  elicitation and exit-plan callbacks remain separate pending interactions.
- full history is read through `CopilotSession.getEvents()`; the opt-in primary
  view uses native `eventLog.read`. The adapter never reads Copilot files.
  The full-history opaque pagination cursor has the form
  `copilot:event-index:<n>` and pages the native event array without interpreting
  event content.
- `stop` disconnects the SDK handle but preserves the vendor session for native
  resume. `close` gracefully disconnects all handles and stops the shared CLI.

Read-only native requests have a 15-second caller deadline and coalesce identical
in-flight reads. A timed-out request retains its native slot until settlement;
late results are discarded, and repeated polling cannot issue replacements while
it is stalled. The adapter caps retained pending reads across session handles at
256. Primary-history page-size reductions share one deadline. Mutations are never
timed out or retried by this helper. See [stalled reads and recovery limits](../../docs/wiki/Adapters-and-Terminals.md#stalled-copilot-reads).

The implementation is pinned and tested against `@github/copilot-sdk@1.0.13`.
The optional stock-TUI integration additionally pins
`@github/copilot@1.0.81`; it does not accept an auto-updated or merely
SDK-reported version.

## Native allow-all permissions

The `permissions.mode` capability supports the Copilot command
`{ type: "setPermissionMode", mode: "manual" | "allow-all" }`. It calls native
`session.permissions.setMode`, independently of interactive/plan/autopilot.
Native `allow-all` covers tool, path and URL permission
requests. The runtime remains responsible for its managed policies; the adapter
does not replace permission handlers with unconditional approvals.

`harnessSettings.copilotPermissions` contains the native acknowledged permission
mode. The adapter reads `permissions.getMode` on every fresh
attachment/resume, accepts root `session.permissions_changed` events and fences
late reads/replies behind newer native events. Native `assisted` is observable but
cannot be selected through this command. Missing or unrecognized state remains
unknown, and attaching never changes permissions. Native persistence determines
the state after resume; the adapter reads it instead of replaying a stored toggle.

A refused change fails with the native actual state still visible. A dispatched
change with a lost or malformed reply is `outcomeUnknown`. Use the original
command receipt; never blindly issue another operation. A newer native state
may differ from the exact operation's acknowledged result.

Enabling allow-all does not independently answer existing requests. Only native
`permission.completed` retires the matching permission interaction when another
native client or policy change has settled it. Questions and plan transitions
are never answered by that setting. Turning it off does not undo work already
dispatched or remove separate native approval rules.

## Experimental stock TUI

Copilot does not expose a supported stock-TUI attach command for an existing
headless SDK runtime. `CopilotUiServerRuntime` is therefore an opt-in escape
hatch built around the CLI's hidden `--ui-server` mode. The TUI owns the
runtime and the adapter joins it as a sibling SDK client. A single PTY is shared
across the adapter scope, foreground-session changes require confirmation, and
terminate/restart are disabled because they would also kill structured
sessions.

The runtime probes the actual executable for exact CLI version `1.0.81` and
always passes `--no-auto-update`. Current UI-server builds reject
`COPILOT_CONNECTION_TOKEN` with `AUTHENTICATION_NOT_CONFIGURED`, so this path
uses a random, unadvertised listener bound strictly to `127.0.0.1` and no
connection token. It must remain inside a trusted runtime OS/container and
must never be port-forwarded. The reference runtime keeps this mode disabled by
default and falls back to the normal structured adapter without terminal
capability if its version/startup probe fails.

The PTY and all output/replay/keyboard-lease state remain in runtime memory.
They are not Copilot history and are never persisted or returned by
`readNativeHistory`.

## Runtime-node-local BYOK provider

Embedders can configure a singular Copilot SDK `ProviderConfig` through the
adapter constructor:

```ts
new CopilotAdapter({
  provider: {
    type: "openai",
    baseUrl: "http://codex-lb.internal/v1",
    apiKey: readRuntimeNodeSecret(),
    wireApi: "responses",
    transport: "http",
  },
  defaultModel: "gpt-5.6-sol",
  providerModels: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
});
```

`baseUrl` is the OpenAI-compatible API base, so codex-lb URLs include `/v1`
and do not include `/responses`. Responses over HTTP are the supported v1
codex-lb path. A configured provider requires `defaultModel`. The optional
`providerModels` list is deduplicated, always includes that default, and
replaces SDK model discovery for `models.list`; it is an advertised allowlist,
not authorization for `setModel`.

The adapter disables logged-in-user authentication for this singular BYOK
runtime and injects the same provider and resolved model into both
`createSession` and `resumeSession`. Re-supplying it on cold resume matters
because provider credentials are not reconstructed from Copilot's persisted
history.

Credentials belong to the embedding runtime node and never to the multiplex
protocol. The reference runtime node reads an API key or bearer token from one of two
mutually exclusive `*_FILE` variables. Its native path policy rejects
`native.provider` and `native.providers`, so a fleet client cannot serialize a
credential or replace the runtime node's provider. Adapter model descriptions do not
include the provider object.

See GitHub's pinned
[custom-provider documentation](https://github.com/github/copilot-sdk/blob/v1.0.13/nodejs/README.md#custom-providers)
for the upstream `ProviderConfig` surface.


## Native tracked tasks

Experimental `tasks.list`, `tasks.progress`, `tasks.promoteToBackground` and
`tasks.cancel` v1 capabilities expose native task observations and exact-ID
controls. Synchronous shell waits, background tasks and native model/owner
attribution remain intact. Lists refresh detached-shell metadata and share a
bounded read lane/deadline; they never load history or resume a stopped session.
False mutation acknowledgements remain no-ops; uncertain acknowledgements use
the existing durable command identity without retry or shell fallbacks.

See [task operation guidance](../../docs/wiki/Adapters-and-Terminals.md#copilot-tracked-tasks)
for view/command names, read limits, native caveats and client behavior. The
[disposable native smoke](test/native-tasks-smoke.mjs) proves sync-shell
promotion/cancellation without model requests; Windows and model-driven
agent/client behavior remain separate UAT.
