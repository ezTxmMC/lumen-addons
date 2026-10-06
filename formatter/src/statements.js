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
 * What the fixes need to know about statements, found without a real parser:
 * where one ends, whether a block always leaves the function or loop, what
 * kind of block a `{` opens and which names a block declares.
 *
 * Everything here answers "unsure" with `-1`/`false` rather than guessing —
 * a fix that cannot be sure does nothing.
 */

import { T } from './tokenizer.js';
import { isPunct, isWord, namesBeforeAssignment } from './source.js';

/** A line ending in one of these words is not finished. */
const OPEN_ENDED_WORDS = new Set([
  'in', 'of', 'instanceof', 'typeof', 'new', 'await', 'void', 'delete', 'extends', 'as', 'satisfies', 'keyof', 'yield', 'is', 'async',
]);

const STATEMENT_ENDING_PUNCT = new Set([')', ']', '}', '++', '--']);

/** A line starting with one of these words continues the statement above it. */
const CONTINUING_WORDS = new Set(['in', 'of', 'instanceof', 'as', 'satisfies', 'extends', 'implements']);

const NON_TYPE_WORDS = new Set([
  'return', 'throw', 'new', 'else', 'case', 'default', 'break', 'continue', 'yield', 'assert', 'super', 'this', 'goto',
  'if', 'for', 'while', 'do', 'switch', 'try', 'catch', 'finally', 'import', 'package', 'export', 'await', 'delete', 'typeof',
]);

export const TERMINATORS = new Set(['return', 'throw', 'continue', 'break']);

/** Could a statement end after this token (JavaScript's automatic semicolon rules, roughly)? */
export function canEndStatement(token) {
  if (!token) { return false; }
  if (token.type === T.WORD) { return !OPEN_ENDED_WORDS.has(token.value); }
  if (token.type === T.PUNCT) { return STATEMENT_ENDING_PUNCT.has(token.value); }
  return true;
}

/** Would a token at the start of a line carry the previous line's statement on? */
export function startsContinuation(token) {
  if (!token) { return false; }
  if (token.type === T.TEMPLATE) { return true; }
  if (token.type === T.WORD) { return CONTINUING_WORDS.has(token.value); }
  if (token.type !== T.PUNCT) { return false; }
  const value = token.value;
  if (['.', '?.', '(', '[', ',', '?', ':', '=>', '+', '-', '*', '/', '%', '&', '|', '^', '<', '>', '&&', '||', '??', '**', '<<', '>>', '>>>', '++', '--', '{', '->', '::'].includes(value)) {
    return true;
  }
  return value.endsWith('=');
}

function isCloser(token) {
  return Boolean(token) && token.type === T.PUNCT && (token.value === ')' || token.value === ']' || token.value === '}');
}

function isOpener(token) {
  return Boolean(token) && token.type === T.PUNCT && (token.value === '(' || token.value === '[' || token.value === '{');
}

/**
 * The last token of the simple statement starting at sig index `start`, or -1.
 * JavaScript statements may end at a line break; Java's need their `;`.
 */
function simpleStatementEnd(src, start) {
  const { sig, match, language } = src;
  const automatic = language.family === 'js';
  let k = start;
  while (k < sig.length) {
    const token = sig[k];
    if (isOpener(token)) {
      if (match[k] === -1) { return -1; }
      k = match[k];
    }
    if (isPunct(sig[k], ';')) { return k; }
    const next = sig[k + 1];
    if (!next) { return automatic && canEndStatement(sig[k]) ? k : -1; }
    if (isCloser(next)) { return automatic && canEndStatement(sig[k]) ? k : -1; }
    if (automatic && next.nlBefore > 0 && canEndStatement(sig[k]) && !startsContinuation(next)) { return k; }
    k++;
  }
  return -1;
}

function afterHeader(src, index) {
  const open = isWord(src.sig[index + 1], 'await') ? index + 2 : index + 1;
  if (!isPunct(src.sig[open], '(') || src.match[open] === -1) { return -1; }
  return src.match[open] + 1;
}

