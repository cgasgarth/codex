# Plaintext V2 backend for the ChatGPT app

Built from official OpenAI Codex `rust-v0.160.0`, with a two-file source patch.
No third-party fork or app-bundle modification is used.

## Behavior

The launcher enables V2 with the ordinary `agents` namespace and sets
`CODEX_V2_PLAINTEXT=1`. The patch requests plaintext parameters for
`spawn_agent`, `send_message`, and `followup_task`, then routes these messages
through Codex's existing plaintext delivery path. V2 coordination stays intact.
This disables encryption of delegated instructions for this backend. TLS and
provider authentication are unchanged. Tasks become readable in local rollouts.

The saved global model catalog remains V1. The app launcher overrides that
setting for its process and children. The ordinary installed CLI is unchanged.
Old encrypted records are not decrypted by this patch.

## App launch and updates

`CODEX_CLI_PATH` selects the external backend. A login LaunchAgent sets this
environment variable and checks for updates. It also watches the app's backend
package file. Its plist lives here, with a symlink in
`~/Library/LaunchAgents/com.cgas.codex-v2-plaintext.plist`.
Restart the app after enabling it. The running app retains its original backend.

App updates cannot overwrite these files. When the bundled CLI version changes,
the updater downloads matching official source, checks that the patch applies,
builds a candidate, verifies its version, and checks app-server initialization
and V2 configuration. Only a passing candidate replaces the installed patch.

The build runs in the background because the app has a startup timeout. Until
it passes, or if it fails, app launches use the bundled backend with V1 defaults.
The next app launch uses a ready patched update. The updater does not restart
the app or interrupt existing chats. Concurrent launches share one build.
Details are in `update.log` and `build.log`.

To retry an update manually:

```sh
bun ~/.codex/patches/v2-plaintext/rebuild.ts
```

Source changes may require updating the patch. Builds use `dev-small`, the
installed Rust toolchain, and macOS Command Line Tools. Automatic checks make no
model requests. The full mixed-model probes remain manual:

```sh
bun ~/.codex/patches/v2-plaintext/verify-cli.ts
bun ~/.codex/patches/v2-plaintext/verify-app-server.ts
```

These probes create isolated config and history under `build/probes`. They copy
local authentication into directories with restricted access. Their raw output
stays local and is ignored by Git.

To launch explicitly after fully quitting the app:

```sh
~/.codex/patches/v2-plaintext/start-chatgpt.sh
```

To disable the override:

```sh
~/.codex/patches/v2-plaintext/disable.sh
```

Then fully quit and reopen the app. Its saved model catalog selects V1 again for
new chats; existing chats can retain saved V2 metadata. The disable command also
prevents an in-flight update from activating. To enable the launcher again:

```sh
~/.codex/patches/v2-plaintext/enable.sh
```

## Verified October 4, 2026

- GPT Sol parent: Fable, Opus, and GPT Luna children completed initial tasks,
  proactive messages, follow-ups, and independently verified nonce-bearing files.
- Opus parent: GPT Luna completed the same task and follow-up sequence.
- App-server API: GPT Sol → Opus → GPT Luna chain completed a real file-writing
  task and returned results through both parents.
- Runtime rollouts confirmed V2, requested model IDs, VibeProxy provider, and
  plaintext inter-agent content with no encrypted content parts.
- All 12 existing multi-agent schema tests passed with the patch disabled.

The live desktop UI has not yet been restarted on this backend. App-server
success is backend integration evidence, not desktop UI acceptance.

Local test source and raw evidence are under:
`/Users/cgas/Documents/Codex/2026-09-29/is-s/work/v2-plaintext/`.
