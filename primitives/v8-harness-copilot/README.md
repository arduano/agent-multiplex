# V8 Copilot harness

This explicitly installed adapter owns the concrete controller, exact SDK
`1.0.19`/CLI `1.0.95` runtime, native history and media binding, typed tRPC harness
router and native admission protocol. It preserves separate native model, agent
mode, permission, queue, task and callback semantics. A provider route never
changes the native harness family.

The supported singular BYOK provider binds the whole native session to one
authorized framework route. Public `Selection.providerId` identifies that route;
it is not an assertion that native `model.getCurrent` returned the same opaque
provider ID. Model/effort still come from actual native observations. The
controller authorizes a model command's route, then omits that label from the
native `switchTo` request: a bare model retains this session's BYOK provider.
Native `providerId` instead names a registered catalog entry. This adapter does
not register additive providers, mix CAPI/BYOK routes or permit credit fallback.

`copilotHarness(privateOptions, offlineDependencies?)` is an inert immutable
Host definition. Lifecycle calls `create({ scope, directory, cwd })` only after
workspace ownership. `create` verifies the published runtime pins and materializes
explicit packaged skill assets, but does not start an SDK, native session or
provider. Runtime construction and startup configuration remain private; public
manifests contain safe plugin IDs, versions, capabilities and ownership keys.

Supported static contributions are `copilotMcp`, `copilotSkills`,
`copilotInstructions`, `copilotTools`, `copilotAgents` and `copilotSettings`.
MCP keys, skill names, agent names, setting keys and tool policies have one owner.
Allowing and excluding the same tool conflicts. Instructions append in explicit
configuration order. Copilot MCP configurations preserve their stdio versus
HTTP/SSE union; arbitrary function callbacks are not accepted as JSON settings.
Direct SDK tool handlers are unsupported; custom tools enter through MCP.
Custom agents preserve explicit `model` and `reasoningEffort` startup requests.
The latter is the pinned SDK's `low | medium | high | xhigh | max` union; unknown
fields, Codex spellings and malformed values are refused before runtime creation.
Omitted fields stay omitted. The SDK may fall back to the parent model when an
agent model is unavailable, and resolves omitted effort from model configuration
before same-model inheritance. These requests are not observed child selections;
only actual native dispatch/usage can establish those. Model/provider policy and
no-credit-fallback remain with the configured runtime and its provider boundary.
Managed-settings activation requires a native token contract not present in this
BYOK runtime, so its startup setting can only remain disabled. Native supported
live model/reasoning/mode/permission actions remain separate from Host updates.

A skill contribution names a complete packaged directory manifest: relative
paths, exact byte lengths, SHA-256 and executable bits, including each named
`skill/SKILL.md` and every referenced asset. Provisioning refuses missing,
unlisted, oversized, mismatched or symlinked files. Verified bytes are copied
into the owned native home, which is an existing containment mount; the runtime
never references the package's source directory. A retained installation manifest
and byte checks refuse configuration replacement or native-modified files.
Nothing overwrites an existing home to force an update. Deployment must stage
explicit MCP executable/script dependencies inside mounted installed resources.

The actual `submit`/`original`/`read` tRPC router derives authenticated scope and
delegates to the same lifecycle original journal. Copilot's settings sequence
(mode, model/effort, permissions, Send) is adapter policy; the lifecycle retains
admission and checks current ownership between each step. No new receipt manager,
mutation replay, polling queue or native session lifetime is added.

`copilot.mcp.reconnect` targets one known enabled static server under that same
original journal. A passive configured read precedes exactly one
`restartServer({serverName})` for HTTP/SSE/stdio. Reconnect does not assert that
OAuth succeeded or updated persisted credentials; that native notification
belongs to a positively correlated login. The earlier unconditional HTTP
notification failed against a real unauthenticated fixture before restart.
Each native call checks current custody, so Stop during configuration observation
cannot launch a later restart.
Native replies and authorization URLs never enter the receipt; its ACK is not
connection health. Config-discovered transport stays unknown and is not writable
through this control. Dispatch/native change events invalidate retained MCP
evidence without polling or implicit refresh.

