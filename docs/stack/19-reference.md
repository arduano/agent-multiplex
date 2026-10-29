# 19 — Runnable reference process and Root/Host composition

The reference application composes the shipped owners into a real Node process:
a Root Catalog, one Host/default lifecycle, its model-free scripted harness,
conversation/interaction and asset extensions, a Gateway, authenticated Fetch
handling and the React consumer. It is an executable integration reference, not
a native-provider emulator or evidence that Codex/Copilot ran successfully.
Personal configuration, credentials and deployment policy do not belong here.

## Authority and creation

`createReference({directory,seed?})` opens two distinct original journals:
`root.sqlite` owns the Root Create workflow and logical metadata;
`sessions.sqlite` owns the Host's native effects/lifetimes. The file store owns
its own scoped bytes. The Root never writes a Host lifecycle checkpoint. The
Gateway forwards authorized observations/commands and owns neither catalog nor
native sessions.

Startup creates the two named fixture conversations through the real Catalog.
The returned `createConversation({session,id,name,selection?})` uses that same
workflow for additional logical sessions. It supplies this reference viewer's
scope, the actual Host contract/owner, its borrowed workspace and explicit
scripted selection. Catalog persists admission/reservation, sends the Host
Create once, and records positive evidence. Duplicate originals remain immutable
lookups; changed meaning cannot reuse an ID. Current metadata comes from Catalog,
not from deriving identity or names from whichever native lifetime is current.
The present UI bootstrap still describes the two fixture conversations; a
separate dynamic Create UI is not implied by this integration.

The actual structural HostCreationPort is returned as `hostCreation`. Its
read-only reconciliation checks exact scope, original ID and the hash of the
immutable Host Create request, including workspace and intended selection.
Successful Create evidence comes only from that receipt's permanently retained
positive `result.run`. It never substitutes today's session generation after a
later explicit Reopen. Missing/nonterminal evidence stays pending/unknown;
reconciliation never calls Create or Reopen. Archive publication similarly
validates the exact Host Archive original's scope, ID, generation/hash and
positive result before changing catalog metadata.

No startup path resumes persisted native work. A reused directory can retain
catalog and stopped Host metadata without reconstructing the scripted harness's
in-memory transcript. This fixture does not claim persistent native history or
native process recovery. Normal demo launches use a fresh disposable directory.
Older seeded history deliberately starts with an unknown earlier boundary so
07's acquisition owner, not the fixture, proves the native prefix.

## HTTP and shutdown

`startReference(...)` returns the composition plus its loopback URL and explicit
`disconnectViewers():void`. The latter closes only the owned HTTP connections;
the listener, catalog, Host lifetimes and native originals remain untouched.
Observation reconnection belongs to the retained client/supervisor. A discarded
HTTP connection cannot authorize a new Send or recover an effect by replay.

The local demo's bootstrap establishes its disposable local-viewer cookie; it is
not a production login flow. Other Gateway requests require that cookie and the
normal Gateway authorization. `multiplex run` instead imports an explicit
application module that supplies authenticated Fetch handling and owns shutdown.
The CLI does not infer provider credentials, native homes, login or enrollment.
Mutable agent and machine-trust directories remain explicit and disjoint from
payloads;20 owns the actual Nix/build distribution contract.

Malformed HTTP methods/Host authorities return400 before Fetch dispatch, inside
the HTTP error boundary. They cannot turn Request construction into an uncaught
process error. Normal close first stops only this composition's owned scripted
sessions, including additional Root-created sessions, then closes observations,
Host/extensions, catalog, files and both writers. It refuses active Root workflow
work; actual native models or existing fleet sessions are never cleanup targets.

## Focused qualification

Strict NodeNext/ES2023 compilation passed for the real reference source, CLI and
`test/reference/server.test.ts`. The single bounded actual-SQLite/loopback-HTTP
composition oracle passed in7.157s. It proves:

- Separate Root/Host original receipts and actual startup/Create composition.
- Permanent created-run evidence after a later explicit Stop/Reopen, immutable
  duplicate Create, request-hash mismatch refusal without allocation, and exact
  positive Host Archive evidence consumed by Catalog.
- Preserved seeded earlier boundary and five actual file preview descriptors.
- Cookie authentication, malformed TRACE/Host rejection while the listener
  survives, viewer disconnection without native mutation, and inert CLI help.

