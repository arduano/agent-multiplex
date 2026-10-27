import test from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { initTRPC } from "@trpc/server";
import { createSharedSecretSecurity } from "@arduano/p2prpc-core";
import type { ConnectOptions, P2PNode, P2PNodeOptions, PeerContext, SignedTicket, createP2PNode } from "@arduano/p2prpc-core";
import { normalizeRelayPaths } from "../src/node/relay-config.js";
import { openRelayNetwork } from "../src/node/relay-network.js";
import type { RelayPeer, RelayRoute } from "../src/node/relay-network.js";

const t = initTRPC.context<PeerContext>().create();
const router = t.router({ read: t.procedure.query(() => "one existing owner") });
const protocol = { applicationId: "fixture-relays", contractVersion: "1" };
const protocolName = "p2prpc/5/fixture-relays/1";
const paths = () => normalizeRelayPaths([
  { id: "public", relayUrl: "https://a.example" },
  { id: "restricted", relayUrl: "https://b.example" },
]);
const nodeOptions = () => ({ router, protocol,
  security: createSharedSecretSecurity(randomBytes(32), { authorize: () => true }),
  createContext: (context: PeerContext) => context,
});

function signingIdentity() {
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), randomBytes(32)]),
    type: "pkcs8", format: "der",
  });
  const bytes = createPublicKey(privateKey).export({ type: "spki", format: "der" }).subarray(-32);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let accumulator = 0, bits = 0, id = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; id += alphabet[(accumulator >>> bits) & 31]; }
  }
  if (bits) id += alphabet[(accumulator << (5 - bits)) & 31];
  const ticket = (relayUrl: string | null, overrides: Partial<SignedTicket> = {}): string => {
    const now = Date.now();
    const body = Buffer.from(JSON.stringify({ version: 3, peerId: id, directAddresses: [],
      relayUrl, protocol: protocolName, issuedAt: now, expiresAt: now + 60_000, ...overrides }));
    return `p2prpc3.${body.toString("base64url")}.${sign(null,
      Buffer.concat([Buffer.from("p2prpc-signed-ticket-v3\0"), body]), privateKey).toString("base64url")}`;
  };
  return { id, ticket };
}

function fixture(failure?: { createAt?: number; closeAt?: number }) {
  type Node = { id: string; relayUrl: string; closes: number; dials: ConnectOptions[];
    ticket: string; sign: ReturnType<typeof signingIdentity>["ticket"]; peer: { id: string }; closeGate?: Promise<void> };
  const nodes: Node[] = [], options: P2PNodeOptions<typeof router>[] = [];
  const factory = (async (input: P2PNodeOptions<typeof router>) => {
    options.push(input);
    if (options.length === failure?.createAt) throw new Error("private factory failure");
    assert.equal(input.iroh?.relay?.mode, "custom");
    if (input.iroh?.relay?.mode !== "custom") assert.fail("Expected a singleton custom relay");
    const relayUrl = input.iroh.relay.urls[0]!, identity = signingIdentity();
    const state: Node = { id: identity.id, relayUrl, closes: 0, dials: [],
      ticket: identity.ticket(relayUrl), sign: identity.ticket, peer: { id: `peer-${nodes.length}` } };
    nodes.push(state);
    return { id: state.id, ticket: () => state.ticket, createTicket: async () => state.ticket,
      connect: async (connect: ConnectOptions) => { state.dials.push(connect); return state.peer; },
      close: async () => { state.closes++; await state.closeGate;
        if (nodes.indexOf(state) + 1 === failure?.closeAt) throw new Error("private close failure"); },
    } as unknown as P2PNode<typeof router>;
  }) as typeof createP2PNode;
  return { factory, nodes, options };
}

function remote(relayUrl = "https://a.example", overrides: Partial<SignedTicket> = {}) {
  const identity = signingIdentity();
  const route: RelayRoute = { id: "remote", relayUrl, locator: { kind: "ticket", ticket: identity.ticket(relayUrl, overrides) } };
  const expected: RelayPeer = { expectedPeerId: identity.id,
    expectedPrincipal: { subject: "trusted independently configured account", issuer: null, clientId: null, tenantId: null } };
  return { identity, route, expected };
}

test("parallel paths share one configured router/security while pins remain independently trusted", async () => {
  const f = fixture(), shared = nodeOptions(), network = await openRelayNetwork({ paths: paths(), node: shared }, f.factory);
  try {
    assert.equal(f.nodes.length, 2);
    for (const option of f.options) {
      assert.equal(option.router, shared.router);
      assert.equal(option.security, shared.security);
      assert.equal(option.createContext, shared.createContext);
      assert.equal(option.iroh?.relay?.mode, "custom");
      if (option.iroh?.relay?.mode === "custom") assert.equal(option.iroh.relay.urls.length, 1);
    }
    const published = await network.path("public").route();
    assert.deepEqual(Object.keys(published).sort(), ["id", "locator", "relayUrl"]);
    assert.equal(published.id, "public");
    assert.equal(published.relayUrl, "https://a.example");
    const r = remote();
    const peer = await network.connect("public", r.route, r.expected);
    assert.equal(peer, f.nodes[0]!.peer);
    assert.deepEqual(f.nodes[0]!.dials, [{ locator: r.route.locator, ...r.expected }]);
    assert.equal(f.nodes[1]!.dials.length, 0);
    const racedDial = network.connect("public", r.route, r.expected);
    const closing = network.closePath("public");
    await assert.rejects(racedDial, { code: "CLOSED" });
    await closing;
    await network.closePath("public");
    assert.equal(f.nodes[0]!.closes, 1);
    assert.equal(f.nodes[1]!.closes, 0);
    assert.equal((await network.path("restricted").route()).relayUrl, "https://b.example");
    await assert.rejects(network.connect("public", r.route, r.expected), { code: "CLOSED" });
  } finally { await network.close(); }
  assert.deepEqual(f.nodes.map(node => node.closes), [1, 1]);
  await network.close();
  assert.deepEqual(f.nodes.map(node => node.closes), [1, 1]);
});

