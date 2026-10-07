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
 * Reading the extension's settings: plain values, lists, and the line
 * formats of the CLI-native surfaces (subagents, hooks, plugins, rules).
 */

import os from 'node:os';

export const MODES = new Set(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']);
export const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionStart', 'Notification', 'PreCompact']);
/** Tools that only look: the "read-only" tool set. */
const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'NotebookRead'];

export const lines = (value) => String(value ?? '').split(/\r?\n|,/).map((entry) => entry.trim()).filter(Boolean);
export const isOn = (value) => value === 'true';
/** A select setting's value; `auto` (and nothing) leaves the choice to Claude Code. */
export const chosen = (value) => (value && value !== 'auto' ? value : undefined);
export const unescapeLine = (value) => String(value ?? '').replace(/\\n/g, '\n');
export const home = (dir) => dir.replace(/^~(?=\/|$)/, os.homedir());

export function number(value) {
  const parsed = Number(value);
  if (!value || !Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.round(parsed);
}

/** Non-empty, non-comment lines split at `|` — the format of every list setting. */
export function rows(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('|').map((part) => part.trim()));
}

/** `KEY=VALUE` per line. */
export function envFrom(value) {
  const env = {};
  for (const line of String(value ?? '').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) {
      env[match[1]] = match[2];
    }
  }
  return env;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (err) {
    throw new Error(`${label}: invalid JSON — ${err.message}`);
  }
}

/** MCP servers as JSON: `{ "name": { "command": "…", "args": [] } }`, or the `mcpServers` of a `.mcp.json`. */
export function mcpFrom(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return undefined;
  }
  const parsed = parseJson(text, 'MCP servers');
  const servers = parsed && typeof parsed === 'object' && parsed.mcpServers ? parsed.mcpServers : parsed;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new Error('MCP servers: expected an object of servers');
  }
  return servers;
}

/** The thinking setting: adaptive (the model decides), off, or a fixed budget. */
export function thinkingFrom(settings) {
  if (settings.thinking === 'disabled') {
    return { type: 'disabled' };
  }
  if (settings.thinking === 'budget') {
    return { type: 'enabled', budgetTokens: number(settings.thinkingBudget) ?? 8000 };
  }
  if (settings.thinking === 'adaptive') {
    return { type: 'adaptive' };
  }
  return undefined;
}

export function settingSources(settings) {
  const sources = [];
  if (settings.userSettings !== 'false') {
    sources.push('user');
  }
  if (settings.projectSettings !== 'false') {
    sources.push('project');
  }
  if (settings.localSettings !== 'false') {
    sources.push('local');
  }
  return sources;
}

/** The effort for this message: the panel's choice, else the setting. */
export function effortFor(request) {
  const effort = request.effort || chosen(request.settings.effort);
  if (!effort) {
    return undefined;
  }
  if (!EFFORTS.has(effort)) {
    throw new Error(`Unknown effort: ${effort}`);
  }
  return effort;
}

/** The permission mode for this message; bypassing needs its own explicit setting. */
export function permissionMode(mode, settings) {
  if (!MODES.has(mode)) {
    throw new Error(`Unknown mode: ${mode}`);
  }
  if (mode === 'bypassPermissions' && !isOn(settings.allowBypass)) {
    throw new Error('“Bypass permissions” is switched off. Enable it under Settings → Extensions → Claude Code first.');
  }
  return mode;
}

/** Settings handed to `claude` for this run only: fast mode, output style, "ask" rules, sandbox. */
export function flagSettings(settings) {
  const flags = {};
  if (settings.fastMode === 'true' || settings.fastMode === 'false') {
    flags.fastMode = settings.fastMode === 'true';
  }
  const style = String(settings.outputStyle ?? '').trim();
  if (style) {
    flags.outputStyle = style;
  }
  const ask = lines(settings.askTools);
  if (ask.length) {
    flags.permissions = { ask };
  }
  const sandbox = sandboxFrom(settings.sandbox);
  if (sandbox) {
    flags.sandbox = sandbox;
  }
  if (!Object.keys(flags).length) {
    return undefined;
  }
  return flags;
}

/** `on` / `on-auto` / `off` → the SDK's sandbox settings; `auto` leaves it to Claude Code. */
export function sandboxFrom(value) {
  if (value === 'off') {
    return { enabled: false };
  }
  if (value === 'on') {
    return { enabled: true };
  }
  if (value === 'on-auto') {
    return { enabled: true, autoAllowBashIfSandboxed: true };
  }
  return undefined;
}

/** The built-in tools: all of them (default), the read-only set, or an explicit list. */
export function toolsFrom(settings) {
  if (settings.toolset === 'readonly') {
    return READ_ONLY_TOOLS;
  }
  if (settings.toolset === 'custom') {
    const custom = lines(settings.customTools);
    return custom.length ? custom : undefined;
  }
  return undefined;
}

/** `--betas`: header names, one per line. */
export const betasFrom = (value) => lines(value);

/** Local plugin directories, one per line. */
export const pluginsFrom = (value) => lines(value).map((dir) => ({ type: 'local', path: home(dir) }));

/** Skills to load: nothing set leaves it to Claude Code, `all`, or names. */
export function skillsFrom(value) {
  const names = lines(value);
  if (!names.length) {
    return undefined;
  }
  if (names.length === 1 && names[0].toLowerCase() === 'all') {
    return 'all';
  }
  return names;
}

/** One `name | description | prompt | tools | model` line as a subagent. */
function agentFromFields(fields) {
  const [name, description, ...rest] = fields;
  if (!name || !description || !rest.length) {
    return null;
  }
  const model = rest.length >= 3 ? rest.at(-1) : '';
  const tools = rest.length >= 3 ? rest.at(-2) : rest[1] ?? '';
  const promptParts = rest.length >= 3 ? rest.slice(0, -2) : rest.slice(0, 1);
  const definition = { description, prompt: unescapeLine(promptParts.join(' | ')) };
  const toolList = lines(tools);
  if (toolList.length) {
    definition.tools = toolList;
  }
  if (model) {
    definition.model = model;
  }
  return [name, definition];
}

/**
 * Custom subagents: JSON (`{ "reviewer": { "description": …, "prompt": … } }`)
 * or one `name | description | prompt | tools | model` line each; `tools`
 * is comma-separated, `\n` in the prompt a line break.
 */
export function agentsFrom(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return undefined;
  }
  if (text.startsWith('{')) {
    return parseJson(text, 'Subagents');
  }
  const agents = {};
  for (const fields of rows(text)) {
    const entry = agentFromFields(fields);
    if (entry) {
      agents[entry[0]] = entry[1];
    }
  }
  if (!Object.keys(agents).length) {
    return undefined;
  }
  return agents;
}

/** Hooks as `Event | matcher | shell command` lines; the matcher may be empty or `*`. */
export function hookSpecsFrom(value) {
  const specs = [];
  for (const fields of rows(value)) {
    const [event, matcher, ...command] = fields;
    const shell = command.join(' | ');
    if (!HOOK_EVENTS.has(event) || !shell) {
      continue;
    }
    specs.push({ event, matcher: matcher && matcher !== '*' ? matcher : undefined, command: shell });
  }
  return specs;
}
