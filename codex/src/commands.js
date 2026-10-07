/*
 * Copyright (C) 2026 ezTxmMC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of Lumen IDE. It is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version. See the LICENSE file for details.
 */

/**
 * Slash commands Codex's exec mode can honour, plus Lumen-side ones. The
 * panel hands `/name args` to the provider as typed (it expands only its own
 * custom commands), so `resolveSlash` decides what a message means.
 */

import fs from 'node:fs';
import path from 'node:path';
import { mcpCommand } from './mcp.js';
import { discoverPrompts, resolvePrompt } from './prompts.js';
import { codexHome, runCodex, splitArgs } from './util.js';
import { approvalFor, profileArgs, sandboxFor } from './settings.js';
import { configuredModel } from './models.js';

export const INIT_PROMPT = [
  'Create an AGENTS.md file in the root of this repository: a concise contributor guide for coding agents.',
  'Inspect the project first (layout, build and test commands, code style, commit conventions) and write only what you verified.',
  'Use short sections: Project structure, Build and test commands, Coding style, Testing, Commit and PR guidelines.',
  'If AGENTS.md already exists, improve it instead of replacing what is correct.',
].join(' ');

const BUILTIN = [
  { name: 'review', description: 'Review code with Codex', argumentHint: '[base <branch> | commit <sha> | instructions]', source: 'builtin' },
  { name: 'init', description: 'Create or improve AGENTS.md', source: 'builtin' },
  { name: 'status', description: 'Show model, sandbox, approvals, session and context', source: 'builtin' },
  { name: 'mcp', description: 'List or manage MCP servers', argumentHint: '[list | add | remove | get]', source: 'builtin' },
  { name: 'profiles', description: 'List the profiles of config.toml', source: 'builtin' },
];

/** What the `session` event reports to the `/` palette. */
export async function slashCommands(cwd) {
  const prompts = await discoverPrompts(cwd).catch(() => []);
  return [...BUILTIN, ...prompts.map(({ body, ...entry }) => entry)];
}

/** `/review` arguments as `codex exec review` flags — a target, or custom instructions (the CLI allows only one of them). */
export function reviewPlan(argLine) {
  const tokens = splitArgs(argLine);
  const [kind, value, ...rest] = tokens;
  if (!tokens.length || kind === 'uncommitted') {
    return { target: ['--uncommitted'] };
  }
  if ((kind === 'base' || kind === '--base') && value) {
    return { target: ['--base', value] };
  }
  if ((kind === 'commit' || kind === '--commit') && value) {
    return { target: ['--commit', value, ...(rest.length ? ['--title', rest.join(' ')] : [])] };
  }
  return { target: [], prompt: argLine.trim() };
}

/** `[profiles.x]` tables of config.toml and `<name>.config.toml` layers. */
export function discoverProfiles() {
  const names = new Set();
  const home = codexHome();
  const config = fs.existsSync(path.join(home, 'config.toml')) ? fs.readFileSync(path.join(home, 'config.toml'), 'utf8') : '';
  for (const match of config.matchAll(/^\s*\[profiles\.(?:"([^"]+)"|([\w-]+))\]/gm)) {
    names.add(match[1] ?? match[2]);
  }
  for (const entry of fs.existsSync(home) ? fs.readdirSync(home) : []) {
    const layer = /^(.+)\.config\.toml$/.exec(entry);
    if (layer) {
      names.add(layer[1]);
    }
  }
  return [...names].sort();
}

function profilesText() {
  const names = discoverProfiles();
  if (!names.length) {
    return 'No profiles found. Add a `[profiles.<name>]` table to ~/.codex/config.toml or a ~/.codex/<name>.config.toml file, then name it under Settings → Extensions → ChatGPT Codex → Profile.';
  }
  return ['Profiles (set one under Settings → Extensions → ChatGPT Codex → Profile):', ...names.map((name) => `- ${name}`)].join('\n');
}

async function statusText(request) {
  const { settings, cwd, mode, sessionId } = request;
  const version = await runCodex(settings, ['--version'], { cwd }).catch(() => null);
  const login = await runCodex(settings, ['login', 'status'], { cwd }).catch(() => null);
  const model = request.model || (settings.model !== 'auto' ? settings.model : '') || await configuredModel() || 'as in config.toml';
  const profile = settings.profile ? profileArgs(settings.profile).join(' ') : 'none';
  const rows = [
    ['Codex', version?.stdout.trim() || 'unknown'],
    ['Account', `${login?.stdout ?? ''}${login?.stderr ?? ''}`.trim().split('\n').pop() || 'unknown'],
    ['Model', `${model}${request.effort ? ` (${request.effort})` : ''}`],
    ['Sandbox', sandboxFor(mode, settings)],
    ['Approvals', approvalFor(mode, settings) || 'as in config.toml'],
    ['Profile', profile],
    ['Folder', cwd],
    ['AGENTS.md', fs.existsSync(path.join(cwd, 'AGENTS.md')) ? 'present' : 'missing — /init creates it'],
    ['Session', sessionId || 'none yet'],
  ];
  return rows.map(([label, value]) => `${label}: ${value}`).join('\n');
}

/**
 * What a message means: `{ kind: 'review', … }`, `{ kind: 'prompt', text }`
 * (send this instead), `{ kind: 'notice', text }` (show it, run nothing), or
 * `null` for an ordinary message.
 */
export async function resolveSlash(request) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(request.text.trim());
  if (!match) {
    return null;
  }
  const [, name, args = ''] = match;
  if (name === 'review') {
    return { kind: 'review', ...reviewPlan(args) };
  }
  if (name === 'init') {
    return { kind: 'prompt', text: args ? `${INIT_PROMPT}\nAlso: ${args}` : INIT_PROMPT };
  }
  if (name === 'status') {
    return { kind: 'notice', text: await statusText(request) };
  }
  if (name === 'profiles') {
    return { kind: 'notice', text: profilesText() };
  }
  if (name === 'mcp') {
    return { kind: 'notice', text: await mcpCommand(request.settings, request.cwd, args) };
  }
  const prompt = name.startsWith('prompts:') ? await resolvePrompt(request.cwd, name, args) : null;
  return prompt === null ? null : { kind: 'prompt', text: prompt };
}
