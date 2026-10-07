# nvh-markdown

Support for [nvh-markdown](https://github.com/ezTxmMC/nvh-markdown), the Markdown library of
[Novus](https://github.com/ezTxmMC/novus): the `.nvmd` language (Markdown with Novus in it, like
`.mdx` with JSX) and the generator that turns `Page.nvmd` into `Page.nvh`.

## What it does

- **Language `.nvmd`** with its own highlighting: Markdown (headings, emphasis, code spans,
  fences coloured per language, links, lists, tables, task lists, block quotes), `:::note|tip|warning|danger`
  containers, the `---` frontmatter, the `<?nv ... ?>` header as Novus, `{expr}`,
  `{#if}` / `{:else}` / `{/if}`, `{#for}` / `{/for}`, `{@html}` and `<Component>` tags. Braces in code
  spans and fences stay plain, as in the generator.
- **Commands** (command palette, category *nvh-markdown*): generate the `.nvh` of the open file,
  generate all `.nvmd` of the project, show the generated `.nvh`, generate and check the program,
  watch in a terminal, remove the generated files. They run `novusc run nvmd.nv ...`.
- **Settings**: path of `novusc`, the generator's `nvmd.nv` (found automatically in `nvh-markdown/` in or
  next to the project, in the `replace` target of `project.nv`, or in the copy `novusc deps` fetched into
  `~/.novus/deps`), content folders, main file for *check*, `--force`, *generate on save* and
  *check while typing*.
- **Problems**: generator errors (`error: file:line: message`) show up as problems of the `.nvmd` file —
  after a generate/check run, and live with *Check while typing*.
- **Typing**: `<?nv` and `<?=` close themselves (`<?nv  ?>`), brackets, quotes and backticks pair up (no `'`, which
  prose uses as an apostrophe). A word inside `<?nv ?>`, `{expr}` and event handlers follows Novus (`count-c` is
  `count` minus `c`), in Markdown text and tags it keeps `-` and `:`. `:::` does not close itself, because typing
  the closing `:::` would open a new container.
- **Snippets**: scoped to where they belong (`prop`, `ref` and `import` only inside the `<?nv ?>` header; containers,
  components, table and fences only in Markdown text), containers, `<Callout>`, `<CodeBlock>`, `<Toc>`, `<Markdown>`, frontmatter, `<?nv ?>` header with
  `prop` and import, `{#if}`, `{#for}`, `{@html}`, table, task list and code fences per language. The components also come to `.nvh` files as snippets (`<Callout>`, `<CodeBlock>`,
  `<Toc>`, `<Markdown>`, only in `*.nvh` template text).
- **Project template** *nvh-markdown page* (`project.nv` with the `require`, `main.nv`, `Page.nvmd`,
  a `Callout` component) and a project kind that recognises a `project.nv` requiring nvh-markdown.
- **A docs page** with the dialect, the `markdown.*` API and the `.nvmd` syntax.

## What it does not do

- No language server: `novus-lsp` serves `.nv` and `.nvh`, not `.nvmd`.
- No output folder setting: the generator writes each `.nvh` next to its `.nvmd`.
- The highlighting is a tokenizer built into Lumen (`nvmd`), not shipped by this add-on.
- The project kind's tasks are `novusc run`, `check` and `deps`; generating goes through the commands,
  because where `nvmd.nv` lives depends on the project.

Needs `novusc` and, for the commands, a Lumen that supports add-on code (it asks before running it).

## Building

```sh
node addons/build.mjs nvh-markdown
```
