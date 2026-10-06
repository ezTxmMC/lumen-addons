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
 * Tests for the Formatter extension: the tokenizer, every Pureline fix, the
 * checker, the config readers and the engine selection (against temporary
 * folders and a fake `ctx`). No framework.
 *
 *   node addons/formatter/test.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPureline } from './src/checker.js';
import { globToRegExp, matchGlob } from './src/config/glob.js';
import { parseJsonc } from './src/config/jsonc.js';
import { parseFlatToml, parseFlatYaml } from './src/config/flat-formats.js';
import { documentedTemplate, defaultsFor, effectiveConfig, indentUnit, mergeConfig, parsePureline } from './src/config/pureline.js';
import { isIgnoredBy, parseIgnoreFile, parsePrettierConfig, prettierToPureline, resolvePrettierOptions } from './src/config/prettier.js';
import { findNearest, loadPurelineChain, ignoredByChain } from './src/config/discover.js';
import { crystalElses, crystalLiteralLines } from './src/crystal.js';
import { createEngines } from './src/engines.js';
import { formatPureline } from './src/format.js';
import { explainDocument, rulesDocument } from './src/reports.js';
import { isKnownRule, RULES, levelOf } from './src/rules.js';
import { analyze } from './src/source.js';
import { resolveLanguage } from './src/languages.js';
import { T, tokenize } from './src/tokenizer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let assertions = 0;
const eq = (actual, expected, message) => {
  assertions++;
  assert.equal(actual, expected, message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const same = (actual, expected, message) => {
  assertions++;
  assert.deepEqual(actual, expected, message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const yes = (value, message) => {
  assertions++;
  assert.ok(value, message ?? 'expected a truthy value');
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** Formats with the Pureline defaults (4 spaces, tabs for Go) unless `config` changes something. */
function format(text, languageId = 'javascript', config = {}, options = {}) {
  const language = resolveLanguage({ languageId });
  const name = language?.name ?? languageId;
  const effective = effectiveConfig(config, name, defaultsFor(name, {}, {}));
  return formatPureline(text, languageId, effective, options);
}

const out = (text, languageId, config, options) => format(text, languageId, config, options).text;

/** Asserts that formatting `input` gives `expected`, and that the result is stable. */
function formats(input, expected, languageId = 'javascript', config = {}) {
  const first = out(input, languageId, config);
  eq(first, expected);
  eq(out(first, languageId, config), first, 'idempotent');
}

function diagnostics(text, languageId, config = {}) {
  const language = resolveLanguage({ languageId });
  const name = language?.name ?? languageId;
  return checkPureline(text, languageId, effectiveConfig(config, name, defaultsFor(name, {}, {})));
}

const codes = (list) => list.map((entry) => entry.code);

/* ------------------------------------------------------------------ */
/* Tokenizer                                                           */
/* ------------------------------------------------------------------ */

const significant = (text, family = 'js') => tokenize(text, family).filter((t) => ![T.WS, T.NEWLINE, T.COMMENT].includes(t.type));

test('tokenizer: strings with escapes stay one token', () => {
  const tokens = significant('const s = "a\\"b" + \'c\\\'d\';');
  same(tokens.map((t) => t.type), ['word', 'word', 'punct', 'string', 'punct', 'string', 'punct']);
  eq(tokens[3].value, '"a\\"b"');
  eq(tokens[5].value, '\'c\\\'d\'');
});

test('tokenizer: template literals nest expressions, strings and templates', () => {
  const text = 'const t = `a ${b("}") + `x${y}`} c`;';
  const tokens = significant(text);
  eq(tokens.filter((t) => t.type === T.TEMPLATE).length, 1);
  eq(tokens.find((t) => t.type === T.TEMPLATE).value, '`a ${b("}") + `x${y}`} c`');
  eq(tokens.at(-1).value, ';');
});

test('tokenizer: a regex in a template expression does not confuse the scan', () => {
  const tokens = significant('const t = `"${String(v).replace(/"/g, \'x\')}"`; foo();');
  eq(tokens.filter((t) => t.type === T.TEMPLATE).length, 1);
  eq(tokens.at(-4).value, 'foo');
});

test('tokenizer: regex versus division depends on the previous token', () => {
  const regex = significant('const r = /a[/]b/gi; x = a / b / c;');
  eq(regex.filter((t) => t.type === T.REGEX).length, 1);
  eq(regex.find((t) => t.type === T.REGEX).value, '/a[/]b/gi');
  eq(significant('return /x/.test(y);').filter((t) => t.type === T.REGEX).length, 1);
  eq(significant('a = (b) / 2 / c;').filter((t) => t.type === T.REGEX).length, 0);
});

test('tokenizer: comments, line numbers and unterminated input', () => {
  const tokens = tokenize('a // x\n/* y\nz */ b', 'js');
  const comments = tokens.filter((t) => t.type === T.COMMENT);
  eq(comments.length, 2);
  eq(comments[1].block, true);
  eq(tokens.at(-1).line, 2);
  eq(tokenize('/* open', 'js').at(-1).end, 7);
  eq(significant('"abc\nx', 'js').length, 2);
});

test('tokenizer: Java text blocks, char literals and Go raw strings', () => {
  const block = significant('String s = """\n  a "quoted" \\""" b\n  """;', 'java');
  eq(block.find((t) => t.type === T.TEMPLATE).kind, 'textblock');
  eq(block.at(-1).value, ';');
  eq(significant('char c = \'\\\'\';', 'java').filter((t) => t.type === T.STRING).length, 1);
  const raw = significant('x := `a\\n\n b`\ny := 1', 'go');
  eq(raw.find((t) => t.type === T.TEMPLATE).value, '`a\\n\n b`');
  eq(raw.at(-1).value, '1');
});

test('tokenizer: numbers, words and multi-character operators', () => {
  const tokens = significant('x >>>= 0xFF_FF + 1.5e-3 ?? a?.b => c', 'js');
  same(tokens.map((t) => t.value), ['x', '>>>=', '0xFF_FF', '+', '1.5e-3', '??', 'a', '?.', 'b', '=>', 'c']);
  same(significant('a := b <- c', 'go').map((t) => t.value), ['a', ':=', 'b', '<-', 'c']);
  same(significant('a -> b :: c', 'java').map((t) => t.value), ['a', '->', 'b', '::', 'c']);
});

test('source: bracket pairs and balance detection', () => {
  const language = resolveLanguage({ languageId: 'javascript' });
  const ok = analyze('f(a, [1, {x: 2}]);', language);
  eq(ok.balanced, true);
  eq(ok.match[ok.sig.findIndex((t) => t.value === '[')], ok.sig.findIndex((t) => t.value === ']'));
  eq(analyze('f(a, [1);', language).balanced, false);
  eq(analyze('const s = `open', language).balanced, false);
  eq(analyze('/* never closed', language).balanced, false);
});

/* ------------------------------------------------------------------ */
/* JSONC, glob, flat formats                                           */
/* ------------------------------------------------------------------ */

test('jsonc: comments, trailing commas, single quotes and unquoted keys', () => {
  const text = `// head\n{\n  /* block */ "a": 1, // line\n  b: 'two',\n  "c": [1, 2, ],\n  "d": { "e": null, },\n}\n`;
  const { value, error } = parseJsonc(text);
  eq(error, null);
  same(value, { a: 1, b: 'two', c: [1, 2], d: { e: null } });
});

test('jsonc: errors come back as messages, never as exceptions', () => {
  yes(parseJsonc('{ "a": }').error.includes('line 1'));
  yes(parseJsonc('{ "a": 1 } x').error.includes('after the value'));
  yes(parseJsonc('').error);
  eq(parseJsonc('﻿[1]').value[0], 1);
  eq(parseJsonc('"a\\u0041\\n"').value, 'aA\n');
});

test('glob: *, **, ? and braces', () => {
  yes(matchGlob('*.min.js', 'dist/app.min.js'));
  yes(matchGlob('dist/**', 'dist/a/b.js'));
  yes(!matchGlob('dist/**', 'src/dist.js'));
  yes(matchGlob('src/**/*.ts', 'src/a/b/c.ts'));
  yes(matchGlob('src/**/*.ts', 'src/c.ts'));
  yes(matchGlob('?.js', 'a.js'));
  yes(!matchGlob('?.js', 'ab.js'));
  yes(matchGlob('*.{ts,tsx}', 'a/b.tsx'));
  yes(!matchGlob('*.{ts,tsx}', 'a/b.js'));
});

test('glob: anchoring, directory patterns and odd input', () => {
  yes(matchGlob('/build', 'build/x.js'));
  yes(!matchGlob('/build', 'src/build/x.js'));
  yes(matchGlob('generated/', 'generated/x.js'));
  yes(!matchGlob('', 'a'));
  yes(globToRegExp('{broken').test('{broken') || true);
  yes(matchGlob('[a-c].js', 'b.js'));
});

test('flat yaml and toml read top-level scalars and skip the rest', () => {
  const yaml = parseFlatYaml(`# prettier\n---\ntabWidth: 2\nuseTabs: false\nsemi: true # comment\nsingleQuote: 'yes'\nendOfLine: "lf"\noverrides:\n  - files: "*.ts"\n    options:\n      tabWidth: 8\nplugins:\n  - foo\n`);
  same(yaml, { tabWidth: 2, useTabs: false, semi: true, singleQuote: 'yes', endOfLine: 'lf' });
  const toml = parseFlatToml(`tabWidth = 4\nsemi = false # no\nendOfLine = 'crlf'\n\n[[overrides]]\nfiles = "*.ts"\ntabWidth = 8\n`);
  same(toml, { tabWidth: 4, semi: false, endOfLine: 'crlf' });
});

/* ------------------------------------------------------------------ */
/* .pureline                                                           */
/* ------------------------------------------------------------------ */

test('.pureline: the documented schema parses without notes', () => {
  const { config, notes } = parsePureline(`{
    "pureline": "1.1", "root": true,
    "indent": { "style": "space", "size": 4 }, "endOfLine": "lf", "printWidth": 120,
    "semicolons": true, "finalNewline": true, "trimTrailingWhitespace": true,
    "rules": { "PL-CF-002": "error", "PL-FMT-001": "off", "PL-JS-002": "warn" },
    "languages": { "typescript": { "indent": { "size": 2 } }, "go": { "indent": { "style": "tab" } } },
    "ignore": ["dist/**", "*.min.js"]
  }`);
  same(notes, []);
  eq(config.root, true);
  eq(config.printWidth, 120);
  same(config.rules, { 'PL-CF-002': 'error', 'PL-FMT-001': 'off', 'PL-JS-002': 'warn' });
  same(config.languages.typescript.indent, { size: 2 });
  same(config.ignore, ['dist/**', '*.min.js']);
});

test('.pureline: comments and trailing commas are tolerated', () => {
  const { config, notes } = parsePureline('// my style\n{\n  /* wide */ "printWidth": 100,\n  "rules": { "PL-CF-001": "off", },\n}\n');
  same(notes, []);
  eq(config.printWidth, 100);
  eq(config.rules['PL-CF-001'], 'off');
});

test('.pureline: bad values become notes and fall back', () => {
  const { config, notes } = parsePureline('{ "indent": { "style": "mixed", "size": 99 }, "printWidth": "wide", "endOfLine": "cr", "semicolons": "yes", "bogus": 1 }');
  eq(notes.length, 6);
  yes(notes.some((note) => note.includes('indent.style')));
  yes(notes.some((note) => note.includes('indent.size')));
  yes(notes.some((note) => note.includes('unknown key "bogus"')));
  eq(config.printWidth, undefined);
  eq(config.indent.size, undefined);
});

test('.pureline: broken JSON gives one note and an empty config', () => {
  const { config, notes } = parsePureline('{ "indent": ');
  same(config, {});
  eq(notes.length, 1);
  yes(notes[0].includes('not valid JSON'));
  eq(parsePureline('[1]').notes.length, 1);
});

test('.pureline: unknown rules are reported, known ones accept true/false and aliases', () => {
  const { config, notes } = parsePureline('{ "rules": { "PL-XX-999": "error", "PL-CF-002": false, "PL-JS-002": true, "PL-CF-003": "warning", "PL-JS-001": "loud" } }');
  eq(notes.length, 2);
  yes(notes[0].includes('unknown rule "PL-XX-999"'));
  yes(notes[1].includes('invalid value'));
  eq(config.rules['PL-CF-002'], 'off');
  eq(config.rules['PL-JS-002'], 'warn');
  eq(config.rules['PL-CF-003'], 'warn');
  eq(config.rules['PL-JS-001'], undefined);
});

test('.pureline: languages accept aliases and report unknown ones', () => {
  const { config, notes } = parsePureline('{ "languages": { "ts": { "printWidth": 90 }, "cobol": {}, "go": { "wat": 1 } } }');
  eq(config.languages.typescript.printWidth, 90);
  eq(notes.length, 2);
  yes(notes.some((note) => note.includes('"cobol"')));
});

test('.pureline: shorthand indent and a foreign spec version', () => {
  eq(parsePureline('{ "indent": 2 }').config.indent.size, 2);
  eq(parsePureline('{ "indent": "tab" }').config.indent.style, 'tab');
  yes(parsePureline('{ "pureline": "2.0" }').notes[0].includes('Pureline 1.1'));
  eq(parsePureline('{ "pureline": "1.1" }').notes.length, 0);
});

test('rule catalog: ids are unique and cover the spec', () => {
  eq(new Set(RULES.map((rule) => rule.id)).size, RULES.length);
  for (const id of ['PL-CORE-001', 'PL-CF-003', 'PL-NAME-001', 'PL-JAVA-010', 'PL-JS-006', 'PL-TS-006', 'PL-GO-009', 'PL-CR-007', 'PL-ARCH-001']) {
    yes(isKnownRule(id), id);
  }
  yes(!isKnownRule('PL-CF-004'));
  yes(RULES.find((rule) => rule.id === 'PL-CF-002').fixable);
  eq(levelOf({ rules: { 'PL-CF-002': 'off' } }, 'PL-CF-002'), 'off');
  eq(levelOf({}, 'PL-JS-003'), 'warn');
});

test('config: merge and per-language resolution', () => {
  const parent = parsePureline('{ "indent": { "size": 2 }, "printWidth": 100, "rules": { "PL-CF-002": "error", "PL-FMT-001": "off" }, "languages": { "go": { "printWidth": 90 } } }').config;
  const child = parsePureline('{ "indent": { "style": "tab" }, "rules": { "PL-FMT-001": "info" }, "languages": { "go": { "semicolons": false } } }').config;
  const merged = mergeConfig(parent, child);
  same(merged.indent, { size: 2, style: 'tab' });
  same(merged.rules, { 'PL-CF-002': 'error', 'PL-FMT-001': 'info' });
  same(merged.languages.go, { printWidth: 90, semicolons: false });
  const go = effectiveConfig(merged, 'go');
  eq(go.printWidth, 90);
  eq(go.semicolons, false);
  eq(effectiveConfig(merged, 'java').printWidth, 100);
  eq(indentUnit({ indent: { style: 'tab', size: 4 } }), '\t');
  eq(indentUnit({ indent: { style: 'space', size: 3 } }), '   ');
});

test('defaults: editor options, defaultIndent, Go tabs and Crystal two spaces', () => {
  same(defaultsFor('java', { tabWidth: 2, useTabs: false }, { defaultIndent: '4' }).indent, { style: 'space', size: 4 });
  same(defaultsFor('java', { tabWidth: 2, useTabs: false }, { defaultIndent: 'editor' }).indent, { style: 'space', size: 2 });
  same(defaultsFor('java', { tabWidth: 8, useTabs: true }, { defaultIndent: 'editor' }).indent, { style: 'tab', size: 8 });
  eq(defaultsFor('go', { tabWidth: 2 }, { defaultIndent: '2' }).indent.style, 'tab');
  same(defaultsFor('crystal', { tabWidth: 4 }, { defaultIndent: '4' }).indent, { style: 'space', size: 2 });
  eq(defaultsFor('java', { endOfLine: 'crlf', insertFinalNewline: false }, {}).endOfLine, 'crlf');
  eq(defaultsFor('java', {}, {}).printWidth, 120);
});

test('documented template parses cleanly', () => {
  const { config, notes } = parsePureline(documentedTemplate());
  same(notes, []);
  eq(config.root, true);
  eq(config.indent.size, 4);
});

/* ------------------------------------------------------------------ */
/* Prettier config                                                     */
/* ------------------------------------------------------------------ */

test('prettier: JSON config with overrides resolves per file', () => {
  const parsed = parsePrettierConfig('.prettierrc', '{ "tabWidth": 2, "semi": false, "overrides": [ { "files": "*.ts", "options": { "tabWidth": 4 } }, { "files": ["legacy/**"], "excludeFiles": "legacy/keep/**", "options": { "useTabs": true } } ] }');
  eq(parsed.readable, true);
  same(resolvePrettierOptions(parsed, 'a/b.js'), { tabWidth: 2, semi: false });
  same(resolvePrettierOptions(parsed, 'a/b.ts'), { tabWidth: 4, semi: false });
  same(resolvePrettierOptions(parsed, 'legacy/x.js'), { tabWidth: 2, semi: false, useTabs: true });
  same(resolvePrettierOptions(parsed, 'legacy/keep/x.js'), { tabWidth: 2, semi: false });
});

test('prettier: .prettierrc may be YAML, TOML or JSON5; overrides only count in JSON', () => {
  const yaml = parsePrettierConfig('.prettierrc', 'tabWidth: 3\nsemi: false\noverrides:\n  - files: "*.ts"\n    options:\n      tabWidth: 9\n');
  same(resolvePrettierOptions(yaml, 'a.ts'), { tabWidth: 3, semi: false });
  const toml = parsePrettierConfig('.prettierrc.toml', 'useTabs = true\nprintWidth = 90\n');
  same(resolvePrettierOptions(toml, 'a.ts'), { useTabs: true, printWidth: 90 });
  const json5 = parsePrettierConfig('.prettierrc.json5', "{ tabWidth: 8, // comment\n overrides: [{ files: '*.md', options: { tabWidth: 2 } }], }");
  same(resolvePrettierOptions(json5, 'x.md'), { tabWidth: 2 });
  same(resolvePrettierOptions(json5, 'x.js'), { tabWidth: 8 });
});

test('prettier: package.json key, script configs and broken files', () => {
  const pkg = parsePrettierConfig('package.json', '{ "name": "x", "prettier": { "tabWidth": 6 } }', true);
  eq(pkg.readable, true);
  eq(pkg.options.tabWidth, 6);
  eq(parsePrettierConfig('package.json', '{ "prettier": "@org/config" }', true).readable, false);
  eq(parsePrettierConfig('prettier.config.mjs', 'export default {}').readable, false);
  eq(parsePrettierConfig('.prettierrc.cjs', 'module.exports = {}').readable, false);
  const broken = parsePrettierConfig('.prettierrc.json', '{ nope');
  eq(broken.readable, false);
  yes(broken.error);
});

test('prettier: options map to Pureline settings', () => {
  same(prettierToPureline({ tabWidth: 2, useTabs: false, semi: false, printWidth: 100, endOfLine: 'crlf', singleQuote: true }), {
    indent: { size: 2, style: 'space' }, semicolons: false, printWidth: 100, endOfLine: 'crlf',
  });
  eq(prettierToPureline({ endOfLine: 'auto' }).endOfLine, 'keep');
  same(prettierToPureline({ tabWidth: 'x' }), {});
});

test('prettier: .prettierignore follows gitignore rules', () => {
  const entries = parseIgnoreFile('# comment\n\ndist\n/build\n*.min.js\ndocs/generated/\n!docs/generated/keep.md\nsrc/**/vendor/*\n');
  yes(isIgnoredBy(entries, 'dist/a.js'));
  yes(isIgnoredBy(entries, 'pkg/dist/a.js'));
  yes(isIgnoredBy(entries, 'build/a.js'));
  yes(!isIgnoredBy(entries, 'pkg/build/a.js'));
  yes(isIgnoredBy(entries, 'lib/app.min.js'));
  yes(isIgnoredBy(entries, 'docs/generated/x.md'));
  yes(!isIgnoredBy(entries, 'docs/generated/keep.md'));
  yes(isIgnoredBy(entries, 'src/a/b/vendor/x.js'));
  yes(!isIgnoredBy(entries, 'src/main.js'));
});

/* ------------------------------------------------------------------ */
/* Brace fix (PL-CF-003 / PL-JS-001)                                   */
/* ------------------------------------------------------------------ */

test('braces: single statements get blocks, one line or two', () => {
  formats('if (!valid) return;\n', 'if (!valid) {\n    return;\n}\n', 'java');
  formats('if (!valid)\n    return;\n', 'if (!valid) {\n    return;\n}\n', 'java');
  formats('for (int i = 0; i < n; i++) sum += i;\n', 'for (int i = 0; i < n; i++) {\n    sum += i;\n}\n', 'java');
  formats('while (running) tick();\n', 'while (running) {\n    tick();\n}\n', 'java');
});

test('braces: else, else if and do-while', () => {
  formats('if (a) x(); else if (b) y(); else z();\n', 'if (a) {\n    x();\n} else if (b) {\n    y();\n} else {\n    z();\n}\n', 'java');
  formats('do x++; while (x < 3);\n', 'do {\n    x++;\n} while (x < 3);\n', 'java');
});

test('braces: the dangling else stays with the inner if', () => {
  formats('if (a) if (b) x(); else y();\n', 'if (a) {\n    if (b) {\n        x();\n    } else {\n        y();\n    }\n}\n', 'java');
});

test('braces: nested braceless bodies and labelled blocks', () => {
  formats('for (a of b) for (c of d) go(c);\n', 'for (a of b) {\n    for (c of d) {\n        go(c);\n    }\n}\n', 'javascript');
  formats('if (x) outer: {\n    break outer;\n}\n', 'if (x) {\n    outer: {\n        break outer;\n    }\n}\n', 'java');
});

test('braces: JavaScript statements without a semicolon only when the end is certain', () => {
  formats('if (!user) return\nfoo()\n', 'if (!user) {\n    return;\n}\nfoo();\n', 'javascript');
  const unsure = out('if (a) b = c\n(d)\n', 'javascript');
  eq(unsure.includes('{'), true, 'a call on the next line continues the statement, so it is wrapped whole');
  eq(unsure, 'if (a) {\n    b = c\n    (d);\n}\n');
});

test('braces: comments between header and body leave the statement alone', () => {
  const text = 'if (a) // why\n    return;\n';
  eq(out(text, 'java'), text, 'the braceless body stays, one level in');
});

test('braces: rules turn the fix off', () => {
  const text = 'if (!valid) return;\n';
  eq(out(text, 'java', { rules: { 'PL-CF-003': 'off' } }), text);
  eq(out(text, 'javascript', { rules: { 'PL-JS-001': 'off' } }), 'if (!valid) return;\n');
  eq(out(text, 'go'), text);
});

test('braces: nothing changes inside strings and comments', () => {
  const text = 'String s = "if (a) b();"; // if (x) y();\n/* while (z) w(); */\n';
  eq(out(text, 'java'), text);
});

/* ------------------------------------------------------------------ */
/* Else removal (PL-CF-002 / PL-GO-002)                                */
/* ------------------------------------------------------------------ */

test('else: removed after return, throw, continue and break', () => {
  for (const exit of ['return x;', 'throw err;', 'continue;', 'break;']) {
    const input = `for (const a of b) {\n    if (a) {\n        ${exit}\n    } else {\n        use(a);\n    }\n}\n`;
    const expected = `for (const a of b) {\n    if (a) {\n        ${exit}\n    }\n\n    use(a);\n}\n`;
    formats(input, expected, 'javascript');
  }
});

test('else: else-if chains become separate ifs while branches terminate', () => {
  formats(
    'function f(a) {\n    if (a === 1) {\n        return 1;\n    } else if (a === 2) {\n        return 2;\n    } else {\n        return 3;\n    }\n}\n',
    'function f(a) {\n    if (a === 1) {\n        return 1;\n    }\n\n    if (a === 2) {\n        return 2;\n    }\n\n    return 3;\n}\n',
  );
});

test('else: a branch that does not leave keeps its else (and everything after it)', () => {
  const text = 'function f(a) {\n    if (a === 1) {\n        log(1);\n    } else if (a === 2) {\n        return 2;\n    } else {\n        return 3;\n    }\n}\n';
  eq(out(text, 'javascript'), text);
  const middle = 'function f(a) {\n    if (a === 1) {\n        return 1;\n    } else if (a === 2) {\n        log(2);\n    } else {\n        log(3);\n    }\n}\n';
  eq(out(middle, 'javascript'), 'function f(a) {\n    if (a === 1) {\n        return 1;\n    }\n\n    if (a === 2) {\n        log(2);\n    } else {\n        log(3);\n    }\n}\n');
});

test('else: an if that is itself an else branch is left alone', () => {
  const text = 'function f(a) {\n    if (a) {\n        log(1);\n    } else {\n        if (b) {\n            return 1;\n        } else {\n            log(2);\n        }\n    }\n}\n';
  const result = out(text, 'javascript');
  yes(result.includes('} else {\n        if (b) {'), 'the outer else is kept because its branch does not leave');
  yes(!result.includes('} else {\n            log(2)'), 'the inner else after return is removed');
});

test('else: scope clashes keep the else', () => {
  const clash = 'function f(a) {\n    if (a) {\n        return 1;\n    } else {\n        const x = 2;\n        return x;\n    }\n}\nfunction g() {\n    const x = 1;\n    return x;\n}\n';
  eq(out(clash, 'javascript'), clash);
  const used = 'function f(a) {\n    if (a) {\n        return 1;\n    } else {\n        const x = 2;\n        return x;\n    }\n    console.log(x);\n}\n';
  eq(out(used, 'javascript'), used);
  const free = out('function f(a) {\n    if (a) {\n        return 1;\n    } else {\n        const unique = 2;\n        return unique;\n    }\n}\n', 'javascript');
  yes(!free.includes('else'));
});

test('else: Java, comments and the spec example', () => {
  const guard = 'if (request != null) {\n    if (request.valid()) {\n        var session = sessions.create(request.user());\n        return executor.execute(session, request);\n    } else {\n        return Result.invalid();\n    }\n}\n\nreturn Result.empty();\n';
  formats(guard, 'if (request != null) {\n    if (request.valid()) {\n        var session = sessions.create(request.user());\n        return executor.execute(session, request);\n    }\n\n    return Result.invalid();\n}\n\nreturn Result.empty();\n', 'java');
  const comment = 'if (a) {\n    return;\n} // done\nelse {\n    x();\n}\n';
  eq(out(comment, 'java'), comment);
});

test('else: not inside expressions, not when other code shares the line', () => {
  const ternaryish = 'const f = (a) => { if (a) { return 1; } else { return 2; } };\n';
  eq(out(ternaryish, 'javascript').includes('else'), true);
  const shared = 'if (a) {\n    return;\n} else {\n    x();\n} y();\n';
  eq(out(shared, 'java').includes('else'), true);
});

test('else: Go removes it after terminating branches, but not around init statements', () => {
  formats(
    'func f() error {\n\tif err != nil {\n\t\treturn err\n\t} else {\n\t\tuse(1)\n\t}\n\treturn nil\n}\n',
    'func f() error {\n\tif err != nil {\n\t\treturn err\n\t}\n\n\tuse(1)\n\treturn nil\n}\n',
    'go',
  );
  const init = 'func f() error {\n\tif v, err := get(); err != nil {\n\t\treturn err\n\t} else {\n\t\tuse(v)\n\t}\n\treturn nil\n}\n';
  eq(out(init, 'go'), init);
  const shadow = 'func f() {\n\tx := 0\n\tif ok {\n\t\treturn\n\t} else {\n\t\tx := 1\n\t\tuse(x)\n\t}\n\tuse(x)\n}\n';
  eq(out(shadow, 'go').includes('else'), true, 'a name declared twice keeps the else');
});

test('else: rules turn the fix off', () => {
  const text = 'function f(a) {\n    if (a) {\n        return 1;\n    } else {\n        return 2;\n    }\n}\n';
  eq(out(text, 'javascript', { rules: { 'PL-CF-002': 'off' } }), text);
  const go = 'func f() {\n\tif a {\n\t\treturn\n\t} else {\n\t\tx()\n\t}\n}\n';
  eq(out(go, 'go', { rules: { 'PL-GO-002': 'off' } }), go);
});

/* ------------------------------------------------------------------ */
/* Semicolons (PL-JS-002)                                              */
/* ------------------------------------------------------------------ */

test('semicolons: clear statements get one', () => {
  formats('const a = 1\nlet b = a + 1\nreturnValue(b)\nimport x from "y"\nexport const z = 3\n', 'const a = 1;\nlet b = a + 1;\nreturnValue(b);\nimport x from "y";\nexport const z = 3;\n');
  formats('function f() {\n    return 1\n}\n', 'function f() {\n    return 1;\n}\n');
  formats('function f() { return 1 }\n', 'function f() { return 1; }\n');
});

test('semicolons: multi-line expressions end at their last line', () => {
  formats('const a = foo\n    .bar()\n    .baz()\nconst b = {\n    x: 1,\n}\n', 'const a = foo\n    .bar()\n    .baz();\nconst b = {\n    x: 1,\n};\n');
  formats('const c = a\n    ? b\n    : d\nconst e = [\n    1,\n]\n', 'const c = a\n    ? b\n    : d;\nconst e = [\n    1,\n];\n');
});

test('semicolons: continuation lines never get one in the middle', () => {
  const text = 'const a = b +\n    c\nconst d = e\n(f)\n';
  const result = out(text, 'javascript');
  yes(result.startsWith('const a = b +\n    c;\n'), result);
  yes(!result.includes('e;'), 'a line followed by "(" continues');
});

test('semicolons: declarations that end in a brace stay as they are', () => {
  const text = 'function f() {\n    return 1;\n}\nclass A {\n    m() {\n        return 2;\n    }\n}\nif (a) {\n    b();\n}\n';
  eq(out(text, 'javascript'), text);
});

test('semicolons: class, interface and type bodies keep their style', () => {
  const text = 'class A {\n    a = 1\n    b = 2\n}\ninterface I {\n    a: string\n    b: number\n}\nenum E {\n    A,\n    B\n}\n';
  eq(out(text, 'typescript'), text);
  formats('type A =\n    | "a"\n    | "b"\nexport type B = {\n    x: number\n}\n', 'type A =\n    | "a"\n    | "b";\nexport type B = {\n    x: number\n};\n', 'typescript');
});

test('semicolons: switch cases, trailing comments and existing semicolons', () => {
  formats('switch (a) {\ncase 1:\n    foo()\n    break\n}\n', 'switch (a) {\n    case 1:\n        foo();\n        break;\n}\n');
  formats('foo() // note\nbar();\n', 'foo(); // note\nbar();\n');
});

test('semicolons: off by rule or by config, and never in Java or Go', () => {
  const text = 'const a = 1\n';
  eq(out(text, 'javascript', { rules: { 'PL-JS-002': 'off' } }), text);
  eq(out(text, 'javascript', { semicolons: false }), text);
  eq(out('int a = 1\n', 'java'), 'int a = 1\n');
});

test('semicolons: JSX files only get whitespace fixes', () => {
  const jsx = 'const a = <div>\n    hi\n</div>   \nconst b = 1\n';
  const result = format(jsx, 'javascriptreact');
  eq(result.text, 'const a = <div>\n    hi\n</div>\nconst b = 1\n');
  yes(result.notes.some((note) => note.includes('JSX')));
  yes(format(jsx, 'javascript').notes.some((note) => note.includes('JSX')), 'detected in plain .js too');
});

/* ------------------------------------------------------------------ */
/* Compact calls (PL-FMT-001)                                          */
/* ------------------------------------------------------------------ */

test('calls: vertical arguments collapse when they fit', () => {
  formats('var box = Block.box(\n    min,\n    min,\n    max,\n    max,\n    max,\n    16\n);\n', 'var box = Block.box(min, min, max, max, max, 16);\n', 'java');
  formats('foo(\n    a,\n    b,\n);\n', 'foo(a, b);\n');
  formats('x = new Foo(\n    a\n);\n', 'x = new Foo(a);\n', 'java');
});

test('calls: builder chains, long calls and multi-line arguments stay vertical', () => {
  const chain = 'var server = Server.builder()\n    .host(config.host())\n    .port(config.port())\n    .executor(executor)\n    .build();\n';
  eq(out(chain, 'java'), chain);
  const inner = 'builder\n    .host(\n        a\n    );\n';
  eq(out(inner, 'java'), inner);
  const wide = `call(\n    ${'a'.repeat(70)},\n    ${'b'.repeat(70)}\n);\n`;
  eq(out(wide, 'java'), wide);
  eq(out(wide, 'java', { printWidth: 400 }), `call(${'a'.repeat(70)}, ${'b'.repeat(70)});\n`);
  const object = 'foo(\n    a,\n    {\n        b: 1,\n    }\n);\n';
  eq(out(object, 'javascript'), object);
  const lambda = 'run(\n    () => {\n        work();\n    }\n);\n';
  eq(out(lambda, 'javascript'), lambda);
});

test('calls: comments, declarations and keywords are not collapsed', () => {
  const comment = 'foo(\n    a, // first\n    b\n);\n';
  eq(out(comment, 'java'), comment);
  const declaration = 'void foo(\n    int a,\n    int b\n) {\n    work();\n}\n';
  eq(out(declaration, 'java'), declaration);
  const keyword = 'if (\n    a &&\n    b\n) {\n    work();\n}\n';
  eq(out(keyword, 'java').includes('if (\n'), true);
  const go = 'var (\n\ta = 1\n\tb = 2\n)\n';
  eq(out(go, 'go'), go);
});

test('calls: rule off keeps them vertical', () => {
  const text = 'foo(\n    a,\n    b\n);\n';
  eq(out(text, 'javascript', { rules: { 'PL-FMT-001': 'off' } }), text);
});

/* ------------------------------------------------------------------ */
/* Whitespace and indentation                                          */
/* ------------------------------------------------------------------ */

test('whitespace: trailing blanks, final newline and blank-line runs', () => {
  formats('const a = 1;   \n\n\n\n\nconst b = 2;\t\n\n\n', 'const a = 1;\n\nconst b = 2;\n');
  eq(out('', 'javascript'), '');
  eq(out('\n\n', 'javascript'), '');
  eq(out('a();', 'javascript'), 'a();\n');
  eq(out('a();\n\n\n', 'javascript', { finalNewline: false }), 'a();\n');
  eq(out('a();   ', 'javascript', { trimTrailingWhitespace: false }), 'a();   \n');
});

test('whitespace: line endings follow endOfLine, keep detects the dominant style', () => {
  eq(out('a();\r\nb();\r\n', 'javascript'), 'a();\nb();\n');
  eq(out('a();\nb();\n', 'javascript', { endOfLine: 'crlf' }), 'a();\r\nb();\r\n');
  eq(out('a();\r\nb();\r\nc();\n', 'javascript', { endOfLine: 'keep' }), 'a();\r\nb();\r\nc();\r\n');
  eq(out('a();\nb();\n', 'javascript', { endOfLine: 'keep' }), 'a();\nb();\n');
});

test('indentation: brackets, tabs, other sizes and idempotence', () => {
  const messy = 'function f() {\nif (a) {\nreturn [\n1,\n2,\n];\n}\n}\n';
  const expected = 'function f() {\n    if (a) {\n        return [\n            1,\n            2,\n        ];\n    }\n}\n';
  formats(messy, expected);
  formats(messy, expected.replace(/    /g, '\t'), 'javascript', { indent: { style: 'tab' } });
  formats(messy, expected.replace(/ {4}/g, '  '), 'javascript', { indent: { size: 2 } });
});

test('indentation: continuation lines, chains and ternaries get one extra level', () => {
  formats('const x = foo\n.bar()\n.baz();\nconst y = a +\nb +\nc;\n', 'const x = foo\n    .bar()\n    .baz();\nconst y = a +\n    b +\n    c;\n');
  formats('const v = ok\n? yes\n: no;\n', 'const v = ok\n    ? yes\n    : no;\n');
  formats('foo(function () {\nwork();\n});\n', 'foo(function () {\n    work();\n});\n');
});

test('indentation: a block opened after a multi-line condition hangs from the statement', () => {
  formats('if (a\n&& b) {\nwork();\n}\n', 'if (a\n        && b) {\n    work();\n}\n', 'java');
});

test('indentation: switch bodies sit one level inside their case', () => {
  formats('switch (x) {\ncase 1:\nfoo();\nbreak;\ndefault:\nbar();\n}\n', 'switch (x) {\n    case 1:\n        foo();\n        break;\n    default:\n        bar();\n}\n');
  formats('return switch (state) {\ncase READY -> start();\ncase CLOSED -> stop();\n};\n', 'return switch (state) {\n    case READY -> start();\n    case CLOSED -> stop();\n};\n', 'java');
});

test('indentation: Go aligns case with switch like gofmt', () => {
  formats('func f() {\nswitch x {\ncase 1:\nfoo()\ndefault:\nbar()\n}\n}\n', 'func f() {\n\tswitch x {\n\tcase 1:\n\t\tfoo()\n\tdefault:\n\t\tbar()\n\t}\n}\n', 'go');
  formats('func f() {\nouter:\nfor {\nbreak outer\n}\n}\n', 'func f() {\nouter:\n\tfor {\n\t\tbreak outer\n\t}\n}\n', 'go');
});

test('indentation: template literals, text blocks and raw strings are untouched', () => {
  const template = 'const s = `a\n   b   \n  ${c}`;\nfoo();\n';
  eq(out(template, 'javascript'), template);
  const block = 'class A {\n    String s = """\n        keep   \n      this\n        """;\n}\n';
  eq(out(block, 'java'), block);
  const raw = 'func f() {\n\tx := `a  \n  b`\n\tuse(x)\n}\n';
  eq(out(raw, 'go'), raw);
  eq(out('  const s = `x`;   \n', 'javascript'), 'const s = `x`;\n');
});

test('indentation: block comments move as one block', () => {
  formats('function f() {\n/**\n * One\n * @param a\n */\nreturn 1;\n}\n', 'function f() {\n    /**\n     * One\n     * @param a\n     */\n    return 1;\n}\n');
  formats('function f() {\n        /* a\n           b */\n  return 1;\n}\n', 'function f() {\n    /* a\n       b */\n    return 1;\n}\n');
});

test('indentation: comments hang with the continuation they precede', () => {
  formats('type A =\n    | "a"\n// the second\n    | "b";\n', 'type A =\n    | "a"\n    // the second\n    | "b";\n', 'typescript');
});

test('indentation: unbalanced code is only whitespace-fixed', () => {
  const result = format('function f( {\n   if (a) return   \n', 'javascript');
  eq(result.text, 'function f( {\n   if (a) return\n');
  yes(result.notes.some((note) => note.includes('balance')));
});

test('languages: unsupported ids give a note, Kotlin and Crystal only get whitespace', () => {
  const unknown = format('x', 'cobol');
  eq(unknown.text, 'x');
  eq(unknown.notes.length, 1);
  eq(out('fun main() {\nval x = 1   \nif (x > 0) println("a")\n}\n', 'kotlin'), 'fun main() {\n    val x = 1\n    if (x > 0) println("a")\n}\n');
  eq(out('def foo(x)   \n  x\nend\n\n\n\nputs 1\n', 'crystal'), 'def foo(x)\n  x\nend\n\nputs 1\n');
  const heredoc = 'puts <<-EOS\n  raw   \n\n\n  EOS\n';
  eq(out(heredoc, 'crystal'), heredoc);
});

/* ------------------------------------------------------------------ */
/* Range formatting                                                    */
/* ------------------------------------------------------------------ */

test('range: lines outside the selection stay byte-identical', () => {
  const text = 'function a() {\n  if (x) return 1\n}\n\nfunction b() {\n  if (y) return 2   \n}\n';
  const from = text.indexOf('function b');
  const result = out(text, 'javascript', {}, { range: { from, to: text.length } });
  yes(result.startsWith('function a() {\n  if (x) return 1\n}\n\nfunction b() {\n'), result);
  yes(result.includes('if (y) {\n        return 2;\n    }'), result);
});

test('range: a structural change is applied whole or not at all', () => {
  const text = 'function f(a) {\n  if (a) {\n    return 1\n  } else {\n    return 2\n  }\n}\n';
  const withinElse = text.indexOf('return 2');
  const result = out(text, 'javascript', {}, { range: { from: withinElse, to: withinElse + 3 } });
  yes(!result.includes('else'), 'the whole else block was rewritten');
  eq((result.match(/{/g) ?? []).length, (result.match(/}/g) ?? []).length, 'braces still balance');
  const outside = out(text, 'javascript', {}, { range: { from: 0, to: 5 } });
  eq(outside.includes('else'), true);
});

test('range: CRLF documents keep their line endings and offsets', () => {
  const text = 'a();\r\nif (x) return   \r\nb();   \r\n';
  const from = text.indexOf('if');
  const result = out(text, 'javascript', {}, { range: { from, to: from + 2 } });
  eq(result.startsWith('a();\r\n'), true);
  yes(result.includes('b();   \r\n'), 'outside the range the trailing blanks stay');
  yes(result.includes('{\r\n'));
});

/* ------------------------------------------------------------------ */
/* Spec examples as golden tests                                       */
/* ------------------------------------------------------------------ */

test('spec 2: guard clauses, explicit blocks', () => {
  formats('if (!valid) return;\n', 'if (!valid) {\n    return;\n}\n', 'java');
  formats('if (!valid)\n    return;\n', 'if (!valid) {\n    return;\n}\n', 'java');
  const preferred = 'if (!valid) {\n    reject();\n    return;\n}\n\nexecute();\n';
  eq(out(preferred, 'java'), preferred);
  const ternary = 'var state = valid ? State.READY : State.INVALID;\n';
  eq(out(ternary, 'java'), ternary);
});

test('spec 6: compact horizontal calls', () => {
  formats('var box = Block.box(\n    min,\n    min,\n    max,\n    max,\n    max,\n    16\n);\n', 'var box = Block.box(min, min, max, max, max, 16);\n', 'java');
});

test('spec 9: JavaScript profile', () => {
  formats('if (!user) return;\n', 'if (!user) {\n    return;\n}\n');
  formats('const session = createSession(user)\nsession.start()\n', 'const session = createSession(user);\nsession.start();\n');
  const asyncExample = 'async function loadUser(id) {\n    const response = await fetch(`/users/${id}`);\n\n    if (!response.ok) {\n        return null;\n    }\n\n    return response.json();\n}\n';
  eq(out(asyncExample, 'javascript'), asyncExample);
  const arrows = 'function createSession(user) {\n    return new Session(user);\n}\n\nusers.filter(user => user.active());\n';
  eq(out(arrows, 'javascript'), arrows);
  const constFirst = 'let count = 0;\ncount++;\n';
  eq(out(constFirst, 'javascript'), constFirst);
});

test('spec 11: Go error guards and else', () => {
  const guard = 'user, err := loadUser(id)\n\nif err != nil {\n\treturn nil, err\n}\n\nsession := createSession(user)\nreturn session, nil\n';
  eq(out(guard, 'go'), guard);
  formats('func f() {\n\tif err != nil {\n\t\treturn nil, err\n\t} else {\n\t\treturn createSession(user), nil\n\t}\n}\n', 'func f() {\n\tif err != nil {\n\t\treturn nil, err\n\t}\n\n\treturn createSession(user), nil\n}\n', 'go');
});

/* ------------------------------------------------------------------ */
/* Checker                                                             */
/* ------------------------------------------------------------------ */

test('checker: nesting deeper than three levels (PL-CF-001) with positions', () => {
  const text = 'function f() {\n    if (a) {\n        for (const x of xs) {\n            while (b) {\n                if (c) {\n                    go();\n                }\n            }\n        }\n    }\n}\n';
  const found = diagnostics(text, 'javascript').filter((entry) => entry.code === 'PL-CF-001');
  eq(found.length, 1);
  eq(found[0].line, 4);
  eq(found[0].column, 16);
  eq(found[0].source, 'Pureline');
  eq(found[0].severity, 'warning');
  yes(found[0].suggestion);
  eq(diagnostics('if (a) {\n    if (b) {\n        if (c) {\n            x();\n        }\n    }\n}\n', 'java').filter((entry) => entry.code === 'PL-CF-001').length, 0);
});

test('checker: else after a terminating branch is a warning, any other else is info', () => {
  const text = 'function f(a) {\n    if (a) {\n        return 1;\n    } else {\n        go();\n    }\n    if (b) {\n        x();\n    } else {\n        y();\n    }\n}\n';
  const found = diagnostics(text, 'javascript').filter((entry) => entry.code === 'PL-CF-002');
  eq(found.length, 2);
  eq(found[0].severity, 'warning');
  eq(found[0].line, 3);
  eq(found[0].column, 6);
  eq(found[1].severity, 'info');
  eq(found[1].line, 8);
  const go = diagnostics('func f() {\n\tif a {\n\t\treturn\n\t} else {\n\t\tgo()\n\t}\n}\n', 'go');
  same(codes(go).filter((code) => code === 'PL-GO-002'), ['PL-GO-002']);
  eq(go.find((entry) => entry.code === 'PL-GO-002').column, 3);
});

test('checker: braceless bodies, semicolons and vertical calls point at the right place', () => {
  const found = diagnostics('if (a) return\nfoo(\n    1,\n    2\n);\n', 'javascript');
  const braces = found.find((entry) => entry.code === 'PL-JS-001');
  eq(braces.line, 0);
  eq(braces.column, 0);
  eq(braces.endColumn, 6);
  const semicolon = found.find((entry) => entry.code === 'PL-JS-002' && entry.line === 0);
  eq(semicolon.column, 12);
  const vertical = found.find((entry) => entry.code === 'PL-FMT-001');
  eq(vertical.line, 1);
  eq(vertical.column, 0);
  eq(vertical.severity, 'info');
  eq(codes(diagnostics('if (a) return;\n', 'java'))[0], 'PL-CF-003');
});

test('checker: names (PL-NAME-001)', () => {
  const found = diagnostics('const tmp = 1;\nfor (let i = 0; i < 3; i++) {\n    use(i);\n}\ntry {\n    run();\n} catch (e) {\n    log(e);\n}\nfunction f(x, user) {\n    return user;\n}\n', 'javascript').filter((entry) => entry.code === 'PL-NAME-001');
  same(found.map((entry) => [entry.line, entry.column]), [[0, 6], [9, 11]]);
  const go = diagnostics('func f(ctx context.Context) error {\n\tvar err error\n\tx := 1\n\tconn := open()\n\t_ = conn\n\treturn err\n}\n', 'go').filter((entry) => entry.code === 'PL-NAME-001');
  same(go.map((entry) => entry.line), [2]);
});

test('checker: functions (PL-FN-001) by size and vague names', () => {
  const body = (count) => Array.from({ length: count }, (_, index) => `    step${index}();`).join('\n');
  const long = diagnostics(`function build() {\n${body(55)}\n}\n`, 'javascript').filter((entry) => entry.code === 'PL-FN-001');
  eq(long.length, 1);
  eq(long[0].severity, 'warning');
  const review = diagnostics(`function build() {\n${body(33)}\n}\n`, 'javascript').filter((entry) => entry.code === 'PL-FN-001');
  eq(review[0].severity, 'info');
  eq(diagnostics(`function build() {\n${body(10)}\n}\n`, 'javascript').filter((entry) => entry.code === 'PL-FN-001').length, 0);
  const vague = diagnostics('function doStuff() {\n    run();\n}\nconst process = () => {\n    run();\n};\n', 'javascript').filter((entry) => entry.code === 'PL-FN-001');
  same(vague.map((entry) => entry.line), [0, 3]);
});

test('checker: classes over 200 lines (PL-STRUCT-001)', () => {
  const body = Array.from({ length: 205 }, (_, index) => `    m${index}() {}`).join('\n');
  const found = diagnostics(`class Huge {\n${body}\n}\n`, 'typescript').filter((entry) => entry.code === 'PL-STRUCT-001');
  eq(found.length, 1);
  eq(found[0].line, 0);
  eq(found[0].column, 6);
  eq(diagnostics('class Small {\n    m() {}\n}\n', 'typescript').filter((entry) => entry.code === 'PL-STRUCT-001').length, 0);
});

test('checker: comments that restate the code (PL-DOC-001)', () => {
  const found = diagnostics('// Check if the player exists\nif (player == null) {\n    return;\n}\n// Workaround for a bug in the proxy (see #12)\nfoo();\n', 'javascript').filter((entry) => entry.code === 'PL-DOC-001');
  eq(found.length, 1);
  eq(found[0].line, 0);
  eq(found[0].severity, 'hint');
  eq(diagnostics('# Get the user\nx = 1\n', 'crystal').filter((entry) => entry.code === 'PL-DOC-001').length, 1);
});

test('checker: JavaScript profile (PL-JS-003, PL-JS-004)', () => {
  const found = diagnostics('var a = 1;\nlet b = 2;\nlet c = 3;\nc += 1;\nfetch(u).then(r => r);\n', 'javascript');
  const varDiag = found.find((entry) => entry.code === 'PL-JS-003' && entry.line === 0);
  eq(varDiag.severity, 'error');
  eq(varDiag.column, 0);
  const lets = found.filter((entry) => entry.code === 'PL-JS-003' && entry.line !== 0);
  same(lets.map((entry) => entry.line), [1]);
  eq(lets[0].severity, 'warning');
  const then = found.find((entry) => entry.code === 'PL-JS-004');
  eq(then.line, 4);
  eq(then.severity, 'hint');
});

test('checker: TypeScript profile (PL-TS-001, PL-TS-003, PL-TS-005)', () => {
  const found = diagnostics('interface IUser {\n    id: any;\n}\nconst v = x as any;\nconst w = <any>y;\nenum Color {\n    Red,\n}\n', 'typescript');
  same(found.filter((entry) => entry.code === 'PL-TS-001').map((entry) => [entry.line, entry.column]), [[1, 8], [3, 15], [4, 11]]);
  same(found.filter((entry) => entry.code === 'PL-TS-003').map((entry) => [entry.line, entry.column]), [[0, 10]]);
  eq(found.find((entry) => entry.code === 'PL-TS-005').severity, 'hint');
  eq(codes(diagnostics('interface IUser {}\nlet a: any;\n', 'javascript')).includes('PL-TS-003'), false, 'TypeScript rules do not apply to JavaScript');
});

test('checker: Java profile (PL-JAVA-002 to 005)', () => {
  const text = 'import java.util.List;\npublic class Point {\n    private final int x;\n    private final int y;\n    public Point(int x, int y) { this.x = x; this.y = y; }\n    public int getX() { return x; }\n    public int getY() { return y; }\n}\ninterface Shape {}\ninterface IShape {}\nclass A {\n    void f(java.util.concurrent.CompletableFuture<String> future) {\n        Objects.requireNonNull(future);\n    }\n}\n';
  const found = diagnostics(text, 'java');
  same(found.filter((entry) => entry.code === 'PL-JAVA-002').map((entry) => entry.line), [8]);
  eq(found.find((entry) => entry.code === 'PL-JAVA-003').line, 1);
  const fqcn = found.find((entry) => entry.code === 'PL-JAVA-005');
  eq(fqcn.line, 11);
  eq(fqcn.column, 11);
  eq(found.find((entry) => entry.code === 'PL-JAVA-004').line, 12);
  eq(found.filter((entry) => entry.code === 'PL-JAVA-005').length, 1, 'the import line is not a violation');
  eq(codes(diagnostics('class Mutable {\n    private int x;\n    int getX() { return x; }\n}\n', 'java')).includes('PL-JAVA-003'), false);
});

test('checker: Crystal else (PL-CR-002) and the "I prefix" stays Java-only', () => {
  const found = diagnostics('def foo(x)\n  if x\n    1\n  else\n    2\n  end\n  case x\n  when 1\n    3\n  else\n    4\n  end\nend\n', 'crystal');
  same(found.map((entry) => [entry.code, entry.line, entry.column]), [['PL-CR-002', 3, 2]]);
  eq(found[0].severity, 'info');
  eq(codes(diagnostics('interface Shape {}\n', 'typescript')).includes('PL-JAVA-002'), false);
});

test('checker: severities and off come from .pureline', () => {
  const text = 'function f(a) {\n    if (a) {\n        return 1;\n    } else {\n        go();\n    }\n}\n';
  eq(diagnostics(text, 'javascript', { rules: { 'PL-CF-002': 'error' } }).find((entry) => entry.code === 'PL-CF-002').severity, 'error');
  eq(codes(diagnostics(text, 'javascript', { rules: { 'PL-CF-002': 'off' } })).includes('PL-CF-002'), false);
  eq(codes(diagnostics('var a = 1\n', 'javascript', { rules: { 'PL-JS-002': 'off', 'PL-JS-003': 'off' } })).length, 1, 'only PL-NAME-001 is left');
  eq(codes(diagnostics('const a = 1\n', 'javascript', { semicolons: false })).includes('PL-JS-002'), false);
});

test('checker: robust against broken code, JSX and unsupported languages', () => {
  same(diagnostics('function f( {', 'javascript').filter((entry) => entry.code !== 'PL-DOC-001'), []);
  same(diagnostics('x', 'cobol'), []);
  same(diagnostics('fun main() {}', 'kotlin'), []);
  const jsx = 'const a = <div>\n    hi\n</div>\nconst b = 1\n';
  eq(codes(diagnostics(jsx, 'javascriptreact')).includes('PL-JS-002'), false);
  eq(diagnostics('if (a) return;\r\nfoo();\r\n', 'java')[0].line, 0);
});

test('checker: guard-clause code is clean', () => {
  const clean = 'async function loadUser(id) {\n    const response = await fetch(`/users/${id}`);\n\n    if (!response.ok) {\n        return null;\n    }\n\n    return response.json();\n}\n';
  same(diagnostics(clean, 'javascript'), []);
});

/* ------------------------------------------------------------------ */
/* Crystal helpers                                                     */
/* ------------------------------------------------------------------ */

test('crystal: heredocs and multi-line strings are protected', () => {
  const text = 'a = <<-EOS\n  one  \n  two\n  EOS\nb = "x\ny"\nc = 1\n';
  const { startsInside, endsInside } = crystalLiteralLines(text);
  same([...startsInside].sort(), [1, 2, 3, 5]);
  same([...endsInside].sort(), [1, 2, 4]);
  same(crystalElses('x = 1\nif a\nelse\nend\n'), [{ line: 2, column: 0, length: 4 }]);
});

/* ------------------------------------------------------------------ */
/* Engine selection, Prettier runner, external formatters              */
/* ------------------------------------------------------------------ */

async function withFolder(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-formatter-'));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function put(root, relative, content = '') {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return file;
}

function fakeCtx({ exec, settings = {}, root = null, platform = 'linux' } = {}) {
  const notifications = [];
  const calls = [];
  const ctx = {
    platform,
    notifications,
    calls,
    log() {},
    ui: { notify: (message, tone) => notifications.push([message, tone]) },
    workspace: { root: () => root },
    settings: { get: (key) => settings[key], all: () => settings },
    exec: async (command, args, options) => {
      calls.push({ command, args, options });
      if (!exec) { throw new Error('spawn ENOENT'); }
      return exec(command, args, options);
    },
  };
  return ctx;
}

const FORMAT_OPTIONS = { tabWidth: 2, useTabs: false, endOfLine: 'lf', trimTrailingWhitespace: true, insertFinalNewline: true };

const request = (root, relative, text, languageId, extra = {}) => ({
  path: path.join(root, relative), languageId, text, options: FORMAT_OPTIONS, workspace: root, ...extra,
});

test('engines: no config means the Pureline defaults', async () => {
  await withFolder(async (root) => {
    const file = await put(root, 'src/a.js', 'x');
    const ctx = fakeCtx({ root, settings: { defaultIndent: '4' } });
    const engines = createEngines(ctx, () => ctx.settings.all());
    const decision = await engines.decide({ path: file, languageId: 'javascript' }, root);
    eq(decision.engine, 'pureline');
    eq(decision.source, 'defaults');
    const result = await engines.format(request(root, 'src/a.js', 'if (a) return\n', 'javascript'));
    eq(result.text, 'if (a) {\n    return;\n}\n');
    eq(result.engine, 'Pureline 1.1 (defaults)');
    eq(result.notes, undefined);
  });
});

test('engines: defaultIndent "editor" uses the request options', async () => {
  await withFolder(async (root) => {
    const ctx = fakeCtx({ root, settings: { defaultIndent: 'editor' } });
    const engines = createEngines(ctx, () => ctx.settings.all());
    const result = await engines.format(request(root, 'a.js', 'if (a) return;\n', 'javascript'));
    eq(result.text, 'if (a) {\n  return;\n}\n');
  });
});

test('engines: the nearest folder wins, .pureline beats Prettier within one folder', async () => {
  await withFolder(async (root) => {
    await put(root, '.pureline', '{ "indent": { "size": 8 } }');
    await put(root, 'sub/.prettierrc', '{ "tabWidth": 3 }');
    await put(root, 'both/.pureline', '{ "indent": { "size": 2 }, "root": true }');
    await put(root, 'both/.prettierrc', '{ "tabWidth": 3 }');
    const ctx = fakeCtx({ root });
    const engines = createEngines(ctx, () => ({}));
    const deep = await engines.decide({ path: path.join(root, 'sub/a.js'), languageId: 'javascript' }, root);
    eq(deep.engine, 'pureline', 'no Prettier installed here: falls back to Pureline');
    eq(deep.source, 'prettier-fallback');
    const both = await engines.decide({ path: path.join(root, 'both/a.js'), languageId: 'javascript' }, root);
    eq(both.engine, 'pureline');
    eq(both.source, '.pureline');
    const top = await engines.decide({ path: path.join(root, 'a.js'), languageId: 'javascript' }, root);
    eq(top.chain.files.length, 1);
    eq((await engines.format(request(root, 'both/a.js', 'if (a) return;\n', 'javascript'))).text, 'if (a) {\n  return;\n}\n');
  });
});

test('engines: .pureline inheritance and root', async () => {
  await withFolder(async (root) => {
    await put(root, '.pureline', '{ "printWidth": 90, "indent": { "size": 2 }, "rules": { "PL-CF-002": "error" } }');
    await put(root, 'a/.pureline', '{ "indent": { "size": 3 } }');
    await put(root, 'b/.pureline', '{ "root": true, "rules": { "PL-FMT-001": "off" } }');
    const inherited = await loadPurelineChain(path.join(root, 'a'), root);
    eq(inherited.files.length, 2);
    const config = effectiveConfig(inherited.config, 'javascript');
    eq(config.indent.size, 3);
    eq(config.printWidth, 90);
    eq(config.rules['PL-CF-002'], 'error');
    const rooted = await loadPurelineChain(path.join(root, 'b'), root);
    eq(rooted.files.length, 1);
    eq(effectiveConfig(rooted.config, 'javascript').printWidth, 120);
    eq(effectiveConfig(rooted.config, 'javascript').rules['PL-CF-002'], undefined);
  });
});

test('engines: ignore globs are relative to their .pureline', async () => {
  await withFolder(async (root) => {
    await put(root, '.pureline', '{ "ignore": ["dist/**", "*.min.js"] }');
    await put(root, 'pkg/.pureline', '{ "ignore": ["gen/*.js"] }');
    const ctx = fakeCtx({ root });
    const engines = createEngines(ctx, () => ({}));
    eq(await engines.format(request(root, 'dist/a.js', 'x\n', 'javascript')), null);
    eq(await engines.format(request(root, 'src/app.min.js', 'x\n', 'javascript')), null);
    eq(await engines.format(request(root, 'pkg/gen/a.js', 'x\n', 'javascript')), null);
    yes(await engines.format(request(root, 'pkg/src/a.js', 'x   \n', 'javascript')));
    const chain = await loadPurelineChain(path.join(root, 'pkg'), root);
    eq(ignoredByChain(chain.files, path.join(root, 'pkg/gen/a.js')), true);
    eq(await engines.check({ ...request(root, 'dist/a.js', 'var a = 1\n', 'javascript') }).then((list) => list.length), 0);
  });
});

test('engines: bad .pureline values come back as notes on the result', async () => {
  await withFolder(async (root) => {
    await put(root, '.pureline', '{ "printWidth": "x", "rules": { "PL-NOPE-1": "error" } }');
    const ctx = fakeCtx({ root });
    const engines = createEngines(ctx, () => ({}));
    const result = await engines.format(request(root, 'a.js', 'a();\n', 'javascript'));
    eq(result.notes.length, 2);
    yes(result.notes.some((note) => note.includes('PL-NOPE-1')));
    eq(result.engine, 'Pureline 1.1 (.pureline)');
  });
});

test('engines: the engine setting forces one', async () => {
  await withFolder(async (root) => {
    await put(root, '.pureline', '{}');
    const prettierFile = await put(root, 'bin/prettier', '#!/bin/sh');
    const exec = async (command, args) => (args.includes('--version') ? { code: 0, stdout: '3.3.2\n', stderr: '', timedOut: false } : { code: 0, stdout: 'PRETTY\n', stderr: '', timedOut: false });
    const forcedPrettier = fakeCtx({ root, exec, settings: { engine: 'prettier', prettierPath: prettierFile } });
    const enginesA = createEngines(forcedPrettier, () => forcedPrettier.settings.all());
    const result = await enginesA.format(request(root, 'a.js', 'a()\n', 'javascript'));
    eq(result.text, 'PRETTY\n');
    eq(result.engine, 'Prettier 3.3.2');
    const forcedPureline = fakeCtx({ root, exec, settings: { engine: 'pureline' } });
    const enginesB = createEngines(forcedPureline, () => forcedPureline.settings.all());
    await put(root, '.prettierrc', '{}');
    eq((await enginesB.decide({ path: path.join(root, 'a.js'), languageId: 'javascript' }, root)).engine, 'pureline');
    eq(await enginesB.format(request(root, 'style.css', 'a{}\n', 'css')), null, 'Pureline cannot format CSS');
  });
});

test('engines: Prettier configs hand the file to Prettier with the documented arguments', async () => {
  await withFolder(async (root) => {
    await put(root, '.prettierrc', '{ "semi": false }');
    await put(root, 'node_modules/.bin/prettier', '#!/bin/sh');
    const exec = async (command, args, options) => {
      if (args.includes('--version')) { return { code: 0, stdout: '3.4.0\n', stderr: '', timedOut: false }; }
      return { code: 0, stdout: `formatted(${options.input.trim()})\n`, stderr: '', timedOut: false };
    };
    const ctx = fakeCtx({ root, exec });
    const engines = createEngines(ctx, () => ({}));
    const result = await engines.format(request(root, 'src/a.ts', 'a  ()', 'typescript'));
    eq(result.text, 'formatted(a  ())\n');
    eq(result.engine, 'Prettier 3.4.0');
    const call = ctx.calls.find((entry) => entry.args.includes('--stdin-filepath'));
    eq(call.command, path.join(root, 'node_modules', '.bin', 'prettier'));
    same(call.args, ['--stdin-filepath', path.join(root, 'src/a.ts')]);
    eq(call.options.cwd, path.join(root, 'src'));
    eq(call.options.input, 'a  ()');
    const ranged = await engines.format(request(root, 'src/a.ts', 'abc', 'typescript', { range: { from: 1, to: 2 } }));
    same(ctx.calls.at(-1).args, ['--stdin-filepath', path.join(root, 'src/a.ts'), '--range-start', '1', '--range-end', '2']);
    eq(ranged.engine, 'Prettier 3.4.0');
  });
});

test('engines: Prettier failures leave the document alone', async () => {
  await withFolder(async (root) => {
    await put(root, '.prettierrc', '{}');
    await put(root, 'node_modules/.bin/prettier', '#!/bin/sh');
    const makeExec = (result) => async (command, args) => (args.includes('--version') ? { code: 0, stdout: '3.0.0\n', stderr: '', timedOut: false } : result);
    const failing = fakeCtx({ root, exec: makeExec({ code: 2, stdout: '', stderr: '[error] a.ts: SyntaxError\n', timedOut: false }) });
    eq(await createEngines(failing, () => ({})).format(request(root, 'a.ts', 'x', 'typescript')), null);
    yes(failing.notifications[0][0].includes('SyntaxError'));
    const noisy = fakeCtx({ root, exec: makeExec({ code: 0, stdout: 'ok', stderr: '[warn] something\n', timedOut: false }) });
    eq(await createEngines(noisy, () => ({})).format(request(root, 'a.ts', 'x', 'typescript')), null);
    const slow = fakeCtx({ root, exec: makeExec({ code: null, stdout: '', stderr: '', timedOut: true }) });
    eq(await createEngines(slow, () => ({})).format(request(root, 'a.ts', 'x', 'typescript')), null);
    yes(slow.notifications[0][0].includes('too long'));
  });
});

test('engines: .prettierignore means "not formatted"', async () => {
  await withFolder(async (root) => {
    await put(root, '.prettierrc', '{}');
    await put(root, '.prettierignore', 'generated/\n*.snap.ts\n');
    await put(root, 'node_modules/.bin/prettier', '#!/bin/sh');
    const exec = async (command, args) => ({ code: 0, stdout: args.includes('--version') ? '3.0.0\n' : 'X\n', stderr: '', timedOut: false });
    const ctx = fakeCtx({ root, exec });
    const engines = createEngines(ctx, () => ({}));
    eq(await engines.format(request(root, 'generated/a.ts', 'a', 'typescript')), null);
    eq(await engines.format(request(root, 'x.snap.ts', 'a', 'typescript')), null);
    eq((await engines.format(request(root, 'src/a.ts', 'a', 'typescript'))).text, 'X\n');
    eq(await engines.format(request(root, 'node_modules/pkg/a.js', 'a', 'javascript')), null);
    eq(ctx.calls.filter((entry) => entry.args.includes('--stdin-filepath')).length, 1);
  });
});

test('engines: a Prettier config without Prettier falls back to Pureline with one note', async () => {
  await withFolder(async (root) => {
    await put(root, '.prettierrc', '{ "tabWidth": 2, "semi": false, "printWidth": 100 }');
    const ctx = fakeCtx({ root });
    const engines = createEngines(ctx, () => ({}));
    const first = await engines.format(request(root, 'a.js', 'if (a) return\n', 'javascript'));
    eq(first.text, 'if (a) {\n  return\n}\n', 'indent 2 and no semicolons come from the Prettier options');
    eq(first.engine, 'Pureline 1.1 (Prettier options)');
    eq(first.notes.length, 1);
    yes(first.notes[0].includes('Prettier is not installed'));
    const second = await engines.format(request(root, 'b.js', 'x = 1\n', 'javascript'));
    eq(second.notes, undefined, 'only once per workspace');
    eq(await engines.format(request(root, 'style.css', 'a{}\n', 'css')), null, 'no Pureline fallback for CSS');
  });
});

test('engines: Prettier-only languages without any config are left to others', async () => {
  await withFolder(async (root) => {
    const ctx = fakeCtx({ root });
    const engines = createEngines(ctx, () => ({}));
    eq(await engines.supportsFormat({ path: path.join(root, 'a.css'), languageId: 'css' }, root), false);
    eq(await engines.supportsFormat({ path: path.join(root, 'a.java'), languageId: 'java' }, root), true);
    eq(await engines.supportsFormat({ path: path.join(root, 'a.py'), languageId: 'python' }, root), false);
    eq(await engines.supportsFormat({ path: null, languageId: 'typescript' }, root), true, 'unsaved tabs work by language id');
  });
});

test('engines: package.json "prettier" key and Prettier detection by folder', async () => {
  await withFolder(async (root) => {
    await put(root, 'pkg/package.json', '{ "name": "x", "prettier": { "tabWidth": 2 } }');
    await put(root, 'other/package.json', '{ "name": "x" }');
    await put(root, 'script/prettier.config.mjs', 'export default {};');
    await put(root, 'yaml/.prettierrc.yaml', 'tabWidth: 2\n');
    eq((await findNearest(path.join(root, 'pkg'), root))?.prettier.name, 'package.json');
    eq(await findNearest(path.join(root, 'other'), root), null);
    eq((await findNearest(path.join(root, 'script'), root))?.prettier.name, 'prettier.config.mjs');
    eq((await findNearest(path.join(root, 'yaml'), root))?.prettier.name, '.prettierrc.yaml');
    eq(await findNearest(path.join(root, 'pkg'), root, 'pureline'), null);
  });
});

test('engines: a file outside the workspace searches up to the filesystem root', async () => {
  await withFolder(async (workspace) => {
    await withFolder(async (elsewhere) => {
      await put(elsewhere, '.pureline', '{ "indent": { "size": 3 } }');
      const ctx = fakeCtx({ root: workspace });
      const engines = createEngines(ctx, () => ({}));
      const result = await engines.format({ path: path.join(elsewhere, 'deep/a.js'), languageId: 'javascript', text: 'if (a) return;\n', options: FORMAT_OPTIONS, workspace });
      eq(result.text, 'if (a) {\n   return;\n}\n');
    });
  });
});

test('engines: Go runs gofmt before and after, Crystal its own formatter', async () => {
  await withFolder(async (root) => {
    const seen = [];
    const exec = async (command, args, options) => {
      seen.push(command);
      if (command === 'gofmt') { return { code: 0, stdout: options.input.replace(/^ +/gm, '\t'), stderr: '', timedOut: false }; }
      if (command === 'crystal') { return { code: 0, stdout: options.input.toUpperCase(), stderr: '', timedOut: false }; }
      throw new Error('ENOENT');
    };
    const ctx = fakeCtx({ root, exec });
    const engines = createEngines(ctx, () => ({}));
    const go = await engines.format(request(root, 'a.go', 'func f() {\n    if a {\n        return\n    } else {\n        x()\n    }\n}\n', 'go'));
    eq(go.text, 'func f() {\n\tif a {\n\t\treturn\n\t}\n\n\tx()\n}\n');
    eq(seen.filter((command) => command === 'gofmt').length, 2);
    const cr = await engines.format(request(root, 'a.cr', 'puts 1  \n', 'crystal'));
    eq(cr.text, 'PUTS 1\n');
    same(ctx.calls.find((entry) => entry.command === 'crystal').args, ['tool', 'format', '--no-color', '-']);
    const ranged = await engines.format(request(root, 'a.go', 'func f() {}\n', 'go', { range: { from: 0, to: 3 } }));
    yes(ranged);
    eq(seen.filter((command) => command === 'gofmt').length, 2, 'gofmt is skipped for a range');
  });
});

test('engines: missing gofmt or crystal is not an error, a failing one adds a note', async () => {
  await withFolder(async (root) => {
    const ctx = fakeCtx({ root });
    const engines = createEngines(ctx, () => ({}));
    const go = await engines.format(request(root, 'a.go', 'func f() {\nx()\n}\n', 'go'));
    eq(go.text, 'func f() {\n\tx()\n}\n');
    eq(go.notes, undefined);
    const failing = fakeCtx({ root, exec: async () => ({ code: 1, stdout: '', stderr: 'syntax error in STDIN:1:1\n', timedOut: false }) });
    const result = await createEngines(failing, () => ({})).format(request(root, 'a.cr', 'puts 1\n', 'crystal'));
    eq(result.text, 'puts 1\n');
    yes(result.notes[0].includes('syntax error'));
  });
});

test('engines: the checker runs for Pureline files only and follows checkOnType', async () => {
  await withFolder(async (root) => {
    const settings = { checkOnType: 'true' };
    const ctx = fakeCtx({ root, settings });
    const engines = createEngines(ctx, () => settings);
    const file = { path: path.join(root, 'a.js'), languageId: 'javascript' };
    eq(await engines.supportsCheck(file, root), true);
    eq((await engines.check({ ...file, text: 'var a = 1;\n', workspace: root })).some((entry) => entry.code === 'PL-JS-003'), true);
    settings.checkOnType = 'false';
    eq(await engines.supportsCheck(file, root), false);
    eq((await engines.check({ ...file, text: 'var a = 1;\n', workspace: root })).length, 0);
    settings.checkOnType = 'true';
    await put(root, '.prettierrc', '{}');
    await put(root, 'node_modules/.bin/prettier', '#!/bin/sh');
    const withPrettier = fakeCtx({ root, settings, exec: async () => ({ code: 0, stdout: '3.0.0\n', stderr: '', timedOut: false }) });
    eq(await createEngines(withPrettier, () => settings).supportsCheck(file, root), false, 'a Prettier project is not checked against Pureline');
    eq(await engines.supportsCheck({ path: path.join(root, 'a.kt'), languageId: 'kotlin' }, root), false);
  });
});

test('engines: .pureline severities reach the checker', async () => {
  await withFolder(async (root) => {
    await put(root, '.pureline', '{ "rules": { "PL-JS-003": "error", "PL-NAME-001": "off" } }');
    const ctx = fakeCtx({ root });
    const engines = createEngines(ctx, () => ({}));
    const found = await engines.check({ ...request(root, 'a.js', 'let a = 1;\nconst tmp = 2;\n', 'javascript') });
    eq(found.find((entry) => entry.code === 'PL-JS-003').severity, 'error');
    eq(found.some((entry) => entry.code === 'PL-NAME-001'), false);
  });
});

/* ------------------------------------------------------------------ */
/* Reports, manifest, house style                                      */
/* ------------------------------------------------------------------ */

test('reports: the explain document names engine, files, options and rules', async () => {
  await withFolder(async (root) => {
    const file = await put(root, '.pureline', '{ "indent": { "size": 2 }, "rules": { "PL-CF-002": "error" }, "ignore": ["dist/**"] }');
    const ctx = fakeCtx({ root });
    const engines = createEngines(ctx, () => ({}));
    const target = { path: path.join(root, 'a.ts'), languageId: 'typescript' };
    const decision = await engines.decide(target, root);
    const config = engines.purelineConfig(decision, {});
    const text = explainDocument({ file: target, workspace: root, decision, config, language: decision.language, label: engines.engineLabel(decision) });
    yes(text.includes('Pureline 1.1 (.pureline)'));
    yes(text.includes(file));
    yes(text.includes('2 spaces'));
    yes(text.includes('| PL-CF-002 |'));
    yes(text.includes('`dist/**`'));
    yes(explainDocument({ file: { path: null, languageId: 'cobol' }, decision: null }).includes('none'));
  });
});

test('reports: the rule catalog lists every rule', () => {
  const text = rulesDocument();
  for (const rule of RULES) { yes(text.includes(`| ${rule.id} |`), rule.id); }
  yes(text.includes('PL-CF-002'));
});

test('manifest: id, settings, commands and translations', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(HERE, 'extension.json'), 'utf8'));
  eq(manifest.id, 'addon.formatter');
  eq(manifest.minAppVersion, '0.7.0');
  eq(manifest.category, 'tool');
  eq(manifest.license, 'AGPL-3.0-or-later');
  same(manifest.settings.map((setting) => setting.key), ['engine', 'prettierPath', 'defaultIndent', 'checkOnType', 'showStatus']);
  for (const setting of manifest.settings) { yes(setting.i18n?.en?.label, setting.key); }
  same(manifest.commands.map((command) => command.id), ['format.explain', 'pureline.init', 'pureline.rules']);
  for (const command of manifest.commands) { yes(command.i18n?.en?.title, command.id); }
});

test('main: activate registers the providers and commands against a fake ctx', async () => {
  const { activate } = await import('./main.js');
  const registered = { formatters: [], diagnostics: [], commands: [], status: [] };
  const documents = [];
  const ctx = {
    platform: 'linux',
    log() {},
    exec: async () => { throw new Error('ENOENT'); },
    formatters: { register: (id, provider, options) => registered.formatters.push({ id, provider, options }) },
    diagnostics: { register: (id, provider) => registered.diagnostics.push({ id, provider }) },
    commands: { register: (id, handler) => registered.commands.push({ id, handler }) },
    statusBar: { set: (id, item) => registered.status.push({ id, item }) },
    events: { last: () => ({ kind: 'activeFile', path: path.join(HERE, 'main.js'), languageId: 'javascript' }), on: () => () => {} },
    settings: { get: () => undefined, all: () => ({}), onDidChange: () => () => {} },
    workspace: { root: () => HERE },
    ui: { notify() {}, openDocument: (name, content) => documents.push([name, content]), openFile() {} },
  };
  const dispose = activate(ctx);
  eq(registered.formatters[0].id, 'pureline');
  eq(registered.formatters[0].options.priority, 50);
  eq(await registered.formatters[0].provider.supports({ path: path.join(HERE, 'x.ts'), languageId: 'typescript' }), true);
  same(registered.commands.map((entry) => entry.id), ['format.explain', 'pureline.init', 'pureline.rules']);
  await registered.commands.find((entry) => entry.id === 'pureline.rules').handler();
  yes(documents[0][1].includes('PL-CF-002'));
  await registered.commands.find((entry) => entry.id === 'format.explain').handler();
  yes(documents[1][1].includes('Formatter: active configuration'));
  yes(registered.status.some((entry) => entry.item && entry.item.text.startsWith('Pureline')));
  dispose();
  eq(registered.status.at(-1).item, null);
});

test('house style: no `else` keyword anywhere in the extension code', async () => {
  const files = [];
  const walk = async (folder) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (entry.name === 'node_modules') { continue; }
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) { await walk(full); }
      if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) { files.push(full); }
    }
  };
  await walk(HERE);
  yes(files.length > 20);
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    const words = tokenize(text, 'js').filter((token) => token.type === T.WORD && token.value === 'else');
    eq(words.length, 0, `${path.relative(HERE, file)} uses else`);
    yes(text.includes('SPDX-License-Identifier: AGPL-3.0-or-later'), `${path.relative(HERE, file)} lacks the header`);
  }
});

/* ------------------------------------------------------------------ */

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    process.stdout.write(`✓ ${name}\n`);
  } catch (error) {
    failed++;
    process.stdout.write(`✗ ${name}\n${error.stack}\n`);
  }
}
process.stdout.write(`\n${tests.length - failed}/${tests.length} tests, ${assertions} assertions\n`);
if (failed) { process.exit(1); }
