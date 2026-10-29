import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type {
  NativeOpening,
  OpeningCapsule,
  OpeningIdentity,
  OpeningRef,
  OpeningStopProof,
} from "./contracts.js";
import { canonical, copy } from "./validation.js";
import { requireThat } from "./validation.js";
import type {
  DockerCommands,
  LinuxContainerOptions,
  LinuxInspectionOptions,
  PreparedLinux,
} from "./node-contracts.js";

/** Explicit disposable Linux qualification profile; not the host filesystem. */
export const LINUX_IMAGE =
  "node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df";
type ContainerState = Readonly<{ running: boolean }>;
const idPattern = /^[a-f0-9]{64}$/;
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const metadata = (value: unknown): Record<string, unknown> => {
  requireThat(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
};

/** No ambient daemon discovery, shell interpolation, pulling or credentials in argv. */
export function dockerCommands(binary: string): DockerCommands {
  requireThat(isAbsolute(binary));
  return {
    exec: (args) =>
      new Promise((resolve, reject) =>
        execFile(
          binary,
          ["--host", "unix:///var/run/docker.sock", ...args],
          {
            encoding: "utf8",
            timeout: 15000,
            maxBuffer: 262144,
            env: {
              PATH: "/usr/bin:/bin",
              DOCKER_CONFIG: "/nonexistent-multiplex-v8-docker-config",
            },
          },
          (error, stdout) => {
            if (error) reject(new Error("Owned container control was not acknowledged"));
            else resolve(stdout);
          },
        ),
      ),
  };
}

/** One immutable container, not a daemon/process registry or agent lifecycle. */
export class LinuxContainerOwner {
  readonly #options: LinuxContainerOptions;
  readonly #commands: DockerCommands;
  readonly #attachment = `linux-${randomUUID()}`;
  readonly #reference: string;
  #prepared: Promise<PreparedLinux> | undefined;
  #value: PreparedLinux | undefined;
  #sealed = false;
  #stopping: Promise<OpeningIdentity> | undefined;
  #allocationFailed = false;
  #directory: string | undefined;
  constructor(options: LinuxContainerOptions, commands?: DockerCommands) {
    for (const path of [
      options.directory,
      options.binary,
      options.packageRoot,
      options.home,
      options.cwd,
    ])
      requireThat(isAbsolute(path));
    requireThat(
      ["agent", "reader"].includes(options.kind) &&
        options.args.every((value) => typeof value === "string" && !value.includes("\0")),
    );
    requireThat(
      typeof options.reference === "string" &&
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
    this.#reference = digest(options.reference);
    this.#commands =
      commands ?? dockerCommands(options.docker ?? "/run/current-system/sw/bin/docker");
  }
  get identity(): OpeningIdentity | null {
    return this.#value ? copy(this.#value.identity) : null;
  }
  get sealed(): boolean {
    return this.#sealed;
  }
  prepare(): Promise<PreparedLinux> {
    requireThat(!this.#sealed, "Owned container acquisition was sealed");
    return (this.#prepared ??= this.#prepare().catch((error) => {
      if (!this.#value) this.#allocationFailed = true;
      throw error;
    }));
  }
  async #prepare(): Promise<PreparedLinux> {
    const options = this.#options;
    requireThat(process.platform === "linux", "Linux containment is unavailable on this platform");
    for (const path of [options.packageRoot, options.home, options.cwd])
      requireThat(!/[\r\n,\0]/.test(path), "Container mount path cannot be represented safely");
    await mkdir(options.directory, { recursive: true, mode: 0o700 });
    const base = await realpath(options.directory);
    const info = await lstat(base);
    requireThat(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0);
    for (const path of [options.home, options.cwd]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      requireThat((await lstat(path)).isDirectory() && !(await lstat(path)).isSymbolicLink());
    }
    const packageRoot = await realpath(options.packageRoot),
      binary = await realpath(options.binary),
      suffix = relative(packageRoot, binary);
    requireThat(
      suffix !== "" &&
        suffix !== ".." &&
        !suffix.startsWith(`..${sep}`) &&
        !isAbsolute(suffix) &&
        (await lstat(binary)).isFile(),
    );
    const directory = await mkdtemp(join(base, "native-"));
    this.#directory = directory;
    const environment = join(directory, "environment");
    await writeFile(
      environment,
      Object.entries(options.environment)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n",
      { mode: 0o600, flag: "wx" },
    );
    // Capture creation once. An unknown allocation outcome is never repaired by
    // another create or by treating an absent name as non-execution proof.
    requireThat(!this.#sealed, "Owned container acquisition was sealed");
    const args = [
      "create",
      "--pull=never",
      "--interactive",
      "--name",
      this.#attachment,
      "--label",
      `multiplex.owner.owner=${this.#attachment}`,
      "--label",
      `multiplex.owner.reference=${this.#reference}`,
      "--label",
      `multiplex.owner.kind=${options.kind}`,
      "--network",
      "host",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "128",
      "--memory",
      "2g",
      "--user",
      `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`,
      "--tmpfs",
      "/tmp:rw,exec,nosuid,nodev,mode=1777",
      "--mount",
      `type=bind,src=${packageRoot},dst=${packageRoot},readonly`,
      "--mount",
      `type=bind,src=${options.home},dst=${options.home}`,
      "--mount",
      `type=bind,src=${options.cwd},dst=${options.cwd}`,
      "--env-file",
      environment,
      "--workdir",
      options.cwd,
      "--entrypoint",
      binary,
      LINUX_IMAGE,
      ...options.args,
    ];
    const cid = (await this.#commands.exec(args)).trim();
    requireThat(idPattern.test(cid));
    const identity: OpeningIdentity = {
      attachment: this.#attachment,
      process: `container:${cid}:init`,
      containment: cid,
      placement: "dedicated",
    };
    const launcher = join(directory, "launcher.js");
    const value = Object.freeze({ launcher, identity: Object.freeze(identity) });
    this.#value = value;
    await inspectExact(this.#commands, identity, this.#reference, options.kind);
    const sealed = join(directory, "sealed"),
      claim = join(directory, "launch-claimed"),
      docker = options.docker ?? "/run/current-system/sw/bin/docker";
    // SDK-generated argv is checked, not ignored or projected. A launcher has
    // only start/attach authority for this immutable ID, never create/retry.
    const source =
      `#!/usr/bin/env node\nimport {existsSync,openSync,closeSync} from 'node:fs';\n` +
      `if(existsSync(${JSON.stringify(sealed)})||JSON.stringify(process.argv.slice(2))!==${JSON.stringify(JSON.stringify(options.args))})process.exit(74);\n` +
      `try{closeSync(openSync(${JSON.stringify(claim)},'wx',0o600));}catch{process.exit(74);}\n` +
      `if(existsSync(${JSON.stringify(sealed)}))process.exit(74);\n` +
      `process.execve(${JSON.stringify(docker)},[${JSON.stringify(docker)},'--host','unix:///var/run/docker.sock','start','--attach','--interactive',${JSON.stringify(cid)}],{PATH:'/usr/bin:/bin',DOCKER_CONFIG:'/nonexistent-multiplex-v8-docker-config'});\n`;
    await writeFile(launcher, source, { mode: 0o700, flag: "wx" });
    requireThat(!this.#sealed, "Owned container acquisition was sealed");
    return copy(value);
  }
  async opening(opening: OpeningRef): Promise<NativeOpening> {
    requireThat(
      digest(canonical(opening)) === this.#reference,
      "Opening identity differs from allocated containment",
    );
    const prepared = await this.prepare();
    const capsule = copy({ opening, identity: prepared.identity });
    return Object.freeze({
      ...capsule,
      stop: async () => ({
        ...capsule,
        state: "stopped" as const,
        scope: "nativeTree" as const,
        noAutomaticContinuation: true as const,
        acquisitionSealed: true as const,
        identity: await this.stop(),
      }),
    });
  }
  assertLaunchable(): void {
    requireThat(
      !this.#sealed && this.#value && !this.#allocationFailed,
      "Owned native launch is unavailable",
    );
  }
  async inspect(): Promise<"created" | "running" | "gone"> {
    requireThat(this.#value);
    const state = await inspectExact(
      this.#commands,
      this.#value.identity,
      this.#reference,
      this.#options.kind,
    );
    return state === null ? "gone" : state.running ? "running" : "created";
  }
  stop(): Promise<OpeningIdentity> {
    if (this.#stopping) return this.#stopping;
    // Seal synchronously, before pending filesystem/create/control awaits.
    this.#sealed = true;
    this.#stopping = this.#stop();
    return this.#stopping;
  }
  async #stop(): Promise<OpeningIdentity> {
    if (this.#directory)
      await writeFile(join(this.#directory, "sealed"), "sealed\n", { mode: 0o600 });
    if (this.#prepared) await this.#prepared.catch(() => undefined);
    requireThat(
      this.#value && !this.#allocationFailed,
      "Pending container allocation was not positively identified",
    );
    const identity = this.#value.identity;
    const state = await inspectExact(this.#commands, identity, this.#reference, this.#options.kind);
    if (state !== null)
      await this.#commands.exec(["rm", "--force", "--volumes", identity.containment]);
    requireThat(
      (await inspectExact(this.#commands, identity, this.#reference, this.#options.kind)) === null,
      "Exact native containment remains present",
    );
    return copy(identity);
  }
}

/** A successful inspect is JSON with explicit absence, never an error-message heuristic. */
async function inspectExact(
  commands: DockerCommands,
  identity: OpeningIdentity,
  reference: string,
  kind: "agent" | "reader",
): Promise<ContainerState | null> {
  requireThat(
    identity.placement === "dedicated" &&
      idPattern.test(identity.containment) &&
      identity.process === `container:${identity.containment}:init`,
  );
  // `container ls --all --no-trunc` gives exact-ID absence without interpreting
  // Docker stderr (which may instead be permission/daemon/transport failure).
  const listing = await commands.exec([
    "container",
    "ls",
    "--all",
    "--no-trunc",
    "--filter",
    `id=${identity.containment}`,
    "--format",
    "{{.ID}}",
  ]);
  const ids = listing.trim() ? listing.trim().split("\n") : [];
  requireThat(ids.every((id) => idPattern.test(id)) && ids.length <= 1);
  if (!ids.length) return null;
  requireThat(ids[0] === identity.containment);
  const raw = JSON.parse(
    await commands.exec(["container", "inspect", identity.containment]),
  ) as unknown;
  requireThat(Array.isArray(raw) && raw.length === 1);
  const entry = metadata(raw[0]),
    config = metadata(entry.Config),
    labels = metadata(config.Labels),
    state = metadata(entry.State);
  requireThat(
    entry.Id === identity.containment &&
      config.Image === LINUX_IMAGE &&
      labels["multiplex.owner.owner"] === identity.attachment &&
      labels["multiplex.owner.reference"] === reference &&
      labels["multiplex.owner.kind"] === kind &&
      typeof state.Running === "boolean",
  );
  return { running: state.Running };
}

export async function inspectLinuxOpening(
  capsule: OpeningCapsule,
  options: LinuxInspectionOptions,
  commands?: DockerCommands,
  kind: "agent" | "reader" = "agent",
): Promise<NativeOpening | OpeningStopProof | null> {
  requireThat(kind === "agent" || kind === "reader");
  const fixed = copy({ opening: capsule.opening, identity: capsule.identity }),
    port = commands ?? dockerCommands(options.docker ?? "/run/current-system/sw/bin/docker"),
    reference = digest(canonical(fixed.opening));
  const state = await inspectExact(port, fixed.identity, reference, kind);
  const proof = (): OpeningStopProof => ({
    ...fixed,
    state: "stopped",
    scope: "nativeTree",
    noAutomaticContinuation: true,
    acquisitionSealed: true,
  });
  // Capsule is committed only after immutable allocation and before launch.
  // No remaining launcher can allocate or restart an absent immutable CID.
  if (state === null) return proof();
  let stopping: Promise<OpeningStopProof> | undefined;
  return {
    ...fixed,
    stop: () =>
      (stopping ??= (async () => {
        await port.exec(["rm", "--force", "--volumes", fixed.identity.containment]);
        requireThat((await inspectExact(port, fixed.identity, reference, kind)) === null);
        return proof();
      })()),
  };
}
