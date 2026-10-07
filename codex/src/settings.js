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
 * From the extension's settings (and the panel's choices) to the `codex`
 * command line. `codex exec [options] [resume <id> | fork <id> | review …]`:
 * the options come first, then the subcommand — verified against codex 0.160.
 */

import fs from 'node:fs';
import path from 'node:path';
import { codexHome, expandHome, isOn, settingLines, tomlString } from './util.js';

export const SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
export const APPROVALS = new Set(['never', 'on-request', 'on-failure', 'untrusted']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const SUMMARIES = new Set(['auto', 'concise', 'detailed', 'none']);
const VERBOSITIES = new Set(['low', 'medium', 'high']);
const LOCAL_PROVIDERS = new Set(['lmstudio', 'ollama']);
const APPROVAL_SETTING = {
  'read-only': 'approvalReadOnly',
  'workspace-write': 'approvalWorkspace',
  'danger-full-access': 'approvalFull',
};

export const EFFORT_IDS = [...EFFORTS];

/** The sandbox for this message; full access needs its own explicit setting. */
export function sandboxFor(mode, settings) {
  if (!SANDBOXES.has(mode)) {
    throw new Error(`Unknown mode: ${mode}`);
  }
  if (mode === 'danger-full-access' && !isOn(settings.allowFullAccess)) {
    throw new Error('“Full access” is switched off. Enable it under Settings → Extensions → ChatGPT Codex first.');
  }
  return mode;
}

/** The reasoning effort for this message: the panel's choice, else the setting. */
export function effortFor(request) {
  const effort = request.effort || request.settings.reasoningEffort;
  if (!effort || effort === 'auto') {
    return undefined;
  }
  if (!EFFORTS.has(effort)) {
    throw new Error(`Unknown reasoning effort: ${effort}`);
  }
  return effort;
}

/** The approval policy of the mode, falling back to the general one. */
export function approvalFor(mode, settings) {
  const own = settings[APPROVAL_SETTING[mode]];
  if (APPROVALS.has(own)) {
    return own;
  }
  return APPROVALS.has(settings.approvalPolicy) ? settings.approvalPolicy : '';
}

/** `key=value` lines: valid ones are used, the rest is reported back. */
export function overridesOf(value) {
  const valid = [];
  const invalid = [];
  for (const line of settingLines(value)) {
    if (/^[A-Za-z_][\w.-]*\s*=\s*\S/.test(line)) {
      valid.push(line);
      continue;
    }
    invalid.push(line);
  }
  return { valid, invalid };
}

/** The profile: a `<name>.config.toml` layer when the file exists, otherwise a `[profiles.<name>]` table. */
export function profileArgs(profile) {
  if (!profile) {
    return [];
  }
  if (fs.existsSync(path.join(codexHome(), `${profile}.config.toml`))) {
    return ['--profile', profile];
  }
  return ['--config', `profile=${tomlString(profile)}`];
}

/** `name` enables a feature, `-name` disables it. */
function featureArgs(value) {
  return settingLines(value).flatMap((line) => {
    if (line.startsWith('-')) {
      return ['--disable', line.slice(1).trim()];
    }
    return ['--enable', line.replace(/^\+/, '').trim()];
  });
}

/** What the user told Codex to do on top of AGENTS.md: the setting and the chat's own system prompt. */
export function instructionsOf(request) {
  const parts = [request.settings.customInstructions, request.systemPrompt].map((part) => String(part ?? '').trim());
  return parts.filter(Boolean).join('\n\n');
}

function modelArgs(request, effort) {
  const { model, settings } = request;
  const args = [];
  const chosen = model || (settings.model !== 'auto' ? settings.model : '');
  if (chosen) {
    args.push('--model', chosen);
  }
  if (effort) {
    args.push('--config', `model_reasoning_effort=${tomlString(effort)}`);
  }
  if (SUMMARIES.has(settings.reasoningSummary)) {
    args.push('--config', `model_reasoning_summary=${tomlString(settings.reasoningSummary)}`);
  }
  if (VERBOSITIES.has(settings.verbosity)) {
    args.push('--config', `model_verbosity=${tomlString(settings.verbosity)}`);
  }
  if (isOn(settings.hideReasoning)) {
    args.push('--config', 'hide_agent_reasoning=true');
  }
  if (isOn(settings.oss)) {
    args.push('--oss');
    if (LOCAL_PROVIDERS.has(settings.localProvider)) {
      args.push('--local-provider', settings.localProvider);
    }
  }
  return args;
}

function sandboxArgs(request) {
  const { cwd, mode, settings } = request;
  const args = ['--sandbox', sandboxFor(mode, settings), '--cd', cwd];
  for (const dir of settingLines(settings.additionalDirectories)) {
    args.push('--add-dir', expandHome(dir));
  }
  if (settings.networkAccess === 'true' || settings.networkAccess === 'false') {
    args.push('--config', `sandbox_workspace_write.network_access=${settings.networkAccess}`);
  }
  if (isOn(settings.excludeTmp)) {
    args.push('--config', 'sandbox_workspace_write.exclude_slash_tmp=true', '--config', 'sandbox_workspace_write.exclude_tmpdir_env_var=true');
  }
  if (settings.webSearch && settings.webSearch !== 'auto') {
    args.push('--config', `web_search=${tomlString(settings.webSearch)}`);
  }
  const approval = approvalFor(mode, settings);
  if (approval) {
    args.push('--config', `approval_policy=${tomlString(approval)}`);
  }
  return args;
}

/** Options shared by every kind of run. */
export function commonArgs(request) {
  const { settings } = request;
  const args = ['exec', '--experimental-json', '--color', 'never'];
  args.push(...overridesOf(settings.configOverrides).valid.flatMap((entry) => ['--config', entry]));
  args.push(...profileArgs(settings.profile));
  args.push(...modelArgs(request, effortFor(request)));
  args.push(...sandboxArgs(request));
  if (settings.skipGitRepoCheck !== 'false') {
    args.push('--skip-git-repo-check');
  }
  if (isOn(settings.ephemeral)) {
    args.push('--ephemeral');
  }
  if (settings.outputSchema) {
    args.push('--output-schema', expandHome(settings.outputSchema));
  }
  args.push(...featureArgs(settings.features));
  return args;
}

/**
 * The command line of a turn. `sub` is `{ kind: 'review', target, prompt }`
 * for `/review`; a plain message resumes the session when it has one.
 */
export function argsFor(request, images, sub = {}) {
  const args = commonArgs(request);
  const instructions = request.settings.instructionsVia === 'prompt' ? '' : instructionsOf(request);
  if (instructions) {
    args.push('--config', `developer_instructions=${tomlString(instructions)}`);
  }
  if (sub.kind === 'review') {
    args.push('review', ...sub.target);
    return sub.prompt ? [...args, sub.prompt] : args;
  }
  if (request.sessionId) {
    args.push('resume', request.sessionId);
  }
  for (const image of images) {
    args.push('--image', image);
  }
  return args;
}

/** `codex exec fork <id>`: a new session with the history of the old one; with no prompt it only forks. */
export function forkArgs(request) {
  return [...commonArgs(request), 'fork', request.sessionId];
}

/** The text sent on standard input: files named, and the instructions when they travel in the prompt. */
export function promptWith(text, attachments = [], instructions = '') {
  const files = attachments.filter((entry) => entry.path && !/\.(png|jpe?g|gif|webp)$/i.test(entry.path));
  const body = files.length ? `${text}\n\nFiles: ${files.map((entry) => entry.path).join(', ')}` : text;
  if (!instructions) {
    return body;
  }
  return `<instructions>\n${instructions}\n</instructions>\n\n${body}`;
}
