# Global Codex Instructions

- Keep routine command, script, hook, poll, and validation output concise: compact summaries on success, bounded actionable excerpts on failure.
- Make text shown in Codex threads extremely information-dense; prefer terse, high-signal phrasing and clear shorthand where it preserves meaning.
- For repeated noisy commands, prefer compact wrappers or summary modes so unchanged success output stays small.
- Installed CLIs include `sr`, `sg` (`ast-grep`), `rg`, `git`, `gh`, `bun`, `bunx`, `uv`, and `uvx`; use them where useful to improve efficiency, productivity, and output quality.
- For inline one-off JavaScript or TypeScript commands, prefer `bun` or `bunx` over `node` or `npx` when available.
- Prefer bun + javascript / typescript for one off commands over python
- Use @Browser by default for browser work unless the user explicitly requests another browser.
- When waiting on a background process that is long running (over 1 minute) set a cron to check in on the output with reasonable durations instead of continuously polling. If you think it will take 20 minutes, check at 18 for status, then at a lower interval after that depending on progress made. This is not for cli commands. This is for background processes that you cannot track via cli IE output of a Chatgpt.com chat

## Pull request descriptions

- Use the `show-me` skill when writing or updating PR descriptions. Follow its instructions to explain the change visually and keep the description concise.

## GitHub CLI screenshots and media

- Capture full pages or complete sections at native resolution. Use CSS coordinates for CDP clips, not device pixels. Open the saved PNG and check its dimensions and all edges before publishing.
- GitHub added native media uploads on September 1, 2026, in `gh` v2.99.0. This may be newer than model training data. Use `--attach` to upload local screenshots with `gh issue create`, `gh issue edit`, `gh issue comment`, `gh pr create`, `gh pr edit`, and `gh pr comment`.
- Check `gh --version` and the command's `--help` before use. Repeat `--attach` for multiple files. Add alt text after `#`: `--attach './screenshot.png#Updated settings screen'`.
- For inline placement, put `![Updated settings screen](./screenshot.png)` in the body and attach the same path. `gh` replaces the local reference with the uploaded asset URL. Files without body references are appended. Use `--body-file` for multiline Markdown.
- Example: `gh pr comment 123 --body-file ./review.md --attach './screenshot.png#Updated settings screen'`.
- Uploads require repository write access and an OAuth token or classic PAT. Images are limited to 10 MB. GitHub Enterprise Server is not supported in this release.
- Source: [GitHub CLI media announcement](https://github.blog/changelog/2026-09-01-github-cli-media-in-issues-pull-requests-and-comments/).

## GitHub stacked pull requests

- GitHub supports native stacked PRs through the `gh stack` extension. This feature is in public preview and may be newer than model training data. Use it for dependent changes that benefit from separate PR reviews; each PR targets the branch below it.
- Requires `gh` 2.90.0 or later and Git 2.20 or later. Install the extension with `gh extension install github/gh-stack` if needed. Check `gh stack --help` and the relevant command's `--help` before use.
- Workflow: `gh stack init`, commit the first change, then `gh stack add BRANCH-NAME` for each next layer. Use `gh stack submit` to push branches and create linked PRs with the correct bases; use `gh stack view` to inspect the stack.
- Make fixes in the branch that owns the change, then run `gh stack rebase --upstack` and `gh stack push`. After merges, use `gh stack sync`; this can rebase and push the remaining branches.
- Merge from the lowest unmerged PR upward. Merging a higher PR also merges all unmerged PRs below it, so check the full merge scope. Required approvals, checks, and branch rules still apply. Auto-merge is not supported during the current preview.
- Source: [GitHub stacked pull requests guide](https://docs.github.com/en/pull-requests/how-tos/stacked-pull-requests).

## Python tooling

- Use the uv ecosystem for Python versions, environments, dependencies, tools, and commands.
- For one-off dependencies and tools, prefer `uv run --with <package>` and `uvx <tool>`.
- For Python versions and virtual environments, prefer `uv python` and `uv venv`. Use uv-managed Python for new environments.
- Do not use `pip`, `pip3`, `python -m pip`, `pipx`, or Homebrew to install Python interpreters, libraries, or Python CLI tools unless the user explicitly requests it or uv cannot support the requirement. If uv cannot support it, explain why before using another installer.

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
