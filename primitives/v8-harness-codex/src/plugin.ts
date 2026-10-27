import { codexProtocol } from "./protocol.js";
import { join } from "node:path";
import { copy } from "../../v8-session/src/contracts/validation.js";
import type { Catalog, SessionScope } from "../../v8-session/src/contracts/types.js";
import { createCodexModelCatalog, createCodexRuntime, type CodexRuntimeOptions } from "./runtime.js";
import { compileCodexContributions, type CodexContribution } from "./contributions.js";
import { codexHarnessRouter } from "./router.js";
import type { NativeAllocationBackend } from "../../v8-host/src/native/allocation.js";

export type CodexHarnessContext = Readonly<{ scope: SessionScope; directory: string; cwd: string; modelCatalog?: () => Promise<Catalog> }>;
export type CodexHarnessOptions = Omit<CodexRuntimeOptions, "directory" | "home" | "cwd" | "mcpServers" | "multiAgent" | "developerInstructions" | "allocation" | "modelCatalog"> & Readonly<{ contributions?: readonly CodexContribution[]; allocation?: (directory: string) => NativeAllocationBackend }>;
/** Inert static definition. Private options never enter the public manifest. */
export function codexHarness(options: CodexHarnessOptions) {
  const { manifests, ...startup } = compileCodexContributions(options.contributions ?? []);
  const { contributions: _contributions, catalog, commands, wire, allocation, ...data } = options;
  const fixed = copy(data);
  return Object.freeze({
    kind: "harness" as const, protocol: codexProtocol, identity: Object.freeze({ id: "multiplex.codex", version: 1, recordVersion: 1 }), nativeKind: "codex" as const,
    capabilities: Object.freeze(["native.codex", "history.streaming", "lifecycle.full-stop", "startup.mcp", "startup.instructions", "startup.multiAgent"]),
    contributions: manifests,
    /** These missing encoders are explicit; no ambient home provisioning or arbitrary JSON. */
    unsupported: Object.freeze(["startup.skills", "startup.custom-agents", "startup.direct-tools"]),
    router: codexHarnessRouter,
    modelCatalog: ({ directory }: { directory: string }) => createCodexModelCatalog({ ...fixed, directory,
      ...(catalog ? { catalog } : {}), ...(commands ? { commands } : {}), ...(wire ? { wire } : {}), ...(allocation ? { allocation: allocation(directory) } : {}),
    }),
    create: async (context: CodexHarnessContext) => createCodexRuntime({ ...fixed, ...startup,
      ...(catalog ? { catalog } : {}), ...(context.modelCatalog ? { modelCatalog: context.modelCatalog } : {}), ...(commands ? { commands } : {}), ...(wire ? { wire } : {}),
      ...(allocation ? { allocation: allocation(join(context.directory, "native-custody")) } : {}),
      directory: join(context.directory, "native-custody"), home: join(context.directory, "native-home"), cwd: context.cwd }),
  });
}
