# Disconnected archive search acceptance — October 5, 2026

## Result and source boundary

The B1 disconnected-archive follow-up is already implemented and published.
Independent disposable acceptance passes the existing complete-page contract;
no behavior correction, schema change or extra deployment is required for this
boundary. This is artifact acceptance, not a live-fleet disconnection exercise.

Original change `14de05f` was cherry-picked as
`ab9114133f2142cd50fb4cc3e45a95b156a78d8d` before immutable `.29`. The seven
changed files are identical between those commits; the original commit itself
is not a Git ancestor of `.30`. Qualified source is
`1dd9ae1bfdef07af4ce931afd0284829bb4400e3`, lockstep `.30`.

The exact retained NAS `.29` package used for installed-byte acceptance is:

```text
/nix/store/f59mihz3n3p6rflmk27r3z5qs1swbbv7-leo-multiplex-v6-0.1.0
```

All six relevant compiled modules are byte-identical between that package and
qualified `.30` source: control `cold-search-reads.js`, `service.js`, `router.js`;
Gateway `projection.js`; source-client `control-node-source.js`; Gateway access
`router.js`. Other `.30` changes and native acceptance remain separate work.

## Disposable acceptance

Three private disposable control catalogs contain a Root-owned hot row and
three archived rows owned by Root and its two attached children. Searches use
the exact installed packages, real relayless local Iroh for source queries and
the actual loopback Gateway HTTP router/client for browser-facing responses.
Only the selected local fixture interface is admitted; discovery/relays are
disabled. No fleet peer, private installed state, provider or model is used.

Eight acceptance checks pass:

1. Complete archives include the Root and both child rows, preserving exact
   native identity, binding/provenance and Root metadata authority.
2. Disconnecting a required child returns HTTP **503 / SERVICE_UNAVAILABLE**
   in **7 ms**, without a successful empty or partial page.
3. Runtime-scoped Root and reachable-sibling archive searches remain successful.
4. Default hot search still serves the Root row while a cold branch is offline.
5. Reconnecting the exact child plus its normal heartbeat restores all archives.
6. Two simultaneous Gateway reads share one hanging child request. Both fail
   with typed unavailable after **15,016 / 15,019 ms**.
7. Repeating that query after expiry returns unavailable in **15 ms** without
   another child dispatch. A late empty reply cannot become success; a fresh
   exact connection restores the complete page.
8. Root authority, original archive receipt, child-owned archived catalog row
   and absence of cold child rows in the Root hot catalog are unchanged.

Source regressions separately pass **20 tests / 3 files** covering disconnected
and stale branches, cancellation, retained capacity across query/connection
generations, late replies, replaced connections, sibling merge barriers,
pre-attachment archives, pagination/provenance and typed source errors. Focused
control/Gateway/source-client compilation passes.

```bash
TMPDIR=/dev/shm/disconnected-archive-20261005 npm exec vitest -- run \
  packages/control-node-core/test/cold-search-reads.test.ts \
  packages/control-node-core/test/recursive-v4.test.ts \
  packages/client-p2prpc/test/control-node-source.test.ts --maxWorkers=1
npm exec tsc -- -b packages/control-node-core packages/gateway-core \
  packages/client-p2prpc apps/gateway --pretty false
```

Leo's ordinary session catalog explicitly queries `running`/`stopped`, which
does not traverse cold archives. Its existing pagination helper rejects a
failed later page instead of committing an authoritative partial list. No UI
archive-search bypass, silent branch omission or new partial-result API is
needed.

## Retained evidence and limits

Private receipts remain under
`receipts/disconnected-archive-20261005` in the isolated qualification worktree.

| Evidence | SHA-256 |
| --- | --- |
| Installed eight-check result | `6d25e82598b677cee30e007cf5bd9902bcb949fb6e5c16a3fd5a1e5fea98df6a` |
| Focused source test log | `1b58ab2a4d162735c3395fc5733d53b6bc733a40736e668c9d2730a50dba8ff0` |
| Installed fixture script | `c7041bdd97b4a69b7ec2819cb4451522e3ccf15f070628344f19bcc098114d2c` |
| Six-module equivalence | `bc4185abb87a60911394f80045cfec1dabd5b732bf556cf7c8755cdda63c08bb` |

Two failed preparations remain explicit. The first incorrectly placed a normal
HTTP client into the P2P-only source adapter; its noncanonical error envelope
was rejected as INTERNAL. Real Iroh replaced that invalid fixture boundary.
The second reconnected a snapshot without the normal heartbeat, correctly
leaving the child stale/unavailable. Adding that fixture heartbeat restored
the intended online connection. No error-envelope validation or presence check
was weakened to make either attempt pass.

No live service, session, enrollment, task, ACL or model action occurred. No
real p510 outage was induced. The independent source/package checks qualify
the same installed-byte failure boundary without claiming fleet network or
maintenance acceptance. Global archives intentionally require all selected
branches; operators needing results during an outage can apply the supported
runtime filter to reachable branches.
