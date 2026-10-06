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
 * Readers for the two flat formats Prettier configs come in besides JSON:
 * `key: value` YAML and `key = value` TOML. Only top-level scalars are read —
 * enough for `tabWidth`, `useTabs`, `semi`, `printWidth`, `endOfLine`.
 * Nested content (`overrides`, plugin lists) is skipped on purpose.
 */

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) { quote = null; }
      continue;
    }
    if (ch === '"' || ch === '\'') { quote = ch; }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) { return line.slice(0, i); }
  }
  return line;
}

function scalar(raw) {
  const value = raw.trim();
  if (value === '') { return undefined; }
  if (value.toLowerCase() === 'true') { return true; }
  if (value.toLowerCase() === 'false') { return false; }
  if (value === 'null' || value === '~') { return null; }
  if (/^[+-]?\d+(\.\d+)?$/.test(value)) { return Number(value); }
  const quoted = /^(["'])(.*)\1$/.exec(value);
  if (quoted) { return quoted[2]; }
  if (value.startsWith('[') || value.startsWith('{')) { return undefined; }
  return value;
}

/** Flat YAML: top-level `key: value` pairs; indented lines and list items belong to a skipped block. */
export function parseFlatYaml(text) {
  const result = {};
  for (const rawLine of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line.trim() || line.trim() === '---' || /^\s/.test(line) || line.startsWith('-')) { continue; }
    const colon = line.indexOf(':');
    if (colon === -1) { continue; }
    const key = line.slice(0, colon).trim().replace(/^["']|["']$/g, '');
    const value = scalar(line.slice(colon + 1));
    if (key && value !== undefined) { result[key] = value; }
  }
  return result;
}

/** Flat TOML: `key = value` before the first `[table]`; tables (including `[[overrides]]`) are skipped. */
export function parseFlatToml(text) {
  const result = {};
  for (const rawLine of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) { continue; }
    if (line.startsWith('[')) { break; }
    const equals = line.indexOf('=');
    if (equals === -1) { continue; }
    const key = line.slice(0, equals).trim().replace(/^["']|["']$/g, '');
    const value = scalar(line.slice(equals + 1));
    if (key && value !== undefined) { result[key] = value; }
  }
  return result;
}
