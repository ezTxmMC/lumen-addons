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
 * ChatGPT Codex as an agent in Lumen.
 *
 * Lumen loads this bundle into its main process (after the user approved it)
 * and calls `activate`. Each message runs the installed `codex` program in its
 * non-interactive JSON mode — `codex exec --experimental-json`, the prompt on
 * standard input — exactly as OpenAI's own TypeScript SDK does, and turns the
 * JSON lines it prints into Lumen's agent events. A conversation continues
 * with `codex exec … resume <thread id>`.
 *
 * `codex exec` does not ask before acting: what Codex may do is set by the
 * sandbox. The panel's modes therefore are sandbox levels — read only, write
 * inside the project, or full access (which has to be allowed in the
 * settings first).
 *
 * The parts live in `src/`: `settings` builds the command line, `translate`
 * turns Codex's events into Lumen's, `commands` and `prompts` are the slash
 * commands, `sessions` and `actions` the history and its actions, `models` the
 * model list, `usage` the context meter and notices.
 *
 * This bundle does not carry the `codex` binary; it starts the one installed.
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { runAction } from './src/actions.js';
import { resolveSlash, slashCommands } from './src/commands.js';
import { extraModels, listModels } from './src/models.js';
import { listSessions, useStorage } from './src/sessions.js';
import { argsFor, instructionsOf, overridesOf, promptWith } from './src/settings.js';
import { translate } from './src/translate.js';
import { startNotices, usageEvent, warningFrom } from './src/usage.js';
import { envFrom, findCodex } from './src/util.js';

const IMAGE_EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
const MAX_WARNINGS = 3;
/** What every `session` event adds: the session actions this add-on carries out, and the usage meter. */
const CAPABILITIES = { fork: true, rename: true, delete: true, export: true, usage: true };

/** Runs by chat id: the running process. */
const runs = new Map();

/* ------------------------------------------------------------------ *
 * Attachments
 * ------------------------------------------------------------------ */

/** Pasted images go to temporary files — `codex` takes image paths. */
async function imageFiles(attachments = []) {
  const files = [];
  let dir = null;
  for (const entry of attachments) {
    if (entry.path && /\.(png|jpe?g|gif|webp)$/i.test(entry.path)) {
      files.push(entry.path);
      continue;
    }
    const extension = IMAGE_EXTENSIONS[entry.mimeType];
    if (!entry.data || !extension) {
      continue;
    }
    dir ??= await fsp.mkdtemp(path.join(os.tmpdir(), 'lumen-codex-'));
    const file = path.join(dir, `image-${files.length + 1}${extension}`);
    await fsp.writeFile(file, Buffer.from(entry.data, 'base64'));
    files.push(file);
  }
  return { files, cleanup: () => (dir ? fsp.rm(dir, { recursive: true, force: true }) : Promise.resolve()) };
}

/* ------------------------------------------------------------------ *
 * One turn
 * ------------------------------------------------------------------ */

/** Reads stderr line by line: warnings become notices (a few), the rest is kept for an error message. */
function watchStderr(child, emit) {
  const tail = [];
  const seen = new Set();
  const reader = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
  reader.on('line', (line) => {
    tail.push(line);
    const notice = seen.size < MAX_WARNINGS ? warningFrom(line) : null;
    if (notice && !seen.has(notice.text)) {
      seen.add(notice.text);
      emit(notice);
    }
  });
  return () => tail.slice(-12).join('\n').trim();
}

/** What the config overrides setting got wrong, as one warning. */
function overrideWarning(settings) {
  const { invalid } = overridesOf(settings.configOverrides);
  if (!invalid.length) {
    return null;
  }
  return { kind: 'notice', level: 'warn', text: `Ignored lines in “More configuration (-c)” (use key=value): ${invalid.join(', ')}` };
}

function contextOf(request) {
  const { cwd, mode, settings } = request;
  return {
    cwd,
    mode,
    model: request.model || settings.model || undefined,
    startedAt: Date.now(),
    sessionId: request.sessionId,
    sessionExtras: { capabilities: CAPABILITIES },
  };
}

