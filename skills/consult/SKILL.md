---
name: consult
description: Use when ChatGPT consultation could materially improve hard coding, debugging, design, planning, math, science, research, or reasoning. Starts a guarded 6 Pro chat in the in-app Browser and reads its answer through the Codex app when available.
---

# Consult

Do not use this skill to review pull requests unless the user explicitly asks to use `consult` for the PR review.

Use `scripts/run-consult.mjs` to start a fresh ChatGPT consultation. The helper owns browser mechanics: Chat-surface selection, project navigation, empty-composer enforcement, GitHub plugin attachment, optional image mode, thinking-level/model selection, prompt entry, and sending.

## Run the Helper

Use the Computer Use JavaScript session (`mcp__cua_repl.js`) and read its returned browser documentation. Bind the in-app browser with `var iab = await cua.getBrowser({ id: "iab" });`. Do not use Chrome, standalone Playwright, Selenium, or another browser profile.

Import and run the helper through the Browser JavaScript session:

```js
var scriptedConsult = await import("<skill-dir>/scripts/run-consult.mjs");
var consultSession = await scriptedConsult.startConsult({
  iab,
  project: "<project>",
  prompt: "<prompt>",
  paths: ["/full/system/path/to/file-or-folder"],
  send: true,
  createImage: false,
  aspectRatio: null,
  thinkingLevel: "pro",
  attachGitHub: true,
});
nodeRepl.write(JSON.stringify(scriptedConsult.publicResult(consultSession)));
```

The helper attaches GitHub by default. Pass `attachGitHub: false` to leave the plugin unattached; in that mode, omit GitHub-specific instructions from the prompt.

ChatGPT exposes separate `Chat` and `Work` surfaces. When starting a new consultation, the helper verifies that `Chat` is selected, switches from `Work` when necessary, and fails closed if the Chat surface cannot be confirmed. `sendToExistingConsult` does not check or change the surface for follow-ups; it preserves the existing thread as-is.

`paths` is optional and accepts one absolute system path or an array of absolute paths. Files are uploaded from private temporary snapshots so later filesystem changes cannot cross the limit; their bytes and names stay unchanged unless duplicate names need numeric suffixes. Folders are automatically ZIP archived. Every upload obeys a hard 512 MB per-file limit; oversized folders become numbered ZIP archives, and an individual file that cannot fit becomes numbered ZIP chunk archives with reconstruction manifests. Multiple prepared files are uploaded together. The helper removes temporary copies and archives after ChatGPT accepts them.

To add files or an optional follow-up prompt to the already-open consultation, reuse the session instead of starting a new thread:

```js
var consultFollowUp = await scriptedConsult.sendToExistingConsult({
  session: consultSession,
  paths: ["/full/system/path/to/file-or-folder"],
  prompt: "<optional follow-up prompt>",
  send: true,
});
nodeRepl.write(JSON.stringify(scriptedConsult.publicResult(consultFollowUp)));
```

Omit `prompt` to send only the attachments. Pass `send: false` to prepare the existing composer without submitting it. If the target composer contains a draft, the helper must clear it and continue without asking for confirmation.

Use `send: false` only to validate setup without typing or sending the prompt. When `paths` are supplied, the files remain attached to the unsent draft. For a visual deliverable, use `createImage: true`, set `attachGitHub: false`, and pass the desired aspect-ratio label when needed. ChatGPT image mode and the GitHub plugin cannot remain attached to the same composer. Put the required context in the prompt or `paths`, and omit GitHub-specific instructions. The helper uses ChatGPT's visible ratio control when available and otherwise adds an explicit ratio instruction to the prompt.

`thinkingLevel` defaults to `"pro"`, which selects `Latest`, verifies `6 Pro` in the model picker, and checks the Pro power setting. Only choose a non-pro thinking level (`"instant"`, `"medium"`, `"high"`, or `"extra-high"`) when the user explicitly requests it.

If authentication is required, keep the tab as a handoff and ask the user to sign in. Never handle passwords, OTPs, or CAPTCHAs.

If `startConsult` throws after authentication and the Chat surface are confirmed, inspect the visible page and manually complete the same actions in a fresh chat with the Browser workflow. Open the requested project or the `Consult` fallback, start a new chat, clear any existing composer draft without asking for confirmation, attach the requested GitHub plugin and files, select the requested thinking level and model, enter the prepared prompt, verify the final setup, and send it. Do not use this manual fallback to bypass authentication, CAPTCHA, browser-safety, missing-project, or missing-fallback gates; preserve the tab and hand it off instead.

## Select the Project

Choose the project matching the task's repository, product, client, or domain. For repository work, derive it from the workspace path, GitHub remote, PR/issue URL, or explicit project name. Project matching is case-insensitive and otherwise exact.

