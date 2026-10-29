# Agent Multiplex

This is the public framework reconstruction stack. Start with `README.md` and
`docs/stack/README.md`. The previous implementation is a read-only design and
behavior reference, not a compatibility requirement or build input.

- Work only in this stack's isolated checkout. Preserve all existing branches,
  installed services, native homes and sessions, and other repositories.
- Keep the framework independent of private applications and sibling checkouts.
  Use the declared package entry points at module and consumer boundaries.
- One owner per session, native lifetime, original operation, catalog and
  retained client entry. Observation cancellation never cancels an admitted
  effect; disconnect, idle and missing evidence never prove Stop or completion.
- Admit an original durably before dispatch. Reconcile its exact identity;
  never retry or replay a mutation merely to recover its outcome.
- Native history belongs to the native API. Do not parse vendor history files,
  invent completion from text or use terminal scrollback as transcript truth.
- Lifecycle/workspace policy is an explicit static plugin. Harnesses own their
  actual native differences. Definitions/imports/render/reconnect remain inert.
- Keep browser exports free of Node/storage/native code and private inputs.
  Trusted profiles, credentials and mutable state remain outside build outputs.
- New managed Codex defaults are full access/on-request. Explicit provider,
  permission and real confirmation policies remain authoritative; no fallback
  to a different provider or billable model is implicit.
- No model/native-agent qualification without a finite applicable allowance.
  Normal checks use scripted adapters, captured fixtures and disposable state.
- Follow [module boundaries](docs/stack/Modularity.md). Keep self-contained
  business logic and platform machinery in interface-strict
  modules. The module owns its internals, dependencies and decisive tests; callers
  use its public contract. Split an independent package when that adds a real
  dependency/consumption boundary, rather than adding packaging for each helper.
- Test unique invariants at the real owner. Keep an explicit replacement or
  retirement record for earlier coverage. Do not weaken an oracle to get green.
- Keep each PR coherent and buildable. Record contract, edge cases, exact checks
  and limits in its numbered review note. The coordinator alone commits,
  publishes and restacks the numbered branches. Never merge or deploy the stack.
- Author non-JSX code and scripts as `.ts`, executed with `tsx`; reserve `.tsx`
  for files containing JSX. Use `cmd-ts` for every
  command-line entrypoint. Do not add authored JavaScript/MJS scripts or manual
  argument parsers. Normal compiled JavaScript and vendor artifacts remain outputs.
- Use actual tRPC routers and clients across HTTP and p2prpc. Derive generic
  type-only contracts from tRPC types; do not create a second path/type/JSON RPC
  protocol. Routing/authentication metadata stays outside procedure input.
- Configure official tRPC clients and links directly in application composition.
  Do not add generic client factories, router reconstruction or copied upstream
  option types. Test Multiplex ownership and behavior; retire tests whose only
  subject was a removed wrapper or behavior already owned by a dependency.
- Use Zod for structured boundary validation and infer types from schemas. Keep
  ownership, state transitions and other domain decisions explicit; do not hand-roll
  repeated shape/type/key decoders or create a competing validation framework.
- Prettier owns formatting, and ESLint owns correctness checks. Keep both clean
  through `npm run check`; use `npm run format` and `npm run lint:fix` while editing.

Run `npm run check` for a stable checkpoint. Browser/native qualifications have
separate named commands and evidence; a source build is not native proof.
