# V8 Codex harness

The explicitly installed Codex adapter owns the concrete controller, native
`.162.1` RPC/runtime, history scope/codec, typed harness router and admission
protocol. Shared Multiplex custody facilities do not select a native adapter.

`codexHarness(privateOptions)` is inert. Its immutable definition exposes only
safe identity/version/capability/contribution keys; credentials, provider routes,
commands, instructions and filesystem paths remain private. Lifecycle calls
`create({ scope, directory, cwd })` after it has established workspace ownership.
The runtime remains inert until explicit opening or reader acquisition.

Model choices default to native `model/list`, using the pinned
[0.162.1 model contract](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/model.rs).
Each choice preserves the native model identifier and supported reasoning values;
Codex choices do not invent a selectable provider. The private configured route
and Copilot-only restriction remain authoritative. Hidden models are excluded.
At most eight pages of 64 native rows and 128 visible choices are accepted.
Malformed rows, duplicate identities/efforts, repeated cursors, limits or native
failure make the whole read unavailable; no partial or hardcoded fallback list
becomes a valid writable catalog. Native display name, description, default
reasoning effort and text/image/audio input modalities are optional closed
presentation metadata. Missing fields stay unknown; unrelated native fields
are not projected. Modalities do not establish attachment delivery or visual
interpretation. Existing aggregate catalog bounds still apply.

An active session reuses its exact owned RPC. Before native opening, the runtime
delegates to the Host's single lazy model owner. `createCodexModelCatalog` is an
inert factory for that owner: concurrent reads share one actual read, with a
private managed home and an existing reader allocation. It initializes stdio and
lists metadata without Start, Resume, Send, history reads or MCP contributions.
Successful choices become visible only after exact helper retirement and wire
closure. The default read budget is 15 seconds (maximum 30); a helper timeout
seals/retires only its own allocation. An active RPC timeout returns unavailable
while retaining its one actual query until settlement; it never stops the agent
and late replies cannot continue pagination. There is no result cache or poller.

Failed helper cleanup remains owned and blocks readiness/new reads. Explicit
`retire()` may reconcile only the same sealed allocation's positive `gone`
inspection plus wire closure; it does not replay failed Stop. An allocation that
lacks exact absence proof remains manual intervention. Ordinary retirement is
reusable; final `close()` seals future reads. The optional injected `catalog`
remains a scripted fixture seam. `qualification/models.test.ts` exercises the
actual stdio codec, pagination, owner lifetime and active-RPC timeout boundary;
fresh native/provider acceptance is a separate finite qualification.

Startup contributions are statically targeted: `codexMcp`, `codexInstructions`
and `codexSettings` (explicit multi-agent settings). MCP servers own distinct
names, settings have one owner, and instruction segments preserve explicit
array order. Duplicate ownership is rejected before construction effects.
Instructions use the pinned native `developerInstructions` field on both Start
and Resume; trusted full-access/on-request and provider restrictions remain.
Custom tools use MCP. Skills, custom agents and direct executable tool callbacks
are explicitly unsupported in this adapter increment; no ambient existing home
is imported or changed to simulate support. MCP executable/script dependencies
must be part of the installed CLI package, owned home or workspace mounted by
exact containment; deployment owns that closure, not a sibling source checkout.

