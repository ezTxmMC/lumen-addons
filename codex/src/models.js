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
 * The models Codex offers: from `~/.codex/models_cache.json` or — when that is
 * missing or the user asks for a fresh list — from `codex app-server`
 * (`model/list`). Each model brings the reasoning levels it supports.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { EFFORT_IDS } from './settings.js';
import { codexHome, envFrom, findCodex, lines } from './util.js';

/** How long `codex app-server` may take to list its models. */
const MODELS_TIMEOUT = 20_000;

/** The last list `codex app-server` reported, per program and environment. */
let modelCache = { key: '', at: 0, list: [] };

/** A reasoning level as the cache (`{ effort }`) or the app server (`{ reasoningEffort }`) writes it. */
function effortOf(level) {
  if (typeof level === 'string') {
    return { id: level };
  }
  const id = level?.effort ?? level?.reasoningEffort ?? level?.reasoning_effort ?? level?.id;
  if (typeof id !== 'string' || !id) {
    return null;
  }
  return { id, description: level.description || undefined };
}

const effortsOf = (levels) => (Array.isArray(levels) ? levels.map(effortOf).filter(Boolean) : undefined);

/**
 * The models Codex itself offers: it keeps the list its servers gave it in
 * ~/.codex/models_cache.json. Hidden ones stay out, the best come first.
 */
async function modelsFromCache(includeHidden = false) {
  const content = await fsp.readFile(path.join(codexHome(), 'models_cache.json'), 'utf8').catch(() => '');
  if (!content) {
    return [];
  }
  const cache = JSON.parse(content);
  return (Array.isArray(cache.models) ? cache.models : [])
    .filter((entry) => entry?.slug && (includeHidden || (entry.visibility ?? 'list') === 'list'))
    .sort((a, b) => (a.priority ?? 1e9) - (b.priority ?? 1e9))
    .map((entry) => ({
      id: entry.slug,
      label: entry.display_name || entry.slug,
      description: [entry.visibility === 'list' || !entry.visibility ? '' : 'Older model', entry.description].filter(Boolean).join(' — ') || undefined,
      efforts: effortsOf(entry.supported_reasoning_levels),
      defaultEffort: entry.default_reasoning_level || undefined,
    }));
}

/** One JSON-RPC conversation with `codex app-server` over its standard streams. */
function appServer(settings) {
  const child = spawn(findCodex(settings.codexPath), ['app-server'], {
    env: { ...process.env, ...envFrom(settings.env) },
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  const waiting = new Map();
  let counter = 0;
  const failAll = (err) => {
    for (const { reject } of waiting.values()) {
      reject(err);
    }
    waiting.clear();
  };
  child.once('error', failAll);
  child.once('close', (code) => failAll(new Error(`codex app-server exited with code ${code}`)));
  child.stdin.on('error', () => {});
  const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const entry = waiting.get(message?.id);
    if (!entry) {
      return;
    }
    waiting.delete(message.id);
    if (message.error) {
      entry.reject(new Error(message.error.message ?? 'codex app-server failed'));
      return;
    }
    entry.resolve(message.result);
  });
  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return {
    request(method, params) {
      const id = ++counter;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        write({ id, method, params });
      });
    },
    notify: (method, params) => write(params ? { method, params } : { method }),
    close() {
      reader.close();
      child.stdin.end();
      child.kill('SIGTERM');
    },
  };
}

