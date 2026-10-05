# Local Codex setup

## Routing

```mermaid
flowchart LR
    App[ChatGPT app] --> Patch[Patched V2 backend]
    CLI[Standard Codex CLI · V1] --> Proxy
    Patch --> Proxy[VibeProxy · localhost:8318]
    Proxy --> OpenAI
    Proxy --> Claude
```

OpenAI and Claude both use VibeProxy. The default is Sol 6.1, high effort,
priority tier. Settings live in `config.toml`; model names, context limits, and
compaction thresholds live in [model-catalog.json](model-catalog.json).

VibeProxy must be running and authenticated. Its overrides live in
`~/.cli-proxy-api/config.yaml`. Client → proxy supports WebSockets; Claude's
upstream connection uses HTTP/SSE.

## Plaintext V2 patch

Stock V2 encrypts delegated tasks that Claude cannot read. Our two-file patch
requests plaintext for spawn, messages, and follow-ups while retaining V2
coordination. GPT ↔ Claude tests passed, including a nested GPT → Opus → GPT
chain through the app-server API. Old encrypted history is not decrypted.

| Launch / update | Behavior |
| --- | --- |
| App startup | A login LaunchAgent sets `CODEX_CLI_PATH` to the external launcher |
| Activation | Fully quit and reopen the app; live UI execution still needs verification |
| App update | Automatically applies the patch, builds, and checks app-server startup in the background |
| While updating / on failure | Uses the bundled backend with V1 defaults; details in `patches/v2-plaintext/update.log` |
| Update ready | The next app launch uses the new patched backend |

```sh
# Disable the patch, then fully quit and reopen the app.
~/.codex/patches/v2-plaintext/disable.sh

# Enable it again, then fully quit and reopen the app.
~/.codex/patches/v2-plaintext/enable.sh
```

Automatic checks use no model tokens. If the patch no longer applies or startup
fails, it is not activated. Full GPT/Claude tests remain available manually in
the [patch guide](patches/v2-plaintext/README.md). The standard CLI retains V1.

## Other custom settings

| Component | Purpose |
| --- | --- |
| [Idle compaction](idle-compact/README.md) | Login service; compacts eligible chats after 25 idle minutes when the latest request exceeds 100k tokens |
| `agents/` | Named Fable, Opus, and Gemini roles through VibeProxy |
| [AGENTS.md](AGENTS.md) | Global engineering and communication instructions |

Idle compaction requires the app to be running. It uses a private desktop
interface, so app updates can affect it.
