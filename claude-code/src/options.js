/*
 * Copyright (C) 2026 ezTxmMC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of Lumen IDE. It is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version. See the LICENSE file for details.
 */

/** The SDK's options for one message, from the request and the extension's settings. */

import os from 'node:os';
import { findClaude } from './program.js';
import {
  agentsFrom, betasFrom, chosen, effortFor, envFrom, flagSettings, home, isOn, lines, mcpFrom, number,
  permissionMode, pluginsFrom, settingSources, skillsFrom, thinkingFrom, toolsFrom,
} from './settings.js';

/** Additional instructions: the setting, then the per-chat system prompt. */
function systemPromptOf(request) {
  const append = [request.settings.appendSystemPrompt, request.systemPrompt]
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
  return { type: 'preset', preset: 'claude_code', ...(append ? { append } : {}) };
}

function withoutEmpty(options) {
  for (const key of Object.keys(options)) {
    if (options[key] === undefined) {
      delete options[key];
    }
    if (Array.isArray(options[key]) && !options[key].length) {
      delete options[key];
    }
  }
  return options;
}

/** Everything that is about the process itself: program, environment, settings layers. */
function processOptions(request) {
  const { settings } = request;
  const env = envFrom(settings.env);
  return {
    pathToClaudeCodeExecutable: findClaude(settings.claudePath),
    // Behave as `claude` does in a terminal: CLAUDE.md, the user's and the project's settings apply.
    settingSources: settingSources(settings),
    env: Object.keys(env).length ? { ...process.env, ...env } : undefined,
    settings: flagSettings(settings),
    persistSession: settings.persistSessions === 'false' ? false : undefined,
    betas: betasFrom(settings.betas),
    strictMcpConfig: isOn(settings.strictMcp) ? true : undefined,
  };
}

/** What Claude may use and know: tools, rules, folders, subagents, plugins, skills, MCP servers. */
function capabilityOptions(settings) {
  return {
    tools: toolsFrom(settings),
    allowedTools: lines(settings.allowedTools),
    disallowedTools: lines(settings.disallowedTools),
    additionalDirectories: lines(settings.additionalDirectories).map(home),
    agents: agentsFrom(settings.customAgents),
    plugins: pluginsFrom(settings.pluginDirs),
    skills: skillsFrom(settings.skills),
    mcpServers: mcpFrom(settings.mcpServers),
  };
}

/** How it answers: model, effort, thinking, limits. */
function modelOptions(request) {
  const { model, settings } = request;
  return {
    model: model || chosen(settings.model),
    fallbackModel: settings.fallbackModel || undefined,
    maxTurns: number(settings.maxTurns),
    maxBudgetUsd: Number(settings.maxBudget) > 0 ? Number(settings.maxBudget) : undefined,
    effort: effortFor(request),
    thinking: thinkingFrom(settings),
    includePartialMessages: settings.streaming !== 'false',
  };
}

/** `run` brings what belongs to this very message: the abort controller, `canUseTool`, hooks. */
export function optionsFor(request, run) {
  const { cwd, mode, sessionId, settings } = request;
  return withoutEmpty({
    cwd: cwd || os.homedir(),
    abortController: run.abort,
    permissionMode: permissionMode(mode, settings),
    canUseTool: run.canUseTool,
    hooks: run.hooks,
    resume: sessionId,
    systemPrompt: systemPromptOf(request),
    // Needed for “rewind”: Claude backs up files before it changes them.
    enableFileCheckpointing: settings.fileCheckpoints === 'false' ? undefined : true,
    allowDangerouslySkipPermissions: mode === 'bypassPermissions' ? true : undefined,
    ...processOptions(request),
    ...capabilityOptions(settings),
    ...modelOptions(request),
  });
}
