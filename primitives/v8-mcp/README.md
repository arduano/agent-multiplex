# V8 MCP observation primitives

Small isolated, browser-safe MCP lifecycle observation for an **existing exact native run**. There is no SDK/process/config dependency, background materialization, native tool call, prompt responder or second effect journal.

```ts
const reads = new McpReadPool(); // share across native-run/Host observer replacements
const mcp = new McpOwner({run, epoch: sessionSnapshot.epoch,
  native: copilotMcpReadPort(session), reads});
const workspace = new McpWorkspace({connection, principal, port: mcp});
await workspace.bind(run, 'copilot'); // retained snapshot/subscription only
await workspace.refresh(run);       // explicit bounded native discovery
workspace.retire(run);              // explicit exact-run replacement/retirement
```

`src/index.ts` exports contracts, separate Codex/Copilot read wrappers, `McpReadPool`, `McpOwner` and the retained `McpWorkspace`. The wrappers are structural ports; they import neither native SDK nor native configuration. Application composition supplies existing authenticated routing and the existing `RunRef`/Host observation epoch.

Codex requests `mcpServerStatus/list` for the exact native thread with `toolsAndAuthOnly`, at most four pages of 32 requested servers. Copilot calls only `.19 rpc.mcp.listConfigured()`; `rpc.mcp.list()` may start/wait for native servers and is deliberately absent. Projected snapshots omit endpoints, raw errors, configurations, tool schemas, resource bodies, OAuth handles and credentials. Native enum/auth/availability differences remain concrete and typed. Codex tool counts distinguish discovery failure (null) from an empty returned catalog (zero), without a redundant derived discovery flag.

Codex's `thread-scoped-discovery` can start temporary MCP clients during explicit refresh. Counts are discovery evidence, potentially cached, not live tool availability. Actual local qualification found even the separate named-server native request could return an old five-tool catalog while its live client successfully called the new sixth tool. No implicit per-server N+1 refresh or polling is added to hide this boundary. Copilot's passive read was checked against a stopped owned server and did not restart it.

Defaults: two actual underlying read owners, 32 removable observers per read, eight-second consumer deadline, 128 projected servers, 256 tool names counted per Codex server, 64 KiB projected snapshot, 16 retained runs and 64 listeners per entry/owner. Native wire/SDK response byte limits are separate and not established by a projection cap. Copilot's configured list has no native page-size argument.

Consumers can cancel/time out independently; actual slots persist until settlement even after native-run retirement. Known native changes during discovery keep its result stale. Snapshot/subscribe/bind/reobserve do not invoke native discovery. UI unmount merely releases a subscriber. Concurrent initial binds share one baseline read and subscription. Failed subscription admission rolls back its exact entry; a failed initial snapshot keeps a stale valid subscription so explicit bind retries only the read. Positive native retirement immediately detaches observation while retaining its last facts. A new exact-run subscriber receives those closed retired facts once without a retained subscription; refresh remains fenced. The workspace owner calls `retire(run)` only after publishing a replacement, or to discard a distinct failed candidate. Exact retirement releases capacity, scrubs/notifies cached facades and fences delayed callbacks/reads; it does not close the MCP/native server. Namespace disposal applies the same cleanup to every retained run. The embedding can reserve one published plus one candidate run per retained session, with a maximum of 256 runs.

Native controllers can report `management: "session-originals"` when they expose
the closed SessionHost commands: Codex `codex.mcp.reload` reloads all loaded
threads in that native app-server; Copilot `copilot.mcp.reconnect` reconnects one
known configured server with a plain native restart. Reconnect does not assert
that OAuth succeeded or that persisted credentials changed. Stop fences the
effect boundary. The existing `NativeCapture.mcpChanged` signal marks this
owner stale before dispatch and on known native changes without rereading.
Native acknowledgement never implies a connected server or current tool list.
Read-only bindings continue to report `unavailable-no-original-command`.

Running-agent sign-in remains a separate SessionHost original. The concrete
controllers use the private [`LoginLinks`](src/login.ts) transient owner: at most
sixteen per-server attempts,8192UTF-8 URL bytes each and a120-second display
window. Expiry never cancels a native flow or licenses replay. URLs are absent
from this module's snapshots, events, journals and client caches. The dedicated
`SessionPort.mcpLoginLink` lookup requires exact account/run/original plus both
read and control authority; HTTP is no-store. Stop retires native callbacks and
fences late links. Codex completion requires its exact native login ID. A
Copilot manual URL flow stays initiated until an actual correlated proof exists;
a generic connected event cannot supply it. Explicit persistent Copilot storage
is preserved but unsupported for this login leaf. Stopped/shared authentication
remains unavailable until its reusable credential namespace is proved.

Inventory adds only frozen `transport` and `canAuthenticate` facts. Codex derives
them from native origin/auth metadata without publishing the origin; Copilot
uses the exact trusted startup definitions. Config-discovered names stay
`unknown`/null. Authentication eligibility alone grants no sign-in action; the
explicit running-agent original above remains the only supported login path.
No endpoint, configuration, credential or authorization URL is projected.
The existing native/session owners retain ordinary enabled tools and real
confirmation popups. Stopped/shared Host-profile authentication, enable/disable
and configuration writers remain unavailable; they cannot gain
honest receipts from a second operation map. Copilot may explicitly select native
`persistent` token storage for the same managed native home across Stop/Resume;
this is not proof of a working OS keychain or shared authentication across homes.

Focused development commands, from framework root:

```sh
node node_modules/typescript/bin/tsc --project primitives/v8-mcp/tsconfig.json
node --test --test-concurrency=1 --test-timeout=60000 primitives/v8-mcp/.build/primitives/v8-mcp/qualification/*.test.js
```

Focused scripted tests and negative type assertions protect the contract. The
[local helpers](qualification/local/run.mjs) are opt-in, model-free probes against
standalone stdio/HTTP fixtures, an independent published MCP SDK and disposable
pinned CLIs. Tools resolve within this framework or through explicit tool/SDK
roots. Ordinary qualification runs admission/model-trap guards without starting
those native helpers. Local ignored receipts retain exact source/tool scope;
they do not establish deployment or full MCP-management conformance. See the
framework [MCP boundary](../../docs/design/v8-architecture.md#interactions-and-mcp).
