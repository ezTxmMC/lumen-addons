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
 * Crystal is not a brace language, so Pureline does not rewrite its
 * structure: indentation belongs to `crystal tool format`, this file only
 * keeps blanks tidy (without touching heredocs or multi-line strings) and
 * finds `else` for the checker.
 */

const HEREDOC = /<<-(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/g;
const PERCENT_CLOSERS = { '(': ')', '[': ']', '{': '}', '<': '>', '|': '|' };

function skipInterpolation(text, start) {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    if (text[i] === '{') { depth++; }
    if (text[i] === '}') { depth--; }
    if (text[i] === '"') { i = skipString(text, i); continue; }
    i++;
  }
  return i;
}

function skipString(text, start) {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === '#' && text[i + 1] === '{') {
      i = skipInterpolation(text, i + 2);
      continue;
    }
    if (text[i] === '"') { return i + 1; }
    i++;
  }
  return text.length;
}

function skipPercentLiteral(text, start) {
  const opener = text[start + 1] && 'qQwWiIr'.includes(text[start + 1]) ? text[start + 2] : text[start + 1];
  const closer = PERCENT_CLOSERS[opener];
  if (!closer) { return -1; }
  const bodyStart = start + (text[start + 1] && 'qQwWiIr'.includes(text[start + 1]) ? 3 : 2);
  let depth = 1;
  for (let i = bodyStart; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (opener !== closer && text[i] === opener) { depth++; }
    if (text[i] === closer) { depth--; }
    if (depth === 0) { return i + 1; }
  }
  return text.length;
}

/**
 * Marks the body lines of the heredocs started on the line before `from` —
 * up to and including each terminator — and returns the first line after them.
 */
function markHeredocBodies(lines, from, ids, startsInside, endsInside) {
  let next = from;
  for (const id of ids) {
    const bodyStart = next;
    while (next < lines.length && lines[next].trim() !== id) { next++; }
    const bodyEnd = Math.min(next, lines.length - 1);
    for (let k = bodyStart; k <= bodyEnd; k++) {
      startsInside.add(k);
      if (k < bodyEnd) { endsInside.add(k); }
    }
    next = bodyEnd + 1;
  }
  return next;
}

/**
 * Which lines start or end inside a literal spanning lines (heredoc bodies,
 * multi-line strings, `%w()` literals) and which lines are comments.
 */
export function crystalLiteralLines(text) {
  const lineStarts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) { lineStarts.push(i + 1); }
  const lineOf = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= offset) { low = mid; continue; }
      high = mid - 1;
    }
    return low;
  };
  const startsInside = new Set();
  const endsInside = new Set();
  const mark = (from, to) => {
    const first = lineOf(from);
    const last = lineOf(Math.max(from, to - 1));
    for (let line = first + 1; line <= last; line++) { startsInside.add(line); }
    for (let line = first; line < last; line++) { endsInside.add(line); }
  };
  const lines = text.split('\n');
  const pendingHeredocs = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') {
      const line = lineOf(i);
      if (pendingHeredocs.length) {
        const next = markHeredocBodies(lines, line + 1, pendingHeredocs.splice(0), startsInside, endsInside);
        i = next < lines.length ? lineStarts[next] : text.length;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '#') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (ch === '"') {
      const end = skipString(text, i);
      mark(i, end);
      i = end;
      continue;
    }
    if (ch === '<' && text[i + 1] === '<') {
      HEREDOC.lastIndex = i;
      const match = HEREDOC.exec(text);
      if (match && match.index === i) {
        pendingHeredocs.push(match[2]);
        i += match[0].length;
        continue;
      }
    }
    if (ch === '%' && /[\s(,=[]/.test(text[i - 1] ?? ' ')) {
      const end = skipPercentLiteral(text, i);
      if (end !== -1) {
        mark(i, end);
        i = end;
        continue;
      }
    }
    i++;
  }
  return { startsInside, endsInside };
}

