import { createHash } from "node:crypto";
import { join } from "node:path";
import { FileHost } from "../src/host/index.js";
import type { FileManifest, FileScope } from "../src/contracts/types.js";

// Only forked by crash.test.ts against its disposable, parent-owned directory.
const root = process.argv[2];
if (!root || !process.send) throw new Error("Disposable crash child requires an IPC parent");
const scope: FileScope = { connection: "connection", principal: "owner", host: "host", session: "session" };
const data = Buffer.from("original exact bytes");
const manifest: FileManifest = { id: "original", name: "original.bin", mediaType: "application/octet-stream", bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") };
const host = await FileHost.open({ directory: join(root, "private"), bindings: [{ scope, cwd: join(root, "workspace"), dialect: "posix" }] });
await host.call("begin", { scope, manifest });
await host.call("write", { scope, id: manifest.id, offset: 0, data });
const held = { ...manifest, id: "held", name: "held.bin" };
await host.call("begin", { scope, manifest: held });
await host.call("write", { scope, id: held.id, offset: 0, data });
await host.call("commit", { scope, id: held.id });
await host.call("protect", { scope, operationId: "unclean-send", artifactIds: [held.id], consumers: ["native"] });
const status = await host.call("status", { scope, id: manifest.id });
const usage = await host.call("usage", { scope });
process.send({ kind: "acknowledged", offset: status.state === "uploading" ? status.offset : -1, walBytes: usage.walBytes });
// Leave the worker/database/IPC alive. The parent terminates this exact child with SIGKILL.
await new Promise<void>(() => {});
