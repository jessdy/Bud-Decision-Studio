#!/usr/bin/env bash
set -euo pipefail

export BASAL_DATA="${BASAL_DATA:-/data}"
export HF_HOME="${HF_HOME:-/models}"
export HF_HUB_CACHE="${HF_HUB_CACHE:-/models/hub}"
export BASAL_HOST="${BASAL_HOST:-0.0.0.0}"
export BASAL_PORT="${BASAL_PORT:-8420}"

mkdir -p "$BASAL_DATA" "$HF_HUB_CACHE" "$BASAL_DATA/logs" "$BASAL_DATA/uploads"

SEED="${BUD_CONFIG_SEED:-/opt/bud/config.json}"
if [ ! -f "$BASAL_DATA/config.json" ] && [ -f "$SEED" ]; then
  cp "$SEED" "$BASAL_DATA/config.json"
fi

cd /app
exec "$@"
