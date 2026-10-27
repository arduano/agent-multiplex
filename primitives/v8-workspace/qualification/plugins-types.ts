import type { PublicHostContract } from "../../v8-plugins/src/index.js";
import { fixture } from "../../v8-plugins/qualification/fixtures.js";
import { defineHost, hostProcedure, hostRouter } from "../../v8-plugins/src/index.js";
import { z } from "zod";
import { createMultiplexReact } from "../src/plugin-react.js";
import { PluginWorkspace, type PluginAgentSnapshot, type PluginAgentView, type PluginHostSnapshot, type PluginHostView } from "../src/plugin-client.js";

const codex = fixture().definition;
const copilot = defineHost({
  contract: { id: "fixture.copilot", version: 1 },
  harness: { kind: "harness", identity: { id: "copilot", version: 1, recordVersion: 1 }, nativeKind: "copilot", capabilities: [] } as const,
  lifecycle: () => ({ kind: "lifecycle" as const, identity: { id: "default", version: 1, recordVersion: 1 }, capabilities: [], createInput: z.object({ repository: z.string() }), public: { host: z.object({ organization: z.string() }), session: z.object({ customMode: z.string() }) }, open() { return { sessions: {}, router: hostRouter({}), readiness: () => ({ ready: true as const }), close() {} }; } }),
  harnessRouter: () => hostRouter({ mode: hostProcedure.input(z.enum(["interactive", "plan"])).mutation(({ input }) => input) }),
});
type Hosts = { local: PublicHostContract<typeof codex>; work: PublicHostContract<typeof copilot> };
const { useHost, useAgent } = createMultiplexReact<Hosts>();
declare const host: PluginHostView<Hosts>;
declare const agentView: PluginAgentView<Hosts>;
const h = useHost(host);
const a = useAgent(agentView);
function assertType<T>(_value: T): void {}
assertType<PluginHostSnapshot<Hosts>>(h);
assertType<PluginAgentSnapshot<Hosts>>(a);
if (h.hostKind === "local") {
  void h.client.harness.thinking.mutate({ effort: "high" });
  assertType<number | undefined>(h.plugin.value?.extensions.workspace.quota);
  // @ts-expect-error No Copilot command on Codex Host.
  void h.client.harness.mode.mutate("plan");
}
if (h.hostKind === "work") {
  void h.client.harness.mode.mutate("plan");
  assertType<string | undefined>(h.plugin.value?.lifecycle.organization);
  // @ts-expect-error No Codex command on Copilot Host.
  void h.client.harness.thinking.mutate({ effort: "high" });
}
if (a.hostKind === "local" && a.agent.kind === "codex") {
  a.agent.actions.updateTurn?.("turn", { kind: "codex" });
  // @ts-expect-error No Copilot native action after known Host narrowing.
  a.agent.actions.setMode?.("plan");
  assertType<string | undefined>(a.plugin.value?.extensions.workspace.branch);
}
if (a.hostKind === "work" && a.agent.kind !== "disposed" && a.agent.kind !== "unavailable") {
  a.agent.actions.setMode?.("plan");
  // @ts-expect-error No Codex native action after known Host narrowing.
  a.agent.actions.updateTurn?.("turn", { kind: "codex" });
}
// @ts-expect-error Caller cannot assert an unrelated contract through the hook.
useHost<PublicHostContract<typeof copilot>>(host);
// @ts-expect-error Runtime known-kind registration must match the native kind.
new PluginWorkspace<Hosts>({ local: { contractId: "x", contractVersion: 1, compositionId: "x", nativeKind: "copilot" }, work: { contractId: "y", contractVersion: 1, compositionId: "y", nativeKind: "copilot" } });
