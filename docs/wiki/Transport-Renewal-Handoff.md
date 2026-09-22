# Authenticated transport renewal handoff

Local review candidate only. No pin, release, production service, native session
or other checkout has been changed. The complete
[design and maintenance plan](../design/p2prpc-renewal-vnext.md) owns the new
contract, deployment matrix, rollout order and rollback constraints.

Build requires `npm ci` followed by `npm run prepare:transport-renewal -- ../p2prpc`.
This reads exact upstream source, applies the tracked patch in this worktree,
produces a checksummed local tarball and installs it without rewriting pins.
The three maintained Docker targets consume that same tarball. Release packaging
is intentionally blocked until independent core publication and exact pin review
are separately authorized.

The candidate keeps short authentication lifetimes and replaces authenticated
generations before expiry while preserving ordered QUIC/RPC/feed streams.
Multiplex domain protocol stays v5; its p2prpc application contract changes to
`5.renewal.1`, using independent core `0.3.0-renewal.0`, wire v5 and handshake v4.
The 16 Multiplex package versions and released dependency pins are unchanged.
All p2prpc services must be updated together, including direct personal
work-command/recovery consumers. Irregular Windows/native stalls remain separate.

Validation and exact commit identities are recorded after final review below.
