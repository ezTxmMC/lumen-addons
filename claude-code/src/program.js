/*
 * Copyright (C) 2026 ezTxmMC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of Lumen IDE. It is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version. See the LICENSE file for details.
 */

/** Finding the installed `claude` program. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The `claude` program: the path from the settings, or the first one found. */
export function findClaude(configured) {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  if (configured && configured !== 'claude') {
    if (!fs.existsSync(configured)) {
      throw new Error(`claude not found at ${configured}`);
    }
    return configured;
  }
  // A desktop launcher often starts Lumen with a short PATH, so the usual homes come along.
  const home = os.homedir();
  const folders = [
    ...(process.env.PATH ?? '').split(path.delimiter),
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ];
  for (const folder of folders.filter(Boolean)) {
    const candidate = path.join(folder, name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('Claude Code is not installed. Install it (npm install -g @anthropic-ai/claude-code) or set its path under Settings → Extensions → Claude Code.');
}
