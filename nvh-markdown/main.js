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
 * nvh-markdown for Lumen: drives the `.nvmd` generator of the Novus library
 * nvh-markdown (`novusc run nvmd.nv build|watch|translate|clean|check`).
 *
 * The generator is Novus code, so the extension only runs `novusc` and reads
 * what it prints. Generator errors have the form `error: file:line: message`
 * and are shown as problems of the `.nvmd` file.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const GENERATOR_FILE = 'nvmd.nv';
const ERROR_LINE = /^error: (.+?):(\d+): (.*)$/;
const DEPS_PREFIX = path.join('github.com', 'ezTxmMC');

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

/** The paths named by `replace "github.com/ezTxmMC/nvh-markdown" "<path>"` in project.nv. */
async function replacedCheckouts(root) {
  const text = await fs.readFile(path.join(root, 'project.nv'), 'utf8').catch(() => '');
  const found = [];
  for (const match of text.matchAll(/^replace\s+"github\.com\/ezTxmMC\/nvh-markdown"\s+"([^"]+)"/gm)) {
    found.push(path.resolve(root, match[1]));
  }
  return found;
}

/** The fetched copies `$NOVUS_DEPS/github.com/ezTxmMC/nvh-markdown@<version>`, newest first. */
async function fetchedCheckouts() {
  const base = path.join(process.env.NOVUS_DEPS || path.join(os.homedir(), '.novus', 'deps'), DEPS_PREFIX);
  const names = await fs.readdir(base).catch(() => []);
  const copies = names.filter((name) => name.startsWith('nvh-markdown@'));
  const dated = await Promise.all(copies.map(async (name) => {
    const stat = await fs.stat(path.join(base, name)).catch(() => null);
    return { dir: path.join(base, name), time: stat ? stat.mtimeMs : 0 };
  }));
  return dated.sort((a, b) => b.time - a.time).map((entry) => entry.dir);
}

/** The `nvmd.nv` to run: the setting, else a checkout in or next to the project, a `replace` target, or a fetched copy. */
export async function findGenerator(root, setting) {
  const wanted = (setting ?? '').trim();
  if (wanted) {
    return path.resolve(root ?? process.cwd(), wanted);
  }
  const folders = [
    ...(root ? [path.join(root, 'nvh-markdown'), path.join(root, '..', 'nvh-markdown')] : []),
    ...(root ? await replacedCheckouts(root) : []),
    ...await fetchedCheckouts(),
  ];
  for (const folder of folders) {
    const file = path.join(folder, GENERATOR_FILE);
    if (await exists(file)) {
      return file;
    }
  }
  return null;
}

/** `error: file:line: message` lines -> problems, grouped by absolute file. */
export function parseErrors(output, cwd) {
  const byFile = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = ERROR_LINE.exec(line.trim());
    if (!match) {
      continue;
    }
    const file = path.resolve(cwd, match[1]);
    const list = byFile.get(file) ?? [];
    list.push({ line: Math.max(0, Number(match[2]) - 1), column: 0, severity: 'error', message: match[3], source: 'nvh-markdown' });
    byFile.set(file, list);
  }
  return byFile;
}

