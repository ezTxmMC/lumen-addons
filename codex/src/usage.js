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
 * The `usage` and `notice` events: context meter, rate limits and the lines
 * that say how this session runs. Codex prints no prices, so there is no cost.
 */

import { contextWindowOf } from './models.js';
import { approvalFor } from './settings.js';
import { liveNumbers } from './sessions.js';
import { isOn } from './util.js';

/** `300` minutes as `5 h`, `10080` as `week`. */
export function windowLabel(minutes) {
  if (!minutes) {
    return 'limit';
  }
  if (minutes % 10080 === 0) {
    return minutes === 10080 ? 'week' : `${minutes / 10080} weeks`;
  }
  if (minutes % 1440 === 0) {
    return minutes === 43200 ? 'month' : `${minutes / 1440} d`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60} h`;
  }
  return `${minutes} min`;
}

function rateLimitsOf(limits) {
  return ['primary', 'secondary']
    .map((key) => limits?.[key])
    .filter(Boolean)
    .map((entry) => ({
      label: windowLabel(entry.window_minutes),
      usedPercent: typeof entry.used_percent === 'number' ? Math.min(100, Math.max(0, entry.used_percent)) : undefined,
      resetsAt: entry.resets_at ? entry.resets_at * 1000 : undefined,
    }));
}

/**
 * The toolbar numbers after a turn: Codex's own `token_count` record when it
 * can be read, else what the turn's usage says against the model cache.
 */
export async function usageEvent({ sessionId, model, mode, turn }) {
  const live = sessionId ? await liveNumbers(sessionId).catch(() => null) : null;
  const total = live?.contextTotal || await contextWindowOf(model).catch(() => 0);
  const used = live?.contextUsed ?? ((turn?.input_tokens ?? 0) + (turn?.output_tokens ?? 0) || undefined);
  const event = { kind: 'usage', model: model || undefined, mode };
  if (used) {
    event.contextUsed = used;
  }
  if (total) {
    event.contextTotal = total;
  }
  const limits = rateLimitsOf(live?.limits);
  if (limits.length) {
    event.rateLimits = limits;
  }
  return event;
}

/** What the sandbox and approvals are for this session: one `notice` when a session starts. */
export function startNotices(request) {
  const { mode, settings } = request;
  const parts = [`sandbox ${mode}`];
  const approval = approvalFor(mode, settings);
  parts.push(`approvals ${approval || 'as in config.toml'}`);
  if (mode === 'workspace-write' && settings.networkAccess && settings.networkAccess !== 'auto') {
    parts.push(`network ${settings.networkAccess === 'true' ? 'allowed' : 'blocked'}`);
  }
  const notices = [{ kind: 'notice', level: 'info', text: `Codex runs with ${parts.join(' · ')}.` }];
  if (mode === 'danger-full-access') {
    notices.push({ kind: 'notice', level: 'warn', text: 'No sandbox: Codex can change any file and run any command.' });
  }
  if (isOn(settings.hideReasoning) || settings.reasoningSummary === 'none') {
    notices.push({ kind: 'notice', level: 'info', text: 'Reasoning summaries are switched off.' });
  }
  if (isOn(settings.ephemeral)) {
    notices.push({ kind: 'notice', level: 'warn', text: 'Ephemeral session: Codex keeps no session file, so it cannot be resumed later.' });
  }
  return notices;
}

/** A stderr line worth showing: warnings only, never the log noise of MCP transports. */
export function warningFrom(line) {
  const text = line.replace(/^\S+Z\s+/, '').trim();
  if (!/^WARN\b/.test(text) || /rmcp::/.test(text)) {
    return null;
  }
  return { kind: 'notice', level: 'warn', text: text.replace(/^WARN\s+/, '').slice(0, 300) };
}
