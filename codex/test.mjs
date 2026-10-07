#!/usr/bin/env node
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
 * Tests for the pure parts of the Codex add-on and one whole turn against a
 * fake `codex` program (no network, no account).
 *
 *   node addons/codex/test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reviewPlan } from './src/commands.js';
import { expandPrompt, parsePrompt } from './src/prompts.js';
import { argsFor, forkArgs, overridesOf, promptWith } from './src/settings.js';
import { translate } from './src/translate.js';
import { warningFrom, windowLabel } from './src/usage.js';
import { splitArgs, tomlString } from './src/util.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  process.stdout.write(`✓ ${name}\n`);
}

const request = (extra = {}) => ({
  cwd: '/work', mode: 'workspace-write', settings: { skipGitRepoCheck: 'true' }, ...extra,
});

await test('splitArgs groups quotes', () => {
  assert.deepEqual(splitArgs('a "b c" d\\ e \'f g\''), ['a', 'b c', 'd e', 'f g']);
});

await test('tomlString escapes line breaks', () => {
  assert.equal(tomlString('a"b\nc'), '"a\\"b\\nc"');
});

await test('prompt front matter and placeholders', () => {
  const { meta, body } = parsePrompt('---\ndescription: Fix it\nargument-hint: FILE=<f>\n---\nFix $FILE and $1, cost $$5: $ARGUMENTS');
  assert.equal(meta.description, 'Fix it');
  assert.equal(meta['argument-hint'], 'FILE=<f>');
  assert.equal(expandPrompt(body, 'FILE=a.ts "two words" x'), 'Fix a.ts and two words, cost $5: two words x');
});

await test('review plan: one target or custom instructions', () => {
  assert.deepEqual(reviewPlan(''), { target: ['--uncommitted'] });
  assert.deepEqual(reviewPlan('base main'), { target: ['--base', 'main'] });
  assert.deepEqual(reviewPlan('commit abc1234 Fix login'), { target: ['--commit', 'abc1234', '--title', 'Fix login'] });
  assert.deepEqual(reviewPlan('look at auth'), { target: [], prompt: 'look at auth' });
});

await test('command line: options before the subcommand', () => {
  const args = argsFor(request({ sessionId: 'abc', settings: { skipGitRepoCheck: 'true', approvalWorkspace: 'on-request', ephemeral: 'true', oss: 'true', localProvider: 'ollama', outputSchema: '/s.json' } }), ['/i.png']);
  assert.deepEqual(args.slice(0, 4), ['exec', '--experimental-json', '--color', 'never']);
  assert.ok(args.indexOf('--sandbox') < args.indexOf('resume'));
  assert.ok(args.includes('--ephemeral') && args.includes('--oss') && args.includes('--output-schema'));
  assert.ok(args.includes('approval_policy="on-request"'));
  assert.deepEqual(args.slice(-4), ['resume', 'abc', '--image', '/i.png']);
});

await test('review and fork command lines', () => {
  const review = argsFor(request(), [], { kind: 'review', target: ['--base', 'main'] });
  assert.deepEqual(review.slice(-3), ['review', '--base', 'main']);
  assert.deepEqual(forkArgs(request({ sessionId: 'abc' })).slice(-2), ['fork', 'abc']);
});

await test('instructions: developer_instructions or prompt prefix', () => {
  const args = argsFor(request({ systemPrompt: 'Be brief', settings: { customInstructions: 'Use tabs' } }), []);
  assert.ok(args.includes('developer_instructions="Use tabs\\n\\nBe brief"'));
  const viaPrompt = argsFor(request({ systemPrompt: 'x', settings: { instructionsVia: 'prompt' } }), []);
  assert.ok(!viaPrompt.some((arg) => arg.startsWith('developer_instructions')));
  assert.match(promptWith('hi', [], 'x'), /^<instructions>\nx\n<\/instructions>\n\nhi$/);
});

await test('full access needs its setting', () => {
  assert.throws(() => argsFor(request({ mode: 'danger-full-access' }), []), /switched off/);
});

await test('config overrides: comments skipped, bad lines reported', () => {
  assert.deepEqual(overridesOf('# c\na=1\nnonsense'), { valid: ['a=1'], invalid: ['nonsense'] });
});

await test('translate: MCP calls, web search, warnings', () => {
  const context = { cwd: '/work', startedAt: Date.now() };
  const mcp = translate({ type: 'item.started', item: { id: '1', type: 'mcp_tool_call', server: 'idea', tool: 'search', arguments: { q: 'x' } } }, context);
  assert.deepEqual(mcp[0].blocks[0], { type: 'tool', id: '1', name: 'idea.search', input: { q: 'x' } });
  const result = translate({ type: 'item.completed', item: { id: '1', type: 'mcp_tool_call', result: { structured_content: { a: 1 } } } }, context);
  assert.match(result[0].text, /"a": 1/);
  const search = translate({ type: 'item.started', item: { id: '2', type: 'web_search', query: 'lumen' } }, context);
  assert.equal(search[0].blocks[0].input.query, 'lumen');
  assert.equal(translate({ type: 'item.completed', item: { type: 'error', message: 'model changed' } }, context)[0].kind, 'notice');
});

await test('usage helpers', () => {
  assert.equal(windowLabel(300), '5 h');
  assert.equal(windowLabel(10080), 'week');
  assert.equal(windowLabel(43200), 'month');
  assert.equal(warningFrom('2026-10-07T08:44:43Z  WARN something odd').text, 'something odd');
  assert.equal(warningFrom('2026-10-07T08:44:43Z ERROR rmcp::transport::worker: x'), null);
});

await test('a whole turn against a fake codex', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  const fake = path.join(dir, 'codex');
  fs.writeFileSync(fake, [
    '#!/bin/sh',
    'echo \'{"type":"thread.started","thread_id":"t-1"}\'',
    'echo \'{"type":"item.completed","item":{"id":"a","type":"agent_message","text":"hello"}}\'',
    'echo \'{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}\'',
  ].join('\n'), { mode: 0o755 });
  const { activate } = await import('./main.js');
  let provider;
  activate({ storage: { get: (_key, fallback) => fallback, set() {} }, agents: { register: (_id, value) => { provider = value; } } });
  const events = [];
  await provider.send({
    chatId: 'c', text: '/init', cwd: dir, mode: 'read-only', settings: { codexPath: fake },
  }, (event) => events.push(event));
  const kinds = events.map((event) => event.kind);
  assert.deepEqual(kinds.slice(0, 2), ['session', 'notice']);
  assert.ok(events[0].capabilities.fork && events[0].slashCommands.some((entry) => entry.name === 'review'));
  assert.ok(kinds.includes('assistant') && kinds.includes('result') && kinds.at(-1) === 'usage');
  const notices = [];
  await provider.send({ chatId: 'c', text: '/profiles', cwd: dir, mode: 'read-only', settings: { codexPath: fake } }, (event) => notices.push(event));
  assert.equal(notices[0].kind, 'notice');
  fs.rmSync(dir, { recursive: true, force: true });
});

process.stdout.write(`\n${passed} passed\n`);
