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
 * Slash commands for the `/` palette: the SDK's `supportedCommands()` with
 * the source each command comes from (the SDK only marks the built-in ones,
 * so project, user and plugin commands are told apart by where they live).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** `a:b` is `a/b.md` in a commands folder. */
const asPath = (name) => name.replace(/:/g, path.sep);

function definedIn(root, name) {
  const relative = asPath(name);
  return [
    path.join(root, '.claude', 'commands', `${relative}.md`),
    path.join(root, '.claude', 'skills', relative, 'SKILL.md'),
  ].some((file) => fs.existsSync(file));
}

/** Where a command comes from; `plugins` are the names the session's init message lists. */
export function sourceOf(command, { cwd, plugins }) {
  if (command.builtin) {
    return 'builtin';
  }
  if (cwd && definedIn(cwd, command.name)) {
    return 'project';
  }
  if (definedIn(os.homedir(), command.name)) {
    return 'user';
  }
  const prefix = command.name.split(':')[0];
  if (command.name.includes(':') && plugins.has(prefix)) {
    return 'plugin';
  }
  if (command.name.startsWith('mcp__') || command.name.includes(':')) {
    return 'plugin';
  }
  // Not Claude Code's own and not a file of ours: a skill (listed in `init`, or managed elsewhere).
  return 'skill';
}

/** `AgentSlashCommand`s from `supportedCommands()`, with the init message's skills and plugins as context. */
export function toSlashCommands(commands, init) {
  const context = {
    cwd: init?.cwd,
    plugins: new Set((init?.plugins ?? []).map((plugin) => plugin.name)),
  };
  const seen = new Set();
  const result = [];
  for (const command of commands ?? []) {
    if (!command?.name || seen.has(command.name)) {
      continue;
    }
    seen.add(command.name);
    result.push({
      name: command.name.replace(/^\//, ''),
      description: command.description || undefined,
      argumentHint: command.argumentHint || undefined,
      source: sourceOf(command, context),
    });
  }
  return result;
}
