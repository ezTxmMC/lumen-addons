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
 * The Pureline formatter — pure: text in, text out, no files, no processes.
 *
 *   formatPureline(text, languageId, config, { range }) -> { text, notes }
 *
 * `config` is the flat result of `effectiveConfig`. The pipeline runs the
 * structural fixes (blocks, `else`, semicolons), then the whitespace, then
 * the call collapsing and the whitespace once more, until nothing changes —
 * which is what makes the formatter idempotent.
 */

import { runChanges } from './edits.js';
import { reflowCrystal } from './crystal.js';
import { findBraceChanges } from './fixes/braces.js';
import { findCallChanges } from './fixes/calls.js';
import { findElseChanges } from './fixes/else.js';
import { findSemicolonChanges } from './fixes/semicolons.js';
import { reflow } from './indent.js';
import { indentUnit } from './config/pureline.js';
import { looksLikeJsx } from './jsx.js';
import { isRuleOn } from './rules.js';
import { analyze, computeLineStarts, lineOf } from './source.js';
import { resolveLanguage } from './languages.js';

const MAX_ROUNDS = 5;

function detectLineEnding(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? 'crlf' : 'lf';
}

/** Offset in the text without `\r` that corresponds to `offset` in the original. */
function withoutCarriageReturns(text, offset) {
  return offset - (text.slice(0, offset).match(/\r\n/g) ?? []).length;
}

/** Structural fixes that apply to this language under these rules. */
function enabledFixes(language, config) {
  const fixes = [];
  const braces = isRuleOn(config, 'PL-CF-003') && isRuleOn(config, language.name === 'java' ? 'PL-CF-003' : 'PL-JS-001');
  if (braces) { fixes.push(findBraceChanges); }
  const elseRule = language.name === 'go' ? 'PL-GO-002' : 'PL-CF-002';
  if (isRuleOn(config, elseRule)) { fixes.push(findElseChanges); }
  if (language.semicolons && config.semicolons && isRuleOn(config, 'PL-JS-002')) { fixes.push(findSemicolonChanges); }
  return fixes;
}

/** `[fromLine, toLine]` of a selection; a selection ending right after a line break excludes the next line. */
function selectedLines(text, range) {
  const starts = computeLineStarts(text);
  const from = lineOf(starts, range.from);
  const end = range.to > range.from && text[range.to - 1] === '\n' ? range.to - 1 : range.to;
  return { from, to: Math.max(from, lineOf(starts, end)) };
}

function offsetsOfLines(text, lines) {
  const starts = computeLineStarts(text);
  const last = Math.min(lines.to, starts.length - 1);
  const lineEnd = last + 1 < starts.length ? starts[last + 1] - 1 : text.length;
  return { from: starts[Math.min(lines.from, starts.length - 1)], to: lineEnd };
}

/**
 * One whitespace pass. `lines` (optional) restricts it to a line span; the
 * returned `lines` is that span in the new text.
 */
function whitespacePass(text, language, config, lines, structuralOk) {
  const options = {
    unit: indentUnit(config),
    indent: structuralOk && language.family !== 'crystal',
    trim: config.trimTrailingWhitespace,
    collapse: true,
  };
  const entries = language.family === 'crystal' ? reflowCrystal(text, options) : reflow(text, language, options);
  const original = text.split('\n');
  const out = [];
  let newFrom = null;
  let newTo = null;
  entries.forEach((entry, index) => {
    const inside = !lines || (index >= lines.from && index <= lines.to);
    const value = inside ? entry.text : original[index];
    if (index === lines?.from) { newFrom = out.length; }
    if (value !== null) { out.push(value); }
    if (index === lines?.to) { newTo = Math.max(out.length - 1, newFrom ?? 0); }
  });
  return { text: out.join('\n'), lines: lines ? { from: newFrom, to: newTo } : null };
}

function finishEnding(text, config) {
  if (!config.finalNewline) { return text; }
  const trimmed = text.replace(/\n+$/, '');
  if (trimmed.trim() === '') { return ''; }
  return `${trimmed}\n`;
}

function runPipeline(input, language, config, range, notes) {
  let text = input;
  let selection = range;
  const first = analyze(text, language);
  const jsx = language.jsx || looksLikeJsx(first);
  const structuralOk = language.family !== 'crystal' && first.balanced && !jsx;
  if (language.family !== 'crystal' && !first.balanced) { notes.add('Brackets do not balance — only whitespace was fixed.'); }
  if (jsx) { notes.add('JSX detected — only whitespace was fixed (structural Pureline fixes skip JSX files).'); }

  if (structuralOk && language.structural) {
    for (const find of enabledFixes(language, config)) {
      const src = analyze(text, language);
      if (!src.balanced) { break; }
      const result = runChanges(text, find(src), selection);
      text = result.text;
      selection = result.range;
    }
  }

  let lines = selection ? selectedLines(text, selection) : null;
  let pass = whitespacePass(text, language, config, lines, structuralOk);
  text = pass.text;
  lines = pass.lines;

  const collapse = structuralOk && language.structural && isRuleOn(config, 'PL-FMT-001');
  if (collapse) {
    const src = analyze(text, language);
    const tabWidth = config.indent.style === 'tab' ? 4 : config.indent.size;
    const changes = findCallChanges(src, config.printWidth, tabWidth);
    const offsets = lines ? offsetsOfLines(text, lines) : null;
    const result = runChanges(text, changes, offsets);
    text = result.text;
    if (result.count > 0) {
      lines = result.range ? selectedLines(text, result.range) : null;
      pass = whitespacePass(text, language, config, lines, structuralOk);
      text = pass.text;
      lines = pass.lines;
    }
  }
  return { text, lines };
}

/**
 * Formats `text`. `range` (`{ from, to }` offsets, optional) limits the
 * rewrite to the selection; code outside it stays byte-identical.
 */
export function formatPureline(text, languageId, config, options = {}) {
  const notes = new Set();
  const language = resolveLanguage({ languageId, path: options.path ?? null });
  if (!language) {
    return { text, notes: [`Pureline does not handle the language "${languageId}".`] };
  }
  const ending = detectLineEnding(text);
  let work = text.replace(/\r\n/g, '\n');
  const range = options.range ? {
    from: withoutCarriageReturns(text, options.range.from),
    to: withoutCarriageReturns(text, options.range.to),
  } : null;

  if (range) {
    const result = runPipeline(work, language, config, range, notes);
    const eol = ending === 'crlf' ? '\r\n' : '\n';
    return { text: result.text.replace(/\n/g, eol), notes: [...notes] };
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const next = runPipeline(work, language, config, null, round === 0 ? notes : new Set()).text;
    if (next === work) { break; }
    work = next;
  }
  work = finishEnding(work, config);
  const eolName = config.endOfLine === 'keep' ? ending : config.endOfLine;
  const eol = eolName === 'crlf' ? '\r\n' : '\n';
  return { text: eol === '\n' ? work : work.replace(/\n/g, eol), notes: [...notes] };
}
