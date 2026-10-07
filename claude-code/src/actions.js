/*
 * Copyright (C) 2026 ezTxmMC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of Lumen IDE. It is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version. See the LICENSE file for details.
 */

/** Session actions: compact, rewind, fork, rename, delete, export — and the checkpoints rewind offers. */

import {
  deleteSession, forkSession, getSessionInfo, getSessionMessages, renameSession,
} from '@anthropic-ai/claude-agent-sdk';
import { withIdleQuery } from './idle.js';
import { transcriptMarkdown } from './export.js';
import { runTurn } from './run.js';
import { carryCost } from './usage.js';

const CHECKPOINT_LIMIT = 40;
const LABEL_LIMIT = 70;
/** Text the CLI writes into the transcript for itself — not something the user typed. */
const INTERNAL_TEXT = /^<(local-command|system-reminder|command-)/;

function needSession(request) {
  if (!request.sessionId) {
    throw new Error('There is no conversation yet.');
  }
  return request.sessionId;
}

/** The text of a user message, or '' when it only carries tool results or internal notes. */
function userText(message) {
  const content = message.message?.content;
  const text = typeof content === 'string'
    ? content
    : (Array.isArray(content) ? content : []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
  const trimmed = text.trim();
  return INTERNAL_TEXT.test(trimmed) ? '' : trimmed;
}

const isPrompt = (message) => message.type === 'user' && !message.parent_tool_use_id && Boolean(userText(message));

/** The user's own messages, newest first — the points the conversation can return to. */
export async function checkpoints({ sessionId, cwd }) {
  if (!sessionId) {
    return [];
  }
  const messages = await getSessionMessages(sessionId, { dir: cwd }).catch(() => []);
  return messages
    .filter(isPrompt)
    .map((message) => {
      const first = userText(message).split('\n')[0];
      return { id: message.uuid, label: first.length > LABEL_LIMIT ? `${first.slice(0, LABEL_LIMIT)} …` : first };
    })
    .reverse()
    .slice(0, CHECKPOINT_LIMIT);
}

/** `/compact [what to keep]` through the normal turn; its own result card stays out of the chat. */
async function compact(request, emit) {
  needSession(request);
  const keep = String(request.argument ?? '').trim();
  const quiet = (event) => {
    if (event.kind === 'result' && !event.isError) {
      return;
    }
    emit(event);
  };
  await runTurn({ ...request, mode: request.mode || 'default', text: `/compact${keep ? ` ${keep}` : ''}`, attachments: [] }, quiet);
}

/** Puts the files back as they were before the message, and — if there was an earlier one — the conversation too, as a fork. */
async function rewind(request) {
  const sessionId = needSession(request);
  const { checkpointId, cwd, settings } = request;
  if (!checkpointId) {
    throw new Error('Choose a point to return to.');
  }
  const messages = await getSessionMessages(sessionId, { dir: cwd });
  const at = messages.findIndex((message) => message.uuid === checkpointId);
  const before = at > 0 ? messages[at - 1] : undefined;
  const result = await withIdleQuery(
    settings,
    { cwd, resume: sessionId, enableFileCheckpointing: true },
    (run) => run.rewindFiles(checkpointId),
  );
  if (!result.canRewind) {
    throw new Error(result.error || 'The files cannot be restored to that point.');
  }
  const files = result.filesChanged?.length ?? 0;
  const restored = files ? `${files} file${files === 1 ? '' : 's'} restored` : 'No files had changed';
  if (!before) {
    return { notice: `${restored}.` };
  }
  const forked = await forkSession(sessionId, { dir: cwd, upToMessageId: before.uuid });
  carryCost(sessionId, forked.sessionId);
  return { sessionId: forked.sessionId, notice: `${restored}; the conversation continues from before that message.` };
}

async function fork(request) {
  const sessionId = needSession(request);
  const title = String(request.argument ?? '').trim();
  const forked = await forkSession(sessionId, { dir: request.cwd, ...(title ? { title } : {}) });
  carryCost(sessionId, forked.sessionId);
  return { sessionId: forked.sessionId, title: title || undefined, notice: 'Forked: the conversation continues in a copy.' };
}

async function rename(request) {
  const sessionId = needSession(request);
  const title = String(request.argument ?? '').trim();
  if (!title) {
    throw new Error('A title is needed.');
  }
  await renameSession(sessionId, title, { dir: request.cwd });
  return { title };
}

async function remove(request) {
  await deleteSession(needSession(request), { dir: request.cwd });
  return { deleted: true };
}

async function exportSession(request) {
  const sessionId = needSession(request);
  const info = await getSessionInfo(sessionId, { dir: request.cwd }).catch(() => undefined);
  const title = info?.customTitle || info?.summary || `Claude Code session ${sessionId.slice(0, 8)}`;
  const messages = await getSessionMessages(sessionId, { dir: request.cwd });
  return { export: { fileName: `claude-session-${sessionId.slice(0, 8)}.md`, text: transcriptMarkdown(title, messages) } };
}

const ACTIONS = { compact, rewind, fork, rename, delete: remove, export: exportSession };

/** Carries out a session action the manifest declared. */
export async function action(request, emit) {
  const handler = ACTIONS[request.action];
  if (!handler) {
    throw new Error(`Unknown action: ${request.action}`);
  }
  return handler(request, emit);
}
