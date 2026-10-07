# ChatGPT Codex

OpenAI Codex as a chat agent in Lumen. Each message starts the installed
Codex CLI (`codex exec`); your login, `AGENTS.md` and `~/.codex/config.toml`
apply.

## Chat

- **Modes** are sandbox levels: *In project* (default), *Read only* and — only
  when enabled — *Full access*
- **Tools** with preview: commands with their output, changed files to
  open, MCP calls (`server.tool` with their arguments and result), web searches
- **Plan**: Codex's to-do list as a card with progress
- **Tokens and duration** per answer, a **context meter** (from Codex's own
  `token_count` records, else the model cache) and **rate limits** when your
  plan reports them; Codex prints no prices, so there is no cost estimate
- **Notices**: how the session runs (sandbox, approvals, network), warnings
  Codex prints, switched-off reasoning summaries, ephemeral sessions
- **Multiple chats**, **resume earlier sessions** (from `~/.codex/sessions`,
  named as Codex or you named them)
- **Models** from `~/.codex/models_cache.json` or from `codex app-server`
  (`model/list`) — ↻ next to the picker asks the CLI again
- **Reasoning effort per model** chosen in the chat — only the levels the model
  supports; Lumen remembers the choice per model
- Switch **models** directly in the chat, paste or attach **images**,
  `@` for files, send the open file and selection along

## Slash commands

| Command | What it does |
| --- | --- |
| `/review [base <branch> \| commit <sha> [title] \| instructions]` | `codex exec review`: uncommitted changes by default. Codex accepts either a target or custom instructions, not both. A review runs in a session of its own. |
| `/init` | Asks Codex to create or improve `AGENTS.md` |
| `/status` | Codex version, account, model, sandbox, approvals, profile, `AGENTS.md`, session |
| `/mcp [list \| get \| add \| remove]` | `codex mcp …`; `add` takes `codex mcp add`'s arguments, e.g. `/mcp add docs --url https://…` or `/mcp add tool -- npx -y some-server` |
| `/profiles` | The profiles Codex finds (`[profiles.x]` in `config.toml`, `<name>.config.toml`) |
| `/prompts:<name> [args]` | Your Codex custom prompts: `~/.codex/prompts/*.md`, and `.codex/prompts/*.md` of the project (a project prompt wins). Front matter `description` and `argument-hint`; body placeholders `$1`…`$9`, `$ARGUMENTS`, `$NAME` (filled from `NAME=value`), `$$` |
| your own | *Customize → Slash commands* (e.g. `/explain`, `/tests`) |

Lumen adds `/clear`, `/new` and — for the session actions below — `/fork`,
`/rename`, `/delete`, `/export`. The palette learns Codex's own commands when
the chat's first session starts.

## Session actions

- **Fork** — `codex exec fork <id>`: a new session with the old history
- **Rename** — kept by the add-on (exec mode cannot rename); the history shows it
- **Delete** — `codex delete --force <id>`
- **Export** — the session's rollout file as Markdown (your messages and Codex's)

Not offered: *compact* (exec mode has no compaction command; Codex compacts by
itself near the context limit) and *rewind* (no checkpoints in exec mode).

## Settings

*Settings → Extensions → ChatGPT Codex*:

- **Program** — path to `codex`, profile (`[profiles.x]` or `<x>.config.toml`)
- **Model** — default model, list source, more models, effort (incl. `max`),
  reasoning summary, verbosity, hide reasoning
- **Instructions** — text added to every chat, handed to Codex as
  `developer_instructions` (`-c`) or in front of each message; the chat's own
  system prompt is added after it
- **Tools** — web search, network and `/tmp` in the *In project* sandbox
- **Permissions** — approval policy, overridable per mode; full access;
  more writable folders (`--add-dir`); Git check
- **Advanced** — `-c` overrides (comments allowed, bad lines reported), reply
  schema (`--output-schema`), feature flags (`--enable` / `--disable`), local
  model (`--oss`, `--local-provider`), ephemeral sessions (`--ephemeral`),
  environment variables
- **Customize** — quick actions, slash commands and profiles as one-line
  entries (pre-filled; edit freely)

```text
Quick action   Label | prompt                         ({{selection}} {{file}} {{clipboard}})
Command        name | description | prompt            ($ARGUMENTS or {{args}})
Profile        Label | mode=read-only | effort=high | anySettingKey=value
```

Built in: the profiles *Careful* (read only, high effort) and *Build*.
*Full access* in a profile still needs the setting that allows it.

Every message runs with `--color never`. Exec mode has no `--search` flag, so
web search is the `web_search` config key.

## Project

- **Project type** `ChatGPT Codex` — detected by `AGENTS.md` or `.codex/`, with the
  tasks *Start Codex*, *Resume last session*, *Sign in*,
  *Show MCP servers* and *Install Codex*
- **Template** `AGENTS.md` with commands and conventions, an example prompt in `.codex/prompts/` and a project `.codex/config.toml`

## Requirements

```sh
npm install -g @openai/codex
codex login
```

The extension ships executable code that must be confirmed on installation.
It only starts the program you have installed.
