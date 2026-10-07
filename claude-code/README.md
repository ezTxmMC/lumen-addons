# Claude Code

Claude Code as a chat agent in Lumen — with the same engine as the `claude` command:
your login, `CLAUDE.md`, settings and MCP servers all apply.

## Chat

- **Live answers**: text and reasoning appear while Claude writes;
  answers as Markdown with copyable code blocks
- **Tools** with preview — diffs for changes, the command for `Bash`, the
  file to open; changed files open on their own
- **Allow / Always allow / Deny** (also with a reason) for every action
- **Plan**: Claude's to-do list as a card with progress
- **Cost** per answer: tokens, cache, steps, duration and price
- **Multiple chats** side by side, **resume earlier sessions**
- **Models** come straight from the installed Claude Code CLI — always
  matching your version and account; ↻ next to the picker reloads them
- **Effort per model** chosen in the chat — only the levels the model supports
  (Haiku, for example, has none); Lumen remembers the choice per model
- **Modes** switched directly in the chat: Ask, Auto-accept edits,
  Plan and — only when enabled — No prompts
- **Input**: `/` for slash commands, `@` for files, ↑ for earlier messages,
  paste (Ctrl+V) or attach images, send the open file and selection along

## Session actions

The chat's "…" menu and the `/` palette offer, for the current conversation:

- **Compact** (`/compact [what to keep]`) — summarizes the conversation to free context
- **Rewind** — returns to one of your earlier messages: the files are restored
  from Claude's backups and the conversation continues as a fork from before
  that message (needs "Back up files for rewind", on by default)
- **Fork**, **Rename**, **Delete** the session
- **Export** the transcript as Markdown

## Toolbar and chat lines

- **Context meter** (tokens used of the model's window), **session cost**
  and, with a claude.ai plan, the **5-hour and weekly limits**
- **Notices** for compaction, blocked hooks, denied tools, API retries and
  the output of commands such as `/context`
- **Subagents** (Task tool) start and finish as their own entries with their
  tool calls nested beneath them
- **Slash commands** come from Claude Code with their description, argument
  hint and source (built-in, project, user, plugin, skill). `/name args`
  reaches Claude as a real slash command. `/mcp` lists the MCP servers and
  their state without sending anything.
- **Permission prompts** also offer "Allow for this session" and
  "Always allow `Bash(npm:*)`" (built from Claude Code's own suggestions)

## Settings

*Settings → Extensions → Claude Code*:

- **Program, Model**: path to `claude`, default and fallback model, more
  models, model list cache, default effort, extended thinking (adaptive,
  budget, off), fast mode
- **Chat**: output style, save sessions, back up files for rewind, live
  answers, maximum steps, cost limit, additional instructions
- **Permissions**: allowed, denied and always-ask rules, the tool set
  (all, read-only, or a list), sandbox, more folders, "No prompts" mode;
  the extra mode "Only allowed" denies whatever no rule allows
- **Extensions**: custom **subagents**, **hooks** (shell commands per event),
  **plugins** (local folders), **skills**, "only these MCP servers"
- **Advanced**: settings sources, additional MCP servers (JSON), beta
  headers, environment variables
- **Customize**: quick actions, slash commands and profiles (below)

### Subagents

One per line — `name | description | prompt | tools | model` (tools
comma-separated, model an alias, `\n` = line break), or JSON as for
`claude --agents`:

```
reviewer | Reviews code for bugs | You are a strict code reviewer. | Read,Grep,Glob | sonnet
```

### Hooks

One per line — `Event | matcher | command`. Events: `PreToolUse`,
`PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`,
`Notification`, `PreCompact`. The command gets the event as JSON on stdin and
runs in the project folder; exit code 2 blocks (stderr is the reason, shown as
a notice), JSON on stdout works as in Claude Code.

```
PreToolUse | Bash | ./scripts/check-command.sh
```

### Customize

Quick actions (`Label | prompt`), commands (`name | description | prompt`)
and profiles (`Label | mode=plan | model=opus | effort=high | key=value`)
are filled with examples; change them freely. Prompts can use `{{selection}}`,
`{{file}}`, `{{clipboard}}` and, in commands, `$ARGUMENTS`. A profile's extra
`key=value` sets any setting of this extension for chats using it, e.g.
`toolset=readonly` or `sandbox=on`. The defaults include Plan (Opus, high),
Quick edit (Sonnet), Read-only review and Sandboxed autonomy; `/review`,
`/explain`, `/tests`, `/plan`, `/remember` (adds to CLAUDE.md) and `/memory`.
Each chat can also carry its own system prompt.

## Template

*New project → Claude Code project* creates `CLAUDE.md`, `.claude/settings.json`,
the slash commands `/review` and `/explain` and a `reviewer` subagent.

## Requirements

Claude Code must be installed and signed in:

```sh
npm install -g @anthropic-ai/claude-code
claude
```

The extension ships executable code that must be confirmed on installation.
It starts the installed `claude`.
