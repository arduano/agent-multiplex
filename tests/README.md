# Test boundaries

Vitest runs current protocol-v4 tests from this directory and the active
packages. The individually named root `host-*.test.ts` files, `e2e.test.ts`,
and everything under `packages/host-core` are archived protocol-v2 tests and
are deliberately excluded in `vitest.config.ts`. The root test exclusions are
an exact allowlist rather than a wildcard so a future maintained test whose
name starts with `host-` cannot silently fall outside the release suite.

Archived tests retain their historical package-scope imports. They are evidence
for the matching archived source, not consumers of the published
`@arduano/agent-multiplex-*` graph.

Maintained Docker acceptance suites are `docker-mock-scale`, `docker-v3-tree`,
and `docker-live-four-container`. Older Docker suites that launch
`apps/host/dist/main.js` are retained as evidence only; they are not supported
v4 targets or exposed as root npm scripts.

`docker-v3-tree` retains its historical directory name for path compatibility;
the maintained suite and its default receipt namespace both use protocol v4.
