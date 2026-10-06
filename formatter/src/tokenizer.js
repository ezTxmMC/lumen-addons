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
 * A tokenizer for the brace languages (JavaScript/TypeScript, Java, Kotlin, Go).
 *
 * Every transformation of the formatter works on these tokens and their
 * offsets, so nothing ever reaches into a string, a comment or a template by
 * accident. The tokenizer never throws: an unterminated literal simply ends
 * at the end of its line (or the file for comments and templates).
 *
 * Families: `js` (JavaScript, TypeScript), `java`, `kotlin`, `go`.
 */

export const T = Object.freeze({
  WS: 'ws',
  NEWLINE: 'newline',
  COMMENT: 'comment',
  STRING: 'string',
  TEMPLATE: 'template',
  REGEX: 'regex',
  WORD: 'word',
  NUMBER: 'number',
  PUNCT: 'punct',
});

/** After these words a `/` starts a regular expression instead of a division. */
const WORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'delete', 'throw', 'new', 'yield', 'await', 'instanceof',
]);

const PUNCT_4 = ['>>>='];
const PUNCT_3 = ['...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??='];
const PUNCT_2_COMMON = ['==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>'];
const PUNCT_2_BY_FAMILY = {
  js: ['=>', '??', '?.', '**'],
  java: ['->', '::'],
  kotlin: ['->', '::', '?.', '?:', '..'],
  go: [':=', '<-', '&^'],
};

const NUMBER_PATTERN = /(?:0[xXbBoO][0-9a-fA-F_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[a-zA-Z]*/y;
const WORD_PATTERN = /[A-Za-z_$\u0080-￿][\w$\u0080-￿]*/y;

function countNewlines(text) {
  let count = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    count++;
  }
  return count;
}

/** End (exclusive) of a quoted literal; an unescaped line break ends an unterminated one. */
function scanQuoted(text, start, quote) {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) { return i + 1; }
    if (ch === '\n') { return i; }
    i++;
  }
  return text.length;
}

/** End of a `${ ... }` expression inside a template; `start` is the first character after `${`. */
function scanInterpolation(text, start) {
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') { depth++; }
    if (ch === '}') { depth--; }
    if (depth === 0) { return i + 1; }
    if (ch === '\'' || ch === '"') {
      i = scanQuoted(text, i, ch);
      continue;
    }
    if (ch === '`') {
      i = scanTemplate(text, i, '`');
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const lineEnd = text.indexOf('\n', i);
      i = lineEnd === -1 ? text.length : lineEnd;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    if (ch === '/' && regexStartsAt(text, start, i)) {
      const end = scanRegex(text, i);
      if (end !== -1) {
        i = end;
        continue;
      }
    }
    i++;
  }
  return text.length;
}

/** Inside `${ }`: does the `/` at `i` begin a regular expression (judged by the character before it)? */
function regexStartsAt(text, from, i) {
  let k = i - 1;
  while (k >= from && ' \t\n'.includes(text[k])) { k--; }
  if (k < from) { return true; }
  return '(,=:[!&|?{};+-*%<>~^'.includes(text[k]);
}

/** A template literal (or a Kotlin string with `${}`): may span lines and nest expressions. */
function scanTemplate(text, start, delimiter) {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === delimiter) { return i + 1; }
    if (ch === '$' && text[i + 1] === '{') {
      i = scanInterpolation(text, i + 2);
      continue;
    }
    i++;
  }
  return text.length;
}

/** `"""` text blocks (Java) and raw strings (Kotlin): end at the next unescaped `"""`. */
function scanTextBlock(text, start) {
  let i = start + 3;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text.startsWith('"""', i)) {
      let end = i + 3;
      while (text[end] === '"') { end++; }
      return end;
    }
    i++;
  }
  return text.length;
}

function scanRawString(text, start) {
  const close = text.indexOf('`', start + 1);
  return close === -1 ? text.length : close + 1;
}

