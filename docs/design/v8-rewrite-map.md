# V8 rewrite map

V8 is an isolated clean-break source implementation under
[primitives](../../primitives/), outside the maintained released workspace graph.
The [architecture contract](v8-architecture.md) owns generic module and effect
ownership. [Current state](../wiki/Current-State.md) separates this source lane
from released compatibility and deployment facts.

Preserve useful capability, native semantics, privacy and exact effect evidence
while reducing coupling. Old topology, forwarding journals, projection layers
and every old implementation test are not requirements for the new design.

## Module map

| Area | Source boundary |
| --- | --- |
| Static Host/router composition | [v8-plugins](../../primitives/v8-plugins/README.md) |
| Selected lifecycle, allocation and native originals | [v8-lifecycle-default](../../primitives/v8-lifecycle-default/README.md) |
| Concrete native adapters and setup | [Codex](../../primitives/v8-harness-codex/README.md), [Copilot](../../primitives/v8-harness-copilot/README.md), [installed facade](../../primitives/v8-harness-defaults/README.md) |
| Shared native custody and Send preparation | [v8-host](../../primitives/v8-host/README.md) |
| Session DTOs and retained native client | [v8-session](../../primitives/v8-session/README.md) |
| Capture/replay, exceptional acquisition and views | [v8-history](../../primitives/v8-history/README.md) |
| File bytes, inputs, references and previews | [v8-files](../../primitives/v8-files/README.md) |
| Catalog identity and binding publication | [v8-catalog](../../primitives/v8-catalog/README.md) |
| Native prompt/callback observations | [v8-interactions](../../primitives/v8-interactions/README.md) |
| Retained MCP inspection/explicit refresh | [v8-mcp](../../primitives/v8-mcp/README.md) |
| Runtime evidence and organization | [v8-runtime](../../primitives/v8-runtime/README.md), [v8-organization](../../primitives/v8-organization/README.md) |
| Authenticated direct routing and observers | [v8-gateway](../../primitives/v8-gateway/README.md) |
| Retained heterogeneous React bindings | [v8-workspace](../../primitives/v8-workspace/README.md) |
| Scripted executable and cross-module qualification | [v8-integration](../../primitives/v8-integration/README.md) |

## Simplification rules

One selected lifecycle owns its allocation/native boundary; its existing native
journal stays with that implementation. The Host kernel has no fallback.
Harness-specific controls and history/events stay concrete instead of becoming
arbitrary action names.

Each durable effect has one existing owner. Gateway forwarding, React rendering
and transport reconnection add no outbox, execution authority or mutation replay.
UI selection and observation pins never decide native lifetime. An unknown
outcome stays with the exact original owner.

Applications compose configuration and typed static modules outside this
repository. Generic source and qualification must not import application
configuration, plans, dependency installations or private runtime state.

## Qualification and remaining boundaries

Use bounded focused checks, then the relevant composed source gate. Retain tests
for their unique invariant/oracle, not original module placement. Physical native
halt, native page/live continuity and callback settlement require their own
native evidence. A missing historical physical-close caller stays unproved even
when the controlled shared-hop cancellation class passes its replacement oracle.

Historical local receipts are ignored diagnostic artifacts, not evidence shipped
with a clone. They retain their original source/dependency scope. Published
package closure, production authentication, OS installation, complete
native/platform conformance and application/domain ports remain separate
acceptance boundaries.