function tryStatementEnd(src, start) {
  const { sig, match } = src;
  let k = start + 1;
  if (isPunct(sig[k], '(') && match[k] !== -1) { k = match[k] + 1; }
  if (!isPunct(sig[k], '{') || match[k] === -1) { return -1; }
  let end = match[k];
  for (;;) {
    const next = sig[end + 1];
    if (isWord(next, 'catch')) {
      const open = end + 2;
      const bodyAt = isPunct(sig[open], '(') && match[open] !== -1 ? match[open] + 1 : open;
      if (!isPunct(sig[bodyAt], '{') || match[bodyAt] === -1) { return -1; }
      end = match[bodyAt];
      continue;
    }
    if (isWord(next, 'finally')) {
      const body = end + 2;
      if (!isPunct(sig[body], '{') || match[body] === -1) { return -1; }
      end = match[body];
      continue;
    }
    return end;
  }
}

function doStatementEnd(src, start) {
  const bodyEnd = statementEnd(src, start + 1);
  if (bodyEnd === -1) { return -1; }
  const tail = bodyEnd + 1;
  if (!isWord(src.sig[tail], 'while') || !isPunct(src.sig[tail + 1], '(') || src.match[tail + 1] === -1) { return -1; }
  const close = src.match[tail + 1];
  return isPunct(src.sig[close + 1], ';') ? close + 1 : close;
}

function ifStatementEnd(src, start) {
  const body = afterHeader(src, start);
  if (body === -1) { return -1; }
  const bodyEnd = statementEnd(src, body);
  if (bodyEnd === -1) { return -1; }
  if (!isWord(src.sig[bodyEnd + 1], 'else')) { return bodyEnd; }
  return statementEnd(src, bodyEnd + 2);
}

/**
 * Sig index of the last token of the statement that starts at `start`, or -1
 * when its end is not certain. Handles blocks, `if`/`else`, loops, `do`,
 * `switch` and `try`; anything declaration-like is "unsure".
 */
export function statementEnd(src, start) {
  const token = src.sig[start];
  if (!token) { return -1; }
  if (isPunct(token, '{')) { return src.match[start]; }
  if (isPunct(token, ';')) { return -1; }
  if (token.type !== T.WORD) { return simpleStatementEnd(src, start); }
  if (isPunct(src.sig[start + 1], ':') && !['case', 'default'].includes(token.value)) { return statementEnd(src, start + 2); }
  switch (token.value) {
    case 'if': return ifStatementEnd(src, start);
    case 'for':
    case 'while': {
      const body = afterHeader(src, start);
      return body === -1 ? -1 : statementEnd(src, body);
    }
    case 'do': return doStatementEnd(src, start);
    case 'try': return tryStatementEnd(src, start);
    case 'switch': {
      const body = afterHeader(src, start);
      return body === -1 || !isPunct(src.sig[body], '{') ? -1 : src.match[body];
    }
    case 'else':
    case 'case':
    case 'default':
    case 'function':
    case 'class':
    case 'interface':
    case 'enum':
    case 'async':
      return -1;
    default:
      return simpleStatementEnd(src, start);
  }
}

/** Does the `}` at `closeIndex` end a block statement (not an object literal or a lambda)? */
function closesBlockStatement(src, closeIndex) {
  const open = src.match[closeIndex];
  if (open === -1) { return false; }
  const before = src.sig[open - 1];
  if (!before) { return true; }
  if (before.type === T.PUNCT) { return [';', '{', '}', ')'].includes(before.value); }
  return before.type === T.WORD && ['else', 'do', 'try', 'finally'].includes(before.value);
}

/** Sig indices where a statement begins directly inside the block `open`..`close`. */
function statementStarts(src, open, close) {
  const { sig, language } = src;
  const starts = [];
  let expectStart = true;
  let k = open + 1;
  while (k < close) {
    if (expectStart) {
      starts.push(k);
      expectStart = false;
    }
    let last = k;
    if (isOpener(sig[k])) { last = src.match[k]; }
    if (last === -1 || last >= close) { break; }
    const lastToken = sig[last];
    const next = sig[last + 1];
    const byNewline = language.family !== 'java' && next.nlBefore > 0 && canEndStatement(lastToken) && !startsContinuation(next);
    const byBlock = isPunct(lastToken, '}') && closesBlockStatement(src, last);
    expectStart = isPunct(lastToken, ';') || byBlock || byNewline;
    k = last + 1;
  }
  while (starts.length && isPunct(sig[starts[starts.length - 1]], ';')) { starts.pop(); }
  return starts;
}

