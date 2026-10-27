# Typed static Host composition

One selected harness and one lifecycle plugin are mandatory. `defineHost` is
inert. `activateHost` opens the selected lifecycle owner, builds its actual tRPC
router and installs keyed extensions. The kernel never performs native lifecycle
operations. Definitions, records and capabilities are validated before the Host
is published. All returned extension owners transfer before any key is validated.
Rejected composition closes only quiescent owners, in dependency order. If
cleanup cannot be proved, `HostActivationError.recoveryFor(definition)` retains
the actual typed lifecycle session owner, remaining extensions and readiness/
close capability for that exact static definition. It publishes no incomplete
Host and performs no automatic Stop. Successful cleanup progress is retained;
an unknown close failure stays unsafe and is never automatically replayed.

A lifecycle `open` or extension factory owns partial resources until it returns
them. If it throws before that handoff, it must preserve or clean up those
resources itself. The kernel cannot discover an unreturned owner or manufacture
native recovery authority from a route, manifest or process name.

`hostRouter`/`hostProcedure` preserve native tRPC inference. `PublicHostContract`
projects creation input, public Host/session schemas, extension schemas and the
composed router as a type-only browser contract. Private configuration and
durable checkpoints have no automatic public projection. JSON DTO validation
belongs to the declared procedure schemas; binary resources retain FilePort.

The deployment verifies forwarding proof in `activateHost(...).context(call)`.
Verified connection/principal, authority, Host, durable owner, route epoch and
optional exact session generation must agree. Expected contract/composition are
public identities, never hashes of private configuration. Procedures require
read/control respectively and enforce any finer domain permission themselves.

`originalMutation` supplies typed submit/original procedures over an existing
owner. It supplies no journal, retry, reconciliation policy or duplicate effect
owner. `updateHost` requires positive lifecycle/domain quiescence, closes the old
owner and activates the new static composition. No automatic Resume is invoked.
Every extension explicitly supplies readiness/close, including stateless noops.
Close seals Host procedure admission and refuses already-admitted calls. Old
contexts cannot authorize new procedures. Extension owners close before their
lifecycle dependency; each owner must seal its non-RPC admission and recheck
actual custody. A failed partial close stays failed and blocks update; a later
call cannot silently reinterpret failure as successful cleanup.

Run `npm test` here for focused schema/type/ownership checks. These scripted
checks prove composition and actual in-process tRPC dispatch; the integration
owner qualifies the authenticated Gateway, retained React and pinned transport
path. They do not qualify native hosts, models, deployment or power loss.
