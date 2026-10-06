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
 * Text edits and "changes". A change is one self-contained rewrite — for
 * example wrapping one statement in braces: several edits that only make
 * sense together. Changes are applied all or not at all, which is what keeps
 * a range format from ever leaving a half-moved `else` behind.
 *
 *   change = { start, end, edits: [{ start, end, text, tie? }] }
 *
 * `start`/`end` is the extent of the code the change rewrites; a range
 * request applies exactly the changes whose extent touches the selection.
 */

function lengthDelta(edit) {
  return edit.text.length - (edit.end - edit.start);
}

function overlaps(a, b) {
  if (a.start === a.end || b.start === b.end) {
    const insert = a.start === a.end ? a : b;
    const other = insert === a ? b : a;
    return other.start < insert.start && insert.start < other.end;
  }
  return a.start < b.end && b.start < a.end;
}

function sortEdits(edits) {
  return [...edits].sort((a, b) => a.start - b.start || a.end - b.end || (a.tie ?? 0) - (b.tie ?? 0));
}

/** Drops (whole) changes whose edits collide with an earlier change's edits. */
function resolveConflicts(changes) {
  const accepted = [];
  for (const change of changes) {
    const clash = accepted.some((other) => other.edits.some((a) => change.edits.some((b) => overlaps(a, b))));
    if (clash) { continue; }
    accepted.push(change);
  }
  return accepted;
}

/**
 * Applies the changes to `text`. Returns the new text, the changes that were
 * applied and `map(offset, bias)` which translates an offset of the old text
 * into the new one (`bias` decides on which side of an insertion it lands).
 */
export function applyChanges(text, changes) {
  const applied = resolveConflicts(changes);
  const edits = sortEdits(applied.flatMap((change) => change.edits));
  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    out += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  out += text.slice(cursor);

  const map = (offset, bias = 'left') => {
    let delta = 0;
    for (const edit of edits) {
      const insertion = edit.start === edit.end;
      if (edit.end < offset || (edit.end === offset && (!insertion || bias === 'right'))) {
        delta += lengthDelta(edit);
        continue;
      }
      if (edit.start >= offset) { break; }
      return edit.start + delta + (bias === 'right' ? edit.text.length : 0);
    }
    return offset + delta;
  };
  return { text: out, applied, map };
}

/** Whether a change extent touches the selected range (`null` = everything). */
export function touchesRange(change, range) {
  if (!range) { return true; }
  if (range.from === range.to) { return change.start <= range.from && range.from <= change.end; }
  return change.start < range.to && range.from < change.end;
}

/**
 * Runs one stage: keeps the changes that touch the range, widens the range so
 * it covers them completely, applies them and moves the range into the new
 * text. Without a range every change is applied.
 */
export function runChanges(text, changes, range) {
  const wanted = changes.filter((change) => touchesRange(change, range));
  if (!wanted.length) { return { text, range, count: 0 }; }
  let widened = range;
  if (range) {
    widened = {
      from: Math.min(range.from, ...wanted.map((change) => change.start)),
      to: Math.max(range.to, ...wanted.map((change) => change.end)),
    };
  }
  const result = applyChanges(text, wanted);
  if (!widened) { return { text: result.text, range: null, count: result.applied.length }; }
  return {
    text: result.text,
    range: { from: result.map(widened.from, 'left'), to: result.map(widened.to, 'right') },
    count: result.applied.length,
  };
}
