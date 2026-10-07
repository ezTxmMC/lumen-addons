---
title: nvh-markdown
icon: book-open
---

# nvh-markdown

[nvh-markdown](https://github.com/ezTxmMC/nvh-markdown) is Markdown for
[Novus](https://github.com/ezTxmMC/novus) and nvh: a Markdown renderer written in
Novus, a few nvh components and the generator for `.nvmd` files — Markdown with
Novus in it, the way `.mdx` is Markdown with JSX.

## Setup

In the `project.nv` of the project:

```
require "github.com/ezTxmMC/nvh-markdown" "latest"
replace "github.com/ezTxmMC/nvh-markdown" "../nvh-markdown"     // a local checkout, optional
```

```nv
import "github.com/ezTxmMC/nvh-markdown/markdown"       // markdown.render(...)
import "github.com/ezTxmMC/nvh-markdown/components"     // Callout, CodeBlock, Toc, Markdown
```

A project with `.nvmd` files needs the `require` and the generator. The compiler
itself knows nothing about `.nvmd`: `novusc` reads `.nv` and `.nvh` only, so the
generator writes `Page.nvh` next to every `Page.nvmd` before the compiler runs.

## The `.nvmd` format

A `.nvmd` file is a component like a `.nvh` file.

1. **Frontmatter** (optional, first line): `---`, `key: value` lines, `---`. Every key
   made of `[A-Za-z0-9_]` becomes `prop string key = "value"`, so `{key}` works and a
   parent can override it.
2. **Header** `<?nv ... ?>` (optional, right after the frontmatter): imports,
   `prop`/`ref`, methods, defines — exactly the header of a `.nvh` file. The closing
   `?>` stands on a line of its own.
3. **Body**: Markdown with these Novus constructs:
   - `{expr}` anywhere in Markdown text: the HTML-escaped value. `\{` and `\}` are
     literal braces; braces in fenced code and code spans are always literal.
   - alone on their line: `{#if c}`, `{:else if c}`, `{:else}`, `{/if}`,
     `{#for x in xs}`, `{#for x, i in xs}`, `{/for}`, `{@html expr}`, `<?nv ... ?>`.
   - components: a tag starting with an upper-case letter, with nvh attributes
     (`prop={x}`, `@event="handler"`), either `<Name>` ... `</Name>` on lines of
     their own (children are Markdown) or self closing `<Name ... />`.
   - lower-case HTML tags are raw HTML. A block with a handler (`@click=`, `bind=`,
     `class:x={...}`) is nvh, not Markdown, and runs to the next blank line.

The generated file has the same lines as the source, so an error of the compiler
points at the right line of the `.nvmd`. A generated file starts with
`<?nv /* nvmd-generated */`; the generator never overwrites or removes a `.nvh`
without that mark. Put the generated `*.nvh` into `.gitignore`.

## The generator

```sh
novusc run nvh-markdown/nvmd.nv build content        # only what changed (--force: all)
novusc run nvh-markdown/nvmd.nv watch content        # rebuild while you write
novusc run nvh-markdown/nvmd.nv translate Page.nvmd  # print the .nvh of one file
novusc run nvh-markdown/nvmd.nv clean content        # remove the generated files
novusc run nvh-markdown/nvmd.nv check content --main main.nv
```

`check` builds, runs `novusc check` and names the `.nvmd` lines of its errors. Translation
errors are printed as `error: file:line: message` and end the program with exit code 1.
From a program: `nvmd.translate(source, "Page.nvmd")`, `nvmd.build(["content"], false)`,
`nvmd.watch(["content"])`, `nvmd.clean(["content"])` after
`import "github.com/ezTxmMC/nvh-markdown/nvmd"`.

## The `markdown` package

```
markdown.render(string source): string                     Markdown -> HTML
markdown.fill(string html, array values): string           markers of .nvmd -> escaped values
markdown.frontmatter(string source): map<string, string>   the key: value pairs between the --- lines
markdown.body(string source): string                       the source without its frontmatter
markdown.headings(string source): array<Heading>           level, id, text of every heading
markdown.slug(string text): string                         "Hello, World!" -> "hello-world"
markdown.highlight(string language, string code): string   HTML with <span class="tok-...">
markdown.text(string source): string                       plain text, for a search index
```

`Heading` has the fields `level` (1-6), `id` and `text`. A heading that is only `{expr}`
has no text to take the id from: name it with a trailing `{#id}` (`# {title} {#intro}`).

## Dialect

CommonMark core (ATX and setext headings, paragraphs, emphasis, code spans, fenced and
indented code, block quotes, nested lists, links, images, reference links, autolinks, hard
breaks, HTML blocks and inline HTML) plus GFM tables with alignment, task lists,
`~~strikethrough~~` and bare `http(s)://` links, plus containers:

```
:::note Optional title
text, **Markdown**
:::
```

(`note`, `tip`, `warning`, `danger`). Raw HTML is passed through for the usual tags;
`<script>`, `<style>` and unknown tags are shown as text, and `javascript:` links become `#`.

The output is plain semantic HTML with stable class names, so any CSS — Tailwind included —
can style it: `heading-anchor`, `code-block` (with `data-language`), `callout callout-<kind>`,
`callout-title`, `table-wrapper`, `task-list-item`, and for highlighted code `tok-kw`, `tok-str`,
`tok-num`, `tok-com`, `tok-fn`, `tok-type`, `tok-op`, `tok-punct`. Highlighted languages: `nv`,
`nvh`/`html`, `sh`, `json`, `c`, `js`/`ts`, `toml`, `yaml`; any other language is only escaped.

## Components

| Component | Props | Output |
| --- | --- | --- |
| `Callout` | `type` (`note`), `title` | `<aside class="callout callout-{type}">` around its slot |
| `CodeBlock` | `code`, `language` | a highlighted `<pre class="code-block">` |
| `Toc` | `headings`, `minLevel` (2), `maxLevel` (3) | a `<nav class="toc">` list of anchors |
| `Markdown` | `source` | renders Markdown at run time |

They carry no styling of their own.

## In Lumen

| Command | What it runs |
| --- | --- |
| nvmd: Generate .nvh for this file | `build <file>` |
| nvmd: Generate all .nvmd in the project | `build <content folders>` |
| nvmd: Show the generated .nvh of this file | `translate <file>`, opened as a read-only tab |
| nvmd: Generate and check the program | `check <content folders> --main <main>` |
| nvmd: Watch and regenerate in a terminal | `watch <content folders>` |
| nvmd: Remove generated .nvh files | `clean <content folders>` |

The settings under *Extensions → nvh-markdown* name the `novusc` program, the generator's
`nvmd.nv`, the content folders and the main file, and switch *Generate on save* and
*Check while typing* on.
