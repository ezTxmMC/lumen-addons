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
 * The `.pureline` spec file: parsing, validation, inheritance and the
 * defaults that apply when a project has none.
 *
 * A bad value never breaks formatting: it becomes a note and the default
 * stays in force.
 */

import { isKnownRule, ruleById, SEVERITY_LEVELS } from '../rules.js';
import { parseJsonc } from './jsonc.js';

export const LANGUAGE_KEYS = ['java', 'javascript', 'typescript', 'go', 'crystal', 'kotlin'];

const LANGUAGE_ALIASES = {
  js: 'javascript', jsx: 'javascript', javascriptreact: 'javascript',
  ts: 'typescript', tsx: 'typescript', typescriptreact: 'typescript',
  golang: 'go', cr: 'crystal', kt: 'kotlin',
};

const SEVERITY_ALIASES = { warning: 'warn', err: 'error', information: 'info' };

const COMMON_KEYS = ['indent', 'endOfLine', 'printWidth', 'semicolons', 'finalNewline', 'trimTrailingWhitespace', 'rules'];
const TOP_KEYS = ['pureline', 'root', 'languages', 'ignore', ...COMMON_KEYS];

export const FALLBACK_CONFIG = Object.freeze({
  indent: Object.freeze({ style: 'space', size: 4 }),
  endOfLine: 'lf',
  printWidth: 120,
  semicolons: true,
  finalNewline: true,
  trimTrailingWhitespace: true,
  rules: Object.freeze({}),
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readIndent(raw, where, notes) {
  if (typeof raw === 'number') { return readIndent({ size: raw }, where, notes); }
  if (raw === 'tab' || raw === 'space') { return { style: raw }; }
  if (!isObject(raw)) {
    notes.push(`${where}: "indent" must be an object like { "style": "space", "size": 4 } (ignored)`);
    return undefined;
  }
  const result = {};
  for (const key of Object.keys(raw)) {
    if (key !== 'style' && key !== 'size') { notes.push(`${where}: unknown key "indent.${key}" (ignored)`); }
  }
  if (raw.style !== undefined) {
    if (raw.style === 'space' || raw.style === 'tab') { result.style = raw.style; }
    if (raw.style !== 'space' && raw.style !== 'tab') { notes.push(`${where}: "indent.style" must be "space" or "tab" (got ${JSON.stringify(raw.style)})`); }
  }
  if (raw.size !== undefined) {
    if (Number.isInteger(raw.size) && raw.size >= 1 && raw.size <= 16) { result.size = raw.size; }
    if (!(Number.isInteger(raw.size) && raw.size >= 1 && raw.size <= 16)) { notes.push(`${where}: "indent.size" must be a whole number from 1 to 16 (got ${JSON.stringify(raw.size)})`); }
  }
  return result;
}

function readRuleLevel(id, raw, where, notes) {
  if (raw === false) { return 'off'; }
  if (raw === true) { return ruleById(id)?.severity ?? 'info'; }
  const text = typeof raw === 'string' ? raw.toLowerCase() : '';
  const level = SEVERITY_ALIASES[text] ?? text;
  if (SEVERITY_LEVELS.includes(level)) { return level; }
  notes.push(`${where}: rule ${id} has the invalid value ${JSON.stringify(raw)}; use off, info, warn or error (ignored)`);
  return undefined;
}

function readRules(raw, where, notes) {
  if (!isObject(raw)) {
    notes.push(`${where}: "rules" must be an object (ignored)`);
    return undefined;
  }
  const rules = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isKnownRule(id)) {
      notes.push(`${where}: unknown rule "${id}" (not in the Pureline 1.1 catalog, ignored)`);
      continue;
    }
    const level = readRuleLevel(id, value, where, notes);
    if (level) { rules[id] = level; }
  }
  return rules;
}

function readBoolean(key, raw, where, notes) {
  if (typeof raw === 'boolean') { return raw; }
  notes.push(`${where}: "${key}" must be true or false (got ${JSON.stringify(raw)})`);
  return undefined;
}

