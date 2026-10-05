# Pinned native agent task shapes — October 5, 2026

The disposable [native fixture](../../packages/adapter-copilot/test/native-agent-task-shape-smoke.mjs)
creates two simultaneous background tasks through pinned SDK **1.0.14** / CLI
**1.0.88**. Its provider is a synthetic loopback HTTP server returning 503;
logged-in authentication is disabled and known credential variables are removed.
There is no root prompt, real model call, installed state write or owner-session
attachment. Both active native snapshots pass unchanged strict task admission,
and both exact task cancellations acknowledge. Native tool execution is confined
to this fixture; it is not exposed by the production adapter.

This rules out a universal rejection of these simple pinned native agent shapes.
It does **not** reproduce the lost Tariff snapshot, establish its malformed field,
or qualify actual Luna work, native children/history streaming or corporate auth.
The fixture records source and executable digests, native pins, local request
count and checksummed receipts under `receipts/copilot-native-agent-shape/`.

After the dependency build:

```bash
node --import tsx packages/adapter-copilot/test/native-agent-task-shape-smoke.mjs
```

On NixOS, set `AGENT_MULTIPLEX_TEST_COPILOT_CLI` to an immutable
interpreter-patched copy of that exact CLI. The script checks its adjacent package
version and records executable SHA-256. Use a disposable `TMPDIR`; do not change
installed binaries or authentication homes. For native Windows, use a new
protected TEMP/TMP directory to satisfy the unchanged private-state guards.

The initial Linux raw npm executable failed at the NixOS ELF interpreter boundary,
before attachment. A preliminary fixture also attempted an unexported SDK
`package.json` subpath; corrected file-based version admission passed. Those
preparation failures are retained separately. The successful native probe uses
the immutable Nix CLI and synthetic local provider only.
