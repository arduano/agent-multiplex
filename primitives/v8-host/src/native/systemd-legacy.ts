/** Exact old independent-unit capsule inspection only. No allocation path. */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NativeOpening, OpeningCapsule, OpeningIdentity, OpeningStopProof } from "../../../v8-session/src/contracts/types.js";
import { canonical, copy } from "../../../v8-session/src/contracts/validation.js";
import { requireThat } from "../../../v8-runtime/src/validation.js";
import { cgroupPath, type Cgroup, type SystemdCommands } from "./cgroup.js";
type Allocation = Readonly<{
  version: 1; identity: OpeningIdentity; unit: string; invocation: string;
  bootId: string; cgroup: string; device: string; inode: string; reference: string; kind: "agent" | "reader";
}>;
type Unit = Readonly<Record<string, string>>;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const attachmentPattern = /^multiplex-v8-[a-f0-9-]{36}$/;
const bootPattern = /^[a-f0-9-]{36}$/;
const invocationPattern = /^[a-f0-9]{32}$/;
const properties = ["Id", "Description", "InvocationID", "ControlGroup", "ActiveState", "Restart", "KillMode", "ExitType", "Transient"];
const pause = () => new Promise<void>(resolveWait => setTimeout(resolveWait, 20));
const disappeared = (error: unknown): boolean => error instanceof Error && ["ENOENT", "ENODEV"].includes((error as NodeJS.ErrnoException).code ?? "");
async function listed(port: SystemdCommands, name: string): Promise<boolean> {
  const listing = await port.exec("control", ["--user", "--no-pager", "--no-legend", "--plain", "--full", "list-units", "--all", name]);
  const rows = listing.trim() ? listing.trim().split("\n") : [];
  requireThat(rows.length <= 1 && rows.every(row => row.trim().split(/\s+/)[0] === name), "Unexpected systemd unit listing");
  return rows.length !== 0;
}
async function unit(port: SystemdCommands, name: string): Promise<Unit | null> {
  if (!await listed(port, name)) return null;
  let output: string;
  try { output = await port.exec("control", ["--user", "--no-pager", "show", name, ...properties.map(property => `--property=${property}`)]); }
  catch (error) {
    // A collected transient unit may disappear after list-units. Only another
    // acknowledged exact-name listing can distinguish removal from read failure.
    if (!await listed(port, name)) return null;
    throw error;
  }
  const result: Record<string, string> = {};
  for (const line of output.trim().split("\n")) {
    const index = line.indexOf("="); requireThat(index > 0); const key = line.slice(0, index);
    requireThat(properties.includes(key) && !Object.hasOwn(result, key)); result[key] = line.slice(index + 1);
  }
  requireThat(properties.every(key => Object.hasOwn(result, key)) && result.Id === name);
  // systemctl may synthesize a default inactive record after --collect removes
  // the real invocation. The synthetic record is not an ownership observation.
  if (result.InvocationID === "" && result.ControlGroup === "" && result.ActiveState === "inactive" && result.Transient === "no" && !await listed(port, name)) return null;
  return result;
}
async function cgroup(port: SystemdCommands, path: string): Promise<Cgroup> {
  try { return await port.cgroup(path); }
  catch (error) {
    // Directory acquisition can succeed just before cgroup.events/cgroup.kill
    // disappears. Reopen once; only its returned identity/absence is evidence.
    if (!disappeared(error)) throw error;
    return port.cgroup(path);
  }
}
function checkUnit(value: Unit, expected: Pick<Allocation, "unit" | "reference" | "kind"> & Partial<Allocation>): void {
  requireThat(value.Id === expected.unit && value.Description === `Multiplex V8 ${expected.kind} ${expected.reference}` && value.Restart === "no" && value.KillMode === "control-group" && value.ExitType === "cgroup" && value.Transient === "yes", "Systemd allocation policy differs");
  requireThat(invocationPattern.test(value.InvocationID!) && value.ControlGroup?.endsWith(`/${expected.unit}`), "Systemd allocation identity is unavailable");
  if (expected.invocation) requireThat(value.InvocationID === expected.invocation && value.ControlGroup === expected.cgroup, "Systemd invocation changed");
}
async function state(port: SystemdCommands, receipt: Allocation): Promise<"created" | "running" | "gone"> {
  const boot = await port.bootId(); requireThat(bootPattern.test(boot));
  // A previous boot cannot retain this exact invocation. The gate also checks
  // boot identity before vendor spawn, so an old launcher cannot revive it.
  if (boot !== receipt.bootId) return "gone";
  const observed = await unit(port, receipt.unit), group = await cgroup(port, receipt.cgroup);
  if (observed) checkUnit(observed, receipt);
  if (group.state !== "absent") requireThat(group.device === receipt.device && group.inode === receipt.inode, "Native cgroup path was replaced");
  if (group.state === "populated") return observed ? "running" : "created";
  if (!observed || observed.ActiveState === "inactive" || observed.ActiveState === "failed") return "gone";
  // Unit/cgroup removal may be between observations. A live manager state is
  // never flattened to stopped because the directory disappeared first.
  return "created";
}
async function seal(directory: string): Promise<void> { await writeFile(join(directory, "sealed"), "sealed\n", { mode: 0o600 }); }
async function retire(port: SystemdCommands, receipt: Allocation, directory: string): Promise<OpeningIdentity> {
  await seal(directory);
  if (await state(port, receipt) === "gone") return copy(receipt.identity);
  const group = await cgroup(port, receipt.cgroup);
  if (group.state !== "absent") {
    requireThat(group.device === receipt.device && group.inode === receipt.inode);
    if (group.state === "populated") {
      try { await port.killCgroup(receipt.cgroup, receipt); }
      catch (error) {
        if (!disappeared(error)) throw error;
        const after = await cgroup(port, receipt.cgroup);
        requireThat(after.state === "absent" || (after.state === "empty" && after.device === receipt.device && after.inode === receipt.inode), "Exact native cgroup retirement remains unconfirmed");
      }
    }
  }
  const deadline = Date.now() + 5000;
  while (await state(port, receipt) !== "gone") { requireThat(Date.now() < deadline, "Exact native cgroup retirement remains unconfirmed"); await pause(); }
  return copy(receipt.identity);
}
async function receiptAt(options: Readonly<{ directory: string }>, capsule: OpeningCapsule, kind: "agent" | "reader"): Promise<{ receipt: Allocation; directory: string } | null> {
  if (!attachmentPattern.test(capsule.identity.attachment) || capsule.identity.placement !== "dedicated") return null;
  const directory = join(options.directory, capsule.identity.attachment), path = join(directory, "allocation.json");
  let stat;
  try { stat = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  requireThat(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.uid === process.getuid?.() && stat.size <= 8192);
  const directoryInfo = await lstat(directory);
  requireThat((await realpath(directory)) === directory && directoryInfo.isDirectory() && (directoryInfo.mode & 0o077) === 0 && directoryInfo.uid === process.getuid?.());
  const receipt = JSON.parse(await readFile(path, "utf8")) as Allocation;
  requireThat(receipt.version === 1 && receipt.unit === `${capsule.identity.attachment}.service` && canonical(receipt.identity) === canonical(capsule.identity) && receipt.reference === hash(canonical(capsule.opening)) && receipt.kind === kind && bootPattern.test(receipt.bootId) && invocationPattern.test(receipt.invocation));
  requireThat(receipt.identity.process === `systemd-user:${receipt.bootId}:${receipt.invocation}` && receipt.cgroup === receipt.identity.containment && /^\d+$/.test(receipt.inode) && /^\d+$/.test(receipt.device));
  cgroupPath(receipt.cgroup); return { receipt, directory };
}

export async function inspectLegacySystemdOpening(options: Readonly<{ directory: string }>, capsule: OpeningCapsule, kind: "agent" | "reader", port: SystemdCommands): Promise<NativeOpening | OpeningStopProof | null> {
  const fixed = copy({ opening: capsule.opening, identity: capsule.identity }), found = await receiptAt(options, fixed, kind); if (!found) return null;
  const proof = (): OpeningStopProof => ({ ...fixed, state: "stopped", scope: "nativeTree", noAutomaticContinuation: true, acquisitionSealed: true });
  if (await state(port, found.receipt) === "gone") return proof();
  let stopping: Promise<OpeningStopProof> | undefined;
  return { ...fixed, stop: () => stopping ??= (async () => { await retire(port, found.receipt, found.directory); return proof(); })() };
}
