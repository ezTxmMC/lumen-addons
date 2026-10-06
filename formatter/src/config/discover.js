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
 * Finds the configuration that applies to a file: walks up from its folder
 * to the workspace root (to the filesystem root for a file outside the
 * workspace). The NEAREST folder holding any config wins; inside one folder
 * `.pureline` beats the Prettier configs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { matchesAny } from './glob.js';
import { mergeConfig, parsePureline } from './pureline.js';
import { parseIgnoreFile, PRETTIER_CONFIG_FILES, parsePrettierConfig } from './prettier.js';

export const PURELINE_FILE = '.pureline';

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** True when `file` lies in `folder` (or is it). */
export function isInside(folder, file) {
  const relative = path.relative(folder, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** The folders from `start` up to `stop` (inclusive), or up to the filesystem root. */
export function foldersUp(start, stop) {
  const folders = [];
  let current = path.resolve(start);
  for (;;) {
    folders.push(current);
    if (stop && path.resolve(stop) === current) { return folders; }
    const parent = path.dirname(current);
    if (parent === current) { return folders; }
    current = parent;
  }
}

/** Where the search for a file's config stops: the workspace root when the file is inside it. */
export function searchLimit(filePath, workspaceRoot) {
  if (workspaceRoot && filePath && isInside(workspaceRoot, filePath)) { return workspaceRoot; }
  return null;
}

/** What one folder holds: `{ pureline: file|null, prettier: { file, name, packageJson }|null }`. */
export async function configsIn(folder) {
  const pureline = path.join(folder, PURELINE_FILE);
  const result = { pureline: (await exists(pureline)) ? pureline : null, prettier: null };
  for (const name of PRETTIER_CONFIG_FILES) {
    const file = path.join(folder, name);
    if (await exists(file)) {
      result.prettier = { file, name, packageJson: false };
      return result;
    }
  }
  const packageFile = path.join(folder, 'package.json');
  const text = await readText(packageFile);
  if (text && text.includes('"prettier"')) {
    const parsed = parsePrettierConfig('package.json', text, true);
    if (parsed.readable || /"prettier"\s*:\s*"/.test(text)) {
      result.prettier = { file: packageFile, name: 'package.json', packageJson: true };
    }
  }
  return result;
}

/**
 * The nearest folder with a config the engine setting allows.
 * `which`: `auto` (either), `pureline` or `prettier`. Returns
 * `{ folder, pureline, prettier }` or null.
 */
export async function findNearest(startFolder, stop, which = 'auto') {
  for (const folder of foldersUp(startFolder, stop)) {
    const found = await configsIn(folder);
    const pureline = which !== 'prettier' ? found.pureline : null;
    const prettier = which !== 'pureline' ? found.prettier : null;
    if (pureline || prettier) { return { folder, pureline, prettier }; }
  }
  return null;
}

/**
 * Reads the `.pureline` of `folder` and, unless it says `root: true`, those
 * of the folders above it; nearer files override farther ones.
 * Returns `{ config, files: [{ file, folder, ignore }], notes }`, nearest first.
 */
export async function loadPurelineChain(folder, stop) {
  const files = [];
  const notes = [];
  let merged = {};
  const chain = [];
  for (const candidate of foldersUp(folder, stop)) {
    const file = path.join(candidate, PURELINE_FILE);
    const text = await readText(file);
    if (text === null) { continue; }
    const { config, notes: fileNotes } = parsePureline(text);
    for (const note of fileNotes) { notes.push(`${file}: ${note}`); }
    chain.push({ file, folder: candidate, config });
    if (config.root === true) { break; }
  }
  for (const entry of [...chain].reverse()) { merged = mergeConfig(merged, entry.config); }
  for (const entry of chain) { files.push({ file: entry.file, folder: entry.folder, ignore: entry.config.ignore ?? [] }); }
  return { config: merged, files, notes };
}

/** Is the file excluded by the `ignore` list of any `.pureline` in the chain? */
export function ignoredByChain(files, filePath) {
  if (!filePath) { return false; }
  return files.some((entry) => {
    if (!entry.ignore.length || !isInside(entry.folder, filePath)) { return false; }
    return matchesAny(entry.ignore, path.relative(entry.folder, filePath).split(path.sep).join('/'));
  });
}

/** The nearest `.prettierignore` above the file: `{ folder, entries }` or null. */
export async function findPrettierIgnore(startFolder, stop) {
  for (const folder of foldersUp(startFolder, stop)) {
    const text = await readText(path.join(folder, '.prettierignore'));
    if (text !== null) { return { folder, entries: parseIgnoreFile(text) }; }
  }
  return null;
}
