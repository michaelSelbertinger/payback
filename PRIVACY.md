# Privacy policy

Payback is a Claude Code mod written and maintained by Michael Selbertinger. It runs entirely on your own machine, inside Claude Code. It has no servers, no accounts, no analytics and no telemetry.

## What Payback reads

To count what Claude did for you, Payback reads, while Claude Code runs:

- **your prompts and Claude's tool calls and their results**, to tell a typed request from a command, to sort it by the tools it used, and to count lines, commits, test runs and tokens;
- **your session transcripts** in `~/.claude/projects` (or `CLAUDE_CONFIG_DIR`), only when you run `/payback import`, to count past sessions the same way;
- **a few environment variables** to find those transcripts and to tell whether a session was started by the Agent SDK: `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CONFIG_DIR`, `HOME`, `USERPROFILE` and `OS`.

It reads this text to count it. It does not keep it.

## What Payback stores

Only totals, on your machine, in the mod's own store in Claude Code's plugin store folder (`~/.claude/plugins/store`): for each calendar day, how many tasks of each kind finished, which models did them, lines added and removed, how many files were touched, languages (from file extensions), counts of commits, pushes, merges, rebases, branches, pull requests, issues, test runs and builds, test runtime and pass and fail counts, and token counts per model. Plus your settings (hourly rate, currency, minutes per kind of task, whether the judge is on) and the time live tracking began.

It does **not** store prompt text, Claude's replies, file contents, file paths, commit messages, branch names or tool output.

## What leaves your machine

Payback makes no network requests of its own and has no third-party services.

There is one thing that can go further than your machine, and it is **off by default**. If you turn the **Haiku judge** on (`/payback settings judge on`), each time a coding task finishes, Payback asks Claude Haiku 5.5 to label it. That request is sent through your own Claude Code session, on your own Claude account or API key, to Anthropic, and contains the first 1,500 characters of your request, the names and counts of the tools used, and the number of lines and files changed. The reply is two words. Anthropic handles that request under the terms and privacy policy that apply to your use of Claude. The judge stays off until you turn it on, and `/payback settings judge off` turns it off again. With the judge off, which is how Payback starts, nothing leaves your machine at all.

The judge is never run on imported history.

## How long data is kept, and how to delete it

Totals stay on your machine until you remove them. `/payback import undo` removes everything imported from past sessions. Deleting the store file in `~/.claude/plugins/store` (its name starts with `payback`) removes all Payback data. Uninstalling the mod stops all reading. Because Payback holds no data anywhere else, there is nothing for me to delete on your behalf.

## Children

Payback is a developer tool for people who use Claude Code. It is not directed at anyone under 18.

## Changes and contact

If this policy changes, the new version is published here with the release that changes it. Questions, security concerns and requests: [open an issue](https://github.com/michaelSelbertinger/payback/issues) or write to michael.selbertinger@web.de.
