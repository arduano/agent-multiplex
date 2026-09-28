import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { emptyMetadataSnapshot, sessionRecordSchema } from "@arduano/agent-multiplex-protocol";
import { ApiProvider } from "../../apps/web/src/client/api.js";
import { SessionConsole } from "../../apps/web/src/client/session-console.js";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "../../apps/web/src/client/styles.css";

const session = sessionRecordSchema.parse({
  sessionId: "00000000-0000-4000-8000-000000000001",
  runtimeNodeId: "00000000-0000-4000-8000-000000000002",
  harness: "copilot",
  adapterScopeId: "fixture:copilot",
  vendorSessionId: "fixture-native-session",
  bindingRevision: 1,
  runtimeEpoch: "00000000-0000-4000-8000-000000000003",
  cwd: "/workspace/lifecycle-fixture",
  availability: "active",
  runtimeStatus: "idle",
  lifecycle: {
    version: 1,
    fence: {
      sessionId: "00000000-0000-4000-8000-000000000001",
      runtimeNodeId: "00000000-0000-4000-8000-000000000002",
      runtimeNodeBootId: "00000000-0000-4000-8000-000000000007",
      bindingRevision: 1,
      runtimeEpoch: "00000000-0000-4000-8000-000000000003",
    },
    nextSequence: 4,
    label: "Ready",
  },
  metadata: { ...emptyMetadataSnapshot(), values: { "agent.title": "Lifecycle fixture" } },
  metadataAuthority: {
    realmId: "00000000-0000-4000-8000-000000000004",
    controlNodeId: "00000000-0000-4000-8000-000000000005",
    epochId: "00000000-0000-4000-8000-000000000006",
  },
  createdAt: "2026-09-22T00:00:00.000Z",
  updatedAt: "2026-09-22T00:00:00.000Z",
  lastSeenAt: null,
});
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <ApiProvider token="" connectionKey={0} enableWebSocket={false}>
      <main style={{ display: "flex", height: "100dvh", minHeight: 0, flexDirection: "column" }}>
        <SessionConsole session={session} terminalCapability={null} />
      </main>
    </ApiProvider>
  </QueryClientProvider>,
);
