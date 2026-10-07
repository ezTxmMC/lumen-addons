/*
 * Copyright (C) 2026 ezTxmMC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of Lumen IDE. It is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version. See the LICENSE file for details.
 */

/** `/mcp`: the MCP servers Codex knows, through `codex mcp …`. */

import { runCodex, splitArgs } from './util.js';

const PASS_THROUGH = new Set(['add', 'remove', 'get']);

function describeServer(server) {
  const transport = server.transport ?? {};
  const target = transport.type === 'stdio'
    ? [transport.command, ...(transport.args ?? [])].join(' ')
    : transport.url ?? transport.type ?? '';
  const state = server.enabled === false ? 'off' : 'on';
  return `- ${server.name} (${state}, ${transport.type ?? '?'}) ${target}`.trimEnd();
}

/** The configured servers as lines of text. */
export async function listServers(settings, cwd) {
  const result = await runCodex(settings, ['mcp', 'list', '--json'], { cwd });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'codex mcp list failed');
  }
  const servers = JSON.parse(result.stdout || '[]');
  if (!servers.length) {
    return 'No MCP servers are configured. Add one with `/mcp add <name> -- <command> [args…]` or `/mcp add <name> --url <url>`.';
  }
  return ['MCP servers:', ...servers.map(describeServer)].join('\n');
}

/** `/mcp [list | add … | remove <name> | get <name>]`; the arguments after the verb go to `codex mcp` as typed. */
export async function mcpCommand(settings, cwd, argLine) {
  const [verb = 'list', ...rest] = splitArgs(argLine);
  if (verb === 'list') {
    return listServers(settings, cwd);
  }
  if (!PASS_THROUGH.has(verb)) {
    return 'Usage: /mcp [list | get <name> | add <name> (--url <url> | -- <command> [args…]) | remove <name>]';
  }
  const result = await runCodex(settings, ['mcp', verb, ...rest], { cwd, timeout: 60_000 });
  const text = `${result.stdout}${result.stderr}`.trim();
  if (result.code !== 0) {
    throw new Error(text || `codex mcp ${verb} failed`);
  }
  return text || `codex mcp ${verb}: done`;
}
