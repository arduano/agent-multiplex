# Release qualification checkpoint

## Certified Copilot cold-resume candidate — 2026-10-01

Based on hotfix.24 preparation `512cf4874968ef9b7620673d53aef0c4710ddbe9`,
the first native cold/non-continuing resume certificate can establish root idle
with no cycle/outcome after complete empty child/interaction hydration. Root,
activity, command and callback races block certification. The reducer preserves
gaps, partial hydration, positive work and observed outcomes; task/queue reads
remain independent. Persisted/public schemas and runtime store/migrations are
byte-identical to the base. No native/transport dependency or released pin changed.

Eight targeted regressions fail with the old bridge restored, and corrected
source passes **184 tests / six files**, one worker. Nearest adapter project
TypeScript build passes. Tests cover interactive/plan/autopilot, explicit/missing/
active flags, races, duplicate/child/retired/replacement boundaries, partial/gap
and stale-fence rejection, persisted reopen, new-epoch uncertainty and the
existing 4,096 reducer schedules. The
[owning audit](audits/copilot-cold-resume-ready-20261001.md) records cause and
publication/installed limitations. No live/model/session/service action occurred.

Local namespace: `receipts/copilot-cold-ready-20261001`.
Old-bridge regression log SHA-256:
`11a537ba3afb58de59ed543ac5a6e6f8e9e834d18e735321040937cff12b1df7`.
Final corrected focused log SHA-256:
`146d816d76774dd4763de6ca2b9ea4a5e17dadc811b7340a8a5964f5a220a292`.
Final seven-file source/test inventory SHA-256:
`f833a753160249bda063fa9072858b6c2be29b20a500c0bd84614bd0c0a74403`.
Intermediate active-resume contract diagnostic (77 pass/2 fail) SHA-256:
`f18cbf3297a5150fcc8ca8001a4a68081f88eac0a3d7797e7d17a73cd35dd16b`.
The final correction retains native active-resume status for fresh/live handles
without granting another cold-resume certificate; all six focused files pass.
Unchanged state/view/store boundary SHA-256:
`e0fec623dad3fc4c0efcf8edf5d2451f3dab96c0a3d2e5a6245296b6f16d9f23`.
Broad source/package gates, independent review, publication and installed
Windows/WSL acceptance remain separate coordinator-owned steps.

Independent review then found a sticky preboundary race marker suppressing
later positive native active-resume status on `212769a`. Both explicit active
flags reproduce it. The follow-up removes that marker only from the consumed
boundary path, preserving first-boundary/false/ambiguous/child/closed fences
without promoting hydration or root outcomes. Nearest Copilot project build and
**151 tests / three files** pass, one worker; the final combined broad gate remains
coordinator-owned. Baseline diagnostic SHA-256:
`cc0345620acea6dd4ba8f7dcd8df299539ed54fac8bc67e7c5ceaac78dc6f769`.
Passing focused SHA-256:
`da3c97ab29faf132fb96653ca2f0f743688d83f2965a117266a26cf06430b5d5`.
Follow-up two-file inventory SHA-256:
`8ae226bfc352e5cbd7ec4edd2b33f92fe5c22d7ee0e488cd45db044a082131de`.

## Isolated runtime replay starvation candidate — 2026-10-01

Based on published `.23` checkpoint `5b8cb1530e4b3fd6040ae611d28b7c5e9cd8ad12`,
real runtime/control services, native event hub and reverse-feed pump reproduce
four retirement cases that block another session's native feed while heartbeat
and synthetic native history work. The pre-fix regression fails five assertions
and passes the unknown/stale-fence safeguard. After the narrow correction,
**71 focused tests / five files** pass with one worker, including all six new
regressions, bridge retry/cursor tests, control hardening, launch/archive and
startup reattachment. Targeted TypeScript project build, docs, release metadata,
secret scan and diff whitespace checks pass. The
[audit](audits/runtime-replay-starvation-20261001.md) owns source design and limits.

Local receipt namespace is `receipts/runtime-replay-starvation-20261001`.
Final corrected baseline failure `red-final.json` SHA-256:
`d1fd4883e8dc7ba6c952d66524cd27f1240b5af35f53ff9708a1bee616e35b6c`.
Passing focused `green-final.json` SHA-256:
`729651ca85bf12aad3e6e830b30ec12745b5cf2a3e9adc2f1ecac89faf5703d6`.
Exact four-file source/test inventory SHA-256:
`28a2b1c4f8ed84e50f004753e39cf22214c59af98ff01d172ccbe23f5cd4bfbb`.
Initial fixture-native-ID reuse failure is preserved separately and excluded
from defect evidence.

`node scripts/check-checkpoint.mjs` failed because the new worktree deliberately
built only targeted projects: `@arduano/agent-multiplex-gateway-core package
target dist/index.js does not exist`. Diagnostic receipt SHA-256:
`8b19b14db11df730444b93187578cc12889be6ccfa285dec3f34d500f844bd5f`.
The broad project build/full gates await coordinator scheduling; no admission
or gate was weakened. Independent review, full source/package qualification,
new coordinated publication and installed acceptance remain pending. No live
service/model/vendor SDK action occurred, and the actual Windows trigger remains
unproven. Published `.22`/`.23` bytes, pins and all durable schemas are unchanged.

## Hotfix.23 prerelease publication — 2026-09-30

