import { Button } from './ui/index.js';
import { createElement as h } from 'react';
import type { McpSnapshot } from '../../v8-mcp/src/contracts.js';
/** Passive facts are distinct from explicit discovery and original commands. */
export function ToolConnections({ snapshot, stale, connected, canRefresh, refresh, open = false }: Readonly<{ snapshot: McpSnapshot | null; stale: boolean; connected: boolean; canRefresh: boolean; refresh(): void; open?: boolean }>) {
  return h('details', { className: 'mpx-chat__tools', open }, h('summary', null, 'Tool connections', snapshot ? ` (${snapshot.servers.length})` : ''),
    h('div', { className: 'mpx-chat__tool-body' },
      h('p', { role: 'status' }, !snapshot ? 'Not observed' : `${snapshot.coverage === 'enumerated' ? 'Configured inventory' : snapshot.coverage === 'partial' ? 'Partial inventory' : 'Inventory boundary unknown'} · ${stale ? 'last observation may be out of date' : snapshot.freshness}`),
      h(Button, { variant: 'ghost', type: 'button', disabled: !canRefresh || !connected || snapshot?.freshness === 'refreshing' || snapshot?.freshness === 'retired', 'data-action': 'refresh-mcp', onClick: refresh }, snapshot?.freshness === 'refreshing' ? 'Refreshing…' : 'Refresh tool connections'),
      snapshot?.kind === 'codex' ? snapshot.servers.map(server => h('div', { key: server.name, className: 'mpx-chat__tool-row' }, h('strong', null, server.name), h('span', null, server.runtimeStatus ?? 'Connection not reported'), h('span', null, `Authentication: ${server.authStatus ?? 'not reported'}`), h('span', null, server.toolCount === null ? 'Tool count not reported' : `${server.toolCount} discovered tools`))) :
      snapshot?.kind === 'copilot' ? snapshot.servers.map(server => h('div', { key: server.name, className: 'mpx-chat__tool-row' }, h('strong', null, server.name), h('span', null, server.enabled ? server.runtimeStatus : 'Disabled'))) : null,
      h('p', { className: 'mpx-chat__muted' }, 'Observed configuration does not prove a tool is available to this running turn. Server-requested confirmations appear as native requests.')));
}