The first run used an existing Undici keepalive socket immediately after the
intentional all-socket disconnect, which correctly failed. The listener-liveness
assertion now opens an explicit fresh HTTP connection; this is not an effect
retry. Actual browser offline/recovery, scroll, layout and media tests belong to
21 and retain their separate evidence. This gate used no vendor agent, provider
request, external service or deployment. The CLI help child exited; the owned
HTTP listener, scripted lifetimes, SQLite readers/writers and file store closed,
and the disposable directory was removed.

This composed oracle replaces test-only assumptions that a fake Host reply or a
current session projection proves Root/native agreement. Earlier module-specific
invariants remain qualified at their owners rather than copied into this test.

The public build emits the reference browser assets under `dist/reference/web`;
`node dist/reference/cli.js demo` serves them with the model-free local Host.
Source composition and process helpers live under `src/reference/server/`;
React and explicit browser boot live under `src/reference/ui/`. The root
`node.ts` remains the public process facade, and `cli.ts` retains its compiled
entry path. This runtime split preserves the application's single resource owner.
`esbuild-wasm0.25.11` avoids an install-time native bundler bootstrap. Mermaid12
is bundled only into the reference application; the reusable chat renderer still
requires an explicitly injected renderer. The browser package boundary remains
free of Node imports. `multiplex run` instead loads an explicit trusted consumer
module exporting `create({paths})`, its authenticated Fetch handler and its actual
shutdown owner. Agent data and machine trust directories are canonical, private,
account-owned and disjoint; neither may be an immutable Nix payload.

Startup failure follows acquired ownership in reverse: a second journal/FileStore
failure releases only acquired owners, and a refused HTTP bind retires the fresh
scripted sessions and closes their stores. Cleanup must prove each Stop. An
unproved cleanup throws `ReferenceStartupError` retaining the exact close owner;
the CLI preserves that disposable state instead of deleting its recovery input.

## CLI convention amendment

The source entrypoint is `src/reference/cli.ts`; `cmd-ts` owns decoding. Both
`demo` and `run` take `--port` (0 by default); `run` no longer takes a positional
port. `--help` replaces the old help alias. Explicit empty/missing option values,
unknown arguments and invalid ports refuse before reading state or importing the
application. A narrow cmd-ts AST guard closes its defaulted-option empty-value
edge; no second argv parser is introduced.

An explicit `.ts`/`.tsx` application loads lazily through the pinned `tsx` API,
so the installed compiled CLI runs with its pinned Node without a global loader
or source checkout. No application import or transpiler starts during help.
Existing startup/custody/shutdown obligations remain authoritative.

## F07 contract-first amendment

The inert `ApplicationFactory`/`ApplicationModule` ABI and disjoint mutable paths live in `reference/node-contracts.ts`; applications no longer import the executable CLI for types. UI descriptors live in `reference/ui/contracts.ts`. Composition retains real attachment/asset owners for cleanup while lending narrower UI contracts. File-store custody transfers once to assets.

## F09 — Actual browser / Gateway / Iroh Host composition

`startReference` explicitly owns two authenticated local Iroh nodes and a logical
bridge Host. Its WebSocket upgrade checks the reference cookie and same Origin,
then selects an exact Gateway lease. The published p2prpc relay forwards bytes;
the Host's actual router, schemas and existing effect/native owners stay intact.
The reference is model-free and uses no existing service or native home.
`createReference` still opens no network endpoint by itself.

The UI borrows one actual typed peer across all conversations. Reconnect replaces
only a carrier and restarts observations; original receipts reconcile read-only,
with no Send replay. File bytes use the same peer's real file engine. A plain
Standard Schema descriptor lends the existing Zod validator to the dependency.
The Host middleware is reused by the asset router's extended context; no kernel
transport fields or implicit capability registry are needed.

The server retains every acquired owner before asynchronous startup. Shutdown
requests each independently owned listener/transport close, aggregates failures,
and retains the resource owner on failed proof. A transport heartbeat updates
Gateway topology only after an actual authenticated read succeeds. CLI applications
may provide an explicit Node upgrade handler alongside their Fetch handler.
Listener and application retirement start together so upgraded sockets cannot
trap the shutdown order.

The explicit demo CLI selects the published Iroh fork's `application` signal
policy before creating any endpoint. Its standalone default exits the process
after native cleanup and would preempt journal/file cleanup. Only the CLI owns
SIGTERM/SIGINT completion; it keeps Node alive while its asynchronous shutdown
settles. Imports and help remain inert. A custom application's process composition
must likewise choose its native library's signal policy before allocation.

