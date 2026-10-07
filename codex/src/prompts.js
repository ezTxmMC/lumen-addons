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
 * Codex's custom prompts: Markdown files in `~/.codex/prompts/` that become
 * `/prompts:<name>` commands. Optional front matter gives `description` and
 * `argument-hint`; the body may use `$1`…`$9`, `$ARGUMENTS`, `$NAME` (filled
 * from `NAME=value` arguments) and `$$` for a literal dollar. Lumen also reads
 * `<project>/.codex/prompts/` the same way, and a project prompt wins over a
 * user prompt of the same name.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { codexHome, splitArgs } from './util.js';

const NAME_VALUE = /^([A-Z][A-Z0-9_]*)=([\s\S]*)$/;

/** `---` front matter as `{ description, 'argument-hint' }` plus the body. */
export function parsePrompt(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) {
    return { meta: {}, body: text };
  }
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = /^([\w-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (pair) {
      meta[pair[1]] = pair[2].replace(/^["']|["']$/g, '');
    }
  }
  return { meta, body: match[2] };
}

async function promptsIn(dir, source) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) {
      continue;
    }
    const text = await fsp.readFile(path.join(dir, entry.name), 'utf8').catch(() => '');
    const { meta, body } = parsePrompt(text);
    found.push({
      name: `prompts:${entry.name.slice(0, -3)}`,
      description: meta.description || undefined,
      argumentHint: meta['argument-hint'] || undefined,
      source,
      body,
    });
  }
  return found;
}

/** The prompts Codex (and the project) offer for a folder, project ones first. */
export async function discoverPrompts(cwd) {
  const project = await promptsIn(path.join(cwd, '.codex', 'prompts'), 'project');
  const user = await promptsIn(path.join(codexHome(), 'prompts'), 'user');
  const taken = new Set(project.map((entry) => entry.name));
  return [...project, ...user.filter((entry) => !taken.has(entry.name))];
}

/** Fills a prompt body like Codex does. */
export function expandPrompt(body, argLine) {
  const positional = [];
  const named = {};
  for (const token of splitArgs(argLine)) {
    const pair = NAME_VALUE.exec(token);
    if (pair) {
      named[pair[1]] = pair[2];
      continue;
    }
    positional.push(token);
  }
  return body.replace(/\$(\$|ARGUMENTS|[1-9]|[A-Z][A-Z0-9_]*)/g, (match, key) => {
    if (key === '$') {
      return '$';
    }
    if (key === 'ARGUMENTS') {
      return positional.join(' ');
    }
    if (/^[1-9]$/.test(key)) {
      return positional[Number(key) - 1] ?? '';
    }
    return named[key] ?? match;
  });
}

/** The prompt a `/prompts:name args` message stands for, or `null`. */
export async function resolvePrompt(cwd, name, argLine) {
  const entry = (await discoverPrompts(cwd)).find((candidate) => candidate.name === name);
  if (!entry) {
    return null;
  }
  return expandPrompt(entry.body, argLine);
}
