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
 * The Pureline checker — pure like the formatter:
 *
 *   checkPureline(text, languageId, config) -> CheckDiagnostic[]
 *
 * Diagnostics carry the stable rule id as `code` and `Pureline` as `source`.
 * Severities come from `config.rules` (`.pureline`); a rule that is `off`
 * reports nothing. A check that cannot understand the file stays silent
 * instead of guessing.
 */

import { checkComments, restatesCode } from './checks/comments.js';
import { createContext } from './checks/context.js';
import { checkControlFlow } from './checks/control-flow.js';
import { checkJava, checkJavaScript } from './checks/languages.js';
import { checkClasses, checkFunctions, checkNames } from './checks/structure.js';
import { scanCrystal } from './crystal.js';
import { resolveLanguage } from './languages.js';
import { looksLikeJsx } from './jsx.js';
import { analyze, computeLineStarts } from './source.js';

/** Checks that need real structure (matching brackets); the others work on tokens alone. */
const STRUCTURAL_CHECKS = [checkControlFlow, checkNames, checkFunctions, checkClasses, checkJavaScript, checkJava];

/** What is safe in a file with JSX: its text is not code, so statement-level checks stay out. */
const JSX_CHECKS = [checkFunctions, checkClasses, checkJavaScript];

function checkCrystal(text, language, config) {
  const lineStarts = computeLineStarts(text);
  const ctx = createContext({ language, lineStarts }, config);
  const { elses, blocks } = scanCrystal(text);
  const offsetOf = (line, column) => lineStarts[line] + column;
  for (const found of elses) {
    ctx.report('PL-CR-002', {
      start: offsetOf(found.line, found.column),
      end: offsetOf(found.line, found.column + found.length),
      message: 'Avoid `else`: Pureline prefers a guard that returns early.',
      suggestion: 'Handle the unusual case first (`return` or `return if ...`) and keep the happy path flat.',
      severity: 'info',
    });
  }
  for (const block of blocks) {
    const isType = ['class', 'module', 'struct'].includes(block.kind);
    const limit = isType ? 200 : 50;
    if (block.lines <= limit) { continue; }
    ctx.report(isType ? 'PL-STRUCT-001' : 'PL-FN-001', {
      start: offsetOf(block.line, block.column),
      end: offsetOf(block.line, block.column + block.name.length),
      message: `\`${block.name}\` is ${block.lines} lines long.`,
      suggestion: isType ? 'Classes above roughly 200 lines should be reviewed for several responsibilities.' : 'Functions over 50 lines are usually split.',
      severity: isType ? 'info' : 'warn',
    });
  }
  text.split('\n').forEach((line, index) => {
    const comment = /^\s*#(?!\{)(.*)$/.exec(line);
    if (!comment || !restatesCode(`#${comment[1]}`)) { return; }
    ctx.report('PL-DOC-001', {
      start: offsetOf(index, line.indexOf('#')),
      end: offsetOf(index, line.length),
      message: 'This comment restates what the code already says.',
      suggestion: 'Say why something unusual is necessary, or delete the comment.',
      severity: 'hint',
    });
  });
  return ctx.diagnostics;
}

/** Diagnostics for `text`, ordered by position. */
export function checkPureline(text, languageId, config) {
  const language = resolveLanguage({ languageId });
  if (!language || language.name === 'kotlin') { return []; }
  const normalized = String(text).replace(/\r\n/g, '\n');
  if (language.family === 'crystal') { return sortDiagnostics(checkCrystal(normalized, language, config)); }

  const src = analyze(normalized, language);
  const ctx = createContext(src, config);
  checkComments(ctx);
  if (src.balanced) {
    const jsx = language.jsx || looksLikeJsx(src);
    for (const check of jsx ? JSX_CHECKS : STRUCTURAL_CHECKS) {
      try {
        check(ctx);
      } catch {
        // A check that trips over unusual code must not take the others down.
      }
    }
  }
  return sortDiagnostics(ctx.diagnostics);
}

function sortDiagnostics(diagnostics) {
  return diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);
}
