import { parentPort, workerData } from "node:worker_threads";
import { FileError } from "../contracts/types.js";
import { FileLedger } from "./ledger.js";
import type { FileHostOptions } from "./index.js";

const port = parentPort!;
let owner: FileLedger | undefined;
port.on("message", (message: { id: number; method: string; input: unknown; at: number }) => {
  try {
    if (message.method === "$open") owner = new FileLedger(workerData as FileHostOptions, message.at);
    else if (message.method === "$close") { owner!.close(); owner = undefined; }
    else {
      if (!owner) throw new FileError("CLOSED");
      const value = owner.call(message.method, message.input, message.at);
      port.postMessage({ id: message.id, value });
      return;
    }
    port.postMessage({ id: message.id });
  } catch (error) {
    // Paths, SQL statements and provider state never escape the private owner.
    port.postMessage({ id: message.id, error: error instanceof FileError
      ? { code: error.code, message: error.message }
      : { code: "IO", message: "File owner could not complete the operation" } });
  }
});
