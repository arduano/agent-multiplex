import { createElement as h, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { z } from "zod";
import { GatewayClient } from "../../v8-gateway/src/client/coordinator.js";
import { HttpGatewayTransport } from "../../v8-gateway/src/client/http.js";
import { createGatewayHostClient } from "../../v8-gateway/src/client/rpc.js";
import { HistoryWorkspace } from "../../v8-history/src/client/workspace.js";
import { PluginWorkspace, type PluginAgentView, type PluginHostView } from "../src/plugin-client.js";
import { createMultiplexReact } from "../src/plugin-react.js";
import type { PluginBrowserHosts } from "./plugins-browser-fixture.js";
import type { HostManifest } from "../../v8-plugins/src/contracts.js";
import type { HostRpcTarget } from "../../v8-gateway/src/contracts/rpc.js";
import { workspaceFixture, catalogScope } from "./fixture.js";

type Metadata = { local: { target: HostRpcTarget; manifest: HostManifest }; work: { target: HostRpcTarget; manifest: HostManifest } };
const metadata = await (await fetch("/meta")).json() as Metadata;
function expected(kind: "local" | "work") {
  const local = kind === "local";
  const identity = (id: string) => ({ id, version: 1, recordVersion: 1 });
  return { contractId: `browser.${kind}`, contractVersion: 1,
    compositionId: JSON.stringify({ harness: identity(local ? "browser.codex" : "browser.copilot"), lifecycle: identity(local ? "browser.existing" : "browser.repository"), extensions: local ? { workspace: identity("browser.workspace") } : { organization: identity("browser.organization") } }),
  };
}
const native = workspaceFixture({ hostForKind: { codex: "local-host", copilot: "work-host" } });
const bases = await native.open();
let channels = 0, disposed = false;
let plugins!: PluginWorkspace<PluginBrowserHosts>;
const dispose = () => { if (disposed) return; disposed = true; plugins.disposeNamespace(catalogScope); native.workspace.close(); };
const transport = new HttpGatewayTransport({ url: new URL("/v8", location.href).href, authorization: "Bearer browser-owner", onUnauthenticated: dispose,
  fetch: async (input, init) => { if (JSON.parse(String(init?.body)).op === "watch.open") channels++; return fetch(input, init); },
});
const gateway = new GatewayClient({ transport, targets: [], hostTargets: [metadata.local.target, metadata.work.target], history: new HistoryWorkspace(catalogScope), onFence: dispose });
plugins = new PluginWorkspace<PluginBrowserHosts>({ local: { ...expected("local"), nativeKind: "codex" }, work: { ...expected("work"), nativeKind: "copilot" } });
const localHostData = z.object({ revision: z.number().int().positive(), data: z.object({ lifecycle: z.object({ strategy: z.literal("existing") }), extensions: z.object({ workspace: z.object({ quota: z.number() }) }) }) });
const localSessionData = z.object({ revision: z.number().int().positive(), data: z.object({ lifecycle: z.object({ directory: z.string() }), extensions: z.object({ workspace: z.object({ branch: z.string() }) }) }) });
const workHostData = z.object({ revision: z.number().int().positive(), data: z.object({ lifecycle: z.object({ tenant: z.string() }), extensions: z.object({ organization: z.object({ policy: z.object({ managed: z.boolean() }) }) }) }) });
const workSessionData = z.object({ revision: z.number().int().positive(), data: z.object({ lifecycle: z.object({ mode: z.literal("interactive") }), extensions: z.object({ organization: z.object({ team: z.string() }) }) }) });
const localClient = createGatewayHostClient<PluginBrowserHosts["local"]["router"]>({ transport, ...metadata.local, expected: expected("local") });
const workClient = createGatewayHostClient<PluginBrowserHosts["work"]["router"]>({ transport, ...metadata.work, expected: expected("work") });
const localHost = plugins.prepareHost({ hostKind: "local", key: metadata.local.target, manifest: metadata.local.manifest, client: localClient,
  sessionClient: session => createGatewayHostClient<PluginBrowserHosts["local"]["router"]>({ transport, ...metadata.local, expected: expected("local"), session }),
  source: gateway.rpcSource({ target: metadata.local.target, expected: expected("local"), path: "extensions.workspace.hostWatch" }, value => localHostData.parse(value).data),
});
const workHost = plugins.prepareHost({ hostKind: "work", key: metadata.work.target, manifest: metadata.work.manifest, client: workClient,
  sessionClient: session => createGatewayHostClient<PluginBrowserHosts["work"]["router"]>({ transport, ...metadata.work, expected: expected("work"), session }),
  source: gateway.rpcSource({ target: metadata.work.target, expected: expected("work"), path: "extensions.organization.hostWatch" }, value => workHostData.parse(value).data),
});
const local = plugins.prepareAgent(localHost, { session: { id: "a", generation: 1 }, base: bases.a,
  source: gateway.rpcSource({ target: metadata.local.target, expected: expected("local"), session: { id: "a", generation: 1 }, path: "extensions.workspace.sessionWatch" }, value => localSessionData.parse(value).data),
});
const work = plugins.prepareAgent(workHost, { session: { id: "b", generation: 1 }, base: bases.b,
  source: gateway.rpcSource({ target: metadata.work.target, expected: expected("work"), session: { id: "b", generation: 1 }, path: "extensions.organization.sessionWatch" }, value => workSessionData.parse(value).data),
});
const { Provider, useHost, useAgent } = createMultiplexReact<PluginBrowserHosts>();
function Panel({ host, view }: { host: PluginHostView<PluginBrowserHosts>; view: PluginAgentView<PluginBrowserHosts> }) {
  const hostState = useHost(host), state = useAgent(view);
  if (state.agent.kind === "disposed") return h("div", { id: "state" }, "disposed");
  return h("section", {}, h("div", { id: "state" }, state.hostKind), h("div", { id: "native" }, state.agent.kind),
    h("div", { id: "plugin-state" }, state.plugin.observation), h("div", { id: "custom-session" }, JSON.stringify(state.plugin.value)),
    h("div", { id: "custom-host" }, JSON.stringify(hostState.plugin.value)), h("div", { id: "draft" }, state.agent.composer.value.text),
    h("button", { id: "edit", onClick: () => view.base.setDraft("retained typed plugin draft") }, "Edit"));
}
function Shell() {
  const [selected, select] = useState<"local" | "work">("local");
  return h("main", {}, h("button", { id: "local", onClick: () => select("local") }, "Local"), h("button", { id: "work", onClick: () => select("work") }, "Work"), h(Panel, selected === "local" ? { host: localHost, view: local } : { host: workHost, view: work }));
}
const before = { channels, streams: native.counts().streams };
const html = renderToString(h(Provider, { workspace: plugins }, h(Panel, { host: localHost, view: local })));
const ssr = { htmlHasCodex: html.includes("codex"), before, after: { channels, streams: native.counts().streams } };
let root = createRoot(document.getElementById("app")!);
const render = () => root.render(h(StrictMode, {}, h(Provider, { workspace: plugins }, h(Shell))));
render();
const api = {
  ready: true, ssr, stats: () => ({ channels, ...native.counts(), disposed }),
  snapshot: () => ({ local: local.getSnapshot(), work: work.getSnapshot() }),
  pin(value: boolean) { local.setPinned(value); native.workspace.setPinned("a", value); },
  disconnect: () => gateway.disconnect(), reconnect: () => gateway.reconnect(),
  async query() { return { local: await localClient.extensions.workspace.inspect.query(), work: await workClient.extensions.organization.inspect.query() }; },
  async claim() { return localClient.extensions.workspace.claim.submit.mutate({ id: "browser-original", input: { branch: "claimed" } }); },
  original: () => localClient.extensions.workspace.claim.original.query({ id: "browser-original" }),
  unmount() { root.unmount(); }, remount() { root = createRoot(document.getElementById("app")!); render(); },
  close() { plugins.close(); gateway.close(); transport.close(); native.workspace.close(); },
};
Object.assign(window, { pluginReact: api });
declare global { interface Window { pluginReact: typeof api; } }
