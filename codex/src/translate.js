/*
 * Copyright (C) 2026 ezTxmMC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of Lumen IDE. It is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version. See the LICENSE file for details.
 */

/** Codex's `--experimental-json` events as Lumen's agent events. */

import path from 'node:path';
import { clip } from './util.js';

const CHANGE_TOOL = { add: 'Write', update: 'Edit', delete: 'Delete' };

/** One MCP content block as text. */
function blockText(block) {
  if (block.type === 'text') {
    return block.text;
  }
  if (block.type === 'resource' && block.resource?.text) {
    return block.resource.text;
  }
  return `[${block.type ?? 'content'}]`;
}

/** An MCP result's content blocks (or its structured content) as text. */
function mcpText(item) {
  if (item.error?.message) {
    return item.error.message;
  }
  const content = Array.isArray(item.result?.content) ? item.result.content : [];
  if (content.length) {
    return clip(content.map(blockText).join('\n'));
  }
  const structured = item.result?.structured_content ?? item.result?.structuredContent;
  return structured ? clip(JSON.stringify(structured, null, 2)) : '';
}

/** An MCP call's arguments as the object the chat shows. */
function mcpInput(item) {
  if (item.arguments && typeof item.arguments === 'object' && !Array.isArray(item.arguments)) {
    return item.arguments;
  }
  return item.arguments === undefined || item.arguments === null ? {} : { arguments: item.arguments };
}

/** A web search's query and, when Codex says what it did, the action (open page, find in page). */
function searchInput(item) {
  const input = { query: item.query ?? item.action?.query ?? '' };
  if (item.action?.type && item.action.type !== 'search') {
    input.action = item.action.type;
  }
  if (item.action?.url) {
    input.url = item.action.url;
  }
  return input;
}

/** Codex's to-do list: the first open entry counts as the one in progress. */
export function todosOf(item) {
  const entries = Array.isArray(item.items) ? item.items : [];
  const current = entries.findIndex((entry) => !entry.completed);
  return entries.map((entry, index) => {
    if (entry.completed) {
      return { text: entry.text, status: 'completed' };
    }
    return { text: entry.text, status: index === current ? 'in_progress' : 'pending' };
  });
}

const tool = (id, name, input) => ({ kind: 'assistant', blocks: [{ type: 'tool', id, name, input }] });

/** Events for an item that just started. */
function started(item) {
  if (item.type === 'command_execution') {
    return [tool(item.id, 'Shell', { command: item.command })];
  }
  if (item.type === 'mcp_tool_call') {
    return [tool(item.id, `${item.server}.${item.tool}`, mcpInput(item))];
  }
  if (item.type === 'web_search') {
    return [tool(item.id, 'WebSearch', searchInput(item))];
  }
  if (item.type === 'todo_list') {
    return [{ kind: 'todos', items: todosOf(item) }];
  }
  return [];
}

function fileChanges(item, cwd) {
  // One row per file, so each can be opened; the chat opens edited files itself.
  return (item.changes ?? []).flatMap((change, index) => {
    const id = `${item.id}-${index}`;
    const file = path.isAbsolute(change.path) ? change.path : path.join(cwd, change.path);
    return [
      tool(id, CHANGE_TOOL[change.kind] ?? 'Edit', { file_path: file }),
      { kind: 'toolResult', toolUseId: id, text: '', isError: item.status === 'failed' },
    ];
  });
}

/** Events for an item that finished. */
function completed(item, cwd) {
  if (item.type === 'agent_message') {
    return [{ kind: 'assistant', blocks: [{ type: 'text', text: item.text ?? '' }] }];
  }
  if (item.type === 'reasoning') {
    return [{ kind: 'assistant', blocks: [{ type: 'thinking', text: item.text ?? '' }] }];
  }
  if (item.type === 'command_execution') {
    const failed = item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0);
    return [{ kind: 'toolResult', toolUseId: item.id, text: clip(item.aggregated_output), isError: failed }];
  }
  if (item.type === 'file_change') {
    return fileChanges(item, cwd);
  }
  if (item.type === 'mcp_tool_call') {
    return [{ kind: 'toolResult', toolUseId: item.id, text: mcpText(item), isError: item.status === 'failed' }];
  }
  if (item.type === 'web_search') {
    return [{ kind: 'toolResult', toolUseId: item.id, text: '', isError: false }];
  }
  if (item.type === 'todo_list') {
    return [{ kind: 'todos', items: todosOf(item) }];
  }
  if (item.type === 'error') {
    return [{ kind: 'notice', level: 'warn', text: item.message }];
  }
  return [];
}

export function usageOf(usage, startedAt) {
  return {
    inputTokens: usage?.input_tokens,
    outputTokens: (usage?.output_tokens ?? 0) + (usage?.reasoning_output_tokens ?? 0),
    cacheReadTokens: usage?.cached_input_tokens,
    cacheWriteTokens: usage?.cache_write_input_tokens,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * `context`: `cwd`, `model`, `startedAt`, and `sessionEvent` — the extras
 * (commands, capabilities, mode) every `session` event carries.
 */
export function translate(event, context) {
  if (event.type === 'thread.started') {
    return [{ kind: 'session', sessionId: event.thread_id, model: context.model, mode: context.mode, ...context.sessionExtras }];
  }
  if (event.type === 'turn.started') {
    return [{ kind: 'status', text: '' }];
  }
  if (event.type === 'item.started') {
    return started(event.item);
  }
  if (event.type === 'item.updated' && event.item?.type === 'todo_list') {
    return [{ kind: 'todos', items: todosOf(event.item) }];
  }
  if (event.type === 'item.completed') {
    return completed(event.item, context.cwd);
  }
  if (event.type === 'turn.completed') {
    return [{ kind: 'result', isError: false, text: '', usage: usageOf(event.usage, context.startedAt) }];
  }
  if (event.type === 'turn.failed') {
    return [{ kind: 'result', isError: true, text: event.error?.message ?? 'The turn failed', usage: usageOf(null, context.startedAt) }];
  }
  if (event.type === 'error') {
    return [{ kind: 'error', message: event.message }];
  }
  return [];
}