/** End of a regular expression literal starting at `start`, or -1 when it is not one. */
function scanRegex(text, start) {
  let i = start + 1;
  let inClass = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') { return -1; }
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '[') { inClass = true; }
    if (ch === ']') { inClass = false; }
    if (ch === '/' && !inClass) {
      let end = i + 1;
      while (/[a-z]/i.test(text[end] ?? '')) { end++; }
      return end;
    }
    i++;
  }
  return -1;
}

function regexAllowedAfter(previous) {
  if (!previous) { return true; }
  if (previous.type === T.WORD) { return WORDS_BEFORE_REGEX.has(previous.value); }
  if (previous.type !== T.PUNCT) { return false; }
  return ![')', ']', '}', '++', '--'].includes(previous.value);
}

function punctuatorAt(text, i, twoChar) {
  for (const candidate of PUNCT_4) {
    if (text.startsWith(candidate, i)) { return candidate; }
  }
  for (const candidate of PUNCT_3) {
    if (text.startsWith(candidate, i)) { return candidate; }
  }
  for (const candidate of twoChar) {
    if (text.startsWith(candidate, i)) { return candidate; }
  }
  return text[i];
}

/**
 * Splits `text` into tokens. Line breaks are `\n` tokens (the formatter
 * normalises `\r\n` before it tokenizes), other blanks are `ws` tokens.
 */
export function tokenize(text, family) {
  const tokens = [];
  const twoChar = [...PUNCT_2_COMMON, ...(PUNCT_2_BY_FAMILY[family] ?? [])];
  let i = 0;
  let line = 0;
  let lastSignificant = null;

  const push = (type, end) => {
    const token = { type, value: text.slice(i, end), start: i, end, line };
    tokens.push(token);
    line += countNewlines(token.value);
    if (type !== T.WS && type !== T.NEWLINE && type !== T.COMMENT) { lastSignificant = token; }
    i = end;
    return token;
  };

  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '\n') {
      push(T.NEWLINE, i + 1);
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
      let end = i + 1;
      while (end < text.length && ' \t\r\f\v'.includes(text[end])) { end++; }
      push(T.WS, end);
      continue;
    }
    if (ch === '/' && next === '/') {
      const lineEnd = text.indexOf('\n', i);
      push(T.COMMENT, lineEnd === -1 ? text.length : lineEnd).block = false;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      push(T.COMMENT, close === -1 ? text.length : close + 2).block = true;
      continue;
    }
    if (ch === '"' && text.startsWith('"""', i) && (family === 'java' || family === 'kotlin')) {
      push(T.TEMPLATE, scanTextBlock(text, i)).kind = 'textblock';
      continue;
    }
    if (ch === '"' && family === 'kotlin') {
      push(T.TEMPLATE, scanTemplate(text, i, '"')).kind = 'string';
      continue;
    }
    if (ch === '"' || ch === '\'') {
      push(T.STRING, scanQuoted(text, i, ch));
      continue;
    }
    if (ch === '`' && family === 'go') {
      push(T.TEMPLATE, scanRawString(text, i)).kind = 'raw';
      continue;
    }
    if (ch === '`' && family === 'js') {
      push(T.TEMPLATE, scanTemplate(text, i, '`')).kind = 'template';
      continue;
    }
    if (ch === '/' && family === 'js' && regexAllowedAfter(lastSignificant)) {
      const end = scanRegex(text, i);
      if (end !== -1) {
        push(T.REGEX, end);
        continue;
      }
    }
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(next ?? ''))) {
      NUMBER_PATTERN.lastIndex = i;
      const match = NUMBER_PATTERN.exec(text);
      if (match) {
        push(T.NUMBER, i + match[0].length);
        continue;
      }
    }
    WORD_PATTERN.lastIndex = i;
    const word = WORD_PATTERN.exec(text);
    if (word) {
      push(T.WORD, i + word[0].length);
      continue;
    }
    push(T.PUNCT, i + punctuatorAt(text, i, twoChar).length);
  }
  return tokens;
}
