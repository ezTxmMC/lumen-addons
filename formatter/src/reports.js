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
 * The documents the commands open: what is active for a file, and the rule
 * catalog. Plain Markdown text; nothing here touches Lumen or the disk.
 */

import { levelOf, RULES } from './rules.js';

const LEVEL_NAMES = { off: 'off', hint: 'hint', info: 'info', warn: 'warning', error: 'error' };

function bullet(label, value) {
  return `- **${label}:** ${value}`;
}

function indentText(indent) {
  return indent.style === 'tab' ? 'tabs' : `${indent.size} spaces`;
}

/** The rules that apply to `languageName`, with their level under `config`. */
function ruleRows(config, languageName) {
  return RULES
    .filter((rule) => rule.languages.includes(languageName) && (rule.checked || rule.fixable))
    .map((rule) => {
      const level = levelOf(config, rule.id);
      const action = rule.fixable ? 'fix + check' : 'check';
      return `| ${rule.id} | ${rule.title} | ${LEVEL_NAMES[level] ?? level} | ${level === 'off' ? '—' : action} |`;
    });
}

function purelineSection(description) {
  const { config, decision, language } = description;
  const lines = [
    '## Resolved options',
    '',
    bullet('Indentation', indentText(config.indent)),
    bullet('Line endings', config.endOfLine),
    bullet('Print width', config.printWidth),
    bullet('Semicolons', config.semicolons ? 'yes' : 'no'),
    bullet('Final newline', config.finalNewline ? 'yes' : 'no'),
    bullet('Trim trailing whitespace', config.trimTrailingWhitespace ? 'yes' : 'no'),
    '',
    `## Active rules for ${language.name}`,
    '',
    '| Rule | What | Level | Action |',
    '| --- | --- | --- | --- |',
    ...ruleRows(config, language.name),
  ];
  const ignores = decision.chain.files.filter((entry) => entry.ignore.length);
  if (ignores.length) {
    lines.push('', '## Ignored files', '');
    for (const entry of ignores) { lines.push(`- \`${entry.file}\`: ${entry.ignore.map((pattern) => `\`${pattern}\``).join(', ')}`); }
  }
  return lines;
}

function prettierSection(description) {
  const { decision } = description;
  const lines = ['## Prettier', ''];
  lines.push(bullet('Program', `\`${decision.binary.bin}\` (${decision.binary.source}${decision.version ? `, version ${decision.version}` : ''})`));
  lines.push(bullet('Config', decision.configFile ? `\`${decision.configFile}\`` : 'none — Prettier defaults'));
  if (decision.ignoreFile) { lines.push(bullet('.prettierignore', `\`${decision.ignoreFile}\``)); }
  if (decision.ignored) { lines.push(bullet('This file', 'ignored by Prettier — it is not formatted')); }
  const options = Object.entries(decision.options ?? {});
  if (decision.parsed && !decision.parsed.readable) {
    lines.push('', 'The config is a script or a shared config — Prettier resolves it itself, so no options are listed here.');
  }
  if (options.length) {
    lines.push('', '### Options read from the config', '');
    for (const [key, value] of options) { lines.push(`- \`${key}\`: \`${JSON.stringify(value)}\``); }
  }
  return lines;
}

/**
 * Markdown for "which configuration is active here".
 * `description`: `{ file, workspace, decision, config, language }` — `decision`
 * is `engines.decide(...)` (null: no engine formats this file).
 */
export function explainDocument(description) {
  const { file, decision } = description;
  const lines = ['# Formatter: active configuration', ''];
  lines.push(bullet('File', file.path ? `\`${file.path}\`` : 'not saved yet'));
  lines.push(bullet('Language', file.languageId ?? 'unknown'));
  if (!decision) {
    lines.push(bullet('Engine', 'none'), '', 'No formatter in this extension handles the file: Pureline knows Java, JavaScript, TypeScript, Go, Crystal and Kotlin, and Prettier only runs when a Prettier config exists (or the engine setting forces it).');
    return lines.join('\n');
  }
  lines.push(bullet('Engine', description.label));
  const origin = {
    '.pureline': 'a `.pureline` file was found',
    defaults: 'no config file was found, so the Pureline defaults apply (editor options and the `defaultIndent` setting)',
    'prettier-fallback': 'a Prettier config exists but Prettier is not installed',
  };
  if (decision.engine === 'pureline') { lines.push(bullet('Why', origin[decision.source])); }
  if (decision.engine === 'prettier') { lines.push(bullet('Why', 'a Prettier config was found (or Prettier is forced by the engine setting)')); }
  if (decision.ignored) { lines.push(bullet('This file', 'ignored — it is not formatted')); }
  if (decision.engine === 'pureline' && decision.chain.files.length) {
    lines.push('', '## `.pureline` files (nearest first)', '');
    for (const entry of decision.chain.files) { lines.push(`- \`${entry.file}\``); }
  }
  lines.push('');
  lines.push(...(decision.engine === 'pureline' ? purelineSection(description) : prettierSection(description)));
  if (decision.notes?.length) {
    lines.push('', '## Notes', '');
    for (const note of decision.notes) { lines.push(`- ${note}`); }
  }
  return lines.join('\n');
}

/** Markdown with every Pureline rule: id, title, languages, whether the formatter fixes it. */
export function rulesDocument() {
  const lines = [
    '# Pureline 1.1 rule catalog',
    '',
    'Rules are switched in a `.pureline` file: `"rules": { "PL-CF-002": "error", "PL-FMT-001": "off" }`.',
    'A rule that is `off` is neither fixed nor reported. **Fix** means the formatter rewrites code for it when you format.',
    '',
    '| Rule | What | Languages | Default | Fix | Check |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const rule of RULES) {
    const languages = rule.languages.length === 5 ? 'all' : rule.languages.join(', ');
    lines.push(`| ${rule.id} | ${rule.title} | ${languages} | ${LEVEL_NAMES[rule.severity]} | ${rule.fixable ? 'yes' : '—'} | ${rule.checked ? 'yes' : 'review'} |`);
  }
  return lines.join('\n');
}
