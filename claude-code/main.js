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
 * Claude Code as an agent in Lumen.
 *
 * Lumen loads this bundle into its main process (after the user approved it)
 * and calls `activate`. The Agent SDK runs the same engine as the `claude`
 * command, so the user's login, `CLAUDE.md`, settings and MCP servers apply.
 * Every tool the agent wants to use waits for the user's answer in the panel,
 * unless the chosen mode or the allowed tools say otherwise.
 *
 * The SDK starts the installed `claude` program; this bundle does not carry it.
 * Everything configurable lives in the extension's settings (see
 * `extension.json`); the panel adds the mode, the model and its effort per
 * message. The models come from `claude` itself (`supportedModels()`), so the
 * list always matches the installed version and the user's account.
 *
 * The work is split by topic under `src/`: `options` (settings → SDK options),
 * `run` (one message and its stream), `translate` and `usage` (SDK messages →
 * Lumen events), `permissions`, `hooks`, `commands`, `actions` (compact,
 * rewind, fork …), `models`.
 */

import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { action, checkpoints } from './src/actions.js';
import { mcpNotice } from './src/mcp.js';
import { fallbackModels, listModels } from './src/models.js';
import { answerPermission } from './src/permissions.js';
import { abortAllRuns, interruptRun, runTurn } from './src/run.js';

const TITLE_LIMIT = 80;
const SESSION_LIMIT = 40;

/** `/mcp` (optionally `/mcp status`) is answered here instead of being sent to Claude. */
const isMcpCommand = (text) => /^\/mcp(\s+(status|list))?\s*$/i.test(text.trim());

const provider = {
  async send(request, emit) {
    if (isMcpCommand(request.text)) {
      emit(await mcpNotice(request));
      return;
    }
    await runTurn(request, emit);
  },

  answer: answerPermission,

  interrupt: interruptRun,

  action,

  checkpoints: (request) => checkpoints(request),

  /** The conversations Claude Code keeps for this folder, newest first. */
  async sessions(cwd) {
    const list = await listSessions({ dir: cwd, limit: SESSION_LIMIT, includeWorktrees: false }).catch(() => []);
    return list
      .sort((a, b) => b.lastModified - a.lastModified)
      .map((session) => ({
        id: session.sessionId,
        title: (session.customTitle || session.summary || session.firstPrompt || session.sessionId).split('\n')[0].slice(0, TITLE_LIMIT),
        updatedAt: session.lastModified,
      }));
  },

  /** What the installed `claude` offers; if it cannot be asked, the last list or the plain aliases. */
  async models(options) {
    try {
      return await listModels(options);
    } catch (err) {
      console.warn('[claude-code] could not list models:', err.message);
      return fallbackModels();
    }
  },
};

export function activate(ctx) {
  ctx.agents.register('claude', provider);
  return abortAllRuns;
}
