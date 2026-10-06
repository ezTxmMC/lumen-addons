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
 * PL-DOC-001: a comment that only repeats the next line of code ("Check if
 * the player exists") says nothing the code does not. Detected by the verbs
 * such comments start with, so it stays a hint.
 */

import { T } from '../tokenizer.js';

const RESTATING_START = /^(?:check(?:s|ing)?\s+(?:if|whether|that)|get(?:s)?\s+the|set(?:s)?\s+the|return(?:s)?\s+the|create(?:s)?\s+(?:a|an|the)\s+new|loop(?:s)?\s+(?:through|over)|iterate(?:s)?\s+(?:through|over)|increment(?:s)?\b|decrement(?:s)?\b|initiali[sz]e(?:s)?\s+(?:the|a)|call(?:s)?\s+the|define(?:s)?\s+(?:a|the)|declare(?:s)?\s+(?:a|the)|if\s+the\b)/i;

export function restatesCode(commentText) {
  const text = commentText.replace(/^\s*(?:\/\/+|#+|\/\*+|\*+)\s*/, '').replace(/\s*\*\/\s*$/, '').trim();
  if (text.length < 8 || text.includes('\n')) { return false; }
  return RESTATING_START.test(text);
}

export function checkComments(ctx) {
  for (const token of ctx.src.tokens) {
    if (token.type !== T.COMMENT || !restatesCode(token.value)) { continue; }
    ctx.report('PL-DOC-001', {
      start: token.start,
      end: token.end,
      message: 'This comment restates what the code already says.',
      suggestion: 'Say why something unusual is necessary, or delete the comment.',
      severity: 'hint',
    });
  }
}