/**
 * Trailing blanks and runs of blank lines, nothing more — see `reflow` in
 * `indent.js` for the meaning of the entries.
 */
export function reflowCrystal(text, options) {
  const { startsInside, endsInside } = crystalLiteralLines(text);
  const entries = [];
  let blankRun = 0;
  text.split('\n').forEach((raw, line) => {
    if (startsInside.has(line)) {
      blankRun = 0;
      entries.push({ text: options.trim && !endsInside.has(line) ? raw.trimEnd() : raw });
      return;
    }
    if (raw.trim() === '') {
      blankRun++;
      entries.push({ text: options.collapse && blankRun > 1 ? null : '' });
      return;
    }
    blankRun = 0;
    entries.push({ text: options.trim && !endsInside.has(line) ? raw.trimEnd() : raw });
  });
  return entries;
}

const OPENERS = /^(?:(?:private|protected|abstract)\s+)*(?:class|module|struct|enum|lib|annotation|macro|while|until|begin|union)\b/;
const BLOCK_DO = /\bdo(?:\s*\|[^|]*\|)?\s*$/;
const DEFINITION = /^(?:(?:private|protected)\s+)?def\s+([A-Za-z_][\w?!=]*(?:\.[\w?!=]+)?)/;
const TYPE_DEFINITION = /^(?:(?:private|protected|abstract)\s+)*(class|module|struct)\s+([A-Z][\w:]*)/;

/**
 * Walks a Crystal file's `end`-delimited blocks. Returns the `else`/`elsif`
 * that belong to an `if`/`unless` (not to `case`) and every `def`, `class`,
 * `module` and `struct` with its line range — all the checker needs.
 */
export function scanCrystal(text) {
  const { startsInside } = crystalLiteralLines(text);
  const elses = [];
  const blocks = [];
  const stack = [];
  text.split('\n').forEach((raw, line) => {
    if (startsInside.has(line)) { return; }
    const code = raw.replace(/#.*$/, '');
    const trimmed = code.trim();
    if (!trimmed) { return; }
    const column = raw.indexOf(trimmed);
    if (/^(?:if|unless)\b/.test(trimmed) && !/\bend\s*$/.test(trimmed)) { stack.push({ kind: 'if' }); }
    if (/^case\b/.test(trimmed)) { stack.push({ kind: 'case' }); }
    const type = TYPE_DEFINITION.exec(trimmed);
    if (type && !/\bend\s*$/.test(trimmed)) { stack.push({ kind: type[1], name: type[2], line, column: raw.indexOf(type[2]) }); }
    if (!type && OPENERS.test(trimmed)) { stack.push({ kind: 'other' }); }
    const definition = DEFINITION.exec(trimmed);
    const endless = /^[^(]*(?:\([^)]*\))?\s*=\s/.test(trimmed.replace(/^(?:(?:private|protected)\s+)?def\s+/, ''));
    if (definition && !endless) { stack.push({ kind: 'def', name: definition[1], line, column: raw.indexOf(definition[1]) }); }
    if (!definition && BLOCK_DO.test(trimmed) && !/^(?:if|unless|case|while|until)\b/.test(trimmed)) { stack.push({ kind: 'other' }); }
    if (/^(?:else|elsif)\b/.test(trimmed) && stack[stack.length - 1]?.kind === 'if') {
      elses.push({ line, column, length: trimmed.startsWith('elsif') ? 5 : 4 });
    }
    if (/^end\b/.test(trimmed)) {
      const closed = stack.pop();
      if (closed?.name) { blocks.push({ ...closed, endLine: line, lines: line - closed.line + 1 }); }
    }
  });
  return { elses, blocks };
}

/** Positions of `else`/`elsif` that belong to an `if`/`unless`, for PL-CR-002. */
export function crystalElses(text) {
  return scanCrystal(text).elses;
}
