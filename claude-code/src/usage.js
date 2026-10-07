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
 * What the toolbar shows: context window, session cost, plan limits. Numbers
 * come from the SDK's messages and, after an answer, from `getContextUsage`
 * and the `/usage` data — each part optional, a failing one is skipped.
 */

const DEFAULT_WINDOW = 200_000;
const LONG_WINDOW = 1_000_000;
/** How long a control request for usage numbers may take. */
const CONTROL_TIMEOUT = 4000;

/** Session cost so far, by session id (a resumed session starts again at 0 in a new process). */
const sessionCosts = new Map();
/** Context window sizes the CLI told us, by model id. */
const windows = new Map();

const LIMIT_LABELS = {
  five_hour: '5-hour limit',
  seven_day: 'Weekly limit',
  seven_day_opus: 'Weekly Opus limit',
  seven_day_sonnet: 'Weekly Sonnet limit',
  seven_day_overage_included: 'Weekly limit (with extra usage)',
  overage: 'Extra usage',
};

/** The window of a model: reported by the CLI, else the long one for `[1m]` ids, else the usual. */
export function windowOf(model) {
  const known = windows.get(model);
  if (known) {
    return known;
  }
  return /\[1m\]/i.test(model ?? '') ? LONG_WINDOW : DEFAULT_WINDOW;
}

/** Tokens in the context after an assistant message: everything the request carried plus the answer. */
export function contextTokens(usage) {
  if (!usage) {
    return undefined;
  }
  const total = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.output_tokens ?? 0);
  return total > 0 ? total : undefined;
}

/** `usage` event after a main-thread assistant message. */
export function assistantUsage(message) {
  const model = message.message?.model;
  const contextUsed = contextTokens(message.message?.usage);
  if (!contextUsed) {
    return null;
  }
  return { kind: 'usage', contextUsed, contextTotal: windowOf(model), model };
}

/** Adds a finished answer's cost to its session and learns the window sizes. */
export function resultUsage(message) {
  for (const [model, usage] of Object.entries(message.modelUsage ?? {})) {
    if (usage.contextWindow) {
      windows.set(model, usage.contextWindow);
    }
  }
  const total = (sessionCosts.get(message.session_id) ?? 0) + (message.total_cost_usd ?? 0);
  sessionCosts.set(message.session_id, total);
  return { kind: 'usage', costUsd: total };
}

/** Gives a forked or moved session the cost of the one it came from. */
export function carryCost(fromId, toId) {
  if (fromId && toId && sessionCosts.has(fromId)) {
    sessionCosts.set(toId, sessionCosts.get(fromId));
  }
}

/** Epoch seconds or milliseconds → milliseconds. */
function toMillis(value) {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value !== 'number') {
    return undefined;
  }
  return value < 1e12 ? value * 1000 : value;
}

/** `utilization` arrives as a fraction in rate-limit events and as a percentage in the usage report. */
function percentOf(value, fraction) {
  if (typeof value !== 'number') {
    return undefined;
  }
  const percent = fraction ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** A `rate_limit_event` as one entry for the toolbar. */
export function rateLimitOf(message) {
  const info = message.rate_limit_info;
  if (!info) {
    return null;
  }
  const label = LIMIT_LABELS[info.rateLimitType] ?? 'Rate limit';
  return { label, usedPercent: percentOf(info.utilization, true), resetsAt: toMillis(info.resetsAt) };
}

/** The plan windows of the usage report as entries for the toolbar. */
export function limitsOfReport(report) {
  const limits = report?.rate_limits;
  if (!report?.rate_limits_available || !limits) {
    return [];
  }
  const entries = [];
  const add = (label, window) => {
    if (window && typeof window.utilization === 'number') {
      entries.push({ label, usedPercent: percentOf(window.utilization, false), resetsAt: toMillis(window.resets_at) });
    }
  };
  add(LIMIT_LABELS.five_hour, limits.five_hour);
  add(LIMIT_LABELS.seven_day, limits.seven_day);
  add(LIMIT_LABELS.seven_day_opus, limits.seven_day_opus);
  add(LIMIT_LABELS.seven_day_sonnet, limits.seven_day_sonnet);
  return entries;
}

/** A control request that may fail or hang: its answer, or `undefined`. */
async function attempt(request) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(undefined), CONTROL_TIMEOUT);
  });
  try {
    return await Promise.race([request().catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** After an answer: the exact context size and the plan limits, as `usage` events. */
export async function finalUsage(run, model) {
  const events = [];
  const context = await attempt(() => run.getContextUsage({ detail: 'summary' }));
  const total = context?.rawMaxTokens || context?.maxTokens;
  if (total) {
    windows.set(context.model ?? model, total);
    events.push({ kind: 'usage', contextUsed: context.totalTokens, contextTotal: total, model: context.model ?? model });
  }
  const report = await attempt(() => run.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }));
  const rateLimits = limitsOfReport(report);
  if (rateLimits.length) {
    events.push({ kind: 'usage', rateLimits });
  }
  return events;
}