The current logical peer has the upstream authentication lifetime (default15min).
Expiry/reload capacity recovery is an explicit remaining hardening item, not a
claim of indefinite self-healing. Same-epoch route-registration replacement does
not qualify a fresh Host identity/route epoch after restart. The acceptance record
separates these limits from the finite actual browser/Iroh journey. Earlier timing
and loopback-HTTP paragraphs above are historical evidence for earlier source.

## Harness-shaped Codex composition example

`./reference/codex` exposes the inert Gateway identity/contract and types inferred
from the actual composed routers. `./reference/codex/node` exposes
`createCodexDemoDefinition` and `codexDemoGatewayRouter`. This is a reusable example
for a separate Host/customization repository, with no live provider, binary,
credentials, directory or transport selected by default.

The definition factory receives the process-owned original journal, requested
selection and a factory constructing one actual `CodexAdapter`. It wires that
adapter's observations to the selected default lifecycle internally. The Host
combines the existing-directory workspace policy, native-shaped Codex router and
one `extensions.workspace.inspect` read of the actual lifecycle's workspace
metadata. The extension borrows that state; it creates no directory, second
journal or native owner. `activateHost` remains explicit, retaining the concrete
definition for the kernel's normal activation-failure recovery.

```ts
const definition = await createCodexDemoDefinition({
  journal,
  selection,
  adapter: (observe) => createCodexAdapter({ ...explicitNativeOptions, observe }),
});
const host = await activateHost(definition, activation);
const custom = codexDemoGatewayRouter(gatewayOwnedInventory);
const router = gatewayRouter(gateway, definition.gateway!, custom);
const handler = gatewayHttpHandler(gateway, authentication, router);
```

The associated Gateway-local `custom.summary` invokes an injected inventory
service with the authenticated viewer and exact selected Host target. Its code
and resource ownership stay on the Gateway. The Host imports only the inert
contract module; references to the actual Gateway/router factories are type-only.
Native Host procedures remain on the Host, reached through its actual inferred
client. The Gateway does not reconstruct or proxy those procedures as local
handlers. Consumers use official tRPC clients/links and the existing bridge.

The focused model-free oracle composes the actual Codex adapter over the retained
scripted wire/allocation fixture, one real SQLite writer and official tRPC Fetch
adapters/clients. It checks native model/turn response fidelity, creation-time
custom-route inference and authentication, workspace metadata, one native
dispatch for an exact repeated original, lifecycle activity observation and
positive cleanup. It passed in about4.2seconds; strict types (including negative
cross-harness/custom-route calls) and scoped lint passed. This is in-process
HTTP with no listening sockets, provider calls or native agents. It does not
qualify Iroh, the browser, live Codex behavior or deployment; those remain
separate integration evidence.

### Native-shaped browser integration

The opt-in `test/codex-demo/browser.ts` composes that Codex definition with the
published p2prpc browser client, a cookie-authenticated WebSocket Gateway and two
real local Iroh endpoints. Official inferred clients call the Host's native
Codex/workspace routes and the separately owned Gateway summary route. React
mounts the harness-specific headless hook over one retained Codex workspace per
viewer. The actual Codex adapter still uses a scripted stdio/allocation backend;
this does not launch Codex, contact a model provider, use a relay or qualify TLS.

The final-source journey passed in24.459seconds, including cleanup, within its
90second bound. It allocated two endpoints, one HTTP/WebSocket listener, one
Chromium context with two pages and two disposable scripted sessions. Three
unique Sends produced native streamed replies in both viewers. Session switching,
React remounting and pin retention preserved captured state. Closing the first
viewer left the second able to Send and left the borrowed physical peer usable.
With default initial-history behavior, both fresh sessions made **zero native
history-read calls**. No model requests or native agents were allocated.

All547 non-document source inputs remained byte-identical during the case. Both
logical peers reported zero tasks, streams, callbacks, shares and transfers after
close; the two endpoints, listener, scripted native owners and temporary state
also closed successfully. The earlier r1 artifact remains separate: it used an
explicit no-initial-read option before the final provenance/budget refinements.
The final r2 receipt and input/artifact hashes are retained with the private
qualification record. This finite journey does not qualify process restart,
relay failover, authentication expiry or live native-provider behavior.

Run it explicitly with an installed Chromium executable and a private output
directory; ordinary unit tests do not allocate these endpoints:

```sh
node --import tsx test/codex-demo/browser.ts \
  --out .cache/codex-demo-browser/manual \
  --browser /path/to/chromium
```
