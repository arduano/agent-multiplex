# Same-parent bootstrap fallback hotfix.35 — October 6, 2026

## Source scope and fences

Lockstep `0.2.4-hotfix.35` is based on reviewed implementation
`0f6a1ab0c9df41175fd39dd8fbb7347b6119321d` and retains
[hotfix.34 startup containment](hotfix34-startup-containment-20261006.md).
The reference control supervisor snapshots its configured startup bootstrap
and tries the durable selected locator first. A failed dial permits bootstrap
fallback only when both logical parent and pinned endpoint match the durable
selection and the locator differs. Successful fallback dialing alone never
persists a locator or selects a parent.

After asynchronous dial, attachment and heartbeat, the supervisor rechecks
the durable selection. Explicit detach, cleared selection or an identity change
cancels the attempt; a newer same-parent locator restarts the durable dial.
Only an accepted authenticated heartbeat may renew the durable locator, using
the same-identity and exact-locator comparison fence. Saved attachment, boot,
authority, metadata and replay checks remain unchanged.

Regression coverage includes primary success, accepted fallback renewal,
identity mismatch, rejected attachment, failed fallback, concurrent detach and
locator changes at dial/attach/heartbeat, cleared selection, restart preference
and same-parent replacement during an established connection. The maintained
[architecture](../wiki/Architecture-and-Data-Roles.md) and
[data-role design](../design/data-roles-v4.md) record the behavior.

Transport, native SDK/CLI, wire and durable schema versions are unchanged from
the reviewed base. This is reachability fallback for an already-selected parent;
it adds no live reparent operation or implicit configuration rewrite. Migration11
rollback requirements and unresolved Copilot interaction uncertainty remain as
documented for `.34`.

## Exact source qualification

The combined `.35` source and exact published dependency boundary pass:

- `npm run typecheck`.
- `npm test -- --maxWorkers=1`: **1,514 passing tests / 140 passing files**, with
  eight tests and one file skipped. Its pretest performs the full release build.
- `npm run check:checkpoint`, `npm run check:docs`, `npm run check:release` and
  `npm run check:secrets`.

The full suite uses unchanged timeouts and fresh process-only mode0700
`/dev/shm/lr35._6m_gij6`; that fixture namespace was removed after success.
Node is `24.19.0`, npm `11.17.0`. The protected ignored receipt is
`receipts/hotfix35-release-2bd1a04811604bfea06d48c51a10819c/`, with per-command
stdout/stderr, elapsed times and the completed source summary. The test stdout
filename is `02---.stdout.log` because the runner retained the `--` argument as
its command label.

An earlier producer full run passed1,511 tests/139 files but failed three Codex
runtime cases in one file, with eight tests/one file skipped. Its overlong
protected `TMPDIR` exceeded Unix `sun_path` and produced `listen EINVAL`.
Physical `/tmp` runs also retained latency failures and a missing fixture-native
node-pty import; a direct native rebuild repaired only that fixture worktree.
Those failed receipts are diagnostic evidence. The later successful short-path
run is separate evidence and does not relabel the earlier failures or increase
timeouts.

## Packed artifacts and independent consumers

Clean artifact source `47f3b7ee416541dced114f46509f84172ce40c21` produces all
**16** lockstep `.35` tarballs. `sha256sum -c SHA256SUMS` passes for the complete
set. All16 role-isolated consumers pass declaration/import/browser/CLI surfaces,
publint/ATTW and the reviewed exact Iroh/Koffi dependency boundary. SBOM generation
passes with498 components, all16 released packages and125 web-bundled identities.
Packing, verification and SBOM run sequentially without concurrent rebuilding.

Stock `npm run release:verify` first fails with transport registry E401. Its
original stdout/stderr remain in the ignored receipt. The unchanged reviewed
published-transport verifier then passes using independent
`@arduano/p2prpc-core@0.3.0-renewal.1` at its exact public release URL and locked
SRI; product dependencies and registry policy do not change. That verifier's
SHA-256 is `31b2593ffd60b1f91da78f027e826da29dc945e3f1b4ef21ae5925e944f985af`.

| Evidence | SHA-256 |
| --- | --- |
| `SHA256SUMS` | `c2f9b06d393b07bbd6fe27a7912d9d326d7d5c73cde7976134f4e836a0cfedd1` |
| `pack-manifest.json` | `bf257ff73af2b3c2204ea0ff6cc4c02de8b7633a2bca710c8d4370fd81118b0c` |
| `sbom.cdx.json` | `e750ee31f9bd305c06a6a21fa5ad025c9de0d35a0aba7e90639c3d8abdfc5113` |

