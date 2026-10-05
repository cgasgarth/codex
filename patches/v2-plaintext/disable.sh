#!/bin/sh
set -eu
patch_dir=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
touch "$patch_dir/disabled"
label="gui/$(id -u)/com.cgas.codex-v2-plaintext"
if launchctl print "$label" >/dev/null 2>&1; then launchctl bootout "$label"; fi
launchctl unsetenv CODEX_CLI_PATH
link="$HOME/Library/LaunchAgents/com.cgas.codex-v2-plaintext.plist"
if [ -L "$link" ] && [ "$(readlink "$link")" = "$patch_dir/com.cgas.codex-v2-plaintext.plist" ]; then unlink "$link"; fi
echo "Patch disabled. Fully quit and reopen ChatGPT to use its bundled backend."
