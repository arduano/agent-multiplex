# Copilot adapter

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
- permission requests use native request/completion events and the SDK's pending
  permission RPC, preserving their exact request identities. Questions,
  elicitation and exit-plan callbacks remain separate pending interactions.
- history is read exclusively through `CopilotSession.getEvents()`. The adapter
  never reads Copilot files. The opaque pagination cursor has the form
  `copilot:event-index:<n>` and pages the native event array without interpreting
  event content.
- `stop` disconnects the SDK handle but preserves the vendor session for native
  resume. `close` gracefully disconnects all handles and stops the shared CLI.

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
