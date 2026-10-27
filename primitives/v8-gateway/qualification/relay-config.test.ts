import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { normalizeRelayPaths } from "../src/node/relay-config.js";
import type { RelayPathConfig } from "../src/node/relay-config.js";

test("each named relay path creates a separately constrained singleton endpoint configuration", () => {
  const configured = [
    { id: "primary", relayUrl: "https://RELAY-A.example:443/" },
    { id: "restricted-network", relayUrl: "https://relay-b.example:8443" },
  ];
  const paths = normalizeRelayPaths(configured);
  assert.deepEqual(paths.map(({ id, relayUrl }) => ({ id, relayUrl })), [
    { id: "primary", relayUrl: "https://relay-a.example" },
    { id: "restricted-network", relayUrl: "https://relay-b.example:8443" },
  ]);
  configured[0]!.relayUrl = "https://changed.example";
  assert.ok(Object.isFrozen(paths));
  for (const path of paths) {
    assert.ok(Object.isFrozen(path));
    const options = path.endpointOptions();
    assert.ok(Object.isFrozen(options));
    assert.ok(Object.isFrozen(options.relay));
    assert.deepEqual(options.relay, { mode: "custom", urls: [path.relayUrl] });
    if (options.relay?.mode !== "custom") assert.fail("Expected custom relay");
    assert.ok(Object.isFrozen(options.relay.urls));
    assert.deepEqual(options.discovery, { dns: false, mdns: false });
    assert.ok(Object.isFrozen(options.discovery));
    for (const address of ["127.0.0.1:42", "192.168.0.1:42", "[::1]:42", "203.0.113.1:42"]) {
      assert.equal(options.allowDirectAddress?.(address), false);
      assert.equal(options.allowAdvertisedAddress?.(address), false);
    }
    assert.equal(options.allowRelayUrl?.(path.relayUrl), true);
    for (const other of paths.filter(other => other !== path)) {
      assert.equal(options.allowRelayUrl?.(other.relayUrl), false);
    }
    assert.equal(options.allowRelayUrl?.(`${path.relayUrl}/untrusted`), false);
  }
});

test("private keys and authentication stay off normalized descriptions and are defensively copied", () => {
  const authToken = "private-relay-fixture-token", secretKey = new Uint8Array(32).fill(17);
  const paths = normalizeRelayPaths([{ id: "private", relayUrl: "https://relay.example", authToken, secretKey }]);
  const path = paths[0]!;
  const projected = JSON.stringify(paths);
  assert.deepEqual(JSON.parse(projected), [{ id: "private", relayUrl: "https://relay.example" }]);
  assert.ok(!projected.includes(authToken));
  assert.ok(!inspect(paths, { depth: 10 }).includes(authToken));
  assert.ok(!inspect(paths, { depth: 10 }).includes("Uint8Array"));
  secretKey.fill(99);
  const first = path.endpointOptions(), second = path.endpointOptions();
  assert.deepEqual(first.secretKey, new Uint8Array(32).fill(17));
  assert.notEqual(first.secretKey, second.secretKey);
  first.secretKey!.fill(33);
  assert.deepEqual(second.secretKey, new Uint8Array(32).fill(17));
  assert.deepEqual(path.endpointOptions().secretKey, new Uint8Array(32).fill(17));
  assert.equal(first.relay?.mode, "custom");
  if (first.relay?.mode === "custom") assert.equal(first.relay.authToken, authToken);
});

test("invalid paths fail atomically without echoing private configuration", () => {
  const valid = { id: "valid", relayUrl: "https://relay.example" };
  const badUrls = [
    "http://relay.example", "https://user:private-value@relay.example", "https://@relay.example",
    "https://relay.example/path", "https://relay.example/../", "https://relay.example/?private-value",
    "https://relay.example?", "https://relay.example/#private-value", "https://relay.example#",
    " https://relay.example", "https://relay.example/\n", "https:\\\\relay.example",
    "https://relay.example\\", "https://relay.example:0", "https://%72elay.example", "https://", "not-a-url-private-value",
  ];
  const invalid: unknown[] = [
    [], new Array(1), Array.from({ length: 17 }, (_, n) => ({ id: `p${n}`, relayUrl: `https://r${n}.example` })),
    [{ ...valid, id: "" }], [{ ...valid, id: "private-value/invalid" }], [{ ...valid, id: "a".repeat(65) }],
    [valid, { ...valid, relayUrl: "https://another.example" }],
    [valid, { ...valid, id: "different", relayUrl: "https://RELAY.EXAMPLE:443/" }],
    [{ ...valid, secretKey: new Uint8Array(31) }], [{ ...valid, secretKey: "private-value" }],
    [{ ...valid, secretKey: new Uint8Array(32).fill(7) },
      { id: "other", relayUrl: "https://another.example", secretKey: new Uint8Array(32).fill(7) }],
    [{ ...valid, authToken: "" }], [{ ...valid, authToken: "private-value\n" }],
    [{ ...valid, authToken: "private-value token" }], [{ ...valid, authToken: "private-value\u202e" }],
    [{ ...valid, authToken: "a".repeat(8193) }], [{ ...valid, authToken: null }],
    [{ ...valid, fallbackToDefault: true }], [null],
    ...badUrls.map(relayUrl => [{ ...valid, relayUrl }]),
  ];
  for (const candidate of invalid) {
    assert.throws(() => normalizeRelayPaths(candidate as readonly RelayPathConfig[]), error => {
      assert.ok(error instanceof TypeError || error instanceof RangeError);
      assert.ok(!error.message.includes("private-value"));
      return true;
    });
  }
  let accessed = false;
  const accessor = { ...valid, get authToken(): string { accessed = true; throw new Error("private-value"); } };
  assert.throws(() => normalizeRelayPaths([accessor]), /configuration is invalid/);
  assert.equal(accessed, false);
  assert.equal(normalizeRelayPaths([{ id: "local-tls", relayUrl: "https://127.0.0.1:9443" }]).length, 1);
});
