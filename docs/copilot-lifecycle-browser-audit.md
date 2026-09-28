# Copilot lifecycle vNext: browser and client evidence audit

This audit covers the maintained reference `apps/web` and `packages/client`
at base `c28811b320f436acbec332b00199716a3c62cfa7`, followed by the local
corrections described below. It does not inspect or modify the external Leo
consumer. `BRIEF.md`, `CURRENT-AUDIT.md` and `STABILITY-CONTEXT.md` from the
supplied `copilot-lifecycle-vnext-20260922` evidence directory were read and
all three passed their supplied `SHA256SUMS` verification.

## Evidence matrix

| Assertion | Verdict and exact scope | Source / executable evidence |
| --- | --- | --- |
| Hidden tabs exhaust the finite receipt-read budget without issuing reads | **Conditional external defect; disproved as an in-repository reference-console defect.** The supplied audit describes Leo's `composer-recovery.tsx` and `operation-recovery.ts`. Neither file nor an automatic receipt-read scheduler exists here. The reference console offers a manual check only. | [Reference console](../apps/web/src/client/session-console.tsx); repository file/search inventory. No external regression qualification is claimed. |
| Native-compaction local marker blocks later terminal receipt persistence | **Conditional external defect; absent here.** There is no `nativeCompactionRecovery`, browser receipt store or `command-recovery-model.ts` in the maintained reference UI. | Same source inventory. The separate consumer must preserve marker/conflict policy independently from authoritative receipt progression. |
| Browser command recovery never replays a saved mutation | **Disproved at this repository base; fixed.** The original **Check the original command** callback passed `action.envelope` back to `sessions.execute.mutate`. It now calls `readCommandReceipt`, which can access only `commands.get.query`. | [Client receipt helper](../packages/client/src/command-recovery.ts), [regressions](../packages/client/test/command-recovery.test.ts), [rendered scenario](../tests/browser-lifecycle-vnext.mjs). |
| Native display is correlated only by exact logical message ID | **Disproved for this repository's optimistic presentation at base; fixed by removing the inference.** The console removed pending local user bubbles when any native entry had matching body/images. Repeated prompts or an older equal message could remove the wrong bubble. The console now renders native evidence only. | [Console](../apps/web/src/client/session-console.tsx), [transcript normalizer](../apps/web/src/client/transcript.ts); rendered repeat-text scenario checks that neither unknown nor accepted commands manufacture another native message. |
| A successful send proves delivery or task completion | **Disproved.** The reference UI now says **Message accepted** / **Steering message accepted**. The draft may settle on acceptance without proving a native echo. No `Finished` claim is introduced. | Same console and rendered acceptance. |
| Late receipt clears only its submitted draft | **Disproved at base; fixed for the mounted binding.** Previously success unconditionally emptied current text/images. A captured binding/text/ordered image-ID snapshot must now match exactly. | [Draft settlement predicate](../apps/web/src/client/command-draft.ts), [12 transition regressions](../tests/web-command-draft.test.ts). Reload/multi-tab persistence remains unimplemented. |
| Mutable and immutable access cursor helpers have equivalent monotonic semantics | **Disproved at base; fixed.** `AccessCursor.observe` overwrote same-epoch native sequence 7 with 2, while `advanceAccessCursor` retained 7. The mutable wrapper now delegates established-feed transitions to the shared function and retains maximum early same-epoch positions. | [Cursor wrapper](../packages/client/src/cursor.ts), [cursor/retirement tests](../packages/client/test/fleet-watch.test.ts). |
| Reconnect commits a cursor only after its consumer has committed the item | **Confirmed for the asynchronous client callback contract.** Processing is serialized and reconnect waits for accepted pending work. Retired transport callbacks cannot advance the replacement subscription. A React state setter returning is not a durable IndexedDB or painted-transcript transaction. | [Access watch](../packages/client/src/access-watch.ts), [resilient subscription](../packages/client/src/resilient-subscription.ts), deferred-consumer retirement regression in fleet-watch tests. |
| HTTP queries/mutations are independent; WS is subscriptions only | **Confirmed.** Each HTTP request has its own cancellation and completion boundary. Mutations have no automatic retry. | [Client construction](../packages/client/src/client.ts), [real HTTP tests](../packages/client/test/access-http-independence.test.ts). |
| Every reference Copilot history read uses native primary paging | **Disproved.** This reference console requests legacy Copilot `limit/cursor` history; it does not select `view: primary`. The supplied 25-event opening page, root-message target, byte/time budgets and pinned primary-pager lifetime belong to the separate consumer. | `loadNativeHistory` in the console; [reference history readiness/retry policy](../apps/web/src/client/native-history.ts). Native cursor-expiry/reconciliation remains harness-owned. |
| The reference console owns fresh task/queue snapshots and exact root/child status projection | **Disproved.** The elaborate task, queue, subagent and `Finished` projections described by the supplied audit are external consumer code. This console exposes catalog runtime status plus stream/history health and polls pending interactions every five seconds. | [Interaction refresh](../apps/web/src/client/interaction-refresh.ts), console and [app](../apps/web/src/client/app.tsx). The shared lifecycle model is a separate migration boundary. |
| Browser disconnection means native completion | **Disproved as an authority claim.** Native work may continue while a source is unavailable. The reference UI displays stream status separately; its scalar catalog idle is not proof of observed task settlement. | Console header, source/data-role contract, lifecycle design. |
| Production Windows/WSL failure attribution and 15-minute root churn are independently reproduced here | **Untested historical observation.** The supplied stability report is evidence of a prior deployment, not a fresh observation of this checkout. No live service, credentials, private conversations or native sessions were accessed. | Supplied stability context only. Archived `apps/host` is not an implementation target. |

