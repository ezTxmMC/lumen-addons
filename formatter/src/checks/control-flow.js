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
 * Checks about the shape of control flow and of statements: nesting depth
 * (PL-CF-001), `else` (PL-CF-002 / PL-GO-002), braces (PL-CF-003 / PL-JS-001),
 * semicolons (PL-JS-002) and needlessly vertical calls (PL-FMT-001).
 */

import { findCallChanges } from '../fixes/calls.js';
import { scanControlBodies } from '../fixes/braces.js';
import { scanElses } from '../fixes/else.js';
import { findSemicolonChanges } from '../fixes/semicolons.js';
import { isPunct } from '../source.js';
import { T } from '../tokenizer.js';

const CONTROL_HEADS = new Set(['if', 'else', 'for', 'while', 'do', 'switch', 'select', 'try', 'catch', 'finally']);
const MAX_NESTING = 3;

/** The first token of the statement whose block opens at sig index `brace`. */
function statementHead(src, brace) {
  const { sig, match } = src;
  let head = brace;
  for (let k = brace - 1; k >= 0; k--) {
    const token = sig[k];
    if (isPunct(token, ')') || isPunct(token, ']')) {
      if (match[k] === -1) { return sig[head]; }
      k = match[k];
      head = k;
      continue;
    }
    if (isPunct(token, ';') || isPunct(token, '{') || isPunct(token, '}')) { return sig[head]; }
    head = k;
  }
  return sig[head];
}

function checkNesting(ctx) {
  const { src } = ctx;
  const { sig, match } = src;
  const stack = [];
  for (let k = 0; k < sig.length; k++) {
    const token = sig[k];
    if (token.type !== T.PUNCT) { continue; }
    if (token.value === '{' && match[k] !== -1) {
      const head = statementHead(src, k);
      const control = head.type === T.WORD && CONTROL_HEADS.has(head.value);
      stack.push(control);
      const depth = stack.filter(Boolean).length;
      // A chain of `if` branches counts as one level, however long it is.
      const chained = head.value === 'else' && sig[head.si + 1]?.value === 'if';
      if (control && depth > MAX_NESTING && !chained) {
        ctx.report('PL-CF-001', {
          start: head.start,
          end: head.end,
          message: `Control flow is nested ${depth} levels deep.`,
          suggestion: 'Handle the unusual case early and return, throw or continue, so the happy path stays near the base indentation.',
          severity: 'warn',
        });
      }
      continue;
    }
    if (token.value === '}') { stack.pop(); }
  }
}

function checkElse(ctx) {
  const { src } = ctx;
  const go = src.language.name === 'go';
  for (const entry of scanElses(src)) {
    const token = src.sig[entry.elseIndex];
    if (entry.terminated) {
      ctx.report(go ? 'PL-GO-002' : 'PL-CF-002', {
        start: token.start,
        end: token.end,
        message: 'The branch before this `else` always leaves (return, throw, continue or break).',
        suggestion: 'Remove the `else` and continue with the happy path.',
        severity: 'warn',
      });
      continue;
    }
    if (!entry.elseIf || !go) {
      ctx.report('PL-CF-002', {
        start: token.start,
        end: token.end,
        message: 'Avoid `else`: Pureline prefers guard clauses.',
        suggestion: 'Invert the condition, handle that case first and return early.',
        severity: 'info',
      });
    }
  }
}

function checkBlocks(ctx) {
  const { src } = ctx;
  const ruleId = src.language.name === 'java' ? 'PL-CF-003' : 'PL-JS-001';
  for (const entry of scanControlBodies(src)) {
    if (entry.braced) { continue; }
    const keyword = src.sig[entry.keywordIndex];
    const header = src.sig[entry.headerEnd];
    ctx.report(ruleId, {
      start: keyword.start,
      end: header.end,
      message: `The body of \`${entry.keyword}\` has no braces.`,
      suggestion: 'Wrap the body in { } — the formatter does it when the end of the statement is certain.',
      severity: 'warn',
    });
  }
}

function checkSemicolons(ctx) {
  const { src, config } = ctx;
  if (!src.language.semicolons || config.semicolons === false) { return; }
  for (const change of findSemicolonChanges(src)) {
    const at = change.edits[0].start;
    ctx.report('PL-JS-002', {
      start: at - 1,
      end: at,
      message: 'Missing semicolon.',
      suggestion: 'Add `;` at the end of the statement.',
      severity: 'warn',
    });
  }
}

function checkVerticalCalls(ctx) {
  const { src, config } = ctx;
  const tabWidth = config.indent?.style === 'tab' ? 4 : (config.indent?.size ?? 4);
  for (const change of findCallChanges(src, config.printWidth ?? 120, tabWidth)) {
    const callee = src.sig[change.openIndex - 1];
    ctx.report('PL-FMT-001', {
      start: callee.start,
      end: change.end,
      message: `The arguments of \`${callee.value}(...)\` are spread over lines but fit on one.`,
      suggestion: 'Put the call on one line, or keep it vertical only when it shows meaningful structure.',
      severity: 'info',
    });
  }
}

export function checkControlFlow(ctx) {
  if (!ctx.src.language.structural) { return; }
  checkNesting(ctx);
  checkElse(ctx);
  checkBlocks(ctx);
  checkSemicolons(ctx);
  checkVerticalCalls(ctx);
}
