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
 * Choosing and running the engine for a file.
 *
 *   `.pureline` (nearest folder, wins within a folder)  ->  Pureline with that file
 *   Prettier config (nearest folder)                    ->  Prettier, if it is installed
 *   nothing                                             ->  Pureline defaults
 *
 * The `engine` setting can force one of them. Prettier only gets the file
 * types it supports; a missing Prettier falls back to Pureline once with a
 * note. Go and Crystal get their own formatter first, when it is installed.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { checkPureline } from './checker.js';
import { findNearest, findPrettierIgnore, ignoredByChain, isInside, loadPurelineChain, searchLimit } from './config/discover.js';
import { effectiveConfig, defaultsFor } from './config/pureline.js';
import { isIgnoredBy, parsePrettierConfig, prettierToPureline, resolvePrettierOptions } from './config/prettier.js';
import { formatPureline } from './format.js';
import { isPrettierFile, resolveLanguage } from './languages.js';
import { findPrettier, forgetBinaries, runPrettier, versionOf } from './prettier-runner.js';

export const SPEC_VERSION = '1.1';

const PRETTIER_LANGUAGE_IDS = new Set([
  'javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'json', 'jsonc', 'json5', 'css', 'scss', 'less', 'html',
  'vue', 'markdown', 'mdx', 'yaml', 'graphql', 'handlebars',
]);

const ENGINE_SETTINGS = new Set(['auto', 'pureline', 'prettier']);

/** How long an engine decision is remembered. */
const CACHE_MS = 1500;

const MISSING_PRETTIER_NOTE = 'A Prettier config was found but Prettier is not installed (set "prettierPath", run `npm i -D prettier` or install it globally) — Pureline formats instead.';

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

function posix(file) {
  return file.split(path.sep).join('/');
}

/** Prettier skips `node_modules` on its own and everything a `.prettierignore` lists. */
function isIgnoredByPrettier(filePath, ignoreFile) {
  if (filePath.split(/[\\/]/).includes('node_modules')) { return true; }
  if (!ignoreFile || !isInside(ignoreFile.folder, filePath)) { return false; }
  return isIgnoredBy(ignoreFile.entries, posix(path.relative(ignoreFile.folder, filePath)));
}

