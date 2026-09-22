# Independent core review candidate

`p2prpc-renewal.patch` contains the complete implementation, tests and upstream
documentation against the exact commit in `manifest.json`. It is MIT-licensed
upstream work, staged here to obey the owner's restriction against editing any
other checkout or updating dependency pins.

From the Multiplex repository root:

```bash
npm ci
npm run prepare:transport-renewal -- ../p2prpc
```

The source checkout is read-only input. The command creates a fresh isolated
source copy under `receipts/p2prpc-renewal`, applies the patch, installs build
prerequisites, builds/packs the independent package, and overlays its files in
this worktree's `node_modules`. It retains npm's nested dependencies and verifies
the patch, artifact digest and exported contract. Re-run
`npm run install:transport-renewal` after a later `npm ci` if the verified local
artifact is already available. No package publication or Git operation on the
upstream checkout occurs.

The generated `p2prpc-core.tgz` and `artifact.json` are ignored local artifacts.
The maintained Docker targets require them and use the same verified candidate.
Normal release packaging is blocked. Future independent core publication and
exact pin changes require separate authorization and repeat qualification; the
local overlay is not a release dependency or production startup mechanism.

Linux source CI, Docker qualification and Windows startup workflows prepare
the exact upstream source under `receipts/upstream-p2prpc`. Private source access
requires a read-only `P2PRPC_SOURCE_READ_TOKEN`; the default workflow token is
sufficient only when that repository is readable with it. Candidate CI skips
release packing, release SBOM/upload and the optional external personal-consumer
composition. Native release-status recording also rejects this unpinned graph.
These workflows were syntax-validated locally; Windows execution and hosted
workflow execution are separate qualification steps.

See the [design](../docs/design/p2prpc-renewal-vnext.md) and
[handoff](../docs/wiki/Transport-Renewal-Handoff.md).
