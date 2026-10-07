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
 * Short-lived `claude` processes that are asked something without sending a
 * message: the model list, the MCP status, a file rewind.
 */

import os from 'node:os';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { envFrom, settingSources } from './settings.js';
import { findClaude } from './program.js';

/** How long `claude` may take to answer a control request. */
export const IDLE_TIMEOUT = 30_000;

/** A stream that never sends a message: `claude` starts, answers control requests, and waits. */
async function* idle(signal) {
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
}

/** The options every idle process shares; `extra` adds to them (resume, MCP servers …). */
function idleOptions(settings, abort, extra) {
  const env = envFrom(settings.env);
  return {
    cwd: os.homedir(),
    abortController: abort,
    pathToClaudeCodeExecutable: findClaude(settings.claudePath),
    settingSources: settingSources(settings),
    persistSession: false,
    ...(Object.keys(env).length ? { env: { ...process.env, ...env } } : {}),
    ...extra,
  };
}

/** Runs `ask(run)` against an idle `claude` and tears it down afterwards. */
export async function withIdleQuery(settings, extra, ask) {
  const abort = new AbortController();
  const run = query({ prompt: idle(abort.signal), options: idleOptions(settings, abort, extra) });
  // Nobody reads the messages; an abort must not surface as an unhandled rejection.
  const drained = (async () => {
    for await (const _message of run) { /* nothing to show */ }
  })().catch(() => {});
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('claude did not answer in time')), IDLE_TIMEOUT);
  });
  try {
    return await Promise.race([ask(run), timeout]);
  } finally {
    clearTimeout(timer);
    abort.abort();
    run.close();
    await drained;
  }
}
