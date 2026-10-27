import { isAbsolute } from "node:path";
import { canonical, copy } from "../../v8-session/src/contracts/validation.js";
import { requireThat } from "../../v8-runtime/src/validation.js";
import type { Json } from "../../v8-session/src/contracts/types.js";
import { validateSkillAssets, type SkillAssets } from "./assets.js";

export type CopilotMcpServer = Readonly<{ tools?: readonly string[]; timeout?: number }> & (
  Readonly<{ type?: "local" | "stdio"; command: string; args?: readonly string[]; env?: Readonly<Record<string, string>>; workingDirectory?: string }> |
  Readonly<{ type: "http" | "sse"; url: string; headers?: Readonly<Record<string, string>> }>
);
/** Pinned SDK 1.0.19 CustomAgentConfig / ReasoningEffort startup requests,
 * not observations of a child's dispatched model.
 * Omission retains the pinned SDK's model/effort inheritance semantics. */
export type CopilotAgent = Readonly<{ name: string; prompt: string; displayName?: string; description?: string; tools?: readonly string[] | null; infer?: boolean; skills?: readonly string[]; model?: string; reasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max" }>;
export type CopilotContribution = Readonly<{ target: "copilot"; id: string }> & (
  Readonly<{ type: "mcp"; servers: Readonly<Record<string, CopilotMcpServer>> }> |
  Readonly<{ type: "skills"; assets: SkillAssets }> |
  Readonly<{ type: "instructions"; text: string }> |
  Readonly<{ type: "tools"; available?: readonly string[]; excluded?: readonly string[] }> |
  Readonly<{ type: "agents"; agents: readonly CopilotAgent[] }> |
  Readonly<{ type: "settings"; enableConfigDiscovery?: boolean; enableManagedSettings?: false; mcpOAuthTokenStorage?: "persistent" | "in-memory" }>
);
export const copilotMcp = (value: Omit<Extract<CopilotContribution, { type: "mcp" }>, "target" | "type">): CopilotContribution => ({ target: "copilot", type: "mcp", ...value });
export const copilotSkills = (value: Omit<Extract<CopilotContribution, { type: "skills" }>, "target" | "type">): CopilotContribution => ({ target: "copilot", type: "skills", ...value });
export const copilotInstructions = (value: Omit<Extract<CopilotContribution, { type: "instructions" }>, "target" | "type">): CopilotContribution => ({ target: "copilot", type: "instructions", ...value });
export const copilotTools = (value: Omit<Extract<CopilotContribution, { type: "tools" }>, "target" | "type">): CopilotContribution => ({ target: "copilot", type: "tools", ...value });
export const copilotAgents = (value: Omit<Extract<CopilotContribution, { type: "agents" }>, "target" | "type">): CopilotContribution => ({ target: "copilot", type: "agents", ...value });
export const copilotSettings = (value: Omit<Extract<CopilotContribution, { type: "settings" }>, "target" | "type">): CopilotContribution => ({ target: "copilot", type: "settings", ...value });

const agentFields = new Set(["name", "prompt", "displayName", "description", "tools", "infer", "skills", "model", "reasoningEffort"]);
const agentEfforts: Readonly<Record<NonNullable<CopilotAgent["reasoningEffort"]>, true>> = Object.freeze({ low: true, medium: true, high: true, xhigh: true, max: true });
function validateAgent(agent: CopilotAgent): void {
  const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
  requireThat(agent && typeof agent === "object" && !Array.isArray(agent) && Object.keys(agent).every(key => agentFields.has(key)), "Invalid Copilot custom agent");
  requireThat(typeof agent.name === "string" && typeof agent.prompt === "string" && agent.prompt.length > 0 && agent.prompt.length <= 65536, "Invalid Copilot custom agent");
  for (const value of [agent.displayName, agent.description]) if (value !== undefined) requireThat(typeof value === "string" && value.length <= 4096, "Invalid Copilot custom agent");
  for (const value of [agent.tools, agent.skills]) if (value !== undefined && value !== null) requireThat(Array.isArray(value) && value.length <= 256 && value.every(item => text(item, 256)), "Invalid Copilot custom agent");
  requireThat(agent.skills !== null && (agent.infer === undefined || typeof agent.infer === "boolean"), "Invalid Copilot custom agent");
  if (agent.model !== undefined) requireThat(text(agent.model, 256), "Invalid Copilot custom agent");
  if (agent.reasoningEffort !== undefined) requireThat(typeof agent.reasoningEffort === "string" && Object.hasOwn(agentEfforts, agent.reasoningEffort), "Invalid Copilot custom agent");
}

export function compileCopilotContributions(values: readonly CopilotContribution[]) {
  canonical(values, 2 * 1024 * 1024); requireThat(values.length <= 128);
  const occupied = new Set<string>(), manifests: { namespace: string; key: string }[] = [], skills: { id: string; assets: SkillAssets }[] = [];
  const mcpServers: Record<string, Json> = Object.create(null) as Record<string, Json>, customAgents: CopilotAgent[] = [], instructions: string[] = [], availableTools: string[] = [], excludedTools: string[] = [];
  let availableConfigured = false, excludedConfigured = false;
  let settings: { enableConfigDiscovery?: boolean; enableManagedSettings?: false; mcpOAuthTokenStorage?: "persistent" | "in-memory" } = {};
  const claim = (namespace: string, key: string) => { requireThat(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)); const name = `${namespace}\0${key}`; requireThat(!occupied.has(name), "Duplicate Copilot startup contribution"); occupied.add(name); manifests.push({ namespace, key }); };
  for (const raw of values) {
    const value = copy(raw); requireThat(value.target === "copilot"); claim("contribution", value.id);
    if (value.type === "mcp") for (const [name, server] of Object.entries(value.servers)) { claim("mcp", name); requireThat(server && typeof server === "object" && !Array.isArray(server));
      if (server.tools !== undefined) requireThat(Array.isArray(server.tools) && server.tools.length <= 256 && server.tools.every(tool => typeof tool === "string" && tool.length > 0 && tool.length <= 256));
      if (server.timeout !== undefined) requireThat(Number.isSafeInteger(server.timeout) && server.timeout > 0 && server.timeout <= 300000);
      if (server.type === "http" || server.type === "sse") { const url = new URL(server.url); requireThat(["http:", "https:"].includes(url.protocol) && !url.username && !url.password); }
      else { const local = server as Extract<CopilotMcpServer, { command: string }>; requireThat(isAbsolute(local.command) && (local.args === undefined || local.args.every(arg => typeof arg === "string" && !arg.includes("\0"))) && (local.workingDirectory === undefined || isAbsolute(local.workingDirectory))); }
      mcpServers[name] = server as unknown as Json; }
    else if (value.type === "skills") { const assets = validateSkillAssets(value.assets); for (const file of assets.files) if (/^[^/]+\/SKILL\.md$/.test(file.path)) claim("skill", file.path.split("/")[0]!); skills.push({ id: value.id, assets }); }
    else if (value.type === "instructions") { claim("instructions", value.id); requireThat(typeof value.text === "string" && value.text.length > 0 && value.text.length <= 65536); instructions.push(value.text); }
    else if (value.type === "tools") {
      requireThat(value.available !== undefined || value.excluded !== undefined); availableConfigured ||= value.available !== undefined; excludedConfigured ||= value.excluded !== undefined;
      for (const [items, target] of [[value.available, availableTools], [value.excluded, excludedTools]] as const) for (const name of items ?? []) { claim("tool", name); target.push(name); }
    } else if (value.type === "agents") {
      requireThat(Array.isArray(value.agents) && value.agents.length <= 128, "Invalid Copilot custom agents");
      for (const agent of value.agents) { validateAgent(agent); claim("agent", agent.name); customAgents.push(agent); }
    }
    else if (value.type === "settings") {
      for (const key of ["enableConfigDiscovery", "enableManagedSettings"] as const) if (value[key] !== undefined) { claim("settings", key); requireThat(typeof value[key] === "boolean" && (key !== "enableManagedSettings" || value[key] === false), "Managed settings require an explicit native token contract"); if (key === "enableManagedSettings") settings.enableManagedSettings = false; else settings.enableConfigDiscovery = value.enableConfigDiscovery === true; }
      if (value.mcpOAuthTokenStorage !== undefined) { claim("settings", "mcpOAuthTokenStorage"); requireThat(value.mcpOAuthTokenStorage === "persistent" || value.mcpOAuthTokenStorage === "in-memory"); settings.mcpOAuthTokenStorage = value.mcpOAuthTokenStorage; }
    } else throw new Error("Unsupported Copilot startup contribution");
  }
  const text = instructions.join("\n\n"); requireThat(text.length <= 65536);
  return copy({ manifests, skills, sessionOptions: { ...settings, ...(Object.keys(mcpServers).length ? { mcpServers } : {}), ...(customAgents.length ? { customAgents: customAgents as unknown as readonly Json[] } : {}), ...(availableConfigured ? { availableTools } : {}), ...(excludedConfigured ? { excludedTools } : {}), ...(text ? { systemMessage: { mode: "append", content: text } } : {}) } });
}
