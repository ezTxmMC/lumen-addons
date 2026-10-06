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
 * Prettier's configuration, read — never executed. JSON, JSON5, flat YAML,
 * flat TOML and the `prettier` key of `package.json` are understood;
 * JavaScript and TypeScript configs are only detected (Prettier itself
 * resolves them). `.prettierignore` follows the rules of `.gitignore`.
 */

import { parseFlatToml, parseFlatYaml } from './flat-formats.js';
import { globToRegExp, matchGlob } from './glob.js';
import { parseJsonc } from './jsonc.js';

/** The file names Prettier looks for, in the order it prefers them. */
export const PRETTIER_CONFIG_FILES = Object.freeze([
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yaml',
  '.prettierrc.yml',
  '.prettierrc.json5',
  '.prettierrc.toml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.ts',
  '.prettierrc.cts',
  '.prettierrc.mts',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'prettier.config.ts',
  'prettier.config.cts',
  'prettier.config.mts',
]);

/** How a file is read: `json`, `yaml`, `toml`, `rc` (JSON or YAML), or `script` (not read). */
export function configKindOf(fileName) {
  if (fileName === '.prettierrc') { return 'rc'; }
  if (/\.(?:json|json5)$/.test(fileName)) { return 'json'; }
  if (/\.ya?ml$/.test(fileName)) { return 'yaml'; }
  if (/\.toml$/.test(fileName)) { return 'toml'; }
  return 'script';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseByKind(kind, text) {
  if (kind === 'json') { return parseJsonc(text); }
  if (kind === 'yaml') { return { value: parseFlatYaml(text), error: null }; }
  if (kind === 'toml') { return { value: parseFlatToml(text), error: null }; }
  if (kind === 'rc') {
    const looksLikeJson = /^\s*(?:\{|\/[/*])/.test(text);
    return looksLikeJson ? parseJsonc(text) : { value: parseFlatYaml(text), error: null };
  }
  return { value: undefined, error: 'not read' };
}

/**
 * Reads one Prettier config. Returns
 * `{ options, overrides, readable, error }` — `readable` is false for
 * script configs and for a `package.json` that names a shared config.
 */
export function parsePrettierConfig(fileName, text, isPackageJson = false) {
  if (isPackageJson) {
    const parsed = parseJsonc(text);
    const section = parsed.value?.prettier;
    if (!isObject(section)) { return { options: {}, overrides: [], readable: false, error: null }; }
    return { options: section, overrides: Array.isArray(section.overrides) ? section.overrides : [], readable: true, error: null };
  }
  const kind = configKindOf(fileName);
  if (kind === 'script') { return { options: {}, overrides: [], readable: false, error: null }; }
  const { value, error } = parseByKind(kind, text);
  if (error || !isObject(value)) {
    return { options: {}, overrides: [], readable: false, error: error ?? 'The config is not an object.' };
  }
  const jsonLike = kind === 'json' || (kind === 'rc' && /^\s*\{/.test(text));
  const overrides = jsonLike && Array.isArray(value.overrides) ? value.overrides : [];
  return { options: value, overrides, readable: true, error: null };
}

function asList(value) {
  if (typeof value === 'string') { return [value]; }
  return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}

function overrideApplies(override, relativePath) {
  if (!isObject(override)) { return false; }
  const files = asList(override.files);
  const excluded = asList(override.excludeFiles);
  const matches = files.some((pattern) => matchGlob(pattern, relativePath));
  return matches && !excluded.some((pattern) => matchGlob(pattern, relativePath));
}

/** The options for one file: the base options, then every matching override in order. */
export function resolvePrettierOptions(parsed, relativePath) {
  const { overrides, options } = parsed;
  let resolved = Object.fromEntries(Object.entries(options).filter(([key]) => key !== 'overrides'));
  for (const override of overrides) {
    if (overrideApplies(override, relativePath) && isObject(override.options)) {
      resolved = { ...resolved, ...override.options };
    }
  }
  return resolved;
}

/** The Pureline settings a set of Prettier options says — for the fallback when Prettier is not installed. */
export function prettierToPureline(options) {
  const config = {};
  const indent = {};
  if (Number.isInteger(options.tabWidth) && options.tabWidth >= 1 && options.tabWidth <= 16) { indent.size = options.tabWidth; }
  if (typeof options.useTabs === 'boolean') { indent.style = options.useTabs ? 'tab' : 'space'; }
  if (Object.keys(indent).length) { config.indent = indent; }
  if (typeof options.semi === 'boolean') { config.semicolons = options.semi; }
  if (Number.isInteger(options.printWidth) && options.printWidth >= 20) { config.printWidth = options.printWidth; }
  if (options.endOfLine === 'lf' || options.endOfLine === 'crlf') { config.endOfLine = options.endOfLine; }
  if (options.endOfLine === 'auto' || options.endOfLine === 'cr') { config.endOfLine = 'keep'; }
  return config;
}

/** Parses the lines of a `.prettierignore` (or `.gitignore`-style) file. */
export function parseIgnoreFile(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const negated = line.startsWith('!');
      return { pattern: negated ? line.slice(1) : line, negated };
    });
}

function ignorePatternMatches(pattern, relativePath) {
  let source = pattern.replace(/^\.\//, '');
  const directoryOnly = source.endsWith('/');
  if (directoryOnly) { source = source.slice(0, -1); }
  const anchored = source.startsWith('/') || source.slice(0, -1).includes('/');
  source = source.replace(/^\//, '');
  const segments = relativePath.split('/');
  const regex = globToRegExp(source);
  if (anchored) {
    // The pattern names the path itself or one of the folders above the file.
    for (let end = segments.length; end >= 1; end--) {
      if (directoryOnly && end === segments.length) { continue; }
      if (regex.test(segments.slice(0, end).join('/'))) { return true; }
    }
    return false;
  }
  return segments.some((segment, index) => {
    if (directoryOnly && index === segments.length - 1) { return false; }
    return regex.test(segment);
  });
}

/**
 * Does the ignore file (relative to `relativePath`'s base) exclude the file?
 * Later patterns win, `!` re-includes — like `.gitignore`.
 */
export function isIgnoredBy(entries, relativePath) {
  const path = String(relativePath).replace(/\\/g, '/').replace(/^\.\//, '');
  let ignored = false;
  for (const { pattern, negated } of entries) {
    if (ignorePatternMatches(pattern, path)) { ignored = !negated; }
  }
  return ignored;
}