/** Does the block `{` at `open` always end in return/throw/continue/break? */
export function blockTerminates(src, open) {
  const close = src.match[open];
  if (close === -1 || close === open + 1) { return false; }
  const starts = statementStarts(src, open, close);
  if (!starts.length) { return false; }
  const last = src.sig[starts[starts.length - 1]];
  return last.type === T.WORD && TERMINATORS.has(last.value);
}

/** A `{` after `case x:` or a label starts a block; one after `key:` starts an object. */
function braceKindAfterColon(src, open) {
  const { sig, match } = src;
  for (let k = open - 2, steps = 0; k >= 0 && steps < 40; k--, steps++) {
    const token = sig[k];
    if (isCloser(token) && match[k] !== -1 && !isPunct(token, '}')) {
      k = match[k];
      continue;
    }
    if (isWord(token, 'case') || isWord(token, 'default')) { return 'block'; }
    if (isPunct(token, ';') || isPunct(token, '{') || isPunct(token, '}')) { break; }
  }
  const label = sig[open - 2];
  const beforeLabel = sig[open - 3];
  if (!isWord(label)) { return 'unknown'; }
  if (!beforeLabel || isPunct(beforeLabel, ';') || isPunct(beforeLabel, '}')) { return 'block'; }
  if (isPunct(beforeLabel, '{')) { return braceKind(src, open - 3) === 'block' ? 'block' : 'unknown'; }
  return 'unknown';
}

/** What kind of body the `{` at `open` starts: `block`, `class`, `type`, `object` or `unknown`. */
export function braceKind(src, open) {
  const { sig, match } = src;
  const before = sig[open - 1];
  if (!before) { return 'block'; }
  if (before.type === T.PUNCT) {
    if ([';', '{', '}', ')', '=>', '->'].includes(before.value)) { return 'block'; }
    if (before.value === ':') { return braceKindAfterColon(src, open); }
    if (before.value !== '>') { return 'object'; }
  }
  if (before.type === T.WORD && ['else', 'do', 'try', 'finally', 'static'].includes(before.value)) { return 'block'; }
  if (before.type === T.WORD && before.value === 'return') { return 'object'; }
  if (before.type === T.WORD && ['export', 'import', 'as', 'from', 'default'].includes(before.value)) { return 'unknown'; }
  for (let k = open - 1, steps = 0; k >= 0 && steps < 300; k--, steps++) {
    const token = sig[k];
    if (isCloser(token) && match[k] !== -1 && !isPunct(token, '}')) {
      k = match[k];
      continue;
    }
    if (token.type === T.PUNCT && [';', '{', '}', '='].includes(token.value)) { return 'unknown'; }
    if (token.type === T.WORD) {
      if (token.value === 'class') { return 'class'; }
      if (token.value === 'interface' || token.value === 'enum' || token.value === 'struct') { return 'type'; }
      if (token.value === 'function' || token.value === 'namespace' || token.value === 'module') { return 'block'; }
      if (src.language.family === 'go' && ['func', 'if', 'for', 'switch', 'select'].includes(token.value)) { return 'block'; }
    }
    const startsStatement = token.nlBefore > 0 && canEndStatement(sig[k - 1]) && !startsContinuation(token);
    if (startsStatement) { return 'unknown'; }
  }
  return 'unknown';
}

/** Kind of the scope a token at sig index `index` lives directly in. */
export function scopeKind(src, index) {
  const parent = src.parent[index];
  if (parent === -1) { return 'block'; }
  if (!isPunct(src.sig[parent], '{')) { return 'expression'; }
  return braceKind(src, parent);
}

function skipGroup(src, k) {
  return isOpener(src.sig[k]) && src.match[k] !== -1 ? src.match[k] : k;
}

