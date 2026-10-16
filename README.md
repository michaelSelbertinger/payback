# Payback

A Claude Code plugin that shows what Claude did for you, and what that was worth.

Payback opens a pane with four tabs (Today, Week, Month, Year). It counts every request you typed that Claude finished, sorts it by the tools it used, and estimates the hours it saved you and their value. It is built for developers: alongside the task count it tracks lines changed, languages, commits, pushes, merges, pull requests, issues, test runs, builds and tokens per model.

Hours and money are always shown as estimates.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install payback --marketplace michaelSelbertinger/payback
```

From a shell:

```
claude plugin install payback --marketplace michaelSelbertinger/payback
```

In the desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `michaelSelbertinger/payback`, then **Add plugin**.

Payback is a hooks-module plugin, an early-access part of Claude Code. It needs Claude Code 2.1.299 or later.

## Commands

| Command | What it does |
| --- | --- |
| `/payback` | Opens the pane. There is also a **Payback** button in the hint line under the prompt. |
| `/payback settings` | Lists the hourly rate, currency, minutes per kind of task and whether the Haiku judge is on. |
| `/payback settings rate 75` | Sets the hourly rate. |
| `/payback settings currency eur` | Shows money in euro (`usd` for dollars). Nothing is converted: the rate is read in the chosen currency. The pane has a `$ / €` switch too. |
| `/payback settings <kind> 15` | Minutes saved per task of a kind: `devops`, `emails`, `images`, `documents`, `research`, `questions`, `other`. |
| `/payback settings small\|medium\|large 45` | Minutes saved per coding task of that size. |
| `/payback settings judge on\|off` | Turns the Haiku judge on or off (see below). |
| `/payback import` | Reads your past Claude Code sessions into the report (see below). Also `/payback import 30d` or `/payback import 2026-09-20 2026-10-10`. |
| `/payback import undo` | Removes everything imported. Live data is untouched. |

## What counts

One task is one request you typed that Claude finished with an answer. Slash commands, helper agents, interrupted requests and injected text are not tasks. A helper agent's lines, commits, test runs and tokens still count.

Each task gets one kind, from the tools it used:

| Kind | When | Minutes saved (default) |
| --- | --- | --- |
| Coding | It edited code, ran git, gh, tests or a build, or used a code tool such as Unity or GitHub | by size: 15 / 45 / 120 |
| DevOps & shell | It ran shell commands without editing code, or used Docker, Kubernetes or cloud tools | 20 |
| Emails | It used a mail tool | 10 |
| Images and video | It used an image or video tool, or wrote an image or video file | 20 |
| Documents | It used a document, slide or spreadsheet tool, or wrote a document file | 30 |
| Research | It searched or read the web | 25 |
| Questions & planning | It used no tools, or only read and searched files | 10 |
| Other | Anything else | 10 |

The size of a coding task comes from the lines it changed (under 40 small, under 250 medium, larger is large) until the Haiku judge says otherwise.

Everything else Payback shows is counted by plain code, with no model involved:

- **Code**: lines added and removed, files touched, top languages.
- **Git**: commits, pushes, merges, rebases and new branches, read from Bash and PowerShell commands that succeeded (`git -C`, chained commands and PowerShell's `if ($?)` included; quoted messages and here-strings are ignored).
- **GitHub**: pull requests opened and merged, issues opened and closed (`gh pr …`, `gh issue …`).
- **Tests**: runs of pytest, jest, vitest, go test, cargo test, dotnet test, npm/pnpm/yarn/bun test and others, with pass rate, runtime and passed and failed counts.
- **Builds**: runs and failures.
- **Tokens**: input, output and cache share per model.

It counts what Claude did through its own tools, not commits you make yourself in a terminal.

### Started by you or by the SDK

Sessions started through the Claude Agent SDK (an assistant of your own, a script) are counted apart. The pane shows a **Started by** row with an **All / You / SDK** filter. SDK sessions run from a temp folder are treated as tests and left out, as are requests that only ask Claude to summarise an earlier session.

## The Haiku judge

When the judge is on (the default), each finished coding task gets one small call to Claude Haiku 5.5. It labels the task's type (feature, bugfix, refactor, tests, debug, docs, devops, review) and its size. The call is sent the first 1,500 characters of your request, the names and counts of the tools it used and the number of lines changed, and it uses your own Claude account or API key. Its tokens are shown in the pane under **Haiku judge**. Turn it off with `/payback settings judge off`; sizes then come from the lines changed alone.

## Importing your history

`/payback import` reads the session transcripts Claude Code keeps in `~/.claude/projects/` and replays them by the same rules as live tracking.

- **Preview first.** Nothing is saved until you press **Import** in the pane, which shows tasks, days, sessions, kinds and the estimate before you decide.
- **No double counting.** It reads only what happened before Payback's first live record, and an import replaces its whole date range, so running it twice counts once. History that a fork or a resume copied into another file is counted once.
- **Undo** with `/payback import undo`.
- Imported coding tasks are sized by lines changed; the Haiku judge is not run on them.

Claude Code deletes transcripts after 30 days by default, so that is as far back as an import can go. Raise `cleanupPeriodDays` in your settings to keep more from now on.

## Privacy

All counts stay on your machine, in the plugin's own store. Payback sends nothing anywhere, except the Haiku judge's calls described above, which go to Anthropic through your own Claude Code session and can be turned off.

## Development

```
claude plugin validate .
claude plugin test .
```

The logic lives in `hooks/stats.ts` (counting, sorting, dates) and `hooks/history.ts` (the transcript replay), both free of Claude Code's runtime so the tests reach them directly. `hooks/register.tsx` holds the hooks, the commands and the pane. To run your working copy in every session, add its folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`, and set `CLAUDE_CODE_PLUGIN_DIR_WATCH` to `1` there so desktop sessions reload it when you save.

## License

Copyright (C) 2026 Michael Selbertinger.

Payback is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See [LICENSE](LICENSE) for the full text.
