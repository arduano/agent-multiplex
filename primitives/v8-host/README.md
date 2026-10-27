# V8 shared Host facilities

This module contains the shared custody contracts, controller base, bounded
native-media projections, Send preparation and exact Linux containment facility.
It does not select Codex/Copilot or own a session lifecycle implementation.

The browser [entry](src/index.ts) exports contracts only; its Node
[entry](src/node.ts) exports the shared Controller/containment facilities.
Concrete [Codex](../v8-harness-codex/README.md) and
[Copilot](../v8-harness-copilot/README.md) controllers/runtimes belong to their
installed harness packages. [Default lifecycle](../v8-lifecycle-default/README.md)
owns AgentHost assembly, workspace/native creation and SessionHost's journal.
These are isolated development modules, outside the published release graph.

The finite native metadata helper contract, `HostModelCatalog`, belongs to
[Host contracts](src/contracts.ts). Adapters supply its inert factory; the
selected lifecycle owns the returned helper's read/retirement lifetime. The
contract does not require importing a lifecycle implementation into an adapter.

Composition selects exactly one lifecycle plugin and one harness:

```ts
import { defineHost, activateHost } from "../../v8-plugins/src/index.js";
import { codexHarness } from "../../v8-harness-codex/src/node.js";
import { defaultLifecycle, existingDirectoryWorkspace } from "../../v8-lifecycle-default/src/node.js";

const harness = codexHarness(privateCodexOptions);
const definition = defineHost({
  contract: { id: "application.codex", version: 1 },
  harness,
  lifecycle: ({ harness }) => defaultLifecycle({
    harness, workspace: existingDirectoryWorkspace(), directory: privateDirectory,
    policy: {
      kind: "codex", provider: "copilot-only",
      access: { approval: "on-request", sandbox: "danger-full-access" },
    },
  }),
  harnessRouter: ({ sessions, harness }) => harness.router({ sessions }),
});
const host = await activateHost(definition, { route, storage, authenticate });
// Definition/activation do not Create, Resume, fetch history, discover MCP or Send.
// Explicit lifecycle.create admits the original and workspace input afterward.
```

The default lifecycle [AgentHost assembly](../v8-lifecycle-default/src/assembly.ts)
still composes the existing stream/file/callback/MCP owners. Its observations
and ownership invariants below remain distinct from static Host composition.
The selected harness supplies a history scope/codec facet and a required
NativeProtocol; assembly and RuntimeSupervisor contain no native-kind fallback.

`binding()` is null until SessionHost durably knows a native session, then returns
`{run: RunRef, history: HistoryScope}`. File scope uses the real native session ID;
it never substitutes the logical catalog ID. A resumed native session keeps file
bytes and, within the same Host observation epoch, streamed history. A Host writer
reopen creates a new history observation attachment with an explicit cold gap.

Only explicit session Create/Resume opens native state. The concrete transport is
owned by the caller. `TrustedContainment` supplies independently qualified exact
ownership, fresh-creation quiescence, explicit saved-work reopening and
native-tree halt evidence. This
library validates that evidence; transport loss, idle, leader exit, abort,
unsubscribe and disconnect do not generate it. Without the required declarations
the existing SessionHost refuses Create/Resume.

The optional awaited early-owned callback records an actual native identity and
Stop capability before post-open metadata/settings/certification. Until complete,
phase remains Starting; actual confirmations may be answered but ordinary Send
and settings are blocked. An initialization failure leaves the original receipt
unknown and retains the known owner. Stop can bypass hung initialization. Only
exact halt permits a new explicit Resume; late old initialization/callbacks cannot
change that generation or run another settings substep. Successful final native
installation releases only its exact opening admission slot before publishing
Running, so the first intentional Send need not wait for Create receipt IO. The
old opening finalizer cannot release a newer Send's slot. This readiness rule
also holds for final-only ports without optional early notification.

Within the default lifecycle implementation, `AgentHost.terminate()` detaches this owned Host writer/capture/file worker and leaves native
controller/callback custody intact. `AgentHost.close()` requires the existing SessionHost's
stopped/settled boundary. Neither method calls native disconnect, Stop, Resume,
archive or delete. `controller.dispose()` releases its library listeners only after
exact halt; it does not close the caller's native transport.

