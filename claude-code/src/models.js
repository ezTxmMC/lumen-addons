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
 * The model list: asked from the installed `claude` (`supportedModels()`), so
 * it always matches the version and the user's account.
 */

import { EFFORTS, settingSources } from './settings.js';
import { withIdleQuery } from './idle.js';

/** The last model list `claude` reported, per program and environment. */
let modelCache = { key: '', at: 0, list: [] };

/** Models the user adds by hand: `id` or `id | Label` per line. */
function extraModels(value) {
  return String(value ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [id, label] = line.split('|').map((part) => part.trim());
    return { id, label: label || id, efforts: [...EFFORTS].map((effort) => ({ id: effort })) };
  });
}

/** Used only when `claude` cannot be asked: the aliases every version understands. */
const FALLBACK_MODELS = [
  { id: 'opus', label: 'Opus', efforts: [...EFFORTS].map((effort) => ({ id: effort })) },
  { id: 'sonnet', label: 'Sonnet', efforts: [...EFFORTS].map((effort) => ({ id: effort })) },
  { id: 'haiku', label: 'Haiku', efforts: [] },
];


/** Ask the installed `claude` which models it offers — without sending a message. */
const askClaude = (settings) => withIdleQuery(settings, {}, (run) => run.supportedModels());

/** `claude-opus-5-5[1m]` → `claude-opus-5-5`: the model without its context suffix. */
const bare = (id) => String(id ?? '').replace(/\[[^\]]*\]$/, '');

/** `claude-opus-5-5` → `Opus 5.5`, `claude-haiku-4-5-20251001` → `Haiku 4.5`; anything else stays as it is. */
function nameOf(id) {
  const parts = bare(id).replace(/^claude-/, '').replace(/-\d{8}$/, '').split('-');
  if (!/^[a-z]+$/.test(parts[0]) || !parts.slice(1).every((part) => /^\d+$/.test(part))) {
    return '';
  }
  return [parts[0][0].toUpperCase() + parts[0].slice(1), parts.slice(1).join('.')].filter(Boolean).join(' ');
}

/** The name Lumen shows: the version from the id, `(1M)` for the long-context variant; the CLI's own name otherwise. */
function labelled(rows) {
  const count = new Map();
  const label = (row) => {
    const name = nameOf(row.resolvedModel || row.value);
    if (!name) {
      return row.displayName || row.value;
    }
    return /\[1m\]$/i.test(row.value) || /\[1m\]$/i.test(row.resolvedModel ?? '') ? `${name} (1M)` : name;
  };
  for (const row of rows) {
    count.set(label(row), (count.get(label(row)) ?? 0) + 1);
  }
  // Names must tell rows apart: a repeated one gets the id behind it.
  return (row) => (count.get(label(row)) > 1 ? `${label(row)} (${row.value})` : label(row));
}

/** Older models that still answer; they only show up when the setting asks for them. */
const LEGACY_MODELS = [
  { id: 'claude-opus-4-5', label: 'Opus 4.5', efforts: ['low', 'medium', 'high'] },
  { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', efforts: [] },
  { id: 'claude-opus-4-1', label: 'Opus 4.1', efforts: [] },
  { id: 'claude-opus-4-0', label: 'Opus 4', efforts: [] },
  { id: 'claude-sonnet-4-0', label: 'Sonnet 4', efforts: [] },
  { id: 'claude-3-7-sonnet-latest', label: 'Sonnet 3.7', efforts: [] },
  { id: 'claude-3-5-haiku-latest', label: 'Haiku 3.5', efforts: [] },
].map((entry) => ({
  id: entry.id,
  label: entry.label,
  description: 'Older model',
  efforts: entry.efforts.map((effort) => ({ id: effort })),
}));

/** The older models, minus those the CLI already lists (by id or by what it resolves to). */
function legacyModels(listed) {
  const known = new Set(listed.flatMap((entry) => [entry.id, bare(entry.id)]));
  return LEGACY_MODELS.filter((entry) => !known.has(entry.id) && !listed.some((row) => row.label === entry.label));
}

/**
 * Claude Code's list, in the panel's shape. Its first row (`default`) only
 * names another model; that one gets marked as the default instead.
 */
function toModels(list) {
  const rows = Array.isArray(list) ? list.filter((entry) => entry?.value) : [];
  const fallback = rows.find((entry) => entry.value === 'default');
  const labelOf = labelled(rows.filter((entry) => entry.value !== 'default'));
  const models = rows.filter((entry) => entry.value !== 'default').map((entry) => ({
    id: entry.value,
    label: labelOf(entry),
    description: entry.description || undefined,
    efforts: entry.supportsEffort === false ? [] : (entry.supportedEffortLevels ?? []).map((effort) => ({ id: effort })),
    isDefault: Boolean(fallback?.resolvedModel) && entry.resolvedModel === fallback.resolvedModel,
  }));
  if (!fallback || models.some((entry) => entry.isDefault)) {
    return models;
  }
  // The default is none of the listed ones — offer it under its real name.
  return [{
    id: fallback.resolvedModel || 'default',
    label: nameOf(fallback.resolvedModel) || bare(fallback.resolvedModel) || fallback.displayName || 'Default',
    description: fallback.description || undefined,
    efforts: (fallback.supportedEffortLevels ?? []).map((effort) => ({ id: effort })),
    isDefault: true,
  }, ...models];
}

/** Cached for `modelCacheMinutes`; the panel's refresh button asks again. */
export async function listModels({ settings = {}, refresh = false } = {}) {
  const minutes = Number(settings.modelCacheMinutes || 60);
  const key = JSON.stringify([settings.claudePath, settings.env, settingSources(settings)]);
  const fresh = modelCache.key === key && Date.now() - modelCache.at < Math.max(0, minutes) * 60_000;
  const extras = extraModels(settings.extraModels);
  const withExtras = (list) => [...list, ...(settings.showLegacyModels === 'true' ? legacyModels(list) : []), ...extras];
  if (fresh && !refresh) {
    return withExtras(modelCache.list);
  }
  const list = toModels(await askClaude(settings));
  modelCache = { key, at: Date.now(), list };
  return withExtras(list);
}

/** The models to fall back on when `claude` cannot be asked: the last list, else the plain aliases. */
export function fallbackModels() {
  return modelCache.list.length ? modelCache.list : FALLBACK_MODELS;
}
