# Reviewing and amending the stack

The stack is25 responsibility layers, each a single logical commit and draft PR
against its immediate predecessor.01 is an empty tree, not a compatibility shim.
No PR should merge by itself while its descendants are under review.

Read the numbered note beside the source diff. Start with identity/originals/
custody02–06, then history/files/interactions07–09. Review each native adapter
separately10/11. Authority and transport12–14 precede retained clients/React/chat
15/16. The next layers connect those existing owners instead of replacing them:
conversation17, assets18, reference19, remote catalog20, attachments21, children22
and file links23. Packaging24 and acceptance25 close the public artifact boundary.

## Select an independent checkpoint

```sh
git fetch origin
git worktree add /tmp/multiplex-review-17 origin/rebuild/v8/17-conversation
cd /tmp/multiplex-review-17
npm ci --ignore-scripts --include=optional
npm run check
```

Use a new path outside every other checkout so Node cannot resolve an omitted
dependency from an ancestor's node_modules. Standard installs retain native
optional platform bindings; omitting all optionals is a narrower source-only
check, not complete transport installation proof. PR01's oracle is instead an
empty `git ls-tree -r` result.

No check needs an existing provider home or native session. Normal tests are
model-free. Read qualification limits before running opt-in endpoints/browser
or platform checks. Explicit inputs and actual ownership always outrank a test
count.

## Amend the responsible owner

The integration owner records the old SHA of every affected branch, uses a new
isolated worktree at the layer's parent, cherry-picks that layer and edits/amends
it there. Later layer commits are replayed in order onto the new parent, resolving
only changes required by the revised contract. Keep each numbered branch and PR
number; update its pointer to the corresponding replayed commit.

Run the decisive changed-owner oracle, public type/boundary checks and a stable
integration checkpoint. A source-only amendment does not require replaying every
unrelated native qualification. Changes to a real native/platform boundary do
require their own finite evidence. Update that layer's note and the acceptance
record, retaining failed receipts and narrowing obsolete claims.

Publish all affected pointers together with `git push --atomic` and an explicit
`--force-with-lease=refs/heads/<branch>:<recorded-old-sha>` for **each** owned
branch. Do not use an unbounded force push, merge the stack, rewrite main or reset
another working tree. A lease rejection requires read-only reconciliation first.
The PR bases stay the previous numbered branch, so each review remains a small
logical diff after restacking.

## Where a correction belongs

A durable dispatch/checkpoint race belongs in03/06, not a UI recovery worker.
A vendor protocol difference belongs in10 or11. Reconnect/custody invariants belong
in13/14/15; a native lifetime never belongs to a React component. File capture
and byte leases belong in08/18/23; attachment draft state belongs to the existing
client entry introduced in21. Catalog metadata remains12/20 even when displayed
in the same navigation as native session status. Acceptance25 records evidence;
it does not become a patch bucket for earlier owners.
