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
 * A forgiving JSON reader for config files: `//` and `/* *\/` comments,
 * trailing commas, single-quoted strings and unquoted keys (JSON5 style) are
 * all accepted. It never throws — a syntax error comes back as `error`.
 */

const NUMBER = /[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|Infinity|NaN)/y;
const IDENTIFIER = /[A-Za-z_$][\w$-]*/y;
const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

class Reader {
  constructor(text) {
    this.text = text.replace(/^﻿/, '');
    this.pos = 0;
  }

  fail(message) {
    const upTo = this.text.slice(0, this.pos);
    const line = upTo.split('\n').length;
    throw new SyntaxError(`${message} (line ${line})`);
  }

  skipBlanks() {
    const { text } = this;
    for (;;) {
      const ch = text[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.pos++;
        continue;
      }
      if (ch === '/' && text[this.pos + 1] === '/') {
        const end = text.indexOf('\n', this.pos);
        this.pos = end === -1 ? text.length : end + 1;
        continue;
      }
      if (ch === '/' && text[this.pos + 1] === '*') {
        const end = text.indexOf('*/', this.pos + 2);
        this.pos = end === -1 ? text.length : end + 2;
        continue;
      }
      return;
    }
  }

  readString(quote) {
    const { text } = this;
    this.pos++;
    let out = '';
    while (this.pos < text.length) {
      const ch = text[this.pos];
      if (ch === quote) {
        this.pos++;
        return out;
      }
      if (ch === '\\') {
        out += this.readEscape();
        continue;
      }
      out += ch;
      this.pos++;
    }
    return this.fail('Unterminated string');
  }

  readEscape() {
    const { text } = this;
    const code = text[this.pos + 1];
    this.pos += 2;
    if (code === 'u') {
      const hex = text.slice(this.pos, this.pos + 4);
      this.pos += 4;
      return String.fromCharCode(parseInt(hex, 16) || 0);
    }
    if (code === '\n') { return ''; }
    return ESCAPES[code] ?? code;
  }

  readKey() {
    const ch = this.text[this.pos];
    if (ch === '"' || ch === '\'') { return this.readString(ch); }
    IDENTIFIER.lastIndex = this.pos;
    const match = IDENTIFIER.exec(this.text);
    if (!match) { return this.fail('Expected a property name'); }
    this.pos += match[0].length;
    return match[0];
  }

  readObject() {
    const result = {};
    this.pos++;
    for (;;) {
      this.skipBlanks();
      if (this.text[this.pos] === '}') {
        this.pos++;
        return result;
      }
      const key = this.readKey();
      this.skipBlanks();
      if (this.text[this.pos] !== ':') { this.fail('Expected ":"'); }
      this.pos++;
      result[key] = this.readValue();
      this.skipBlanks();
      const next = this.text[this.pos];
      if (next === ',') {
        this.pos++;
        continue;
      }
      if (next !== '}') { this.fail('Expected "," or "}"'); }
    }
  }

  readArray() {
    const result = [];
    this.pos++;
    for (;;) {
      this.skipBlanks();
      if (this.text[this.pos] === ']') {
        this.pos++;
        return result;
      }
      result.push(this.readValue());
      this.skipBlanks();
      const next = this.text[this.pos];
      if (next === ',') {
        this.pos++;
        continue;
      }
      if (next !== ']') { this.fail('Expected "," or "]"'); }
    }
  }

  readValue() {
    this.skipBlanks();
    const ch = this.text[this.pos];
    if (ch === '{') { return this.readObject(); }
    if (ch === '[') { return this.readArray(); }
    if (ch === '"' || ch === '\'') { return this.readString(ch); }
    for (const [word, value] of [['true', true], ['false', false], ['null', null]]) {
      if (this.text.startsWith(word, this.pos)) {
        this.pos += word.length;
        return value;
      }
    }
    NUMBER.lastIndex = this.pos;
    const match = NUMBER.exec(this.text);
    if (!match) { return this.fail('Unexpected character'); }
    this.pos += match[0].length;
    return Number(match[0]);
  }
}

/** `{ value, error }` — `error` is a message, `value` is undefined then. */
export function parseJsonc(text) {
  const reader = new Reader(String(text ?? ''));
  try {
    const value = reader.readValue();
    reader.skipBlanks();
    if (reader.pos < reader.text.length) { reader.fail('Unexpected content after the value'); }
    return { value, error: null };
  } catch (error) {
    return { value: undefined, error: error.message };
  }
}
