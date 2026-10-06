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
 * The checks of the language profiles: JavaScript and TypeScript (PL-JS-003,
 * PL-JS-004, PL-TS-001, PL-TS-003, PL-TS-005) and Java (PL-JAVA-002 to
 * PL-JAVA-005).
 */

import { isPunct, isWord } from '../source.js';
import { T } from '../tokenizer.js';

const ASSIGNMENT_OPERATORS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=']);
const FQCN_ROOTS = new Set(['java', 'javax', 'jakarta', 'org', 'com', 'net', 'io']);

/** Is the name assigned to anywhere, or in a place this scan does not understand? */
function isReassigned(sig, name, declaration) {
  for (let k = 0; k < sig.length; k++) {
    const token = sig[k];
    if (k === declaration + 1 || !isWord(token, name) || isPunct(sig[k - 1], '.')) { continue; }
    const after = sig[k + 1];
    const before = sig[k - 1];
    if (after && after.type === T.PUNCT && (ASSIGNMENT_OPERATORS.has(after.value) || after.value === '++' || after.value === '--')) { return true; }
    if (before && before.type === T.PUNCT && (before.value === '++' || before.value === '--')) { return true; }
    // `[a, name] = ...` and `({ name } = ...)`: assignments through a pattern.
    if (before && (isPunct(before, ',') || isPunct(before, '[') || isPunct(before, '{')) && after && (isPunct(after, ',') || isPunct(after, ']') || isPunct(after, '}'))) { return true; }
    if (isWord(before, 'of') || isWord(before, 'in')) { continue; }
  }
  return false;
}

export function checkJavaScript(ctx) {
  const { src } = ctx;
  const { sig } = src;
  if (src.language.family !== 'js') { return; }
  for (let k = 0; k < sig.length; k++) {
    const token = sig[k];
    if (isWord(token, 'var') && !isPunct(sig[k - 1], '.') && isWord(sig[k + 1])) {
      ctx.report('PL-JS-003', {
        start: token.start,
        end: token.end,
        message: '`var` is not used in Pureline code.',
        suggestion: 'Use `const`, or `let` when the variable really is reassigned.',
        severity: 'error',
      });
    }
    const simpleLet = isWord(token, 'let') && isWord(sig[k + 1]) && isPunct(sig[k + 2], '=') && !isPunct(sig[k - 1], '(');
    if (simpleLet && !isReassigned(sig, sig[k + 1].value, k)) {
      ctx.report('PL-JS-003', {
        start: token.start,
        end: sig[k + 1].end,
        message: `\`${sig[k + 1].value}\` is never reassigned.`,
        suggestion: 'Declare it with `const`; use `let` only for actual reassignment.',
        severity: 'warn',
      });
    }
    if (isPunct(token, '.') && isWord(sig[k + 1], 'then') && isPunct(sig[k + 2], '(')) {
      ctx.report('PL-JS-004', {
        start: sig[k + 1].start,
        end: sig[k + 1].end,
        message: 'Promise chain: `async` / `await` usually reads more linearly.',
        suggestion: 'Make the surrounding function `async` and `await` the call.',
        severity: 'hint',
      });
    }
  }
  if (src.language.name === 'typescript') { checkTypeScript(ctx); }
}

function checkTypeScript(ctx) {
  const { sig } = ctx.src;
  for (let k = 0; k < sig.length; k++) {
    const token = sig[k];
    if (isWord(token, 'any') && !isPunct(sig[k - 1], '.')) {
      const annotation = isPunct(sig[k - 1], ':') || isWord(sig[k - 1], 'as') || isPunct(sig[k - 1], '<') || isPunct(sig[k - 1], ',');
      const closes = isPunct(sig[k + 1], '>') || isPunct(sig[k + 1], ',') || isPunct(sig[k + 1], ')') || isPunct(sig[k + 1], ';') || isPunct(sig[k + 1], '[') || isPunct(sig[k + 1], '=') || isPunct(sig[k + 1], '|') || isPunct(sig[k + 1], '&') || !sig[k + 1];
      if (annotation && closes) {
        ctx.report('PL-TS-001', {
          start: token.start,
          end: token.end,
          message: '`any` switches the type checker off.',
          suggestion: 'Use a precise type, or `unknown` for data of an unknown shape.',
          severity: 'warn',
        });
      }
    }
    if (isWord(token, 'interface') && isWord(sig[k + 1]) && /^I[A-Z]/.test(sig[k + 1].value)) {
      ctx.report('PL-TS-003', {
        start: sig[k + 1].start,
        end: sig[k + 1].end,
        message: `\`${sig[k + 1].value}\`: the \`I\` prefix is a Java convention.`,
        suggestion: `Call it \`${sig[k + 1].value.slice(1)}\`.`,
        severity: 'warn',
      });
    }
    if (isWord(token, 'enum') && isWord(sig[k + 1]) && !isPunct(sig[k - 1], '.')) {
      ctx.report('PL-TS-005', {
        start: token.start,
        end: sig[k + 1].end,
        message: 'A union of string literals is often simpler than an enum.',
        suggestion: 'Consider `type State = "idle" | "ready"` unless you need the enum object at runtime.',
        severity: 'hint',
      });
    }
  }
}

