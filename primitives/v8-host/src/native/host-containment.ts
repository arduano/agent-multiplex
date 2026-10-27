import { spawn } from "node:child_process";
import { mkdir, open, readFile, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpeningIdentity, ParentStopProof } from "../../../v8-session/src/contracts/types.js";
import { copy } from "../../../v8-session/src/contracts/validation.js";
import { requireThat } from "../../../v8-runtime/src/validation.js";
import { bootPattern, cgroupPath, disappeared, invocationPattern, observeCgroup, sameCgroup, systemdCommands, type CgroupIdentity, type SystemdCommands } from "./cgroup.js";

export interface GateProcess { readonly exited: Promise<void>; terminate(): Promise<void> }
export interface HostContainmentCommands extends SystemdCommands {
  self(): Promise<Readonly<{ pid: number; invocation: string; cgroup: string }>>;
  createGroup(path: string): Promise<CgroupIdentity>;
  removeGroup(path: string, expected: CgroupIdentity): Promise<void>;
  enter(path: string, expected: CgroupIdentity): Promise<void>;
  spawnGate(directory: string): GateProcess;
}
const helper = fileURLToPath(new URL("./systemd-gate.js", import.meta.url));
const unitPattern = /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,200}\.service$/;
const pause = () => new Promise<void>(done => setTimeout(done, 20));
export function hostContainmentCommands(options: Readonly<{ systemctl: string }>): HostContainmentCommands {
  return {
    ...systemdCommands(options),
    async self() {
      const cgroup = (await readFile("/proc/self/cgroup", "utf8")).split("\n").find(line => line.startsWith("0::"))?.slice(3);
      const invocation = process.env.INVOCATION_ID; requireThat(cgroup && invocation && invocationPattern.test(invocation));
      return { pid: process.pid, invocation, cgroup };
    },
    async createGroup(path) {
      await mkdir(cgroupPath(path));
      const group = await systemdCommands(options).cgroup(path); requireThat(group.state === "empty"); return { device: group.device, inode: group.inode };
    },
    async removeGroup(path, expected) {
      let directory;
      try { directory = await open(cgroupPath(path), "r"); } catch (error) { if (disappeared(error)) return; throw error; }
      try {
        const info = await directory.stat({ bigint: true }); requireThat(String(info.dev) === expected.device && String(info.ino) === expected.inode, "Native subgroup changed before release");
        const events = await readFile(`/proc/self/fd/${directory.fd}/cgroup.events`, "utf8"); requireThat(/^populated 0$/m.test(events), "Native subgroup remains populated");
        // This delegated subtree has one writer. No new admission reuses a
        // released attachment name; a replacement observed above is refused.
        try { await rmdir(cgroupPath(path)); } catch (error) { if (!disappeared(error)) throw error; }
      } finally { await directory.close(); }
    },
    async enter(path, expected) {
      const directory = await open(cgroupPath(path), "r");
      try {
        const info = await directory.stat({ bigint: true }); requireThat(String(info.dev) === expected.device && String(info.ino) === expected.inode);
        await writeFile(`/proc/self/fd/${directory.fd}/cgroup.procs`, String(process.pid));
      } finally { await directory.close(); }
    },
    spawnGate(directory) {
      // This direct child is born inside the owning Host hierarchy. There is no
      // asynchronous service-manager admission which can outlive that hierarchy.
      const child = spawn(process.execPath, [helper, "--delegated-gate", directory], { stdio: ["ignore", "ignore", "inherit"] });
      const exited = new Promise<void>((done, reject) => { child.once("error", reject); child.once("close", () => done()); });
      return { exited, async terminate() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); await exited; } };
    },
  };
}
export function parentIdentity(identity: OpeningIdentity): Readonly<{ boot: string; invocation: string; device: string; inode: string }> {
  requireThat(identity.placement === "dedicated" && unitPattern.test(identity.attachment));
  const parts = /^systemd-host:([^:]+):([^:]+):(\d+):(\d+)$/.exec(identity.process);
  requireThat(parts && bootPattern.test(parts[1]!) && invocationPattern.test(parts[2]!));
  cgroupPath(identity.containment); requireThat(identity.containment.endsWith(`/inv-${parts[2]}`));
  return { boot: parts[1]!, invocation: parts[2]!, device: parts[3]!, inode: parts[4]! };
}
const proof = (identity: OpeningIdentity): ParentStopProof => ({ identity: copy(identity), state: "stopped", scope: "nativeTree", noAutomaticContinuation: true, acquisitionSealed: true });
/** A changed invocation name alone never proves retirement: old and new
 * invocation subgroups are observed independently by exact filesystem identity. */
