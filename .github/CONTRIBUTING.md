# Contributing

Thank you for helping improve Agent Multiplex. The project is currently a
protocol-v4 internal/personal control plane with experimental upstream harness
boundaries, so small changes with explicit invariants and evidence are preferred.

## Before proposing a change

Read the [wiki home](../docs/wiki/Home.md),
[protocol-v4 checkpoint](../docs/checkpoint-v4.md), and the relevant deep design.
Open a design issue before changing the wire protocol, data authority, topology,
persistence format, plugin trust boundary, or public package graph.

Security reports must follow [SECURITY.md](../SECURITY.md), not a public issue.
Scrub tickets, tokens, transcripts, private source, terminal output, auth homes,
endpoint details, and provider configuration from examples and logs.

## Development setup

Node.js 24 and authenticated read access to the `@arduano` GitHub Packages
scope are required. Configure `NODE_AUTH_TOKEN` through your user npm config or
secret manager; never put a token in the repository. The token needs
`read:packages` for installation.

```bash
npm ci --strict-allow-scripts
npm run check:docs
npm run check:release
npm run typecheck
npm test
npm run check:checkpoint
```

The exact `@arduano/p2prpc-core` version is the normal dependency boundary. Use
the sibling `../p2prpc` checkout only when developing that package, qualify and
release it independently, then update the exact registry dependency here.

Do not add archived `apps/host` or `packages/host-core` back to workspaces.

## Pull requests

- Keep one coherent behavior or documentation change per PR.
- Add regression tests at the owning layer and an end-to-end test when a route
  crosses roles.
- Explain authority, persistence, migration, compatibility, recovery, and secret
  handling impacts.
- Update wiki/design/security/license material when the boundary changes.
- Never rewrite a released SQLite migration or hand-edit generated Codex types.
- Preserve harness-native behavior and native-history ownership.
- Record focused and full checks. Do not cite failed or stale Docker receipts as
  qualification.

Real Codex/Copilot tests spend model credits and may touch local auth state; run
them only in the isolated documented harness with explicit authorization.

By contributing, you agree that your contribution is provided under the
repository's [MIT License](../LICENSE) and that third-party material remains
under its original terms.