export function createEngines(ctx, readSettings) {
  const warnedWorkspaces = new Set();

  const settings = () => readSettings() ?? {};
  const reported = new Map();
  const decisions = new Map();

  /** A Prettier problem leaves the document alone; the user hears about it, but not on every keystroke. */
  function reportProblem(note) {
    ctx.log?.(note);
    const last = reported.get(note) ?? 0;
    if (Date.now() - last < 60_000) { return; }
    reported.set(note, Date.now());
    ctx.ui?.notify?.(note, 'warning');
  }

  /** What Prettier says about a file, resolved from its config (nothing when there is no config). */
  async function prettierOptionsFor(anchor, filePath) {
    if (!anchor?.prettier) { return { options: {}, parsed: null }; }
    const { file, name, packageJson } = anchor.prettier;
    const text = await readText(file);
    const parsed = parsePrettierConfig(name, text ?? '', packageJson);
    const relative = posix(path.relative(path.dirname(file), filePath));
    return { options: resolvePrettierOptions(parsed, relative), parsed };
  }

  async function purelineDecision(file, anchorFolder, stop) {
    const chain = anchorFolder ? await loadPurelineChain(anchorFolder, stop) : { config: {}, files: [], notes: [] };
    return {
      engine: 'pureline',
      source: anchorFolder ? '.pureline' : 'defaults',
      partial: chain.config,
      chain,
      ignored: ignoredByChain(chain.files, file.path),
      notes: [...chain.notes],
    };
  }

  async function prettierDecision(file, anchor, folder, stop, language) {
    const { options, parsed } = await prettierOptionsFor(anchor, file.path);
    const ignoreFile = await findPrettierIgnore(folder, stop);
    const ignored = isIgnoredByPrettier(file.path, ignoreFile);
    const binary = await findPrettier(ctx, { filePath: file.path, folder, setting: settings().prettierPath, stop });
    const base = { configFile: anchor?.prettier?.file ?? null, options, parsed, ignoreFile: ignoreFile?.folder ?? null, ignored, folder };
    if (binary) {
      return { engine: 'prettier', binary, version: await versionOf(ctx, binary.bin), notes: [], ...base };
    }
    return missingPrettier(language, base);
  }

  /** No Prettier: Pureline takes over where it can; the first format per workspace says so. */
  function missingPrettier(language, base) {
    if (!language) { return null; }
    return {
      engine: 'pureline',
      source: 'prettier-fallback',
      partial: prettierToPureline(base.options),
      chain: { config: {}, files: [], notes: [] },
      ignored: base.ignored,
      notes: [],
      fallbackNote: MISSING_PRETTIER_NOTE,
      configFile: base.configFile,
    };
  }

  /**
   * The engine for `file`, or null when no engine here handles it.
   * `{ engine, source, language, ... }` — see the branches for the rest.
   */
  async function decideUncached(file, workspace) {
    const language = resolveLanguage(file);
    const lowerId = String(file.languageId ?? '').toLowerCase();
    const prettierFile = Boolean(file.path) && (isPrettierFile(file.path) || PRETTIER_LANGUAGE_IDS.has(lowerId));
    if (!language && !prettierFile) { return null; }
    const requested = String(settings().engine ?? 'auto');
    const setting = ENGINE_SETTINGS.has(requested) ? requested : 'auto';
    const folder = file.path ? path.dirname(file.path) : workspace;
    const stop = searchLimit(file.path, workspace) ?? (file.path ? null : workspace);
    const withLanguage = (decision) => (decision ? { ...decision, language } : null);

    if (!folder) {
      return language ? withLanguage(await purelineDecision(file, null, null)) : null;
    }
    if (setting === 'prettier' && prettierFile) {
      const anchor = await findNearest(folder, stop, 'prettier');
      return withLanguage(await prettierDecision(file, anchor, folder, stop, language));
    }
    if (!language) {
      if (setting === 'pureline') { return null; }
      const anchor = await findNearest(folder, stop, 'prettier');
      return anchor ? withLanguage(await prettierDecision(file, anchor, folder, stop, null)) : null;
    }
    if (setting === 'pureline') {
      const anchor = await findNearest(folder, stop, 'pureline');
      return withLanguage(await purelineDecision(file, anchor?.folder ?? null, stop));
    }
    const anchor = await findNearest(folder, stop, prettierFile ? 'auto' : 'pureline');
    if (!anchor) { return withLanguage(await purelineDecision(file, null, stop)); }
    if (anchor.pureline) { return withLanguage(await purelineDecision(file, anchor.folder, stop)); }
    return withLanguage(await prettierDecision(file, anchor, folder, stop, language));
  }

  /**
   * `decideUncached` with a short memory: the editor asks `supports` and then
   * `format`/`check` for the same file in quick succession, and checking runs
   * while typing. Config changes show up after `CACHE_MS` or on `forget()`.
   */
  function decide(file, workspace) {
    const current = settings();
    const key = [file.path, file.languageId, workspace, current.engine, current.prettierPath].join('\0');
    const hit = decisions.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) { return hit.promise; }
    const promise = decideUncached(file, workspace).catch((error) => {
      ctx.log?.(`Could not choose an engine: ${error.message}`);
      return null;
    });
    decisions.set(key, { at: Date.now(), promise });
    if (decisions.size > 200) { decisions.clear(); }
    return promise;
  }

  /** The complete Pureline options for a decision, from the editor's options and the project's files. */
  function purelineConfig(decision, requestOptions) {
    const defaults = defaultsFor(decision.language.name, requestOptions, settings());
    return effectiveConfig(decision.partial, decision.language.name, defaults);
  }

  function engineLabel(decision) {
    if (decision.engine === 'prettier') { return decision.version ? `Prettier ${decision.version}` : 'Prettier'; }
    const origins = { '.pureline': '.pureline', defaults: 'defaults', 'prettier-fallback': 'Prettier options' };
    return `Pureline ${SPEC_VERSION} (${origins[decision.source]})`;
  }

  async function runGofmt(text, cwd) {
    try {
      const result = await ctx.exec('gofmt', [], { input: text, cwd, timeoutMs: 20_000 });
      if (result.code === 0 && result.stdout) { return { text: result.stdout }; }
      if (result.code !== 0 && result.stderr.trim()) { return { text: null, note: `gofmt: ${result.stderr.trim().split('\n')[0]}` }; }
    } catch {
      // gofmt is not installed: Pureline's own indentation does the job.
    }
    return { text: null };
  }

  async function runCrystalFormat(text, cwd) {
    try {
      const result = await ctx.exec('crystal', ['tool', 'format', '--no-color', '-'], { input: text, cwd, timeoutMs: 30_000 });
      if (result.code === 0 && result.stdout) { return { text: result.stdout }; }
      if (result.code !== 0 && result.stderr.trim()) { return { text: null, note: `crystal tool format: ${result.stderr.trim().split('\n')[0]}` }; }
    } catch {
      // Crystal is not installed: only whitespace is fixed.
    }
    return { text: null };
  }

  async function formatWithPureline(request, decision) {
    const language = decision.language;
    const notes = [...decision.notes];
    const workspaceKey = request.workspace ?? path.dirname(request.path ?? '/');
    if (decision.fallbackNote && !warnedWorkspaces.has(workspaceKey)) {
      warnedWorkspaces.add(workspaceKey);
      notes.push(decision.fallbackNote);
    }
    const config = purelineConfig(decision, request.options);
    const cwd = request.path ? path.dirname(request.path) : (request.workspace ?? undefined);
    let text = request.text;
    let external = false;

    if (language.name === 'go' && !request.range) {
      const result = await runGofmt(text, cwd);
      if (result.note) { notes.push(result.note); }
      if (result.text !== null) {
        text = result.text;
        external = true;
      }
    }
    if (language.name === 'crystal' && !request.range) {
      const result = await runCrystalFormat(text, cwd);
      if (result.note) { notes.push(result.note); }
      if (result.text !== null) { text = result.text; }
    }
    const formatted = formatPureline(text, request.languageId ?? language.name, config, { range: request.range, path: request.path });
    notes.push(...formatted.notes);
    let out = formatted.text;
    if (external && out !== text) {
      const again = await runGofmt(out, cwd);
      if (again.text !== null) { out = again.text; }
    }
    const result = { text: out, engine: engineLabel(decision) };
    return notes.length ? { ...result, notes } : result;
  }

  async function formatWithPrettier(request, decision) {
    const result = await runPrettier(ctx, {
      bin: decision.binary.bin,
      filePath: request.path,
      folder: path.dirname(request.path),
      text: request.text,
      range: request.range,
    });
    if (result.text === null) {
      reportProblem(result.note);
      return null;
    }
    return { text: result.text, engine: engineLabel(decision) };
  }

  return {
    decide,
    purelineConfig,
    engineLabel,

    /** Does some engine format this file? (Asked often; the decision is cheap.) */
    async supportsFormat(file, workspace) {
      return (await decide(file, workspace)) !== null;
    },

    async format(request) {
      const decision = await decide(request, request.workspace);
      if (!decision || decision.ignored) { return null; }
      if (decision.engine === 'prettier') { return formatWithPrettier(request, decision); }
      return formatWithPureline(request, decision);
    },

    /** Diagnostics come from Pureline only — a project that runs on Prettier has chosen another style. */
    async supportsCheck(file, workspace) {
      const language = resolveLanguage(file);
      if (!language || language.name === 'kotlin') { return false; }
      if (String(settings().checkOnType) === 'false') { return false; }
      const decision = await decide(file, workspace);
      return decision !== null && decision.engine === 'pureline' && !decision.ignored;
    },

    async check(request) {
      if (String(settings().checkOnType) === 'false') { return []; }
      const decision = await decide(request, request.workspace);
      if (!decision || decision.engine !== 'pureline' || decision.ignored) { return []; }
      const config = purelineConfig(decision, {});
      return checkPureline(request.text, request.languageId ?? decision.language.name, config);
    },

    forget() {
      decisions.clear();
      forgetBinaries(ctx);
    },
  };
}
