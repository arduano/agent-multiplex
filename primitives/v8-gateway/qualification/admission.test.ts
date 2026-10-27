import assert from "node:assert/strict";
import test from "node:test";
import {createServer, request as httpRequest} from "node:http";
import type {AddressInfo} from "node:net";
import {GatewayCoordinator} from "../src/gateway/coordinator.js";
import {createGatewayHttpHandler} from "../src/http/server.js";
import type {CatalogPort} from "../../v8-catalog/src/contracts/types.js";
import {alice, deferred} from "./fixture.js";

for (const boundary of ["authentication", "body"] as const) test(`actual HTTP seal fences a request still reading ${boundary} before dispatch`, {timeout: 10000}, async () => {
  const gateway = new GatewayCoordinator(), entered = deferred<void>(), release = deferred<void>();
  const scope = {connection: "fixture", principal: "alice", authority: "root"}; let mutations = 0;
  const port: CatalogPort = {list: async () => [], get: async () => null, creation: async () => null, subscribe: () => () => {},
    create: async () => { mutations++; throw Error("A sealed request reached mutation"); }, rename: async () => { throw Error("not used"); }, setWatched: async () => { throw Error("not used"); }, metadataOriginal: async () => null};
  gateway.registerCatalog({scope, owner: "catalog-owner", port});
  const handler = createGatewayHttpHandler(gateway, async () => { if (boundary === "authentication") { entered.resolve(); await release.promise; } return alice; });
  const server = createServer((request, response) => {
    if (boundary === "body") {
      const iterator = request[Symbol.asyncIterator].bind(request);
      // Instrument only this disposable IncomingMessage: entered means the
      // real handler has reached its actual async request-body reader.
      request[Symbol.asyncIterator] = async function* (): AsyncGenerator<any, undefined, any> { entered.resolve(); yield* iterator(); return undefined; };
    }
    handler(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const bytes = Buffer.from(JSON.stringify({op: "catalog.create", request: {scope, id: "original", session: "session", target: {host: "host", owner: "owner", kind: "codex", placement: "dedicated"}, metadata: {name: null, cwd: null}}}));
  const request = httpRequest(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v8`, {method: "POST", headers: {"content-type": "application/json", "content-length": bytes.length}});
  const response = new Promise<{status: number; body: string}>((resolve, reject) => { request.on("error", reject); request.on("response", value => { const chunks: Buffer[] = []; value.on("data", chunk => chunks.push(chunk)); value.on("end", () => resolve({status: value.statusCode!, body: Buffer.concat(chunks).toString()})); value.on("error", reject); }); });
  try {
    request.flushHeaders(); request.write(bytes.subarray(0, 1)); await entered.promise;
    handler.sealAdmissions(); release.resolve(); request.end(bytes.subarray(1));
    const result = await response; assert.equal(result.status, 409); assert.equal(JSON.parse(result.body).error, "CLOSED"); assert.equal(mutations, 0);
  } finally { release.resolve(); request.destroy(); handler.close(); gateway.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
