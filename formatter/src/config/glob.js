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
 * A small glob matcher for the `ignore` list of a `.pureline` file, Prettier's
 * `overrides` and `.prettierignore`: `*`, `**`, `?`, `[a-z]` and `{a,b}`.
 * Paths always use `/` here.
 */

const SPECIAL = /[.+^$()|\\]/;

function translate(pattern) {
  let out = '';
  let braceDepth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      const slashAfter = pattern[i + 2] === '/';
      i += slashAfter ? 2 : 1;
      out += slashAfter ? '(?:.*/)?' : '.*';
      continue;
    }
    if (ch === '*') {
      out += '[^/]*';
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 2);
      if (close !== -1) {
        const body = pattern.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\');
        out += `[${body}]`;
        i = close;
        continue;
      }
    }
    if (ch === '{') {
      braceDepth++;
      out += '(?:';
      continue;
    }
    if (ch === '}' && braceDepth > 0) {
      braceDepth--;
      out += ')';
      continue;
    }
    if (ch === ',' && braceDepth > 0) {
      out += '|';
      continue;
    }
    out += SPECIAL.test(ch) ? `\\${ch}` : ch;
  }
  return out + ')'.repeat(braceDepth);
}

const cache = new Map();

/** The regular expression for a glob; a pattern with an unbalanced `{` still compiles. */
export function globToRegExp(pattern) {
  const cached = cache.get(pattern);
  if (cached) { return cached; }
  let regex;
  try {
    regex = new RegExp(`^${translate(pattern)}$`);
  } catch {
    regex = /$^/;
  }
  cache.set(pattern, regex);
  return regex;
}

/**
 * Does `relativePath` match `pattern`? A pattern without a slash matches the
 * file name at any depth (`*.min.js`); a leading `/` or `./` anchors it.
 * A pattern naming a directory (`dist/`, or matching a parent) covers its content.
 */
export function matchGlob(pattern, relativePath) {
  let source = String(pattern).trim();
  let path = String(relativePath).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!source) { return false; }
  let anchored = false;
  if (source.startsWith('./')) {
    source = source.slice(2);
    anchored = true;
  }
  if (source.startsWith('/')) {
    source = source.slice(1);
    anchored = true;
  }
  if (source.endsWith('/')) { source += '**'; }
  const regex = globToRegExp(source);
  const hasSlash = source.includes('/');
  if (regex.test(path)) { return true; }
  if (!hasSlash && !anchored) { return regex.test(path.split('/').pop()); }
  path = path.replace(/^\/+/, '');
  return globToRegExp(`${source}/**`).test(path);
}

/** True when any pattern matches. */
export function matchesAny(patterns, relativePath) {
  return patterns.some((pattern) => matchGlob(pattern, relativePath));
}