export function activate(ctx) {
  /** Absolute file -> problems of the last generator run. */
  let problems = new Map();

  const setting = (key) => ctx.settings.get(key) ?? '';
  const novusc = () => setting('novusc').trim() || 'novusc';
  const root = () => ctx.workspace.root();

  const activeNvmd = () => {
    const file = ctx.events.last('activeFile')?.path;
    return file && file.endsWith('.nvmd') ? file : null;
  };

  const folders = () => setting('folders').split(',').map((entry) => entry.trim()).filter(Boolean);

  /** Run the generator; null (after telling the user) when it cannot be found. */
  async function generator(args, options = {}) {
    const cwd = root();
    if (!cwd) {
      ctx.ui.notify('Open a project folder first.', 'warning');
      return null;
    }
    const script = await findGenerator(cwd, setting('generator'));
    if (!script) {
      ctx.ui.notify('nvh-markdown was not found. Run "novusc deps" in the project or set its nvmd.nv in the settings.', 'warning');
      return null;
    }
    try {
      const result = await ctx.exec(novusc(), ['run', script, ...args], { cwd, timeoutMs: options.timeoutMs });
      return { cwd, script, result, output: `${result.stdout}\n${result.stderr}` };
    } catch (err) {
      ctx.ui.notify(`${novusc()} could not be started: ${err.message}`, 'error');
      return null;
    }
  }

  function remember(run, scope) {
    const found = parseErrors(run.output, run.cwd);
    for (const file of scope) {
      problems.delete(file);
    }
    for (const [file, list] of found) {
      problems.set(file, list);
    }
    return [...found.values()].reduce((sum, list) => sum + list.length, 0);
  }

  async function build(paths, scope, label) {
    const args = ['build', ...paths];
    if (setting('force') === 'true') {
      args.push('--force');
    }
    const run = await generator(args);
    if (!run) {
      return;
    }
    const errors = remember(run, scope);
    if (run.result.code === 0) {
      ctx.ui.notify(`${label}: ${run.stdout.trim().split(/\r?\n/).pop() || 'done'}`, 'success');
      ctx.ui.refreshProject();
      return;
    }
    const first = (run.output.split(/\r?\n/).find((line) => ERROR_LINE.test(line.trim())) ?? run.output.trim()).slice(0, 300);
    ctx.ui.notify(`${label} failed (${errors || 'no'} problems): ${first}`, 'error');
  }

  async function generateFile(file) {
    const target = file ?? activeNvmd();
    if (!target) {
      ctx.ui.notify('The active file is not a .nvmd file.', 'warning');
      return;
    }
    await build([target], [target], 'Generate .nvh');
  }

  async function generateAll() {
    const base = root();
    if (!base) {
      ctx.ui.notify('Open a project folder first.', 'warning');
      return;
    }
    const paths = folders();
    await build(paths.length ? paths : ['.'], [...problems.keys()], 'Generate all .nvmd');
  }

  async function translate() {
    const target = activeNvmd();
    if (!target) {
      ctx.ui.notify('The active file is not a .nvmd file.', 'warning');
      return;
    }
    const run = await generator(['translate', target]);
    if (!run) {
      return;
    }
    remember(run, [target]);
    if (run.result.code !== 0) {
      ctx.ui.notify(`Translation failed: ${run.output.trim().slice(0, 300)}`, 'error');
      return;
    }
    ctx.ui.openDocument(`${path.basename(target, '.nvmd')}.nvh`, run.result.stdout, 'nvh');
  }

  async function clean() {
    const paths = folders();
    const confirmed = await ctx.ui.confirm('Remove generated files', `Remove the .nvh files generated from .nvmd in ${(paths.length ? paths : ['.']).join(', ')}?`, { danger: true, confirmLabel: 'Remove' });
    if (!confirmed) {
      return;
    }
    const run = await generator(['clean', ...(paths.length ? paths : ['.'])]);
    if (!run) {
      return;
    }
    ctx.ui.notify(run.result.code === 0 ? run.stdout.trim() : run.output.trim().slice(0, 300), run.result.code === 0 ? 'success' : 'error');
    ctx.ui.refreshProject();
  }

  /** Build, then `novusc check` the program; the errors name the .nvmd lines. */
  async function check() {
    const paths = folders();
    const args = ['check', ...(paths.length ? paths : ['.']), '--main', setting('main').trim() || 'main.nv', '--novusc', novusc()];
    const run = await generator(args, { timeoutMs: 300_000 });
    if (!run) {
      return;
    }
    const errors = remember(run, [...problems.keys()]);
    ctx.ui.notify(run.result.code === 0 ? 'No problems found.' : `${errors} problems found.`, run.result.code === 0 ? 'success' : 'error');
  }

  async function watch() {
    const base = root();
    const script = base ? await findGenerator(base, setting('generator')) : null;
    if (!script) {
      ctx.ui.notify('nvh-markdown was not found. Run "novusc deps" in the project or set its nvmd.nv in the settings.', 'warning');
      return;
    }
    const paths = folders();
    const quoted = [novusc(), 'run', script, 'watch', ...(paths.length ? paths : ['.'])].map((part) => JSON.stringify(part));
    ctx.ui.runInTerminal(quoted.join(' '), { cwd: base, title: 'nvmd watch' });
  }

  ctx.commands.register('generate-file', (args) => generateFile(typeof args === 'string' ? args : undefined));
  ctx.commands.register('generate-all', generateAll);
  ctx.commands.register('translate', translate);
  ctx.commands.register('clean', clean);
  ctx.commands.register('check', check);
  ctx.commands.register('watch', watch);

  ctx.events.on('fileSaved', (event) => {
    if (setting('generateOnSave') !== 'true' || !event.path.endsWith('.nvmd')) {
      return;
    }
    generateFile(event.path);
  });

  /** A live check translates a copy of the text, so unsaved edits are covered too. */
  async function liveCheck(text) {
    const base = root();
    const script = base ? await findGenerator(base, setting('generator')) : null;
    if (!script) {
      return null;
    }
    const dir = await ctx.storage.dir();
    const copy = path.join(dir, 'check.nvmd');
    await fs.writeFile(copy, text, 'utf8');
    const result = await ctx.exec(novusc(), ['run', script, 'translate', copy], { cwd: base, timeoutMs: 60_000 }).catch(() => null);
    if (!result) {
      return null;
    }
    const found = parseErrors(`${result.stdout}\n${result.stderr}`, base);
    const own = found.get(copy);
    if (own) {
      return own;
    }
    return result.code === 0 ? [] : null;
  }

  ctx.diagnostics.register('nvmd', {
    supports: ({ languageId }) => languageId === 'nvmd',
    async check({ path: file, text }) {
      if (setting('liveCheck') === 'true') {
        const live = await liveCheck(text);
        if (live) {
          return live;
        }
      }
      return file ? problems.get(file) ?? [] : [];
    },
  });

  return () => {
    problems = new Map();
  };
}