test("wrong-relay, wrong-peer, protocol, direct and invalid hints never reach the dialer", async () => {
  const f = fixture(), network = await openRelayNetwork({ paths: paths(), node: nodeOptions() }, f.factory);
  try {
    const r = remote(), wrongPeer = signingIdentity();
    const cases: [RelayRoute, RelayPeer][] = [
      [remote("https://b.example").route, r.expected],
      [{ ...r.route, relayUrl: "https://b.example" }, r.expected],
      [{ ...r.route, locator: { kind: "ticket", ticket: r.identity.ticket("https://b.example") } }, r.expected],
      [r.route, { ...r.expected, expectedPeerId: wrongPeer.id }],
      [{ ...r.route, locator: { kind: "ticket", ticket: r.identity.ticket("https://a.example", { protocol: "p2prpc/5/another/1" }) } }, r.expected],
      [{ ...r.route, locator: { kind: "ticket", ticket: r.identity.ticket("https://a.example", { directAddresses: ["127.0.0.1:9000"] }) } }, r.expected],
      [{ ...r.route, locator: { kind: "ticket", ticket: r.identity.ticket(null) } }, r.expected],
      [{ ...r.route, locator: { kind: "ticket", ticket: "private malformed locator" } }, r.expected],
      [{ ...r.route, locator: { kind: "ticket", ticket: r.identity.ticket("https://a.example", { issuedAt: 1, expiresAt: 2 }) } }, r.expected],
      [r.route, undefined as unknown as RelayPeer],
      [r.route, { expectedPeerId: r.expected.expectedPeerId } as RelayPeer],
    ];
    for (const [route, expected] of cases) {
      await assert.rejects(network.connect("public", route, expected), error => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes("private"));
        assert.equal((error as { code?: unknown }).code, "FENCED");
        return true;
      });
      assert.equal(f.nodes[0]!.dials.length, 0);
    }
    f.nodes[0]!.ticket = r.identity.ticket("https://a.example");
    await assert.rejects(network.path("public").route()); // A valid signature still cannot change this endpoint's identity.
  } finally { await network.close(); }
});

test("invalid path sets fail before opening any endpoint", async () => {
  const f = fixture(), configured = paths();
  for (const candidate of [[], [configured[0]!, configured[0]!],
    [Object.freeze({ ...configured[0]!, id: "invalid/path" })]]) {
    await assert.rejects(openRelayNetwork({ paths: candidate, node: nodeOptions() }, f.factory));
  }
  assert.equal(f.options.length, 0);
});

test("publishing requires the endpoint's current proved home and exposes no direct route", async () => {
  const f = fixture(), network = await openRelayNetwork({ paths: paths(), node: nodeOptions() }, f.factory);
  try {
    const state = f.nodes[0]!;
    const decoded = JSON.parse(Buffer.from(state.ticket.split(".")[1]!, "base64url").toString("utf8")) as SignedTicket;
    assert.equal(decoded.directAddresses.length, 0);
    assert.equal(decoded.relayUrl, "https://a.example");
    state.ticket = state.sign(null);
    await assert.rejects(network.path("public").route(), { code: "UNAVAILABLE" });
    state.ticket = state.sign("https://b.example");
    await assert.rejects(network.path("public").route());
    state.ticket = state.sign("https://a.example", { directAddresses: ["127.0.0.1:9000"] });
    await assert.rejects(network.path("public").route());
  } finally { await network.close(); }
});

test("one failed endpoint close cannot skip another path or retry physical closure", async () => {
  const f = fixture({ closeAt: 1 }), network = await openRelayNetwork({ paths: paths(), node: nodeOptions() }, f.factory);
  await assert.rejects(network.close(), error => {
    assert.ok(error instanceof AggregateError);
    assert.ok(!error.message.includes("private"));
    return true;
  });
  assert.deepEqual(f.nodes.map(node => node.closes), [1, 1]);
  await assert.rejects(network.close());
  assert.deepEqual(f.nodes.map(node => node.closes), [1, 1]);
});

test("partial startup closes every created endpoint and retains cleanup failure", async () => {
  for (const closeAt of [undefined, 1]) {
    const f = fixture({ createAt: 2, ...(closeAt === undefined ? {} : { closeAt }) });
    await assert.rejects(openRelayNetwork({ paths: paths(), node: nodeOptions() }, f.factory), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("private"));
      if (closeAt !== undefined) assert.ok(error instanceof AggregateError);
      return true;
    });
    assert.equal(f.options.length, 2);
    assert.deepEqual(f.nodes.map(node => node.closes), [1]);
  }
});