Signed tag `hotfix-2026-09-30.1` peels to exact once-packed artifact source
`a36c000814c344fce1d5ad3d45ed344c6d0a79cc`. All 19 published assets
independently match retained local bytes; checksum inventory SHA-256
`612ed0504c9a2d34dc93efeedd194b410a00240b45f935ef1c80c9080655987d`.
Independent consumer-repository verification receipt SHA-256
`063782299da8f126ccf592bdb2a7fda036d063da9a0fa6780705c7d52fcb67d7`.
See [publication evidence](audits/hotfix23-release-preparation-20260930.md#publication-receipt--september-30).
Local source/package/Docker gates passed; registry auth, native models, hosted CI
and installed acceptance are unclaimed. No live service or model call occurred.

## Lockstep hotfix.23 B1/B12 local release qualification — 2026-09-30

The new **unpublished** `0.2.4-hotfix.23` 16-package graph is packed once
from clean source `a36c000814c344fce1d5ad3d45ed344c6d0a79cc`.
The preparation commit changes only `.22` -> `.23` manifests/internal edges/lock;
existing B1 corrections and private B12 categories are included without further
code changes. Protocol/native/transport pins, released profile hashes and
migrations are unchanged. The original Copilot trigger remains unproven.

Exact Node 24.19.0 / npm 11.17.0 passed typecheck, production pretest build,
**1,162 tests / 124 files**, checkpoint/docs/release/secrets, offline strict
install/graph, all 16 role-isolated packed consumers, 11 packaged B1 regressions,
and 506-component SBOM. Current-source deterministic Docker tree and
10-runtime/100-session scale both passed with cleanup and all 96 receipt files
independently rehashed. The first obsolete-browser-path failure is retained;
the successful process-only Chromium override did not change source/policy.

Source summary SHA-256 `1cf9ac888a265922e58a909679d6dca6dc16f9816e8bf45f6afece9e495bd461`; packed summary
`74dfb4d9eafb5a9c2b8ef2003d0f0ef6b35a688c674cccb171220b4c143fdfdd`; successful Docker summary
`d2bb97e6f17457ae3f05050fa210bdf9ec0beec1a7ffb97f6f93aa88335c5b08`; artifact inventory
`612ed0504c9a2d34dc93efeedd194b410a00240b45f935ef1c80c9080655987d`.
[The release qualification record](audits/hotfix23-release-preparation-20260930.md)
contains full paths/hashes, exact changelog, safe staging procedure and limits.

The reviewed public transport verifier was reused byte-for-byte. Registry
authentication and native-model release qualification are not claimed. No tag,
publication, `latest` promotion, framework-main merge or installed activation
occurred in this lane. Proposed `hotfix-2026-09-30.1` was absent at preparation;
recheck before any owner-authorized publication. Earlier `.22` artifacts remain
unchanged. Future consumer staging must use independently verified **published**
URLs/integrities; these disposable local `file:` consumers are not deployment
pins. No real model calls or live-state modifications occurred.

## Private Copilot payload-gap diagnostics candidate — 2026-09-30

Code `d0c855c44229d9ae65a8ec39fd0ad10d3237d90b`, documentation/packed
source `714682b3241c3cd03a815ef800d0607f82e49675`, retains the qualified
B1 corrections and adds only fixed private-hook validation detail. The durable
lifecycle diagnostic schema is unchanged, preserving `.22` rollback parsing.
Synthetic exact-size retained text/tool output fails the envelope; recognized
inline image data can shrink successfully. The original owner event remains
unproven. See [the diagnosis](audits/copilot-native-payload-gap-20260930.md).

Passed typecheck, production pretest build, **1,162 tests / 124 files** with
one worker, posttest checkpoint, docs/release/secrets checks, packing all 16
modules, all 16 role-isolated packed consumers and the release-build SBOM.
Process-only `TMPDIR=/dev/shm` applies only to disposable qualification.

- Full source receipt `receipts/copilot-gap-full-20260930-2/summary.json`:
  SHA-256 `8df15931ac1fe047cbab6bd7c14b432914b61d905e4349fc39aa104ffa34dc0d`.
- Packed receipt `receipts/copilot-gap-packed-20260930/summary.json`:
  SHA-256 `2a24ed0f21418865a29ca2aeff8cfb8d956bff766225624e6e01a519f380e407`.
- Artifact inventory `release-artifacts/SHA256SUMS`:
  SHA-256 `d05ab9ebdca33526684a2c2b3e02fc7734d69dbc7fcd36836fa3b4660803563b`.

The receipt-contained verifier is the previously reviewed public-transport
variant, copied without changes. Each consumer asserts the exact published
`p2prpc-core@0.3.0-renewal.1` URL/version/SRI and reviewed Iroh/Koffi closure
under strict script policy. Standard private-registry authentication remains
unqualified; no registry credential/policy changed. Tarballs retain local `.22`
candidate identities and must never replace published `.22` bytes. Future
publication needs a new coordinated version and fresh exact-source artifacts.

Focused diagnostics retain the corrected synthetic strict-schema fixture
failure. The root's initial full-gate admission stopped before running a gate
because a documentation commit advanced HEAD; the successful exact checkout
is recorded above. No model calls, private native history/log reads, installed
service changes or owner-session actions occurred. No new Docker/native-model
qualification or installed acceptance is claimed.

## Retained binding metadata bootstrap candidate — 2026-09-30

Isolated source based on `d9c9038` adds canonical metadata bootstrap for exact
locally retained native bindings omitted by discovery. The existing
protocol-v6 reconciliation input gains optional bounded `retainedBindings`;
the response shape, protocol version, operation identities, released hashes,
launch contracts, migrations and dependency pins remain unchanged. Activation
requires the coordinated protocol, control-node-core, runtime-node-core and
runtime-node app graph. Catalog authority stays with control; no Gateway or
native-history authority is added.

Two synthetic Codex/Copilot old-state cases reproduced the missing authority
before the source correction. The final focused run passed **8 files / 132
tests**, with one worker. Eleven new disposable fixture cases cover stopped
resumable/unavailable bindings, runtime/control restart, canonical metadata,
Root attachment and former-authority rejection, supported Archive and retained
tombstones, native discovery failure, endpoint/boot/binding fences, local
removal during bootstrap, and advanced unowned metadata. Three new maintenance
cases cover 1,000-reference batching, changed response revisions and discarded
late results after connection retirement. Nearby runtime, metadata, control
hardening, lifecycle and child-archive projection regressions also passed.

The initial normal-temp run timed out during disposable SQLite filesystem
sync; its worker was observed waiting in `bch2_closure_sync_timeou`. After that
run exited, `TMPDIR=/dev/shm` provided disposable memory-backed fixture storage
for both the actual pre-fix assertion reproduction and passing qualification.
This is a qualification-environment choice, not a deployed storage change.
Affected TypeScript projects compiled with
`npx tsc -b packages/control-node-core packages/runtime-node-core apps/runtime-node --pretty false`.
Documentation, checkpoint, release-metadata, secrets and whitespace gates passed.
That focused checkpoint did not run a new broad suite or production build.

The scrubbed focused log is
`receipts/retained-binding-authority-bootstrap-20260930/focused-tests.log`;
SHA-256: `9c36cc88f4209695f0e575a5afaf04e45c4b3cb70a61753ba3a4976ec1315046`.
The local summary binds the exact commit, lockfile and source diff to those
logs and their checksums. No native model calls, publication, push, deployment,
live service/config/pin changes or installed-state mutation occurred. Full
candidate, packed-consumer and native installed qualification remain separate.

### Combined full source and local packed gate

Exact code `f7c6cbe3dcf44e0d3c7456ebb2bd07c275f3273a` subsequently passed
`npm run typecheck`, `npm test -- --maxWorkers=1 --minWorkers=1` (**122
files / 1,147 tests**, including its production pretest build and posttest
checkpoint), docs/release/secrets checks, and local packing of all 16 modules.
Tests used `TMPDIR=/dev/shm` with one worker and no concurrent broad suite.
No installed service or state was changed.

`npm run release:verify` exited 1 at GitHub Packages E401 for
`@arduano/p2prpc-core` with no authentication token. Its original log is
preserved. All 16 role-isolated consumers then passed the receipt-contained
public-transport verifier variant. It substitutes only the exact previously
reviewed published `p2prpc-core@0.3.0-renewal.1` GitHub tarball and asserts its
version, resolved URL and SHA-512 integrity in every disposable lockfile.
Framework tarballs, reviewed Iroh/Koffi pins, type/export/browser/bin checks
and strict script policy are unchanged. All 11 bootstrap regressions also
passed against the installed local tarball graph. This qualifies that public
artifact boundary, not registry authentication.

Local summary:
`receipts/retained-binding-authority-bootstrap-full-20260930/summary.json`;
SHA-256 `2fa3caeb3d1da766a4af720a43ee07359ba6fd3d540b99e6b224a16efc32808a`.
Artifact SHA-256 inventory digest:
`c7a9bcac69694c33fda237e111525d8d553900371e46c8ddded0da594f9119f7`.
The directory retains original diagnostics, passing logs and checksummed
qualification helper code. These are **unpublished local `.22` candidate
artifacts**, never replacements for the existing published `.22` release.
A future release needs a new coordinated version/source and its own artifact
qualification before independently operated deployment. Native SDK/model,
Windows, Docker topology/scale and installed qualification were not run for
this source-only checkpoint. Protocol/migrations/released hashes and Leo's
published dependency boundary remain unchanged.

## Root child-error and archive projection candidates — 2026-09-30

Isolated source `d452014adeaa1faeeba48d0ee25ab9b730b7ad57` combines
definitive sanitized child-error normalization (`4f0e5bc`) and transactional
publication of the canonical archived session when importing child Archive.
The new IPC regressions and warm Root/child/Gateway regressions reproduced
the published defects before the corrections. Typecheck and the focused
32-test IPC / 70-test archive-neighbor suites passed, as did documentation,
release-metadata, checkpoint, secrets and whitespace checks.

The exact combined source passed `npm test -- --maxWorkers=1`: **121 files,
1,133 tests**, including the production pretest build and posttest checkpoint
check. The first `npm test -- --maxWorkers=2` run failed seven suites at missing
`node-pty` native startup, two 15-second test timeouts and one worker RPC timeout
(1,098 tests passed). `npm rebuild node-pty --foreground-scripts` was refused
by `ESTRICTALLOWSCRIPTS` for an uncovered transitive prepare script. No approval
policy was changed. Running the already pinned target package's own
`npm --prefix node_modules/node-pty run install` succeeded; all nine failed
files then passed with one worker (70 tests), followed by the passing full run.

The local scrubbed summary is
`receipts/d1-combined-full-20260930/summary.json`; SHA-256:
`70072826147fb532feb2150fc5f6b39fa36491423978f454e05b45f2807228f3`.
It records exact source, Node, command outcomes and log checksums. Package
versions, dependency pins, wire contracts and migrations are unchanged.
No publication, deployment, model prompt or installed-state mutation occurred.
Packed-consumer release qualification remains separate. Canonical metadata
bootstrap for retained bindings omitted by native inventory remains a pending
prevention fix; the fenced settlement workaround does not restore native history.

## Aggregate defect integration candidate — 2026-09-29

An isolated integration branch combines the unpublished D1 confirmed-stop
projection correction, D2 Copilot reasoning selection, D4 Host message delivery
view, D6 bounded file previews, and D7 bounded child native history. Copilot
now advertises `reasoning-effort.switch` only with the new native command
contract, so a mixed-version UI can hide that control. The integration source
commit did not advance a package version or send a model prompt.

The combined source passed typecheck, production build, 117 focused tests and
the full **1,115-test / 119-file** suite with two workers. Checkpoint,
documentation and release-metadata checks passed. Packed consumer, native
Windows, installed-host and disposable model qualifications remain separate.

The separate `prep/defect-graph-hotfix22-20260929` worktree advances all 16
package manifests and the lockfile to `0.2.4-hotfix.22` solely to prepare a
distinct local package graph. This preparation has not been published or
installed. The preceding source-suite result applies to the `.21` integration
commit; exact `.22` package and consumer gates are recorded separately.

## Stopped binding inventory correction candidate — 2026-09-29

The isolated `fix/unavailable-stopped-inventory-20260929` branch starts from
signed hotfix.21 source `dd0b6962c6690b0b53c8b5d09dc44d4489ec9fc6`.
It changes only control catalog reconciliation and its documentation/tests;
package versions, protocol, migrations and dependency pins remain at the
published `.21` baseline. A complete native inventory omission now preserves
a previously confirmed stopped status while reporting native availability
unavailable. A formerly active binding still becomes unknown and needs an
explicit Stop before Archive. No native work is inferred from inventory.

Three new focused cases cover Codex and Copilot confirmed stops, repeated
omission after catalog restart, archive admission, and an active-missing
binding that needs a new Stop. The neighboring control hardening suite also
passed. The isolated source passed `npm ci`, typecheck, production build,
**1,103 tests across 117 files**, checkpoint, documentation and release
metadata checks. No model call, published artifact, installed update or live
catalog repair is claimed. Exact package publication and consumer qualification
belong to a later coordinated release.

## Copilot reasoning effort source candidate — 2026-09-29

The isolated source branch adds Copilot `setEffort` to the command contract,
the runtime's change-settings lifecycle gate and the Copilot adapter's pinned
session model RPC. Applied effort is read from the native model snapshot and
kept independent of a previous model's selection. A failed or unconfirmed
model switch clears both projected selection values until native observation.
The initial candidate passed `npm run typecheck`, production build and the full
117-file suite (1,101 tests) after rebuilding the pinned `node-pty` native
addon in this isolated worktree. A later full rerun, concurrent with another
framework suite on the NAS, failed 26 unrelated 15-second integration
timeouts and six worker RPC timeouts; the final failure-path refinement then
passed all 27 focused Copilot adapter tests with one worker. A quiet full
suite rerun, package release, Leo consumer qualification and live candidate
behavior are pending. No installed Host changed.

## Codex 0.158.0 source release preparation — 2026-09-28

The isolated `0.2.4-hotfix.20` source candidate advances all 16 maintained
package identities and their internal dependencies together. Codex adapter
source commit `19923c540f24f4b69965fa0da0fa20acc0533e28` pins
`@openai/codex@0.158.0`, regenerates the app-server declarations from that
binary, updates the adapter version boundary, and retains the exact published
transport and Copilot pins. The release-version change and a longer wait in
three asynchronous startup test assertions follow that source commit. No
protocol, migration, or transport change is claimed for this candidate.

The focused Codex adapter suite passed 95 tests against the pinned CLI.
One authorized `gpt-6-luna` text-and-image turn
through `CodexAdapter` and `RuntimeNodeService` passed with one Codex request
and no Copilot request. The adapter observed native turn/item events and token
usage, transferred image data through the runtime image path, returned a native
history page with an image descriptor, and served stopped and restarted reads.
The local scrubbed receipt is
`receipts/codex-0158-luna-one-turn-20260928/`; its `SHA256SUMS` SHA-256 is
`468a747cbe83ec43468eb508bb71df846e1ab769127d8f81db9fc8d1e22e0fcc`.
The receipt records Node `24.19.0`, source head `19923c5`, dependency-lock
SHA-256 `d40f18f474054e97f87ea3d668a795889a3ea2b03a36f20f0a12033755d67620`,
and unchanged tested boundary SHA-256
`7c0ed006429c40417b3adbe82ec3d349569d55d0904d5dfcfd485997c8fbbda9`.
Its scope is the adapter/runtime path before the `.20` package-version change.

`npm ci`, typecheck, production build, release metadata, documentation,
checkpoint and source-secret checks pass in the `.20` preparation worktree.
`npm audit --audit-level=high` has no high or critical findings; two moderate
Vitest development dependency advisories remain. A passing full deterministic
suite against the final clean `.20` source, isolated packed consumers, SBOM,
exact-commit native four-container soak, Windows and deployed-host checks
remain open. No tag, publication, or rollout is claimed.

## Published-core protocol-v6 source gate — 2026-09-23

The `0.2.4-hotfix.17` framework source pins the independently published
`@arduano/p2prpc-core@0.3.0-renewal.0` through its manifest and lockfile.
The GitHub Packages integrity is
`sha512-Gr1yK8rE22VKOwz6Hzrg7RpkZIpOjOOForks+kCKOACbTMAn4yF3Y2u4ngnGT8IJFIpYISXFRzxSQP+RgFeVnA==`.
Independent p2prpc main/tag `ca7bb6fb7b791813c937ddbf9bde62423d097373`
passed publication run
[`35841435029`](https://github.com/arduano/p2prpc/actions/runs/35841435029),
registry-byte/downstream verification, and a nine-asset GitHub release. Its
registry tarball SHA-256 is
`e2b13239b9337ddb5ea1b28542e1d8fcd28bde37f469c18541967b60d6d9b69f`.

After a clean `npm ci --strict-allow-scripts`, Node 24.19.0/npm 11.17.0 passed
typecheck, production build, **1,050 tests/114 files**, checkpoint, docs,
release metadata, source-secret checks, `npm ls --workspaces --depth=0`, and
high-severity npm audit. The audit found two moderate Vitest development
dependency advisories, with no high/critical result. The no-model Docker
control tree and 10-runtime/100-session mock scale passed against the
published-core lockfile:

| Suite | Local checksummed receipt | `SHA256SUMS` SHA-256 |
| --- | --- | --- |
| Control tree | `receipts/protocol-v4-control-tree/20260923T092203Z-1d42606337be/` | `531db2c2e07d39827a6887dc106b724822da4fa7d67b637de0dc5a1bbe43cb4a` |
| Mock scale | `receipts/protocol-v4-mock-docker-scale/20260923T092533Z-9673e1d283cd/` | `24b947399643c099c431b51950fef5032eb5a472a115e5bbb43844dce80473f1` |

Both receipt inventories passed `sha256sum -c SHA256SUMS`; the Docker images
used the exact locked core version/integrity and made zero real inference
requests. All 16 packed packages passed separate role-scoped consumer import,
declaration, executable, publint and Are the Types Wrong checks. The release
build SBOM contained 507 components, including all 16 packages and 125 web
bundle component identities. These source tests ran before the final clean
release commit and do not claim exact-tag or native Windows qualification.
The earlier patch-overlay candidate section below remains historical. Final
signed artifact, external consumer, Windows, backup/rollback and live
three-generation receipts must be recorded separately before cutover.

## Unpublished protocol-v6 Copilot lifecycle and consumer candidate — 2026-09-23

The clean framework implementation commit
`1af20f651e8d5733946154178d8c7f51b738d605` on
`feat/copilot-session-lifecycle-vnext-20260922` is based on
`c28811b320f436acbec332b00199716a3c62cfa7`. It introduces the
[normative lifecycle contract](design/copilot-session-lifecycle-vnext.md),
[evidence audit](audits/copilot-lifecycle-vnext-audit.md), protocol-v6 wire and
store boundary, and lockstep maintained-role implementation. The coordinated
Leo consumer work is a separate local branch; neither branch is deployed.

On Node 24.19.0 / npm 11.17.0, the implementation source passed full
typecheck, build, **1,041 tests across 114 files**, checkpoint, documentation,
release-metadata and source-secret checks. The executable lifecycle reducer
includes a 4,096-schedule invariant run. The host and reference client tests
cover exact command receipts, durable task/queue recovery, lifecycle freshness,
startup reattachment and no causal inference from text or catalog idle.

Two credential-free Docker runs used an empty npm configuration and the
checksummed local p2prpc renewal candidate:

| Deterministic run | Receipt | Result | `SHA256SUMS` SHA-256 |
| --- | --- | --- | --- |
| Control tree | `receipts/protocol-v4-control-tree/20260923T054356Z-dc1c3b994a3d/` | Protocol v6; authority/branch failover, native replay, metadata recovery, image immutability and browser/accessibility assertions pass. Image `sha256:dbabd741d6bf0ac3df73c0b74ec2ff2593d93c04528a3fb2443ce9b1143ec2de`. | `ab7e8a67153685313167d3b42342a8b0b4ff71fe8eef740a35eeb3d34151e719` |
| Mock scale | `receipts/protocol-v4-mock-docker-scale/20260923T054503Z-442702afc55f/` | Protocol v6; 10 runtimes, 100 sessions and sends, 3,600 native events, zero gaps/duplicates, reconnect, metadata, dashboard, cleanup and accessibility pass. Image `sha256:d707e2972341455ce629e830634328dbae88fa4c87955b3c97a33e97bff0cd71`. | `261e597c706c7effdb18dc8425084837458891e46d5c7c497f81b8f215d81622` |

Both receipt trees passed `sha256sum -c SHA256SUMS`. The image identities and
scale manifest source-tree hash identify the executed Docker snapshots; those
runs preceded the final implementation commit and do not claim a later
exact-HEAD Docker rerun. The deterministic suites use a mock harness, not a
native Copilot session.

The independently reviewed core candidate is `@arduano/p2prpc-core`
`0.3.0-renewal.0`, tarball SHA-256
`789da942e6902121a86a12f644c747acb2454dcb8e6bd2448803e16cfbfe05d5`
and source patch SHA-256
`c10c42e68be3807bcedd77e85b127ce5cf2eb218cad10793596b1cf559128cca`.
The public dependency remains pinned to `0.2.1`; the candidate is a local
overlay, not the final published package graph. Release packing deliberately
blocks until independent publication and exact pin review. A disposable Leo
snapshot at clean commit `21280febf603e7c8e5eb398a32f074500dfc5c82`
passed typecheck, build, **1,163 tests (one skip)** and 13 no-model Copilot
delivery browser checks across six viewports with zero serious/critical axe
findings. It physically extracted all 16 direct-packed framework artifacts
from `1af20f6` and the renewed core. Its scrubbed receipt is
`receipts/copilot-lifecycle-packed-graph/qualification-1af20f6-21280fe/`;
`SHA256SUMS` SHA-256 is
`8ce9375e7aeaf9f323ca00847c3473f1cedd9031f6d5c0f9cea5aa138473b632`.
Third-party dependencies came from a local install, including a same-version
compiled Linux `node-pty` binary, so this is a staged local graph test rather
than a clean published-install qualification. SDK `1.0.14` and CLI `1.0.88`
are the selected current Copilot pins. Native Windows behavior,
account-specific GPT-6 Sol entitlement, native model turns, installed-host
behavior and the coordinated maintenance window remain unqualified. No push,
publication, production action or credential access was used.

## Authenticated renewal review candidate — 2026-09-22

Local, unpublished implementation source
`b357e43e02515f8d25568a2eff800e7d86495368` was clean during qualification. It is
based on signed prerelease source `c28811b320f436acbec332b00199716a3c62cfa7`.
See the [handoff](wiki/Transport-Renewal-Handoff.md) for review commits and the
[design/migration](design/p2prpc-renewal-vnext.md) for contract and rollout.
Later handoff/checkpoint commits contain documentation only.

The independently staged core is `0.3.0-renewal.0`, wire/ALPN v5, handshake v4,
renewal contract 1, against upstream
`6f0bac778d8944e846e50151b5e42a4a7f9982b0`. Multiplex's p2prpc application contract
is `5.renewal.1`; domain protocol remains v5. The 16 published Multiplex versions,
dependency pins and root lockfile are unchanged. This qualifies a verified local
artifact overlay; release packing and native release attestation are blocked
until independent publication, exact pin review and qualification of that graph.

| Boundary | SHA-256 |
| --- | --- |
| Complete independent source patch | `c10c42e68be3807bcedd77e85b127ce5cf2eb218cad10793596b1cf559128cca` |
| Reproducible core tarball | `789da942e6902121a86a12f644c747acb2454dcb8e6bd2448803e16cfbfe05d5` |
| Passing receipt's `SHA256SUMS` | `fe817fbe1ed1d38c3db1cf982aa9aad3159a000502ee41393fa56eacd8eb77a3` |

On Node 24.19.0 / npm 11.17.0, with test umask 022:

- Multiplex: 932 tests / 101 files, full typecheck/build, checkpoint/docs/release
  metadata/secret checks, pinned-action/actionlint validation and whitespace checks.
- Independent core: 413 unit tests / 15 files, 26 real-Iroh integration tests /
  2 files, full typecheck (core/example/benchmarks), build, ESLint, docs, package
  content, packed consumer and tree-shaken native-import smokes.
- Real QUIC renewal tests span three original accelerated authentication
  lifetimes. Coverage includes idle/busy cursor continuity, reads, one mutation
  invocation, cancellation, unknown settlement and read-only receipt recovery,
  invalid tokens, idle-policy revocation, scope changes, replacement timeout,
  duplicate/stale lineage, clock skew, capacity contention, fixed-expiry rejection
  and genuine reconnect. The SQLite root/child/runtime test retains one snapshot
  and feed per healthy edge, reopens the durable cursor, and still projects real
  child loss immediately. Per-hop unknown command diagnostics cannot regress a
  recovered known receipt or tear down that feed.

Passing Docker receipts under
`receipts/p2prpc-renewal/qualification-b357e43/`:

- Tree: `tree/20260922-renewal-b357e43/`, image
  `sha256:e6c1892930c31bbf82c40a58469caed0492ef1f3a50e32ede501493f933aad79`;
  receipt checksums digest
  `5759cc990f07abd664a12644459008d88969438258308b61f9a3931ab5756d49`.
  Authority restart, warm-branch failover, metadata convergence, routing and
  immutable image transfer assertions passed.
- Scale: `scale/20260922-renewal-b357e43/`, image
  `sha256:02cc1e15faf3d19b723deeee50a3deb8df4ed5d83d91e730053148004b1e2b82`;
  receipt checksums digest
  `43e5b77e317a7496db086f6f95a0b52744cff0e041a25ca73b57b8d7657e2517`.
  Ten runtimes, 100 launches and sends, 3,600 events, zero gaps/duplicates,
  cursor/network recovery, metadata and dashboard assertions passed.

Both Docker suites record the actual candidate dependency and verified cleanup;
their default TTL is not a three-period renewal soak. Accelerated real transport
tests provide that coverage. The combined receipt is scrubbed and checksummed;
all disposable endpoints, containers, networks and images were removed.
Earlier failed attempts, including missing Docker-prune registry authentication,
are diagnostics outside the passing receipt. Candidate preparation now preserves
public source/package file modes regardless of the operator's private umask.

No hosted CI, native Windows run, native model workload, publication, pin update,
production action or other checkout change occurred. Irregular Windows/native
Copilot stalls remain separately unqualified. Final published-graph and external
consumer qualification, refreshed signed locators, and a 45-minute activation
observation belong to the separately authorized coordinated maintenance window.

## Storage stall containment — 2026-09-11

Signed [`hotfix-2026-09-11.1`](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-11.1)
identifies source `fd17b7a61f2097378b38438ae8abbadbf06bf1c8` and all 16
`0.2.4-hotfix.14` packages. Gateway recovery admission, catalog write reduction
and bounded authority-worker RPC preserve protocol, migration, native/transport
pins and WAL/FULL durability. Worker isolation applies only to an authority
without upstream or locally owned runtimes. No filesystem placement changes.

Node 24.19.0 / npm 11.17.0 passed typecheck/build, 928 tests across 99 files,
checkpoint/docs/release/secret checks, all 16 role-isolated packed consumers and
the 507-component release-build SBOM. Tests cover a 60-second writer stall with
responsive health, bounded queued/response credits, actual SQLITE_FULL, worker
exit before commit and after commit-before-reply, child feeds and lost reverse
command replies reconciled under the original operation ID without redispatch.
All 19 published assets were independently downloaded and byte-compared; all
package SHA-256/SHA-512 integrities and signed source/tag identities verify.

Implementation-stage deterministic Docker runs passed:

- Tree: `receipts/protocol-v4-control-tree/20260911T020533Z-d9d67a55876f/`,
  image `sha256:f094734d430de0fa7d2aa42083e6aa7b30c7eafe108f09cde971780dfda8bad8`.
  Includes isolated authority, root restart, direct-child fallback and convergence.
- Scale: `receipts/protocol-v4-mock-docker-scale/20260911T015742Z-aae9532d6c60/`,
  image `sha256:4dffeee69b73a14bd612fc047537364eb11aabe8e43e0d6239639d492240d45f`,
  10 runtimes / 100 sessions using ordinary local-runtime composition.

These Docker runs preceded the final clean source commit; their manifests and
image identities define that evidence, not an invented clean-tag rerun. Prior
failed tree receipts remain diagnostics. Scrubbed checksummed release evidence
is under `receipts/storage-reliability/2026-09-11/`. Native-model qualification is
waived for this incremental prerelease; no stable registry promotion or installed
host qualification is claimed. Imported-event identity evidence remains unpruned;
retention failures may exceed normal headroom, and worker termination cannot
make a stuck kernel syscall complete.


## Independent access HTTP requests — 2026-09-10

Signed tag [`hotfix-2026-09-10.1`](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-10.1) identifies source
`01ba00f4d3fddf0cc10f1c6c79b311fc92a21bc6` and all16 `0.2.4-hotfix.13` packages.
The release changes only the access client's HTTP request
construction: one independently completed/cancellable request per query or
mutation. It preserves bearer/custom headers, WebSocket subscriptions and
exact mutation bodies without replay. The unchanged p2prpc implementation already
opens one QUIC bidirectional stream per RPC. No migration, protocol version,
native binary or transport dependency is changed.

Typecheck/build, **884 tests across 94 files**, documentation, checkpoint,
release metadata and source-secret checks pass on Node `24.19.0` / npm `11.17.0`.
Five real-loopback HTTP regressions cover held history/task reads, independent
cancellation, authentication and failed mutation dispatch. An initial test run
used a restrictive process umask that invalidated the existing unsafe-directory
fixture; the complete rerun under the normal 022 umask passes. Native-model
qualification remains waived for this incremental prerelease. All16 packed consumers and the507-component SBOM pass. All19 public assets
were independently downloaded and byte-compared, including SHA256/SHA512
integrities. Source and tag signatures verify against tracked release signers. Private evidence is under
`receipts/independent-http/2026-09-10/`.

## Imported interaction ownership hotfix — 2026-09-09

Signed tag [`hotfix-2026-09-09.3`](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-09.3)
identifies source `a5a6ef8d77e528c40728353560b9d8299c07a8af` and 16 packages at
`0.2.4-hotfix.12`. Interaction resolution, expiry, republication and retirement
preserve imported child projection ownership. Snapshot takeover and conflicting
terminal-answer checks remain enforced. No migration, native/transport pin,
protocol, or third-party dependency changes are included. Existing corrupt
markers require a separately fenced, backed-up repair.

Typecheck/build, **879 tests across 93 files**, docs/checkpoint/release and
source-secret checks pass. All 16 role-isolated packed consumers pass using the
exact published transport tarball resolver; the release-build SBOM verifies
507 components and 125 bundled web identities. All 19 published assets were
independently downloaded, byte-compared and SHA256/SHA512-verified; signed source
and tag signatures verify against the tracked signer list. The exact toolchain
is Node `24.19.0` and npm `11.17.0`.

The deterministic Docker control-tree suite passes at
`receipts/protocol-v4-control-tree/20260909T060834Z-6954053c7b0f/`.
The 10-runtime/100-session Docker scale suite passes at
`receipts/protocol-v4-mock-docker-scale/20260909T061400Z-dde54c610e37/`.
Scrubbed checksummed release evidence is in
`receipts/interaction-ownership/2026-09-09/`. These are deterministic qualifications,
with no native model calls. This uses the existing incremental prerelease
exception and native-model waiver; stable registry promotion and installed-host
qualification are not claimed.

## Native context compaction hotfix — 2026-09-09

Signed tag [`hotfix-2026-09-09.2`](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-09.2) identifies source
`e5846a5e068ef01d37a82e893291bad19671c9f1` and all 16 `0.2.4-hotfix.11` packages.
The release adds explicit native Codex/Copilot compaction through the existing
stable command and active-binding fences. Codex preserves its start
acknowledgement, while Copilot preserves completion counters and false results.
Malformed, oversized, lost or retired-binding acknowledgements remain unknown
without replay. Security/notices review records agent-control authorization and
potential provider/model calls. No new third-party package, migration,
native/transport pin, generated declaration or protocol-version change is included.

Source validation passed: typecheck/build, **874 deterministic tests across 92
files**, checkpoint, documentation, release metadata and source-secret checks.
The exact release toolchain is Node `24.19.0` and npm `11.17.0`. The high-severity
npm audit passes; two existing moderate Vitest development-tool advisories remain
outside this change. All 16 role-isolated packed consumers pass. The SBOM contains
507 release-build components, including all 16 packages and 125 bundled web
identities.

Published at `2026-09-09T05:46:47Z`, all 19 assets were independently downloaded
and byte-compared with the validated artifact set. Tarball SHA1/SHA256/SHA512,
sizes, source commit and exact toolchain match the public manifest. Source commit
and tag signatures verify against the tracked release signers. Scrubbed and
checksummed evidence belongs to `receipts/native-compaction/2026-09-09/`.
This is the owner-authorized incremental prerelease exception; native-model
qualification is waived. Native compaction itself may make model requests, so no
live compaction, Windows qualification or installed-host activation is claimed.

## Copilot native task controls hotfix — 2026-09-09

Signed tag [`hotfix-2026-09-09.1`](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-09.1) identifies source
`37816aa9a217bfbfd301825e6369d8f599ee85df` and all 16 `0.2.4-hotfix.10` packages.
The release adds native Copilot task observation, progress,
exact-ID promotion and cancellation. Read lanes retain stalled calls, metadata
refresh cannot outlive its list deadline, and mutation ambiguity preserves the
original durable operation. Security/notices review covers read versus
agent-control authorization. The adapter directly declares the already locked
Zod validator; no new third-party package, migration, native/transport pin or
protocol-version change is included.

Source validation passed: typecheck/build, **848 deterministic tests across 90
files**, checkpoint, documentation, release metadata and source-secret checks.
Codex regeneration from the exact pinned CLI is byte-identical after the tracked
ESM normalization. The high-severity npm audit passes; two existing moderate
Vitest development-tool advisories remain outside this API hotfix.

All 16 isolated packed consumers pass. The SBOM contains 507 release-build
components, including all 16 published packages and 125 bundled web identities.
The prerelease was published at `2026-09-09T03:16:07Z`; all 19 assets were
independently downloaded and byte-compared, and tarball SHA256/SHA512 integrities
match the artifact manifest. Source commit and tag signatures both verify against
the tracked release signers. Local scrubbed/checksummed evidence belongs to
`receipts/copilot-task-controls/2026-09-09/`.

A disposable native Linux smoke on that exact clean source verified synchronous
shell promotion, synchronous/background cancellation, progress, absent-ID no-ops
and task-change events with **zero model/provider requests**. Its receipt is
`receipts/copilot-native-tasks/2026-09-09T03-13-35.586Z/`.
This follows the owner-authorized incremental prerelease exception; native-model
qualification is waived. These checks do not qualify Windows or model-driven
agent/client behavior, and no installed-host activation is claimed.

## Copilot stalled-read recovery hotfix — 2026-09-08

Signed tag [`hotfix-2026-09-08.2`](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-08.2) identifies source
`77a3898254a367c81ba43c69293aab4c62f8ff98` and all 16 `0.2.4-hotfix.9` packages.
The release contains bounded/coalesced Copilot read-only calls,
native activity reconciliation, mode observation and independent runtime presence
maintenance. Timeouts discard late read results while retaining unresolved native
slots; they never retry ambiguous mutations or imply native completion. Runtime
maintenance retains one job per lane across reconnects and fences late results.
No protocol, transport/native dependency or migration boundary changed.

Typecheck/build, **826 deterministic tests across 89 files**, documentation,
checkpoint and release metadata checks pass for this implementation. Private
source/log checksums belong to `receipts/copilot-read-recovery/2026-09-08/`.
All 16 isolated packed consumers pass using the configured GitHub Packages read
credential. The release-build SBOM contains 507 components, including all 16
packages and 125 bundled web identities. Published at `2026-09-08T11:46:09Z`,
all 19 assets were independently downloaded and compared with local artifacts;
all tarball SHA256 and SHA512 integrities match the manifest. Both source commit
and tag signatures verify against the tracked release signers. Native-model
qualification is waived under the owner's incremental hotfix exception; this
entry claims no live model qualification or installed host activation.

## Bounded Codex turn detail hotfix — 2026-09-08

Signed tag [`hotfix-2026-09-08.1`](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-08.1) identifies source
`a4c69378ac16adc4f00adcd071e2efe65f537514` and all 16 `0.2.4-hotfix.8` package
artifacts. It adds capability-gated native turn status/error paging.
The adapter preserves native errors, timestamps and cursors, with bounded
summary reads and native `notLoaded` fallback. Native decisions and ordinary
item history remain unchanged. No wire, transport/native dependency or
migration boundary changed.

Typecheck/build, **783 deterministic tests across 88 files**, checkpoint,
documentation and release metadata checks passed on the implementation source.
Private source/log checksums are recorded in
`receipts/codex-turn-detail/2026-09-08/source-checks.json`. This is deterministic
source evidence, not native-model qualification. All 16 isolated packed consumers
also passed using the configured GitHub Packages credential. An initial attempt
using the GitHub CLI token failed with insufficient registry scopes; that failure
is diagnostic only. All 19 published assets were independently downloaded and
verified against the local artifacts. Installed rollout remains in the consumer
repository; the owner has waived model-using release qualification for these
incremental hotfixes.

## Codex goals and unavailable Copilot recovery — 2026-09-07

Signed tag `hotfix-2026-09-07.6` identifies source
`cbb37c222865fc194f17577d75fea3d330551c27`. The
[published prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-07.6)
contains 16 `0.2.4-hotfix.6` packages, `pack-manifest.json` and `SHA256SUMS`.
It adds native Codex goal observation/set/clear and
recognizes Copilot's exact missing-history resume refusal as a known failure.
The pinned goal schemas match the installed Codex 0.153.4 contracts; no generated
source, native dependency, transport, migration or protocol-version changes.

Node 24.19.0/npm 11.17.0 typecheck, production build, all **758 tests**, checkpoint,
docs and release metadata checks pass. The owner waived model-using qualification.
Disposable CLI 1.0.81 probes reproduced empty-session loss and verified the known
failed resume with no user message or replacement. The scrubbed local receipt is
`receipts/copilot-empty-session-recovery/2026-09-07-no-model/`; it does not claim
Windows or native-model release qualification. All 16 isolated packed consumers
also pass with the exact independently published transport tarball. The registry
path could not authenticate with this machine's GitHub Packages scope, so no
registry-auth verification is claimed. Installed rollout belongs to the personal
consumer's implementation status; no stable promotion or native soak is claimed.

Status: signed `v0.2.3` published on 2026-09-07 with an explicit native-model waiver.

This document records release qualification and separately scoped development
evidence. Its filename remains stable for existing links. It is not a second
architecture guide. Start a new development session with
[`wiki/Current-State.md`](wiki/Current-State.md), then use the role-specific
wiki and design documents linked at the end of this page.

## Copilot pending messages hotfix — 2026-09-07

Signed tag `hotfix-2026-09-07.4` identifies source
`fea5cedc1cdd8f61002f108203e2a4d23cab202e`. The
[immutable prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-07.4)
contains 16 `0.2.4-hotfix.4` packages, `pack-manifest.json` and `SHA256SUMS`.
It adds live Copilot pending-message reads and atomic queue-to-steering commands;
new procedures are optional and capability-gated. Protocol version 5, native
pins, p2prpc `0.2.1` and migrations remain unchanged.

Typechecking, **678 tests**, docs/checkpoint/release gates and all 16 isolated
packed consumers pass. Packed checks use the same verifier with the transport
resolved from its independently published public tarball; no registry-auth
qualification is claimed. The separate p2prpc worktree also passes typechecking
and **401 tests**, without changes. Framework dependencies were reinstalled from
the lock before testing, and the actual loaded Copilot SDK is `1.0.13`.
No model calls, native soak, stable promotion or installed-host qualification
is claimed. Consumer rollout and deferred Windows restart belong to the
personal repository's handoff.

## Copilot observation hotfix — 2026-09-07

The published `0.2.4-hotfix.3` fixes model observation after native attachment
and keeps attached/background work running until Copilot's whole-session idle
signal. Model API reads and root changes retain native IDs and fence late
observations; no model selection is replayed on resume. Twenty-two new adapter
regressions cover these boundaries and pending interactions.

Local typecheck, all **655 tests**, checkpoint, documentation and release checks
pass. The 16-package graph retains protocol 5, Copilot SDK `1.0.13` / CLI
`1.0.81`, Codex `0.152.0`, p2prpc `0.2.1` and released migrations. No real
model calls, soak, native qualification or stable promotion is claimed.
Signed tag `hotfix-2026-09-07.3` identifies source
`0eaf6ae20538e461ab37730d7b2f267c5b912aaa`; the
[GitHub prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-07.3)
contains all 16 packages and their manifest/checksums. The personal consumer's
installed tarball integrities match all 16 manifest entries.

All packages pass publint, applicable type/export checks and 16 isolated
consumers using the public `p2prpc@0.2.1` release tarball, matching the personal
consumer's transport dependency. The stock registry consumer check was blocked
by the available GitHub token's missing package-read scope. No registry consumer
qualification is claimed. The fallback retained the same verifier and replaced
only transport discovery with its public release URL. Consumer deployment facts
belong to the personal repository.

## Urgent session hotfix evidence — 2026-09-07

The owner authorized focused-check prerelease deployment followed by broad
non-model checks. This evidence does not promote a stable release or assert a
passing native-model qualification. Wire protocol remains `5`, transport remains
exact public `@arduano/p2prpc-core@0.2.1`, and native pins remain Codex `0.152.0`,
Copilot SDK `1.0.13` and CLI `1.0.81`.

### Immutable deployed package boundary

Signed tag `hotfix-2026-09-07.2` peels to
`564f166ebe579eefa749c9682400628d68af63ce`. Its
[GitHub prerelease](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-07.2)
was published at `2026-09-07T03:45:02Z`, with 16 lockstep `0.2.4-hotfix.2`
tarballs. The `pack-manifest.json` SHA-256 is
`78075b77456f0688b176cfd21fa8c59252bbc4fad738b9e513ac5a1f4840b7ca`;
the `SHA256SUMS` file SHA-256 is
`8f5381559ad1459cbf44c8f4a3b77e063e8da0c87b39f2fb00d0466d9503d037`.
No artifact or signed tag was replaced during final validation.

[Docker qualification run 34082871111](https://github.com/arduano/agent-multiplex/actions/runs/34082871111)
checked out that exact commit and passed both deterministic suites. Downloaded
artifact `10004313224` contains the following successful, scrubbed receipts;
independent SHA-256 verification passed all 48 inventory entries in each:

| Receipt | SHA-256 of its `SHA256SUMS` |
| --- | --- |
| `protocol-v4-control-tree/20260907T042344Z-4ee2f6401bae` | `f15c19833b4607637b6df2583ae31c2ddc02aa6aaacc03a3d40dcb3349102553` |
| `protocol-v4-mock-docker-scale/20260907T042605Z-11cc549a3bc9` | `18d61bcaa1ee000c2cd5b4c2a7c3b0810657cfa49f2730b612a107f00ea04777` |

The tree run exercised authority/branch failover and recovery, queued metadata,
native event reassembly and immutable image transfer. The scale run exercised
10 runtimes/100 concurrent mock sessions, client and runtime reconnect recovery,
zero native event gaps/duplicates and responsive dashboard checks. Its receipt
records Node `24.19.0`, Docker `28.0.4`, zero real agent processes and zero inference
requests. Both runners removed disposable state; they did not alter installed
hosts or existing sessions. Receipt directory names retain their historical `v4`
spelling; their manifests explicitly record protocol `5`.

### Final reviewed source checks

Review head `15e27abc9f7ec0d4e6fa93514fb69c7175c3b31f` passed these PR workflows:

- [CI 34085039526](https://github.com/arduano/agent-multiplex/actions/runs/34085039526):
  typecheck, 633 tests across 81 files, docs/checkpoint/release gates, build,
  no-model native Copilot permission smoke, audit, all 16 independent packed
  consumers, SBOM and tracked-source credential scan.
- [Windows 34085039485](https://github.com/arduano/agent-multiplex/actions/runs/34085039485):
  x64 private-state/storage/native startup and isolated Copilot permission RPCs,
  with zero model calls or retained credentials.
- [CodeQL 34085039503](https://github.com/arduano/agent-multiplex/actions/runs/34085039503)
  and [dependency review 34085039508](https://github.com/arduano/agent-multiplex/actions/runs/34085039508).

These workflows checked out GitHub's synthetic PR merge commit
`093c43828a42a535c7f4576c47c44431fa21fd79`. Its complete Git tree is byte-identical
to the review head: `1dcd16b986b6fb258c5e0b63385d1358e06c8a57`, including the
lockfile. The downloaded pack manifest names that merge commit; its SHA-256 is
`c61dab0d50db28be4eae01c1556f8997b9f5e51a1cfa56440c7833efe0b5a0cf`.
All 16 downloaded package checksums passed. The `SHA256SUMS` SHA-256 is
`27e149e5c4b207ae7a20e915fec36156d53df3750a2b7e1bda7bc8d9715e278a`.
These CI candidates are separate from the immutable prerelease bytes above.

Windows receipt inventories also passed independent checksums. Startup receipt
`2026-09-07T04-59-52.643Z` has inventory SHA-256
`ee327f3cb96991f08ee62b24dde85940e0491ee10b667ec4ae6c06a5788c9621`;
permission receipt `2026-09-07T04-59-54.797Z` has inventory SHA-256
`7775646813d5efedfe77396647c9fd29400ecd14c60b4351e899c9863b4ed6fd`.
Downloaded evidence is retained locally under `receipts/urgent-final-ci/`;
credential-pattern scans found no raw credentials in its textual receipt files.

The published hotfix reference CLI/control/runtime/gateway executables still
print the stale hardcoded `0.2.3` for `--version`, although package manifests and
consumer locks correctly identify `0.2.4-hotfix.2`. Final source commit `15e27ab`
reads the installed package manifest instead; this fixed the packed executable
verification failure without changing the immutable release. Installed bespoke
hosts, corporate OAuth and laptop fallback/outage UAT remain consumer-owned
evidence, not outcomes implied by these framework checks.


## Embedded locator release — 2026-09-07

Signed tag `v0.2.3` peels to `7b9d3e383fceb299cf3c1f1404358466abe7be23`.
All 16 lockstep packages are published at `0.2.3`. The only runtime code addition
is lifetime-fenced control-ticket access; protocol, migrations, transport and
native package pins are unchanged from `0.2.2`.

Exact-source evidence:

- [CI](https://github.com/arduano/agent-multiplex/actions/runs/34073277454).
- [Windows startup](https://github.com/arduano/agent-multiplex/actions/runs/34073277447).
- [CodeQL](https://github.com/arduano/agent-multiplex/actions/runs/34073277444).
- [Docker tree/mock scale](https://github.com/arduano/agent-multiplex/actions/runs/34073277410).
- [Immutable publication](https://github.com/arduano/agent-multiplex/actions/runs/34073552897)
  succeeded; the [release](https://github.com/arduano/agent-multiplex/releases/tag/v0.2.3)
  contains 21 assets and was published at `2026-09-07T01:44:01Z`.

The owner separately authorized skipping model-using qualification. Exact-commit
status `53645081986`, created by owner numeric identity `13347712`, records
`WAIVED for v0.2.3 by owner; local ticket accessor only; native and transport pins unchanged`
in context `Agent Multiplex / Owner-approved native-model waiver`. This is an
explicit release exception, not a passing native-model receipt.

All 16 independently downloaded tarballs passed SHA-256 and GitHub build-provenance
attestation verification. The consumer lockfile's 16 npm SHA-512 integrities match
the release manifest. Artifact inventory SHA-256:
`786396d6df5827fd4a715e0d1d42b491addfd2e2f2a10a66599dd8b46c05c5b7`;
`pack-manifest.json` SHA-256:
`7f1f8e35e65b87263e05df5c64e1131044a8228d6cfb4d468f4fa185fdcf9d0a`.
The consumer retains its downloaded artifacts under local
`receipts/framework-0.2.3-release/`. Laptop installation and outage checks belong
to the consumer; this release does not claim those deployment results.

## Copilot permissions release — 2026-09-07

Signed tag `v0.2.2` (tag object `c9c4f6e57a56d45cfe69589de663780963a93b8a`)
peels to `1baacd49d44f9fe3d10f52b5fab0a8175d35a508`. All 16 lockstep packages
are published at `0.2.2`; transport remains `@arduano/p2prpc-core@0.2.1`.
Copilot SDK is `1.0.13`, CLI remains `1.0.81`, and Codex remains `0.152.0`.

Exact-source evidence:

- [CI](https://github.com/arduano/agent-multiplex/actions/runs/34039392228):
  typecheck, 625 tests, release/docs/checkpoint checks, package consumers and
  isolated native Copilot permission RPC smoke with zero model calls.
- [Windows startup](https://github.com/arduano/agent-multiplex/actions/runs/34039392216):
  private-state/SDK startup and isolated native permission RPC checks.
- [CodeQL](https://github.com/arduano/agent-multiplex/actions/runs/34039392202).
- [Docker tree and 100-agent mock qualification](https://github.com/arduano/agent-multiplex/actions/runs/34039392270).
- [Immutable package publication](https://github.com/arduano/agent-multiplex/actions/runs/34039674529):
  signed tag, exact prerequisites, packed and registry consumer verification,
  artifact attestation, public package visibility and release asset checks.

The owner explicitly requested skipping model-using release qualification to
unblock laptop deployment. Owner-created status **Agent Multiplex / Owner-approved
native-model waiver** succeeds on this exact source with description
`WAIVED for v0.2.2 by owner; native permission RPC checks passed without model calls`.
The release workflow accepts that exception only for `v0.2.2`; no passing native
four-container receipt or soak result was fabricated. Native provider-driven
permission workflows remain subsequent device/model UAT.

The [public release](https://github.com/arduano/agent-multiplex/releases/tag/v0.2.2)
retains all tarballs, checksums, manifest, SBOM and publication receipt. The
pack-manifest SHA-256 is
`e6f8b6bf59a3616225a22dda59fcbb93e82d4bc15685ce84d65057071bf36fbb`.
The local downloaded inventory verifies all 16 tarballs, and the adapter-Copilot
artifact's GitHub attestation verifies against this repository. The personal
consumer separately verifies every lockfile integrity against that manifest.


## Windows patch release qualification (2026-09-06)

| Evidence | Identity |
| --- | --- |
| Signed annotated tag | `v0.2.1`; tag object `10223abed9c5b8549923ccde1877c9361acf7a19` |
| Peeled source commit | `a6b4b1ecc474ae819ab7609486d0978fe0bc4957` |
| Wire/package boundary | Protocol `5`; 16 lockstep packages at `0.2.1` |
| CI | [Run `34023055422`](https://github.com/arduano/agent-multiplex/actions/runs/34023055422), passed on the exact source |
| CodeQL | [Run `34023055398`](https://github.com/arduano/agent-multiplex/actions/runs/34023055398), passed on the exact source |
| Deterministic Docker | [Run `34023055510`](https://github.com/arduano/agent-multiplex/actions/runs/34023055510), passed on the exact source |
| Windows Copilot startup | [Run `34023055448`](https://github.com/arduano/agent-multiplex/actions/runs/34023055448), passed on the exact source |
| Publication | [Run `34023552031`](https://github.com/arduano/agent-multiplex/actions/runs/34023552031), passed on the exact source |
| Native qualification | [Owner-recorded success status](https://github.com/arduano/agent-multiplex/commit/a6b4b1ecc474ae819ab7609486d0978fe0bc4957) |
| GitHub Release | [`v0.2.1`](https://github.com/arduano/agent-multiplex/releases/tag/v0.2.1) |

Native receipt: `receipts/protocol-v4-live-four-container/20260906T085229Z-295e94b14a7a`.
SHA-256 of its `SHA256SUMS`: `23f2294bea0301f5a8465c38734575e4fcb91d428827b90f26161da74085bc67`.
The owner authorized a **300,000 ms soak for 0.2.1 only**. The same browser and
gateway watcher retained both agents, then received fresh streamed Codex and
Copilot replies. The recorder validated the exact-source receipt and all
stream/count/cleanup/secret predicates before recording status. The short soak
need not reset the independent transport subscription and does **not** requalify
the 15-minute authenticated-session renewal boundary. Other versions retain
930,000 ms and positive reset/replay requirements.

The native run also covered UI metadata, Codex model/mode switching, Plan input,
interruption, managed terminal interaction with two viewers, native history
reload and responsive accessibility. Disposable containers, network, image,
relay and state were removed. No installed personal host or existing native
session was changed. Pins remain Node `24.19.0`/npm `11.17.0`, Codex `0.152.0`,
Copilot SDK `1.0.11`/CLI `1.0.81` and public p2prpc `0.2.1`.

Windows 2025 x64 separately passed private DACLs, SQLite ownership/reopen,
retained image uploads, Iroh and unauthenticated Copilot SDK startup, with zero
model calls. Corporate OAuth/network/suspend and real share access remain laptop
UAT. Native Windows Codex and output-image paths remain unsupported. The personal
consumer separately records installation/host/executor tests against the exact
published artifacts, including C:/D: directories.

The patch adds trusted static runtime path-policy injection without changing
wire v5, default root fencing or released migration identities. Publication
verified packed and registry consumers, all 16 tarball integrities, attestations
and public Release assets. Independent downloaded checksums and provenance:
all 21 Release asset digests and all 16 package provenance attestations passed.
The manifest SHA-256 is
`e4a30672353f771666bfd2c93fd007a2af7e13045b1f79162b8933f37568d8ee`.
Raw receipts stay local/gitignored; linked workflows,
owner status and inventory digests are the portable evidence.

The earlier five-minute run at `f070939` passed native acceptance but was
rejected by the recorder's positive reset/replay requirement. It remains
diagnostic evidence. The final source explicitly scopes that requirement to
longer soaks and other versions, preserves sequence/replay integrity checks,
and has the fresh accepted receipt above.

## Protocol-v5 release qualification (2026-09-05)

| Evidence | Identity |
| --- | --- |
| Signed annotated tag | `v0.2.0`; tag object `cf4d8a3fa9221587bd96adc058d631e0a7fd4b34` |
| Peeled source commit | `0e043478538a30a0a42fd854f5f5c8a14309cbf0` |
| Wire/package boundary | Protocol `5`; 16 lockstep packages at `0.2.0` |
| CI | [Run `33955393265`](https://github.com/arduano/agent-multiplex/actions/runs/33955393265), passed on the exact source commit |
| CodeQL | [Run `33955393288`](https://github.com/arduano/agent-multiplex/actions/runs/33955393288), passed on the exact source commit |
| Deterministic Docker | [Run `33955393260`](https://github.com/arduano/agent-multiplex/actions/runs/33955393260), passed on the exact source commit |
| Native qualification | Owner-recorded `Agent Multiplex / Native four-container qualification` [success status](https://github.com/arduano/agent-multiplex/commit/0e043478538a30a0a42fd854f5f5c8a14309cbf0) |
| Publication | [Run `33956925510`](https://github.com/arduano/agent-multiplex/actions/runs/33956925510), passed on the exact source commit |
| GitHub Release | [`v0.2.0`](https://github.com/arduano/agent-multiplex/releases/tag/v0.2.0), published 2026-09-05 at 09:09:07 UTC with 21 assets |

The qualifying native receipt is
`receipts/protocol-v4-live-four-container/20260905T084042Z-1429aa03a5d9`.
The historical directory name is retained by the runner; its manifest explicitly
records protocol **5** and the exact source commit above. The requested
930,000 ms soak completed, with fresh post-soak native Codex and Copilot replies.
The independent recorder validated the scrubbed inventory before creating the
owner status. SHA-256 of `SHA256SUMS` is
`79e7bfff5878448ef574f1d888024a8a11a000644eb8cb31bbb9f093a18ee077`.

The run used Node `24.19.0`, Docker Server `29.7.2`, Codex CLI `0.152.0`,
Copilot SDK `1.0.11`, Copilot CLI package `1.0.81`, and exact public
`@arduano/p2prpc-core@0.2.1`; transport/native pins are unchanged. It exercised
the four-container native control, streaming/history, browser, terminal,
metadata, and renewal checks. Cleanup removed the disposable containers,
network, image, relay, and runtime state; no material user data was removed.
The manifest records `credentialMaterialRecorded=false`.

All 16 public tarballs match the consumer's locked artifact integrities.
Independent downloads verified all 21 inventory checksums and all 16 package
attestations. The public tarballs differ in archive bytes from the local
qualification packs, but their extracted files match byte-for-byte. The publication workflow completed packed-consumer and
registry-consumer verification, package attestation, exact-artifact publication
and `latest` promotion, public-package visibility checks, and exact GitHub
Release creation/recovery. The Release API independently confirms 21 uploaded
assets. These are the `v0.2.0` workflow results; the separate manual
registry/Release byte-equality and provenance audit below belongs to `v0.1.0`.

This release qualification does not erase the narrower outcomes of the earlier
image trials. Those receipts retain their original implementation fingerprints;
the live release suite is not an additional external-model image-prompt suite.
Raw receipt trees remain local and gitignored. The tracked identities, public
workflow links, immutable owner status, and inventory digest form the portable
audit trail.

## Historical v0.1.0 release identity

| Evidence | Identity |
| --- | --- |
| Signed annotated tag | `v0.1.0`; tag object `da9497ed9ae5e020dd51ec21523bf91139f811e7` |
| Peeled source commit | `38236480a88e5a7f350097b1bc43fd9a7674096d` |
| GitHub Release | [`Agent Multiplex v0.1.0`](https://github.com/arduano/agent-multiplex/releases/tag/v0.1.0) |
| Package set | 16 public lockstep `@arduano/agent-multiplex-*` packages at `0.1.0` |
| Release assets | 16 tarballs plus `SHA256SUMS`, pack manifest, publication receipt, visibility note, and CycloneDX SBOM: 21 total |
| Transport dependency | Public `@arduano/p2prpc-core@0.2.1`, exact pin and integrity `sha512-vsSv2Wd8V/X+mykNSXK0Dfc4ygI+DuI6Wjdkmfa4kBm5j/PPkm4ekX0+ngwQeKuQ0DQ9EmmWRlk4RGu45DfD7A==` |
| Release toolchain | Node `24.19.0`, npm `11.17.0` |

This historical release established the protocol-v4 baseline. Its qualification
does not cover protocol-v5 changes. The table above identifies only the immutable
`v0.1.0` release; current qualification is recorded separately above.

### Exact-commit gates

The signed release commit passed all required gates before publication:

- [CI run `33923601798`](https://github.com/arduano/agent-multiplex/actions/runs/33923601798);
- [CodeQL run `33923601886`](https://github.com/arduano/agent-multiplex/actions/runs/33923601886);
- [deterministic Docker qualification run `33923601753`](https://github.com/arduano/agent-multiplex/actions/runs/33923601753);
- owner-recorded `Agent Multiplex / Native four-container qualification`
  status for the same commit;
- [publication run `33925122627`](https://github.com/arduano/agent-multiplex/actions/runs/33925122627),
  completed successfully on attempt 3.

The tagged workflow independently rebuilt the source, typechecked and tested
it, built one complete artifact set, validated every packed consumer, generated
the SBOM, scanned tracked source for credentials, attested every tarball,
reconciled exact registry bytes, installed every package through a clean
registry-backed consumer, required public visibility, created the Release, and
re-downloaded every asset for byte comparison.

The initial publication exposed a registry edge case: a bare-package
`npm view ... dist-tags` query can return empty output when only `next` exists.
The current default-branch recovery workflow instead queries the exact version,
binds a numeric retained artifact to the signed tag-push run, verifies all 16
registry SHA-512 values and `next` selectors before mutation, and then performs
an idempotent `latest` promotion. Recovery run
[`33929719531`](https://github.com/arduano/agent-multiplex/actions/runs/33929719531)
completed successfully. No package was republished and the tag was never moved.

### Retained qualification receipts

These passing local receipts cover distinct boundaries:

- `receipts/protocol-v4-control-tree/20260904T173822Z-c7222b0a5c27` — four
  containers with authority/branch topology, two overlapping gateway sources,
  queued metadata through authority loss, warm descendant failover and recovery,
  and three exact native-delta reconstructions.
- `receipts/protocol-v4-mock-docker-scale/20260904T200448Z-a3183b58086d` — 12
  containers, 10 runtimes, 100 sessions, 100 launches and prompts, 3,600
  contiguous native events, cursor and runtime-partition recovery, three
  fleet-wide metadata CAS rounds, UI checks, and a 15-second soak.
- `receipts/protocol-v4-live-four-container/20260904T220013Z-716384c05b18` —
  exact signed release commit, one control, one gateway, real Codex and Copilot
  runtimes, two sessions, 641 native events, and a requested/performed
  930-second liveness soak.

The live receipt proves:

- native Codex and Copilot launch, streaming, history, and fresh post-renewal
  prompts;
- Codex model persistence across reload, plan mode, a native user question and
  answer, running-command visibility, interruption, and continued structured
  use after closing a stock TUI;
- metadata initialization and UI-originated CAS updates under the sole control
  authority;
- exact raw terminal replay to two viewers, keyboard lease behavior, terminal
  termination without stopping structured chat, and absence of terminal
  canaries from durable surfaces;
- gateway-only publication, bearer enforcement, source/runtime/session
  projection, browser reload and native-history hydration;
- desktop, compact, tablet, phone portrait/landscape layout checks and no
  serious/critical accessibility violations;
- no retained raw credential material.

Its manifest records Node `24.19.0`, Docker Server `29.7.2`, Codex CLI
`0.152.0`, Copilot CLI `1.0.81`, protocol 4, and the exact public p2prpc package
integrity above. The owner status binds the run ID to inventory SHA-256
`62630865b3d3b583c0e954bfe21c879ee1fefcfcb8fc223f59d134065741d849`.

Every cited receipt contains its own manifest and `SHA256SUMS`. Passing receipts
are evidence only for their recorded source, dependency, topology, and checks.
Failed receipt directories remain diagnostics and must never be cited as a
pass. The complete `receipts/` tree is intentionally gitignored, so a fresh
clone cannot inspect these local paths. Portable evidence is the tracked ledger
on this page plus the immutable commit status, linked Actions runs, Release
assets, and recorded inventory digest above.

### Published-artifact verification

The completed `v0.1.0` release was also audited from the consumer side:

- the remote tag object and peeled commit match the locally verified signature;
- exactly 21 uploaded Release assets match GitHub's recorded SHA-256 and size;
- `SHA256SUMS`, the artifact manifest, embedded package manifests, SHA-1,
  SHA-256, and npm SHA-512 integrity all agree for 16 tarballs;
- all 16 GitHub package records are public and linked to this repository;
- both `next` and `latest` selected `0.1.0` for the complete package set at that audit;
- registry downloads are byte-identical to Release tarballs;
- every tarball has SLSA provenance for this repository's `publish.yml`, exact
  tag ref, exact source commit, and a GitHub-hosted runner;
- all 16 packages pass separate registry-only install, import, declaration,
  browser-bundle where applicable, and packaged executable checks.

Repeated tagged workflow attempts produced multiple valid provenance statements
for the same 16 immutable subjects. Verification requires at least one exact
statement per tarball rather than an exact attestation-record count.

The five auxiliary Release assets are protected by GitHub asset digests,
cross-file identities, and workflow re-download comparison; only the tarballs
have cryptographic build-provenance attestations. Repository-level immutable
Release protection is not enabled, so maintainer mutability remains a platform
trust boundary even though the workflow refuses replacement of existing bytes.

## Reproduce repository checks

With Node 24 and authenticated `read:packages` access:

```bash
npm ci --strict-allow-scripts
npm run check:docs
npm run check:release
npm run typecheck
npm test
npm run check:checkpoint
```

Cross-role changes should also run the deterministic suites:

```bash
npm run test:docker:v4:tree
npm run test:docker:v4:mock:scale
```

Native Codex/Copilot, terminal, browser, authentication, or transport-renewal
changes require a clean exact-main live run and spend real model credits:

```bash
AGENT_MULTIPLEX_LIVE_SOAK_MS=930000 \
  npm run test:docker:v4:live:four
npm run release:native-status -- --check-only \
  receipts/protocol-v4-live-four-container/<successful-run-id>
```

Only record the owner commit status after the candidate is merged and every
receipt check passes. Never publish raw tickets, shared secrets, bearers,
terminal lease secrets, provider credentials/endpoints, native auth homes, or
token-bearing browser URLs.

## Evidence limits

This checkpoint does not prove:

- public multi-tenant identity, isolation, or internet-edge hardening;
- capacity for 100 simultaneous real model processes—the scale receipt uses
  deterministic mock agents;
- native stop, resume, or archive in the four-container live run; deterministic
  tests cover those state machines;
- runtime or live-session migration between machines, graceful online control
  detach, or archived-session restore;
- arbitrary platform support beyond the qualified Linux x86-64 container
  environment;
- stability of a future Codex app-server or hidden Copilot UI-server version;
- correctness of a bespoke launch provider without its own crash, cleanup,
  resume/history/archive, and end-to-end qualification.

## Protocol-v5 image development evidence (2026-09-05)

This earlier image-development checkpoint preceded the `0.2.0` release
candidate. Package manifests were still at `0.1.0`; the transport pin was
unchanged. Its tested implementation
fingerprint is `cb7f5bcf3a430239ed812e6290a5da6e43c779a06ab7fc3b55dfb601e9c9b830`;
the lockfile SHA-256 is
`cb245a0d96c784541b8eb73b875a5f8764e78f15eba599ee713a6712cae00903`.
The inventory covers source, configuration, scripts, and tests; documentation is
excluded so this ledger can record the completed run without changing its tested
implementation boundary.

Repository typecheck, all **594 tests in 75 files**, checkpoint, docs, release,
secret scan, and whitespace gates passed. The unchanged sibling transport source
at `6f0bac778d8944e846e50151b5e42a4a7f9982b0` independently passed typecheck and
401 tests; the application still uses public `@arduano/p2prpc-core@0.2.1`.

Passing, scrubbed, checksummed local receipts for this implementation are:

- `receipts/protocol-v5-control-tree/20260905T065907Z-4c489fe35b71`:
  routed multi-chunk transfers and retries, immutable workspace snapshots,
  ancestor failover/recovery, CLI image-only input, Markdown previews, inert SVG
  display/conversion, and image-only browser sending with native history after
  reload. The image viewer stays mounted through native streaming and restores
  focus to its opening button. All six required viewport sizes passed without
  horizontal overflow or serious/critical axe findings; landscape retained
  128 pixels of transcript, and no external image requests occurred.
- `receipts/protocol-v5-mock-docker-scale/20260905T070128Z-169e24fb0b0f`:
  100 sessions on 10 runtimes, 100 overlapping mock turns, exact native streams,
  cursor/network recovery, metadata convergence, and reference dashboard checks.
- `receipts/protocol-v5-images/20260905T070000Z`: source/dependency inventories,
  repository gate logs, linked receipt checksums and image identities, and the
  qualification scope. Implementation files remained unchanged through the final
  checks; the native offline receipt's 1,094 source/dependency files still match.

The final combined `SHA256SUMS` inventory has SHA-256
`79759348344d5193287f4d078f5359802be6105422a4033ea013cd41e8c29b88`.
All 98 linked tree, scale, and offline-native receipt files passed checksum
verification, as did the combined receipt itself.

The complete receipts remain local and gitignored. This tracked ledger retains
the tested fingerprint and outcome for a fresh clone. Earlier failed or
superseded attempts do not replace these passing receipts.

Real image trials consumed exactly four authorized turns per harness. Codex and
Copilot both recognized the synthetic shapes with mixed text/image and image-only
input. Codex passed the targeted native checks. Copilot exposed inline image
bytes in a live `model.messages_snapshot` event; its original aggregate at
`receipts/native-images-2026-09-05-targeted/aggregate.json` remains failed.
Failed Copilot attempts remain diagnostics; the earlier native checks do not
qualify the final source.

The codec fix was subsequently qualified with pinned native Copilot SDK `1.0.11`
and CLI package `1.0.81` against a loopback completion fixture. Receipt
`receipts/copilot-offline-images/2026-09-05T06-43-35-483Z-031529bc`
reproduced the exact event shape, externalized its image bytes, verified all 30
native event envelopes, and retained image references in native and resumed
history. It records source/dependency hashes and verified checksums, with no raw
prompts, endpoints, or auth homes. It used zero external model calls. At that
checkpoint, the source had not been
requalified against external model services after the fixes and that image-trial
allowance was exhausted. A later, separately authorized four-container run
qualified the exact `v0.2.0` source as recorded above; it did not repeat the
external-model image-prompt suite.

## Maintained documentation

- [Current-state handoff](wiki/Current-State.md) — start here in a fresh session.
- [Wiki home](wiki/Home.md) — task-oriented documentation router.
- [Data-role design](design/data-roles-v4.md) — normative authority, topology,
  routing, projection, and persistence rules.
- [Launch-extension design](design/launch-extensions-v4.md) — normative
  gateway-plugin/runtime-provider/backend contract.
- [Deployment runbook](deployment-v4.md) — detailed personal deployment,
  upgrade, and failure behavior.
- [Release guide](wiki/Releases.md) — versioning, publication, recovery, and
  downstream verification procedure.


## Copilot lifecycle audit hotfix — 2026-09-07

The owner requested a deeper Copilot delivery/event audit and roughly100 useful
conversation messages on initial load. The `0.2.4-hotfix.5` source repairs:

- Waiting-input, already-active resume and shutdown observation races.
- Late failed command acknowledgements or successful permission replies replacing
  newer native lifecycle state, and legacy child provenance changing root state.
- Missing native send IDs reported as success rather than outcome unknown.
- Child-heavy history starvation via optional `history.native.primary` v1,
  native primary filtering and direction-fenced opaque continuation cursors.

Local exact-toolchain gates pass: typecheck, **716 tests across85 files**,
checkpoint, documentation and release metadata. Primary history has15 deterministic
cases covering ordering, view/direction/cursor fences, expiry, bounded image and
byte transfer, and oversized-page retries without cursor skips. Nine lifecycle
race cases cover late acknowledgements and legacy ownership, in addition to the
existing adapter suites.

A disposable exact CLI1.0.81 / SDK1.0.13 session verified the native primary
backward method and opaque continuation across appends, without model prompts
or production state. Native expiry was not exercised; its failure behavior is
covered against the exact schema with deterministic fixtures. No transport,
protocol version, native pin or migration changed. Consumer UI findings and
installed rollout facts belong to the personal repository. This is a model-free,
unqualified prerelease under the existing owner exception, not a stable or
native-model qualification claim.

Published all16 immutable GitHub prerelease tarballs from signed source
`ea05e78c4f9cc892c1b99b4cd403a3ba17bb0dbe` under
[`hotfix-2026-09-07.5`](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-07.5).
The release retains its source-bound pack manifest, tarballs, checksum inventory
and507-component release-build SBOM. `SHA256SUMS` digest:
`cc5e8b096b834a982433d4b19a9b4bebfa000247cdcd55f28e34dac303717e34`.

All16 isolated packed-consumer checks pass using the exact public p2prpc0.2.1
tarball at the unchanged declared dependency boundary. This uses the prior
public-transport verifier after the known registry token-scope failure; it is
separate from registry-authentication evidence. No `latest` promotion or native
model-credit gate was performed.

## Standalone authority handoff hotfix — 2026-09-07

Published [`hotfix-2026-09-07.7`](https://github.com/arduano/agent-multiplex/releases/tag/hotfix-2026-09-07.7),
version `0.2.4-hotfix.7`, from SSH-signed source
`b2b708b01386b086f52d0c3931e29846fc81b14a` under the existing owner exception.
The 16 exact-toolchain artifacts retain immutable manifests, SHA-256/SHA-512
inventories and the 507-component SBOM. The pack manifest digest is
`26cb1a6bd7a7bd570aac143bf4c892ddf8cc282f6a77f8c779293ae7f8626d1d`.
All published assets were independently downloaded through GitHub CLI and all
16 tarballs passed their released checksum inventory.

Typecheck, production build, **768 tests**, checkpoint, docs, release metadata,
secret scan and all 16 role-isolated packed consumers pass. Final-source
deterministic Docker evidence:

- Tree: `receipts/protocol-v4-control-tree/20260907T140142Z-480c110dbc72/`.
- 10-runtime/100-session scale: `receipts/protocol-v4-mock-docker-scale/20260907T140142Z-579c7b38691c/`.

Earlier `c80f8b0` Docker runs are historical, preceding the final observer fixes.
A direct vitest attempt without regenerated dashboard assets had three HTTP
fixture failures; the final standard `npm test` rebuild passed all 768 tests.
Direct urllib downloads encountered gateway timeouts; GitHub CLI independently
downloaded and verified the complete final public asset set.

Control-only migration 6 records authenticated prior authority, original
attachment admission and atomic first-snapshot receipt admission closure.
Historical results stay immutable and reconcile by their original IDs.
Already-watching root gateways receive imported receipts; session-filtered
streams immediately reset on feed change and discard prior-authority native
replay for explicit history/gap recovery. Undrained metadata, populated attachment
beneath a branch, and formed-subtree transfers fail closed. Root and attaching
controls need this update; runtime storage/native bindings and transport/native
pins are unchanged. Older controls require a stopped-state backup for rollback.

No model prompts, native qualification claim, registry `latest` promotion or
production session mutation were used for qualification. Installed source and
NAS/laptop rollout facts belong to the personal repository.
