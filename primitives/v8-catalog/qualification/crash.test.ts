import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { CatalogAuthority } from "../src/authority/catalog.js";
import { CreationFixture, fixture, request, scope, target } from "./fixtures.js";
test("actual authority process death after durable dispatch releases SQLite writer and never replays Create", async () => {
  const f = await fixture(); await f.authority.close(); const child = fork(new URL("./crash-child.js", import.meta.url), [f.directory], { env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { const observed = await Promise.race([once(child, "message"), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("owned child did not reach durable dispatch")), 20000); })]); assert.equal((observed[0] as { state: string }).state, "effectMayHaveStarted"); } finally { if (timer) clearTimeout(timer); }
    const ended = once(child, "exit"); child.kill("SIGKILL"); await ended;
    const a = await CatalogAuthority.open({ directory: f.directory, scope }), host = new CreationFixture(target); a.register(host);
    try { const c = await a.creation(scope, request().id); assert.equal(c!.state, "outcomeUnknown"); assert.equal(c!.entry.binding, null); assert.equal(host.creates.length, 0); assert.equal(host.reads.length, 1); } finally { await a.close(); }
  } finally { if (child.exitCode === null && child.signalCode === null) { const ended = once(child, "exit"); child.kill("SIGKILL"); await ended; } await f.dispose(); }
});
