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
 * Permission prompts. Every tool Claude wants to use waits here for the
 * user's answer. The SDK's own suggestions become the extra answers: "allow
 * for this session" and "always allow `Bash(npm:*)`".
 */

/** Requests waiting for an answer, by request id. */
const pending = new Map();
let requestCounter = 0;

const ruleText = (rule) => (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName);

/** What one suggested update does, in words. */
function describeUpdate(update) {
  if (update.type === 'addRules') {
    return update.rules.map(ruleText).join(', ');
  }
  if (update.type === 'setMode') {
    return `${update.mode} mode`;
  }
  if (update.type === 'addDirectories') {
    return `access to ${update.directories.join(', ')}`;
  }
  return '';
}

function summarize(updates) {
  return updates.map(describeUpdate).filter(Boolean).join('; ');
}

/** The extra answers for a prompt, with the permission updates each one applies. */
export function answersFor(suggestions) {
  const options = [];
  const updates = new Map();
  if (!suggestions.length) {
    return { options, updates };
  }
  const forSession = suggestions.map((update) => ({ ...update, destination: 'session' }));
  options.push({ id: 'session', label: 'Allow for this session', description: summarize(suggestions) || undefined, scope: 'session' });
  updates.set('session', forSession);
  const persistent = suggestions.filter((update) => update.destination !== 'session');
  if (persistent.length) {
    const rule = summarize(persistent);
    options.push({ id: 'always', label: rule ? `Always allow ${rule}` : 'Always allow', scope: 'always' });
    updates.set('always', persistent);
  }
  return { options, updates };
}

/** The `canUseTool` callback of one run. */
export function permissionHandler(chatId, emit) {
  return (tool, input, request) => new Promise((resolve) => {
    const requestId = `perm-${++requestCounter}`;
    const suggestions = request.suggestions ?? [];
    const { options, updates } = answersFor(suggestions);
    pending.set(requestId, { chatId, suggestions, updates, input, resolve });
    request.signal.addEventListener('abort', () => {
      if (!pending.delete(requestId)) {
        return;
      }
      resolve({ behavior: 'deny', message: 'Cancelled' });
      emit({ kind: 'permissionSettled', requestId });
    }, { once: true });
    emit({
      kind: 'permission', requestId, tool, input, blockedPath: request.blockedPath,
      reason: request.decisionReason, canRemember: suggestions.length > 0,
      ...(options.length ? { options } : {}),
    });
  });
}

/** The permission updates an answer asks for: a chosen option, else "remember" means all suggestions. */
function updatesFor(entry, { remember, optionId }) {
  if (optionId && entry.updates.has(optionId)) {
    return entry.updates.get(optionId);
  }
  return remember ? entry.suggestions : undefined;
}

/** The user's answer to a prompt; false when nothing waits for it any more. */
export function answerPermission(reply) {
  const entry = pending.get(reply.requestId);
  if (!entry) {
    return false;
  }
  pending.delete(reply.requestId);
  if (!reply.allow) {
    entry.resolve({ behavior: 'deny', message: reply.message?.trim() || 'The user denied this action' });
    return true;
  }
  // A question the agent asked: the chosen answers travel back inside the tool's input.
  const updatedInput = reply.answers ? { ...entry.input, answers: reply.answers } : entry.input;
  entry.resolve({ behavior: 'allow', updatedInput, updatedPermissions: updatesFor(entry, reply) });
  return true;
}

/** Deny whatever still waits for an answer in this chat. */
export function settleChat(chatId) {
  for (const [id, entry] of pending) {
    if (entry.chatId !== chatId) {
      continue;
    }
    entry.resolve({ behavior: 'deny', message: 'Stopped by the user', interrupt: true });
    pending.delete(id);
  }
}
