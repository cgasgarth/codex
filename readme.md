# Local Codex setup

This directory contains the local settings and custom tools used by the ChatGPT
desktop app's Codex workspace and the Codex CLI. Selected source files are kept
in [cgasgarth/skills](https://github.com/cgasgarth/skills). This repository is not
a complete backup of the live Codex home.

Last inspected: **October 4, 2026**. Both the app's bundled backend and the
external patched backend report `codex-cli 0.160.0`.

## Setup at a glance

| Component | Purpose | Main files |
| --- | --- | --- |
| VibeProxy | Routes OpenAI, Claude, and the configured Gemini agent through the local subscription proxy | Local `config.toml`; proxy settings outside this repo |
| Model catalog | Model picker names, capabilities, context limits, and compaction thresholds | [model-catalog.json](model-catalog.json) |
| Plaintext V2 patch | Allows GPT and Claude subagents to exchange readable tasks while keeping V2 coordination | [patches/v2-plaintext](patches/v2-plaintext/README.md) |
| Named agent roles | Model-specific settings and instructions for Fable, Opus, and Gemini | `agents/*.toml` |
| Idle compaction | Compacts eligible idle chats through the running desktop app | [idle-compact](idle-compact/README.md) |
| Global instructions | Shared engineering, tool, communication, and GitHub guidance | [AGENTS.md](AGENTS.md) |
| Custom skills | Browser support, consultation, repository work, code intelligence, and document/media tools | `skills/` |

## VibeProxy routing

The saved global provider is `vibeproxy`. **OpenAI and Claude requests both use
VibeProxy**. There is no separate OpenAI-only profile or custom routing server
in this setup.

```text
ChatGPT app / Codex CLI
  → http://127.0.0.1:8318/v1 (VibeProxy)
    → OpenAI or Claude upstream, selected by the requested model
```

The local provider uses the Responses API, OpenAI authentication, WebSocket
support, two request retries, and a 900-second stream idle timeout. VibeProxy
must be running and its upstream accounts must be authenticated.

Important local settings in `config.toml`:

| Setting | Saved value |
| --- | --- |
| Default model | `gpt-6.1-sol` |
| Reasoning effort | `high` |
| Service tier | `priority` |
| Model catalog | `/Users/cgas/.codex/model-catalog.json` |
| Approval policy | `never` |
| Sandbox | `danger-full-access` |
| Features | Idle-sleep prevention and memories enabled; legacy `js_repl` disabled |

These are saved defaults. Existing chats can retain their own model, provider,
effort, tier, and protocol. Picker visibility alone does not prove routing or
upstream model availability.

VibeProxy is built on [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).
Its user-owned overrides are in `~/.cli-proxy-api/config.yaml`. VibeProxy writes
the effective `merged-config.yaml`; edit the user-owned file rather than the
generated one. Upstream credentials belong to VibeProxy and are not stored in
this repository.

`supports_websockets = true` describes the client-to-proxy connection. It does
not mean every upstream connection uses WebSockets. Claude's upstream path uses
HTTP/SSE. Fast mode requests priority service for supported OpenAI models;
seeing the Fast control or a tier field is not a latency measurement. The
earlier matched tests reproduced OpenAI slowdown both directly and through the
proxy, so they did not establish a proxy throughput penalty.

## Model catalog and agent roles

The catalog contains 13 model entries. OpenAI IDs and display names retain the
upstream names so model-specific controls, including Fast mode, remain visible.
The catalog is a saved snapshot; it does not refresh itself from OpenAI.

| Models | Context limit | Automatic compaction threshold |
| --- | --- | --- |
| GPT Astra / Sol | 872,000 | 700,000 |
| Claude Opus / Fable | 1,000,000 | 700,000 |

Other models have their own values in the catalog. Changing the catalog does
not rewrite saved chat metadata. Treat app reload behavior as version-specific;
restart and make a real request when verifying a change.

All catalog entries currently select **V1**. The external app launcher overrides
that with **V2**, as described below. The normal installed CLI retains the saved
V1 setup unless explicitly overridden.

Local `config.toml` registers these named roles:

- [Fable](agents/fable.toml): `claude-fable-5-1`, VibeProxy, high effort.
- [Opus](agents/opus.toml): `claude-opus-5-5`, VibeProxy, high effort.
- `agents/gemini.toml`: `gemini-3.6-flash-high`, VibeProxy, high effort,
  800,000-token context and 700,000-token compaction threshold. This is a local
  role, not an entry in the current 13-model picker catalog. The V2 verification
  described here did not test Gemini.

## Plaintext V2 patch

Stock V2 can generate encrypted delegated instructions that Claude cannot read.
V1 avoids this problem and still runs subagents in the background. V2 adds named
tasks, mailbox coordination, and agent-to-agent messaging.

The local patch retains V2 and makes its newly generated task messages
plaintext. It changes two upstream Rust files, covering `spawn_agent`,
`send_message`, and `followup_task`. The launcher uses an ordinary `agents`
namespace to avoid modifying OpenAI's reserved `collaboration` schema.

The patch does not decrypt old encrypted history. It makes delegated
instructions readable in local rollouts; provider authentication and TLS remain
unchanged. It is a local source patch, not an upstream-supported config option.

The app selects it through:

```text
CODEX_CLI_PATH=~/.codex/patches/v2-plaintext/bin/codex
```

The login LaunchAgent sets the absolute path. Its source plist is kept under
`patches/v2-plaintext/`, with a symlink in `~/Library/LaunchAgents/`.

**Activation status:** the override is enabled. At the last process check, the
running app servers still used the bundled backend. Fully quit and reopen the
app to activate the external backend. Isolated CLI and app-server tests passed;
live desktop UI execution has not yet been verified on it.

### Checks and updates

```sh
# Confirm the next-launch override and backend version.
launchctl getenv CODEX_CLI_PATH
~/.codex/patches/v2-plaintext/bin/codex --version

# After fully quitting the app, launch with the override explicitly.
~/.codex/patches/v2-plaintext/start-chatgpt.sh

# Rebuild after the app's bundled backend version changes, then test.
bun ~/.codex/patches/v2-plaintext/rebuild.ts
bun ~/.codex/patches/v2-plaintext/verify-cli.ts
bun ~/.codex/patches/v2-plaintext/verify-app-server.ts
```

App updates cannot overwrite the external patch files. They can change backend
compatibility: the launcher stops on a version mismatch and prints the rebuild
command. The rebuild script checks whether the patch still applies to matching
official source. Changes upstream may require revising the patch.

Verified paths include GPT → Fable/Opus/GPT, Opus → GPT, and an app-server
GPT → Opus → GPT chain. Initial tasks, messages, follow-ups, and generated
artifacts passed. See the [verification summary](patches/v2-plaintext/verification.json)
and [patch guide](patches/v2-plaintext/README.md) for evidence, limits, and disable
commands.

Upstream reports: [#34833](https://github.com/openai/codex/issues/34833),
[#37197](https://github.com/openai/codex/issues/37197), and
[#46939](https://github.com/openai/codex/issues/46939).

## Idle compaction

The Bun service in `idle-compact/` is registered at login and was running when
inspected. It checks local task data once per minute without model calls.

It considers recently completed root chats with more than 100,000 tokens in the
latest request, then requests compaction after 25 idle minutes. It skips active,
failed, interrupted, archived, subagent, and already-attempted tasks. Compaction
itself uses model tokens. The desktop app must be running with the chat loaded.

```sh
launchctl print gui/$(id -u)/com.cgas.codex-idle-compact
bun ~/.codex/idle-compact/service.ts --check
launchctl kickstart -k gui/$(id -u)/com.cgas.codex-idle-compact
```

This uses a private desktop interface that app updates can change. The
[service README](idle-compact/README.md) documents timing, exclusions, state,
logs, installation, and stop/start commands.

## Skills, browser tools, and local helpers

| Local skill | Purpose |
| --- | --- |
| `consult` | Starts a guarded GPT 6 Pro consultation in the in-app Browser |
| `amazon-support-browser` | Amazon support workflows through connected Chrome |
| `put-chat-to-work` | Private Atelier implementation/PR workflow; the tracked README is a general setup guide |
| `typescript-lsp` | TypeScript 7 code intelligence through a request helper |
| `convert-documents-to-markdown` | Converts office documents and PDFs to Markdown |
| `hatch-pet` | Builds and validates animated Codex pet packages |

Only selected skill files are tracked. App-managed bundled skills and plugin
caches are separate from this custom source repository.

The current MCP configuration includes official OpenAI Developer Docs, the
app's Node/browser runtime, and Playwright's Chrome extension connection. The
older standalone `computer-use` MCP entry is disabled. The notification hook
uses the local computer-use helper at turn completion.

`rules/default.rules` holds stored command-approval rules. `hooks/` also contains
legacy browser-policy detection and patch scripts, but `hooks.json` currently
registers no hooks. Their presence does not establish that they run at startup.

## Version control and local-only data

`.gitignore` uses an allowlist. Tracked files include global instructions, the
catalog, Fable/Opus role files, idle-compaction source, patch source and launch
tools, this README, and selected skills.

The live `config.toml`, authentication, proxy credentials, databases, chat
rollouts, worktrees, browser state, caches, logs, and compiled patch binaries are
not tracked. A clone alone is not a complete installation: recreate local
configuration and authentication, build the backend, and register the required
LaunchAgents using the component guides.

Check the exact staged files before pushing. Avoid adding the whole live Codex
home with `git add -f`.
