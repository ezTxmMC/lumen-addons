# Formatter

Formats and checks code in the **Pureline** style, and hands files to
**Prettier** when a project is set up for it.

- **Pureline** (the default): Java, JavaScript, TypeScript (also JSX/TSX), Go and
  Crystal, plus whitespace-only support for Kotlin. The rules of the
  Pureline Specification 1.1 (`PURELINE_SPECIFICATION_1.1.md` in the Lumen repository) — guard
  clauses instead of `else`, explicit blocks, semicolons, compact calls — are
  applied as safe rewrites and reported as diagnostics.
- **Prettier**: used when a Prettier config exists for the file (or the engine is
  forced); it runs from the project, from `prettierPath` or from the PATH.

The extension ships program code, which must be confirmed on install. It runs in
Lumen's main process, needs no npm packages and only starts `gofmt`, `crystal`
and `prettier` — without a shell (Windows aside), with the text on stdin.

Needs Lumen 0.7.0 (formatter and checker providers).

## Which engine formats a file

For every request the extension walks up from the file's folder to the
workspace root (to the filesystem root for a file outside the workspace) and
looks for configuration files. The **nearest folder that has any of them wins**;
inside one folder a `.pureline` beats the Prettier configs.

| Found | Engine |
| --- | --- |
| `.pureline` | Pureline, with that file (and its parents, see `root`) |
| a Prettier config | Prettier (Pureline with the readable Prettier options if Prettier is not installed — a note says so once per workspace) |
| nothing | Pureline defaults |

The `engine` setting (`auto`, `pureline`, `prettier`) forces one. Prettier only
gets file types it supports (js jsx ts tsx mjs cjs mts cts json jsonc json5 css
scss less html vue markdown md mdx yaml yml graphql hbs); other languages always
go to Pureline. A Prettier-only file type (CSS, JSON …) with no Prettier config is
not handled here at all, so other formatters can take it.

The status bar shows the engine for the active file (`Pureline`,
`Pureline · .pureline`, `Prettier`); a click opens **Formatter: Show active
configuration**.

The Pureline checker runs only for files that Pureline formats. A project that
runs on Prettier has chosen its own style and is not checked.

## Pureline defaults

