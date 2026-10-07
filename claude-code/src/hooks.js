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
 * Hooks from the settings: one `Event | matcher | shell command` line each.
 * The command runs like a Claude Code hook — the event's JSON on stdin, exit
 * code 2 blocks, a JSON answer on stdout is passed on — and what it blocks
 * shows up as a notice in the chat.
 */

import { spawn } from 'node:child_process';
import { hookSpecificsFor } from './hook-output.js';

/** How long a hook command may run. */
const HOOK_TIMEOUT = 60_000;

/** Runs a shell command with `input` as JSON on stdin; resolves with its exit code and output. */
export function runCommand(command, input, { cwd, signal }) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true, cwd, signal, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), HOOK_TIMEOUT);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr || err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
  });
}

function parseOutput(stdout) {
  const text = stdout.trim();
  if (!text.startsWith('{')) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The SDK hook callback for one command. */
function callbackFor(spec, { cwd, emit }) {
  const label = `${spec.event}${spec.matcher ? ` ${spec.matcher}` : ''}`;
  return async (input, _toolUseId, { signal }) => {
    const result = await runCommand(spec.command, input, { cwd, signal });
    const json = parseOutput(result.stdout);
    if (result.code === 2) {
      const reason = result.stderr.trim() || result.stdout.trim() || 'blocked by hook';
      emit({ kind: 'notice', level: 'warn', text: `Hook blocked (${label}): ${reason}` });
      return hookSpecificsFor(spec.event, input, { block: true, reason });
    }
    if (result.code !== 0) {
      emit({ kind: 'notice', level: 'warn', text: `Hook failed (${label}, exit ${result.code}): ${result.stderr.trim() || spec.command}` });
      return {};
    }
    if (json) {
      if (json.decision === 'block' || json.continue === false) {
        emit({ kind: 'notice', level: 'warn', text: `Hook blocked (${label}): ${json.reason || json.stopReason || 'blocked by hook'}` });
      }
      return json;
    }
    return hookSpecificsFor(spec.event, input, { context: result.stdout.trim() });
  };
}

/** The SDK's `hooks` option for the parsed specs, or `undefined` for none. */
export function hooksOption(specs, context) {
  if (!specs.length) {
    return undefined;
  }
  const hooks = {};
  for (const spec of specs) {
    hooks[spec.event] ??= [];
    hooks[spec.event].push({ ...(spec.matcher ? { matcher: spec.matcher } : {}), hooks: [callbackFor(spec, context)] });
  }
  return hooks;
}
