# V8 reconstruction review stack

The owner requested a literal empty baseline followed by a logical progression
to the entire generic framework. Breaking API changes are permitted; private
consumer compatibility and production deployment are outside this stack.

PR01 removes every tracked file from `main` at
`c95e5a0483aa2601e101dcfe9b2809d7deba7679`.
The retained source reference is commit
`61d90fd1cb356ccf15a7d681f8d896e38196ef9d`; uncommitted work is not an input.
Sound algorithms may be reused with source provenance and their decisive oracle.
The previous package layout, generation compatibility and historical test suite
are not requirements. A new tree is not evidence that every native behavior was
freshly qualified.

## Review order

| Layer | Outcome                                                            | Dependency and review question                                                                                        |
| ----- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 01    | Empty Git tree                                                     | Is every tracked file removed, without altering other branches or installations?                                      |
| 02    | Toolchain, logical identity, module boundaries and review contract | Can one public source graph build independently, with no private checkout?                                            |
| 03    | Private SQLite and durable original journal                        | Is an original committed before an effect, deduplicated forever and observable after a lost reply?                    |
| 04    | Native allocation and lifetime supervision                         | Does Stop prove retirement of the exact owned tree; do late results retain custody?                                   |
| 05    | Static typed Host, harness, lifecycle and extension contracts      | Can a consumer infer its real router while invalid cross-harness calls fail to compile?                               |
| 06    | Default lifecycle and workspace strategy                           | Does one owner admit Create/Send/Stop/Resume/Archive without a second outbox?                                         |
| 07    | Streamed history and bounded exception reads                       | Are rows coherent, omission boundaries honest and actual exception reads bounded? Native cold readers follow in10/11. |
| 08    | Files, images and native input preparation                         | Are bytes immutable/scoped, cleanup accounted and unsafe/private paths refused?                                       |
| 09    | Questions, approvals and MCP                                       | Are exact one-use capabilities retained independently of viewers, with real confirmation semantics?                   |
| 10    | Codex adapter                                                      | Are native controls, settings, children, history, errors, goals and queue behavior preserved?                         |
| 11    | Copilot adapter                                                    | Are its genuinely different controls/history/tasks/callbacks preserved without unsafe invented capabilities?          |
| 12    | Catalog authority and organization                                 | Is logical identity/metadata owned only by Root, separate from native custody and routing?                            |
| 13    | Gateway authentication, routing and HTTP streams                   | Are grants/epochs checked, originals forwarded once and quiet/shared feeds retained correctly?                        |
| 14    | Published p2prpc/Iroh and multiple relay paths                     | Does one connection owner heal observations without closing another consumer or replaying an effect?                  |
| 15    | One retained typed client and thin React hooks                     | Do drafts, originals, pins, history and independent view anchors survive switching/reconnect?                         |
| 16    | Themeable chat, native forms and safe rich previews                | Is the conversation usable on desktop/mobile through public consumer APIs?                                            |
| 17    | Conversation integration                                           | Do lifecycle, history and callbacks feed the retained client without another owner?                                   |
| 18    | Asset integration                                                  | Do uploads, captured media and preview leases retain their exact scoped bytes?                                        |
| 19    | Reference application and explicit process CLI                     | Can a public consumer compose Root, Host, Gateway and UI with external private state?                                 |
| 20    | Remote Root catalog                                                | Can authenticated typed consumers browse/watch/CAS metadata without owning native effects?                            |
| 21    | Retained attachment drafts and composer                            | Do picker/drop/paste uploads become exact durable Send inputs without losing newer drafts?                            |
| 22    | Read-only child histories                                          | Can proved child streams retain independent views/pins without becoming fake sessions?                                |
| 23    | Authorized file links                                              | Can native Markdown references resolve through actual scoped file authority and safe previews?                        |
| 24    | Immutable Nix payload                                              | Does the exact public lock produce an isolated runnable package without mutable state?                                |
| 25    | Composed acceptance and review ledger                              | Which actual source, package, browser and transport boundaries pass, and which remain unqualified?                    |

