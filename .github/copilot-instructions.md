# GitHub Copilot instructions

This repository maintains Agent Multiplex protocol v5. Read
`docs/wiki/Current-State.md` first, then the role-specific topical guide and
deep design before editing. `docs/wiki/Home.md` is the documentation index and
`docs/checkpoint-v4.md` is the release-evidence ledger.

- Active roles are control node, runtime node, access gateway, client, and
  harness adapter. `apps/host` and `packages/host-core` are archived v2 evidence;
  never import or repair them.
- Session creation is `launches.create` with an exact profile/provider/schema
  fence. There is no v5 `sessions.spawn` network API.
- Control nodes alone own canonical catalog state and namespaced flat JSON
  metadata. Runtimes own native bindings/processes. Gateways have zero authority
  and cannot be chained.
- Control topology is a tree. Disconnect does not promote a branch. Authority,
  identity, binding, and overlap conflicts fail closed.
- Stop preserves a resumable session; archive is a separate durable cleanup
  operation. Never infer archive from age, offline status, or inventory absence.
- Treat `outcomeUnknown` as possibly committed. Reconcile the same stable
  operation ID; never issue a blind replacement request.
- Preserve Codex and Copilot native model, mode, command, interaction, event, and
  history shapes. Never parse vendor history files or terminal scrollback.
- Domain launch workflows belong in a statically composed gateway plugin plus
  runtime provider/backend. Credentials and provider checkpoints stay runtime
  local and never enter launch input or metadata.
- Do not hand-edit `packages/adapter-codex/src/generated`; regenerate it from the
  exact pinned CLI.
- Append SQLite migrations; never rename, reorder, or rewrite released entries.
- Never add secrets, raw tickets, auth homes, terminal lease data, provider
  endpoints/keys, or bearer-bearing URLs to code, tests, logs, or receipts.

Use `rg` for discovery and make focused changes. Run the closest tests, then
`npm run typecheck`, `npm test`, and `npm run check:checkpoint`. Native/Docker
qualification is required for affected release boundaries; real Codex/Copilot
runs require explicit authorization for model-credit use.
