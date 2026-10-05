#!/bin/sh
set -eu
patch_dir=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
export CODEX_CLI_PATH="$patch_dir/bin/codex"
exec /Applications/ChatGPT.app/Contents/MacOS/ChatGPT "$@"
