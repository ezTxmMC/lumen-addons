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
 * Line by line whitespace: trailing blanks, runs of blank lines and the
 * indentation by bracket depth.
 *
 * The indentation of a line follows from where its brackets were opened, not
 * from how the line was indented before — which makes the result the same on
 * a second run. Lines inside template literals, text blocks, raw strings and
 * multi-line strings are never touched (their blanks are content); block
 * comments move as one block and keep their inner alignment.
 */

import { analyze, blockCommentsByLine, isPunct, protectedLines } from './source.js';
import { T } from './tokenizer.js';

/** A line starting with one of these continues the statement above it. */
const CONTINUATION_STARTS = new Set([
  '.', '?.', '+', '-', '*', '/', '%', '&&', '||', '??', '?', ':', '=', '==', '===', '!=', '!==', '<=', '>=',
  '&', '|', '^', '->', '=>', '**',
]);
const GO_NO_CONTINUATION = new Set(['*', '&', '<-']);

/** A line ending with one of these is not finished. */
const CONTINUATION_ENDS = new Set(['+', '-', '*', '/', '%', '&&', '||', '??', '?', ':', '=>', '->', '.', '?.', '&', '|', '^', '**', '<<', '>>']);

function isCloserToken(token) {
  return token.type === T.PUNCT && (token.value === ')' || token.value === ']' || token.value === '}');
}

function isOpenerToken(token) {
  return token.type === T.PUNCT && (token.value === '(' || token.value === '[' || token.value === '{');
}

function groupByLine(src) {
  const byLine = new Map();
  for (const token of src.tokens) {
    if (token.type === T.WS || token.type === T.NEWLINE) { continue; }
    if (!byLine.has(token.line)) { byLine.set(token.line, []); }
    byLine.get(token.line).push(token);
  }
  return byLine;
}

function endsWithContinuation(token) {
  if (!token || token.type !== T.PUNCT) { return false; }
  return CONTINUATION_ENDS.has(token.value) || token.value.endsWith('=');
}

function isCaseLabel(src, token) {
  if (token.type !== T.WORD) { return false; }
  if (token.value === 'case') { return true; }
  if (token.value !== 'default') { return false; }
  const next = src.sig[token.si + 1];
  return isPunct(next, ':') || isPunct(next, '->');
}

function opensSwitch(src, token, byLine) {
  const { sig, match, language } = src;
  const before = sig[token.si - 1];
  if (language.family !== 'go') {
    if (!isPunct(before, ')') || match[token.si - 1] === -1) { return false; }
    const word = sig[match[token.si - 1] - 1];
    return Boolean(word) && word.type === T.WORD && word.value === 'switch';
  }
  const first = (byLine.get(token.line) ?? []).find((candidate) => candidate.type !== T.COMMENT);
  return Boolean(first) && first.type === T.WORD && (first.value === 'switch' || first.value === 'select');
}

/** Does the previous line end a control header (`if (...)`, `else`, `do`) whose body follows without braces? */
function endsBracelessHeader(src, previousLast) {
  if (!previousLast || src.language.family === 'go') { return false; }
  if (previousLast.type === T.WORD) { return previousLast.value === 'else' || previousLast.value === 'do'; }
  if (!isPunct(previousLast, ')') || src.match[previousLast.si] === -1) { return false; }
  const open = src.match[previousLast.si];
  const keyword = src.sig[open - 1];
  if (!keyword || keyword.type !== T.WORD || !['if', 'for', 'while'].includes(keyword.value)) { return false; }
  return !(keyword.value === 'while' && isPunct(src.sig[open - 2], '}'));
}

function startsContinuation(src, first, previousLast, previousFirst) {
  if (first.type === T.WORD && first.value === 'instanceof') { return true; }
  if (endsBracelessHeader(src, previousLast)) { return !isPunct(first, '{'); }
  if (first.type === T.PUNCT && CONTINUATION_STARTS.has(first.value)) {
    return !(src.language.family === 'go' && GO_NO_CONTINUATION.has(first.value));
  }
  if (!endsWithContinuation(previousLast)) { return false; }
  if (previousLast.value === ':') {
    const label = previousFirst && previousFirst.type === T.WORD && (previousFirst.value === 'case' || previousFirst.value === 'default');
    return !label;
  }
  return true;
}

