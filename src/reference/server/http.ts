import type { ServeOptions } from "../node-contracts.js";
import { createServer, type Server } from "node:http";
import { Readable } from "node:stream";
import { once } from "node:events";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
/** One explicit Node HTTP process owner. The injected Fetch handler owns auth,
 * routes and effects. Socket loss aborts observations, never admitted work. */
export async function serve(options: ServeOptions) {
  const assets = options.assets ? await realpath(options.assets) : undefined;
  const server = createServer((incoming, outgoing) => {
    const controller = new AbortController();
    incoming.once("aborted", () => controller.abort());
    outgoing.once("close", () => controller.abort());
    void (async () => {
      let request: Request;
      try {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers))
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
        const authority = headers.get("host") ?? "127.0.0.1";
        request = new Request(`http://${authority}${incoming.url ?? "/"}`, {
          method: incoming.method ?? "GET",
          headers,
          signal: controller.signal,
          ...(incoming.method !== "GET" && incoming.method !== "HEAD"
            ? { body: Readable.toWeb(incoming), duplex: "half" }
            : {}),
        } as RequestInit);
      } catch {
        outgoing.writeHead(400, { "content-type": "application/json" });
        outgoing.end('{"error":"INVALID"}');
        return;
      }
      let response: Response;
      const path = new URL(request.url).pathname;
      if (assets && request.method === "GET" && ["/", "/app.js", "/app.css"].includes(path)) {
        const filename = resolve(assets, path === "/" ? "index.html" : path.slice(1));
        if (!filename.startsWith(assets + sep)) throw Error("Asset path fenced");
        response = new Response(Uint8Array.from(await readFile(filename)), {
          headers: {
            "content-type":
              path === "/"
                ? "text/html; charset=utf-8"
                : path.endsWith(".js")
                  ? "text/javascript; charset=utf-8"
                  : "text/css; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          },
        });
      } else response = await options.handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) {
        outgoing.end();
        return;
      }
      const reader = response.body.getReader();
      try {
        while (!controller.signal.aborted) {
          const part = await reader.read();
          if (part.done) break;
          if (!outgoing.write(part.value))
            await Promise.race([once(outgoing, "drain"), once(outgoing, "close")]);
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        outgoing.end();
      }
    })().catch(() => {
      if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "application/json" });
      outgoing.end('{"error":"INTERNAL"}');
    });
  });
  if (options.upgrade) server.on("upgrade", options.upgrade);
  const listening = new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => resolve());
  });
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw Error("HTTP listener unavailable");
  let closed: Promise<void> | undefined;
  return {
    server,
    url: `http://${options.host ?? "127.0.0.1"}:${address.port}`,
    close() {
      return (closed ??= close(server));
    },
  };
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
