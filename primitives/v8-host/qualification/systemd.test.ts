import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "../../v8-session/src/contracts/validation.js";
import type { OpeningRef } from "../../v8-session/src/contracts/types.js";
import { acquireHostContainment, forceHostContainment, inspectHostContainment, systemdUserAllocation, type HostContainmentCommands } from "../src/native/systemd.js";
import type { NativeAllocationOptions } from "../src/native/allocation.js";
import type { CgroupIdentity } from "../src/native/cgroup.js";

const boot = "00000000-0000-4000-8000-000000000001", invocation = "a".repeat(32), unit = "multiplex-owned-fixture.service", serviceGroup = `/user.slice/app.slice/${unit}`;
const opening: OpeningRef = { scope: { connection: "connection", principal: "principal", host: "host", session: "session" }, generation: 1, operationId: "create-original" };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; };
class Manager implements HostContainmentCommands {
  readonly calls: readonly string[][] = []; readonly kills: string[] = [];
  readonly groups = new Map<string, { device: string; inode: string; populated: boolean }>();
  readonly gates = new Map<string, { group: string; finish(): void }>();
  current = { pid: 123, invocation, cgroup: serviceGroup }; nextInode = 100; boot = boot;
  readonly spawning = deferred(); barrier: Promise<void> | undefined; delegated = true;
  restart = "no"; killMode = "mixed"; sendSigkill = "yes"; stopTimeout = "1min";
  async exec(_tool: "control", args: readonly string[]) {
    (this.calls as string[][]).push([...args]);
    assert.ok(args.includes("show"));
    return Object.entries({ Id: unit, MainPID: String(this.current.pid), InvocationID: this.current.invocation, ControlGroup: serviceGroup,
      ActiveState: "active", Delegate: this.delegated ? "yes" : "no", KillMode: this.killMode, Restart: this.restart, SendSIGKILL: this.sendSigkill, TimeoutStopUSec: this.stopTimeout }).map(([key, value]) => `${key}=${value}`).join("\n");
  }
  async self() { return { ...this.current }; }
  async bootId() { return this.boot; }
  async createGroup(path: string) { assert.equal(this.groups.has(path), false); const value = { device: "1", inode: String(++this.nextInode), populated: false }; this.groups.set(path, value); return { device: value.device, inode: value.inode }; }
  async enter(path: string, expected: CgroupIdentity) { const value = this.groups.get(path)!; assert.equal(value.inode, expected.inode); this.current.cgroup = path; value.populated = true; }
  async removeGroup(path: string, expected: CgroupIdentity) { const value = await this.cgroup(path); if (value.state === "absent") return; assert.equal(value.state, "empty"); assert.equal(value.device, expected.device); assert.equal(value.inode, expected.inode); this.groups.delete(path); }
  async cgroup(path: string) {
    const value = this.groups.get(path); if (!value) return { state: "absent" as const };
    const populated = [...this.groups].some(([key, group]) => (key === path || key.startsWith(path + "/")) && group.populated);
    return { state: populated ? "populated" as const : "empty" as const, device: value.device, inode: value.inode };
  }
  async killCgroup(path: string, expected: CgroupIdentity) {
    const value = this.groups.get(path)!; assert.equal(value.device, expected.device); assert.equal(value.inode, expected.inode); this.kills.push(path);
    for (const [key, group] of this.groups) if (key === path || key.startsWith(path + "/")) group.populated = false;
    for (const gate of this.gates.values()) if (gate.group === path || gate.group.startsWith(path + "/")) gate.finish();
  }
  spawnGate(directory: string) {
    const done = deferred(); let alive = true; let group = "";
    const finish = () => { alive = false; if (group) this.groups.get(group)!.populated = false; done.resolve(); };
    const started = (async () => { const receipt = JSON.parse(await readFile(join(directory, "allocation.json"), "utf8")); group = receipt.cgroup; this.gates.set(directory, { group, finish }); this.spawning.resolve(); if (this.barrier) await this.barrier; if (alive) { this.groups.get(group)!.populated = true; await writeFile(join(directory, "gate-ready"), "scripted ready"); } })();
    void started.catch(() => finish());
    return { exited: done.promise, async terminate() { finish(); await started; await done.promise; } };
  }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "v8-host-hierarchy-")), directory = join(root, "custody"), packageRoot = join(root, "package");
  await mkdir(packageRoot); const binary = join(packageRoot, "native"); await writeFile(binary, "scripted, never launched");
  const manager = new Manager(), containment = await acquireHostContainment({ unit, systemctl: "/fixture/systemctl" }, manager);
  const options: NativeAllocationOptions = { directory, binary, packageRoot, home: join(root, "home"), cwd: join(root, "workspace"), args: ["app-server", "--stdio"], environment: { PATH: "/configured/bin", PROVIDER_SECRET: "private-fixture-value" }, reference: canonical(opening), kind: "agent" };
  const config = { directory, containment }, backend = systemdUserAllocation(config);
  return { root, directory, manager, containment, options, config, backend, dispose: () => rm(root, { recursive: true, force: true }) };
}

