# 25 — Composed reference browser acceptance

The reference application is a public consumer of the framework. Its Node
process uses SQLite originals, DefaultLifecycle, HistoryWindow, InteractionOwner,
FileStore/HostAssetOwner, ConversationFeature, typed Host routing, Gateway and
authenticated browser WebSocket → Gateway → native Iroh Host bridge. The explicitly named scripted provider creates no vendor
process or model request. Browser application composition supplies an actual
inferred tRPC client from published `connectBridge`, with binary `peer.files`. ConversationFeed adapts its
observations into one RetainedWorkspace and the16 Chat; there is no generic
procedure envelope, custom framework link or HTTP client factory.

`src/reference/ui/index.ts` exports the embeddable reference layout, explicit
view preparation and explicit mount/cleanup. The layout owns only navigation;
controls prepare the reference router's actual commands. `connectReferenceUi`
shows the typed composition, including scoped asset handles, binary transfers and
exact callback answers through the retained original owner. Persistence is an
injected browser storage adapter. Each independent viewer requires its own
exclusive stable namespace so it cannot overwrite another client's originals.
No restore/reconnect replays an operation. The optional Mermaid adapter consumes
the real pinned engine in strict mode and returns only releasable image URLs.

`test/browser/entry.ts` is the explicit browser boot used by qualification;
module imports of the public UI remain inert. `test/browser/run.ts` bundles the
actual entry with esbuild-wasm0.25.11 and uses playwright-core1.56.1 with an explicit
Chromium binary. These are build/qualification dependencies, not references to a
private sibling runtime. Mermaid12.0.0 is bundled only into the reference UI;
the generic Chat renderer remains injectable. Bundle metadata rejects Node
imports and records the actual build inputs.

Tooling resolves the repository's locked dev dependencies by default. Optional
`--tooling <package-directory>` requires the same published package versions.
`--browser <executable>` or `MULTIPLEX_BROWSER` selects Chromium; absent both,
the documented local fallback is `/run/current-system/sw/bin/chromium`. Earlier
receipts below used native esbuild0.25.11 from the then-explicit qualification
tooling directory. They remain evidence of those exact inputs; changing the
current runner to the locked wasm package does not rewrite their provenance.

The runner admits one context/two pages,500 browser requests,120 seconds of work
and30 seconds of cleanup before opening the actual disposable reference Host.
It creates unique ignored output; failures are retained. It records the emitted
Node runtime import graph and esbuild's actual browser inputs before/after,
screenshots, browser diagnostics, physical scroll geometry
and independent browser-process/reference/resource cleanup. A browser failure
does not cancel an admitted original or become a fabricated receipt. There are
zero existing-service, native-agent, provider or model effects.

The acceptance journey covers initial real history and scoped images; opaque
HTML and exact text; PDF bytes into the browser's native frame/download; actual
strict Mermaid; image zoom; Send after reading earlier with composer collapse;
manual reading and A/B/A anchors; older paging; themed Select and settings on
desktop/mobile; per-question extra information; explicit native-plan action;
independent viewer close and automatic offline observation recovery without
Send replay. Browser-native PDF rendering is platform dependent; frame/bytes
evidence is not a new PDF engine or a continuous-page renderer claim.

## Scripted browser evidence

The first attempt rejected the qualifier's classic JSX bundler default with
`React is not defined`. The source was already strict-compiled with automatic
JSX; esbuild now selects the same mode explicitly. All resources retired.

The next bounded attempt found an actual End-key geometry/intent edge. A closed
diagnostic measured scrollTop14987 versus reachable max14988; a direct diagnostic
clamp reached14988 and remained after two paint frames. With no subsequent
scrollend, the viewport's manual-gesture latch remained set and the view stayed
in reading mode. No tolerance or anchor oracle was relaxed. The responsible15
owner correction makes End an explicit latest gesture, and gives no-motion
gestures a bounded fallback without changing their reading intent. Its actual
browser tail case then passed. A subsequent resize stimulus incorrectly tried
to rewrite a completed native body and was correctly refused by history's
identity invariant; it now changes consumer DOM geometry instead.

