import { copilotProtocol } from "./protocol.js";
import { join } from "node:path";
import { copy } from "../../v8-session/src/contracts/validation.js";
import type { SessionScope } from "../../v8-session/src/contracts/types.js";
import { createCopilotRuntime, type CopilotRuntimeOptions, type CopilotRuntimeDependencies } from "./runtime.js";
import { compileCopilotContributions, type CopilotContribution } from "./contributions.js";
import { provisionSkillAssets } from "./assets.js";
import { copilotHarnessRouter } from "./router.js";
import type { NativeAllocationBackend } from "../../v8-host/src/native/allocation.js";

export type CopilotHarnessContext = Readonly<{ scope: SessionScope; directory: string; cwd: string }>;
export type CopilotHarnessOptions = Omit<CopilotRuntimeOptions, "scope" | "nativeHome" | "cwd" | "launchDirectory" | "sessionOptions" | "allocation"> & Readonly<{ contributions?: readonly CopilotContribution[]; allocation?: (directory: string) => NativeAllocationBackend }>;
/** Immutable trusted definition; native resources are acquired only by lifecycle. */
export function copilotHarness(options: CopilotHarnessOptions, dependencies: CopilotRuntimeDependencies = {}) {
  const startup = compileCopilotContributions(options.contributions ?? []);
  const { contributions: _contributions, catalog, beforeTool, newSessionId, allocation, ...data } = options;
  const fixed = copy(data), injected = Object.freeze({ ...dependencies });
  return Object.freeze({
    kind: "harness" as const, protocol: copilotProtocol, identity: Object.freeze({ id: "multiplex.copilot", version: 1, recordVersion: 1 }), nativeKind: "copilot" as const,
    capabilities: Object.freeze(["native.copilot", "history.streaming", "lifecycle.full-stop", "startup.mcp", "startup.skills", "startup.instructions", "startup.custom-agents", "startup.tool-policy", "startup.discovery"]),
    contributions: startup.manifests, unsupported: Object.freeze(["startup.direct-tools", "startup.managed-settings-token"]), router: copilotHarnessRouter,
    create: async (context: CopilotHarnessContext) => {
      const nativeHome = join(context.directory, "native-home"), skillDirectories: string[] = [];
      for (const skill of startup.skills) skillDirectories.push(await provisionSkillAssets(skill.assets, nativeHome, skill.id));
      return createCopilotRuntime({ ...fixed, scope: context.scope, nativeHome, cwd: context.cwd, launchDirectory: join(context.directory, "native-custody"), catalog,
        ...(allocation ? { allocation: allocation(join(context.directory, "native-custody")) } : {}),
        ...(beforeTool ? { beforeTool } : {}), ...(newSessionId ? { newSessionId } : {}),
        sessionOptions: { ...startup.sessionOptions, ...(skillDirectories.length ? { skillDirectories } : {}) },
      }, injected);
    },
  });
}
