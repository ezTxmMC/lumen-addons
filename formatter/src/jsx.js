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
 * JSX is not understood by the tokenizer (its text is not code), so a file
 * that contains it only gets the whitespace fixes. This finds such files.
 */

import { isPunct } from './source.js';
import { T } from './tokenizer.js';

/** Tokens after which `<` begins an element rather than a comparison or a generic. */
const ELEMENT_PREDECESSORS = new Set(['(', '=', '=>', '?', ':', '&&', '||', ',', '[', '{', '??']);

/**
 * Does the JavaScript source contain JSX? TypeScript outside `.tsx` cannot,
 * so only JavaScript is inspected (`.tsx`/`.jsx` are flagged by the language).
 */
export function looksLikeJsx(src) {
  if (src.language.name !== 'javascript') { return false; }
  const { sig, text } = src;
  for (let k = 0; k < sig.length - 1; k++) {
    if (!isPunct(sig[k], '<')) { continue; }
    const before = sig[k - 1];
    const startsExpression = !before
      || (before.type === T.PUNCT && ELEMENT_PREDECESSORS.has(before.value))
      || (before.type === T.WORD && before.value === 'return');
    const next = sig[k + 1];
    const tag = next.type === T.WORD && next.start === sig[k].end;
    const fragment = isPunct(next, '>') && next.start === sig[k].end;
    if (startsExpression && (tag || fragment) && /<\/|\/>/.test(text.slice(sig[k].start))) { return true; }
  }
  return false;
}
