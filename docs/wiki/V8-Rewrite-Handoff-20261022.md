# V8 source handoff

V8 is an isolated clean-break implementation under `primitives/`, separate from
the maintained released workspace graph. Start with [repository instructions](../../AGENTS.md),
[current state](Current-State.md), the [architecture contract](../design/v8-architecture.md)
and [module map](../design/v8-rewrite-map.md).

The framework baseline is published `.44` source
`ecb4e1b2c85b1ee80f5e9e275c04ac4287fcd420`. This is a source provenance reference,
not qualification of later V8 changes. Existing released package and dependency
facts remain with their maintained owners.

Select one explicit lifecycle and harness per Host. Preserve exact native
custody, original-operation evidence, history semantics, privacy and trusted
permission behavior while reducing redundant state and coupling. UI selection,
Gateway routing and observer cancellation never decide native execution.
Applications supply their own accounts, profiles, deployment policy and external
domain integration outside this public repository.

Use bounded focused checks and the [composed source gate](../../primitives/v8-integration/README.md).
A unique invariant/oracle determines retained coverage; moving an implementation
does not justify cloning its suite. Historical ignored artifacts retain their
original inputs and failures; they are not portable public evidence for a later
source tree. Source qualification does not imply native/model acceptance,
publication, deployment or permission to modify existing runtimes.

Native/model work requires fresh finite authorization and disposable exact-owned
resources. No application checkout, private plan, credential/home, service or
external workflow is an implicit dependency of this handoff or the public
framework's build and tests.
