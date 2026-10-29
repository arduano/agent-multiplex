# 13 — Gateway route leases and topology

`Gateway<Transport>` owns authenticated Host registrations, viewer grants and
route leases. A registration contains `{route, manifest, transport}`: the
transport is a borrowed capability, not a reconstructed router or native owner.
`registerHost` retains heartbeat/disconnect identity; replacing a registration
revokes leases of that exact registration. An old disconnect cannot hide the
replacement. Online/stale/offline never proves native idle, Stop or completion.

`acquire(viewer, target)` checks authority, Host owner, route epoch, contract and
composition, Host access and nonempty grants. It returns the exact borrowed
transport, immutable viewer/target metadata, a revocation signal and `release()`.
Registration metadata and the capability reference are captured at admission;
mutating the caller's registration object cannot replace a borrowed transport.
`maxRequests` bounds outstanding channel leases, including opening and cleanup.

A route lease stays charged until its actual channel resources close. Aborting a
lease is observation revocation, not cleanup proof or cancellation of an admitted
native effect. `Gateway.close` seals admission, revokes channels and waits for
releases. A transport adapter must retain a failed closure proof rather than
release its reservation. The Gateway owns no RPC frames, file ledgers, agent
state, catalog, callback policy or mutation retry.

`gatewayRouter` and `gatewayHttpHandler` expose authenticated topology and any
explicitly composed Gateway-local custom router at `/trpc`. The official tRPC
Fetch adapter owns protocol/error framing. The thin
boundary enforces mounting, same-origin admission, explicit authentication,
bounded request bytes and no-store responses. A `target` URL is selection metadata
for Gateway-local procedures; it never selects a remote Host router through HTTP.
Layer14 admits WSS channels using the same route lease.

## Creation-associated custom routes

`gatewayTRPC` is the actual shared tRPC builder. `gatewayProcedure` requires the
authenticated viewer's read/control grant. `gatewayHostMiddleware(identity)`
also binds a procedure to an exact registered Host, route/composition and its
declared Gateway customization ID/version. Its `ctx.host.target` and revocation
signal come from a borrowed route lease. Use ordinary tRPC composition:

```ts
const identity = { id: "work.vm-gateway", version: 1 };
const scoped = gatewayTRPC.procedure.use(gatewayHostMiddleware(identity));
const custom = gatewayTRPC.router({
  allocate: scoped
    .input(workspaceInput)
    .mutation(({ ctx, input }) => vm.allocate(ctx.host.target.route.host, input)),
});
const contract: GatewayContract<typeof custom> = identity;
const definition = defineHost({ ...hostDefinition, gateway: contract });
const router = gatewayRouter(gateway, definition.gateway!, custom);
const handler = gatewayHttpHandler(gateway, authentication, router);
```

In separate runtime modules, export the plain identity first, let the Gateway
router use it, and type-import the router when declaring the typed contract.
The Host imports the inert contract only. `vm` is a borrowed Gateway-owned service;
its application owner retains resource lifetime. A Host extension runs on the
Host and remains under `extensions`. No shared mutable current-Host variable or
generic service bag is introduced.

The actual custom router remains inferred through composition, including its
input/output types. `gatewayRouter` checks its type against the declared contract;
it neither copies procedures nor invents an RPC protocol. New runtime Host
instances can select known customization contracts. Unknown customizations need
their implementation included in the Gateway build; discovery JSON cannot
manufacture compile-time procedures.

Finite resolver work releases its route lease after actual settlement. A
subscription retains its lease until its producer's actual cleanup succeeds.
Replacement revokes observation; a quiet stream closes without waiting for a new
item. A failed cleanup stays charged. Revocation does not cancel or replay an
already admitted effect. Host-side delegated authorization and effect receipts
remain independent of authorization for Gateway-owned work.

`HostPeer<Router>` and `hostEndpoint` remain independently typed adapters for an
actual local router/context. They are not stored by the routing owner or used to
copy remote procedures. Browser contracts are exported from `./gateway`; Node
owner/Fetch composition lives behind `./gateway/node`. This layer imports no
p2prpc implementation; the lease's transport parameter is opaque to routing.

The focused owner cases cover exact route/composition/grants, immutable admitted
capabilities, truthful freshness, stale disconnects, independent viewers,
replacement/shutdown waiting for cleanup, capacity and failed HTTP construction.
Procedure parsing, quiet producer cancellation and exact effect/receipt assertions
remain with the actual Host/transport/reference cases. Retired selected-Host
HTTP-router assertions do not qualify the new WSS path.

## Amendment evidence

The earlier F07/F08 selected-router/HTTP results remain historical. This amendment
replaces that path with a transport-neutral route lease and topology-only HTTP.
Scoped strict/lint and six routing-owner cases pass using disposable scripted
resources; the production/browser composition is qualified separately. No native
agents, providers, installed services or old state are touched.
