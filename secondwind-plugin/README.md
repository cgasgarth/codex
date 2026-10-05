# Secondwind for VibeProxy

One native plugin and one shared compressor. Rewrites tool outputs in Responses,
Chat Completions, and Claude Messages requests. Uses Secondwind's built-in lossless
codecs; offloading is disabled and prose summarization is not enabled.

No extra process, per-chat cache, retrieval tool, or artifact storage. VibeProxy
keeps routing, streaming, credentials, and compaction.

Build with `cargo build --release`. The Secondwind revision is pinned in
`Cargo.toml`. Install `target/release/libcpa_secondwind.dylib` as
`~/.cli-proxy-api/plugins/darwin/arm64/cpa-secondwind-v0.4.0.dylib` while the plugin
is disabled, then enable `plugins.configs.cpa-secondwind.enabled` in VibeProxy.
The config is `~/.cli-proxy-api/config.yaml`; the running proxy reads
`merged-config.yaml`.

Disable with `plugins.configs.cpa-secondwind.enabled: false` in both files.

The **Secondwind** sidebar page shows token estimates and rewrite counts since
plugin load. It loads once when opened; use **Refresh** to update the counts.
It uses the management center's saved login. Counts include retries and resent tool outputs; they are not billing
savings. Counters reset when the plugin reloads.

Median and p99 rewrite time cover each changed request: JSON parsing, compressor
wait, compression, and JSON encoding. They exclude model response time. A shared
histogram tracks the percentiles without storing individual samples.

API savings use tokens removed per request model × its standard uncached input
price. Public rates checked **2026-10-05** are in `src/input-prices.json` ([OpenAI](https://developers.openai.com/api/docs/pricing), [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing)).
OpenAI uses short-context rates. Cache, fast mode, long-context and regional
adjustments are excluded; models without a public rate show as unpriced.
This is an API equivalent estimate, not subscription or billing savings.