One failed attempt sampled the Chromium child before its exit event and recorded
that cleanup condition false. A later read-only process check found no remaining
Playwright-profile Chromium process; the original false receipt remains intact.
The runner now captures the PID and awaits its actual exit event.

The eight early cases in `browser-acceptance-RTBGwz` passed through Send/manual
reading/A-B-A, but that overall attempt failed older paging and its overly broad
source seal detected unrelated concurrent source changes. The older-page defect
was the reference provider publishing its private native cursor directly into
the public window before acquisition established its own frontier. The fixture
now starts that boundary unknown; actual ConversationFeature baseline acquisition
mints the public cursor. No history cursor or anchor invariant was relaxed.

`browser-acceptance-WWJqGX` qualified the remaining six cases against an unchanged
actual graph: PDF lease/frame/download, older paging with exact measured anchor,
typed controls, confirmed question/extra-information answer, mobile Select/focus
and one explicit plan Send. Its cleanup conditions were all true; no browser
errors or unauthorized requests occurred. The browser bundle and CSS hashes
were identical to the earlier eight-case attempt. The overall result remains
failed because the following offline test did not establish disconnection:
Playwright's offline flag left the intercepted streaming origin reachable and
the retained view remained current. It is not observation-recovery proof.

Two harness corrections remain explicit: Playwright's service-worker blocking
option injected an unguarded `navigator.serviceWorker` read into the deliberately
opaque HTML frame; it is removed and the context is checked for zero service
workers instead. The request fence now permits only Chromium's exact built-in
PDF extension and `chrome://resources` in addition to the owned HTTP origin.
The prior fence had blocked the native PDF viewer's own resources. PDF evidence
still proves bytes/frame/download only; a dark initial viewer screenshot does
not prove a rendered PDF page. Image focal sampling now waits for the owner's
scheduled paint adjustment before comparing the same coordinates and tolerance.

`--remaining-only --prior <result.json>` and `--recovery-only` record explicitly
partial continuations, not full journey passes. Each creates fresh disposable
state and its own admission/resource receipts. Recovery-only creates no original;
unchanged zero effect counts prove observation-only recovery, not unknown-original
reconciliation or lost-reply non-replay. Those require the separate client/Host
owner oracles.

The final recovery-only case `browser-acceptance-DrdOP6` passes on the actual
Catalog composition with its separate `root.sqlite` journal. It closes only the
owned HTTP viewer sockets while keeping the listener and scripted lifetimes,
and rejects subsequent owned-origin requests as disconnected. A browser fetch
positively rejects and the UI becomes Connecting; the same mounted viewer then
automatically receives the exact event captured during the outage after access
is restored. Closing the second viewer first also leaves the first receiving
fresh capture. Draft, pin and effect counts are preserved. The result records
23 requests, two intentionally rejected outage requests, zero unexpected blocks
or browser errors, unchanged input graph and all six resource-cleanup conditions
true. Sends and answers are zero; both owned scripted capsules retire. The
receipt SHA-256 is
`254772c36b07aa10b438e6ff9ab84bd03bb1b5b867004a7e0961bf0f07509b46`.

The initial eight, remaining six (one PDF overlap) and recovery case cover the
14 distinct journey assertions across fresh fixtures. This is split evidence,
not a claim that either earlier failed overall receipt became a full pass. The
actual browser bundle stayed `989fa7fb1fd28640687804e55b5df836d0dcb34d0796b4e81d6293746713bdc4`
and CSS stayed `2629b2940c504b093950e22b9f3fd295ddc1fef5fa444c450a59baac1c2e7a2d`.
The subsequent behavior-preserving extraction of reference presentation into
`ui/app.tsx` removes a public-barrel runtime cycle; its final package/bundle checks
are separate from these exact browser input hashes.