/** Ask the installed `codex` for its models (`model/list`, all pages). */
async function modelsFromCli(settings, includeHidden = false) {
  const server = appServer(settings);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('codex did not report its models in time')), MODELS_TIMEOUT);
  });
  const ask = async () => {
    await server.request('initialize', { clientInfo: { name: 'lumen', title: 'Lumen', version: '1.0.0' } });
    server.notify('initialized');
    const rows = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await server.request('model/list', { ...(cursor ? { cursor } : {}), ...(includeHidden ? { includeHidden: true } : {}) });
      rows.push(...(result?.data ?? result?.models ?? result?.items ?? []));
      cursor = result?.nextCursor ?? result?.next_cursor;
      if (!cursor) {
        break;
      }
    }
    return rows;
  };
  try {
    const rows = await Promise.race([ask(), timeout]);
    return rows
      .filter((entry) => (entry?.model || entry?.id || entry?.slug) && (includeHidden || !entry.hidden))
      .map((entry) => ({
        id: entry.model || entry.id || entry.slug,
        label: entry.displayName || entry.display_name || entry.model || entry.id,
        description: [entry.hidden ? 'Older model' : '', entry.description].filter(Boolean).join(' — ') || undefined,
        efforts: effortsOf(entry.supportedReasoningEfforts ?? entry.supported_reasoning_levels),
        defaultEffort: entry.defaultReasoningEffort || entry.default_reasoning_level || undefined,
        isDefault: entry.isDefault === true,
      }));
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

/** The `model = "…"` at the top of ~/.codex/config.toml — what Codex uses without `--model`. */
export async function configuredModel() {
  const content = await fsp.readFile(path.join(codexHome(), 'config.toml'), 'utf8').catch(() => '');
  const top = content.split(/^\s*\[/m)[0];
  return /^\s*model\s*=\s*["']([^"']+)["']/m.exec(top)?.[1] ?? '';
}

/** Models the user adds by hand: `id` or `id | Label` per line. */
export function extraModels(value) {
  return lines(value).map((line) => {
    const [id, label] = line.split('|').map((part) => part.trim());
    return { id, label: label || id, efforts: EFFORT_IDS.map((effort) => ({ id: effort })) };
  });
}

/** From the source the settings name: the cache file, the CLI, or the cache with the CLI as fallback. */
async function freshModels(settings, refresh) {
  const source = settings.modelSource || 'auto';
  const legacy = settings.showLegacyModels === 'true';
  if (source === 'cache') {
    return modelsFromCache(legacy);
  }
  const key = JSON.stringify([settings.codexPath, settings.env, legacy]);
  const minutes = Number(settings.modelCacheMinutes || 60);
  const fresh = modelCache.key === key && Date.now() - modelCache.at < Math.max(0, minutes) * 60_000;
  if (source === 'auto' && !refresh) {
    const cached = await modelsFromCache(legacy).catch(() => []);
    if (cached.length) {
      return cached;
    }
  }
  if (fresh && !refresh && modelCache.list.length) {
    return modelCache.list;
  }
  try {
    const list = await modelsFromCli(settings, legacy);
    modelCache = { key, at: Date.now(), list };
    return list;
  } catch (err) {
    if (source === 'cli') {
      throw err;
    }
    console.warn('[codex] could not list models via codex app-server:', err.message);
    return modelsFromCache(legacy);
  }
}

export async function listModels({ settings = {}, refresh = false } = {}) {
  const models = await freshModels(settings, refresh);
  if (!models.some((entry) => entry.isDefault)) {
    const configured = await configuredModel();
    const match = models.find((entry) => entry.id === configured);
    if (match) {
      match.isDefault = true;
    }
  }
  const known = new Set(models.map((entry) => entry.id));
  return [...models, ...extraModels(settings.extraModels).filter((entry) => !known.has(entry.id))];
}


/** The usable context window of a model from Codex's cache (what its own meter counts), or 0. */
export async function contextWindowOf(model) {
  const content = await fsp.readFile(path.join(codexHome(), 'models_cache.json'), 'utf8').catch(() => '');
  if (!content) {
    return 0;
  }
  const slug = model || await configuredModel();
  const entry = (JSON.parse(content).models ?? []).find((candidate) => candidate?.slug === slug);
  if (!entry?.context_window) {
    return 0;
  }
  return Math.round(entry.context_window * ((entry.effective_context_window_percent ?? 100) / 100));
}
