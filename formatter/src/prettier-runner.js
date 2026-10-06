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
 * Running Prettier. The binary is looked up in this order: the `prettierPath`
 * setting, `node_modules/.bin/prettier` in the file's folder or above, and
 * `prettier` on the PATH. It reads the text from stdin; anything but a clean
 * exit is a note and `null` — never a half-formatted document.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { foldersUp } from './config/discover.js';

const TIMEOUT_MS = 30_000;
/** A binary that was missing is looked for again after this long (someone may have installed it). */
const MISSING_RETRY_MS = 30_000;

async function isFile(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * The Prettier to use for a file: `{ bin, source }` where `source` is
 * `setting`, `local` or `path`; `null` when there is none.
 */
export async function findPrettier(ctx, { filePath, folder, setting, stop }) {
  const configured = String(setting ?? '').trim();
  if (configured && (await isFile(configured))) { return { bin: configured, source: 'setting' }; }

  const name = ctx.platform === 'win32' ? 'prettier.cmd' : 'prettier';
  for (const candidate of foldersUp(folder ?? path.dirname(filePath ?? '/'), stop)) {
    const bin = path.join(candidate, 'node_modules', '.bin', name);
    if (await isFile(bin)) { return { bin, source: 'local' }; }
  }
  if (await runnable(ctx, 'prettier')) { return { bin: 'prettier', source: 'path' }; }
  return null;
}

async function runnable(ctx, bin) {
  const version = await versionOf(ctx, bin);
  return version !== null;
}

const caches = new WeakMap();

function versionCache(ctx) {
  if (!caches.has(ctx)) { caches.set(ctx, new Map()); }
  return caches.get(ctx);
}

/** `3.3.2`, or null when the program does not run. Remembered per binary and per context. */
export async function versionOf(ctx, bin) {
  const versions = versionCache(ctx);
  const hit = versions.get(bin);
  if (hit && (hit.version !== null || Date.now() - hit.at < MISSING_RETRY_MS)) { return hit.version; }
  let version = null;
  try {
    const result = await ctx.exec(bin, ['--version'], { timeoutMs: 10_000 });
    if (result.code === 0) { version = result.stdout.trim().split(/\s+/)[0] || null; }
  } catch {
    version = null;
  }
  versions.set(bin, { version, at: Date.now() });
  return version;
}

/** Forget what was learned about binaries — after the setting or a project changed. */
export function forgetBinaries(ctx) {
  versionCache(ctx).clear();
}

function firstLine(text) {
  return String(text).split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

/**
 * Formats `text` with Prettier. Returns `{ text }` or `{ text: null, note }`.
 * `range` (`{ from, to }`) is passed as `--range-start/--range-end`.
 */
export async function runPrettier(ctx, { bin, filePath, folder, text, range }) {
  const args = ['--stdin-filepath', filePath];
  if (range) { args.push('--range-start', String(range.from), '--range-end', String(range.to)); }
  let result;
  try {
    result = await ctx.exec(bin, args, { cwd: folder, input: text, timeoutMs: TIMEOUT_MS });
  } catch (error) {
    return { text: null, note: `Prettier could not be started: ${error.message}` };
  }
  if (result.timedOut) { return { text: null, note: 'Prettier took too long and was stopped.' }; }
  if (result.code !== 0) {
    return { text: null, note: `Prettier failed (exit ${result.code}): ${firstLine(result.stderr) || 'no message'}` };
  }
  if (result.stderr.trim()) {
    return { text: null, note: `Prettier reported: ${firstLine(result.stderr)}` };
  }
  return { text: result.stdout };
}
