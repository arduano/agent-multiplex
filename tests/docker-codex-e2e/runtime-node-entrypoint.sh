#!/bin/sh
set -eu

: "${CODEX_HOME:?CODEX_HOME is required}"

echo "Waiting for runtime-copied Codex provider configuration and credential."
while [ ! -r "$CODEX_HOME/config.toml" ] || [ ! -r "$CODEX_HOME/codex-lb-api-key" ]; do
  sleep 0.1
done

chmod 600 "$CODEX_HOME/config.toml" "$CODEX_HOME/codex-lb-api-key"
echo "Runtime Codex auth material is present; starting the Multiplex runtime node."
exec node /opt/src/agent-multiplex/apps/runtime-node/dist/main.js
