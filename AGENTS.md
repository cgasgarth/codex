# Global Codex Instructions

- Keep routine command, script, hook, poll, and validation output concise: compact summaries on success, bounded actionable excerpts on failure.
- Make text shown in Codex threads extremely information-dense; prefer terse, high-signal phrasing and clear shorthand where it preserves meaning.
- For repeated noisy commands, prefer compact wrappers or summary modes so unchanged success output stays small.
- Installed CLIs include `sr`, `sg` (`ast-grep`), `rg`, `git`, `gh`, `bun`, `bunx`, `uv`, and `uvx`; use them where useful to improve efficiency, productivity, and output quality.
- Prefer bun + javascript / typescript for one off commands over python
- Use @Browser by default for browser work unless the user explicitly requests another browser.
- When waiting on a background process that is long running (over 1 minute) set a cron to check in on the output with reasonable durations instead of continuously polling. If you think it will take 20 minutes, check at 18 for status, then at a lower interval after that depending on progress made. This is not for cli commands. This is for background processes that you cannot track via cli IE output of a Chatgpt.com chat

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

## Code Mode batching

Within each bounded stage, group multiple already-known, independent,
non-conflicting tool calls into one `exec` cell and run them concurrently.

In Code Mode, within each bounded stage, run independent, functions.exec-available tool calls concurrently in one functions.exec call. Use await Promise.allSettled([...]) when partial results are useful, and inspect every result; use await Promise.all([...]) only when any failure should abort the batch. Keep dependencies, waits/resumes, approvals, conflicting or interdependent mutations, and adaptive investigations where each result may change the next step sequential. Do not split otherwise batchable inspections across outer tool calls.

## Engineering Principles

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Never add tests that prove something no longer exists in a repo when it is removed from the repo. Do not have regression tests that prove something was removed and no longer works or exists.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Trust official SDK types at SDK-controlled boundaries. Use exported package types and functions directly. Do not duplicate their contracts or add runtime validation, defensive parsing, or broad casts unless data crosses an untrusted boundary or the SDK documents the value as untyped.

Always talk in ASD-STE100 Simplified Technical English.
