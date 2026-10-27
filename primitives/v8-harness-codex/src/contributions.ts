import { copy, canonical } from "../../v8-session/src/contracts/validation.js";
import { requireThat } from "../../v8-runtime/src/validation.js";
import type { CodexRuntimeOptions } from "./runtime.js";
import { codexMcpConfig } from "./mcp-config.js";

export type CodexMcpServer = NonNullable<CodexRuntimeOptions["mcpServers"]>[string];
/** Immutable installation inputs. Custom tools enter through an enabled MCP server. */
export type CodexContribution = Readonly<{ target: "codex"; id: string }> & (
  Readonly<{ type: "mcp"; servers: Readonly<Record<string, CodexMcpServer>> }> |
  Readonly<{ type: "instructions"; text: string }> |
  Readonly<{ type: "settings"; multiAgent: NonNullable<CodexRuntimeOptions["multiAgent"]> }>
);
export const codexMcp = (value: Omit<Extract<CodexContribution, { type: "mcp" }>, "target" | "type">): CodexContribution => ({ target: "codex", type: "mcp", ...value });
export const codexInstructions = (value: Omit<Extract<CodexContribution, { type: "instructions" }>, "target" | "type">): CodexContribution => ({ target: "codex", type: "instructions", ...value });
export const codexSettings = (value: Omit<Extract<CodexContribution, { type: "settings" }>, "target" | "type">): CodexContribution => ({ target: "codex", type: "settings", ...value });

/** All conflicts are rejected before native-runtime construction or filesystem work. */
export function compileCodexContributions(values: readonly CodexContribution[]) {
  canonical(values, 2 * 1024 * 1024); requireThat(values.length <= 128);
  const occupied = new Set<string>(), manifests: { namespace: string; key: string }[] = [];
  const servers: Record<string, CodexMcpServer> = Object.create(null) as Record<string, CodexMcpServer>;
  const instructions: string[] = []; let multiAgent: CodexRuntimeOptions["multiAgent"];
  const claim = (namespace: string, key: string) => {
    requireThat(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key));
    const name = `${namespace}\0${key}`; requireThat(!occupied.has(name), "Duplicate Codex startup contribution"); occupied.add(name); manifests.push({ namespace, key });
  };
  for (const raw of values) {
    const value = copy(raw); requireThat(value.target === "codex"); claim("contribution", value.id);
    if (value.type === "mcp") {
      for (const [name, server] of Object.entries(value.servers)) {
        claim("mcp", name); codexMcpConfig({ [name]: server });
        servers[name] = server;
      }
    } else if (value.type === "instructions") {
      claim("instructions", value.id); requireThat(typeof value.text === "string" && value.text.length > 0 && value.text.length <= 65536); instructions.push(value.text);
    } else if (value.type === "settings") {
      claim("settings", "multiAgent"); const config = value.multiAgent;
      requireThat(config === false || config && Number.isSafeInteger(config.maxThreads) && config.maxThreads > 0 && config.maxThreads <= 8 && Number.isSafeInteger(config.maxDepth) && config.maxDepth > 0 && config.maxDepth <= 2); multiAgent = config;
    } else throw new Error("Unsupported Codex startup contribution");
  }
  const developerInstructions = instructions.join("\n\n"); requireThat(developerInstructions.length <= 65536);
  return copy({ manifests, mcpServers: servers, ...(multiAgent === undefined ? {} : { multiAgent }), ...(developerInstructions ? { developerInstructions } : {}) });
}
