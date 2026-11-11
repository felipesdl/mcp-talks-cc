#!/usr/bin/env bash
# Pasta de trabalho da task atual (ver src/cli/taskFolder.ts).
#   task-folder.sh path | init [ID] | link KEY
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node --env-file-if-exists="$DIR/.env" --experimental-strip-types --no-warnings "$DIR/src/cli/taskFolder.ts" "$@"
