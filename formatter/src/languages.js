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
 * Which language a file is, as far as the Pureline engine is concerned —
 * decided by Lumen's language id first, by the file extension second.
 */

const BY_ID = {
  java: 'java',
  javascript: 'javascript',
  javascriptreact: 'javascript',
  jsx: 'javascript',
  typescript: 'typescript',
  typescriptreact: 'typescript',
  tsx: 'typescript',
  go: 'go',
  golang: 'go',
  crystal: 'crystal',
  kotlin: 'kotlin',
};

const BY_EXTENSION = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescript',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.go': 'go',
  '.cr': 'crystal',
};

const JSX_IDS = new Set(['javascriptreact', 'typescriptreact', 'jsx', 'tsx']);
const JSX_EXTENSIONS = new Set(['.jsx', '.tsx']);

const INFO = {
  java: { name: 'java', family: 'java', structural: true, semicolons: false, indentDefault: 4 },
  javascript: { name: 'javascript', family: 'js', structural: true, semicolons: true, indentDefault: 4 },
  typescript: { name: 'typescript', family: 'js', structural: true, semicolons: true, indentDefault: 4 },
  go: { name: 'go', family: 'go', structural: true, semicolons: false, indentDefault: 'tab' },
  kotlin: { name: 'kotlin', family: 'kotlin', structural: false, semicolons: false, indentDefault: 4 },
  crystal: { name: 'crystal', family: 'crystal', structural: false, semicolons: false, indentDefault: 2 },
};

function extensionOf(filePath) {
  const base = String(filePath ?? '').split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) { return ''; }
  return base.slice(dot).toLowerCase();
}

/** `{ ...info, jsx }` for a file Pureline can format, otherwise `null`. */
export function resolveLanguage({ path = null, languageId = null } = {}) {
  const extension = extensionOf(path);
  const name = BY_ID[String(languageId ?? '').toLowerCase()] ?? BY_EXTENSION[extension];
  if (!name) { return null; }
  const jsx = JSX_IDS.has(String(languageId ?? '').toLowerCase()) || JSX_EXTENSIONS.has(extension);
  return { ...INFO[name], jsx };
}

/** Extensions Prettier is asked to format; all other files stay with Pureline. */
export const PRETTIER_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts',
  '.json', '.jsonc', '.json5',
  '.css', '.scss', '.less',
  '.html', '.vue',
  '.md', '.markdown', '.mdx',
  '.yaml', '.yml',
  '.graphql', '.gql',
  '.hbs', '.handlebars',
]);

export function isPrettierFile(filePath) {
  return PRETTIER_EXTENSIONS.has(extensionOf(filePath));
}

export { extensionOf };