## Built production UI smoke

`test/browser/packaged.ts --cli <built-dist/reference/cli.js>` starts that actual
artifact's `demo --port 0` with a fresh task-owned temporary directory. It imports
no source fixture, adds no browser test globals and does not rebuild the UI.
It admits one browser/page,100 total HTTP requests,90 seconds of work and30
seconds of cleanup. Its explicit SIGTERM exercises the CLI's actual shutdown;
the receipt requires exit0, an empty owned process group, Chromium retirement
and removal of the demo's temporary state. It never starts a vendor agent or
calls a model. The two demo agents use the explicitly scripted provider.

The archived19 artifact for source `e43fffdc657055bf85ae02fa0e48c32c10f8b9d4`
passes all four smoke cases in `packaged-browser-lu5499`: exact served HTML/CSS/JS,
initial history plus a decoded scoped image, an applied typed control and retained
draft after switching, and390px settings/conversation containment. It used23
requests, with zero browser errors or unauthorized requests; all seven cleanup
conditions are true. The production JavaScript hash is
`16717b6dc4383077335a2c029312c382bb8f6c96d9b536b8fae49fc5c463b153`.
The receipt SHA-256 is
`e5d461e094578c5c56676c2c8cd23d2d5103ba3f5ca1662e31ad32a8c78a0dde`.
The working checkout's installed modules initially lacked the newly declared
Playwright dev dependency; that preflight started no CLI/browser/state. The actual
smoke used `--tooling .cache/checkpoints/19-e43fffdc`, the archived artifact's own
locked dependency installation. Desktop/mobile screenshots accompany the result.

This four-case smoke closes the production-boot/package boundary after the
presentation extraction. It does not replace the14 distinct geometry/form/media/
recovery assertions above or expand the native PDF claim.

These source checks do not qualify native vendors, P14 auth renewal, p2p network
partitions, cold native readers, real provider capacity or installed application
behavior. Their adapter/platform qualification remains explicit elsewhere.

## Final built source smoke

The final external whole-source checkpoint (the committed acceptance source plus
the packaging qualifier correction recorded in Evidence.json) passes the same
production smoke after layers21–23. No source fixture or browser global is used.
The four cases pass with23 requests and zero browser errors or unexpected requests.
The built JavaScript SHA256 is
`191bd98e8f24a7cfa533222d401f0eb971a278edaa3d10c1adc52940b87f4bb2`;
the CLI SHA256 is
`2ad1e05aba92fe3e839b12a1a8679163832706e2c0d1c5732e9bf02264795d87`.

The two scripted capsules retire through the actual CLI's SIGTERM handler, which
exits0. Page/context/browser/native browser process, CLI/process group and
temporary demo state all have positive cleanup evidence. Native agents, model
calls and provider calls are zero. The result SHA256 is
`01571ab25167bc464e93aad2ad5c6cf3d1ab30cc6b85f0f4e3896babd8847558`;
its closed receipt SHA256 is
`d42272551ae5e767f8b0a4de30c39cceed37aa7571cd77a367fd429fc39d7c9e`.

This smoke proves the final production assets boot and the primary desktop/mobile
consumer stays usable. Owner tests separately prove the new attachment and file
link paths; the four smoke cases do not claim a new browser journey through every
new path or requalify the earlier14 geometry/form/recovery assertions.

## TypeScript qualifier amendment

The earlier typed qualifiers and browser fixture entry used `.tsx`, and every qualifier
CLI uses `cmd-ts`. Historical hashes/results above describe their original
JavaScript inputs; changing filenames and parsing does not renew those claims.
The new qualifier sources are strict-checked and linted, with inert help and
missing/empty/unknown-argument checks before any allocation. A separate typed
consumer inspector is copied into the isolated consumer and run by pinned tsx;
only qualification tooling resolves outside that consumer. Actual framework
imports, dependency pins and native bindings resolve inside it. Fresh final
artifact/consumer/UI evidence is recorded in the acceptance note after completion.

