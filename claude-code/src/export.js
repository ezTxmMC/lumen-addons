/*
 * Copyright (C) 2026 ezTxmMC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of Lumen IDE. It is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version. See the LICENSE file for details.
 */

/** A session's transcript as Markdown, for the “export” action. */

const TOOL_RESULT_LIMIT = 2000;
const INPUT_LIMIT = 1200;

function clip(text, limit) {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`;
}

const fence = (text, lang = '') => `\`\`\`${lang}\n${text.replace(/```/g, '`` `')}\n\`\`\``;

function resultText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.map((block) => (block.type === 'text' ? block.text ?? '' : `[${block.type}]`)).join('\n');
}

/** The Markdown parts of one message's content blocks. */
function partsOf(content) {
  if (typeof content === 'string') {
    return [content];
  }
  const parts = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (block.type === 'text' && block.text?.trim()) {
      parts.push(block.text);
    }
    if (block.type === 'tool_use') {
      parts.push(`**Tool: ${block.name}**\n\n${fence(clip(JSON.stringify(block.input ?? {}, null, 2), INPUT_LIMIT), 'json')}`);
    }
    if (block.type === 'tool_result') {
      parts.push(`**Result**\n\n${fence(clip(resultText(block.content), TOOL_RESULT_LIMIT))}`);
    }
  }
  return parts;
}

/** `SessionMessage`s as Markdown: one section per turn, tools and their results as code blocks. */
export function transcriptMarkdown(title, messages) {
  const out = [`# ${title}`, ''];
  for (const message of messages) {
    if (message.parent_tool_use_id || (message.type !== 'user' && message.type !== 'assistant')) {
      continue;
    }
    const parts = partsOf(message.message?.content);
    if (!parts.length) {
      continue;
    }
    const isResult = parts.every((part) => part.startsWith('**Result**'));
    if (!isResult) {
      out.push(`## ${message.type === 'user' ? 'You' : 'Claude'}`, '');
    }
    out.push(parts.join('\n\n'), '');
  }
  return out.join('\n').trimEnd() + '\n';
}
