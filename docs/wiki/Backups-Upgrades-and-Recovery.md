# Backups, upgrades, and recovery

Back up data according to its owner. A control catalog and a runtime store are
both valid databases, but neither alone represents every external resource
owned by a launch provider.

## Backup units

| Role | Preserve together | What loss means |
| --- | --- | --- |
| Control node | SQLite database, live WAL/SHM when applicable, endpoint identity | Canonical catalog, metadata, authority, topology, operation feed, endpoint pin |
| Runtime node | Entire runtime state directory, SQLite/WAL/SHM, endpoint identity, provider-managed recovery references | Bindings, commands, outbox, launch/archive checkpoints and tombstones |
| Gateway | Gateway SQLite and identity | Source locators, renewed tickets, cursors, health; no canonical domain data |
| Harness/provider | Native auth/config and provider resources under their own backup policy | Native history or external workspace/container state |

Managed PTYs, screen replay, viewers, and keyboard leases are intentionally not
backup data.

## Taking a backup

Use the role catalog/store `backup(destination)` API for a verified online
SQLite backup. It creates and integrity-checks a destination without copying a
changing WAL by hand. If an application does not expose that API operationally,
stop its sole writer cleanly, verify it has exited, and copy the database plus
identity/state unit from explicit paths.

Never copy only a live `.sqlite` file while ignoring its `-wal` file. Do not
reuse one backup as two live nodes; endpoint identity and single-writer state
must remain unique.

Store transport secrets, bearer credentials, provider keys, and auth homes in a
separate secrets backup with narrower access. Raw p2prpc tickets are sensitive
reachability material and should not appear in shareable receipts.

## Restore drill

1. Restore into a new isolated directory and network.
2. Preserve file modes and the role's matching endpoint identity.
3. Start exactly one writer and let startup run application-ID, migration-ledger,
   integrity, and foreign-key checks.
4. Verify logical and endpoint identities before allowing peers to connect.
5. Confirm topology, selected sources, runtime bindings, metadata revisions,
   operation journals, and provider resources.
6. Exercise a read, native-history request, and harmless fresh operation.

Restoring a control database without the pinned control endpoint identity causes
existing runtimes, branches, and gateways to reject the replacement. Restoring a
runtime store without its identity similarly changes the enrolled endpoint.
Restore both or deliberately enroll a replacement and reconcile it as a new
node.

## Upgrades

Migration histories are immutable ordered identities. Never rename, reorder, or
rewrite a released migration. New migrations append a positive version and run
inside the storage engine's transaction. Foreign, unversioned, corrupt, future,
rewritten-ledger, and downgrade stores fail closed.

Before upgrading:

```bash
npm ci --strict-allow-scripts
npm run check:docs
npm run check:release
npm run typecheck
npm test
npm run check:checkpoint
npm run test:docker:v4:tree
npm run test:docker:v4:mock:scale
```

Run the real four-container suite when Codex, Copilot, adapter, native transport,
history, terminal, browser, or authentication behavior changes. For a retained
deployment, use the 930-second live soak described in
[the deployment runbook](../deployment-v4.md) to cross p2prpc authentication
renewal and prove fresh post-renewal commands.

Transport changes are released from `../p2prpc` first. Upgrade the exact
`@arduano/p2prpc-core` dependency and lockfile here only after its own package
and integration checks pass; never substitute a local path in a deployment
candidate.

Codex generated bindings for the pinned binary must regenerate byte-for-byte:

```bash
node_modules/.bin/codex app-server generate-ts --experimental \
  --out packages/adapter-codex/src/generated
```

Do not assume protocol-v4 labels alone make arbitrary old/new builds safe for a
rolling upgrade. Qualify the exact mixed-version sequence or take a coordinated
maintenance window.

## Recovery decisions

### Gateway loss

Recreate the gateway from independently pinned source configuration and let it
resynchronize. Domain data remains at controls/runtimes. Losing the gateway
identity may require access-gateway enrollment to be reopened for the new
endpoint.

### Stale ticket

The endpoint ID is still the trust anchor. Retry a known bootstrap locator or
restore stable direct reachability for that same endpoint; never accept a new
endpoint merely because a ticket dials successfully.

### Runtime loss

Restore the complete runtime unit. Do not delete binding/tombstone state to make
inventory look healthy: that can duplicate a native session or resurrect an
archived one. If the store cannot be restored, treat the replacement as a new
runtime and reconcile old external/provider resources manually.

### Authority loss

Restore the control database and identity first. Promotion of an explicitly
detached branch creates a new realm/epoch; it is disaster recovery, not a
transparent replica election. Any later reunion of divergent realms is an
administrative data merge outside protocol v4.

### `outcomeUnknown`

Freeze automatic retry. Query the existing operation, inspect provider
checkpoints and the external system by immutable resource identity, then either
record/recover the known result through domain tooling or escalate for manual
repair. A new operation ID is not reconciliation.

### Source conflict

Retain both last accepted snapshots and logs, remove the route from mutation
service, and identify the ownership or record fork. Do not clear gateway state
or raise source priority until the authoritative topology and data have been
repaired.