Notification capture and reverse-request continuity have independent failure
boundaries. Codex live notifications use the native transport's frame bound;
startup buffering remains bounded. A dropped notification, malformed optional
metadata, rejected media projection or throwing history consumer reports a
history gap and uncertain progress without invalidating intact approval callbacks.
Actual reverse-request loss, unproved callback ancestry and transport loss still
make the confirmation baseline partial. A later idle/completed notification
never repairs a genuinely partial callback owner. The default lifecycle owns
the history-gap projection; presentation cannot reset either owner.

The installed systemd backend acquires one delegated **owning Host process**
hierarchy with `acquireHostContainment({unit, systemctl})`. Its service requires
`Restart=no`, `Delegate=yes`, `KillMode=mixed`, `SendSIGKILL=yes` and a60s stop
limit. Acquisition verifies the actual main PID/invocation and moves this Host
into its invocation's control subgroup once. It precedes native admission.
`systemdUserAllocation({directory, containment})` is then an inert per-session
subgroup factory. Every gate is a direct Host child before placement, so whole
Host force includes a gate even before SessionHost saves its opening capsule.
Native agents end with this Host process; UI/Gateway disconnect remains passive.

Each allocation retains its own sealed gate and exact cgroup device/inode.
Session Stop retires that subgroup and its actual pending gate, then removes only
that identity-checked empty kernel group while retaining its receipt and native
home. This prevents one kernel group accumulating per Stop/reopen. Peers survive.
The backend exposes `parentCustody` for the existing SessionHost journal: positive
old-parent retirement can settle a pre-capsule opening or allocating reader,
while lost original outcomes stay unknown. Invocation subgroups are distinct
even when systemd reuses the service's path; a changed invocation alone proves
nothing. No native inventory, adoption, second store or per-allocation manager
unit is added. The former independent-unit backend is retained only as an exact
old-capsule inspector/retirement path, never an allocation fallback.

Four scripted owner oracles qualify peer-preserving Stop, pre-capsule whole-Host
force, pending placement and stale invocation/cgroup fences. Physical delegation,
crash/force, installed replacement and native executables require their separate
finite platform acceptance; source checks do not imply those claims.

The backend's optional `launcher: { binary, args }` is an explicit trusted Host
ABI selection, such as a pinned dynamic loader on NixOS. The gate still admits
the SDK's exact original arguments, then executes the fixed prefix followed by
the original vendor binary and arguments inside the same cgroup. Default Hosts
execute the vendor directly. No OS detection/fallback, global loader setting or
vendor-binary patch occurs. Profiles must supply and qualify their actual OS
runtime; copying an ELF alone cannot establish that it runs on the target.

Important explicit limits:

- Optional `history: { port(run, scope), limits? }` injects the existing read-only
  native page adapter. Without it, `historyRecovery.state` remains `unavailable`
  and explicit recovery reports `unsupported`. Factories must perform no native
  work; authorization belongs to each exact native read, including child ancestry.
- `history.recover(scope, {signal?, timeoutMs?})` admits one bounded Host-derived
  cold/gap episode. Its body-free outcome is separate from baseline rows published
  through the retained stream. Mount, reconnect, selection and pins never call it.
  A stable native/capture generation and latest genuine native gap batch identify
  the episode; a read's own gap healing cannot replenish its allowance. Ordinary
  deltas/completion and repeated Recover clicks cannot create another episode.
- `history.older(scope, cursor, captureGeneration)` requires the view's exact
  capture generation before invoking native work. The existing retained view token
  accepts its returned page privately and preserves its reading anchor. Native
  RunRef generations namespace episodes even when Resume keeps the same history
  scope/capture generation. Prior-generation child scopes grant no new read authority.
- Actual native read leases also have a stable context. Explicit recovery/older
  requests resolve that cheap binding before reusing an acquisition; Stop retires
  it once per run. Only an opaque hash reaches snapshots/pages/cursors. A changed
  context retires pending paging tokens and native cursors, while retaining loaded
  current/private rows, content versions, order and scroll anchors. The new lease
  starts at its own explicit baseline. Context discovery is observational: an
  offline viewer sees the fence on its next authenticated frame, not at a globally
  simultaneous instant. Context-less legacy ports cannot qualify reader replacement.
  Clearing local read fences fails closed if context publication fails; actual
  native capacity remains held by the independent coordinator until settlement.
