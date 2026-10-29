/** Platform inputs and command ports for explicit Node runtime composition.
 * These descriptions do not acquire or release native custody. */
import type { OpeningIdentity } from "./contracts.js";
import type { HostContainment } from "./host-containment.js";

export type CgroupIdentity = Readonly<{ device: string; inode: string }>;
export type Cgroup =
  Readonly<{ state: "empty" | "populated" } & CgroupIdentity> | Readonly<{ state: "absent" }>;
export interface SystemdCommands {
  exec(tool: "control", args: readonly string[]): Promise<string>;
  bootId(): Promise<string>;
  cgroup(path: string): Promise<Cgroup>;
  killCgroup(path: string, expected: CgroupIdentity): Promise<void>;
}
export type SystemdCommandOptions = Readonly<{ systemctl: string }>;
export type HostContainmentOptions = Readonly<{ unit: string; systemctl: string }>;
export interface GateProcess {
  readonly exited: Promise<void>;
  terminate(): Promise<void>;
}
export interface HostContainmentCommands extends SystemdCommands {
  self(): Promise<Readonly<{ pid: number; invocation: string; cgroup: string }>>;
  createGroup(path: string): Promise<CgroupIdentity>;
  removeGroup(path: string, expected: CgroupIdentity): Promise<void>;
  enter(path: string, expected: CgroupIdentity): Promise<void>;
  spawnGate(directory: string): GateProcess;
}
export type SystemdUserOptions = Readonly<{
  directory: string;
  /** The actual acquired handle; a structural command port cannot replace it. */
  containment: HostContainment;
  /** Explicit host ABI prefix; no loader discovery or binary patching. */
  launcher?: Readonly<{ binary: string; args: readonly string[] }>;
}>;

export interface DockerCommands {
  exec(args: readonly string[]): Promise<string>;
}
export type LinuxContainerOptions = Readonly<{
  directory: string;
  binary: string;
  packageRoot: string;
  home: string;
  cwd: string;
  args: readonly string[];
  environment: Readonly<Record<string, string>>;
  /** Canonical exact opening/read identity. Never a host name/PID lookup. */
  reference: string;
  kind: "agent" | "reader";
  docker?: string;
}>;
export type PreparedLinux = Readonly<{ launcher: string; identity: OpeningIdentity }>;
export type LinuxInspectionOptions = Readonly<{ docker?: string }>;