`copilotSettings({id,mcpOAuthTokenStorage:"persistent"})` explicitly selects the
SDK's OS keychain for the same managed native home on Create and Resume.
Omission preserves the SDK default. This does not share homes/accounts or prove
keychain availability, sign-in success or cross-session Host-profile credential
reuse. OAuth initiation and its transient secret-response channel remain pending.

Fresh writable choices remain distinct from retained Resume observations.
Fresh Create refuses explicit null-effort clearing and assisted permission
selection. Resume accepts those observed values without sending either as an
unsupported write: a retained null omits `reasoningEffort` from SDK options,
while actual `model.getCurrent`, `permissions.getMode` and `mode.get` supply the
new observed facts. Resume never silently changes assisted permissions to manual
or replays stale plan mode. If an injected native seam lacks a read facet, that
observation stays absent. Required permission event bridging stays enabled on
every opening. Newer native events cannot be rolled back by initialization.
These are scripted settings/ownership guarantees; Resume lifetime admission
retains its independent native continuation requirements.

The streaming event boundary retains the SDK's optional native timestamp.
Only root `session.usage_checkpoint` and `session.shutdown` with a valid timestamp
and cumulative `totalNanoAiu` emit the closed `copilot.usage` fact. Child events,
malformed/missing amounts and token-usage events cannot establish accounting.
The lifecycle session writer owns monotonic persistence and freshness, while
applications choose how to present native units. History reads do not seed it.

Root attention uses native event IDs, since loop-local turn IDs can repeat.
`assistant.idle` alone never means finished; known live children can establish
background work, while continuous full `session.idle` supplies a settled root
cycle. Native errors/aborted outcomes remain distinct, children cannot fabricate
root outcomes, and capture/lineage contradictions stay unknown. The failed-call
retry index does not promise a retry. This observer reuses existing child maps,
has no task scheduler, and delegates persistence to the existing session writer.

`prepareHistoryReader(run, scope)` shares one sessionless persisted-event client
per exact root run. Scope-specific ports retain independent continuation rules;
an end page does not retire a helper needed by another pinned scope. Existing
TTL, explicit release and decode/native-error cleanup own its lifetime. A native
agent filter is not child authorization: only captured/proved Host scopes can be
selected, and unknown cold children remain unavailable. No history read resumes
an agent or replays an original action.

Run `npm test` for focused scripted checks, or the `v8-harness-defaults` runner
for the combined reused native oracles. The composed checkpoint owns final
frozen integration evidence. No native/model acceptance is implied by these
scripted checks; native gaps remain explicit in the composed source/proof boundary.

Live user attachments and known tool-result image leaves share the history
decoder's closed structural map before ordinary event framing. Inline image
bytes use the existing separately bounded file capture; unrelated metadata,
tool arguments and unknown payloads retain their normal bounds. Opaque asset
references still report unavailable bytes; this adds no native asset resolver.

Explicit reopening uses SDK `resumeSession` with `continuePendingWork: true` and
`allowTranscriptRecovery: false`, under the same durable original and native
identity. Saved work may continue; no context turn is chained. Missing resume
boundary/pending inventories preserve a partial callback baseline rather than
claiming a passive reopen. Native selection and permission observations remain
authoritative; reopening never silently rewrites them.

Fresh Create and explicit reopening each read native `metadata.activity` once
inside their existing opening observation. An actual inactive result can publish
idle even when the SDK emits no idle event. Missing, failed or active metadata
does not establish idle, and the controller's activity revision fence preserves
any newer native work event that arrives while the read is pending. This adds
no history read, poller or continuation action.

The genuine promptless encoder is `session.sendMessages({ messages: [], mode:
"immediate" })`, with no invented user prompt. The pinned SDK `1.0.19`/CLI
`1.0.95` supports a zero-message run, but it does not expose an atomic idle
precondition. In the scoped native test, one Send followed by empty immediate
input during its held turn produced two native turn starts and one observed
user-message event. The second turn requested work after the original response
had been released and completed. Two accepted HTTP requests alone were not the
oracle; the native turn counters established the added turn. This used a local
scripted provider, zero live model calls, and positively verified native-tree
and owning-process cleanup.

The default controller therefore keeps `copilot.continue` unadvertised. A
retained idle snapshot cannot guarantee safety against work starting before
native dispatch. The encoder remains available for bounded qualification; no
configuration certificate or runtime flag bypasses the missing guarantee.
