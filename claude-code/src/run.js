/*
 * Copyright (C) 2026 ezTxmMC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of Lumen IDE. It is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version. See the LICENSE file for details.
 */

/** One message to Claude and everything that streams back from it. */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { toSlashCommands } from './commands.js';
import { hooksOption } from './hooks.js';
import { optionsFor } from './options.js';
import { permissionHandler, settleChat } from './permissions.js';
import { promptOf } from './prompt.js';
import { hookSpecsFrom } from './settings.js';
import { createTranslator } from './translate.js';
import { finalUsage } from './usage.js';

/** Runs by chat id: the running query's abort controller. */
const runs = new Map();

function deferred() {
  let resolve = () => {};
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** After `init`: the rich slash command list, as a second `session` event. */
function announceCommands(stream, init, emit) {
  stream.supportedCommands()
    .then((commands) => emit({
      kind: 'session', sessionId: init.session_id, model: init.model,
      slashCommands: toSlashCommands(commands, init),
    }))
    .catch(() => {});
}

/**
 * Sends `request.text` to Claude and emits what comes back. The prompt
 * stream stays open until the answer is complete and its usage numbers are
 * in, then closes so `claude` can end.
 */
export async function runTurn(request, emit) {
  const { chatId, text, attachments } = request;
  if (runs.has(chatId)) {
    throw new Error('Claude is still answering');
  }
  const abort = new AbortController();
  const gate = deferred();
  const translate = createTranslator();
  const hooks = hooksOption(hookSpecsFrom(request.settings.hooks), { cwd: request.cwd, emit });
  const options = optionsFor(request, { abort, canUseTool: permissionHandler(chatId, emit), hooks });
  const stream = query({ prompt: promptOf(text, attachments, gate.promise), options });
  runs.set(chatId, abort);
  let model = request.model;
  try {
    for await (const message of stream) {
      for (const event of translate(message)) {
        emit(event);
      }
      if (message.type === 'system' && message.subtype === 'init') {
        model = message.model;
        announceCommands(stream, message, emit);
      }
      if (message.type === 'result') {
        for (const event of await finalUsage(stream, model)) {
          emit(event);
        }
        gate.resolve();
      }
    }
  } catch (err) {
    if (!abort.signal.aborted) {
      throw err;
    }
  } finally {
    gate.resolve();
    settleChat(chatId);
    runs.delete(chatId);
  }
}

export function interruptRun(chatId) {
  const abort = runs.get(chatId);
  if (!abort) {
    return;
  }
  settleChat(chatId);
  abort.abort();
}

export function abortAllRuns() {
  for (const abort of runs.values()) {
    abort.abort();
  }
}
