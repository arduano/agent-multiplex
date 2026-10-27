import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { SessionHost } from "../../v8-lifecycle-default/src/session/index.js";
import { scope, ScriptedPort } from "./host-fixture.js";

test("Host SIGKILL after durable native-boundary receipt preserves unknown original without restarting native", { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(process.env.V8_SESSION_TMPDIR ?? tmpdir(), "v8-session-crash-"));
  const child = fork(fileURLToPath(new URL("./crash-child.js", import.meta.url)), [directory], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let host: SessionHost | undefined; let stderr = ""; child.stderr!.on("data", value => { stderr += String(value); });
  try {
    await Promise.race([new Promise<void>((resolve, reject) => { child.on("message", (message: { state?: string }) => { if (message.state === "unknown-receipt-durable") resolve(); }); child.once("exit", code => { reject(new Error(`child exited ${code}: ${stderr}`)); }); }), new Promise<void>((_, reject) => { const timer = setTimeout(() => reject(new Error("bounded child readiness expired")), 30000); timer.unref(); })]);
    const exited = once(child, "exit"); child.kill("SIGKILL"); const [, signal] = await exited; assert.equal(signal, "SIGKILL");
    const port = new ScriptedPort(); host = await SessionHost.open({ directory, scope, port, policy: { kind: "codex", access: { approval: "on-request", sandbox: "danger-full-access" }, provider: "copilot-only" }, observationMs: 100 });
    const snapshot = await host.snapshot(scope); assert.equal(snapshot.phase, "starting"); assert.equal(snapshot.nativeSession, null); assert.equal(snapshot.issue, "startUnconfirmed");
    assert.equal((await host.receipt(scope, "crash-create"))?.state, "outcomeUnknown");
    assert.equal((await host.submit({ scope, id: "no-replacement", generation: 1, command: { type: "create" } })).state, "refused");
    assert.equal(port.starts.length, 0); assert.equal(port.inspections.length, 0); await assert.rejects(host.close(), { code: "BUSY" });
  } finally { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; } await host?.terminate(); await rm(directory, { recursive: true, force: true }); }
});
