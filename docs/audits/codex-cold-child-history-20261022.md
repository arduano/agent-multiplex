# Codex cold child-history authorization

The owner-authorized disposable qualification found a selected native helper
whose history worked while loaded but failed after a Host cold restart. Native
metadata returned the exact helper ID, its own context ID, and agreeing direct
and source spawn parents pointing at the original native root. The prior reader
required the helper context to equal the root context and refused it before
reading items. This was a read authorization assumption, not a native writer
failure or permission to resume/replay work.

The correction retains native identities and proves every parent edge to the
managed root, bounded to 32 nodes. Both source spellings and direct parent fields
must agree; explicitly malformed spawn parents fail closed. After the full path
is proved, each context may name only its node, a proved ancestor or root context.
An ancestor cannot use a descendant's context to authorize itself. Fresh opens
reprove the full chain and retire earlier cursor authorization on failure.
Attachment retirement fences reads before any item page. Older pages may reuse
only a successfully proved selection within the same reader attachment.

Deterministic coverage includes cold child context, inherited descendant
context, canonical/legacy source-only ancestry, malformed/conflicting parents,
foreign identity/context, changed cached ownership and cursor continuation,
cycles, exact 32-node and rejected 33-node paths, root identity and read retirement.
Package gates and public asset hashes are retained in owner qualification
evidence. All 17 packages advance to `0.2.4-hotfix.44`; transport/native pins,
persisted schemas and generated native declarations remain unchanged. Candidate
publication does not claim registry promotion, hosted CI, live fleet deployment
or real VM lifecycle acceptance. Actual published-artifact cold read acceptance
is a separate zero-inference disposable check.
