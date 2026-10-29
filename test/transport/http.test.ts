import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { createTRPCClient, httpBatchStreamLink } from "@trpc/client";
import { gatewayHttpHandler, type GatewayRouter } from "../../src/gateway/node.js";
import { bridgeHostUrl } from "../../src/transport/index.js";
import { fixture, viewer } from "../gateway/fixture.js";

test("Gateway HTTP authenticates only its topology; Host URLs point to the independent WSS route", async () => {
  const f = await fixture();
  const handler = gatewayHttpHandler(f.gateway, {
    async authenticate(request) {
      return request.headers.get("authorization") === "Bearer fixture" ? viewer : null;
    },
    maxBodyBytes: 8192,
  });
  const server = createServer((incoming, outgoing) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers))
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value);
    void handler(
      new Request(
        `http://127.0.0.1:${(server.address() as { port: number }).port}${incoming.url}`,
        { headers },
      ),
    )
      .then(async (response) => {
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      })
      .catch(() => outgoing.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const remote = createTRPCClient<GatewayRouter>({
    links: [
      httpBatchStreamLink<GatewayRouter>({
        url: url + "/trpc",
        headers: { authorization: "Bearer fixture" },
        maxItems: 1,
      }),
    ],
  });
  try {
    assert.equal((await fetch(url + "/not-mounted/topology")).status, 404);
    const untrusted = createTRPCClient<GatewayRouter>({
      links: [httpBatchStreamLink<GatewayRouter>({ url: url + "/trpc", maxItems: 1 })],
    });
    await assert.rejects(untrusted.topology.query(), /UNAUTHORIZED/);
    const foreign = createTRPCClient<GatewayRouter>({
      links: [
        httpBatchStreamLink<GatewayRouter>({
          url: url + "/trpc",
          headers: { authorization: "Bearer fixture", origin: "https://foreign.invalid" },
          maxItems: 1,
        }),
      ],
    });
    await assert.rejects(foreign.topology.query(), /FORBIDDEN/);
    assert.equal((await remote.topology.query()).length, 1);
    const target = encodeURIComponent(JSON.stringify(f.target()));
    assert.equal(
      (
        await fetch(url + "/trpc/lifecycle.change?target=" + target, {
          headers: { authorization: "Bearer fixture" },
        })
      ).status,
      404,
    );
    assert.equal(f.effects(), 0);
    assert.equal(f.gateway.readiness(), true);
    const bridge = new URL(bridgeHostUrl("https://gateway.invalid/path", f.target()));
    assert.equal(bridge.protocol, "wss:");
    assert.equal(bridge.pathname, "/host");
    assert.deepEqual(JSON.parse(bridge.searchParams.get("target")!), f.target());
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await f.close();
  }
});