## Fresh typed-qualifier artifact result

The `.tsx`/cmd-ts qualifiers at the preceding checkpoint passed against the exact d65e444b production
artifact: build19.464s; full-install tar consumer16.753s; browser15.244s, four
cases and23 requests with zero errors/blocks. All seven browser/CLI cleanup
conditions and consumer cleanup are positive. Original failed IPC preflight is
retained separately. Those application/package/build inputs match that earlier checkpoint. The later
`.ts` extension amendment changes source names and build inputs; it does not
renew this artifact, tarball or NAR identity.

Closed receipt SHA256:
`dec1df55dabe9691500439b4f451b3481c398469a1578bc6a26d51173520c1e3`.
That production JS SHA256:
`033243af3b1c62fc207bdbaab42143f330c8c7a7d04538b1dee03610dc654848`.
That CLI SHA256:
`d3ba389c12880809a424893985a0c66e1b3c89c2e6485eaa5a90635df1e50298`.

## Non-JSX source names

Current non-JSX qualifiers and the browser boot use `.ts`, executed with pinned
`tsx`; only files containing actual JSX use `.tsx`. Paths in the usage examples
above follow current source names. Historical receipts keep their original
source and artifact hashes; fresh extension checks are recorded separately in
[the acceptance record](25-acceptance.md).

## F01–F06 package and browser proof

The fresh clean archive at `a9df79c92f96a465c0440faf75e51ae4487b7116` passes
the typed consumer in14.190s and production smoke in12.239s. The independent
consumer installs184packages and imports41public JS exports, including the new
portable journal contract. Published transport resolutions and native BLAKE3
digest match; imports have zero monitored processes, requests or listeners.

The four production browser cases pass23requests: exact built assets, real
history/decoded image, typed control plus retained draft, and390px settings/chat
containment. Actual official tRPC requests are admitted by the network guard.
There are zero errors/blocks; all seven page/browser/CLI/state cleanup conditions
pass, and two scripted sessions retire. Native agents and model calls are zero.
No new14case, physical-relay or all-platform media claim is implied.

Recorded built JavaScript SHA256:
`bf4dace453154cc1dd39db1b9fae347b47ca572f19da22aaae53976cf5cb1907`.
Recorded CLI SHA256:
`4f03615f7ab7e7a7d7d73fe19f34c4249b6ba52f4557ae22d8e29e89cda4a6c3`.
The closed receipt SHA256 is recorded in [Evidence.json](Evidence.json).
Screenshots and exact resource receipts remain in `.cache/review-f01-f06/`.
The owned external build/consumer scratch directories are removed.

## F07 package/browser checkpoint

Fresh built source `7b213e7` passes the independent 76-entry consumer with zero
monitored import-time processes/requests/listeners and real published bindings.
The actual production browser passes four cases and 23 requests, with zero errors
or blocked requests and all seven cleanup facts positive. It includes the
receiver-safe structural React stores.
The bounded qualifier waits for exact owned browser group retirement; raw prior
failures and positive later absence remain separate. All framework, qualifier,
test and package inputs match the final 274-path source seal. [Evidence.json](Evidence.json)
records exact CLI/assets/receipt hashes. Native agents/providers are unused;
these are scripted browser/consumer claims, not P14/native multi-hop proof.

## F08 composition amendment

Current reference and fixture composition uses `createTRPCClient` with official
links directly. The framework's URL helper adds routing metadata that the
Gateway/Host validate against authenticated authority; it does not authenticate
the caller or wrap query/mutation/subscription procedures or their values. The
removed procedure-client wrapper suite is not a new qualification boundary.
Unique authentication/routing, exact-original non-replay, independent observer
cancellation and reconnect invariants remain in actual HTTP, Reference and
Catalog owner tests. All browser/package hashes and outcomes above describe
their recorded pre-amendment inputs; no repeated browser journey, rebuilt
artifact or vendor/native proof is claimed by this documentation update.
