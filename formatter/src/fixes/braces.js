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
 * PL-CF-003 (Java) / PL-JS-001 (JavaScript, TypeScript): control-flow bodies
 * get explicit blocks.
 *
 * `scanControlBodies` finds every `if`/`else`/`for`/`while`/`do` and says
 * whether its body is a block; the fix wraps the braceless ones whose end is
 * certain, the checker reports all of them.
 */

import { isPunct, isWord } from '../source.js';
import { scopeKind, statementEnd } from '../statements.js';
import { T } from '../tokenizer.js';

const HEADER_KEYWORDS = new Set(['if', 'for', 'while']);

/**
 * Every control statement body in the file:
 * `{ keyword, keywordIndex, headerEnd, bodyIndex, braced, endIndex }`
 * (`endIndex` -1 = the end of a braceless body is not certain).
 */
export function scanControlBodies(src) {
  const { sig, match, language } = src;
  const found = [];
  if (language.family === 'go' || !language.structural) { return found; }
  const doTails = new Set();

  for (let i = 0; i < sig.length; i++) {
    const token = sig[i];
    if (token.type !== T.WORD || isPunct(sig[i - 1], '.') || isPunct(sig[i - 1], '?.')) { continue; }
    const keyword = token.value;
    if (isPunct(sig[i + 1], ':') || scopeKind(src, i) !== 'block') { continue; }

    let headerEnd = -1;
    if (HEADER_KEYWORDS.has(keyword)) {
      const open = isWord(sig[i + 1], 'await') && keyword === 'for' ? i + 2 : i + 1;
      if (!isPunct(sig[open], '(') || match[open] === -1) { continue; }
      if (keyword === 'while' && doTails.has(i)) { continue; }
      headerEnd = match[open];
    }
    if (keyword === 'else') {
      if (isWord(sig[i + 1], 'if')) { continue; }
      headerEnd = i;
    }
    if (keyword === 'do') { headerEnd = i; }
    if (headerEnd === -1) { continue; }

    const bodyIndex = headerEnd + 1;
    const body = sig[bodyIndex];
    if (!body || isPunct(body, ';')) { continue; }
    const braced = isPunct(body, '{');
    const endIndex = braced ? match[bodyIndex] : statementEnd(src, bodyIndex);
    if (keyword === 'do' && endIndex !== -1 && isWord(sig[endIndex + 1], 'while')) { doTails.add(endIndex + 1); }
    found.push({ keyword, keywordIndex: i, headerEnd, bodyIndex, braced, endIndex });
  }
  return found;
}

function sameLineFollower(src, endIndex, keyword) {
  const next = src.sig[endIndex + 1];
  if (!next || next.nlBefore > 0 || next.commentBefore) { return null; }
  if (keyword === 'do' && isWord(next, 'while')) { return null; }
  if (isWord(next, 'else') && keyword !== 'else') { return null; }
  return next;
}

/** One change per braceless body whose end is certain. */
export function findBraceChanges(src) {
  if (!src.language.structural || src.language.family === 'go') { return []; }
  const changes = [];
  const splitAt = new Set();
  for (const entry of scanControlBodies(src)) {
    if (entry.braced || entry.endIndex === -1) { continue; }
    const body = src.sig[entry.bodyIndex];
    if (body.commentBefore) { continue; }
    const header = src.sig[entry.headerEnd];
    const last = src.sig[entry.endIndex];
    const edits = [
      { start: header.end, end: body.start, text: ' {\n' },
      { start: last.end, end: last.end, text: '\n}', tie: -body.start },
    ];
    const follower = sameLineFollower(src, entry.endIndex, entry.keyword);
    if (follower && !splitAt.has(last.end)) {
      splitAt.add(last.end);
      edits.push({ start: last.end, end: last.end, text: '\n', tie: 1e9 });
    }
    changes.push({
      rule: src.language.name === 'java' ? 'PL-CF-003' : 'PL-JS-001',
      start: src.sig[entry.keywordIndex].start,
      end: last.end,
      edits,
    });
  }
  return changes;
}