The ordinal identifies responsibility, not an arbitrary line-count target. A large
layer can be split before publication; its successors retain an explicit parent.
PRs are draft and must not be merged independently while this series is under
review. The PRs are linked in GitHub native stack **#72**. Published review chain: [01](https://github.com/arduano/agent-multiplex/pull/47),
[02](https://github.com/arduano/agent-multiplex/pull/48),
[03](https://github.com/arduano/agent-multiplex/pull/49),
[04](https://github.com/arduano/agent-multiplex/pull/50),
[05](https://github.com/arduano/agent-multiplex/pull/51),
[06](https://github.com/arduano/agent-multiplex/pull/52),
[07](https://github.com/arduano/agent-multiplex/pull/53),
[08](https://github.com/arduano/agent-multiplex/pull/54),
[09](https://github.com/arduano/agent-multiplex/pull/55),
[10](https://github.com/arduano/agent-multiplex/pull/56),
[11](https://github.com/arduano/agent-multiplex/pull/57),
[12](https://github.com/arduano/agent-multiplex/pull/58),
[13](https://github.com/arduano/agent-multiplex/pull/59),
[14](https://github.com/arduano/agent-multiplex/pull/60),
[15](https://github.com/arduano/agent-multiplex/pull/61),
[16](https://github.com/arduano/agent-multiplex/pull/62),
[17](https://github.com/arduano/agent-multiplex/pull/63),
[18](https://github.com/arduano/agent-multiplex/pull/64),
[19](https://github.com/arduano/agent-multiplex/pull/65),
[20](https://github.com/arduano/agent-multiplex/pull/66),
[21](https://github.com/arduano/agent-multiplex/pull/67),
[22](https://github.com/arduano/agent-multiplex/pull/68),
[23](https://github.com/arduano/agent-multiplex/pull/69),
[24](https://github.com/arduano/agent-multiplex/pull/70),
[25](https://github.com/arduano/agent-multiplex/pull/71).

The final integration was split from the original18-layer outline into nine
responsibilities (17–25) before publication. Each remains independently buildable.
See [the feature and retirement ledger](Feature-and-Decisions.md),
[the state/module/test map](Ownership-Map.md) and
[the qualification record](25-acceptance.md) and
[the amendment workflow](Amendments.md).

## Architecture rules

- Leaf protocol types and structural ports never import concrete owners.
- Host lifecycle owns admitted effects and native resources. Adapter policy is
  injected; generic modules do not dispatch between concrete vendor packages.
- Catalog owns identity/metadata. Gateway receives ports, not another catalog.
- One retained client entry owns drafts/originals/projections/pins. React reads
  that owner through committed subscriptions rather than duplicating its store.
- History, files, callbacks and MCP retain distinct actual resource owners.
  Observer loss does not end admitted work. Native idle is not positive Stop.
- Browser/Node/adapter/chat entry points are explicit. Internal implementation
  paths and a private sibling repository are not consumer API.
- One package and lockfile are used initially. Native adapters and React entries
  remain optional consumer boundaries; module count does not imply package count.

## Per-PR review note

Each numbered note records contract/change, authoritative owner and lifetime,
prior failure/edge cases, included/deferred behavior, public exports, exact
commands/results, effect/resource counts, cleanup and remaining unqualified
boundaries. Source reuse names the reference file/commit and why the owner remains
sound. Retired tests name the changed behavior and replacement invariant.

Review the PR's diff against its direct parent. Build/test that branch for its
own checkpoint; do not infer a layer is complete from tests at the final tip.
Normal CI is model-free. Opt-in native checks require exact finite authorization
and cannot manufacture existing-session changes or production cutover authority.

## Amendments

Branches use `rebuild/v8/NN-name`; each PR targets the preceding branch. The
integration owner amends the responsible layer, replays downstream logical commits
onto the revised parent and updates only these stack branches with explicit
force-with-lease. PR numbers and review notes remain stable. Downstream changes
needed for a revised contract belong in their own layer, not a patch piled at the
tip. Keep branch/PR/commit/evidence references in this index current.

Existing deployments and the retained rewrite source are never rebased, reset,
cleaned or updated as part of this process.

## Review feedback and module isolation

[Feedback.md](Feedback.md) tracks owner review requests and their actual resolution.
[Modularity.md](Modularity.md) defines the core rule: self-contained business or
platform machinery owns its internals behind a strict public interface. Consumers
use that contract; independent package boundaries need independent dependency or
consumption value. The journal in03 is the concrete reference for this rule.
