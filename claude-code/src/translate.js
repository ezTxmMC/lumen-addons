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
 * The SDK's messages in the shape every Lumen agent reports: assistant
 * blocks (nested under a subagent when they belong to one), tool results,
 * subagent start/finish, notices, usage and the final result.
 */

import { assistantUsage, rateLimitOf, resultUsage } from './usage.js';

const RESULT_LIMIT = 6000;
const SUMMARY_LIMIT = 300;
/** The tool that starts a subagent (`Task`; newer versions call it `Agent`). */
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

function clip(text, limit = RESULT_LIMIT) {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`;
}

/** A tool result's content is a string or a list of blocks — flatten it to text. */
function resultText(content) {
  if (typeof content === 'string') {
    return clip(content);
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return clip(content.map((block) => (block.type === 'text' ? block.text ?? '' : `[${block.type ?? 'unknown'}]`)).join('\n'));
}

function usageOf(message) {
  const usage = message.usage ?? {};
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
    costUsd: message.total_cost_usd,
    durationMs: message.duration_ms,
    turns: message.num_turns,
  };
}

/** Text and thinking as they are written (`includePartialMessages`). */
function streamDelta(event) {
  if (event?.type !== 'content_block_delta') {
    return [];
  }
  const delta = event.delta ?? {};
  if (delta.type === 'text_delta' && delta.text) {
    return [{ kind: 'delta', text: delta.text }];
  }
  if (delta.type === 'thinking_delta' && delta.thinking) {
    return [{ kind: 'delta', text: delta.thinking, thinking: true }];
  }
  return [];
}

function blocksOf(message) {
  const blocks = [];
  for (const block of message.message.content) {
    if (block.type === 'text' && block.text.trim()) {
      blocks.push({ type: 'text', text: block.text });
    }
    if (block.type === 'thinking' && block.thinking?.trim()) {
      blocks.push({ type: 'thinking', text: block.thinking });
    }
    if (block.type === 'tool_use') {
      blocks.push({ type: 'tool', id: block.id, name: block.name, input: block.input ?? {} });
    }
  }
  return blocks;
}

/** Messages the CLI prints for itself (`/context`, `/cost` …) and its own notes, as chat notices. */
const SYSTEM_NOTICES = {
  compact_boundary(message) {
    const meta = message.compact_metadata ?? {};
    const how = meta.trigger === 'auto' ? 'automatically' : 'on request';
    const sizes = meta.post_tokens ? `${meta.pre_tokens} → ${meta.post_tokens} tokens` : `${meta.pre_tokens ?? '?'} tokens before`;
    return { level: 'info', text: `Conversation compacted ${how} (${sizes}).` };
  },
  local_command_output: (message) => ({ level: 'info', text: String(message.content ?? '').trim() }),
  informational: (message) => ({ level: message.level === 'warning' ? 'warn' : 'info', text: String(message.content ?? '').trim() }),
  api_retry: (message) => ({ level: 'warn', text: `API error (${message.error}), retry ${message.attempt} of ${message.max_retries} …` }),
  permission_denied: (message) => ({ level: 'warn', text: `${message.tool_name}: ${message.message}` }),
  hook_response(message) {
    if (message.outcome !== 'error' && message.exit_code !== 2) {
      return null;
    }
    const detail = (message.stderr || message.output || '').trim();
    return { level: 'warn', text: `Hook ${message.hook_name} (${message.hook_event}) blocked or failed${detail ? `: ${detail}` : '.'}` };
  },
};

function systemEvents(message) {
  if (message.subtype === 'init') {
    return [{
      kind: 'session', sessionId: message.session_id, model: message.model, tools: message.tools,
      slashCommands: message.slash_commands, cwd: message.cwd, mode: message.permissionMode,
    }];
  }
  if (message.subtype === 'status') {
    if (message.compact_result === 'failed') {
      return [{ kind: 'notice', level: 'warn', text: `Compaction failed${message.compact_error ? `: ${message.compact_error}` : '.'}` }];
    }
    return [{ kind: 'status', text: message.status === 'compacting' ? 'Compacting conversation …' : '' }];
  }
  const notice = SYSTEM_NOTICES[message.subtype]?.(message);
  if (!notice?.text) {
    return [];
  }
  return [{ kind: 'notice', ...notice }];
}

/** The `Task` tool use of an assistant message opens a subagent. */
function subagentStarts(message) {
  return message.message.content
    .filter((block) => block.type === 'tool_use' && SUBAGENT_TOOLS.has(block.name))
    .map((block) => ({
      kind: 'subagent', id: block.id, phase: 'start',
      description: block.input?.description || block.input?.prompt?.slice(0, 80),
      agentType: block.input?.subagent_type,
    }));
}

/**
 * A translator for one run. It remembers which subagents are open, so their
 * tool results close them and their assistant messages nest under them.
 */
export function createTranslator() {
  const subagents = new Set();

  const TRANSLATORS = {
    system: systemEvents,

    stream_event(message) {
      // Subagents write too; only the main conversation streams into the chat.
      if (message.parent_tool_use_id) {
        return [];
      }
      return streamDelta(message.event);
    },

    assistant(message) {
      const blocks = blocksOf(message);
      if (!blocks.length) {
        return [];
      }
      const parentId = message.parent_tool_use_id || undefined;
      const events = [{ kind: 'assistant', blocks, ...(parentId ? { parentId } : {}) }];
      for (const start of subagentStarts(message)) {
        subagents.add(start.id);
        events.push(start);
      }
      const usage = parentId ? null : assistantUsage(message);
      return usage ? [...events, usage] : events;
    },

    user(message) {
      const content = message.message.content;
      if (!Array.isArray(content)) {
        return [];
      }
      const events = [];
      for (const block of content.filter((entry) => entry.type === 'tool_result')) {
        const text = resultText(block.content);
        events.push({ kind: 'toolResult', toolUseId: block.tool_use_id, text, isError: block.is_error === true });
        if (subagents.delete(block.tool_use_id)) {
          events.push({ kind: 'subagent', id: block.tool_use_id, phase: 'finish', isError: block.is_error === true, summary: clip(text, SUMMARY_LIMIT) });
        }
      }
      return events;
    },

    rate_limit_event(message) {
      const limit = rateLimitOf(message);
      return limit ? [{ kind: 'usage', rateLimits: [limit] }] : [];
    },

    result(message) {
      const text = message.subtype === 'success' ? message.result : (message.errors ?? []).join('\n') || message.subtype;
      const events = [];
      for (const id of subagents) {
        events.push({ kind: 'subagent', id, phase: 'finish', isError: true, summary: 'Interrupted' });
      }
      subagents.clear();
      events.push({ kind: 'result', isError: message.is_error, text, costUsd: message.total_cost_usd, durationMs: message.duration_ms, usage: usageOf(message) });
      events.push(resultUsage(message));
      return events;
    },
  };

  return function translate(message) {
    const translator = TRANSLATORS[message.type];
    if (!translator) {
      return [];
    }
    return translator(message);
  };
}
