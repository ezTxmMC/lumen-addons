/*
 * Copyright (C) 2026 ezTxmMC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of Lumen IDE. It is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version. See the LICENSE file for details.
 */

/** Small helpers every part of the Codex add-on shares. */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OUTPUT_LIMIT = 6000;

export const lines = (value) => String(value ?? '').split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
/** Setting lines without blanks and `#` comments. */
export const settingLines = (value) => lines(value).filter((entry) => !entry.startsWith('#'));
export const isOn = (value) => value === 'true';
export const expandHome = (value) => value.replace(/^~(?=\/|$)/, os.homedir());
export const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');

/** A TOML basic string, with the escapes a multi-line text needs. */
export function tomlString(value) {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
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

export function clip(text, limit = OUTPUT_LIMIT) {
  const value = String(text ?? '');
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}\n… (${value.length - limit} more characters)`;
}

/** The `codex` program: the path from the settings, or the first one found. */
export function findCodex(configured) {
  const name = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  if (configured && configured !== 'codex') {
    if (!fs.existsSync(configured)) {
      throw new Error(`codex not found at ${configured}`);
    }
    return configured;
  }
  // A desktop launcher often starts Lumen with a short PATH, so the usual homes come along.
  const home = os.homedir();
  const folders = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    path.join(home, '.local', 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  for (const folder of folders.filter(Boolean)) {
    const candidate = path.join(folder, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('Codex is not installed. Install it (npm install -g @openai/codex), sign in with `codex login`, or set its path under Settings → Extensions → ChatGPT Codex.');
}

/** Runs `codex <args>` to the end and returns what it printed. Never throws for a non-zero exit. */
export function runCodex(settings, args, { cwd, input, timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(findCodex(settings.codexPath), args, {
      cwd,
      env: { ...process.env, ...envFrom(settings.env) },
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    const out = [];
    const err = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/** Splits an argument line like a shell: spaces separate, quotes group, `\` escapes. */
export function splitArgs(value) {
  const tokens = [];
  let current = '';
  let quote = '';
  let started = false;
  const text = String(value ?? '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\\' && quote !== "'" && i + 1 < text.length) {
      current += text[++i];
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = '';
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}
