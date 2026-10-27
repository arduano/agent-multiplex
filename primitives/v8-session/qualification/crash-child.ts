import { SessionHost } from "../../v8-lifecycle-default/src/session/index.js";
import { scope, ScriptedPort } from "./host-fixture.js";
const directory = process.argv[2]; if (!directory || !process.send) throw new Error("owned qualification child requires directory and IPC");
const port = new ScriptedPort(); port.startGate = new Promise(() => {});
port.onStart = () => { process.send!({ state: "native-boundary-entered" }); };
const host = await SessionHost.open({ directory, scope, port, policy: { kind: "codex", access: { approval: "on-request", sandbox: "danger-full-access" }, provider: "copilot-only" }, observationMs: 100 });
await host.submit({ scope, id: "crash-create", generation: 0, command: { type: "create" } });
process.send({ state: "unknown-receipt-durable" });
setInterval(() => {}, 1000);
