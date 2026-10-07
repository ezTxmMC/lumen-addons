/*
 * Copyright (C) 2026 ezTxmMC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of Lumen IDE. It is free software: you can redistribute it
 * and/or modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version. See the LICENSE file for details.
 */

/** What a hook command's verdict (a block or extra context) means for each event. */

/**
 * The SDK's answer for a hook that blocked (`block`) or only printed
 * context. A Stop hook that already kept Claude going is let through, so it
 * cannot loop.
 */
export function hookSpecificsFor(event, input, { block = false, reason = '', context = '' }) {
  if (event === 'PreToolUse' && block) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  }
  if (event === 'Stop' && block) {
    return input.stop_hook_active ? {} : { decision: 'block', reason };
  }
  if (event === 'SubagentStop' && block) {
    return input.stop_hook_active ? {} : { decision: 'block', reason };
  }
  if (block) {
    return { decision: 'block', reason };
  }
  if (context && (event === 'UserPromptSubmit' || event === 'SessionStart')) {
    return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
  }
  return {};
}
