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
 * The Pureline 1.1 rule catalog. One list drives everything: the checker's
 * ids, the validation of `.pureline` files, the "rule catalog" document and
 * the README table.
 *
 *   fixable  the formatter rewrites code for this rule (and `off` turns that off)
 *   checked  the checker reports it (the others are principles for reviews)
 *   severity default level: `warn`, `info` or `hint`
 */

const ALL = ['java', 'javascript', 'typescript', 'go', 'crystal'];
const JS = ['javascript', 'typescript'];

function rule(id, title, languages, extra = {}) {
  return { id, title, languages, fixable: false, checked: false, severity: 'info', ...extra };
}

const CORE_TITLES = [
  'Control flow should be as linear as possible',
  'Avoid else',
  'Prefer guard clauses',
  'Use the clearest control-flow form for the language',
  'Idiomatic language-native shorthand is allowed',
  'Functions should be small and focused',
  'Names must carry meaning',
  'Avoid unnecessary abstractions',
  'Avoid God Classes and God Modules',
  'Prefer immutable state',
  'Prefer modern language features where they improve clarity',
  'Avoid unnecessary vertical formatting',
  'Comments must not compensate for unclear code',
  'Handle invalid and error states early',
  'Keep important side effects visible',
  'Resources must have a clear lifecycle',
  'Prefer framework-native APIs',
  'Avoid magic values',
  'Make dependencies explicit',
  'Optimize hot paths deliberately, not accidentally',
];

const CORE_RULES = CORE_TITLES.map((title, index) => rule(`PL-CORE-${String(index + 1).padStart(3, '0')}`, title, ALL));

export const RULES = Object.freeze([
  ...CORE_RULES,
  rule('PL-CF-001', 'Prefer guard clauses (control flow nested deeper than 3 levels)', ALL, { checked: true, severity: 'warn' }),
  rule('PL-CF-002', 'Avoid else', ['java', 'javascript', 'typescript', 'go'], { checked: true, fixable: true, severity: 'warn' }),
  rule('PL-CF-003', 'Explicit blocks in brace-based languages', ['java', 'javascript', 'typescript'], { checked: true, fixable: true, severity: 'warn' }),
  rule('PL-NAME-001', 'Names must be meaningful', ALL, { checked: true, severity: 'warn' }),
  rule('PL-FN-001', 'One clear responsibility per function', ALL, { checked: true, severity: 'warn' }),
  rule('PL-STRUCT-001', 'One clear responsibility per class or module', ALL, { checked: true, severity: 'info' }),
  rule('PL-FMT-001', 'Prefer compact horizontal calls', ALL, { checked: true, fixable: true, severity: 'info' }),
  rule('PL-DOC-001', 'Comments explain why, not what', ALL, { checked: true, severity: 'hint' }),
  rule('PL-JAVA-001', 'Package by responsibility', ['java']),
  rule('PL-JAVA-002', 'Interfaces use the I prefix', ['java'], { checked: true, severity: 'hint' }),
  rule('PL-JAVA-003', 'Prefer records for immutable data', ['java'], { checked: true, severity: 'hint' }),
  rule('PL-JAVA-004', 'Explicit null handling', ['java'], { checked: true, severity: 'info' }),
  rule('PL-JAVA-005', 'Use imports instead of fully qualified class names', ['java'], { checked: true, severity: 'warn' }),
  rule('PL-JAVA-006', 'Prefer modern Java', ['java']),
  rule('PL-JAVA-007', 'Prefer switch for real state branching', ['java']),
  rule('PL-JAVA-008', 'Do not block main or tick threads', ['java']),
  rule('PL-JAVA-009', 'Streams only when clearer', ['java']),
  rule('PL-JAVA-010', 'Lifecycle symmetry', ['java']),
  rule('PL-JS-001', 'Braces are mandatory', JS, { checked: true, fixable: true, severity: 'warn' }),
  rule('PL-JS-002', 'Use semicolons', JS, { checked: true, fixable: true, severity: 'warn' }),
  rule('PL-JS-003', 'const first, never var', JS, { checked: true, severity: 'warn' }),
  rule('PL-JS-004', 'Prefer async / await', JS, { checked: true, severity: 'hint' }),
  rule('PL-JS-005', 'Arrow functions are contextual', JS),
  rule('PL-JS-006', 'Destructuring must improve clarity', JS),
  rule('PL-TS-001', 'Avoid any', ['typescript'], { checked: true, severity: 'warn' }),
  rule('PL-TS-002', 'Use types deliberately', ['typescript']),
  rule('PL-TS-003', 'No Java-style I prefix', ['typescript'], { checked: true, severity: 'warn' }),
  rule('PL-TS-004', 'interface vs type', ['typescript']),
  rule('PL-TS-005', 'Prefer union types over enums when appropriate', ['typescript'], { checked: true, severity: 'hint' }),
  rule('PL-TS-006', 'Strong types at boundaries, freedom internally', ['typescript']),
  rule('PL-GO-001', 'Error guards', ['go']),
  rule('PL-GO-002', 'Avoid else after terminating branches', ['go'], { checked: true, fixable: true, severity: 'warn' }),
  rule('PL-GO-003', 'Naming must remain idiomatic', ['go']),
  rule('PL-GO-004', 'Short receiver names are allowed', ['go']),
  rule('PL-GO-005', 'Small interfaces', ['go']),
  rule('PL-GO-006', 'Define interfaces near consumers', ['go']),
  rule('PL-GO-007', 'Use defer for clear resource lifecycles', ['go']),
  rule('PL-GO-008', 'Goroutines need ownership', ['go']),
  rule('PL-GO-009', 'Avoid premature interface abstraction', ['go']),
  rule('PL-CR-001', 'Idiomatic postfix guards are allowed', ['crystal']),
  rule('PL-CR-002', 'Avoid else', ['crystal'], { checked: true, severity: 'info' }),
  rule('PL-CR-003', 'Idiomatic naming', ['crystal']),
  rule('PL-CR-004', 'Prefer type inference', ['crystal']),
  rule('PL-CR-005', 'Explicit nil guards', ['crystal']),
  rule('PL-CR-006', 'Exceptions are for exceptional states', ['crystal']),
  rule('PL-CR-007', 'Avoid macro cleverness without need', ['crystal']),
  rule('PL-ARCH-001', 'Abstraction requires a reason', ALL),
]);

const BY_ID = new Map(RULES.map((entry) => [entry.id, entry]));

export function ruleById(id) {
  return BY_ID.get(id) ?? null;
}

export function isKnownRule(id) {
  return BY_ID.has(id);
}

/** Levels a `.pureline` file may give a rule. */
export const SEVERITY_LEVELS = Object.freeze(['off', 'hint', 'info', 'warn', 'error']);

const TO_CHECK_SEVERITY = { error: 'error', warn: 'warning', info: 'info', hint: 'hint' };

export function toCheckSeverity(level) {
  return TO_CHECK_SEVERITY[level] ?? 'info';
}

/**
 * The level of a rule under `config.rules`: the explicit entry, otherwise the
 * catalog default. `off` means the rule is neither fixed nor reported.
 */
export function levelOf(config, id) {
  const configured = config?.rules?.[id];
  if (configured) { return configured; }
  return ruleById(id)?.severity ?? 'info';
}

export function isRuleOn(config, id) {
  return levelOf(config, id) !== 'off';
}