/** The events one JSON line stands for; the first `session` event of a chat also carries notices and commands. */
async function eventsOf(event, context, request) {
  const bodies = translate(event, context);
  const out = [];
  for (const body of bodies) {
    out.push(body);
    if (body.kind === 'session') {
      context.sessionId = body.sessionId;
      out.push(...(request.sessionId ? [] : startNotices(request)));
    }
  }
  if (event.type === 'turn.completed') {
    out.push(await usageEvent({ sessionId: context.sessionId, model: context.model, mode: context.mode, turn: event.usage }));
  }
  return out;
}

/** Run one turn: start `codex`, stream its JSON lines, report its exit. */
async function runTurn(request, emit, plan) {
  const { chatId, attachments, settings } = request;
  const executable = findCodex(settings.codexPath);
  const images = await imageFiles(attachments);
  const context = contextOf(request);
  context.sessionExtras.slashCommands = await slashCommands(request.cwd).catch(() => []);
  const child = spawn(executable, argsFor(request, images.files, plan.sub), {
    cwd: request.cwd,
    env: { ...process.env, ...envFrom(settings.env) },
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  const run = { child, stopped: false };
  runs.set(chatId, run);
  const stderrTail = watchStderr(child, emit);
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  // A failed start is reported after the output is read; keep it from counting as unhandled until then.
  exited.catch(() => {});
  // A program that exits before reading its input must not crash the host with EPIPE.
  child.stdin?.on('error', () => {});
  const instructions = settings.instructionsVia === 'prompt' ? instructionsOf(request) : '';
  child.stdin?.end(plan.sub ? '' : promptWith(plan.text, attachments, instructions));

  try {
    const warning = overrideWarning(settings);
    if (warning) {
      emit(warning);
    }
    const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    for await (const line of reader) {
      const event = parseJson(line);
      for (const body of event ? await eventsOf(event, context, request) : []) {
        emit(body);
      }
    }
    const { code, signal } = await exited;
    if (run.stopped || (code === 0 && !signal)) {
      return;
    }
    const detail = stderrTail();
    throw new Error(`codex exited with ${signal ? `signal ${signal}` : `code ${code}`}${detail ? `:\n${detail}` : ''}`);
  } finally {
    runs.delete(chatId);
    await images.cleanup().catch(() => {});
  }
}

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Turns a message into what runs: a plain turn, a review, or only a notice. */
async function planOf(request, emit) {
  const slash = await resolveSlash(request);
  if (!slash) {
    return { text: request.text };
  }
  if (slash.kind === 'notice') {
    emit({ kind: 'notice', level: 'info', text: slash.text });
    return null;
  }
  if (slash.kind === 'review') {
    return { sub: { kind: 'review', target: slash.target, prompt: slash.prompt } };
  }
  return { text: slash.text };
}

const provider = {
  async send(request, emit) {
    if (runs.has(request.chatId)) {
      throw new Error('Codex is still answering');
    }
    const plan = await planOf(request, emit);
    if (!plan) {
      return;
    }
    await runTurn(request, emit, plan);
  },

  /** `codex exec` never asks — there is nothing to answer. */
  answer() {
    return false;
  },

  interrupt(chatId) {
    const run = runs.get(chatId);
    if (!run) {
      return;
    }
    run.stopped = true;
    run.child.kill('SIGTERM');
    setTimeout(() => {
      if (run.child.exitCode === null && run.child.signalCode === null) {
        run.child.kill('SIGKILL');
      }
    }, 3000);
  },

  sessions: (cwd) => listSessions(cwd),

  action: (request, emit) => runAction(request, emit),

  models: (options) => listModels(options).catch((err) => {
    console.warn('[codex] could not list models:', err.message);
    return extraModels(options?.settings?.extraModels);
  }),
};

export function activate(ctx) {
  useStorage(ctx.storage);
  ctx.agents.register('codex', provider);
  return () => {
    for (const run of runs.values()) {
      run.stopped = true;
      run.child.kill('SIGTERM');
    }
  };
}