Without a `.pureline` file: indentation from the editor options in the request
(`tabWidth`, `useTabs`) when the setting *Default indentation* is `editor`, a
fixed 2 or 4 spaces otherwise (default **4**, as in the spec's examples). Go
always uses tabs, Crystal two spaces. Print width 120, semicolons, final newline,
trimmed trailing whitespace; line endings follow the editor.

## The `.pureline` file

JSON, with `//` and `/* */` comments and trailing commas. Create one with
**Formatter: Create .pureline file**.

```json
{
  "pureline": "1.1",
  "root": true,
  "indent": { "style": "space", "size": 4 },
  "endOfLine": "lf",
  "printWidth": 120,
  "semicolons": true,
  "finalNewline": true,
  "trimTrailingWhitespace": true,
  "rules": { "PL-CF-002": "error", "PL-FMT-001": "off", "PL-JS-002": "warn" },
  "languages": { "typescript": { "indent": { "size": 2 } }, "go": { "indent": { "style": "tab" } } },
  "ignore": ["dist/**", "*.min.js"]
}
```

| Key | Meaning |
| --- | --- |
| `pureline` | The spec version the file was written for (`"1.1"`). |
| `root` | `true` stops the search for parent `.pureline` files. Without it, values of parent files are inherited and the nearer file overrides them; `indent`, `rules` and `languages` merge key by key. |
| `indent` | `{ "style": "space" \| "tab", "size": 1–16 }` (`2` or `"tab"` work as shorthand). |
| `endOfLine` | `lf`, `crlf` or `keep` (the dominant ending of the file). |
| `printWidth` | 20–1000; limits how far PL-FMT-001 collapses calls. |
| `semicolons` | `false` switches PL-JS-002 off (JavaScript/TypeScript). Existing semicolons are never removed. |
| `finalNewline` | End the file with exactly one line break. |
| `trimTrailingWhitespace` | Strip blanks at the end of lines (never inside template literals, text blocks or raw strings). |
| `rules` | Rule id to `off`, `info`, `warn` or `error` (`true` = the rule's default level, `false` = `off`; `hint` is accepted too). |
| `languages` | Per-language overrides (`java`, `javascript`, `typescript`, `go`, `crystal`, `kotlin`; `js`/`ts` work as aliases) of every key except `pureline`, `root`, `languages` and `ignore`. |
| `ignore` | Globs relative to the folder of the file that lists them (`*`, `**`, `?`, `[a-z]`, `{a,b}`); a pattern without a slash matches the file name at any depth. Ignored files are neither formatted nor checked. |

A rule that is `off` is neither fixed by the formatter nor reported by the
checker. Every other rule that has a safe automatic fix is applied when you
format; the level only decides how the checker reports it. For the brace fix
both `PL-CF-003` and `PL-JS-001` must be on in JavaScript/TypeScript.

Bad input never breaks formatting: unknown keys, wrong value types, unknown rule
ids and unknown languages become *notes* on the format result and the default
stays in force.

## Prettier detection

Detected configs, per folder: `.prettierrc` (JSON or YAML), `.prettierrc.json`,
`.yaml`, `.yml`, `.json5`, `.toml`, `.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, `.mts`,
`prettier.config.js|cjs|mjs|ts|cts|mts` and a `"prettier"` key in `package.json`.

JSON, JSON5, flat YAML and flat TOML configs are *read* (`tabWidth`, `useTabs`,
`semi`, `printWidth`, `endOfLine` feed the Pureline fallback; JSON/JSON5
`overrides` with `files`/`excludeFiles` globs are honoured). JavaScript and
TypeScript configs are never executed — Prettier resolves them itself.
`.prettierignore` (nearest one above the file, `.gitignore` rules) and
`node_modules` mean: not formatted.

Prettier is found in this order: the `prettierPath` setting,
`node_modules/.bin/prettier` from the file's folder upwards, `prettier` on the
PATH. It runs as `prettier --stdin-filepath <file>` in the file's folder
(`--range-start/--range-end` for a selection). A non-zero exit, output on stderr
or a timeout leaves the document alone and shows a message.

## What Pureline formats

Every fix works on tokens (strings, comments, templates, text blocks and raw
strings are never touched), keeps the meaning of the program, is idempotent and
does nothing when it is not sure.

- **Blocks** (PL-CF-003 Java, PL-JS-001 JS/TS): `if`/`else if`/`else`/`for`/
  `while`/`do-while` bodies get braces; the dangling `else` stays with the inner
  `if`. JavaScript statements without a semicolon are only wrapped when their end
  is certain.
- **`else`** (PL-CF-002, PL-GO-002): removed when the branch before it ends in
  `return`, `throw`, `continue` or `break`; `else if` chains become separate
  `if`s. Skipped when the moved body declares a name that exists elsewhere in the
  file or is used around it, for Go `if` with an init statement, and when
  comments sit in between.
- **Semicolons** (PL-JS-002): added at clear statement ends only (balanced
  brackets, the next line cannot continue the statement); never after `}` of
  functions, classes or blocks; class, interface and enum bodies are left alone.
- **Compact calls** (PL-FMT-001): arguments spread one per line collapse onto one
  line when they fit `printWidth`; builder chains, comments, declarations and
  multi-line arguments stay as they are.
- **Whitespace**: trailing blanks, one final newline, line endings, runs of blank
  lines, indentation by bracket depth (continuation lines, ternaries and chains
  one level deeper, `case` bodies one level inside `switch`, block comments move
  as a block).
- **Go**: `gofmt` runs first (and again after a rewrite) when installed.
  **Crystal**: `crystal tool format` runs first when installed; Pureline only
  tidies whitespace and reports `else`. **Kotlin**: whitespace and indentation.
- **Selections** (*Format Selection*): the whole document is formatted in
  memory; only changes that touch the selected lines are applied and a
  structural rewrite (for example removing an `else`) is applied whole or not at
  all.

Files with JSX, or with brackets that do not balance, only get the whitespace
fixes (and a note).

## Rules

`Fix` = the formatter rewrites code; the others are reported by the checker (the
rule ids and titles come from the specification). Levels are the defaults.

| Rule | What | Languages | Level | Fix |
| --- | --- | --- | --- | --- |
| PL-CF-001 | Prefer guard clauses (control flow nested deeper than 3 levels) | all but Crystal | warning | — |
| PL-CF-002 | Avoid else (after a terminating branch: warning, otherwise info) | java, javascript, typescript, go | warning | yes |
| PL-CF-003 | Explicit blocks in brace-based languages | java, javascript, typescript | warning | yes |
| PL-NAME-001 | Names must be meaningful (`i j k` and catch `e` are fine, Go keeps `ctx err wg tx conn …`) | all but Crystal | warning | — |
| PL-FN-001 | One clear responsibility per function (over 30 lines: review, over 50: split; vague names) | all | warning | — |
| PL-STRUCT-001 | One clear responsibility per class or module (over 200 lines) | all | info | — |
| PL-FMT-001 | Prefer compact horizontal calls | all brace languages | info | yes |
| PL-DOC-001 | Comments explain why, not what | all | hint | — |
| PL-JAVA-002 | Interfaces use the `I` prefix (Java only) | java | hint | — |
| PL-JAVA-003 | Prefer records for immutable data | java | hint | — |
| PL-JAVA-004 | Explicit null handling (`Objects.requireNonNull`) | java | info | — |
| PL-JAVA-005 | Use imports instead of fully qualified class names | java | warning | — |
| PL-JS-001 | Braces are mandatory | javascript, typescript | warning | yes |
| PL-JS-002 | Use semicolons | javascript, typescript | warning | yes |
| PL-JS-003 | `const` first, never `var` (`var`: error, never-reassigned `let`: warning) | javascript, typescript | warning | — |
| PL-JS-004 | Prefer async / await | javascript, typescript | hint | — |
| PL-TS-001 | Avoid `any` | typescript | warning | — |
| PL-TS-003 | No Java-style `I` prefix | typescript | warning | — |
| PL-TS-005 | Prefer union types over enums when appropriate | typescript | hint | — |
| PL-GO-002 | Avoid else after terminating branches | go | warning | yes |
| PL-CR-002 | Avoid else | crystal | info | — |

The other rules of the specification (PL-CORE-001 to 020, PL-JAVA-001, 006 to
010, PL-JS-005/006, PL-TS-002/004/006, PL-GO-001, 003 to 009, PL-CR-001, 003 to 007,
PL-ARCH-001) are principles for reviews: they are valid in a `.pureline` but
nothing is reported for them. **Formatter: Show Pureline rule catalog** lists all
of them. A level in `rules` replaces the default for every finding of that rule.

## Settings

| Setting | Meaning |
| --- | --- |
| Formatter engine (`engine`) | `auto`, `pureline` or `prettier`. |
| Path to Prettier (`prettierPath`) | Empty: project `node_modules/.bin/prettier`, then the PATH. |
| Default indentation (`defaultIndent`) | `editor`, `2` or `4` (default `4`); only without a `.pureline`. |
| Pureline checker while typing (`checkOnType`) | Show rule violations as diagnostics. |
| Show the engine in the status bar (`showStatus`) | |

## Commands

- **Formatter: Show active configuration** — opens a document with the engine, the
  config files in use, the resolved options and the active rules.
- **Formatter: Create .pureline file** — writes the documented default file into
  the project root (never overwrites) and opens it.
- **Formatter: Show Pureline rule catalog** — the rules with their ids, levels
  and whether the formatter fixes them.

## Known limitations

- The tokenizer is not a parser. Regex-versus-division and JSX are decided by
  heuristics; a JSX file gets whitespace fixes only.
- Semicolon and brace fixes in JavaScript follow the automatic-semicolon rules
  conservatively: a statement that could continue on the next line is left alone.
- Without `gofmt`, continuation lines in Go may differ from gofmt's style.
- Kotlin has no structural fixes; Crystal's structure belongs to
  `crystal tool format`.
- PL-NAME-001 and PL-FN-001 are heuristics; callback parameters such as `(a, b) =>`
  are reported as `info`.

License: AGPL-3.0-or-later.
