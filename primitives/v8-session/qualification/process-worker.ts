import { spawn, type ChildProcess } from "node:child_process";

// Disposable Node execution fixture. Never imports a native SDK or provider.
const mode = process.argv[2];
const children = new Map<string, ChildProcess>();
const stalled = new Set<string>();
const stopping = new Set<string>();
const pendingStops = new Map<string, number>();
const timers = new Map<string, ReturnType<typeof setInterval>>();
function send(value: unknown): void { if (process.connected) process.send?.(value); }
const self = new URL(import.meta.url);
async function childFor(id: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [self.pathname, "tool", id], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: {} });
  children.set(id, child);
  return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("message", value => { send(value); resolve(child); });
  });
}
async function end(id: string): Promise<void> {
  const timer = timers.get(id); if (timer) clearInterval(timer); timers.delete(id);
  const child = children.get(id);
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve, reject) => { child.once("exit", () => resolve()); child.once("error", reject); child.kill("SIGTERM"); });
  }
  children.delete(id); stopping.delete(id);
}
if (mode === "grandchild") {
  setInterval(() => {}, 1000);
  send({ type: "grandchild", pid: process.pid });
} else if (mode === "tool") {
  const child = spawn(process.execPath, [self.pathname, "grandchild"], { stdio: ["ignore", "ignore", "ignore", "ipc"], env: {} });
  child.once("message", value => send({ type: "tool", id: process.argv[3], pid: process.pid, child: value }));
  process.once("SIGTERM", () => {
    child.once("exit", () => process.exit(0)); child.kill("SIGTERM");
  });
  setInterval(() => {}, 1000);
} else if (mode === "pool") {
  process.once("disconnect", () => {
    // Losing the disposable test parent must not leave fixture work behind.
    void Promise.all([...timers.keys()].map(end)).finally(() => process.exit(0));
  });
  process.on("message", async (raw: unknown) => {
    const message = raw as { id: string; type: string; request: number; tools?: boolean };
    try {
      if (message.type === "start") {
        if (message.tools) await childFor(message.id);
        timers.set(message.id, setInterval(() => {}, 1000));
      } else if (message.type === "stall") stalled.add(message.id);
      else if (message.type === "unblock") {
        stalled.delete(message.id);
        if (stopping.has(message.id)) {
          await end(message.id); send({ type: "stopped", id: message.id });
          send({ request: pendingStops.get(message.id), ok: true }); pendingStops.delete(message.id);
        }
      } else if (message.type === "stop") {
        if (stalled.has(message.id)) { stopping.add(message.id); pendingStops.set(message.id, message.request); return; }
        await end(message.id); send({ type: "stopped", id: message.id });
      } else if (message.type === "close") {
        for (const id of [...timers.keys()]) await end(id);
        send({ request: message.request, ok: true }); process.disconnect(); return;
      }
      send({ request: message.request, ok: true, roots: [...timers.keys()], rss: process.memoryUsage().rss });
    } catch { send({ request: message.request, ok: false }); }
  });
  send({ type: "ready", pid: process.pid });
} else throw new Error("Unknown disposable fixture mode");