/** Names declared directly in the Java local-variable form `Type name =`, starting at sig index `k`. */
function javaDeclaration(src, k) {
  const { sig } = src;
  let i = k;
  while (isPunct(sig[i], '@') && isWord(sig[i + 1])) {
    i += 2;
    while (isPunct(sig[i], '.') && isWord(sig[i + 1])) { i += 2; }
    if (isPunct(sig[i], '(') && src.match[i] !== -1) { i = src.match[i] + 1; }
  }
  while (isWord(sig[i], 'final')) { i++; }
  if (!isWord(sig[i]) || NON_TYPE_WORDS.has(sig[i].value)) { return null; }
  i++;
  while (isPunct(sig[i], '.') && isWord(sig[i + 1])) { i += 2; }
  if (isPunct(sig[i], '<')) {
    let depth = 0;
    for (; i < sig.length; i++) {
      depth += sig[i].value === '<' ? 1 : 0;
      depth -= sig[i].value === '>' ? 1 : 0;
      depth -= sig[i].value === '>>' ? 2 : 0;
      if (depth <= 0) { break; }
    }
    i++;
  }
  while (isPunct(sig[i], '[') && isPunct(sig[i + 1], ']')) { i += 2; }
  if (!isWord(sig[i]) || NON_TYPE_WORDS.has(sig[i].value)) { return null; }
  const after = sig[i + 1];
  if (!after || after.type !== T.PUNCT || !['=', ';', ',', ':'].includes(after.value)) { return null; }
  return sig[i].value;
}

/**
 * The names declared directly inside the block `open`..`close` (not in nested
 * blocks). `unsure` is true for destructuring and other forms the scan does
 * not understand — the caller should then leave the code alone.
 */
export function declaredNames(src, open, close) {
  const { sig, language } = src;
  const names = new Set();
  let unsure = false;
  let k = open + 1;
  while (k < close) {
    const token = sig[k];
    const declarator = token.type === T.WORD && ['const', 'let', 'var', 'function', 'class', 'interface', 'enum', 'type', 'namespace'].includes(token.value);
    if (declarator && language.family === 'js') {
      let nameAt = k + 1;
      if (isPunct(sig[nameAt], '*')) { nameAt++; }
      if (isWord(sig[nameAt])) { names.add(sig[nameAt].value); }
      if (!isWord(sig[nameAt]) && token.value !== 'type') { unsure = true; }
    }
    if (language.family === 'go' && token.type === T.WORD && ['var', 'const', 'type'].includes(token.value)) {
      if (isWord(sig[k + 1])) { names.add(sig[k + 1].value); }
      if (!isWord(sig[k + 1])) { unsure = true; }
    }
    if (language.family === 'go' && isPunct(token, ':=')) {
      for (const name of namesBeforeAssignment(sig, k, open + 1)) { names.add(name.value); }
    }
    k = skipGroup(src, k) + 1;
  }
  if (language.family === 'java') {
    for (const start of statementStarts(src, open, close)) {
      const name = javaDeclaration(src, start);
      if (name) { names.add(name); }
      if (isWord(sig[start]) && ['class', 'interface', 'enum', 'record'].includes(sig[start].value) && isWord(sig[start + 1])) {
        names.add(sig[start + 1].value);
      }
    }
  }
  return { names, unsure };
}

/** How often `name` is declared anywhere in the file (rough, over-counting is fine). */
export function countDeclarations(src, name) {
  const { sig, language } = src;
  let count = 0;
  for (let k = 0; k < sig.length; k++) {
    if (!isWord(sig[k], name) || isPunct(sig[k - 1], '.')) { continue; }
    const before = sig[k - 1];
    const after = sig[k + 1];
    if (language.family === 'js' && before?.type === T.WORD && ['const', 'let', 'var', 'function', 'class', 'interface', 'enum', 'type', 'namespace'].includes(before.value)) { count++; }
    if (language.family === 'go' && (isPunct(after, ':=') || (before?.type === T.WORD && ['var', 'const', 'type'].includes(before.value)))) { count++; }
    if (language.family === 'go' && isPunct(after, ',') && isPunct(sig[k + 2], ':=')) { count++; }
    const typeBefore = before && ((before.type === T.WORD && !NON_TYPE_WORDS.has(before.value)) || isPunct(before, '>') || isPunct(before, ']'));
    const declarationAfter = after && after.type === T.PUNCT && ['=', ';', ',', ':', ')'].includes(after.value);
    if (language.family === 'java' && typeBefore && declarationAfter) { count++; }
  }
  return count;
}

/** Is `name` used as an identifier in sig[from..to] outside the range [skipFrom, skipTo]? */
export function usedOutside(src, name, from, to, skipFrom, skipTo) {
  for (let k = from; k <= to; k++) {
    if (k >= skipFrom && k <= skipTo) { continue; }
    if (isWord(src.sig[k], name) && !isPunct(src.sig[k - 1], '.')) { return true; }
  }
  return false;
}
