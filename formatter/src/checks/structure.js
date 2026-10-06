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
 * Names and sizes: meaningful names (PL-NAME-001), small functions with
 * clear names (PL-FN-001) and classes that stay focused (PL-STRUCT-001).
 */

import { findClasses, findDeclaredNames, findFunctions } from './declarations.js';

const FUNCTION_REVIEW_LINES = 30;
const FUNCTION_SPLIT_LINES = 50;
const CLASS_REVIEW_LINES = 200;

const VAGUE_FUNCTION_NAMES = new Set(['handleeverything', 'process', 'dostuff', 'executeall', 'handleall', 'dothings']);
const POOR_NAMES = new Set(['tmp', 'temp', 'obj', 'thing', 'stuff']);

const LOOP_COUNTERS = new Set(['i', 'j', 'k']);
const GO_IDIOMS = new Set(['ctx', 'err', 'wg', 'tx', 'conn', 'ok', 'n', 'w', 'r', 't', 'b', 'db', 'mu', 'id']);

function isAcceptableName(entry, languageName) {
  const { name, kind } = entry;
  if (name === '_' || name === '$') { return true; }
  if (name.length > 1) { return !POOR_NAMES.has(name) && !/^(?:data|value|result|item)\d+$/i.test(name); }
  if (LOOP_COUNTERS.has(name)) { return true; }
  if (name === 'e' && kind === 'catch') { return true; }
  return languageName === 'go' && GO_IDIOMS.has(name);
}

export function checkNames(ctx) {
  const { src } = ctx;
  if (src.language.family === 'crystal') { return; }
  for (const entry of findDeclaredNames(src)) {
    if (isAcceptableName(entry, src.language.name)) { continue; }
    ctx.report('PL-NAME-001', {
      start: entry.token.start,
      end: entry.token.end,
      message: `\`${entry.name}\` does not say what it holds.`,
      suggestion: 'Name it after its role — as short as possible, as explicit as necessary. Loop counters (i, j, k) are fine.',
      severity: entry.kind === 'lambda' ? 'info' : 'warn',
    });
  }
}

export function checkFunctions(ctx) {
  for (const entry of findFunctions(ctx.src)) {
    const token = entry.nameToken;
    if (VAGUE_FUNCTION_NAMES.has(entry.name.toLowerCase())) {
      ctx.report('PL-FN-001', {
        start: token.start,
        end: token.end,
        message: `\`${entry.name}\` is a vague name for a function.`,
        suggestion: 'Name the one action it performs, like validateRequest() or sendPacket().',
        severity: 'warn',
      });
    }
    if (entry.lines > FUNCTION_SPLIT_LINES) {
      ctx.report('PL-FN-001', {
        start: token.start,
        end: token.end,
        message: `\`${entry.name}\` is ${entry.lines} lines long; functions over ${FUNCTION_SPLIT_LINES} lines are usually split.`,
        suggestion: 'Extract the steps into functions that each do one clearly named thing.',
        severity: 'warn',
      });
      continue;
    }
    if (entry.lines > FUNCTION_REVIEW_LINES) {
      ctx.report('PL-FN-001', {
        start: token.start,
        end: token.end,
        message: `\`${entry.name}\` is ${entry.lines} lines long; worth a review.`,
        suggestion: 'Functions of about 30 to 50 lines are worth a look: does it do one thing?',
        severity: 'info',
      });
    }
  }
}

export function checkClasses(ctx) {
  for (const entry of findClasses(ctx.src)) {
    if (entry.lines <= CLASS_REVIEW_LINES) { continue; }
    ctx.report('PL-STRUCT-001', {
      start: entry.nameToken.start,
      end: entry.nameToken.end,
      message: `\`${entry.name}\` is ${entry.lines} lines long; classes above roughly ${CLASS_REVIEW_LINES} lines should be reviewed for several responsibilities.`,
      suggestion: 'Look for groups of members that belong together and move them into their own type.',
      severity: 'info',
    });
  }
}
