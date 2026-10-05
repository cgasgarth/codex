# Global Codex Instructions

- When spawning a subagent across GPT and Claude model families, use `fork_turns="none"` and include the required task context in its message. Native GPT compaction state cannot be read by Claude.

- Keep routine command, script, hook, poll, and validation output concise: compact summaries on success, bounded actionable excerpts on failure.
- Make text shown in Codex threads extremely information-dense; prefer terse, high-signal phrasing and clear shorthand where it preserves meaning.
- For repeated noisy commands, prefer compact wrappers or summary modes so unchanged success output stays small.
- Installed CLIs include `sr`, `sg` (`ast-grep`), `rg`, `git`, `gh`, `bun`, `bunx`, `uv`, and `uvx`; use them where useful to improve efficiency, productivity, and output quality.
- Use @Browser by default for browser work unless the user explicitly requests another browser.
- For background work over one minute that cannot be tracked through CLI output, schedule checks near the expected completion time instead of constant polling.

## Pull request descriptions

- Use the `show-me` skill when writing or updating PR descriptions. Follow its instructions to explain the change visually and keep the description concise.

## GitHub CLI screenshots and media

- Capture complete pages or sections at native resolution; use CSS coordinates for CDP clips. Inspect saved screenshots before publishing.
- Use `gh` 2.99+ with `--attach 'path#alt text'` for issue/PR media. Reference the same path in Markdown for inline placement; use `--body-file` for multiline text. Check version and command help first.
- Uploads require write access and OAuth or a classic PAT; images are limited to 10 MB. [Media documentation](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/).

## GitHub stacked pull requests

- Use `gh stack` for dependent PRs. Install with `gh extension install github/gh-stack` if needed; check command help first.
- Create with `init`, `add`, and `submit`. Fix the owning branch, then `rebase --upstack` and `push`; use `sync` after merges.
- Merge bottom-up and check the full merge scope; higher PRs can include lower ones. Required approvals and checks still apply. [Stack documentation](https://docs.github.com/en/pull-requests/how-tos/stacked-pull-requests).

## Python tooling

- Use `uv` as the Python manager and package manager.

## Engineering Principles

- Remove obsolete paths; do not add backward compatibility, fallbacks, migrations, or tests that only prove removal.
- Choose the simplest complete solution. Keep concerns modular; avoid speculative abstractions and configuration.
- Check existing dependencies, documentation, and types before adding code or packages. Prefer maintained libraries over reimplementing common functions.
- Use official SDK types directly. Add validation or parsing only for untrusted or untyped data; avoid duplicate contracts and broad casts.

Always talk in ASD-STE100 Simplified Technical English.