function isTernaryStart(token) {
  return token.type === T.PUNCT && (token.value === '?' || token.value === ':');
}

function codeTokens(tokens) {
  return tokens.filter((token) => token.type !== T.COMMENT);
}

/** `name:` alone on a line — a statement label (not a `case` or `default`). */
function isLabelLine(tokens) {
  const code = codeTokens(tokens);
  return code.length === 2 && code[0].type === T.WORD && !['case', 'default'].includes(code[0].value) && isPunct(code[1], ':');
}

/** The frame a bracket opens on a line of the given level. */
function newFrame(src, state, token, { level, kind, line, go, byLine }) {
  const switchKind = token.value === '{' && opensSwitch(src, token, byLine) ? 'switch' : 'plain';
  // `if (a\n    && b) {` — the body hangs from the `if`, not from the continuation line.
  const afterParen = token.value === '{' && state.lastClosed && state.lastClosed.line < line && isPunct(src.sig[token.si - 1], ')');
  const afterHeader = go && token.value === '{' && kind !== 'normal';
  let open = level;
  if (afterParen) { open = state.lastClosed.open; }
  if (afterHeader) { open = state.statementLevel; }
  return { open, content: open + 1, kind: switchKind, inCase: false, line };
}

/**
 * Indentation level of every line (null where the line is left alone).
 *
 * Walks the lines once, keeping a stack of open brackets ("frames"). A frame
 * remembers the level of the line that opened it (`open`) — its closing line
 * returns to that level — and the level its content gets (`content`).
 */
function computeLevels(src, lineCount, startsInside, byLine) {
  const levels = new Array(lineCount).fill(null);
  const frames = [];
  const go = src.language.family === 'go';
  const state = { previousLast: null, previousFirst: null, previous: null, previousLabel: false, lastClosed: null, statementLevel: 0, labelLevel: null, afterLabel: false };

  const nextCodeFirst = (from) => {
    for (let line = from; line < lineCount; line++) {
      const tokens = byLine.get(line);
      if (!tokens?.length || startsInside.has(line)) { continue; }
      if (tokens[0].type === T.COMMENT && !codeTokens(tokens).length) { continue; }
      return tokens[0].type === T.COMMENT ? null : tokens[0];
    }
    return null;
  };

  const continues = (first) => {
    if (state.previousLabel) { return false; }
    return startsContinuation(src, first, state.previousLast, state.previousFirst);
  };

  const commentLevel = (frame, context, line) => {
    const upcoming = nextCodeFirst(line + 1);
    const inSwitch = frame?.kind === 'switch';
    const labelNext = inSwitch && upcoming && isCaseLabel(src, upcoming);
    let level = inSwitch && !labelNext && frame.inCase && !go ? context + 1 : context;
    if (labelNext && go) { level = frame.open; }
    const hangs = upcoming && !isCloserToken(upcoming) && !inSwitch && continues(upcoming);
    return hangs ? context + 1 : level;
  };

  /** `{ level, kind }` of a line that starts with code. */
  const codeLevel = (frame, context, first, tokens) => {
    if (isCloserToken(first)) { return { level: frame ? frame.open : 0, kind: 'normal' }; }
    const inSwitch = frame?.kind === 'switch';
    if (inSwitch && isCaseLabel(src, first)) {
      frame.inCase = true;
      const level = go ? frame.open : context;
      const finished = [':', '->'].includes(codeTokens(tokens).at(-1).value);
      state.labelLevel = finished ? null : level;
      state.afterLabel = finished;
      return { level, kind: 'normal' };
    }
    if (state.labelLevel !== null) {
      // The rest of a `case a,\n    b:` list hangs from the label.
      const level = state.labelLevel + 1;
      const ends = codeTokens(tokens).at(-1).value === ':';
      state.labelLevel = ends ? null : state.labelLevel;
      state.afterLabel = ends;
      return { level, kind: 'normal' };
    }
    let level = context;
    if (inSwitch && frame.inCase && !go) { level = context + 1; }
    if (go && isLabelLine(tokens)) { return { level: Math.max(level - 1, 0), kind: 'normal' }; }
    if (!continues(first)) { return { level, kind: 'normal' }; }
    const ternary = isTernaryStart(first);
    level += 1;
    // `? a` / `: b` hang one step under the condition they belong to.
    if (ternary && state.previous?.kind === 'continuation') { level = state.previous.level + 1; }
    if (ternary && state.previous?.kind === 'ternary') { level = state.previous.level; }
    return { level, kind: ternary ? 'ternary' : 'continuation' };
  };

  for (let line = 0; line < lineCount; line++) {
    const tokens = byLine.get(line) ?? [];
    const frame = frames[frames.length - 1];
    const context = frame ? frame.content : 0;
    const first = startsInside.has(line) ? null : tokens[0];
    let level = context;
    let kind = 'normal';

    if (first && first.type === T.COMMENT) { level = commentLevel(frame, context, line); }
    if (first && first.type !== T.COMMENT) { ({ level, kind } = codeLevel(frame, context, first, tokens)); }
    levels[line] = startsInside.has(line) ? null : level;
    if (kind === 'normal') { state.statementLevel = level; }

    for (const token of tokens) {
      if (isOpenerToken(token)) { frames.push(newFrame(src, state, token, { level, kind, line, go, byLine })); }
      if (isCloserToken(token)) { state.lastClosed = frames.pop() ?? null; }
    }
    const code = codeTokens(tokens);
    if (code.length) {
      state.previousLast = code[code.length - 1];
      state.previousFirst = code[0];
      state.previous = { kind, level };
      state.previousLabel = isLabelLine(tokens) || state.afterLabel;
      state.afterLabel = false;
    }
  }
  return levels;
}