test("failure-restarted owning services retain exact invocation fences without automatically opening native allocations", async () => {
  const manager = new Manager(); manager.restart = "on-failure";
  const first = await acquireHostContainment({ unit, systemctl: "/fixture/systemctl" }, manager);
  assert.equal(manager.gates.size, 0); assert.deepEqual(manager.kills, []);
  manager.current = { pid: 456, invocation: "b".repeat(32), cgroup: serviceGroup };
  const replacement = await acquireHostContainment({ unit, systemctl: "/fixture/systemctl" }, manager);
  assert.notEqual(first.identity.process, replacement.identity.process);
  assert.notEqual(first.identity.containment, replacement.identity.containment);
  assert.equal(await inspectHostContainment(first.identity, manager), null, "Failure restart cannot certify the old populated invocation as stopped");
  assert.equal(await inspectHostContainment(replacement.identity, manager), null);
  assert.equal(manager.calls.length, 2); assert.equal(manager.gates.size, 0); assert.deepEqual(manager.kills, []);
});

test("owning service restart acceptance stays closed and preserves delegated bounded-stop requirements", async () => {
  for (const policy of ["always", "on-success", "on-abnormal", "on-abort", "on-watchdog", "unknown"]) {
    const manager = new Manager(); manager.restart = policy;
    await assert.rejects(acquireHostContainment({ unit, systemctl: "/fixture/systemctl" }, manager), /delegated bounded lifetime/);
    assert.equal(manager.groups.size, 0); assert.equal(manager.gates.size, 0);
  }
  for (const change of [{ delegated: false }, { killMode: "process" }, { sendSigkill: "no" }, { stopTimeout: "infinity" }]) {
    const manager = new Manager(); manager.restart = "on-failure"; Object.assign(manager, change);
    await assert.rejects(acquireHostContainment({ unit, systemctl: "/fixture/systemctl" }, manager), /delegated bounded lifetime/);
    assert.equal(manager.groups.size, 0); assert.equal(manager.gates.size, 0);
  }
});

