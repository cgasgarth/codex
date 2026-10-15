# Secondwind for VibeProxy

One native plugin and one shared compressor. Compresses JSON data in user text
(including loaded skill documentation), and structured sections in tool results,
across Responses, Chat Completions, and Claude Messages. Uses Secondwind's built-in
lossless codecs; offloading and prose summarization are disabled.

Keeps surrounding text, system instructions, assistant messages, API tool schemas,
tool-call arguments, and images intact. Programming-language fences are preserved.
Compressed JSON fences become text fences because Secondwind emits a table format.

No extra process, per-chat cache, retrieval tool, or artifact storage. VibeProxy
keeps routing, streaming, credentials, and compaction.

Build with `cargo build --release`. The Secondwind revision is pinned in
`Cargo.toml`. Install `target/release/libcpa_secondwind.dylib` as
`~/.cli-proxy-api/plugins/darwin/arm64/cpa-secondwind-v0.6.0.dylib` while the plugin
is disabled, then enable `plugins.configs.cpa-secondwind.enabled` in VibeProxy.
The config is `~/.cli-proxy-api/config.yaml`; the running proxy reads
`merged-config.yaml`.

Disable with `plugins.configs.cpa-secondwind.enabled: false` in both files.

The **Secondwind** sidebar page shows cumulative token estimates and rewrite counts. It loads once when opened; use **Refresh** to update the counts.
It uses the management center's saved login. Counts include retries and resent text blocks; they are not billing
savings. Totals, per-model savings, and the latency histogram are saved after each
request to `~/.local/share/cpa-secondwind/metrics.json` with an atomic file replacement.
This directory is outside CPA's credential scan. Move the existing metrics file there
with the plugin disabled when upgrading from 0.5.0; counters and latency history are retained.
They survive plugin reloads and proxy restarts. Save errors appear on the dashboard.

Median and p99 rewrite time cover each changed request: JSON parsing, compressor
wait, compression, and JSON encoding. They exclude model response time and metrics file writes. A shared
histogram tracks the percentiles without storing individual samples.

API savings use tokens removed per request model × its standard uncached input
price. Public rates checked **2026-10-05** are in `src/input-prices.json` ([OpenAI](https://developers.openai.com/api/docs/pricing), [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing)).
OpenAI uses short-context rates. Cache, fast mode, long-context and regional
adjustments are excluded; models without a public rate show as unpriced.
This is an API equivalent estimate, not subscription or billing savings.
