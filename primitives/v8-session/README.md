# V8 session contracts and retained client

The current session module owns browser-safe identity/receipt/native DTO contracts,
universal bounded validation/opening proofs and the retained SessionWorkspace.
SessionHost and its journal moved together into the selected
[default lifecycle plugin](../v8-lifecycle-default/README.md). There is no kernel
fallback lifecycle. The engine and RuntimeSupervisor require an explicitly
injected [NativeProtocol](src/contracts/native-protocol.ts) for native policy,
command/selection/event admission, urgency, read validation and Send settings
order. Concrete invocation bodies live in the
[Codex](../v8-harness-codex/README.md) and
[Copilot](../v8-harness-copilot/README.md) harness packages.

The browser entry exports contracts, bounded validators and retained clients;
it does not reexport concrete native invocation factories. The explicit
[installed Codex/Copilot defaults](../v8-harness-defaults/README.md) and each
harness expose their own behavior. The current DTO union describes those two
families; it is not a global Host
router registry or a claim to implement a future Claude Code native contract.
Concrete invocation compilers are imported directly from
[Codex invocation](../v8-harness-codex/src/invocation.ts) or
[Copilot invocation](../v8-harness-copilot/src/invocation.ts); the former session
native compatibility barrel is removed.
Generic plugin/router composition infers additional custom structures from the
selected definitions without importing private native runtimes into React.

This source lane is outside maintained published workspaces. The selected
lifecycle owns durable run/Stop intent, original operations, native effects and
callbacks. The browser entry excludes worker storage and process fixtures.

Stop seals admission durably and publishes Stopped only for exact native-tree
proof. Failed/shared stops remain visible and preserve peers. Explicit Resume
reopens native context and permits its saved work; it never chains another
Continue or replays a prompt. Fresh Create opens quiescent. View changes,
pins and reconnect never create native lifecycle intent. Remote tools retain
their actual resource owners.

The [source architecture](../../docs/design/v8-architecture.md#native-lifetime-and-settings)
separates native facts, effect receipts and connection freshness. The original
standalone runner and current composed gate retain their own selected source
scope; local historical results do not qualify subsequent changes.

## Modules

| Folder / entry | One responsibility |
| --- | --- |
| [contracts](src/contracts/types.ts) | Browser-safe concrete commands, immutable identities, receipts and native facts |
| [native validation](src/native/validation.ts) and [opening](src/native/opening.ts) | Universal proof/envelope validation; concrete invocation factories are imported from their selected harness |
| [default lifecycle Host](../v8-lifecycle-default/src/session/index.ts) | Selected plugin's durable originals/run/Stop owner; journal moved with it and urgent controls remain independently bounded |
| [client](src/client/workspace.ts) | Shared retained session state, native type narrowing and actual history/file composition |
| [qualification](qualification/run.mjs) | One frozen check/build/Node/Chromium gate; owned disposable resources and source manifest |

The browser [entry](src/index.ts) excludes the Node Host. `SessionWorkspace`
exposes stable `subscribe`/`getSnapshot` entries for a thin React binding; no
production hook or transport is added here. `agent(scope)` returns a concrete
Codex/Copilot union. Callers narrow the kind before using native actions.
`bind` is read-only; a new run requires explicit history `rebind`. Viewing,
pinning and reconnecting never create/Resume/Stop or replay an original request.

Preparation acquires its subscription before reporting success. Failed
acquisition can be retried by another explicit prepare; a later snapshot failure
preserves the already-owned subscription and retained intent. `close()` first
marks every entry disconnected/stale, then attempts every observer release. It
reports aggregate cleanup failures and retains only those exact handles for a
later explicit close. A late handle returned during synchronous closure is
released immediately. None of these transitions sends native Stop.

Unsettled originals are observed by this same retained client. Lost/nonfinal
replies, restored references and native/reconnect observations request coalesced
exact-receipt reads through its existing bounded read owner. Final receipt
commits pulse the selected Host's existing session watch at a newer observation
revision, preserving native phase/activity/generation. A pulse arriving during
or at release of a held read remains observable. There is no receipt polling
timer, second journal or mutation retry. Failed reads retain uncertainty;
receipt acknowledgement still does not prove completed agent work.

The journal defaults to 128 originals/4 MiB metadata and reserves Stop capacity.
There is no compaction/rollover yet. The client refuses protected capacity
pressure instead of evicting a pin, original operation or draft. Private answer
bodies remain in memory; the durable journal retains only identity/hash markers.

## Qualification boundaries

Scripted native ports, actual worker SQLite, disposable Node process trees and
Chromium exercise different seams. Scaffolding process placement is not a
native performance or full-tree Stop claim. Actual native working-agent halt,
explicit saved-work reopening, promptless Continue, callbacks/policy inheritance and platform containment
need their own finite scoped evidence. Controller-only disconnect is not
promoted into strong Stop by a passing mock.

See the [composed gate](../v8-integration/README.md) for current source inputs and
unique oracles. No native/model work or installed product operation is implied
by a source checkpoint.

Explicit reopening and promptless Continue retain the existing original and
SessionHost admission owner. `reopen` permits saved work to run; fresh Create's
`createAndWait` remains independent. Passive reads, reconnect, navigation and
pinning activate neither. Cold reopening never chains a second native turn.
Warm Continue requires a complete empty interaction baseline, idle activity and
no current-generation retrying fact, checked again immediately before dispatch.
The concrete native adapter owns the remaining atomic active-turn race.

Existing session journal migration 5 adds one private opaque parent identity.
It is durable before agent acquisition or stopped-reader intent. Only an exact
positive sealed-parent nativeTree proof can retire old pre-capsule Starting or
reader allocation intent after Host loss; a new invocation ID or missing PID is
insufficient. Parent identity/proofs never enter session snapshots or original
receipts. Unknown originals remain unknown after positive native retirement.
