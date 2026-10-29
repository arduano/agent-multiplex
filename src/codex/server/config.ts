import type { CodexStartup } from "../node-contracts.js";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { check } from "./validation.js";
function key(value: string): string {
  check(typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value), "CONFIG_KEY");
  return value;
}
function quoted(value: string): string {
  check(typeof value === "string" && !value.includes("\0"), "CONFIG_TEXT");
  return JSON.stringify(value);
}
function table(name: string, values: Readonly<Record<string, string>>): string {
  return (
    `[${name}]\n` +
    Object.entries(values)
      .map(([name, value]) => `${quoted(name)} = ${quoted(value)}\n`)
      .join("")
  );
}
export function codexConfig(options: CodexStartup): string {
  const provider = options.provider,
    url = new URL(provider.baseUrl);
  check(
    ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash,
    "PROVIDER_URL",
  );
  key(provider.id);
  key(provider.environmentKey);
  let result = `model = ${quoted(options.model)}\nmodel_provider = ${quoted(provider.id)}\napproval_policy = "on-request"\nsandbox_mode = "danger-full-access"\nmcp_oauth_credentials_store_mode = "file"\n`;
  result += `[model_providers.${provider.id}]\nname = "Managed Agent Multiplex route"\nbase_url = ${quoted(provider.baseUrl)}\nwire_api = "responses"\nenv_key = ${quoted(provider.environmentKey)}\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`;
  if (options.multiAgent === false)
    result += `[features]\nmulti_agent = false\nmulti_agent_v2 = false\n[agents]\nenabled = false\n`;
  else if (options.multiAgent) {
    check(
      Number.isSafeInteger(options.multiAgent.maxThreads) &&
        options.multiAgent.maxThreads >= 1 &&
        options.multiAgent.maxThreads <= 32 &&
        Number.isSafeInteger(options.multiAgent.maxDepth) &&
        options.multiAgent.maxDepth >= 1 &&
        options.multiAgent.maxDepth <= 8,
      "MULTI_AGENT_LIMIT",
    );
    result += `[features]\nmulti_agent = true\n[agents]\nmax_threads = ${options.multiAgent.maxThreads}\nmax_depth = ${options.multiAgent.maxDepth}\n`;
  }
  const servers = options.mcpServers ?? {};
  check(Object.keys(servers).length <= 64, "MCP_LIMIT");
  for (const [name, server] of Object.entries(servers)) {
    result += `[mcp_servers.${key(name)}]\n`;
    if (server.enabled !== undefined) result += `enabled = ${server.enabled ? "true" : "false"}\n`;
    if (server.tools !== undefined) {
      check(
        server.tools.length <= 128 &&
          server.tools.every((value) => typeof value === "string" && value.length > 0),
        "MCP_TOOLS",
      );
      result += `enabled_tools = [${server.tools.map(quoted).join(", ")}]\n`;
    }
    if (server.toolApproval !== undefined) {
      check(["auto", "prompt", "writes", "approve"].includes(server.toolApproval), "MCP_POLICY");
      result += `default_tools_approval_mode = ${quoted(server.toolApproval)}\n`;
    }
    if (server.type === "http") {
      const url = new URL(server.url);
      check(
        ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash,
        "MCP_URL",
      );
      result += `url = ${quoted(server.url)}\n`;
      if (server.headers) result += table(`mcp_servers.${name}.http_headers`, server.headers);
    } else {
      check(isAbsolute(server.command), "MCP_COMMAND");
      result += `command = ${quoted(server.command)}\nargs = [${server.args.map(quoted).join(", ")}]\n`;
      if (server.env) result += table(`mcp_servers.${name}.env`, server.env);
    }
  }
  return result;
}
/** Native may append only its exact project trust metadata. Existing arbitrary
 * policy is refused rather than overwritten or merged from an ambient home. */
function sameManaged(actual: string, expected: string): boolean {
  if (!actual.startsWith(expected) || actual.length - expected.length > 65536) return false;
  const lines = actual.slice(expected.length).split("\n").filter(Boolean),
    paths = new Set<string>();
  if (lines.length > 256 || lines.length % 2) return false;
  for (let index = 0; index < lines.length; index += 2) {
    const header = lines[index]!,
      trust = lines[index + 1]!;
    if (
      !header.startsWith("[projects.") ||
      !header.endsWith("]") ||
      !['trust_level = "trusted"', 'trust_level = "untrusted"'].includes(trust)
    )
      return false;
    let path: unknown;
    try {
      path = JSON.parse(header.slice(10, -1));
    } catch {
      return false;
    }
    if (typeof path !== "string" || !isAbsolute(path) || paths.has(path)) return false;
    paths.add(path);
  }
  return true;
}
export async function prepareCodexHome(home: string, options: CodexStartup): Promise<void> {
  check(isAbsolute(home), "HOME_PATH");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const info = await lstat(home);
  check(
    info.isDirectory() &&
      !info.isSymbolicLink() &&
      (info.mode & 0o077) === 0 &&
      (await realpath(home)) === home,
    "HOME_CUSTODY",
  );
  const file = join(home, "config.toml"),
    expected = codexConfig(options);
  try {
    await writeFile(file, expected, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const state = await lstat(file);
    check(
      state.isFile() &&
        !state.isSymbolicLink() &&
        (state.mode & 0o077) === 0 &&
        sameManaged(await readFile(file, "utf8"), expected),
      "PRIVATE_POLICY_CHANGED",
    );
  }
}
