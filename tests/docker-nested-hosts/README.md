# Nested-host Docker acceptance

> Archived protocol-v2 receipt harness. It depends on the removed worker/host
> build and is not a runnable protocol-v4 target. Commands below are retained
> only as a record of how the historical receipts were produced.

This deterministic acceptance suite exercises protocol v2 as a real p2prpc
tree, not as in-process service objects:

```text
root
├── aggregate A
│   ├── leaf A1 ── 4 workers × 10 sessions
│   └── 2 direct workers × 10 sessions
└── aggregate B ── 4 direct workers × 10 sessions

root ── observer gateway 1
     └─ observer gateway 2
```

The 16 application containers are four hosts, ten workers, and two standalone
HTTP/WebSocket gateways on one physical Docker host. Both gateways enroll as
independent p2prpc observers. This proves recursive routing across isolated
process/container boundaries, not cross-machine networking.
Workers use the deterministic Codex-shaped mock adapter: the run starts no real
agent process, uses no provider credential, and makes no inference request.

Run from the repository root:

```sh
npm run test:docker:nested
```

The suite proves:

- the root materializes the exact four-host tree, all ten workers, and 100
  sessions while hosts own direct workers and child hosts simultaneously;
- root-to-leaf model lookup, spawn, commands, settings, interrupt, native
  streaming, and opaque native-history calls cross two host links;
- 100 overlapping mock turns arrive without native gaps, duplicate event keys,
  or transcript corruption;
- client-side metadata is committed at the root, while a leaf-originated write
  is first durably queued and later converges through the root authority;
- disconnecting aggregate A changes reachability but preserves parentage,
  attachment, lineage, native IDs, logical IDs, and cached sessions; reconnect
  restores routing without reparenting or promotion;
- two separately enrolled observers see the same fleet, and the dashboard
  renders the complete tree through a standalone gateway;
- containers stay alive without restarts/OOM kills and are resource sampled.

Receipts are written to `receipts/nested-docker/<run-id>/`. They include JSON
assertions, topology snapshots, native event logs, sanitized per-container logs,
Playwright screenshots, resource samples, lifecycle records, source/build-context
digests, cleanup evidence, and SHA-256 sums.
Enrollment tickets and the shared transport secret are never written to the
receipt tree; a final content scan enforces that rule.

The screenshot step needs Playwright and a Chromium-compatible executable on the
Docker host. The defaults match this development machine; portable runners must
set `AGENT_MULTIPLEX_PLAYWRIGHT_MODULE` (an importable module name or absolute
module path) and `AGENT_MULTIPLEX_CHROME_EXECUTABLE` (an executable path). Both
are validated before the Docker image is built.

Useful timing knobs are `AGENT_MULTIPLEX_NESTED_TIMEOUT_MS`,
`AGENT_MULTIPLEX_NESTED_SOAK_MS`, `AGENT_MULTIPLEX_MOCK_CHUNK_COUNT`, and
`AGENT_MULTIPLEX_MOCK_CHUNK_INTERVAL_MS`. A configured mock turn must last at
least two seconds and leave at least 1.5 seconds after its third chunk so the
two-link interruption assertion cannot race a naturally completed turn.
Defaults are the acceptance target: ten workers, ten sessions each, and 100
streamed turns. The dedicated bridge permits external egress for Iroh relay
discovery; it is not an air-gapped network.
