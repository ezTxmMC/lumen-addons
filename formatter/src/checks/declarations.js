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
 * What the checks need to know about a file's declarations: its functions
 * and classes with their extent, and the names it introduces.
 */

import { isPunct, isWord, namesBeforeAssignment } from '../source.js';
import { T } from '../tokenizer.js';

const CONTROL_WORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'with', 'synchronized', 'return', 'throw', 'new', 'else', 'do', 'try', 'finally',
  'await', 'typeof', 'case', 'in', 'of',
]);

const DECLARATION_MODIFIERS = new Set(['function', 'async', 'static', 'public', 'private', 'protected', 'get', 'set', 'abstract', 'override', 'export', 'default', 'readonly', 'declare']);
const PARAMETER_MODIFIERS = new Set(['public', 'private', 'protected', 'readonly', 'final', 'static', 'override']);

function nameBeforeAssignment(sig, index) {
  const before = sig[index];
  if (isPunct(before, '=') && isWord(sig[index - 1])) { return sig[index - 1]; }
  if (isPunct(before, ':') && isWord(sig[index - 1])) { return sig[index - 1]; }
  return null;
}

/** The `)` that ends the parameter list of a function whose `{` is at sig index `brace`, or -1. */
function parameterClose(src, brace) {
  const { sig } = src;
  const before = sig[brace - 1];
  if (isPunct(before, ')')) { return brace - 1; }
  const family = src.language.family;
  for (let k = brace - 1, steps = 0; k > 0 && steps < 40; k--, steps++) {
    const token = sig[k];
    if (token.type === T.PUNCT && [';', '{', '}', '=', '=>'].includes(token.value)) { return -1; }
    if (isPunct(token, ')') && (isPunct(sig[k + 1], ':') || isWord(sig[k + 1], 'throws'))) { return k; }
    if (family === 'go' && isPunct(token, ')')) { return k; }
  }
  return -1;
}

function jsFunctionName(src, open) {
  const { sig } = src;
  const nameToken = sig[open - 1];
  if (!nameToken) { return null; }
  if (isWord(nameToken, 'function')) { return nameBeforeAssignment(sig, open - 2); }
  if (nameToken.type !== T.WORD || CONTROL_WORDS.has(nameToken.value)) { return null; }
  if (isWord(sig[open - 2], 'new')) { return null; }
  return nameToken;
}

function goFunctionName(src, brace) {
  const { sig, match } = src;
  for (let k = brace - 1, steps = 0; k >= 0 && steps < 80; k--, steps++) {
    if (isPunct(sig[k], ')') && match[k] !== -1) {
      k = match[k];
      continue;
    }
    if (isWord(sig[k], 'func')) {
      let at = k + 1;
      if (isPunct(sig[at], '(') && match[at] !== -1) { at = match[at] + 1; }
      return isWord(sig[at]) && isPunct(sig[at + 1], '(') ? sig[at] : null;
    }
    if (isPunct(sig[k], '}') || isPunct(sig[k], ';')) { return null; }
  }
  return null;
}

function arrowName(src, brace) {
  const { sig, match } = src;
  let paramsStart = brace - 2;
  if (isPunct(sig[paramsStart], ')') && match[paramsStart] !== -1) { paramsStart = match[paramsStart]; }
  let before = paramsStart - 1;
  if (isWord(sig[before], 'async')) { before--; }
  return nameBeforeAssignment(sig, before);
}

/** Named functions with a block body: `{ name, nameToken, open, close, startLine, endLine, lines }`. */
export function findFunctions(src) {
  const { sig, match, language } = src;
  const found = [];
  for (let b = 0; b < sig.length; b++) {
    if (!isPunct(sig[b], '{') || match[b] === -1) { continue; }
    let nameToken = null;
    if (language.family === 'go') { nameToken = goFunctionName(src, b); }
    if (language.family !== 'go' && isPunct(sig[b - 1], '=>')) { nameToken = arrowName(src, b); }
    if (language.family !== 'go' && !isPunct(sig[b - 1], '=>')) {
      const close = parameterClose(src, b);
      if (close !== -1 && match[close] !== -1) { nameToken = jsFunctionName(src, match[close]); }
    }
    if (!nameToken) { continue; }
    const endToken = sig[match[b]];
    found.push({
      name: nameToken.value,
      nameToken,
      open: b,
      close: match[b],
      startLine: nameToken.line,
      endLine: endToken.line,
      lines: endToken.line - nameToken.line + 1,
    });
  }
  return found;
}

/** `class Name ... { }` in JavaScript, TypeScript and Java. */
export function findClasses(src) {
  const { sig, match, language } = src;
  const found = [];
  if (language.family === 'go' || language.family === 'crystal') { return found; }
  for (let k = 0; k < sig.length - 1; k++) {
    if (!isWord(sig[k], 'class') || isPunct(sig[k - 1], '.') || !isWord(sig[k + 1])) { continue; }
    let brace = k + 2;
    while (brace < sig.length && !isPunct(sig[brace], '{')) {
      if (isPunct(sig[brace], ';')) { break; }
      brace = isPunct(sig[brace], '(') && match[brace] !== -1 ? match[brace] + 1 : brace + 1;
    }
    if (!isPunct(sig[brace], '{') || match[brace] === -1) { continue; }
    const end = sig[match[brace]];
    found.push({
      name: sig[k + 1].value,
      nameToken: sig[k + 1],
      open: brace,
      close: match[brace],
      lines: end.line - sig[k + 1].line + 1,
    });
  }
  return found;
}

