# Codex router and codex-lb

`codex-lb` is the local API server for Codex. The LaunchAgent runs it on
`127.0.0.1:2455`. `codex-router` switches new Codex sessions between this server
and the signed-in OpenAI account.

## Commands

Open a new terminal or reload `~/.zshrc` to use these aliases:

```sh
codex-lb:on
codex-lb:off
```

To check the route and service, run `codex-router status`.

- `codex-router on` updates and starts `codex-lb`, then routes Codex through it.
- `codex-router off` removes the router endpoint from the config and stops the
  service.
- Add `--restart-app` to either command to restart ChatGPT and apply the route.

## Model limits

The local `~/.codex/config.toml` points to the model catalog:

```toml
model_catalog_json = "/Users/cgas/.codex/model-catalog.json"
```

The router ensures this setting in both states. Per-model context and
automatic compaction limits live in `model-catalog.json`. GPT-6 Astra and
`sol-6.1` are set to an 872,000-token context window and a
700,000-token automatic compaction threshold.

Codex loads the model catalog at startup. Restart ChatGPT after a catalog change
to use the new values.
