# Secondwind for VibeProxy

One native plugin and one shared compressor. Rewrites tool outputs in Responses,
Chat Completions, and Claude Messages requests. Uses Secondwind's built-in lossless
codecs; offloading is disabled and prose summarization is not enabled.

No extra process, per-chat cache, retrieval tool, or artifact storage. VibeProxy
keeps routing, streaming, credentials, and compaction.

Build with `cargo build --release`. The Secondwind revision is pinned in
`Cargo.toml`. Install `target/release/libcpa_secondwind.dylib` as
`~/.cli-proxy-api/plugins/darwin/arm64/cpa-secondwind-v0.2.0.dylib` while the plugin
is disabled, then enable `plugins.configs.cpa-secondwind.enabled` in VibeProxy.
The config is `~/.cli-proxy-api/config.yaml`; the running proxy reads
`merged-config.yaml`.

Disable with `plugins.configs.cpa-secondwind.enabled: false` in both files.

The **Secondwind** sidebar page shows token estimates and rewrite counts since
plugin load. It refreshes every five seconds and uses the management center's
saved login. Counts include retries and resent tool outputs; they are not billing
savings. Counters reset when the plugin reloads.