/** The keys both the top level and a language section share. */
function readCommon(raw, where, notes) {
  const result = {};
  if (raw.indent !== undefined) {
    const indent = readIndent(raw.indent, where, notes);
    if (indent) { result.indent = indent; }
  }
  if (raw.endOfLine !== undefined) {
    if (['lf', 'crlf', 'keep'].includes(raw.endOfLine)) { result.endOfLine = raw.endOfLine; }
    if (!['lf', 'crlf', 'keep'].includes(raw.endOfLine)) { notes.push(`${where}: "endOfLine" must be "lf", "crlf" or "keep" (got ${JSON.stringify(raw.endOfLine)})`); }
  }
  if (raw.printWidth !== undefined) {
    const valid = Number.isInteger(raw.printWidth) && raw.printWidth >= 20 && raw.printWidth <= 1000;
    if (valid) { result.printWidth = raw.printWidth; }
    if (!valid) { notes.push(`${where}: "printWidth" must be a whole number from 20 to 1000 (got ${JSON.stringify(raw.printWidth)})`); }
  }
  for (const key of ['semicolons', 'finalNewline', 'trimTrailingWhitespace']) {
    if (raw[key] === undefined) { continue; }
    const value = readBoolean(key, raw[key], where, notes);
    if (value !== undefined) { result[key] = value; }
  }
  if (raw.rules !== undefined) {
    const rules = readRules(raw.rules, where, notes);
    if (rules) { result.rules = rules; }
  }
  return result;
}

function readLanguages(raw, notes) {
  if (!isObject(raw)) {
    notes.push('"languages" must be an object (ignored)');
    return undefined;
  }
  const result = {};
  for (const [name, section] of Object.entries(raw)) {
    const key = LANGUAGE_ALIASES[name.toLowerCase()] ?? name.toLowerCase();
    if (!LANGUAGE_KEYS.includes(key)) {
      notes.push(`languages: unknown language "${name}" (known: ${LANGUAGE_KEYS.join(', ')})`);
      continue;
    }
    if (!isObject(section)) {
      notes.push(`languages.${name} must be an object (ignored)`);
      continue;
    }
    for (const sectionKey of Object.keys(section)) {
      if (!COMMON_KEYS.includes(sectionKey)) { notes.push(`languages.${name}: unknown key "${sectionKey}" (ignored)`); }
    }
    result[key] = mergeConfig(result[key] ?? {}, readCommon(section, `languages.${name}`, notes));
  }
  return result;
}

function readIgnore(raw, notes) {
  if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== 'string')) {
    notes.push('"ignore" must be a list of glob strings (ignored)');
    return undefined;
  }
  return raw.map((entry) => entry.trim()).filter(Boolean);
}

/**
 * Reads the text of a `.pureline` file.
 * Returns `{ config, notes }`; `config` holds only the valid keys it found,
 * plus `root` (boolean) and `ignore` (list).
 */
export function parsePureline(text) {
  const notes = [];
  const { value, error } = parseJsonc(text);
  if (error) {
    notes.push(`.pureline is not valid JSON: ${error} — defaults are used`);
    return { config: {}, notes };
  }
  if (!isObject(value)) {
    notes.push('.pureline must contain a JSON object — defaults are used');
    return { config: {}, notes };
  }
  for (const key of Object.keys(value)) {
    if (!TOP_KEYS.includes(key)) { notes.push(`.pureline: unknown key "${key}" (ignored)`); }
  }
  const config = readCommon(value, '.pureline', notes);
  if (value.pureline !== undefined && !/^1(\.\d+)?$/.test(String(value.pureline))) {
    notes.push(`.pureline: "pureline" says ${JSON.stringify(value.pureline)}, this formatter implements Pureline 1.1`);
  }
  if (value.root !== undefined) {
    const root = readBoolean('root', value.root, '.pureline', notes);
    if (root !== undefined) { config.root = root; }
  }
  if (value.languages !== undefined) {
    const languages = readLanguages(value.languages, notes);
    if (languages) { config.languages = languages; }
  }
  if (value.ignore !== undefined) {
    const ignore = readIgnore(value.ignore, notes);
    if (ignore) { config.ignore = ignore; }
  }
  return { config, notes };
}