This qualification documentation follows in a separate commit; the exact
artifact source and packed bytes stay unchanged. Artifacts remain in this
release worktree's ignored `release-artifacts/`; the source and package gate
receipt remains in the protected ignored namespace recorded above.

## Deterministic Docker qualification

The required tree and mock-scale gates pass with the original workloads,
timeouts and assertions. Source archive `47f3b7ee416541dced114f46509f84172ce40c21`
is exported to a separate protected disposable copy. Independent review compares
all1,447 committed files and finds only an eight-line central transport creation
fence: `relay: { mode: "disabled" }`, `discovery: { dns: false, mdns: false }`
and `allowRelayUrl: () => false`. Identity, security, direct/bind policy, routing,
protocol and all workload inputs remain unchanged. All maintained role creation
paths used by these suites reach that wrapper.

Stock suites use default public Iroh relay behavior without a relay override;
they were not run. The approved variant qualifies direct-only deterministic mock
topology/scale and introduces no producer default, source release, package or
installed policy change. Neither image requires a lock resolved-URL overlay:
the tracked credential-free npmrc and unchanged exact dependency graph build
successfully. Browser capture uses `/run/current-system/sw/bin/chromium`.

- `npm run test:docker:v4:tree` passes in136,153ms, including routing, retained
  identity/authority recovery, metadata, streams, immutable images, browser and
  local CLI image checks. Run: `direct35-tree-ed529e686d9848c6`.
- `npm run test:docker:v4:mock:scale` passes in105,009ms: one control, one gateway,
  ten mock runtimes with ten sessions each, all100 overlapping sends, reconnect,
  history, stream replay, resource and accessibility checks. Run:
  `direct35-scale-886d8bdba2f04ec6`.

Both successful manifests/checks and exact-owned cleanup records pass;
independent `sha256sum -c SHA256SUMS` passes. Each runner removes only its owned
containers, bridge, image tag and temporary state. The extra wrapper's fresh
protected `/dev/shm/d35.*` namespaces are removed after completion. The ignored
receipt is `receipts/hotfix35-direct-docker-f530b3053fb04fed89dd820a1d7efe02/`;
it retains the source archive, exact patch, independent review, source/context
digests and separate successful tree/scale receipts.

| Evidence | SHA-256 |
| --- | --- |
| Source47f3b7 archive | `59fec29fca6144bf0648599467a3bcd8020c04e19965e9096647cecfa5617a23` |
| Fixture-only policy patch | `6df9277a3c4f1e7775cea3a9e86b16cd4b4b4eb2fc0494e12133b115b2819b22` |
| Tracked fixture context | `4c27f27ff581a53c47a23ac7f5fbd117b68d0ec19baa2511bf4883fe419d3a3b` |
| Successful tree manifest | `cf5c67f5abcea6af4efe4571ba50997f268aca8310108344c2d4fb111f579dc5` |
| Successful tree `SHA256SUMS` | `6ff562ac30958ff1a5e0bda2200709747b865b872b329c12211c545510c72c11` |
| Successful scale manifest | `b562593b8579d35ac5d985918b39cedfcedea389f27a54e56f002d920d33ba91` |
| Successful scale `SHA256SUMS` | `019565d2ffac8fc5944250d526af362f9ec1b869bd1bd3627d0b261a0e507abb` |

The first tree run, `direct35-tree-e4ddf6e1aa8a44ca`, fails after the image,
transport, main topology summary and browser phases because the Git-export
fixture lacks `apps/cli/dist/main.js` for the final local CLI image probe.
Its failure remains retained, and its exact-owned containers/network/image are
independently confirmed absent. Building only the disposable fixture succeeds
in16,047ms; all committed files still differ only by the reviewed transport fence.
A fresh tree receipt then passes the unchanged assertions. This preparation
failure is not relabeled as transport success or a product regression.

## Remaining acceptance

These direct-only mock receipts do not establish custom-private-relay migration,
native model behavior or installed Windows/WSL acceptance. Those remain
consumer-owned and require their own exact-source evidence.

Publication, tag creation, push, npm stable promotion and native installation
belong to the release owner.
Read-only tag inspection found no `hotfix-2026-10-06.2` tag; this source pass did
not create one. No production service stop, policy/VPN change, owner-session
operation or model call occurred. Native private-relay migration and installed
Windows/WSL acceptance remain consumer-owned.
