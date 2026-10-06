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
 * PL-JS-002: semicolons in JavaScript and TypeScript.
 *
 * A semicolon is added only where the statement end is certain: brackets
 * balance, the next line cannot continue the expression and the line does not
 * end in an operator. Declarations that end in `}` (functions, classes,
 * `if`, `for` ...) never get one, class and interface bodies are left alone.
 */

import { isPunct, isWord } from '../source.js';
import { canEndStatement, scopeKind, startsContinuation } from '../statements.js';
import { T } from '../tokenizer.js';

/** Words that start something other than an expression statement. */
const NOT_EXPRESSIONS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'try', 'catch', 'finally', 'function', 'class', 'interface', 'enum',
  'namespace', 'module', 'declare', 'abstract', 'async', 'case', 'default', 'with', 'import', 'export', 'const', 'let',
  'var', 'return', 'throw', 'break', 'continue', 'type', 'static', 'public', 'private', 'protected', 'readonly',
  'get', 'set', 'from', 'of', 'in', 'as', 'extends', 'implements',
]);

const DECLARATION_WORDS = new Set(['function', 'class', 'abstract', 'interface', 'enum']);

function isCloser(token) {
  return Boolean(token) && token.type === T.PUNCT && [')', ']', '}'].includes(token.value);
}

function isOpener(token) {
  return Boolean(token) && token.type === T.PUNCT && ['(', '[', '{'].includes(token.value);
}

/** Is the `:` before sig index `index` the colon of a `case` or `default` label? */
function followsCaseLabel(src, index) {
  const { sig, match } = src;
  if (!isPunct(sig[index - 1], ':')) { return false; }
  for (let k = index - 2, steps = 0; k >= 0 && steps < 60; k--, steps++) {
    const token = sig[k];
    if (isCloser(token) && match[k] !== -1) {
      k = match[k];
      continue;
    }
    if (isWord(token, 'case') || isWord(token, 'default')) { return true; }
    if (isPunct(token, ';') || isPunct(token, '{') || isPunct(token, '}')) { return false; }
  }
  return false;
}

function lineBreakStart(src, index) {
  const { sig } = src;
  const token = sig[index];
  const before = sig[index - 1];
  return token.nlBefore > 0 && canEndStatement(before) && !startsContinuation(token);
}

/** Does a statement of this kind begin at sig index `index`? */
function isStatementStart(src, index, keyword) {
  const { sig } = src;
  const before = sig[index - 1];
  if (!before) { return true; }
  if (before.type === T.PUNCT) {
    if ([';', '{'].includes(before.value)) { return true; }
    if (before.value === '}') { return keyword || lineBreakStart(src, index); }
    if (before.value === ')') { return keyword || lineBreakStart(src, index); }
    if (before.value === ':') { return keyword || followsCaseLabel(src, index); }
    return lineBreakStart(src, index);
  }
  if (before.type === T.WORD && (before.value === 'else' || before.value === 'do')) { return true; }
  return lineBreakStart(src, index);
}

function exportStatement(src, index) {
  const { sig } = src;
  const next = sig[index + 1];
  if (!next) { return false; }
  if (isPunct(next, '{') || isPunct(next, '*') || isPunct(next, '=')) { return true; }
  if (next.type !== T.WORD) { return false; }
  if (['const', 'let', 'var', 'import'].includes(next.value)) { return next.value !== 'const' || !isWord(sig[index + 2], 'enum'); }
  if (next.value === 'default') {
    const after = sig[index + 2];
    if (!after) { return false; }
    if (after.type === T.WORD && DECLARATION_WORDS.has(after.value)) { return false; }
    return !(isWord(after, 'async') && isWord(sig[index + 3], 'function'));
  }
  if (next.value === 'type') {
    const after = sig[index + 2];
    if (isPunct(after, '{') || isPunct(after, '*')) { return true; }
    return isWord(after) && (isPunct(sig[index + 3], '=') || isPunct(sig[index + 3], '<'));
  }
  return false;
}

/** `'keyword'`, `'expression'` or null: what kind of statement starts here, if one that needs a semicolon. */
function statementKind(src, index) {
  const { sig } = src;
  const token = sig[index];
  if (token.type !== T.WORD || isPunct(sig[index - 1], '.') || isPunct(sig[index - 1], '?.')) { return null; }
  const next = sig[index + 1];
  const value = token.value;
  const parent = src.parent[index];
  if (parent !== -1 && !isPunct(sig[parent], '{')) { return null; }

  if (['const', 'let', 'var'].includes(value)) {
    const declares = next && (next.type === T.WORD || isPunct(next, '{') || isPunct(next, '['));
    if (!declares || (value !== 'var' && isWord(next) && ['in', 'of', 'instanceof', 'enum'].includes(next.value))) { return null; }
    return isStatementStart(src, index, true) ? 'keyword' : null;
  }
  if (['return', 'throw', 'break', 'continue'].includes(value)) {
    if (isPunct(next, ':') || isPunct(next, '=')) { return null; }
    return isStatementStart(src, index, true) ? 'keyword' : null;
  }
  if (value === 'import') {
    if (isPunct(next, '(') || isPunct(next, '.')) { return null; }
    return isStatementStart(src, index, true) ? 'keyword' : null;
  }
  if (value === 'export') { return exportStatement(src, index) && isStatementStart(src, index, true) ? 'keyword' : null; }
  if (value === 'type') {
    const alias = isWord(next) && (isPunct(sig[index + 2], '=') || isPunct(sig[index + 2], '<'));
    return alias && isStatementStart(src, index, true) ? 'keyword' : null;
  }
  if (NOT_EXPRESSIONS.has(value) || isPunct(next, ':') || isPunct(next, '=>')) { return null; }
  if (scopeKind(src, index) !== 'block') { return null; }
  return isStatementStart(src, index, false) ? 'expression' : null;
}

/** Sig index of the token after which the `;` belongs, or -1 (has one, or unsure). */
function missingSemicolonAt(src, start) {
  const { sig, match } = src;
  let k = start;
  while (k < sig.length) {
    if (isOpener(sig[k])) {
      if (match[k] === -1) { return -1; }
      k = match[k];
    }
    const token = sig[k];
    const next = sig[k + 1];
    if (isPunct(next, ';')) { return -1; }
    if (!next || isCloser(next)) { return canEndStatement(token) ? k : -1; }
    if (next.nlBefore > 0 && canEndStatement(token) && !startsContinuation(next)) { return k; }
    k++;
  }
  return -1;
}

/** One change per statement missing its semicolon. */
export function findSemicolonChanges(src) {
  if (!src.language.semicolons) { return []; }
  const changes = [];
  const done = new Set();
  for (let i = 0; i < src.sig.length; i++) {
    if (!statementKind(src, i)) { continue; }
    const end = missingSemicolonAt(src, i);
    if (end === -1 || done.has(end)) { continue; }
    done.add(end);
    const last = src.sig[end];
    changes.push({
      rule: 'PL-JS-002',
      start: src.sig[i].start,
      end: last.end,
      edits: [{ start: last.end, end: last.end, text: ';' }],
    });
  }
  return changes;
}
