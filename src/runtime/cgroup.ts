import { execFile } from "node:child_process";
import { lstat, open, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { requireThat } from "./validation.js";
import type {
  Cgroup,
  CgroupIdentity,
  SystemdCommandOptions,
  SystemdCommands,
} from "./node-contracts.js";
export const bootPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
export const invocationPattern = /^[a-f0-9]{32}$/;
export const disappeared = (error: unknown): boolean =>
  ["ENOENT", "ENODEV"].includes((error as NodeJS.ErrnoException)?.code ?? "");
export function cgroupPath(path: string): string {
  requireThat(
    isAbsolute(path) &&
      path !== "/" &&
      path.length <= 512 &&
      !/[\r\n\0]/.test(path) &&
      !path.split("/").some((part) => part === "." || part === ".."),
  );
  return join("/sys/fs/cgroup", path.slice(1));
}
export function sameCgroup(value: Cgroup, expected: CgroupIdentity): boolean {
  return (
    value.state !== "absent" && value.device === expected.device && value.inode === expected.inode
  );
}
export async function observeCgroup(
  port: Pick<SystemdCommands, "cgroup">,
  path: string,
): Promise<Cgroup> {
  try {
    return await port.cgroup(path);
  } catch (error) {
    if (!disappeared(error)) throw error;
    return port.cgroup(path);
  }
}
/** Exact kernel handles, never PID enumeration or a process-group fallback. */
export function systemdCommands(options: SystemdCommandOptions): SystemdCommands {
  requireThat(isAbsolute(options.systemctl));
  return {
    exec: (_tool, args) =>
      new Promise((resolveCommand, reject) => {
        execFile(
          options.systemctl,
          [...args],
          { encoding: "utf8", timeout: 10000, maxBuffer: 65536 },
          (error, stdout) =>
            error ? reject(Error("Owned systemd observation failed")) : resolveCommand(stdout),
        );
      }),
    async bootId() {
      await readFile("/sys/fs/cgroup/cgroup.controllers");
      const value = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      requireThat(bootPattern.test(value));
      return value;
    },
    async cgroup(path) {
      let directory;
      try {
        directory = await open(cgroupPath(path), "r");
      } catch (error) {
        if (disappeared(error)) return { state: "absent" };
        throw error;
      }
      try {
        const info = await directory.stat({ bigint: true });
        requireThat(info.isDirectory());
        const pinned = `/proc/self/fd/${directory.fd}`,
          events = await readFile(join(pinned, "cgroup.events"), "utf8");
        requireThat(
          (await lstat(join(pinned, "cgroup.kill"))).isFile(),
          "Exact subtree retirement is unavailable",
        );
        const populated = /^populated ([01])$/m.exec(events);
        requireThat(populated);
        return {
          state: populated[1] === "1" ? "populated" : "empty",
          device: String(info.dev),
          inode: String(info.ino),
        };
      } finally {
        await directory.close();
      }
    },
    async killCgroup(path, expected) {
      const directory = await open(cgroupPath(path), "r");
      try {
        const info = await directory.stat({ bigint: true });
        requireThat(
          info.isDirectory() &&
            String(info.dev) === expected.device &&
            String(info.ino) === expected.inode,
          "Containment identity changed",
        );
        const kill = await open(`/proc/self/fd/${directory.fd}/cgroup.kill`, "w");
        try {
          await kill.writeFile("1\n");
        } finally {
          await kill.close();
        }
      } finally {
        await directory.close();
      }
    },
  };
}
