# Windows Copilot observation policy — October 9, 2026

## Source and acceptance boundary

This coordinated `.39` candidate starts from frozen `.38` source
`8075f170eef1937aa63aca21928b6bab3b2350aa` and includes the independent IPC
correction `050a82be1159876d205489c6bc75a4a6e20961cd`. All sixteen maintained
packages, internal edges and lockfile entries advance together to `.39`. Frozen
`.38` assets, native SDK/CLI, transport dependencies, wire schemas, stores and
migrations are unchanged. Publication and installed acceptance remain separate.
No live role, owner session, native model, authentication or deployment action
belongs to this source qualification.

Five captured Windows Resume requests expired around the old 15-second adapter
deadline. This does not uniquely prove that SDK resume stalled: embedding MCP
configuration admission previously ran before the actual SDK call, inside the
same wrapper observed as an attachment. The source repair adds distinct stages;
consumer admission isolation and live recovery remain separately owned.

## Contract

One immutable policy is selected at the adapter boundary and passed to shared
read, operation and session owners. Standard/Linux budgets remain startup 60s,
attachment/read/mutation 15s and cleanup 10s. Windows defaults are startup 180s,
attachment 120s and reads/mutations/cleanup 60s. Complete explicit overrides
must contain positive integers within Node's timer range, with read budgets
validated at no more than 600s to match the observation driver. The exact 600s
read boundary passes, 600001ms fails and other timers retain Node's original cap.
Existing exported standard constants retain their values.

The optional generic `prepareSession(config, signal)` preserves the SDK config
type and holds one native-ID reservation through private preparation and SDK
attachment. The shared attachment deadline aborts preparation observation;
late preparation can finish local I/O but cannot call the SDK. Refusal before
SDK dispatch produces a definite `CopilotAttachmentPreparationError`.
The shared `AdapterPreparationError` base allows Runtime to journal the actual
adapter refusal as a definite admission failure. Startup recovery records
`prepareResume` / `preparationFailed`, with the existing recovery-error envelope
and Stop-or-retry action. Neither path manufactures a native owner. Both private
receipts survive reopening the durable store.
The reservation persists until the original preparation settles. Post-dispatch
timeout retains native uncertainty, the original operation and exact late
disconnect proof.

Private diagnostics distinguish `attachmentPreparation` from `attachment`,
with fixed elapsed/deadline metadata and no configuration contents. Embeddings
must use the preparation hook and admit its diagnostic stage explicitly;
preprocessing inside create/resume remains conservatively ambiguous.

Session detach and whole-owner close each receive their full cleanup budget.
The old remaining-window arithmetic could reduce the second budget to nearly
zero after a slow detach. Forced termination still requires an exit from the
exact captured child, and late proof cannot rewrite an earlier failed close.
These are observation bounds, not native cancellation or an overall shutdown
deadline. Expiry never admits an additional owner or mutation replay.

The same read budget is supplied to the attachment observation driver. Its
no-success watchdog permits two full serialized view reads and a retry: 45s
with standard 15s reads, 180s with Windows 60s reads. Periodic refresh requests
cannot renew that watchdog; unchanged stale observations still fail.

## Qualification

Twelve deterministic regressions use disposable SDK fixtures and fake timers.
They cover Windows acknowledgement beyond 15s, the old 15s negative control,
finite Windows expiry and retained lanes, slow startup/read/send/disconnect,
refreshed task deadlines, child exit proof, preparation ordering/refusal,
retirement and exact late completion. A separate exact old-cleanup-arithmetic
negative control fails the 45s detach plus 30s child-exit regression; the
correction passes without forcing the process.

The combined focused gate passes **229 tests in ten files**. It includes the
actual Copilot adapter-to-Runtime admission and startup refusal regressions,
durable reopen checks, wider watchdog cases and both authority IPC hops. The
prior standalone 154-test timeout gate and root's 77-test integration gate
remain separate, overlapping evidence; they are not summed. Combined full
producer qualification passes typecheck, **1,688 tests in 152 passing files**
(eight tests and one file skipped), build, checkpoint/docs/release/secrets and
whitespace checks. The final typecheck/test/build gate retains identical source
inventories before and after execution. Local receipts are in the protected
`receipts/windows-recovery39-20261009/final` directory; their manifest and checksums
identify exact gate logs and source inventory.
Final receipt manifest SHA256:
`b73000a1f20043e4b07f392c1d6d21c65a664bfd6b44f0d6f297068217715fd2`. Qualified non-documentation source inventory SHA256:
`573073e04b1a298ef0b0d140113328051af54aafa383af4d38f035e66e1aa81c`.

The source unit gate uses a newly created private mode 0700 tmpfs fixture root
under `/dev/shm` and two workers, avoiding unrelated NAS disk/fsync contention.
This does not establish native Windows or physical-disk durability acceptance.
The earlier standalone unused-import typecheck failure, dependency script-policy
refusal, missing-node-pty collections and interrupted broad run remain distinct
diagnostic receipts. Only the already approved node-pty dependency build was
run directly; script policy and product dependencies were preserved.

## Required integration and limits

Consumer MCP admission must move to the typed preparation seam and keep its
private-file protections while avoiding the shared Host event loop. The
consumer diagnostic owner must recognize the new stage and safe timing fields.
This source change does not implement that consumer worker.

Runtime mutation journaling retains the original durable command ID. The
reference Control authority's outer router and reverse-child IPC hops now allow
600s for the exact enumerated durable native mutations. Catalog, health,
enrollment, receipt reads and other storage observers retain 30s. The
regressions cover slow access/link Resume, original-ID reconciliation after
expiry, retirement without replacement and ordinary observer refusal.
This budget does not alter transport/authentication limits.

Shorter observers still exist outside the producer: consumer lifecycle checks
10s, native-history checks 30s, and the reviewed p2prpc link's default per-frame
I/O wait 30s. Their expiry cannot cancel a native mutation or authorize replay.
Coordinated consumer review must decide its Windows observer budgets; no
independent transport package change is made here.

Native Windows installed qualification, actual resume recovery, publication,
consumer pin selection and any fleet maintenance remain pending outside this
source worktree. Original failed/unknown native receipts remain unchanged.
