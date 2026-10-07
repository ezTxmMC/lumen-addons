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
 * Session actions (`capabilities` of the manifest). Each uses a documented
 * `codex` command where there is one:
 *
 *   fork    `codex exec fork <id>` — a new session with the old history
 *   delete  `codex delete --force <id>`
 *   rename  kept by the add-on (Codex's exec mode has no rename), shown in the history
 *   export  the session's rollout file as Markdown
 *
 * `compact` and `rewind` are not offered: exec mode has no compaction command
 * (Codex compacts by itself near the context limit) and no checkpoints.
 */

import { exportMarkdown, forgetSession, renameSession, renamedTitle, titleOf } from './sessions.js';
import { forkArgs } from './settings.js';
import { runCodex } from './util.js';

function needSession(request) {
  if (!request.sessionId) {
    throw new Error('This chat has no Codex session yet — send a message first.');
  }
  return request.sessionId;
}

const slug = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'session';

async function fork(request, emit) {
  const sessionId = needSession(request);
  emit({ kind: 'status', text: 'Forking the session …' });
  const settings = { ...request.settings, ephemeral: 'false' };
  const args = forkArgs({ ...request, settings, mode: request.mode || 'workspace-write', sessionId });
  const result = await runCodex(settings, args, { cwd: request.cwd, timeout: 60_000 });
  const started = result.stdout.split('\n').map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).find((event) => event?.type === 'thread.started');
  if (!started?.thread_id) {
    throw new Error(result.stderr.trim().split('\n').slice(-3).join('\n') || 'codex did not report the forked session');
  }
  const title = await titleOf(sessionId);
  return { sessionId: started.thread_id, title: title ? `${title} (fork)` : undefined, notice: 'Continuing in a fork of the session.' };
}

async function remove(request) {
  const sessionId = needSession(request);
  const result = await runCodex(request.settings, ['delete', '--force', sessionId], { cwd: request.cwd });
  if (result.code !== 0) {
    throw new Error(`${result.stdout}${result.stderr}`.trim().split('\n').slice(-2).join('\n') || 'codex could not delete the session');
  }
  forgetSession(sessionId);
  return { deleted: true, notice: 'Session deleted.' };
}

function rename(request) {
  const sessionId = needSession(request);
  const title = String(request.argument ?? '').trim();
  renameSession(sessionId, title);
  return { title: title || undefined };
}

async function exportSession(request) {
  const sessionId = needSession(request);
  const title = await titleOf(sessionId);
  const text = await exportMarkdown(sessionId, title);
  if (text === null) {
    throw new Error('Codex keeps no session file for this chat (ephemeral session, or not written yet).');
  }
  return { export: { fileName: `codex-${slug(renamedTitle(sessionId) || title || sessionId)}.md`, text } };
}

const ACTIONS = { fork, delete: remove, rename, export: exportSession };

export async function runAction(request, emit) {
  const handler = ACTIONS[request.action];
  if (!handler) {
    throw new Error(`Codex does not support “${request.action}” in exec mode.`);
  }
  return handler(request, emit);
}
