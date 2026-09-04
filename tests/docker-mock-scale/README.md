# Protocol-v4 mock Docker scale acceptance

This deterministic suite runs the production protocol-v4 process boundaries:

```text
10 runtime-node containers (10 mock sessions each)
                    │ p2prpc
                    ▼
     hidden authority control-node container
                    │ p2prpc
                    ▼
 authenticated zero-authority access-gateway container
                    │ HTTP/WebSocket on host loopback
                    ▼
              driver + browser
```

The control node's trusted-local HTTP server remains inside its container and
is never published. The only host-facing port belongs to the access gateway,
which requires a fresh per-run bearer token. No real model, Codex process,
provider credential, or inference request is used.

Run from the repository root:

```sh
npm run test:docker:v4:mock:scale
```

The default run proves more than a point-in-time catalog count:

- one canonical authority, one selected gateway source, exactly 10 online
  runtime-node containers, and exactly 10 active sessions per runtime node;
- 100 concurrent successful sends and native mock turns, with full-fleet
  overlap measured from source-emission timestamps so intentional observer
  reconnect/replay cannot distort the concurrency proof;
- one-second inventory polling throughout the workload, with unchanged
  generations deduplicated so polling cannot flood the canonical feed;
- exact per-session delta reconstruction, event order, runtime identity, and
  contiguous sequence numbers, with no gaps or duplicate deliveries;
- application-cursor recovery after deliberately terminating the access-watch
  test client's WebSocket;
- runtime-node event-ring replay after one runtime node is removed from the Docker network
  during streaming and then reattached;
- launch metadata plus three canonical compare-and-set metadata rounds, including
  a deliberately rejected stale write;
- a short stability soak, repeated Docker CPU/memory/PID/network samples, OOM
  checks, and a dashboard acceptance that keeps Fleet independently reachable,
  verifies fixed-height session rows, exercises search and selection, rejects
  horizontal overflow and serious/critical axe findings, then captures a
  screenshot, sanitized logs, topology proof, and cleanup;
- SHA-256 checksums for every receipt artifact.

Receipts are written under `receipts/protocol-v4-mock-docker-scale/<run-id>/`.
The bearer token, shared transport secret, and exact reachability locator are
excluded from the receipt tree and checked by a final content scan. The defaults
are the acceptance target. `AGENT_MULTIPLEX_SCALE_TIMEOUT_MS`,
`AGENT_MULTIPLEX_SCALE_SOAK_MS`, `AGENT_MULTIPLEX_RUNTIME_NODE_MOCK_CHUNK_COUNT`, and
`AGENT_MULTIPLEX_SCALE_CHUNK_INTERVAL_MS` tune timing without changing the
10-by-10 topology.

This is a deterministic capacity/integration receipt, not a production load
limit. Passing establishes that the protocol-v4 control-node catalog,
authenticated gateway projection, p2prpc fan-in, stream cursors, and reference
dashboard survive this 100-session workload on the tested machine. It does not
establish the resource cost of 100 real app-server processes or an unlimited
fleet size.
