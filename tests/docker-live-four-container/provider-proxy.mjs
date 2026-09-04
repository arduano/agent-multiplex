#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";

const [bindHost, readyFile] = process.argv.slice(2);
const upstreamValue = process.env.AGENT_MULTIPLEX_PROVIDER_PROXY_UPSTREAM;
if (!bindHost || !readyFile || !upstreamValue) {
  throw new Error(
    "usage: AGENT_MULTIPLEX_PROVIDER_PROXY_UPSTREAM=<url> " +
      "provider-proxy.mjs <bind-host> <ready-file>",
  );
}

const upstream = new URL(upstreamValue);
if (!/^https?:$/.test(upstream.protocol) || upstream.username || upstream.password) {
  throw new Error("upstream must be a credential-free HTTP(S) URL");
}
if (upstream.search || upstream.hash) {
  throw new Error("upstream base URL must not contain a query or fragment");
}

const transport = upstream.protocol === "https:" ? https : http;
const server = http.createServer((request, response) => {
  const upstreamRequest = transport.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || undefined,
    method: request.method,
    path: request.url,
    headers: { ...request.headers, host: upstream.host },
    servername: upstream.hostname,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });

  upstreamRequest.setTimeout(15 * 60_000, () => {
    upstreamRequest.destroy(new Error("upstream request timed out"));
  });
  upstreamRequest.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end("provider relay unavailable\n");
    } else {
      response.destroy();
    }
  });
  request.pipe(upstreamRequest);
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, bindHost, resolve);
});
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("provider relay did not bind a TCP address");
}
await writeFile(
  readyFile,
  `${JSON.stringify({ bindHost, port: address.port, upstreamProtocol: upstream.protocol })}\n`,
  { mode: 0o600 },
);

const shutdown = () => server.close(() => process.exit(0));
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
