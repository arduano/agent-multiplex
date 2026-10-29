# Agent Multiplex

A public framework for native coding-agent Hosts, authenticated gateways and
retained clients. Accounts, machine topology and business workflows belong to
consuming applications. This reconstruction has no private-repository dependency.

Read the [numbered review stack](docs/stack/README.md) first. Every PR adds one
coherent ownership layer; intermediate stages are explicitly incomplete. The
stack is not a deployment or a migration of an existing installation.

## Development

Node24.19.0 and npm11.17.0 are pinned. Install with `npm ci --ignore-scripts`, then
run `npm run check`. There is one active source/test graph. Builds replace their
owned generated directory; tests use disposable state. Normal commands never
open native agents, providers, installed state or services.

The package uses explicit browser/Node subpath exports. Only implemented exports
are declared. `src/protocol` contains browser-safe logical identity contracts;
later PRs add each independent owner and its public entry. Production builders
live in `scripts/`; tests live in `test/`; generated output is not authored source.

## Current boundary

PR02 supplies tooling and logical scope identity only. It does not implement a
session, native adapter, transport, client or UI yet. The following layers are
tracked in the [stack index](docs/stack/README.md), with per-layer evidence and
explicit limitations. Passing this checkpoint is not full-framework readiness.

Scripts use pinned `tsx` and `cmd-ts`; `npm run check` also runs Prettier and ESLint.

Follow [module boundaries](docs/stack/Modularity.md). Non-JSX code and scripts use `.ts`, executed by `tsx`; `.tsx` is reserved for actual JSX.
