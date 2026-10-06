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
 * The analysed source every fix and every check works on: tokens, the
 * "significant" tokens (no blanks, no comments), bracket pairs and line
 * offsets. Building it once per stage keeps the fixes small.
 */

import { T, tokenize } from './tokenizer.js';

const OPENERS = '([{';
const CLOSERS = ')]}';

export function computeLineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    starts.push(i + 1);
  }
  return starts;
}

/** Zero-based line of an offset. */
export function lineOf(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      low = mid;
      continue;
    }
    high = mid - 1;
  }
  return low;
}

export function positionOf(lineStarts, offset) {
  const line = lineOf(lineStarts, offset);
  return { line, column: offset - lineStarts[line] };
}

export function isPunct(token, value) {
  return Boolean(token) && token.type === T.PUNCT && token.value === value;
}

export function isWord(token, value) {
  if (!token || token.type !== T.WORD) { return false; }
  return value === undefined || token.value === value;
}

/** A literal or comment that runs into the end of the file (or line, for a string) without closing. */
function isUnterminated(token) {
  if (token.type === T.COMMENT) { return token.block && !token.value.endsWith('*/'); }
  if (token.type === T.STRING) { return token.value.length < 2 || token.value[token.value.length - 1] !== token.value[0]; }
  if (token.type !== T.TEMPLATE) { return false; }
  if (token.kind === 'textblock') { return !token.value.endsWith('"""') || token.value.length < 6; }
  return token.value.length < 2 || !token.value.endsWith(token.value[0]);
}

/**
 * Tokenizes `text` (line breaks already `\n`) and derives the structure.
 * `balanced` is false when brackets do not pair up — the structural fixes
 * refuse to touch such a file.
 */
export function analyze(text, language) {
  const tokens = tokenize(text, language.family);
  const sig = [];
  let newlines = 0;
  let commentSeen = false;
  for (const token of tokens) {
    if (token.type === T.NEWLINE) {
      newlines++;
      continue;
    }
    if (token.type === T.WS) { continue; }
    if (token.type === T.COMMENT) {
      commentSeen = true;
      newlines += token.value.split('\n').length - 1;
      continue;
    }
    token.si = sig.length;
    token.nlBefore = newlines;
    token.commentBefore = commentSeen;
    newlines = 0;
    commentSeen = false;
    sig.push(token);
  }

  const match = new Array(sig.length).fill(-1);
  const parent = new Array(sig.length).fill(-1);
  const stack = [];
  let balanced = true;
  sig.forEach((token, index) => {
    parent[index] = stack.length ? stack[stack.length - 1] : -1;
    if (token.type !== T.PUNCT) { return; }
    if (OPENERS.includes(token.value) && token.value.length === 1) {
      stack.push(index);
      return;
    }
    if (!CLOSERS.includes(token.value) || token.value.length !== 1) { return; }
    const open = stack.pop();
    if (open === undefined || OPENERS.indexOf(sig[open].value) !== CLOSERS.indexOf(token.value)) {
      balanced = false;
      return;
    }
    match[open] = index;
    match[index] = open;
    parent[index] = parent[open];
  });
  if (stack.length || tokens.some(isUnterminated)) { balanced = false; }

  return { text, language, tokens, sig, match, parent, balanced, lineStarts: computeLineStarts(text) };
}

/** True when sig token `index` is the opening bracket `value`. */
export function opens(src, index, value) {
  return isPunct(src.sig[index], value) && src.match[index] !== -1;
}

/**
 * Lines whose beginning (or end) lies inside a literal that spans lines.
 * Their leading blanks (or trailing blanks) are content and must not change.
 */
export function protectedLines(src) {
  const startsInside = new Set();
  const endsInside = new Set();
  for (const token of src.tokens) {
    if (token.type !== T.STRING && token.type !== T.TEMPLATE) { continue; }
    const span = token.value.split('\n').length - 1;
    for (let k = 1; k <= span; k++) {
      startsInside.add(token.line + k);
      endsInside.add(token.line + k - 1);
    }
  }
  return { startsInside, endsInside };
}

/** Comments that span lines: start line -> token, to re-indent them as a block. */
export function blockCommentsByLine(src) {
  const map = new Map();
  for (const token of src.tokens) {
    if (token.type === T.COMMENT && token.block && token.value.includes('\n')) {
      map.set(token.line, token);
    }
  }
  return map;
}

/**
 * The identifiers on the left of the `:=` or `=` at sig index `assign`
 * (`a, b := ...`), nearest first; `floor` is the first index that may be one.
 */
export function namesBeforeAssignment(sig, assign, floor = 0) {
  const names = [];
  let i = assign - 1;
  while (i >= floor && sig[i].type === T.WORD) {
    names.push(sig[i]);
    if (!isPunct(sig[i - 1], ',')) { break; }
    i -= 2;
  }
  return names;
}