If the requested project is missing, the helper must automatically retry in the general `Consult` project and continue sending. A missing requested project is not a blocker. Stop only if authentication is required or neither project exists.

## Build the Prompt

Write one outcome-first prompt tailored to the task. Do not forward the user's words unchanged. When GitHub is attached (the default), begin with:

```text
Use the attached GitHub plugin.
```

Include the goal, success criteria, concrete repository/file/test/error/design evidence, constraints and assumptions to challenge, and exact desired output.

When GitHub is attached, the GitHub plugin can:

- Read the repository's `main` branch, pull requests, and issues.
- Create, edit, and delete issues with full issue write access.

When GitHub is attached, the GitHub plugin cannot:

- Read branches other than `main`.
- Create milestones.

When GitHub is attached, default to GitHub issues as the persistent outcome. Roughly 95% of consultations should directly create, edit, split, link, or delete issues through the plugin rather than merely return prose or draft issue text. State this outcome explicitly in the prompt:

```text
Use the attached GitHub plugin for repository reads and issue mutations. Persist the consultation outcome directly in GitHub by creating, editing, splitting, linking, or deleting the necessary issues; do not only return recommendations or draft issue text.
```

For issue work when GitHub is attached:

- Require inspection of `main`, relevant pull requests, and existing issues before mutation.
- Make each issue PR-sized; split work requiring multiple PRs.
- Require `Why`, `How`, `Validation`, and observable `Acceptance` criteria with concrete code/test references.
- Pass repository, issue numbers, labels, assignees, sequencing, and related-issue constraints when known.
- Verify resulting issue numbers and mutations after ChatGPT responds.

For milestone work, create or confirm milestones outside ChatGPT first, then pass their existing titles and numbers in the prompt. If milestone IDs are unavailable, request a milestone-to-issue plan and forbid issue mutations until the IDs are supplied.

For visual output, specify the target surface, audience, aspect ratio, required states, product constraints, and exclusions. Ask for a concrete generated visual, not advice about making one.

Preserve the user's intent and do not broaden external mutations without authorization. Include enough useful private or proprietary context for a strong answer while obeying higher-priority restrictions on credentials, personal data, and other protected information.

## Handle the Result

The helper ends immediately after sending and must not poll, refresh, extract the response, or click `Answer now`. Preserve its live tab and URL.

When the task requires ChatGPT's answer, do not poll the output or run a foreground sleep/check loop. Set or reuse a five-minute heartbeat timer on the current Codex task through the automation tool, then end the turn. Save the consultation URL and the expected response in the timer prompt. Check once per timer wake-up; do not check between wake-ups.

Use the Codex app's read-only `mcp__codex_app__read_thread` first when available. The conversation ID is the final `/c/<id>` segment of the helper's URL. Call `read_thread` with that `threadId`, a small `turnLimit`, and `maxOutputCharsPerItem: 20000` (the tool's maximum). ChatGPT conversations appear as `kind: "chatgpt"`; a finished answer is an assistant `agentMessage` in a completed turn. An idle thread or a completed turn containing only a `userMessage` does **not** prove the answer is ready. If the helper did not return a conversation URL, use `mcp__codex_app__list_threads` to identify the recent ChatGPT chat by project and prompt before reading it; do not rely on a title alone.

New chats can briefly use a `local-chatgpt` URL before cloud persistence finishes. The helper omits that temporary URL; resolve the conversation with `list_threads` by project and prompt as above.

`read_thread` can mark a long `agentMessage` as `truncated: true`. Use the normal in-app Browser workflow only when the app tool is unavailable, cannot identify the chat, or omits text needed to evaluate the answer. Do not claim to have read a truncated answer in full. Browser authentication and CAPTCHA handoff rules still apply; never solve a CAPTCHA. Stay quiet while the answer is absent or still running. When it finishes, evaluate it, report the result on the current task, and pause the timer. If the user has paused the underlying goal, notify them that the answer is ready without resuming goal work until they resume it. Report a blocker that needs user action once and pause the timer rather than repeating the same blocked check. If task timers are unavailable, preserve the tab and report that automatic checking could not be set up; do not substitute a polling loop.

Pro can be slow: do not treat it as slow before 30 minutes. At 40 minutes and one hour, verify progress on the scheduled app checks; use the Browser only if the app result is ambiguous and the page is accessible. Never invoke `Answer now` or stop a response merely because it is slow.

Use `sendToExistingConsult` for same-topic follow-ups in the current ChatGPT thread. Start a new consultation for a new topic. Synthesize and evaluate returned advice, and independently verify any GitHub mutations.