Explicit `multiAgent: false` disables both `features.multi_agent` and
`features.multi_agent_v2`, and sets `agents.enabled = false`. In pinned0.162.1,
[native selection](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/core/src/config/mod.rs#L1604)
prefers the model's multi-agent version to the old feature fallback; bundled
Luna selects V2. The explicit V2 feature override precedes `agents.enabled`, so
all three fields form the disabled policy. Scripted actual-runtime checks cover
the emitted policy and trusted full-access/on-request defaults; fresh native
absence-of-tools acceptance remains separate.

The enabled `{maxThreads,maxDepth}` form retains its existing encoding. Its
effective bounds on native V2 remain unresolved: pinned
[agent settings](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/config/src/config_toml.rs#L752)
say V2 ignores the legacy depth limit and uses separate concurrent-thread
settings. This correction does not force a backend version or claim those
bounds for V2. A separate explicit native settings contract is required.

Managed policy remains exact. New-runtime cold readers accept only their exact
prefix plus the existing closed native project-trust suffix. An older artifact's
disabled prefix is refused before allocation and never rewritten or migrated.
Readers retained by an older copied artifact keep that artifact's policy;
this source correction changes no installed home or existing session.

`harness.router({ sessions })` exposes actual inferred tRPC `submit`, `original`
and `read` procedures. Authenticated context supplies scope and generation.
Concrete supported Codex commands cannot be confused with Copilot controls.
Defaults use the pinned closed `thread/settings/update` encoder; running-turn
updates contain only the exact turn ID and supported model/effort fields.
Effects delegate to the lifecycle journal, preserving the same original ID.
There is no effect journal or retry engine inside this adapter.

`codex.mcp.reload` admits one existing original and sends the pinned no-body
`config/mcpServer/reload`. It affects every loaded thread in this native
app-server, including children; it is not per-server restart. Dispatch marks
retained MCP evidence stale without discovery. The empty ACK does not prove a
connected server or current tool catalog. Stopped agents cannot reload through
this control. Native HTTP startup/OAuth and shared Host sign-in remain separate.

Fresh Create advertises `createAndWait`: exact fresh `thread/start`, continuous
initialized wire, no turn/item starts and no unresolved reverse requests after
owned initialization. Explicit `reopen` calls `thread/resume` on the same native
identity and may run queued, goal or interrupted native work. It does not chain
another context turn. Observation loss never licenses replay or claims Stop.

Warm `codex.continue` is native `turn/start` with `input: []`; it adds no user
message. The existing original owns its ACK and uncertainty. Native working,
retrying and pending-input observations refuse before dispatch; the exact pinned
`EmptyInput` NotSubmitted reply handles an active turn winning the remaining
race. Other RPC errors remain unknown. After a terminal network failure this
starts a new native turn over existing history, not a promise to resume the
failed provider request's exact checkpoint. Native acceptance needs its finite
scripted-provider qualification; source tests do not substitute for it.

Send retains the same original `clientUserMessageId` on its native input. A
rejected Send never silently becomes a queued message. Queue requires explicit
intent and has its own original; queue echoes are omitted from receipts.
Send, exact-turn Steer and Queue share verified image/local-image/mention
encoding. Steer cannot retarget a replacement turn or apply next-turn settings.

Initial model uses `thread/start`; requested effort/collaboration uses one closed
settings substep after the native ID is durably owned. An effort-only initial
choice explicitly selects the default collaboration mode and its built-in
instructions. A failed settings substep retains the native owner for Stop.
An empty settings ACK never fabricates observed selection: native notifications
remain authoritative, and running-turn changes do not overwrite future defaults.
Permission intent uses one encoder: full access, read only, and workspace write
map to the pinned native policies; workspace write adds no client-selected roots
and keeps native network access disabled. Opening uses the coarse `sandbox`
field, while Send and future defaults use `sandboxPolicy`. Named native
permission profiles instead use `permissions`, exclusively of either sandbox
field. An opening profile must be positively returned as
`activePermissionProfile.id`; an empty settings ACK never proves it active.
These are the exact [.162.1 opening/settings](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)
and [policy](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/app-server-protocol/src/protocol/v2/permissions.rs)
contracts. Trusted full access/on-request defaults are unchanged. The UI offers
the native-observed profile, not an invented profile catalog; configured custom
profile definitions remain the Host configuration owner's responsibility.
Running-turn updates still accept only the fields supported by that distinct
native method. These boundaries have scripted exact-wire checks, not fresh
native restricted-sandbox enforcement proof.

On an explicitly certified Resume, the lifecycle carries its last observed
selection as opening intent before clearing the new generation's observations.
The adapter retains the selected model/access for opening and decodes the actual
Resume reply's effort, collaboration mode and instructions. It sends no initial
settings replay on Resume; native persisted settings remain authoritative.
This settings behavior does not qualify passive Resume: the pinned native
implementation can dispatch persisted queued input and active goals on Resume.

Background terminals use the existing native-read/action boundary. An explicit
`codex.terminals` read requests one bounded page (1–100 entries) from
`thread/backgroundTerminals/list`; its cursor never starts another read.
`terminateTerminal(processId)` and `cleanTerminals()` preserve original receipts
and invoke the exact native terminate/clean methods. A native `terminated:false`
remains a no-op result, and clean's empty ACK does not certify an empty list or
agent Stop. The React UI retains the latest page, marks it stale after effects
or connection loss, and refreshes only on a user action. There is no terminal
registry, pagination accumulator, native poller or process-PID control escape.

Explicit stopped history shares one sessionless RPC for the exact root run
across root/child ports. Every child page re-proves native ancestry. One lifetime
and page budget cover the owned helper; sealing it does not release custody
until exact retirement completes. Mounts and inventory reads remain inert.

Root attention replaces the controller's former turn/idle flag with one small
native projector. Matching native turn status supplies finished/error/interrupted;
`willRetry` supplies retrying. Only new model output/tool dispatch proves recovery,
and stale tool output or child terminals cannot settle the root. Capture gaps
make an identified turn unknown until positive native evidence resolves it.
The lifecycle's existing writer retains the fact; Stop and ACK are not outcomes.

The installed `v8-harness-defaults` package retains the existing known-native
validation/selection facade for existing clients. `NativeProtocol` is explicitly
injected into the default lifecycle and supervisor; neither has a fallback
native registry. Future harnesses may supply their own protocol/router or a
custom lifecycle. The installed default native DTO facade still describes only
Codex/Copilot and does not claim Claude Code native acceptance.

Run `npm test` here for this adapter's focused plugin/native boundary checks, or
`node ../v8-harness-defaults/qualification/run.mjs` for the combined reused native
oracles. All use scripted/disposable boundaries and require no model/native CLI
activation. The composed checkpoint owns final frozen integration evidence.
