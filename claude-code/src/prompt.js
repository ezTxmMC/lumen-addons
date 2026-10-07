/*
 * Copyright (C) 2026 ezTxmMC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of Lumen IDE. It is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version. See the LICENSE file for details.
 */

/** The user's message as the SDK's streaming input. */

import { randomUUID } from 'node:crypto';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** `/name args` is a slash command: Claude Code only runs it when the text leads the message. */
export const isSlash = (text) => /^\/[^\s/]+/.test(text.trim());

/** Pasted images as content blocks; project files as a mention in the text. */
export function contentOf(text, attachments = []) {
  const images = attachments.filter((entry) => entry.data && IMAGE_TYPES.has(entry.mimeType));
  const files = attachments.filter((entry) => entry.path);
  const mentions = files.map((entry) => `@${entry.path}`).join(' ');
  const body = mentions ? `${text}\n\n${mentions}` : text;
  if (!images.length) {
    // A plain string: the form in which `/command args` reaches claude as a slash command.
    return body;
  }
  const blocks = images.map((entry) => ({ type: 'image', source: { type: 'base64', media_type: entry.mimeType, data: entry.data } }));
  const textBlock = { type: 'text', text: body };
  if (isSlash(body)) {
    return [textBlock, ...blocks];
  }
  return [...blocks, textBlock];
}

/**
 * One user message as streaming input. The stream stays open until `gate`
 * settles, so control requests (context usage, plan limits) still work after
 * the answer. The message gets an id of its own: it is the checkpoint a
 * later rewind returns to.
 */
export async function* promptOf(text, attachments, gate) {
  yield {
    type: 'user',
    uuid: randomUUID(),
    message: { role: 'user', content: contentOf(text, attachments) },
    parent_tool_use_id: null,
  };
  await gate;
}