- One shared `ReadCoordinator` reserves actual work until settlement. Consumer
  cancellation/expiry removes only its bounded wait; it does not cancel native
  work or create replacement capacity. These scripted checks establish composition
  and local merge fences, not an atomic native snapshot/live-callback contract or
  real Copilot cursor lifetime. No vendor history files are parsed.
- Initial Codex effort/collaboration uses the exact settings RPC after durable
  native-ID custody. Supported defaults/running-turn settings reuse the validated
  native invocation helper and preserve sticky collaboration/instruction rules.
  Native notifications establish observed values; an ACK does not. Fresh Create
  advertises `createAndWait` independently of explicit `reopen`. Reopening may
  continue saved native work; its opening observation establishes current custody
  and callback completeness, without a false no-continuation certificate.
- Send, Steer and explicit Queue accept the same closed harness-specific reference manifest (eight inputs,
  10 MiB per artifact, 20 MiB total raw artifact bytes). SessionHost durably
  admits references before its optional trusted preparation hook. AgentHost
  joins existing FileHost protection and exact committed receipt observation;
  private bytes never enter the original journal or browser command. Concrete
  encoders snapshot them, and only bounded native acceptance identities enter
  receipts. One preparation owner handles all three authoring paths, before
  Copilot Send settings where needed; Steer and Queue apply no selection override.
  Stop fences pending reads and subsequent encoding; an admitted Send is
  definitely refused, while a dispatched original retains uncertainty. Actual
  read leases/buffers release on actual settlement, not a viewer timeout.
  Artifact protection settles only on its exact terminal original receipt.
- Native disk inputs require explicit `nativeInputRoots` visible at the same
  path in the native runtime, intersected with existing FileHost policy and
  handle checks. There is no capture/spool fallback. Reopen scans existing
  protection rows by bounded private keyset pages and releases only recognized
  older epoch/generation inline consumers with exact terminal message receipts;
  unknown or mismatched originals remain protected. Failed cleanup blocks
  future attachment preparation, independently of urgent Stop/answers.
- Copilot initial assisted permissions or clearing effort are explicitly refused.
  Mode/effort/provider/permissions are otherwise applied and positively checked;
  incomplete post-open work retains ownership and cannot ACK Create.
- SDK question/form/plan callbacks omit native request IDs. Returning the callback
  proves response submission, not native resolution. They remain partial; idle,
  transcript content and a guessed completion correlation cannot clear them.
- Concrete Codex reverse requests require the transport's original one-use token,
  response closure and exact settlement Promise. Vendor IDs alone are insufficient.
- Real native containment, peer preservation and strong Stop remain unqualified by
  these scripted checks. No native executable, provider or model is launched here.

`npm run typecheck`, `npm run build`, and `npm test` remain the bounded isolated
Host-domain qualification. New plugin boundaries have their own harness/default-
lifecycle checks; the composed integration gate owns combined source evidence. `qualification/fixture.ts` exports `scriptedHost(kind,{cwd,model?})`
for parent composition, with concrete native-shaped captures and independent
effect/read counters. Its containment certificate is synthetic, explicitly
separate from actual native proof.

The default lifecycle's explicit Archive preflight observes these actual read,
MCP, media and file owners. Busy work refuses before sealing; a completed
Archive fences file acquisition/writes while retaining all bytes and original receipts.
One durable stopped-reader intent/capsule is recorded before its launcher; the
existing allocation backend retires that exact `reader` purpose on archive or
explicit runtime opening. Unconfirmed/legacy custody cannot be flattened into
absence. No scanner, implicit Resume, native-history deletion or cleanup retry
owner is added.

An explicitly requested completed-Archive transcript read can subsequently use
one exact journalled sessionless reader. It launches from retained native
custody metadata, so it cannot recreate a released workspace. Pending Archive,
agent mutations and new file/media acquisition remain sealed. The default
lifecycle owns this passive read distinction; loaded history is not a claim
that an arbitrary cold archive or native runtime has been qualified.
