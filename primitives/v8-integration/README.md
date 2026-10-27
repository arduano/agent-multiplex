# V8 integration and reference application

This generic source lane composes the actual V8 owners into a disposable React
conversation application. The [architecture contract](../../docs/design/v8-architecture.md)
owns module responsibilities and uncertainty rules. It has no consuming
application source, configuration, dependency-installation or runtime dependency.
The maintained published workspace/release graph remains separate.

## Composition

- `v8-plugins` selects one lifecycle/harness, actual custom tRPC routers and
  public schemas. The Host kernel contains no fallback lifecycle.
- `v8-lifecycle-default` assembles the durable SessionHost, allocation registry,
  native supervision, capture, callbacks, MCP and file owners. Concrete adapters
  remain in their Codex/Copilot harness modules.
- `v8-workspace` composes retained clients, native controls and public plugin
  projections. Preparation is explicit; React observes only after commit.
- `v8-gateway` supplies authenticated direct routes, signed exact-owner Host RPC,
  binary file ports and one HTTP observer mux with independent bounded feeds.
- [application](application/) supplies a reference renderer, HTTP credential
  boundary, SQLite/files and scripted native transports. It is a proving
  application, not a consumer's account/profile/deployment composition.

## Disposable example

From this directory, with framework-owned dependencies installed:

```sh
npm run demo
```

The command builds its closed source graph and prints a fresh loopback URL.
Ctrl+C closes only its owned HTTP server, scripted Hosts and temporary state.
It makes no native-agent/model/provider call and installs nothing. Scripted
credentials and native facts are fixture data, not production authentication.

## Bounded source qualification

Use focused checks while iterating. `npm test` invokes the
[composed runner](qualification/run.mjs): browser import guards, strict native
and plugin types, a clean worker build, unique Node invariants, actual
React/Chromium cases and published p2prpc/Iroh loopback fixtures. It also checks
an unpacked selected server/browser graph. Scripts use framework-owned tools;
no application checkout participates in their source/dependency manifest.

The actual [typed React fixture](../v8-workspace/qualification/plugins-browser.mjs)
uses two different Host contracts, custom query/mutation/subscription data,
retained drafts/history/pins, reconnect and auth disposal. The published
transport fixture holds real raw opening while cancelling one observer and
proving other viewers survive. Existing session/history/file/native-boundary
oracles are reused instead of cloned under each plugin.

The runner records exact source/dependency hashes, stage counts, cleanup and
checksums under ignored `artifacts/`. A failed stage stays diagnostic. Historical
receipts retain their original inputs; they do not qualify later code or a
changed repository boundary. These local artifacts are not portable public
clone evidence and may contain private diagnostics. No maintained test is
retired simply because a scripted seam passes.

## Native and product limits

Native SDK/RPC fixtures preserve host-specific semantics, including partial
callback settlement. Scripted containment cannot prove a working native tree
has stopped, every explicit reopening/Continue path, complete history or all platform
behavior. The [opt-in native runner](qualification/native/README.md) has separate
explicit finite admission; normal source qualification does not invoke it.

The V8 shared-hop cancellation correction has a decisive multi-viewer oracle;
it does not identify the first physical-close caller in the older unresolved
incident. Complete native/platform conformance, production sign-in/TLS/fleet
composition, reusable rich product UI, publication and OS installation are
separate acceptance boundaries. This source lane claims no deployed product.