function leadingBlanks(line) {
  return /^[ \t]*/.exec(line)[0];
}

/** Re-indents the continuation lines of a block comment as a whole. */
function reindentComment(raw, indent, originalPrefix, javadoc) {
  const trimmed = raw.trimStart();
  if (trimmed === '') { return ''; }
  if (javadoc && trimmed.startsWith('*')) { return `${indent} ${trimmed}`.trimEnd(); }
  const relative = raw.startsWith(originalPrefix) ? raw.slice(originalPrefix.length) : trimmed;
  return `${indent}${relative}`.trimEnd();
}

function commentInfo(src, lines) {
  const info = new Map();
  for (const [start, token] of blockCommentsByLine(src)) {
    const span = token.value.split('\n').length - 1;
    const inner = lines.slice(start + 1, start + span + 1).map((line) => line.trim()).filter(Boolean);
    const javadoc = inner.length > 0 && inner.every((line) => line.startsWith('*'));
    for (let k = 1; k <= span; k++) { info.set(start + k, { start, javadoc }); }
  }
  return info;
}

/**
 * Reflows the whitespace of `text` (line breaks already `\n`).
 *
 * `options`: `{ unit, indent: boolean, trim: boolean, collapse: boolean }`.
 * Returns one entry per input line: `{ text }` or `{ text: null }` for a line
 * that goes away — so a range format can pick lines individually.
 */
export function reflow(text, language, options) {
  const lines = text.split('\n');
  const src = analyze(text, language);
  const { startsInside, endsInside } = protectedLines(src);
  const byLine = groupByLine(src);
  const comments = commentInfo(src, lines);
  const levels = options.indent && src.balanced ? computeLevels(src, lines.length, startsInside, byLine) : null;
  const newIndent = new Array(lines.length).fill(null);
  const entries = [];
  let blankRun = 0;

  lines.forEach((raw, line) => {
    const tail = (value) => (options.trim && !endsInside.has(line) ? value.trimEnd() : value);

    if (startsInside.has(line)) {
      blankRun = 0;
      entries.push({ text: tail(raw) });
      return;
    }
    const comment = comments.get(line);
    if (comment) {
      blankRun = 0;
      const indent = newIndent[comment.start];
      const prefix = leadingBlanks(lines[comment.start]);
      const reindented = indent === null ? tail(raw) : reindentComment(raw, indent, prefix, comment.javadoc);
      entries.push({ text: reindented });
      return;
    }
    const content = raw.trim();
    if (content === '') {
      blankRun++;
      const drop = options.collapse && blankRun > 1;
      entries.push({ text: drop ? null : '' });
      return;
    }
    blankRun = 0;
    const level = levels ? levels[line] : null;
    const indent = level === null ? leadingBlanks(raw) : options.unit.repeat(level);
    newIndent[line] = level === null ? null : indent;
    entries.push({ text: tail(`${indent}${raw.trimStart()}`) });
  });
  return entries;
}
