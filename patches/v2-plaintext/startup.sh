#!/bin/sh
set -eu
patch_dir=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
if [ -f "$patch_dir/disabled" ]; then exit 0; fi
/bin/launchctl setenv CODEX_CLI_PATH "$patch_dir/bin/codex"
exec /Users/cgas/.bun/bin/bun "$patch_dir/rebuild.ts" --if-needed