/** `over` wins; `indent`, `rules` and `languages` merge key by key. `ignore` and `root` stay per file. */
export function mergeConfig(base, over) {
  const result = { ...base };
  for (const key of ['endOfLine', 'printWidth', 'semicolons', 'finalNewline', 'trimTrailingWhitespace']) {
    if (over[key] !== undefined) { result[key] = over[key]; }
  }
  if (base.indent || over.indent) { result.indent = { ...base.indent, ...over.indent }; }
  if (base.rules || over.rules) { result.rules = { ...base.rules, ...over.rules }; }
  if (base.languages || over.languages) {
    const languages = { ...base.languages };
    for (const [name, section] of Object.entries(over.languages ?? {})) {
      languages[name] = mergeConfig(languages[name] ?? {}, section);
    }
    result.languages = languages;
  }
  return result;
}

/** The complete, flat options for one language: defaults < file < `languages.<name>`. */
export function effectiveConfig(config, languageName, defaults = FALLBACK_CONFIG) {
  const merged = mergeConfig(defaults, config ?? {});
  const section = merged.languages?.[languageName] ?? {};
  const flat = mergeConfig(merged, section);
  return {
    indent: { style: flat.indent?.style ?? 'space', size: flat.indent?.size ?? 4 },
    endOfLine: flat.endOfLine,
    printWidth: flat.printWidth,
    semicolons: flat.semicolons,
    finalNewline: flat.finalNewline,
    trimTrailingWhitespace: flat.trimTrailingWhitespace,
    rules: { ...flat.rules },
  };
}

export function indentUnit(config) {
  if (config.indent.style === 'tab') { return '\t'; }
  return ' '.repeat(config.indent.size);
}

/**
 * The layer below any project file: the editor's options, the extension's
 * `defaultIndent` and per-language customs (Go uses tabs, Crystal two spaces).
 */
export function defaultsFor(language, options = {}, settings = {}) {
  const defaultIndent = settings.defaultIndent ?? '4';
  const editor = { style: options.useTabs ? 'tab' : 'space', size: Number.isInteger(options.tabWidth) ? options.tabWidth : 4 };
  const fixed = { style: 'space', size: Number(defaultIndent) || 4 };
  let indent = defaultIndent === 'editor' ? editor : fixed;
  if (language === 'go') { indent = { style: 'tab', size: 4 }; }
  if (language === 'crystal') { indent = { style: 'space', size: 2 }; }
  return {
    indent,
    endOfLine: options.endOfLine ?? 'lf',
    printWidth: FALLBACK_CONFIG.printWidth,
    semicolons: true,
    finalNewline: options.insertFinalNewline ?? true,
    trimTrailingWhitespace: options.trimTrailingWhitespace ?? true,
    rules: {},
  };
}

/** The documented `.pureline` the "create .pureline" command writes. */
export function documentedTemplate() {
  return `{
  // Pureline spec file — https://github.com/ezTxmMC/lumen-ide (Pureline 1.1)
  "pureline": "1.1",

  // true: do not inherit values from a .pureline in a parent folder.
  "root": true,

  "indent": { "style": "space", "size": 4 },
  "endOfLine": "lf",
  "printWidth": 120,
  "semicolons": true,
  "finalNewline": true,
  "trimTrailingWhitespace": true,

  // off | info | warn | error. A rule that is "off" is neither fixed by the
  // formatter nor reported by the checker. Every other rule that has a safe
  // automatic fix is applied when you format.
  "rules": {
    // "PL-CF-002": "error",
    // "PL-FMT-001": "off"
  },

  // Per-language overrides of indent, endOfLine, printWidth, semicolons,
  // finalNewline, trimTrailingWhitespace and rules.
  "languages": {
    // "typescript": { "indent": { "size": 2 } },
    // "go": { "indent": { "style": "tab" } }
  },

  // Files the Pureline formatter and checker skip (globs relative to this
  // file; *, ** and ? are supported).
  "ignore": [
    // "dist/**",
    // "*.min.js"
  ]
}
`;
}