## Implemented browser/client boundary

The native transcript is a view of native evidence. Command status remains
separate from that view. `readCommandReceipt` validates command ID, payload hash,
session ID, runtime ID and the complete immutable envelope stored as the
receipt request, including the binding revision and harness command. It issues
one query. Missing receipts keep the original uncertain command/draft available;
the helper neither chooses another route nor admits a mutation. Receipt failures
display the safe typed error message rather than interpolating an error object.

Draft settlement requires a successful receipt plus equality of binding identity,
untrimmed draft text and ordered local attachment identities. The original
snapshot remains attached to manual recovery. A retired component ignores its
late success/error callbacks. This is a mounted reference-console rule, not a
claim of browser crash safety or cross-tab serialization.

Native cursors remain scoped to `(sessionId, runtimeEpoch)`. Sequence numbers
are monotonic only inside an epoch. Opaque epochs have no chronological ordering;
transport callbacks are fenced by subscription generation, while authority and
binding checks belong upstream. A source feed change/reset clears retained
native positions. `nativeGap` remains explicit and requests native history
reconciliation; cursor helpers do not interpret vendor history.

## Separate consumer migration obligations

The coordinated consumer update still needs to replace its duplicate delivery,
task, child and completion projections with the lifecycle contract where that
contract is implemented. It must preserve exact pending interaction IDs and
binding/source generations, avoid text/time/queue-absence correlation, and keep
native message display separate from acceptance and settled work.

The supplied R2/R3 regressions must run in that consumer's own code: hidden time
must not spend receipt-read attempts; visibility must resume a finite visible
budget; a local compact marker must not block a matching later authoritative
terminal receipt; unknown/older responses must not downgrade it. Cross-tab draft
CAS, browser storage admission, receipt ordering and exact-draft settlement must
be tested in its IndexedDB/Web Locks implementation. Creating an unused recovery
store in this package would not migrate those owners. No external code was
accessed or claimed fixed by this work.

The reference console still lacks durable reload/multi-tab recovery and does
not reconstruct unsupported native causality. Navigating away can lose its
in-memory uncertain envelope. This limitation must be addressed before claiming
durable browser operation recovery. A successful command receipt cannot repair
the SDK's missing logical message or compaction operation identity.

## Transport renewal contract and safe qualification

Expected authentication renewal may replace a transport subscription generation
without replacing runtime epoch, binding revision, control boot/feed or authority.
Only authenticated continuity of all relevant identities can preserve lifecycle
freshness. An unproven gap/source change requires snapshot/cursor recovery.
Neither renewal nor failover authorizes mutation replay. A response lost during
renewal remains an original-ID receipt problem. The external renewal worktree
was not inspected, modified or merged.

The existing [Docker tree suite](../tests/docker-v3-tree/README.md) covers real
process routing, authority loss/restart and branch fallback with mock adapters.
The [mock scale suite](../tests/docker-mock-scale/README.md) covers 100 sessions,
WS cursor replay, runtime network detachment and browser scale. Both runners
default to reading the npm user configuration as a build secret; under this
task's no-credential fence they must use a deliberately supplied empty config
and public registry/cache dependencies, or be recorded blocked. Neither suite
proves proactive seamless p2prpc renewal. The existing real-Iroh reverse-binding
tests use disposable identities and accelerated retirement; they qualify only
their exact committed transport boundary. Model-using four-container and native
prompt suites are not authorized.

## Deterministic browser acceptance

Run `node tests/browser-lifecycle-vnext.mjs <local-receipt-directory>` after the
workspace TypeScript build. It starts only a local Vite server and Playwright,
with every access RPC fulfilled by a deterministic fixture. There is no native
SDK, gateway, auth home, provider or model request. It checks unknown→missing
receipt→terminal receipt, same-text history, acceptance wording, no second
dispatch from receipt checks, and exact draft preservation/settlement.

The six skill viewports are captured: 1720×1180, 1440×900, 1024×768, 768×1024,
390×844 and 844×390. Each asserts no horizontal overflow, a visible composer,
at least 120px of transcript and no serious/critical axe findings under reduced
motion. Recovery text wraps on narrow screens. Screenshots were inspected;
these receipts qualify this isolated console workflow, not whole-fleet layout,
native conversations or production transport. Exact final source IDs and gate
receipts belong to the lifecycle implementation handoff.
