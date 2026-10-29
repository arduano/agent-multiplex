import assert from "node:assert/strict";
import { test } from "node:test";
import {
  McpOwner,
  publicMcpServers,
  type Delivery,
  type PrivateMcpServer,
} from "../../src/interactions/index.js";
import { admitted, attachment, deferred, run } from "./fixture.js";

test("static MCP contributions expose no private descriptor data and never insert a routine approval", () => {
  const definitions: readonly PrivateMcpServer[] = [
    {
      name: "local",
      enabled: true,
      tools: "enabled",
      transport: {
        type: "stdio",
        command: "/private/tool",
        args: ["--set", "one", "--set", "two"],
        env: { TOKEN: "private-secret" },
        cwd: "/private/cwd",
      },
    },
    {
      name: "remote",
      enabled: true,
      tools: ["read"],
      transport: {
        type: "http",
        url: "https://user:private-secret@example.test/mcp?key=private-secret",
        headers: { Authorization: "private-secret" },
      },
    },
  ];
  const publicValue = publicMcpServers(definitions);
  assert.equal(publicValue[0]!.tools, "enabled");
  assert.equal(publicValue[0]!.serverConfirmations, "surface");
  const serialized = JSON.stringify(publicValue);
  for (const privateValue of [
    "private-secret",
    "example.test",
    "/private",
    "Authorization",
    "TOKEN",
  ])
    assert(!serialized.includes(privateValue));
  assert(Object.isFrozen(publicValue[1]!.tools));
  assert.throws(() => publicMcpServers([...definitions, definitions[0]!]), /INVALID/);
});

test("login retains its actual operation across observer expiry, abort and lost reply without replay", async () => {
  const native = deferred<Delivery>();
  let calls = 0;
  const owner = new McpOwner<Readonly<{ server: string }>, Readonly<{ server: string }>>(
    run,
    attachment,
    {
      adapter: "scripted",
      login: async () => {
        calls++;
        return native.promise;
      },
    },
    { maxPending: 1 },
  );
  assert.equal(calls, 0);
  const handle = owner.login(admitted("login"), { server: "one" });
  assert.equal(owner.login(admitted("login"), { server: "one" }), handle);
  assert.equal(owner.actualCount, 1);
  assert.deepEqual(await handle.observe(0), { state: "waitingExpired" });
  const abort = new AbortController(),
    wait = handle.observe(1000, abort.signal);
  abort.abort();
  await assert.rejects(wait, { name: "AbortError" });
  assert.equal(calls, 1);
  assert.equal(owner.actualCount, 1);
  assert.throws(() => owner.login(admitted("other"), { server: "one" }), /FULL/);
  native.reject(new Error("secret failure"));
  assert.equal((await handle.observe(1000)).state, "unknown");
  assert.equal(owner.actualCount, 0);
  assert.equal(owner.login(admitted("login"), { server: "one" }), handle);
  assert.equal(calls, 1);
  assert.throws(() => owner.login(admitted("other"), { server: "one" }), /FULL/);
  owner.confirm(run, attachment, admitted("login"), true);
  assert.equal(handle.getSnapshot().state, "confirmed");
  assert(!JSON.stringify(owner.getSnapshot()).includes("secret"));
});

test("positive Stop and early confirmation cannot release an outstanding native call or accept its late replacement", async () => {
  const native = deferred<Delivery>();
  let calls = 0;
  const owner = new McpOwner<null, null>(run, attachment, {
    adapter: "scripted",
    reload: async () => {
      calls++;
      return native.promise;
    },
  });
  const handle = owner.reload(admitted("reload"), null);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.throws(
    () => owner.confirm({ ...run, generation: 2 }, attachment, admitted("reload"), true),
    /FENCED/,
  );
  owner.confirm(run, attachment, admitted("reload"), true);
  assert.equal(owner.actualCount, 1);
  owner.confirmedStopped({ run, attachment, confirmed: true });
  assert.equal(owner.actualCount, 1);
  native.resolve({ kind: "confirmed", accepted: false });
  assert.equal((await handle.observe(1000)).state, "confirmed");
  assert.equal(handle.getSnapshot().accepted, true);
  assert.equal(owner.actualCount, 0);
  assert.throws(() => owner.reload(admitted("new"), null), /FENCED/);
  const rolling = new McpOwner<null, null>(
    run,
    attachment,
    { adapter: "scripted", reload: async () => ({ kind: "confirmed", accepted: true }) },
    { maxRecent: 2 },
  );
  for (let index = 0; index < 40; index++)
    await rolling.reload(admitted(`reload-${index}`), null).observe(1000);
  assert.equal(rolling.getSnapshot().length, 2);
  assert.equal(handle.getSnapshot().accepted, true);
});
