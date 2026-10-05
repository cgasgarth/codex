#!/bin/sh
set -eu
patch_dir=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
if [ -f "$patch_dir/disabled" ]; then unlink "$patch_dir/disabled"; fi
link="$HOME/Library/LaunchAgents/com.cgas.codex-v2-plaintext.plist"
if [ ! -e "$link" ] && [ ! -L "$link" ]; then ln -s "$patch_dir/com.cgas.codex-v2-plaintext.plist" "$link"; fi
label="gui/$(id -u)/com.cgas.codex-v2-plaintext"
if ! launchctl print "$label" >/dev/null 2>&1; then launchctl bootstrap "gui/$(id -u)" "$link"; fi
launchctl setenv CODEX_CLI_PATH "$patch_dir/bin/codex"
echo "Patch enabled. Fully quit and reopen ChatGPT to use the launcher."
