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
 * PL-CF-002 / PL-GO-002: no `else` after a branch that always leaves.
 *
 *   if (a) { return x; } else { body }   ->   if (a) { return x; }  + blank line + body
 *
 * Only removed when that cannot change what the program does: the branch
 * before it must end in return/throw/continue/break, the `if` must stand as a
 * statement of its own, a Go `if` must not carry an init statement, and the
 * names the moved body declares must not be visible anywhere they were not
 * before. All other cases are left to the checker.
 */

import { isPunct, isWord } from '../source.js';
import { blockTerminates, countDeclarations, declaredNames, scopeKind, usedOutside } from '../statements.js';

/**
 * The `{ }` block of the `if` at sig index `ifIndex`: `{ open, close, hasInit }`
 * or null. For Go the header has no parentheses; `hasInit` marks `if x := f(); ...`.
 */
export function ifHeaderBlock(src, ifIndex) {
  const { sig, match, language } = src;
  if (language.family !== 'go') {
    const open = ifIndex + 1;
    if (!isPunct(sig[open], '(') || match[open] === -1) { return null; }
    const block = match[open] + 1;
    if (!isPunct(sig[block], '{') || match[block] === -1) { return null; }
    return { open: block, close: match[block], hasInit: false };
  }
  let hasInit = false;
  for (let k = ifIndex + 1; k < sig.length; k++) {
    if (isPunct(sig[k], '{')) { return match[k] === -1 ? null : { open: k, close: match[k], hasInit }; }
    if (isPunct(sig[k], ':=')) { hasInit = true; }
    if (isPunct(sig[k], '}')) { return null; }
    if (isPunct(sig[k], '(') || isPunct(sig[k], '[')) {
      if (match[k] === -1) { return null; }
      k = match[k];
    }
  }
  return null;
}

/** Every `else` that follows a block: `{ elseIndex, terminated, elseIf }` — for the checker. */
export function scanElses(src) {
  const { sig, match, language } = src;
  const found = [];
  if (!language.structural) { return found; }
  for (let i = 1; i < sig.length; i++) {
    if (!isWord(sig[i], 'else') || !isPunct(sig[i - 1], '}') || match[i - 1] === -1) { continue; }
    found.push({
      elseIndex: i,
      terminated: blockTerminates(src, match[i - 1]),
      elseIf: isWord(sig[i + 1], 'if'),
    });
  }
  return found;
}

function atStatementPosition(src, index) {
  const before = src.sig[index - 1];
  if (!before) { return true; }
  return before.type === 'punct' && [';', '{', '}'].includes(before.value);
}

function firstContentOffset(text, from, limit) {
  let i = from;
  while (i < limit && ' \t\n'.includes(text[i])) { i++; }
  return i;
}

function lastContentEnd(text, from, limit) {
  let i = limit;
  while (i > from && ' \t\n'.includes(text[i - 1])) { i--; }
  return i;
}

/** Is it safe to lift the names declared in an else body into the surrounding block? */
function bodyKeepsItsScope(src, ifIndex, open, close) {
  const { names, unsure } = declaredNames(src, open, close);
  if (unsure) { return false; }
  const enclosing = src.parent[ifIndex];
  const from = enclosing === -1 ? 0 : enclosing;
  const to = enclosing === -1 ? src.sig.length - 1 : src.match[enclosing];
  for (const name of names) {
    if (usedOutside(src, name, from, to, open, close)) { return false; }
    if (countDeclarations(src, name) > 1) { return false; }
  }
  return true;
}

function lastElseBlockChange(src, ifIndex, branch, elseOpen) {
  const { sig, text, match } = src;
  const elseClose = match[elseOpen];
  if (elseClose === -1 || sig[elseOpen].commentBefore) { return null; }
  const following = sig[elseClose + 1];
  if (following && following.nlBefore === 0 && !following.commentBefore) { return null; }
  if (!bodyKeepsItsScope(src, ifIndex, elseOpen, elseClose)) { return null; }

  const branchClose = sig[branch.close];
  const bodyStart = firstContentOffset(text, sig[elseOpen].end, sig[elseClose].start);
  const extent = { start: branchClose.start, end: sig[elseClose].end };
  if (bodyStart >= sig[elseClose].start) {
    return { ...extent, edits: [{ start: branchClose.end, end: sig[elseClose].end, text: '' }] };
  }
  const bodyEnd = lastContentEnd(text, bodyStart, sig[elseClose].start);
  return {
    ...extent,
    edits: [
      { start: branchClose.end, end: bodyStart, text: '\n\n' },
      { start: bodyEnd, end: sig[elseClose].end, text: '' },
    ],
  };
}

function chainChanges(src, head, ruleId) {
  const { sig } = src;
  const changes = [];
  let current = head;
  for (;;) {
    const branch = ifHeaderBlock(src, current);
    if (!branch || branch.hasInit) { return changes; }
    const elseIndex = branch.close + 1;
    if (!isWord(sig[elseIndex], 'else') || sig[elseIndex].commentBefore) { return changes; }
    if (!blockTerminates(src, branch.open)) { return changes; }
    const after = elseIndex + 1;
    if (isWord(sig[after], 'if') && !sig[after].commentBefore) {
      changes.push({
        rule: ruleId,
        start: sig[branch.close].start,
        end: sig[after].end,
        edits: [{ start: sig[branch.close].end, end: sig[after].start, text: '\n\n' }],
      });
      current = after;
      continue;
    }
    if (!isPunct(sig[after], '{')) { return changes; }
    const change = lastElseBlockChange(src, current, branch, after);
    if (change) { changes.push({ rule: ruleId, ...change }); }
    return changes;
  }
}

/** The changes that remove `else` after terminating branches. */
export function findElseChanges(src) {
  const { sig, language } = src;
  if (!language.structural) { return []; }
  const ruleId = language.name === 'go' ? 'PL-GO-002' : 'PL-CF-002';
  const changes = [];
  for (let i = 0; i < sig.length; i++) {
    if (!isWord(sig[i], 'if') || isWord(sig[i - 1], 'else') || !atStatementPosition(src, i)) { continue; }
    if (scopeKind(src, i) !== 'block') { continue; }
    changes.push(...chainChanges(src, i, ruleId));
  }
  return changes;
}
