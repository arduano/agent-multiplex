/** Owning-Host hierarchy entry. No independent native-unit creation. */
export { systemdCommands, type SystemdCommands } from "./cgroup.js";
export { acquireHostContainment, forceHostContainment, inspectHostContainment, hostContainmentCommands, type HostContainmentCommands, HostContainment } from "./host-containment.js";
export { systemdUserAllocation, type SystemdUserOptions } from "./delegated-allocation.js";
