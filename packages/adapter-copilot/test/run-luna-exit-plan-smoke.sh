#!/usr/bin/env bash
# One synthetic gpt-6-luna prompt in a disposable glibc container. Never use a
# production session/home. The API key is bind-mounted read-only, not logged.
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
key=${AGENT_MULTIPLEX_COPILOT_SOURCE_KEY:-"$HOME/.codex/codex-lb-api-key"}
config=${AGENT_MULTIPLEX_COPILOT_SOURCE_CONFIG:-"$HOME/.codex/config.toml"}
ca=$(readlink -f /etc/ssl/certs/ca-certificates.crt)
name="agent-multiplex-plan-$RANDOM-$$"
[[ -r "$key" && -r "$config" && -s "$ca" && -f "$repo/packages/adapter-copilot/test/luna-exit-plan-smoke.mjs" ]] || { echo 'Luna smoke preflight missing input' >&2; exit 2; }
if docker container inspect "$name" >/dev/null 2>&1; then echo 'Disposable container name already in use; refusing collision' >&2; exit 2; fi
cleanup() { if docker container inspect "$name" >/dev/null 2>&1; then docker rm -f "$name" >/dev/null 2>&1 || true; fi; }
trap cleanup EXIT
provider_url=$(awk '
  /^\[model_providers\.codex-lb\]$/ { in_provider = 1; next }
  in_provider && /^\[/ { exit }
  in_provider && /^[[:space:]]*base_url[[:space:]]*=/ {
    sub(/^[^=]*=[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit
  }
' "$config")
[[ -n "$provider_url" ]] || { echo 'codex-lb provider URL not configured' >&2; exit 2; }
node -e 'const u=new URL(process.argv[1]);if(!/^https?:$/.test(u.protocol)||u.username||u.password||u.search||u.hash)process.exit(1)' "$provider_url"
cd "$repo"
timeout --signal=TERM --kill-after=10s 240s docker run --rm --name "$name" \
  --network bridge --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 2g \
  --tmpfs /tmp:rw,exec,nosuid,nodev,mode=1777 \
  --mount "type=bind,src=$repo,dst=/work,readonly" \
  --mount "type=bind,src=$key,dst=/run/secrets/codex-lb-api-key,readonly" \
  --mount "type=bind,src=$ca,dst=/run/ca-bundle.pem,readonly" \
  --workdir /work --user "$(id -u):$(id -g)" \
  --env HOME=/tmp --env XDG_CACHE_HOME=/tmp/cache --env COPILOT_TEST_MODEL=gpt-6-luna \
  --env COPILOT_TEST_KEY_FILE=/run/secrets/codex-lb-api-key \
  --env "COPILOT_TEST_BASE_URL=$provider_url" \
  'node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df' \
  node --import tsx packages/adapter-copilot/test/luna-exit-plan-smoke.mjs
