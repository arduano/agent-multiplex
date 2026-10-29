import assert from "node:assert/strict";
import { test } from "node:test";
import { scopeKey } from "../src/index.js";

test("logical scopes separate principals and cannot collide through chosen delimiters", () => {
  const scope = { connection: "one", principal: "owner", host: "host", session: "chat" };
  assert.notEqual(scopeKey(scope), scopeKey({ ...scope, principal: "partner" }));
  assert.notEqual(
    scopeKey({ ...scope, host: "host:chat", session: "other" }),
    scopeKey({ ...scope, host: "host", session: "chat:other" }),
  );
  assert.throws(() => scopeKey({ ...scope, principal: "" }), TypeError);
  assert.throws(() => scopeKey({ ...scope, session: "chat\nother" }), TypeError);
});