export async function inspectHostContainment(identityInput: OpeningIdentity, port: Pick<SystemdCommands, "bootId" | "cgroup">): Promise<ParentStopProof | null> {
  const identity = copy(identityInput), expected = parentIdentity(identity);
  if (await port.bootId() !== expected.boot) return proof(identity);
  const observed = await observeCgroup(port, identity.containment);
  if (observed.state === "absent") return proof(identity);
  requireThat(sameCgroup(observed, expected), "Owning Host containment was replaced");
  return observed.state === "empty" ? proof(identity) : null;
}
/** Explicit foreground maintenance authority. The updater is outside this
 * hierarchy; no native inventory, journal adoption, or individual PID signals. */
export async function forceHostContainment(identityInput: OpeningIdentity, port: SystemdCommands): Promise<ParentStopProof> {
  const identity = copy(identityInput), expected = parentIdentity(identity);
  const prior = await inspectHostContainment(identity, port); if (prior) return prior;
  try { await port.killCgroup(identity.containment, expected); }
  catch (error) { if (!disappeared(error)) throw error; }
  const deadline = Date.now() + 5000;
  for (;;) { const retired = await inspectHostContainment(identity, port); if (retired) return retired; requireThat(Date.now() < deadline, "Owning Host retirement remains unconfirmed"); await pause(); }
}

/** One acquired, process-lifetime containment. Definitions/backends below it
 * remain inert; UI and Gateway connections have no authority over this owner. */
export class HostContainment {
  readonly identity: OpeningIdentity;
  readonly parentCustody;
  readonly commands: HostContainmentCommands;
  private constructor(identity: OpeningIdentity, commands: HostContainmentCommands) {
    this.identity = Object.freeze(copy(identity)); this.commands = commands;
    this.parentCustody = Object.freeze({ identity: this.identity, inspect: (saved: OpeningIdentity) => inspectHostContainment(saved, commands) });
  }
  static async acquire(options: Readonly<{ unit: string; systemctl: string }>, commands = hostContainmentCommands(options)): Promise<HostContainment> {
    requireThat(process.platform === "linux" && unitPattern.test(options.unit));
    const self = await commands.self(), boot = await commands.bootId(); requireThat(bootPattern.test(boot) && invocationPattern.test(self.invocation));
    const properties = ["Id", "MainPID", "InvocationID", "ControlGroup", "ActiveState", "Delegate", "KillMode", "Restart", "SendSIGKILL", "TimeoutStopUSec"];
    const text = await commands.exec("control", ["--user", "show", "--no-pager", `--property=${properties.join(",")}`, "--", options.unit]);
    const fields: Record<string, string> = {};
    for (const line of text.trim().split("\n")) { const at = line.indexOf("="), key = line.slice(0, at); requireThat(at > 0 && properties.includes(key) && !Object.hasOwn(fields, key)); fields[key] = line.slice(at + 1); }
    requireThat(properties.every(key => Object.hasOwn(fields, key)) && fields.Id === options.unit && fields.MainPID === String(self.pid) && fields.InvocationID === self.invocation && fields.ControlGroup === self.cgroup && fields.ActiveState === "active");
    requireThat(fields.Delegate === "yes" && fields.KillMode === "mixed" && fields.Restart === "no" && fields.SendSIGKILL === "yes" && ["1min", "60s", "60000000us"].includes(fields.TimeoutStopUSec!), "Owning service requires delegated bounded lifetime");
    const root = `${self.cgroup}/inv-${self.invocation}`, group = await commands.createGroup(root), control = `${root}/control`, leaf = await commands.createGroup(control);
    await commands.enter(control, leaf);
    const after = await commands.self(); requireThat(after.pid === self.pid && after.invocation === self.invocation && after.cgroup === control && await commands.bootId() === boot);
    return new HostContainment({ attachment: options.unit, process: `systemd-host:${boot}:${self.invocation}:${group.device}:${group.inode}`, containment: root, placement: "dedicated" }, commands);
  }
}
export const acquireHostContainment = (options: Readonly<{ unit: string; systemctl: string }>, commands?: HostContainmentCommands): Promise<HostContainment> => HostContainment.acquire(options, commands);
