import { isAbsolute } from 'node:path';
import { requireThat } from '../../v8-runtime/src/validation.js';
import type { McpTransports } from '../../v8-mcp/src/contracts.js';

export type CodexMcpServer = Readonly<{ type?: 'stdio'; command: string; args: readonly string[]; env?: Readonly<Record<string, string>> }> |
  Readonly<{ type: 'http'; url: string }>;

/** Pinned Codex rust-v0.162.1 MCP TOML: remote `url`, and the top-level
 * mcp_oauth_credentials_store_mode="file" below. Vendor owns credentials.
 * https://github.com/openai/codex/tree/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/rmcp-client/src/oauth.rs */
export function codexMcpConfig(servers: Readonly<Record<string, CodexMcpServer>>) {
  let text = '', hasHttp = false;
  const transports: Record<string, 'stdio' | 'http'> = Object.create(null);
  requireThat(Object.keys(servers).length <= 128);
  for (const [name, server] of Object.entries(servers)) {
    requireThat(/^[A-Za-z0-9_-]{1,64}$/.test(name) && server && typeof server === 'object');
    text += `[mcp_servers.${name}]\n`;
    if (server.type === 'http') {
      requireThat(Object.keys(server).every(key => ['type', 'url'].includes(key)) && typeof server.url === 'string' && server.url.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(server.url));
      const url = new URL(server.url); requireThat(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash);
      text += `url = ${JSON.stringify(server.url)}\n`; transports[name] = 'http'; hasHttp = true;
    } else {
      requireThat(Object.keys(server).every(key => ['type', 'command', 'args', 'env'].includes(key)) && (server.type === undefined || server.type === 'stdio') && isAbsolute(server.command) && Array.isArray(server.args) && server.args.every(value => typeof value === 'string' && !value.includes('\0')));
      text += `command = ${JSON.stringify(server.command)}\nargs = [${server.args.map(value => JSON.stringify(value)).join(', ')}]\n`; transports[name] = 'stdio';
      if (server.env) { text += `[mcp_servers.${name}.env]\n`; for (const [key, value] of Object.entries(server.env)) { requireThat(/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string'); text += `${key} = ${JSON.stringify(value)}\n`; } }
    }
  }
  return { text, hasHttp, transports: Object.freeze(transports) as McpTransports };
}
