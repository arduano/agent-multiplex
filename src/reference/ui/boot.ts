import type { ReferenceRouter } from "../index.js";
import { bridgeHostUrl } from "../../transport/index.js";
import { connectBridge, type BrowserBridgePeer } from "@arduano/p2prpc-core/browser";
import { assetTransferMetadataSchema, type AssetTransferMetadata } from "../../assets/contracts.js";
import { browserPersistence, connectReferenceUi, createMermaidRenderer } from "./index.js";

// Explicit demo boot only. Importing public framework modules remains inert.
const element = document.querySelector("#app");
if (!(element instanceof HTMLElement)) throw Error("Missing reference mount");
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
  const response = await fetch("/bootstrap", { credentials: "include", cache: "no-store" });
  if (!response.ok) throw Error("Reference bootstrap unavailable");
  const bootstrap = await response.json();
  const url = bridgeHostUrl(location.origin, {
    route: bootstrap.route,
    expected: bootstrap.expected,
  });
  peer = await connectBridge<ReferenceRouter, never, AssetTransferMetadata>({
    url,
    expectedHostId: bootstrap.hostId,
    fileMetadataSchema: { "~standard": assetTransferMetadataSchema["~standard"] },
  });
  connected = await connectReferenceUi({
    element,
    bootstrap,
    peer,
    persistence: browserPersistence(localStorage, "multiplex.reference"),
    renderDiagram: createMermaidRenderer({
      container: element,
      load: async () => (await import("mermaid")).default,
    }),
  });
  window.addEventListener(
    "pagehide",
    () => {
      void close().catch(() => console.error("Reference browser cleanup is unproved"));
    },
    { once: true },
  );
} catch {
  const retired = await close().then(
    () => true,
    () => false,
  );
  element.textContent = retired
    ? "Unable to open the reference conversation. Check the local reference process and reload."
    : "Unable to open the reference conversation. Browser connection cleanup was not confirmed.";
}
