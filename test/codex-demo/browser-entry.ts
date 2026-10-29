import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { connectBridge } from "@arduano/p2prpc-core/browser";
import { CodexWorkspace, type CodexViewPort } from "../../src/codex/client/index.js";
import { useCodexView } from "../../src/codex/react/index.js";
import { bridgeHostUrl, ObservationSupervisor } from "../../src/transport/index.js";
import type { CodexDemoHostRouter } from "../../src/reference/codex/index.js";
import type { RunRef } from "../../src/protocol/index.js";
import type { HostTarget } from "../../src/gateway/contracts.js";
import type { CodexBrowserGatewayRouter } from "./browser-fixture.js";

async function boot() {
  const response = await fetch("/bootstrap");
  const bootstrap = (await response.json()) as {
    hostId: string;
    target: HostTarget;
    runs: RunRef[];
  };
  const peer = await connectBridge<CodexDemoHostRouter>({
    url: bridgeHostUrl(location.origin, bootstrap.target),
    expectedHostId: bootstrap.hostId,
  });
  const gateway = createTRPCClient<CodexBrowserGatewayRouter>({
    links: [
      httpBatchLink({
        url:
          location.origin + "/trpc?target=" + encodeURIComponent(JSON.stringify(bootstrap.target)),
      }),
    ],
  });
  const observations = new ObservationSupervisor({ retryMinMs: 20, retryMaxMs: 100 });
  const workspace = new CodexWorkspace({
    client: peer.rpc.native,
    observations,
  });
  const views = bootstrap.runs.map((run) => workspace.view(run));
  views[0]!.pin(true);
  const element = document.querySelector("#app")!;
  let root = createRoot(element),
    selected = 0;
  function Transcript({ view }: { view: CodexViewPort }) {
    const snapshot = useCodexView(view);
    return createElement(
      "section",
      { "data-testid": "transcript", "data-freshness": snapshot.entry.freshness },
      createElement("h1", null, view.run.scope.session),
      ...snapshot.entry.items
        .filter((row) => row.threadId === view.threadId)
        .map((row) =>
          createElement(
            "p",
            { key: row.turnId + ":" + row.item.id },
            row.item.type === "agentMessage" ? row.item.text : row.item.type,
          ),
        ),
    );
  }
  const render = () =>
    root.render(createElement(Transcript, { view: views[selected]!, key: selected }));
  render();
  const api = {
    summary: () => gateway.custom.summary.query(),
    inspect: (index: number) =>
      peer.rpc.extensions.workspace.inspect.query({
        session: bootstrap.runs[index]!.scope.session,
      }),
    async send(index: number, originalId: string) {
      const run = bootstrap.runs[index]!;
      return peer.rpc.native.turn.start.mutate({
        originalId,
        run,
        params: {
          threadId: run.nativeSession,
          input: [{ type: "text", text: originalId, text_elements: [] }],
        },
      });
    },
    switch(index: number) {
      selected = index;
      render();
    },
    remount() {
      root.unmount();
      root = createRoot(element);
      render();
    },
    snapshot: (index: number) => views[index]!.getSnapshot(),
    async close() {
      root.unmount();
      for (const view of views) {
        view.pin(false);
        view.close();
      }
      await workspace.close();
      await observations.close();
      await peer.close();
      return { peer: peer.diagnostics(), workspaceClosed: true };
    },
  };
  window.codexDemo = api;
  document.body.dataset.ready = "true";
  return api;
}
declare global {
  interface Window {
    codexDemo: Awaited<ReturnType<typeof boot>>;
  }
}
void boot().catch((error: unknown) => {
  document.body.dataset.error = String(error);
});
