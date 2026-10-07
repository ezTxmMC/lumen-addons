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
 * Codex's own session files: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
 * (one JSON record per line) and `~/.codex/session_index.jsonl` (the names
 * Codex gives threads). Listing, titles and the live numbers read them; the
 * file format is Codex's own and not a documented interface, so every reader
 * here tolerates what it does not understand.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { codexHome } from './util.js';

/** How many recent session files the history looks through. */
const SESSION_SCAN_LIMIT = 300;
const TAIL_BYTES = 512 * 1024;
const TITLES_KEY = 'sessionTitles';

let storage = null;
/** Rollout path by session id, so a file is searched for once. */
const known = new Map();

export const useStorage = (value) => {
  storage = value;
};

const sessionsRoot = () => path.join(codexHome(), 'sessions');

async function walkRollouts(dir, depth, found) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth < 3) {
      await walkRollouts(full, depth + 1, found);
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      found.push(full);
    }
  }
}

async function rolloutFiles() {
  const found = [];
  await walkRollouts(sessionsRoot(), 0, found);
  // The file names carry the start time, so sorting them sorts by age.
  return found.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
}

/** The rollout file of a session, or `''`. */
export async function rolloutOf(sessionId) {
  if (!sessionId) {
    return '';
  }
  const cached = known.get(sessionId);
  if (cached && fs.existsSync(cached)) {
    return cached;
  }
  const match = (await rolloutFiles()).find((file) => file.endsWith(`-${sessionId}.jsonl`));
  if (match) {
    known.set(sessionId, match);
  }
  return match ?? '';
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** The text of a message record's content parts. */
function partsText(payload) {
  if (!Array.isArray(payload.content)) {
    return '';
  }
  return payload.content.map((part) => part.text ?? '').join(' ').trim();
}

/** The text of the first real user message in a rollout line, if it is one. */
function userText(record) {
  const payload = record?.payload ?? record;
  if (payload?.type === 'user_message' && typeof payload.message === 'string') {
    return payload.message;
  }
  if (payload?.type !== 'message' || payload.role !== 'user') {
    return '';
  }
  const text = partsText(payload);
  // Codex puts the environment and AGENTS.md in front as user messages of their own.
  return text.startsWith('<') ? '' : text;
}

/** The session id, folder and first prompt of one rollout file. */
async function readRollout(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8', end: 256 * 1024 });
  const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const info = { id: '', cwd: '', title: '' };
  try {
    for await (const line of reader) {
      const record = parseLine(line);
      const payload = record?.payload ?? {};
      if (!info.id && (record?.type === 'session_meta' || payload.id) && typeof payload.id === 'string') {
        info.id = payload.id;
        info.cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
      }
      info.title ||= userText(record);
      if (info.id && info.title) {
        break;
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }
  return info;
}

/** The names Codex keeps in `session_index.jsonl` (the last entry of an id wins). */
async function indexedNames() {
  const content = await fsp.readFile(path.join(codexHome(), 'session_index.jsonl'), 'utf8').catch(() => '');
  const names = new Map();
  for (const line of content.split('\n')) {
    const entry = parseLine(line);
    if (entry?.id && entry.thread_name) {
      names.set(entry.id, entry.thread_name);
    }
  }
  return names;
}

const savedTitles = () => storage?.get(TITLES_KEY, {}) ?? {};

/** The title the user gave a session in Lumen. */
export const renamedTitle = (sessionId) => savedTitles()[sessionId] ?? '';

export function renameSession(sessionId, title) {
  const titles = { ...savedTitles() };
  if (title) {
    titles[sessionId] = title;
  }
  if (!title) {
    delete titles[sessionId];
  }
  storage?.set(TITLES_KEY, titles);
}

export function forgetSession(sessionId) {
  known.delete(sessionId);
  renameSession(sessionId, '');
}

export async function listSessions(cwd) {
  const files = (await rolloutFiles()).slice(0, SESSION_SCAN_LIMIT);
  const names = await indexedNames();
  const own = savedTitles();
  const sessions = [];
  for (const file of files) {
    const info = await readRollout(file).catch(() => null);
    if (!info?.id || path.resolve(info.cwd || '/') !== path.resolve(cwd)) {
      continue;
    }
    const stat = await fsp.stat(file).catch(() => null);
    const title = own[info.id] || names.get(info.id) || info.title || info.id;
    sessions.push({ id: info.id, title: title.split('\n')[0].slice(0, 80), updatedAt: stat?.mtimeMs });
    if (sessions.length >= 40) {
      break;
    }
  }
  return sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** The title of one session, as the history would show it. */
export async function titleOf(sessionId) {
  if (renamedTitle(sessionId)) {
    return renamedTitle(sessionId);
  }
  return (await indexedNames()).get(sessionId) ?? '';
}

/* ------------------------------------------------------------------ *
 * Live numbers: the last `token_count` record of the rollout
 * ------------------------------------------------------------------ */

async function tailOf(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const rows = buffer.toString('utf8').split('\n');
    return start > 0 ? rows.slice(1) : rows;
  } finally {
    await handle.close();
  }
}

const hasLimits = (limits) => Boolean(limits?.primary || limits?.secondary);

/** `{ contextUsed, contextTotal, limits }` from the newest `token_count` records of a session, or `null`. */
export async function liveNumbers(sessionId) {
  const file = await rolloutOf(sessionId);
  if (!file) {
    return null;
  }
  const rows = await tailOf(file).catch(() => []);
  let numbers = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const payload = parseLine(rows[i])?.payload;
    if (payload?.type !== 'token_count' || !payload.info) {
      continue;
    }
    numbers ??= { contextUsed: payload.info.last_token_usage?.total_tokens, contextTotal: payload.info.model_context_window };
    if (hasLimits(payload.rate_limits)) {
      return { ...numbers, limits: payload.rate_limits };
    }
  }
  return numbers;
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

function messageOf(record) {
  const payload = record?.payload;
  if (record?.type !== 'response_item' || payload?.type !== 'message') {
    return null;
  }
  if (payload.role !== 'user' && payload.role !== 'assistant') {
    return null;
  }
  const text = partsText(payload);
  if (!text || (payload.role === 'user' && text.startsWith('<'))) {
    return null;
  }
  return { role: payload.role, text };
}

/** The conversation of a rollout as `{ role, text }` entries. */
async function transcriptOf(file) {
  const reader = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const messages = [];
  for await (const line of reader) {
    const message = messageOf(parseLine(line));
    if (message) {
      messages.push(message);
    }
  }
  return messages;
}

/** The session as a Markdown transcript, or `null` when there is no file. */
export async function exportMarkdown(sessionId, title) {
  const file = await rolloutOf(sessionId);
  if (!file) {
    return null;
  }
  const messages = await transcriptOf(file);
  const heading = `# ${title || `Codex session ${sessionId}`}`;
  const body = messages.map((entry) => `## ${entry.role === 'user' ? 'You' : 'Codex'}\n\n${entry.text}`);
  return [heading, `Session \`${sessionId}\``, ...body].join('\n\n') + '\n';
}
