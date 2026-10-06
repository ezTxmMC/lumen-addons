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
 * What every check receives: the analysed source and `report`, which turns a
 * finding into a diagnostic — with the severity from `.pureline`, and never
 * for a rule that is `off` or that does not apply to the language.
 */

import { levelOf, ruleById, toCheckSeverity } from '../rules.js';
import { positionOf } from '../source.js';

export function createContext(src, config) {
  const diagnostics = [];
  const seen = new Set();

  const applies = (ruleId) => {
    const rule = ruleById(ruleId);
    if (!rule) { return false; }
    return levelOf(config, ruleId) !== 'off' && rule.languages.includes(src.language.name);
  };

  /**
   * `finding`: `{ start, end?, message, suggestion?, severity? }` with offsets
   * into the text; `severity` is the default level (`warn`, `info` ...) unless
   * the project's `.pureline` sets one for the rule.
   */
  const report = (ruleId, finding) => {
    if (!applies(ruleId)) { return; }
    const begin = positionOf(src.lineStarts, finding.start);
    const stop = positionOf(src.lineStarts, finding.end ?? finding.start + 1);
    const key = `${ruleId}:${begin.line}:${begin.column}:${finding.message}`;
    if (seen.has(key)) { return; }
    seen.add(key);
    const configured = config?.rules?.[ruleId];
    const level = configured ?? finding.severity ?? ruleById(ruleId).severity;
    diagnostics.push({
      line: begin.line,
      column: begin.column,
      endLine: stop.line,
      endColumn: stop.column,
      severity: toCheckSeverity(level),
      message: finding.message,
      code: ruleId,
      source: 'Pureline',
      ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
    });
  };

  return { src, config, diagnostics, report, applies };
}
