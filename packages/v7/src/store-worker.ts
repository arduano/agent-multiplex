import { parentPort, workerData } from "node:worker_threads";
import { StoreDatabase } from "./store-database.js";
import type { SessionMetadata } from "./protocol.js";
import { V7Error } from "./errors.js";
import type { MetadataPatch } from "./store.js";
import { canonicalJson } from "./store-payload.js";

const port = parentPort!;
let store: StoreDatabase | undefined;
try {
  store = new StoreDatabase(workerData);
  port.postMessage({ ready: true, bindings: store.role === "host" ? store.bindings() : [], registry: store.role === "root" ? store.registry() : [] });
} catch (error) {
  port.postMessage({ ready: true, error: { code: error instanceof V7Error ? error.code : "STORAGE_FAILURE",
    message: error instanceof Error ? error.message : "Storage failed" } });
  port.close();
}
if (store)
port.on("message", (message: { id: number; method: string; args: unknown[] }) => {
  try {
    let result: unknown;
    if (message.method === "patchMetadata") {
      const [sessionId, patch] = message.args as [string, MetadataPatch];
      const previous = store!.metadata(sessionId);
      if (!previous) throw new V7Error("SESSION_MISSING", "Session is absent from Root registry");
      if (patch.expectedMetadataRevision !== undefined && patch.expectedMetadataRevision !== previous.metadataRevision) {
        throw new V7Error("METADATA_CONFLICT", "Session metadata changed since this patch was prepared");
      }
      const values = { ...previous.metadata, ...patch.metadata };
      for (const key of patch.remove ?? []) delete values[key];
      const next: SessionMetadata = { ...previous, ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
        ...(patch.archived === undefined ? {} : { archived: patch.archived }), metadata: values };
      if (canonicalJson(next) !== canonicalJson(previous)) {
        next.metadataRevision += 1; store!.putMetadata(next);
      }
      result = next;
    } else if (message.method === "reserveMetadata") {
      const metadata = message.args[0] as SessionMetadata;
      if (store!.metadata(metadata.sessionId)) throw new V7Error("SESSION_EXISTS", "Logical session ID is already reserved");
      store!.putMetadata(metadata); result = metadata;
    } else if (message.method === "delay") {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(message.args[0])); result = null;
    } else {
      const methods = ["admit", "transition", "receipt", "receiptEvents", "requestPayload", "receipts", "putBinding", "putMetadata", "close"];
      if (!methods.includes(message.method)) throw new V7Error("STORE_METHOD", "Unknown private writer operation");
      const action = (store as unknown as Record<string, (...args: unknown[]) => unknown>)[message.method]!;
      result = action.apply(store, message.args);
    }
    port.postMessage({ id: message.id, result });
    if (message.method === "close") port.close();
  } catch (error) {
    port.postMessage({ id: message.id, error: { code: error instanceof V7Error ? error.code : "STORAGE_FAILURE",
      message: error instanceof Error ? error.message : "Storage failed" } });
  }
});
