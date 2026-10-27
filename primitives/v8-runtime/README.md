# V8 runtime ownership seam

One `RuntimeSupervisor` implements the existing session `NativePort` for one
logical root. It is a trusted, purely injected Host helper, with no Node,
process, SDK, network, provider, persistence or timer dependency. SessionHost
remains the only durable lifecycle and original-effect owner.

```ts
const runtime = new RuntimeSupervisor({ scope, ownership });
const host = await SessionHost.open({ directory, scope, policy, port: runtime });
```

`RuntimeOwnershipPort.open` is called only for explicit Host Create or
Resume. It returns an `OwnedAttachment` with an exact RunRef, opaque captured
attachment/process/containment identity, observed native baseline and native
invoke closure. Fresh Create independently requires `createAndWait`; explicit Resume requires `reopen` and may continue native saved work. There is no chained context turn or promise that reopening stays idle. `inspect` is a separate read-only method; it never opens,
attaches, resumes, retries or replays native work. A missing result is unknown.

`stopTree` must provide an exact existing `StopProof` plus native containment
evidence. Shared placement requires peers preserved; dedicated placement
requires its containment retired. These are trusted adapter obligations. The
supervisor validates their identity and shape; it cannot prove a native tree
ended by inspecting a controller or PID. It performs no OS signaling.

One actual Stop promise survives caller deadlines and same-owner inspection.
Starting Stop fences new direct invocations even after failure. Unexpected
start results are retained in quarantine and cannot license a replacement.
Controller/transport loss and leader exit stay independent observations and
never generate a stopped event. Same-owner inspect refreshes the native read
baseline and current sink/dispatch closures while preserving the Stop owner.

Run `npm test` in this module for the bounded strict build and focused
Node invariants, including actual SessionHost/SQLite composition. The exported
qualification fixture is scripted; no Codex/Copilot/native/model process runs.
Existing session process tests already establish parent-exit/descendant and
shared/dedicated fixture boundaries, so this lane adds no redundant OS fixture.
Actual native strong Stop, saved-work reopening and platform containment retain
their separately scoped qualification. Fresh creation's quiescence proof is
distinct from explicit reopening, which may continue saved work.

The framework [runtime ownership contract](../../docs/design/v8-architecture.md#runtime-and-organization)
explains its relationship to session lifetime and retained views.
