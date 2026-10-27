# Real Codex two-container acceptance test

> Archived protocol-v2 receipt harness. It depends on the removed worker/host
> build and is not a runnable protocol-v4 target. Commands below are retained
> only as a record of how the historical receipts were produced.

This harness exercises the production Codex adapter through the public
Multiplex API with exactly two application containers:

1. the canonical Multiplex host and dashboard;
2. one Multiplex worker whose child process is the real `codex app-server`.

Playwright runs on the Docker host, so browser capture does not add a third
container. The runner creates a fresh Codex home, starts the worker waiting for
credentials, and then uses `docker cp -a` to copy only a generated minimal
`qualification-provider` config and the explicitly selected provider key into
that running container. It never copies `auth.json`, Codex history, state databases, or the
complete host Codex home.

The worker runs as a non-root user with all Linux capabilities dropped and
`no-new-privileges`. Its seccomp profile is unconfined because Codex's own
`workspace-write` sandbox uses Bubblewrap user namespaces; Docker's default
seccomp profile rejects that namespace syscall before the inner Codex sandbox
can start.

Run it from the repository root:

```bash
npm run test:docker:codex
```

The historical core build context defaults to `../p2prpc/packages/core`.
Provider ID, source configuration and key must be supplied explicitly; there
are no user-home credential defaults. Set these inputs before the command above,
or invoke it with the current interface below. No historical receipt is rerun
or relabeled by this documentation edit:

```bash
AGENT_MULTIPLEX_P2PRPC_CORE=/path/to/p2prpc/packages/core \
AGENT_MULTIPLEX_SOURCE_PROVIDER=selected-provider \
AGENT_MULTIPLEX_CODEX_SOURCE_CONFIG=/path/to/provider-config.toml \
AGENT_MULTIPLEX_CODEX_SOURCE_KEY=/path/to/provider-api-key \
npm run test:docker:codex
```

Receipts are written under `receipts/codex-docker-e2e/<UTC run id>/`. They
include native events, Codex `thread/read` results, exact workspace-file proof,
sanitized logs, two dashboard screenshots, curated topology/version data, and
SHA-256 checksums. The shared fleet secret, P2P ticket, provider endpoint,
provider config, and API key are excluded and checked for accidental leakage.

The generated containers, network, fresh container-local Codex home, copied credential,
workspace, and image tag are removed on exit. Set
`AGENT_MULTIPLEX_E2E_KEEP_IMAGE=1` to retain the image for debugging.
