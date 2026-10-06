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
 * Formatter for Lumen: formats and checks code in the Pureline style by
 * default, and hands files to Prettier when a project is set up for it.
 * The engines live in `src/`; this file wires them to Lumen.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { PURELINE_FILE } from './src/config/discover.js';
import { documentedTemplate } from './src/config/pureline.js';
import { createEngines } from './src/engines.js';
import { explainDocument, rulesDocument } from './src/reports.js';
import { resolveLanguage } from './src/languages.js';

const STATUS_PRIORITY = 20;

const CONFIG_FILE_NAMES = new Set(['.pureline', '.prettierrc', '.prettierignore', 'package.json']);

function isConfigFile(file) {
  const name = path.basename(file);
  return CONFIG_FILE_NAMES.has(name) || /^\.?prettier(?:rc|\.config)/.test(name);
}

function statusText(decision) {
  if (decision.engine === 'prettier') { return 'Prettier'; }
  if (decision.source === '.pureline') { return 'Pureline · .pureline'; }
  if (decision.source === 'prettier-fallback') { return 'Pureline · Prettier options'; }
  return 'Pureline';
}

async function writeDefaultConfig(ctx) {
  const root = ctx.workspace.root();
  if (!root) {
    ctx.ui.notify('Open a folder first: the .pureline file belongs in the project root.', 'warning');
    return;
  }
  const target = path.join(root, PURELINE_FILE);
  const exists = await fs.access(target).then(() => true, () => false);
  if (!exists) {
    await fs.writeFile(target, documentedTemplate(), 'utf8');
    ctx.ui.notify('.pureline created in the project root.', 'success');
  }
  if (exists) { ctx.ui.notify('There already is a .pureline in the project root.', 'info'); }
  ctx.ui.openFile(target);
}

export function activate(ctx) {
  const engines = createEngines(ctx, () => ctx.settings.all());
  const workspace = () => ctx.workspace.root();
  const activeFile = () => {
    const event = ctx.events.last('activeFile');
    return event ? { path: event.path ?? null, languageId: event.languageId ?? null } : null;
  };

  if (!ctx.formatters || !ctx.diagnostics) {
    ctx.log('This Lumen has no formatter API; the extension needs Lumen 0.7.0 or newer.');
  }
  ctx.formatters?.register('pureline', {
    supports: (file) => engines.supportsFormat(file, workspace()),
    format: (request) => engines.format(request),
  }, { priority: 50 });
  ctx.diagnostics?.register('pureline', {
    supports: (file) => engines.supportsCheck(file, workspace()),
    check: (request) => engines.check(request),
  });

  const refreshStatus = async () => {
    const file = activeFile();
    const show = String(ctx.settings.get('showStatus') ?? 'true') !== 'false';
    if (!show || !file?.path || !resolveLanguage(file)) {
      ctx.statusBar.set('engine', null);
      return;
    }
    const decision = await engines.decide(file, workspace()).catch(() => null);
    if (!decision) {
      ctx.statusBar.set('engine', null);
      return;
    }
    ctx.statusBar.set('engine', {
      text: statusText(decision),
      tooltip: `Formatter: ${engines.engineLabel(decision)} — click to show the configuration`,
      icon: 'wand-sparkles',
      command: 'format.explain',
      side: 'right',
      priority: STATUS_PRIORITY,
    });
  };

  const explain = async () => {
    const file = activeFile();
    if (!file) {
      ctx.ui.notify('Open a file first.', 'info');
      return;
    }
    const decision = await engines.decide(file, workspace());
    const language = resolveLanguage(file);
    const config = decision?.engine === 'pureline' ? engines.purelineConfig(decision, {}) : null;
    const label = decision ? engines.engineLabel(decision) : 'none';
    const markdown = explainDocument({ file, workspace: workspace(), decision, config, language, label });
    ctx.ui.openDocument('Formatter: configuration', markdown, 'markdown');
  };

  ctx.commands.register('format.explain', explain);
  ctx.commands.register('pureline.init', () => writeDefaultConfig(ctx));
  ctx.commands.register('pureline.rules', () => ctx.ui.openDocument('Pureline rules', rulesDocument(), 'markdown'));

  ctx.events.on('activeFile', refreshStatus);
  ctx.events.on('fileSaved', (event) => {
    if (isConfigFile(event.path)) { engines.forget(); }
    refreshStatus();
  });
  ctx.settings.onDidChange(() => {
    engines.forget();
    refreshStatus();
  });
  refreshStatus();

  return () => ctx.statusBar.set('engine', null);
}