/** `a.b.C` chains that start like a package and contain a class name, outside import/package lines. */
function fullyQualifiedNames(sig) {
  const found = [];
  let statementStart = true;
  for (let k = 0; k < sig.length; k++) {
    const token = sig[k];
    const startsImport = statementStart && (isWord(token, 'import') || isWord(token, 'package'));
    if (startsImport) {
      while (k < sig.length && !isPunct(sig[k], ';')) { k++; }
      statementStart = true;
      continue;
    }
    statementStart = isPunct(token, ';') || isPunct(token, '{') || isPunct(token, '}');
    if (token.type !== T.WORD || !FQCN_ROOTS.has(token.value) || isPunct(sig[k - 1], '.')) { continue; }
    let end = k;
    let sawClass = false;
    while (isPunct(sig[end + 1], '.') && isWord(sig[end + 2])) {
      end += 2;
      sawClass = sawClass || /^[A-Z]/.test(sig[end].value);
      if (sawClass) { break; }
    }
    if (sawClass && end - k >= 4) { found.push({ from: token, to: sig[end] }); }
  }
  return found;
}

function checkJavaInterfaces(ctx) {
  const { sig } = ctx.src;
  for (let k = 0; k < sig.length - 1; k++) {
    if (!isWord(sig[k], 'interface') || isPunct(sig[k - 1], '@') || !isWord(sig[k + 1])) { continue; }
    const name = sig[k + 1];
    if (/^I[A-Z]/.test(name.value)) { continue; }
    ctx.report('PL-JAVA-002', {
      start: name.start,
      end: name.end,
      message: `Pureline Java names interfaces with the \`I\` prefix: \`I${name.value}\`.`,
      suggestion: `Rename \`${name.value}\` to \`I${name.value}\`.`,
      severity: 'hint',
    });
  }
}

function isGetterBody(body) {
  const values = body.map((token) => token.value);
  if (values[0] !== 'return') { return false; }
  const rest = values.slice(1);
  const simple = rest.length === 2 && rest[1] === ';';
  const viaThis = rest.length === 4 && rest[0] === 'this' && rest[1] === '.' && rest[3] === ';';
  return simple || viaThis;
}

function isConstructorBody(body) {
  if (body.length % 6 !== 0) { return false; }
  for (let at = 0; at < body.length; at += 6) {
    const chunk = body.slice(at, at + 6).map((token) => token.value);
    if (chunk[0] !== 'this' || chunk[1] !== '.' || chunk[3] !== '=' || chunk[5] !== ';') { return false; }
  }
  return true;
}

/** Does a class body contain nothing but final fields, a constructor and plain getters? */
function isPlainData(src, className, open, close) {
  const { sig, match } = src;
  let fields = 0;
  let header = [];
  let k = open + 1;
  while (k < close) {
    const token = sig[k];
    if (isPunct(token, '@')) {
      k += 2;
      if (isPunct(sig[k], '(') && match[k] !== -1) { k = match[k] + 1; }
      continue;
    }
    const modifiers = header.filter((item) => isWord(item, 'static') || isWord(item, 'abstract') || isWord(item, 'class'));
    if (modifiers.length) { return false; }
    if (isPunct(token, '{') && match[k] !== -1) {
      const body = sig.slice(k + 1, match[k]);
      const paren = header.findIndex((item) => isPunct(item, '('));
      const name = paren > 0 ? header[paren - 1].value : null;
      const plain = name === className ? isConstructorBody(body) : isGetterBody(body);
      if (paren === -1 || !plain) { return false; }
      header = [];
      k = match[k] + 1;
      continue;
    }
    if (isPunct(token, ';')) {
      const isField = !header.some((item) => isPunct(item, '('));
      if (!isField || !header.some((item) => isWord(item, 'final'))) { return false; }
      fields++;
      header = [];
      k++;
      continue;
    }
    header.push(token);
    k++;
  }
  return fields > 0 && header.length === 0;
}

function checkJavaRecords(ctx) {
  const { src } = ctx;
  const { sig, match } = src;
  for (let k = 0; k < sig.length - 2; k++) {
    if (!isWord(sig[k], 'class') || !isWord(sig[k + 1]) || isPunct(sig[k - 1], '.')) { continue; }
    let brace = k + 2;
    while (brace < sig.length && !isPunct(sig[brace], '{') && !isWord(sig[brace], 'extends')) { brace++; }
    if (!isPunct(sig[brace], '{') || match[brace] === -1) { continue; }
    if (!isPlainData(src, sig[k + 1].value, brace, match[brace])) { continue; }
    ctx.report('PL-JAVA-003', {
      start: sig[k + 1].start,
      end: sig[k + 1].end,
      message: `\`${sig[k + 1].value}\` only holds final fields and getters.`,
      suggestion: 'A `record` states that in one line and generates the boilerplate.',
      severity: 'hint',
    });
  }
}

export function checkJava(ctx) {
  const { src } = ctx;
  const { sig } = src;
  if (src.language.name !== 'java') { return; }
  checkJavaInterfaces(ctx);
  checkJavaRecords(ctx);
  for (let k = 0; k < sig.length - 3; k++) {
    if (isWord(sig[k], 'Objects') && isPunct(sig[k + 1], '.') && isWord(sig[k + 2], 'requireNonNull') && !isPunct(sig[k - 1], '.')) {
      ctx.report('PL-JAVA-004', {
        start: sig[k].start,
        end: sig[k + 2].end,
        message: '`Objects.requireNonNull` hides the decision about a missing value.',
        suggestion: 'Check `== null` and return, or throw a domain-specific exception.',
        severity: 'info',
      });
    }
  }
  for (const name of fullyQualifiedNames(sig)) {
    ctx.report('PL-JAVA-005', {
      start: name.from.start,
      end: name.to.end,
      message: `Fully qualified name \`${name.to.value}\` used in code.`,
      suggestion: `Import ${name.to.value} and use the simple name.`,
      severity: 'warn',
    });
  }
}
