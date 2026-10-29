import type { ReferenceRouter } from "../../src/reference/index.js";
import type { ReferenceBootstrap } from "../../src/reference/index.js";
import type {} from "./globals.js";
import { bridgeHostUrl } from "../../src/transport/index.js";
import { connectBridge, type BrowserBridgePeer } from "@arduano/p2prpc-core/browser";
import {
  assetTransferMetadataSchema,
  type AssetTransferMetadata,
} from "../../src/assets/contracts.js";
import {
  browserPersistence,
  connectReferenceUi,
  createMermaidRenderer,
} from "../../src/reference/ui/index.js";

// This is an explicit reference boot entry, never an effect of importing the
// framework. Both pages use the actual public browser bridge and retained owners.
const element = document.querySelector("#app");
if (!(element instanceof HTMLElement)) throw Error("Missing reference mount");
const response = await fetch("/bootstrap", { credentials: "include", cache: "no-store" });
if (!response.ok) throw Error("Reference bootstrap unavailable");
const bootstrap: ReferenceBootstrap = await response.json();
const viewer = new URL(location.href).searchParams.get("viewer") ?? "primary";
if (!/^[a-z0-9-]{1,32}$/.test(viewer)) throw Error("Invalid reference viewer");
const url = bridgeHostUrl(location.origin, {
  route: bootstrap.route,
  expected: bootstrap.expected,
});
let peer: BrowserBridgePeer<ReferenceRouter, AssetTransferMetadata> | undefined;
let connected: Awaited<ReturnType<typeof connectReferenceUi>> | undefined;
async function close(): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => connected?.close()),
    Promise.resolve().then(() => peer?.close()),
  ]);
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Reference browser cleanup is unproved",
    );
}
try {
  peer = await connectBridge<ReferenceRouter, never, AssetTransferMetadata>({
    url,
    expectedHostId: bootstrap.hostId,
    fileMetadataSchema: { "~standard": assetTransferMetadataSchema["~standard"] },
  });
  const active = await connectReferenceUi({
    element,
    bootstrap,
    peer,
    // Separate viewers have separate durable client namespaces; one tab never
    // overwrites another workspace's unknown originals. Reload retains this tab.
    persistence: browserPersistence(localStorage, `reference.${viewer}`),
    renderDiagram: createMermaidRenderer({
      container: element,
      load: async () => (await import("mermaid")).default,
    }),
    theme: new URL(location.href).searchParams.get("theme") === "dark" ? "dark" : "light",
  });
  connected = active;
  window.__reference = {
    ready: true,
    snapshots: () =>
      active.conversations.map((value) => ({
        id: value.id,
        snapshot: value.view.entry.getSnapshot(),
        anchor: value.view.anchor.getSnapshot(),
      })),
    diagnostics: () => ({
      entries: active.workspace.entryCount,
      observations: active.observations.diagnostics(),
    }),
    close,
  };
} catch (error) {
  try {
    await close();
  } catch (failure) {
    throw new AggregateError([error, failure], "Reference browser startup and cleanup failed", {
      cause: failure,
    });
  }
  throw error;
}
