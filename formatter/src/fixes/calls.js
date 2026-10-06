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
 * PL-FMT-001: a call whose arguments were stretched over lines for no reason
 * goes back onto one line when it fits `printWidth`.
 *
 * Only plain calls qualify: no comments, no argument that itself spans lines
 * (object literals, block lambdas, templates), and not a builder chain —
 * the spec keeps those vertical. Declarations are left alone.
 */

import { isPunct } from '../source.js';
import { T } from '../tokenizer.js';

/** A word before `(` that makes it something other than a call. */
const NOT_CALLEES = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'synchronized', 'with', 'await', 'yield',
  'case', 'in', 'of', 'else', 'do', 'throw', 'func', 'try', 'assert', 'instanceof', 'void', 'delete', 'import', 'export',
  'var', 'const', 'type', 'select', 'go', 'defer', 'range', 'package',
]);

const DECLARATION_LINE_STARTS = new Set(['func', 'function', 'fn']);

/** Is every newline between the brackets one that separates top-level arguments? */
function argumentsAreFlat(src, open, close) {
  const { sig, match } = src;
  let depth = 0;
  for (let k = open + 1; k < close; k++) {
    const token = sig[k];
    const closer = token.type === T.PUNCT && [')', ']', '}'].includes(token.value);
    if (token.commentBefore) { return false; }
    if (token.nlBefore > 0 && (depth > 0)) { return false; }
    if (token.type === T.TEMPLATE || token.type === T.STRING) {
      if (token.value.includes('\n')) { return false; }
    }
    if (token.type === T.PUNCT && ['(', '[', '{'].includes(token.value)) {
      if (match[k] === -1) { return false; }
      depth++;
    }
    if (closer) { depth--; }
  }
  return depth === 0 && !sig[close].commentBefore;
}

function firstTokenOnLine(src, index) {
  let k = index;
  while (k > 0 && src.sig[k].nlBefore === 0) { k--; }
  return src.sig[k];
}

function lineBounds(text, offset) {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  const lineEnd = text.indexOf('\n', offset);
  return { start, end: lineEnd === -1 ? text.length : lineEnd };
}

function indentWidth(line, tabWidth) {
  const lead = /^[ \t]*/.exec(line)[0];
  return [...lead].reduce((sum, ch) => sum + (ch === '\t' ? tabWidth : 1), 0);
}

/** What separates sig token `k` from the one before: nothing after `(`, one space across a line break, otherwise the original blanks. */
function gapBefore(src, open, k) {
  const { sig, text } = src;
  if (k === open + 1) { return ''; }
  if (sig[k].nlBefore > 0) { return ' '; }
  return text.slice(sig[k - 1].end, sig[k].start);
}

function joinedArguments(src, open, close) {
  const { sig } = src;
  let last = close - 1;
  if (isPunct(sig[last], ',') && last > open) { last--; }
  let out = '';
  for (let k = open + 1; k <= last; k++) { out += gapBefore(src, open, k) + sig[k].value; }
  return out;
}

function isCandidate(src, open) {
  const { sig, match } = src;
  const close = match[open];
  const callee = sig[open - 1];
  if (close === -1 || !callee || callee.type !== T.WORD || NOT_CALLEES.has(callee.value)) { return false; }
  const first = sig[open + 1];
  if (close === open + 1) { return sig[close].nlBefore > 0 && !sig[close].commentBefore; }
  if (!first || first.nlBefore === 0 || first.commentBefore) { return false; }
  if (sig[close].nlBefore === 0) { return false; }
  const after = sig[close + 1];
  if (after && (isPunct(after, '{') || isPunct(after, '=>') || isPunct(after, ':') || (after.type === T.WORD && after.value === 'throws'))) {
    return false;
  }
  const lineStart = firstTokenOnLine(src, open);
  if (isPunct(lineStart, '.') || isPunct(lineStart, '?.')) { return false; }
  if (lineStart.type === T.WORD && DECLARATION_LINE_STARTS.has(lineStart.value)) { return false; }
  return argumentsAreFlat(src, open, close);
}

/** One change per needlessly expanded call that fits on one line. */
export function findCallChanges(src, printWidth, tabWidth) {
  if (!src.language.structural) { return []; }
  const { sig, text } = src;
  const changes = [];
  for (let open = 0; open < sig.length; open++) {
    if (!isPunct(sig[open], '(') || !isCandidate(src, open)) { continue; }
    const close = src.match[open];
    const args = joinedArguments(src, open, close);
    const head = lineBounds(text, sig[open].start);
    const tail = lineBounds(text, sig[close].start);
    const prefix = text.slice(head.start, sig[open].end);
    const suffix = text.slice(sig[close].end, tail.end).trimEnd();
    const width = indentWidth(prefix, tabWidth) + prefix.trimStart().length + args.length + 1 + suffix.length;
    if (width > printWidth) { continue; }
    changes.push({
      rule: 'PL-FMT-001',
      openIndex: open,
      start: sig[open].start,
      end: sig[close].end,
      edits: [{ start: sig[open].end, end: sig[close].end, text: `${args})` }],
    });
  }
  return changes;
}