function groupSegments(src, open, close) {
  const { sig, match } = src;
  const segments = [[]];
  let angle = 0;
  for (let k = open + 1; k < close; k++) {
    const token = sig[k];
    if (isPunct(token, ',') && angle === 0) {
      segments.push([]);
      continue;
    }
    segments[segments.length - 1].push(token);
    if (isPunct(token, '<')) { angle++; }
    if (isPunct(token, '>') && angle > 0) { angle--; }
    if (isPunct(token, '>>') && angle > 0) { angle = Math.max(0, angle - 2); }
    if (token.type === T.PUNCT && '([{'.includes(token.value) && match[k] !== -1) {
      const end = match[k];
      for (k += 1; k <= end; k++) { segments[segments.length - 1].push(sig[k]); }
      k = end;
    }
  }
  return segments;
}

function parameterName(segment, family) {
  const words = segment.filter((token) => token.type === T.WORD && !PARAMETER_MODIFIERS.has(token.value));
  if (!words.length || segment.some((token) => isPunct(token, '{') || isPunct(token, '['))) { return null; }
  if (family === 'js') {
    const rest = segment.findIndex((token) => isPunct(token, '...'));
    return rest === -1 ? words[0] : segment[rest + 1];
  }
  const beforeDefault = segment.findIndex((token) => isPunct(token, '='));
  const upTo = beforeDefault === -1 ? segment : segment.slice(0, beforeDefault);
  const named = upTo.filter((token) => token.type === T.WORD && !PARAMETER_MODIFIERS.has(token.value));
  if (named.length < 2 && segment.length > 1) { return null; }
  return named[named.length - 1] ?? null;
}

/**
 * Names the file introduces: `{ name, token, kind }` with kind `variable`,
 * `parameter`, `catch` or `loop`. Destructuring is skipped on purpose.
 */
export function findDeclaredNames(src) {
  const { sig, match, language } = src;
  const found = [];
  const family = language.family;
  const add = (token, kind) => {
    if (token && token.type === T.WORD) { found.push({ name: token.value, token, kind }); }
  };

  for (let k = 0; k < sig.length; k++) {
    const token = sig[k];
    if (family === 'js' && token.type === T.WORD && ['const', 'let', 'var'].includes(token.value) && !isPunct(sig[k - 1], '.')) {
      const inLoop = isPunct(sig[k - 1], '(') && isWord(sig[k - 2], 'for');
      add(isWord(sig[k + 1]) ? sig[k + 1] : null, inLoop ? 'loop' : 'variable');
    }
    if (family === 'go' && isPunct(token, ':=')) {
      for (const name of namesBeforeAssignment(sig, k)) { add(name, 'variable'); }
    }
    if (family === 'go' && isWord(token, 'var') && isWord(sig[k + 1])) { add(sig[k + 1], 'variable'); }
    if (!isPunct(token, '(') || match[k] === -1) { continue; }
    const close = match[k];
    const before = sig[k - 1];
    const after = sig[close + 1];
    const isCatch = isWord(before, 'catch');
    const isFor = isWord(before, 'for');
    const nameBefore = sig[k - 2];
    const typedDeclaration = isPunct(after, ':') && family === 'js' && before?.type === T.WORD
      && (!nameBefore || [';', '{', '}'].includes(nameBefore.value) || (nameBefore.type === T.WORD && DECLARATION_MODIFIERS.has(nameBefore.value)));
    const lambda = Boolean(after) && (isPunct(after, '=>') || isPunct(after, '->'));
    const isFunction = lambda || typedDeclaration || (Boolean(after) && (isPunct(after, '{') || isWord(after, 'throws')));
    if (family === 'go') { continue; }
    if (isFor && family === 'java') {
      const header = groupSegments(src, k, close)[0] ?? [];
      const colon = header.findIndex((item) => isPunct(item, ':'));
      if (colon > 0 && header[colon - 1].type === T.WORD) { add(header[colon - 1], 'loop'); }
      continue;
    }
    if (isCatch) {
      for (const segment of groupSegments(src, k, close)) { add(parameterName(segment, family), 'catch'); }
      continue;
    }
    const callee = before && before.type === T.WORD && CONTROL_WORDS.has(before.value);
    if (!isFunction || callee) { continue; }
    if (isPunct(after, '{') && !(before && (before.type === T.WORD || isPunct(before, '>')))) { continue; }
    for (const segment of groupSegments(src, k, close)) { add(parameterName(segment, family), lambda ? 'lambda' : 'parameter'); }
  }
  if (family === 'js') {
    sig.forEach((token, k) => {
      if (isPunct(token, '=>') && isWord(sig[k - 1]) && !isPunct(sig[k - 2], '.')) { add(sig[k - 1], 'lambda'); }
    });
  }
  if (family === 'java') {
    for (let k = 1; k < sig.length - 1; k++) {
      const declaresLocal = isWord(sig[k]) && isWord(sig[k - 1]) && isPunct(sig[k + 1], '=') && !CONTROL_WORDS.has(sig[k - 1].value);
      if (declaresLocal) { add(sig[k], 'variable'); }
    }
  }
  return found;
}