test("one acquired Host hierarchy replaces independent units; exact session Stop retains peer and private gate custody", async () => {
  const f = await fixture();
  try {
    assert.equal(f.manager.calls.length, 1); const owner = f.backend.allocate(f.options); assert.equal(f.manager.calls.length, 1);
    const held = await owner.opening(opening), prepared = await owner.prepare();
    const peerOpening = { ...opening, operationId: "other-session", scope: { ...opening.scope, session: "peer" } };
    const peer = f.backend.allocate({ ...f.options, reference: canonical(peerOpening) }), peerHeld = await peer.opening(peerOpening);
    const receipt = JSON.parse(await readFile(join(f.directory, held.identity.attachment, "allocation.json"), "utf8"));
    assert.equal(receipt.version, 2); assert.deepEqual(receipt.parent, f.containment.identity); assert.ok(held.identity.containment.startsWith(f.containment.identity.containment + "/"));
    assert.match(await readFile(prepared.launcher, "utf8"), /runSystemdLauncher/); assert.equal(JSON.stringify(receipt).includes("private-fixture-value"), false);
    const restored = await systemdUserAllocation(f.config).inspectOpening(held); assert.ok(restored && "stop" in restored);
    const stopping = restored.stop(); assert.equal(stopping, restored.stop()); await stopping; assert.equal(f.manager.groups.has(held.identity.containment), false, "Stop releases the exact empty kernel subgroup");
    assert.equal(await owner.inspect(), "gone"); assert.equal(await peer.inspect(), "running"); assert.deepEqual(f.manager.kills, [held.identity.containment]);
    assert.equal((await f.manager.cgroup(peerHeld.identity.containment)).state, "populated"); assert.equal(f.manager.calls.length, 1, "no per-session manager or prerequisite calls");
    await peer.stop();
  } finally { await f.dispose(); }
});

test("whole-Host force retires a pre-capsule pending gate without discovering allocations", async () => {
  const f = await fixture();
  try {
    const barrier = deferred(); f.manager.barrier = barrier.promise;
    const owner = f.backend.allocate(f.options), preparing = owner.prepare(); void preparing.catch(() => undefined);
    await f.manager.spawning.promise; assert.ok(owner.identity, "subgroup receipt precedes gate readiness and SessionHost capsule");
    assert.equal(await f.backend.parentCustody!.inspect(f.containment.identity), null);
    const proof = await forceHostContainment(f.containment.identity, f.manager); assert.equal(proof.acquisitionSealed, true);
    barrier.resolve(); await assert.rejects(preparing, /unconfirmed|sealed/); await owner.stop();
    assert.deepEqual(f.manager.kills, [f.containment.identity.containment]); assert.equal(await owner.inspect(), "gone");
    assert.equal(f.manager.calls.length, 1); assert.equal(f.manager.gates.size, 1);
  } finally { await f.dispose(); }
});

test("per-session Stop seals pending placement and awaits its owned gate; no replacement or late launch", async () => {
  const f = await fixture();
  try {
    const barrier = deferred(); f.manager.barrier = barrier.promise;
    const owner = f.backend.allocate(f.options), preparing = owner.prepare(); void preparing.catch(() => undefined); await f.manager.spawning.promise;
    const stopping = owner.stop(); barrier.resolve(); await assert.rejects(preparing, /unconfirmed|sealed/); await stopping;
    assert.equal(owner.sealed, true); assert.equal(await owner.inspect(), "gone"); assert.equal(f.manager.gates.size, 1); assert.throws(() => owner.assertLaunchable());
  } finally { await f.dispose(); }
});

test("parent proof distinguishes invocations and rejects cgroup replacement or missing delegation", async () => {
  const f = await fixture();
  try {
    const old = f.containment.identity; f.manager.current = { pid: 456, invocation: "b".repeat(32), cgroup: serviceGroup };
    const replacement = await acquireHostContainment({ unit, systemctl: "/fixture/systemctl" }, f.manager);
    assert.notEqual(old.containment, replacement.identity.containment);
    assert.equal(await inspectHostContainment(old, f.manager), null, "new invocation does not prove old subtree retirement");
    await forceHostContainment(old, f.manager); assert.ok(await inspectHostContainment(old, f.manager)); assert.equal(await inspectHostContainment(replacement.identity, f.manager), null);
    f.manager.groups.get(old.containment)!.inode = "different"; await assert.rejects(inspectHostContainment(old, f.manager), /replaced/);
    f.manager.current = { pid: 789, invocation: "c".repeat(32), cgroup: serviceGroup }; f.manager.delegated = false;
    await assert.rejects(acquireHostContainment({ unit, systemctl: "/fixture/systemctl" }, f.manager));
    assert.throws(() => systemdUserAllocation({ directory: f.directory, containment: undefined! }), /required/);
  } finally { await f.dispose(); }
});
