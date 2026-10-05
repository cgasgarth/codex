# Compact Bridge replay fix

Local patch for upstream Codex Compact Bridge v0.2.0. No Codex or VibeProxy binary
changes. GPT native compaction stays on passthrough.

The stock bridge routes compaction through its executor but sends the next
streaming replay through CPA's built-in route. CPA then merges the old WebSocket
history back into the compacted history. This causes repeated compaction.

`bridge.patch` keeps compacted replays on the same executor and relays their
responses through the host streaming API. One regression test checks that old
history stays removed and the summary survives later incremental turns.

Apply `bridge.patch` to an upstream checkout with `git apply`. Build from its
`plugin` directory using a working C toolchain:

```sh
go build -buildmode=c-shared -ldflags '-X main.pluginVersion=0.2.0-local1' \
  -o cpa-codex-compact-bridge-v0.2.0-local1.dylib .
```

Disable the bridge, move its old binary out of the plugin directory, install the
new dylib in `~/.cli-proxy-api/plugins/darwin/arm64`, then enable it. VibeProxy
hot-loads it. A Plugin Store update can replace this fix; reapply it until upstream
includes the correction. Restore the stock plugin through the Plugin Store to undo.
