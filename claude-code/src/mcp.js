/*
 * Copyright (C) 2026 ezTxmMC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of Lumen IDE. It is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version. See the LICENSE file for details.
 */

/** `/mcp`: which MCP servers Claude Code connects to and how they are doing, as a chat notice. */

import { withIdleQuery } from './idle.js';
import { isOn, mcpFrom, pluginsFrom } from './settings.js';

const POLLS = 8;
const POLL_MS = 1000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Servers connect in the background: ask again until none is pending, but not forever. */
async function settledStatus(run) {
  let servers = await run.mcpServerStatus();
  for (let i = 0; i < POLLS && servers.some((server) => server.status === 'pending'); i += 1) {
    await wait(POLL_MS);
    servers = await run.mcpServerStatus();
  }
  return servers;
}

function describe(server) {
  const tools = server.tools?.length ? `, ${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}` : '';
  const error = server.error ? ` — ${server.error}` : '';
  const source = server.scope || server.source ? ` [${server.scope || server.source}]` : '';
  return `${server.name}${source}: ${server.status}${tools}${error}`;
}

/** The notice text for a server list. */
export function mcpSummary(servers) {
  if (!servers.length) {
    return 'No MCP servers configured. Add some under Settings → Extensions → Claude Code, in .mcp.json or with `claude mcp add`.';
  }
  return [`MCP servers (${servers.length}):`, ...servers.map(describe)].join('\n');
}

/** Starts an idle `claude` with the same MCP setup a message would get and reports its servers. */
export async function mcpNotice(request) {
  const { cwd, settings } = request;
  const servers = await withIdleQuery(
    settings,
    {
      cwd,
      mcpServers: mcpFrom(settings.mcpServers),
      strictMcpConfig: isOn(settings.strictMcp) ? true : undefined,
      plugins: pluginsFrom(settings.pluginDirs),
    },
    settledStatus,
  );
  return { kind: 'notice', level: 'info', text: mcpSummary(servers) };
}
