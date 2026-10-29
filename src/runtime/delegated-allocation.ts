import { delegatedAttachmentPrefix, delegatedReceiptVersion } from "./allocation-format.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type {
  NativeOpening,
  NativeAllocation,
  NativeAllocationBackend,
  NativeAllocationOptions,
  OpeningCapsule,
  OpeningIdentity,
  OpeningRef,
  OpeningStopProof,
} from "./contracts.js";
import { canonical, copy } from "./validation.js";
import { requireThat } from "./validation.js";
import { disappeared, observeCgroup, sameCgroup } from "./cgroup.js";
import { HostContainment, inspectHostContainment, parentIdentity } from "./host-containment.js";
import type { CgroupIdentity, GateProcess, SystemdUserOptions } from "./node-contracts.js";
import type { GateConfiguration } from "./systemd-gate.js";
type Allocation = Readonly<
  CgroupIdentity & {
    version: 1;
    identity: OpeningIdentity;
    parent: OpeningIdentity;
    bootId: string;
    invocation: string;
    cgroup: string;
    reference: string;
    kind: "agent" | "reader";
  }
>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const attachmentPattern = new RegExp(`^${delegatedAttachmentPrefix}[a-f0-9-]{36}$`);
const pause = () => new Promise<void>((done) => setTimeout(done, 20));
async function readReceipt(
  options: SystemdUserOptions,
  capsule: OpeningCapsule,
  kind: "agent" | "reader",
): Promise<Readonly<{ receipt: Allocation; directory: string }> | null> {
  if (
    !attachmentPattern.test(capsule.identity.attachment) ||
    capsule.identity.placement !== "dedicated"
  )
    return null;
  const directory = join(options.directory, capsule.identity.attachment),
    filename = join(directory, "allocation.json");
  let info;
  try {
    info = await lstat(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  requireThat(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.uid === process.getuid?.() &&
      !(info.mode & 0o077) &&
      info.size <= 8192,
  );
  const parent = await lstat(directory);
  requireThat(
    parent.isDirectory() &&
      !parent.isSymbolicLink() &&
      !(parent.mode & 0o077) &&
      parent.uid === process.getuid?.() &&
      (await realpath(directory)) === directory,
  );
  const receipt = JSON.parse(await readFile(filename, "utf8")) as Allocation,
    stamp = parentIdentity(receipt.parent);
  requireThat(
    receipt.version === delegatedReceiptVersion &&
      canonical(receipt.identity) === canonical(capsule.identity) &&
      receipt.kind === kind &&
      receipt.reference === hash(canonical(capsule.opening)) &&
      receipt.bootId === stamp.boot &&
      receipt.invocation === stamp.invocation,
  );
  requireThat(
    receipt.identity.process === receipt.parent.process &&
      receipt.cgroup === receipt.identity.containment &&
      receipt.cgroup === `${receipt.parent.containment}/${capsule.identity.attachment}` &&
      /^\d+$/.test(receipt.device) &&
      /^\d+$/.test(receipt.inode),
  );
  return { receipt, directory };
}
async function retired(options: SystemdUserOptions, receipt: Allocation): Promise<boolean> {
  const commands = options.containment.commands;
  if (await inspectHostContainment(receipt.parent, commands)) return true;
  const group = await observeCgroup(commands, receipt.cgroup);
  if (group.state === "absent") return true;
  requireThat(sameCgroup(group, receipt), "Native subgroup identity changed");
  return group.state === "empty";
}
async function retire(
  options: SystemdUserOptions,
  receipt: Allocation,
  directory: string,
  gate?: GateProcess,
): Promise<OpeningIdentity> {
  await writeFile(join(directory, "sealed"), "sealed\n", { mode: 0o600 });
  // A gate awaiting subgroup placement is still an owned direct child.
  if (gate) await gate.terminate();
  if (!(await retired(options, receipt))) {
    try {
      await options.containment.commands.killCgroup(receipt.cgroup, receipt);
    } catch (error) {
      if (!disappeared(error)) throw error;
    }
  }
  const deadline = Date.now() + 5000;
  while (!(await retired(options, receipt))) {
    requireThat(Date.now() < deadline, "Native subgroup retirement remains unconfirmed");
    await pause();
  }
  await options.containment.commands.removeGroup(receipt.cgroup, receipt);
  return copy(receipt.identity);
}
class SubgroupAllocation implements NativeAllocation {
  readonly #attachment = `${delegatedAttachmentPrefix}${randomUUID()}`;
  readonly #options: NativeAllocationOptions;
  readonly #config: SystemdUserOptions;
  #receipt: Allocation | undefined;
  #directory: string | undefined;
  #gate: GateProcess | undefined;
  #prepared: Promise<Readonly<{ launcher: string; identity: OpeningIdentity }>> | undefined;
  #sealed = false;
  #stopping: Promise<OpeningIdentity> | undefined;
  constructor(options: NativeAllocationOptions, config: SystemdUserOptions) {
    requireThat(
      options.directory === config.directory && ["agent", "reader"].includes(options.kind),
    );
    for (const path of [
      options.directory,
      options.binary,
      options.packageRoot,
      options.home,
      options.cwd,
    ])
      requireThat(isAbsolute(path) && !/[\r\n\0]/.test(path));
    requireThat(
      options.args.every((value) => typeof value === "string" && !value.includes("\0")) &&
        options.reference.length > 0 &&
        options.reference.length <= 16384,
    );
    for (const [key, value] of Object.entries(options.environment))
      requireThat(
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) &&
          typeof value === "string" &&
          !/[\r\n\0]/.test(value),
      );
    this.#options = copy(options);
    this.#config = config;
  }
  get identity(): OpeningIdentity | null {
    return this.#receipt ? copy(this.#receipt.identity) : null;
  }
  get sealed(): boolean {
    return this.#sealed;
  }
  prepare() {
    requireThat(!this.#sealed, "Native acquisition is sealed");
    return (this.#prepared ??= this.#prepare());
  }
  async #prepare() {
    const options = this.#options,
      config = this.#config,
      parent = config.containment.identity,
      stamp = parentIdentity(parent);
    requireThat(
      !(await config.containment.parentCustody.inspect(parent)),
      "Owning Host has retired",
    );
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const base = await realpath(options.directory),
      info = await lstat(base);
    requireThat(
      base === options.directory &&
        info.isDirectory() &&
        info.uid === process.getuid?.() &&
        !(info.mode & 0o077),
    );
    for (const path of [options.home, options.cwd]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      requireThat((await lstat(path)).isDirectory() && !(await lstat(path)).isSymbolicLink());
    }
    const directory = join(base, this.#attachment);
    await mkdir(directory, { mode: 0o700 });
    this.#directory = directory;
    const cgroup = `${parent.containment}/${this.#attachment}`,
      group = await config.containment.commands.createGroup(cgroup);
    const identity: OpeningIdentity = {
      attachment: this.#attachment,
      process: parent.process,
      containment: cgroup,
      placement: "dedicated",
    };
    const receipt: Allocation = {
      version: delegatedReceiptVersion,
      identity,
      parent,
      bootId: stamp.boot,
      invocation: stamp.invocation,
      cgroup,
      ...group,
      reference: hash(options.reference),
      kind: options.kind,
    };
    this.#receipt = receipt;
    await writeFile(join(directory, "allocation.json"), JSON.stringify(receipt), {
      mode: 0o600,
      flag: "wx",
    });
    const gate: GateConfiguration = {
      binary: options.binary,
      args: options.args,
      cwd: options.cwd,
      environment: options.environment,
      nonce: randomBytes(32).toString("hex"),
      ...(config.launcher ? { launcher: config.launcher } : {}),
    };
    await writeFile(join(directory, "gate.json"), JSON.stringify(gate), {
      mode: 0o600,
      flag: "wx",
    });
    const launcher = join(directory, "launcher.js");
    await writeFile(
      launcher,
      `#!/usr/bin/env node\nimport {runSystemdLauncher} from ${JSON.stringify(new URL("./systemd-gate.js", import.meta.url).href)};\nawait runSystemdLauncher(${JSON.stringify(directory)},process.argv.slice(2));\n`,
      { mode: 0o700, flag: "wx" },
    );
    requireThat(!this.#sealed, "Native acquisition is sealed");
    this.#gate = config.containment.commands.spawnGate(directory);
    let exited = false;
    void this.#gate.exited.then(
      () => {
        exited = true;
      },
      () => {
        exited = true;
      },
    );
    const deadline = Date.now() + 5000;
    for (;;) {
      requireThat(
        !this.#sealed && !exited && Date.now() < deadline,
        "Native gate readiness remains unconfirmed or sealed",
      );
      try {
        await lstat(join(directory, "gate-ready"));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await pause();
    }
    const observed = await config.containment.commands.cgroup(cgroup);
    requireThat(observed.state === "populated" && sameCgroup(observed, group));
    requireThat(!this.#sealed, "Native acquisition is sealed");
    return { launcher, identity: copy(identity) };
  }
  async opening(opening: OpeningRef): Promise<NativeOpening> {
    requireThat(hash(canonical(opening)) === hash(this.#options.reference));
    const ready = await this.prepare(),
      capsule = { opening: copy(opening), identity: ready.identity };
    return {
      ...capsule,
      stop: async () => ({
        ...capsule,
        identity: await this.stop(),
        state: "stopped",
        scope: "nativeTree",
        noAutomaticContinuation: true,
        acquisitionSealed: true,
      }),
    };
  }
  assertLaunchable() {
    requireThat(!this.#sealed && this.#receipt, "Explicit native opening is required");
  }
  async inspect(): Promise<"created" | "running" | "gone"> {
    requireThat(this.#receipt);
    return (await retired(this.#config, this.#receipt)) ? "gone" : "running";
  }
  stop(): Promise<OpeningIdentity> {
    this.#sealed = true;
    return (this.#stopping ??= (async () => {
      if (this.#directory)
        await writeFile(join(this.#directory, "sealed"), "sealed\n", { mode: 0o600 });
      if (this.#prepared) await this.#prepared.catch(() => undefined);
      requireThat(
        this.#receipt && this.#directory,
        "Native allocation custody remains unconfirmed",
      );
      return retire(this.#config, this.#receipt, this.#directory, this.#gate);
    })());
  }
}
/** Inert subgroup backend. No fallback to independent transient-unit creation. */
export function systemdUserAllocation(options: SystemdUserOptions): NativeAllocationBackend {
  requireThat(
    isAbsolute(options.directory) && options.containment instanceof HostContainment,
    "An acquired owning Host containment is required",
  );
  if (options.launcher)
    requireThat(
      isAbsolute(options.launcher.binary) &&
        options.launcher.args.length <= 16 &&
        options.launcher.args.every((value) => value.length <= 8192 && !/[\r\n\0]/.test(value)),
    );
  const config: SystemdUserOptions = Object.freeze({
    directory: options.directory,
    containment: options.containment,
    ...(options.launcher ? { launcher: copy(options.launcher) } : {}),
  });
  return Object.freeze({
    parentCustody: config.containment.parentCustody,
    allocate: (input: NativeAllocationOptions) => new SubgroupAllocation(input, config),
    async inspectOpening(
      capsule: OpeningCapsule,
      kind: "agent" | "reader" = "agent",
    ): Promise<NativeOpening | OpeningStopProof | null> {
      requireThat(kind === "agent" || kind === "reader");
      const fixed = copy({ opening: capsule.opening, identity: capsule.identity }),
        found = await readReceipt(config, fixed, kind);
      if (!found) return null;
      const proof = (): OpeningStopProof => ({
        ...fixed,
        state: "stopped",
        scope: "nativeTree",
        noAutomaticContinuation: true,
        acquisitionSealed: true,
      });
      if (await retired(config, found.receipt)) return proof();
      let stopping: Promise<OpeningStopProof> | undefined;
      return {
        ...fixed,
        stop: () =>
          (stopping ??= (async () => {
            await retire(config, found.receipt, found.directory);
            return proof();
          })()),
      };
    },
  });
}
