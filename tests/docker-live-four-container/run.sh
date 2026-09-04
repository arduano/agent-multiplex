#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
DOCKER_NPMRC=${AGENT_MULTIPLEX_DOCKER_NPMRC:-}
SOURCE_CONFIG=${AGENT_MULTIPLEX_LIVE_SOURCE_CONFIG:-"${HOME}/.codex/config.toml"}
SOURCE_KEY=${AGENT_MULTIPLEX_LIVE_SOURCE_KEY:-"${HOME}/.codex/codex-lb-api-key"}
RECEIPT_ROOT=${AGENT_MULTIPLEX_LIVE_RECEIPT_ROOT:-"$REPO_ROOT/receipts/protocol-v4-live-four-container"}
TIMEOUT_MS=${AGENT_MULTIPLEX_LIVE_TIMEOUT_MS:-600000}
INITIAL_CODEX_MODEL=${AGENT_MULTIPLEX_LIVE_CODEX_MODEL:-gpt-5.6-sol}
SECOND_CODEX_MODEL=${AGENT_MULTIPLEX_LIVE_CODEX_SECOND_MODEL:-gpt-5.6-terra}
COPILOT_MODEL=${AGENT_MULTIPLEX_LIVE_COPILOT_MODEL:-gpt-5.6-sol}
KEEP=${AGENT_MULTIPLEX_LIVE_KEEP:-0}
SOAK_MS=${AGENT_MULTIPLEX_LIVE_SOAK_MS:-0}

note() { printf '[live-four-container] %s\n' "$*" >&2; }
fail() { note "FAILED: $*"; return 1; }
random_hex() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))'
}

if [[ ! "$TIMEOUT_MS" =~ ^[0-9]+$ ]] || (( TIMEOUT_MS < 1 )); then
  echo "live four-container acceptance: TIMEOUT_MS must be a positive integer" >&2
  exit 1
fi
if [[ "$KEEP" != 0 && "$KEEP" != 1 ]]; then
  echo "live four-container acceptance: AGENT_MULTIPLEX_LIVE_KEEP must be 0 or 1" >&2
  exit 1
fi
if [[ ! "$SOAK_MS" =~ ^[0-9]+$ ]] || (( ${#SOAK_MS} > 8 )); then
  echo "live four-container acceptance: AGENT_MULTIPLEX_LIVE_SOAK_MS must be an integer from 0 through 86400000" >&2
  exit 1
fi
SOAK_MS=$((10#$SOAK_MS))
if (( SOAK_MS > 86400000 )); then
  echo "live four-container acceptance: AGENT_MULTIPLEX_LIVE_SOAK_MS must be an integer from 0 through 86400000" >&2
  exit 1
fi
if [[ "$INITIAL_CODEX_MODEL" == "$SECOND_CODEX_MODEL" ]]; then
  echo "live four-container acceptance: the two Codex models must differ" >&2
  exit 1
fi
for value_name in INITIAL_CODEX_MODEL SECOND_CODEX_MODEL COPILOT_MODEL; do
  value=${!value_name}
  if [[ -z "$value" || "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "live four-container acceptance: $value_name must be a non-empty single-line model ID" >&2
    exit 1
  fi
done
for tool in docker git jq node npm curl sha256sum awk sed perl rg timeout find sort xargs systemctl systemd-run; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "live four-container acceptance: required tool '$tool' is unavailable" >&2
    exit 1
  fi
done
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)" ]]; then
  echo "live four-container acceptance: the source worktree must be clean" >&2
  exit 1
fi
SOURCE_COMMIT=$(git -C "$REPO_ROOT" rev-parse --verify 'HEAD^{commit}')
if [[ ! "$SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
  echo "live four-container acceptance: unable to resolve an exact source commit" >&2
  exit 1
fi
if [[ -z "$DOCKER_NPMRC" ]]; then
  DOCKER_NPMRC=$(npm config get userconfig)
fi
if [[ ! -f "$DOCKER_NPMRC" || ! -r "$DOCKER_NPMRC" ]]; then
  echo "live four-container acceptance: a readable npm user config is required for the GitHub Packages build secret" >&2
  exit 1
fi
if [[ ! -r "$SOURCE_CONFIG" ]]; then
  echo "live four-container acceptance: Codex source config is unreadable: $SOURCE_CONFIG" >&2
  exit 1
fi
if [[ ! -r "$SOURCE_KEY" ]]; then
  echo "live four-container acceptance: codex-lb key file is unreadable: $SOURCE_KEY" >&2
  exit 1
fi

RUN_ID=${AGENT_MULTIPLEX_LIVE_RUN_ID:-"$(date -u +%Y%m%dT%H%M%SZ)-$(random_hex)"}
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$ ]]; then
  echo "live four-container acceptance: run ID must start alphanumeric and contain at most 48 supported characters" >&2
  exit 1
fi
RECEIPT_DIR="$RECEIPT_ROOT/$RUN_ID"
if [[ -e "$RECEIPT_DIR" ]]; then
  echo "live four-container acceptance: receipt already exists: $RECEIPT_DIR" >&2
  exit 1
fi
mkdir -p "$RECEIPT_DIR/logs" "$RECEIPT_DIR/rpc" "$RECEIPT_DIR/phases" \
  "$RECEIPT_DIR/coord" "$RECEIPT_DIR/screenshots"

RUNTIME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-multiplex-live-four.XXXXXXXX")
mkdir -p "$RUNTIME_DIR/authority-state" "$RUNTIME_DIR/gateway-state" \
  "$RUNTIME_DIR/codex-home" "$RUNTIME_DIR/codex-workspace" "$RUNTIME_DIR/copilot-workspace"
chmod 700 "$RUNTIME_DIR" "$RUNTIME_DIR"/*
NAME_SUFFIX=$(printf '%s' "$RUN_ID" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9' | tail -c 22)
CONTROL_CONTAINER="multiplex-live-control-$NAME_SUFFIX"
GATEWAY_CONTAINER="multiplex-live-gateway-$NAME_SUFFIX"
CODEX_CONTAINER="multiplex-live-codex-$NAME_SUFFIX"
COPILOT_CONTAINER="multiplex-live-copilot-$NAME_SUFFIX"
NETWORK_NAME="multiplex-live-four-$NAME_SUFFIX"
IMAGE_TAG="agent-multiplex-live-four:$NAME_SUFFIX"
CODEX_RUNTIME_NAME="live-codex-$NAME_SUFFIX"
COPILOT_RUNTIME_NAME="live-copilot-$NAME_SUFFIX"
SHARED_SECRET=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))')
ACCESS_TOKEN=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))')
printf '%s\n' "$ACCESS_TOKEN" >"$RUNTIME_DIR/access-token"
RUN_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

declare -a CONTAINERS=()
CONTROL_STARTED=0
GATEWAY_STARTED=0
CODEX_STARTED=0
COPILOT_STARTED=0
NETWORK_CREATED=0
IMAGE_BUILT=0
COMPLETED=0
LOGS_CAPTURED=0
WATCH_PID=""
STATS_PID=""
PROVIDER_PROXY_PID=""
PROVIDER_PROXY_UNIT=""
PROVIDER_PROXY_STOP_STATE=not-configured
CLEANUP_COMPLETED=0
CONTROL_ENDPOINT_ID=""
CONTROL_TICKET=""
PROVIDER_URL=""
PROVIDER_ORIGIN=""
API_KEY_LITERAL=""
GATEWAY_URL=""
TRPC_URL=""
IMAGE_ID=""
PROXIED_PROVIDER_URL=""
PROXIED_PROVIDER_ORIGIN=""
TERMINAL_MARKER_FILE="$RUNTIME_DIR/terminal-ephemerality-marker"

secret_values_present_in_receipt() {
  local forbidden
  for forbidden in "$SHARED_SECRET" "$ACCESS_TOKEN" "$CONTROL_TICKET" "$API_KEY_LITERAL" \
    "$PROVIDER_URL" "$PROVIDER_ORIGIN" "$PROXIED_PROVIDER_URL" "$PROXIED_PROVIDER_ORIGIN"; do
    if [[ -n "$forbidden" ]] && rg --text --fixed-strings --quiet -- "$forbidden" "$RECEIPT_DIR"; then
      return 0
    fi
  done
  rg --text --quiet 'p2prpc3\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{80,}' "$RECEIPT_DIR"
}

scrub_failed_receipt() {
  local forbidden filename temporary
  while IFS= read -r -d '' filename; do
    # Screenshots and other binary evidence cannot safely be rewritten. Remove
    # them on a failed run if a secret byte sequence appears verbatim.
    if ! LC_ALL=C awk 'BEGIN { binary = 0 } index($0, "\0") { binary = 1; exit } END { exit binary ? 0 : 1 }' \
      "$filename" 2>/dev/null; then
      temporary="$RUNTIME_DIR/scrub.$(random_hex)"
      AM_LIVE_SHARED="$SHARED_SECRET" \
      AM_LIVE_ACCESS="$ACCESS_TOKEN" \
      AM_LIVE_TICKET="$CONTROL_TICKET" \
      AM_LIVE_KEY="$API_KEY_LITERAL" \
      AM_LIVE_PROVIDER="$PROVIDER_URL" \
      AM_LIVE_PROVIDER_ORIGIN="$PROVIDER_ORIGIN" \
      AM_LIVE_PROXY_PROVIDER="$PROXIED_PROVIDER_URL" \
      AM_LIVE_PROXY_PROVIDER_ORIGIN="$PROXIED_PROVIDER_ORIGIN" \
        perl -0pe '
          BEGIN {
            @values = ($ENV{AM_LIVE_SHARED}, $ENV{AM_LIVE_ACCESS}, $ENV{AM_LIVE_TICKET},
              $ENV{AM_LIVE_KEY}, $ENV{AM_LIVE_PROVIDER}, $ENV{AM_LIVE_PROVIDER_ORIGIN},
              $ENV{AM_LIVE_PROXY_PROVIDER}, $ENV{AM_LIVE_PROXY_PROVIDER_ORIGIN});
          }
          for $value (@values) { s/\Q$value\E/<redacted-sensitive-value>/g if defined($value) && length($value); }
          s/p2prpc3\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{80,}/<redacted-p2p-ticket>/g;
        ' "$filename" >"$temporary" && mv -f -- "$temporary" "$filename"
      continue
    fi
    for forbidden in "$SHARED_SECRET" "$ACCESS_TOKEN" "$CONTROL_TICKET" "$API_KEY_LITERAL" \
      "$PROVIDER_URL" "$PROVIDER_ORIGIN" "$PROXIED_PROVIDER_URL" "$PROXIED_PROVIDER_ORIGIN"; do
      if [[ -n "$forbidden" ]] && rg --text --fixed-strings --quiet -- "$forbidden" "$filename"; then
        rm -f -- "$filename"
        break
      fi
    done
  done < <(find "$RECEIPT_DIR" -type f -print0)
}

redact_stream() {
  AM_LIVE_SHARED="$SHARED_SECRET" \
  AM_LIVE_ACCESS="$ACCESS_TOKEN" \
  AM_LIVE_TICKET="$CONTROL_TICKET" \
  AM_LIVE_KEY="$API_KEY_LITERAL" \
  AM_LIVE_PROVIDER="$PROVIDER_URL" \
  AM_LIVE_PROVIDER_ORIGIN="$PROVIDER_ORIGIN" \
  AM_LIVE_PROXY_PROVIDER="$PROXIED_PROVIDER_URL" \
  AM_LIVE_PROXY_PROVIDER_ORIGIN="$PROXIED_PROVIDER_ORIGIN" \
    perl -0pe '
      BEGIN {
        @pairs = (
          [$ENV{AM_LIVE_SHARED} // "", "<redacted-shared-secret>"],
          [$ENV{AM_LIVE_ACCESS} // "", "<redacted-access-token>"],
          [$ENV{AM_LIVE_TICKET} // "", "<redacted-p2p-ticket>"],
          [$ENV{AM_LIVE_KEY} // "", "<redacted-codex-lb-api-key>"],
          [$ENV{AM_LIVE_PROVIDER} // "", "<redacted-provider-endpoint>"],
          [$ENV{AM_LIVE_PROVIDER_ORIGIN} // "", "<redacted-provider-origin>"],
          [$ENV{AM_LIVE_PROXY_PROVIDER} // "", "<redacted-provider-relay-endpoint>"],
          [$ENV{AM_LIVE_PROXY_PROVIDER_ORIGIN} // "", "<redacted-provider-relay-origin>"],
        );
      }
      for $pair (@pairs) {
        ($value, $replacement) = @$pair;
        s/\Q$value\E/$replacement/g if length($value);
      }
      s/p2prpc3\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{80,}/<redacted-p2p-ticket>/g;
    '
}

capture_one_log() {
  local container=$1
  local label=$2
  local raw="$RUNTIME_DIR/$label.raw.log"
  if ! docker inspect "$container" >/dev/null 2>&1; then return; fi
  docker logs "$container" >"$raw" 2>&1 || true
  awk '
    redact_next { print "<redacted-p2p-ticket>"; redact_next = 0; next }
    /^P2P ticket \(/ { print; redact_next = 1; next }
    { print }
  ' "$raw" | redact_stream >"$RECEIPT_DIR/logs/$label.log"
  docker top "$container" -eo pid,ppid,user,args 2>&1 \
    | redact_stream >"$RECEIPT_DIR/logs/$label-processes.txt" || true
}

capture_logs() {
  if (( LOGS_CAPTURED == 1 )); then return; fi
  capture_one_log "$CONTROL_CONTAINER" control-node
  capture_one_log "$GATEWAY_CONTAINER" access-gateway
  capture_one_log "$CODEX_CONTAINER" codex-runtime-node
  capture_one_log "$COPILOT_CONTAINER" copilot-runtime-node
  LOGS_CAPTURED=1
}

write_handoff() {
  local cleanup_script="$RECEIPT_DIR/cleanup-retained.sh"
  local cleanup_result="$RECEIPT_DIR/cleanup-retained-result.json"
  local cleanup_command
  local expected_control_id expected_gateway_id expected_codex_id expected_copilot_id
  local expected_network_id expected_image_id
  expected_control_id=$(docker container inspect --format '{{.Id}}' "$CONTROL_CONTAINER" 2>/dev/null || true)
  expected_gateway_id=$(docker container inspect --format '{{.Id}}' "$GATEWAY_CONTAINER" 2>/dev/null || true)
  expected_codex_id=$(docker container inspect --format '{{.Id}}' "$CODEX_CONTAINER" 2>/dev/null || true)
  expected_copilot_id=$(docker container inspect --format '{{.Id}}' "$COPILOT_CONTAINER" 2>/dev/null || true)
  expected_network_id=$(docker network inspect --format '{{.Id}}' "$NETWORK_NAME" 2>/dev/null || true)
  expected_image_id=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG" 2>/dev/null || true)
  {
    printf '#!/usr/bin/env bash\nset -Eeuo pipefail\n\n'
    printf 'cleanup_ok=true\nidentity_mismatch=false\n'
    printf 'docker_observation=unknown\ndocker_observed_id=\n'
    printf 'observe_docker_resource() {\n'
    printf '  local kind=$1 name=$2 listing candidate\n'
    printf '  docker_observation=unknown; docker_observed_id=\n'
    printf '  case "$kind" in\n'
    printf '    container)\n'
    printf '      if docker_observed_id=$(docker container inspect --format '\''{{.Id}}'\'' "$name" 2>/dev/null); then docker_observation=present; return; fi\n'
    printf '      if ! listing=$(docker container ls --all --format '\''{{.Names}}'\'' 2>/dev/null); then return; fi ;;\n'
    printf '    network)\n'
    printf '      if docker_observed_id=$(docker network inspect --format '\''{{.Id}}'\'' "$name" 2>/dev/null); then docker_observation=present; return; fi\n'
    printf '      if ! listing=$(docker network ls --format '\''{{.Name}}'\'' 2>/dev/null); then return; fi ;;\n'
    printf '    image)\n'
    printf '      if docker_observed_id=$(docker image inspect --format '\''{{.Id}}'\'' "$name" 2>/dev/null); then docker_observation=present; return; fi\n'
    printf '      if ! listing=$(docker image ls --format '\''{{.Repository}}:{{.Tag}}'\'' 2>/dev/null); then return; fi ;;\n'
    printf '    *) return ;;\n'
    printf '  esac\n'
    printf '  docker_observation=absent\n'
    printf '  while IFS= read -r candidate; do\n'
    printf '    if [[ "$candidate" == "$name" ]]; then docker_observation=unknown; return; fi\n'
    printf '  done <<<"$listing"\n'
    printf '}\n'
    printf 'remove_fenced_container() {\n'
    printf '  local name=$1 expected=$2 current\n'
    printf '  observe_docker_resource container "$name"; current=$docker_observed_id\n'
    printf '  if [[ "$docker_observation" == absent ]]; then return 0; fi\n'
    printf '  if [[ "$docker_observation" != present ]]; then\n'
    printf '    printf '\''unable to inspect container %%s; preserving recovery data\\n'\'' "$name" >&2\n'
    printf '    cleanup_ok=false; return 0\n'
    printf '  fi\n'
    printf '  if [[ -z "$expected" || "$current" != "$expected" ]]; then\n'
    printf '    printf '\''refusing to remove container %%s: identity mismatch\\n'\'' "$name" >&2\n'
    printf '    cleanup_ok=false; identity_mismatch=true; return 0\n'
    printf '  fi\n'
    printf '  if ! docker rm --force -- "$name" >/dev/null; then cleanup_ok=false; fi\n'
    printf '}\n'
    printf 'remove_fenced_container %q %q\n' "$CODEX_CONTAINER" "$expected_codex_id"
    printf 'remove_fenced_container %q %q\n' "$COPILOT_CONTAINER" "$expected_copilot_id"
    printf 'remove_fenced_container %q %q\n' "$GATEWAY_CONTAINER" "$expected_gateway_id"
    printf 'remove_fenced_container %q %q\n' "$CONTROL_CONTAINER" "$expected_control_id"
    printf 'provider_proxy_unit=%q\n' "$PROVIDER_PROXY_UNIT"
    printf 'provider_proxy_script=%q\n' "$SCRIPT_DIR/provider-proxy.mjs"
    printf 'provider_proxy_ready=%q\n' "$RUNTIME_DIR/provider-proxy-ready.json"
    printf 'provider_proxy_stopped=true\n'
    printf 'provider_proxy_state=not-configured\n'
    printf 'if [[ -n "$provider_proxy_unit" ]]; then\n'
    printf '  provider_proxy_stopped=false; provider_proxy_state=manager-error\n'
    printf '  if ! provider_proxy_load_state=$(systemctl --user show --property=LoadState --value "$provider_proxy_unit" 2>/dev/null) || [[ -z "$provider_proxy_load_state" ]]; then\n'
    printf '    printf '\''unable to inspect provider relay load state; preserving recovery data\\n'\'' >&2\n'
    printf '    cleanup_ok=false\n'
    printf '  elif [[ "$provider_proxy_load_state" == not-found ]]; then\n'
    printf '    provider_proxy_stopped=true; provider_proxy_state=not-found\n'
    printf '  elif ! provider_proxy_command=$(systemctl --user show --property=ExecStart --value "$provider_proxy_unit" 2>/dev/null) || [[ -z "$provider_proxy_command" ]]; then\n'
    printf '    printf '\''unable to inspect provider relay identity; preserving recovery data\\n'\'' >&2\n'
    printf '    cleanup_ok=false\n'
    printf '  elif [[ "$provider_proxy_command" == *"$provider_proxy_script"* && "$provider_proxy_command" == *"$provider_proxy_ready"* ]]; then\n'
    printf '    if ! systemctl --user stop "$provider_proxy_unit" >/dev/null 2>&1; then\n'
    printf '      printf '\''provider relay stop request failed; verifying its state\\n'\'' >&2\n'
    printf '    fi\n'
    printf '    if ! provider_proxy_load_state=$(systemctl --user show --property=LoadState --value "$provider_proxy_unit" 2>/dev/null) || [[ -z "$provider_proxy_load_state" ]]; then\n'
    printf '      printf '\''unable to verify provider relay after stop; preserving recovery data\\n'\'' >&2\n'
    printf '      provider_proxy_state=manager-error; cleanup_ok=false\n'
    printf '    elif [[ "$provider_proxy_load_state" == not-found ]]; then\n'
    printf '      provider_proxy_stopped=true; provider_proxy_state=not-found\n'
    printf '    elif ! provider_proxy_active_state=$(systemctl --user show --property=ActiveState --value "$provider_proxy_unit" 2>/dev/null) || [[ -z "$provider_proxy_active_state" ]]; then\n'
    printf '      printf '\''unable to verify provider relay active state; preserving recovery data\\n'\'' >&2\n'
    printf '      provider_proxy_state=manager-error; cleanup_ok=false\n'
    printf '    elif [[ "$provider_proxy_active_state" == inactive || "$provider_proxy_active_state" == failed ]]; then\n'
    printf '      provider_proxy_stopped=true; provider_proxy_state=stopped\n'
    printf '      systemctl --user reset-failed "$provider_proxy_unit" >/dev/null 2>&1 || true\n'
    printf '    else\n'
    printf '      printf '\''provider relay is not stopped; preserving recovery data\\n'\'' >&2\n'
    printf '      provider_proxy_state=not-stopped; cleanup_ok=false\n'
    printf '    fi\n'
    printf '  else\n'
    printf '    printf '\''refusing to stop provider relay: service identity mismatch\\n'\'' >&2\n'
    printf '    provider_proxy_state=identity-mismatch; cleanup_ok=false; identity_mismatch=true\n'
    printf '  fi\n'
    printf 'fi\n'
    printf 'network_name=%q\nnetwork_id=%q\n' "$NETWORK_NAME" "$expected_network_id"
    printf 'observe_docker_resource network "$network_name"; current_network_id=$docker_observed_id\n'
    printf 'if [[ "$docker_observation" == present ]]; then\n'
    printf '  if [[ -n "$network_id" && "$current_network_id" == "$network_id" ]]; then\n'
    printf '    docker network rm -- "$network_name" >/dev/null || cleanup_ok=false\n'
    printf '  else\n'
    printf '    printf '\''refusing to remove network %%s: identity mismatch\\n'\'' "$network_name" >&2\n'
    printf '    cleanup_ok=false; identity_mismatch=true\n'
    printf '  fi\n'
    printf 'elif [[ "$docker_observation" != absent ]]; then\n'
    printf '  printf '\''unable to inspect network %%s; preserving recovery data\\n'\'' "$network_name" >&2\n'
    printf '  cleanup_ok=false\n'
    printf 'fi\n'
    printf 'image_tag=%q\nimage_id=%q\n' "$IMAGE_TAG" "$expected_image_id"
    printf 'observe_docker_resource image "$image_tag"; current_image_id=$docker_observed_id\n'
    printf 'if [[ "$docker_observation" == present ]]; then\n'
    printf '  if [[ -n "$image_id" && "$current_image_id" == "$image_id" ]]; then\n'
    printf '    docker image rm -- "$image_tag" >/dev/null || cleanup_ok=false\n'
    printf '  else\n'
    printf '    printf '\''refusing to remove image tag %%s: identity mismatch\\n'\'' "$image_tag" >&2\n'
    printf '    cleanup_ok=false; identity_mismatch=true\n'
    printf '  fi\n'
    printf 'elif [[ "$docker_observation" != absent ]]; then\n'
    printf '  printf '\''unable to inspect image tag %%s; preserving recovery data\\n'\'' "$image_tag" >&2\n'
    printf '  cleanup_ok=false\n'
    printf 'fi\n'
    printf 'runtime_directory=%q\n' "$RUNTIME_DIR"
    printf 'runtime_removed=true\n'
    printf 'if [[ -e "$runtime_directory" ]]; then\n'
    printf '  if [[ "$cleanup_ok" != true ]]; then\n'
    printf '    printf '\''preserving runtime directory because resource cleanup was incomplete\\n'\'' >&2\n'
    printf '    runtime_removed=false\n'
    printf '  elif [[ -d "$runtime_directory" && ! -L "$runtime_directory" && "$(basename -- "$runtime_directory")" == agent-multiplex-live-four.* ]]; then\n'
    printf '    find "$runtime_directory" -mindepth 1 -depth -delete && rmdir "$runtime_directory" || { runtime_removed=false; cleanup_ok=false; }\n'
    printf '  else\n'
    printf '    printf '\''refusing to remove runtime directory: path validation failed\\n'\'' >&2\n'
    printf '    runtime_removed=false; cleanup_ok=false; identity_mismatch=true\n'
    printf '  fi\n'
    printf 'fi\n'
    printf 'cleanup_result=%q\n' "$cleanup_result"
    printf 'jq -n --argjson completed "$cleanup_ok" --argjson identityMismatch "$identity_mismatch" --argjson providerStopped "$provider_proxy_stopped" --arg providerState "$provider_proxy_state" --argjson runtimeRemoved "$runtime_removed" '\''{completed:$completed,identityFenced:true,identityMismatch:$identityMismatch,providerReachabilityRelayStopped:$providerStopped,providerReachabilityRelayState:$providerState,runtimeDirectoryRemoved:$runtimeRemoved,recoveryDataPreserved:(($completed or $runtimeRemoved) | not),completedAt:(now|todateiso8601)}'\'' >"$cleanup_result"\n'
    printf '[[ "$cleanup_ok" == true ]]\n'
  } >"$cleanup_script"
  chmod 700 "$cleanup_script"
  bash -n "$cleanup_script"
  cleanup_command=$(printf 'bash %q' "$cleanup_script")
  jq -n \
    --arg runId "$RUN_ID" --arg dashboard "$GATEWAY_URL" --arg trpc "$TRPC_URL" \
    --arg runtimeDir "$RUNTIME_DIR" --arg tokenFile "$RUNTIME_DIR/access-token" \
    --arg providerProxyPid "$PROVIDER_PROXY_PID" \
    --arg providerProxyUnit "$PROVIDER_PROXY_UNIT" \
    --arg cleanupScript "$cleanup_script" --arg cleanupResult "$cleanup_result" \
    --arg cleanupCommand "$cleanup_command" \
    --arg network "$NETWORK_NAME" --arg image "$IMAGE_TAG" \
    --arg networkId "$expected_network_id" --arg imageId "$expected_image_id" \
    --arg control "$CONTROL_CONTAINER" --arg gateway "$GATEWAY_CONTAINER" \
    --arg codex "$CODEX_CONTAINER" --arg copilot "$COPILOT_CONTAINER" \
    --arg controlId "$expected_control_id" --arg gatewayId "$expected_gateway_id" \
    --arg codexId "$expected_codex_id" --arg copilotId "$expected_copilot_id" '
      {
        retained:true,
        runId:$runId,
        dashboardUrl:$dashboard,
        gatewayTrpcUrl:$trpc,
        resources:{
          network:{name:$network,id:(if $networkId == "" then null else $networkId end)},
          image:{tag:$image,id:(if $imageId == "" then null else $imageId end)},
          containers:[
            {name:$control,id:(if $controlId == "" then null else $controlId end)},
            {name:$gateway,id:(if $gatewayId == "" then null else $gatewayId end)},
            {name:$codex,id:(if $codexId == "" then null else $codexId end)},
            {name:$copilot,id:(if $copilotId == "" then null else $copilotId end)}
          ]
        },
        hostOnly:{
          runtimeDirectory:$runtimeDir,
          bearerTokenFile:$tokenFile,
          providerReachabilityRelay:{
            pid:(if $providerProxyPid == "" then null else ($providerProxyPid | tonumber) end),
            unit:(if $providerProxyUnit == "" then null else $providerProxyUnit end),
            serviceManager:"systemd --user",
            containerized:false,
            bindScope:"isolated Docker bridge only"
          }
        },
        credentials:{valuesRecorded:false,providerEndpointRecorded:false,p2pTicketRecorded:false},
        cleanupScript:$cleanupScript,
        cleanupResult:$cleanupResult,
        cleanupCommand:$cleanupCommand,
        cleanupHint:"The generated script fences every Docker deletion by immutable ID, fences the relay service by unit plus ExecStart identity, validates the runtime path, and writes cleanupResult."
      }
    ' >"$RECEIPT_DIR/handoff.json"
}

docker_resource_state() {
  local kind=$1 name=$2 listing candidate
  case "$kind" in
    container)
      if docker container inspect "$name" >/dev/null 2>&1; then printf present; return; fi
      if ! listing=$(docker container ls --all --format '{{.Names}}' 2>/dev/null); then
        printf unknown
        return
      fi
      ;;
    network)
      if docker network inspect "$name" >/dev/null 2>&1; then printf present; return; fi
      if ! listing=$(docker network ls --format '{{.Name}}' 2>/dev/null); then
        printf unknown
        return
      fi
      ;;
    image)
      if docker image inspect "$name" >/dev/null 2>&1; then printf present; return; fi
      if ! listing=$(docker image ls --format '{{.Repository}}:{{.Tag}}' 2>/dev/null); then
        printf unknown
        return
      fi
      ;;
    *) printf unknown; return ;;
  esac
  while IFS= read -r candidate; do
    if [[ "$candidate" == "$name" ]]; then printf unknown; return; fi
  done <<<"$listing"
  printf absent
}

write_cleanup() {
  local containers_removed=true network_removed=true image_removed=true provider_proxy_stopped=true
  local provider_proxy_state="$PROVIDER_PROXY_STOP_STATE" provider_proxy_load_state provider_proxy_active_state
  local resource_state_certain=true runtime_preserved=false container resource_state
  CLEANUP_COMPLETED=0
  for container in "$CONTROL_CONTAINER" "$GATEWAY_CONTAINER" "$CODEX_CONTAINER" "$COPILOT_CONTAINER"; do
    resource_state=$(docker_resource_state container "$container")
    if [[ "$resource_state" != absent ]]; then containers_removed=false; fi
    if [[ "$resource_state" == unknown ]]; then resource_state_certain=false; fi
  done
  resource_state=$(docker_resource_state network "$NETWORK_NAME")
  if [[ "$resource_state" != absent ]]; then network_removed=false; fi
  if [[ "$resource_state" == unknown ]]; then resource_state_certain=false; fi
  resource_state=$(docker_resource_state image "$IMAGE_TAG")
  if [[ "$resource_state" != absent ]]; then image_removed=false; fi
  if [[ "$resource_state" == unknown ]]; then resource_state_certain=false; fi
  if [[ -n "$PROVIDER_PROXY_UNIT" ]]; then
    provider_proxy_stopped=false
    provider_proxy_state=manager-error
    if provider_proxy_load_state=$(systemctl_user_property "$PROVIDER_PROXY_UNIT" LoadState); then
      if [[ "$provider_proxy_load_state" == not-found ]]; then
        provider_proxy_stopped=true
        provider_proxy_state=not-found
      elif provider_proxy_active_state=$(systemctl_user_property "$PROVIDER_PROXY_UNIT" ActiveState); then
        if [[ "$provider_proxy_active_state" == inactive || "$provider_proxy_active_state" == failed ]]; then
          provider_proxy_stopped=true
          provider_proxy_state=stopped
        else
          provider_proxy_state=not-stopped
        fi
      fi
    fi
  fi
  if [[ "$containers_removed" == true && "$network_removed" == true && \
        "$image_removed" == true && "$provider_proxy_stopped" == true ]]; then
    CLEANUP_COMPLETED=1
  elif [[ -d "$RUNTIME_DIR" ]]; then
    runtime_preserved=true
  fi
  jq -n \
    --argjson containersRemoved "$containers_removed" \
    --argjson networkRemoved "$network_removed" \
    --argjson imageRemoved "$image_removed" \
    --argjson providerProxyStopped "$provider_proxy_stopped" \
    --arg providerProxyState "$provider_proxy_state" \
    --argjson runtimePreserved "$runtime_preserved" \
    --argjson resourceStateCertain "$resource_state_certain" \
    --arg network "$NETWORK_NAME" --arg image "$IMAGE_TAG" \
    --arg control "$CONTROL_CONTAINER" --arg gateway "$GATEWAY_CONTAINER" \
    --arg codex "$CODEX_CONTAINER" --arg copilot "$COPILOT_CONTAINER" '
      {
        cleanupCompleted:($containersRemoved and $networkRemoved and $imageRemoved and $providerProxyStopped),
        exactContainerTargetsRemoved:$containersRemoved,
        isolatedNetworkRemoved:$networkRemoved,
        imageRemoved:$imageRemoved,
        providerReachabilityRelayStopped:$providerProxyStopped,
        providerReachabilityRelayState:$providerProxyState,
        resourceStateObservationCertain:$resourceStateCertain,
        runtimeDirectoryPreservedForRecovery:$runtimePreserved,
        targets:{containers:[$control,$gateway,$codex,$copilot],network:$network,image:$image},
        recoverable:$runtimePreserved,
        materialUserDataRemoved:false
      }
    ' >"$RECEIPT_DIR/cleanup.json"
}

remove_resources() {
  local container
  for container in "$CODEX_CONTAINER" "$COPILOT_CONTAINER" "$GATEWAY_CONTAINER" "$CONTROL_CONTAINER"; do
    docker rm --force "$container" >/dev/null 2>&1 || true
  done
  CONTROL_STARTED=0
  GATEWAY_STARTED=0
  CODEX_STARTED=0
  COPILOT_STARTED=0
  stop_provider_proxy || true
  if (( NETWORK_CREATED == 1 )); then
    if docker network rm "$NETWORK_NAME" >/dev/null 2>&1; then NETWORK_CREATED=0; fi
  fi
  if (( IMAGE_BUILT == 1 )); then
    if docker image rm "$IMAGE_TAG" >/dev/null 2>&1; then IMAGE_BUILT=0; fi
  fi
}

systemctl_user_property() {
  local unit=$1 property=$2 value
  if ! value=$(systemctl --user show --property="$property" --value "$unit" 2>/dev/null); then
    return 1
  fi
  if [[ -z "$value" || "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then return 1; fi
  printf '%s' "$value"
}

stop_provider_proxy() {
  local load_state active_state provider_proxy_command
  if [[ -z "$PROVIDER_PROXY_UNIT" ]]; then return 0; fi
  if ! load_state=$(systemctl_user_property "$PROVIDER_PROXY_UNIT" LoadState); then
    PROVIDER_PROXY_STOP_STATE=manager-error
    note "unable to inspect provider relay load state; retaining its recovery identity"
    return 1
  fi
  if [[ "$load_state" == not-found ]]; then
    PROVIDER_PROXY_STOP_STATE=not-found
    PROVIDER_PROXY_UNIT=""
    PROVIDER_PROXY_PID=""
    return 0
  fi
  if ! provider_proxy_command=$(systemctl_user_property "$PROVIDER_PROXY_UNIT" ExecStart); then
    PROVIDER_PROXY_STOP_STATE=manager-error
    note "unable to inspect provider relay identity; retaining its recovery identity"
    return 1
  fi
  if [[ "$provider_proxy_command" != *"$SCRIPT_DIR/provider-proxy.mjs"* ||
        "$provider_proxy_command" != *"$RUNTIME_DIR/provider-proxy-ready.json"* ]]; then
    PROVIDER_PROXY_STOP_STATE=identity-mismatch
    note "refusing to stop provider relay because its service identity does not match"
    return 1
  fi
  if ! systemctl --user stop "$PROVIDER_PROXY_UNIT" >/dev/null 2>&1; then
    note "provider relay stop request failed; verifying its state"
  fi
  if ! load_state=$(systemctl_user_property "$PROVIDER_PROXY_UNIT" LoadState); then
    PROVIDER_PROXY_STOP_STATE=manager-error
    note "unable to verify provider relay after stop; retaining its recovery identity"
    return 1
  fi
  if [[ "$load_state" != not-found ]]; then
    if ! active_state=$(systemctl_user_property "$PROVIDER_PROXY_UNIT" ActiveState); then
      PROVIDER_PROXY_STOP_STATE=manager-error
      note "unable to verify provider relay active state; retaining its recovery identity"
      return 1
    fi
    if [[ "$active_state" != inactive && "$active_state" != failed ]]; then
      PROVIDER_PROXY_STOP_STATE=not-stopped
      note "provider relay remains in a non-stopped state; retaining its recovery identity"
      return 1
    fi
    systemctl --user reset-failed "$PROVIDER_PROXY_UNIT" >/dev/null 2>&1 || true
    PROVIDER_PROXY_STOP_STATE=stopped
  else
    PROVIDER_PROXY_STOP_STATE=not-found
  fi
  PROVIDER_PROXY_UNIT=""
  PROVIDER_PROXY_PID=""
}

stop_background_jobs() {
  if [[ -n "$WATCH_PID" ]] && kill -0 "$WATCH_PID" 2>/dev/null; then
    kill "$WATCH_PID" 2>/dev/null || true
    wait "$WATCH_PID" 2>/dev/null || true
  fi
  WATCH_PID=""
  if [[ -n "$STATS_PID" ]] && kill -0 "$STATS_PID" 2>/dev/null; then
    kill "$STATS_PID" 2>/dev/null || true
    wait "$STATS_PID" 2>/dev/null || true
  fi
  STATS_PID=""
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  stop_background_jobs
  capture_logs
  # The raw PTY canary must never survive into a retained failed receipt or
  # handoff. Its digest is written only after the positive ephemerality scan.
  rm -f -- "$TERMINAL_MARKER_FILE"
  if (( COMPLETED == 0 )); then scrub_failed_receipt; fi
  if [[ "$KEEP" == 1 ]]; then
    [[ -s "$RECEIPT_DIR/handoff.json" && -s "$RECEIPT_DIR/cleanup-retained.sh" ]] || write_handoff
  else
    remove_resources
    write_cleanup
    if (( CLEANUP_COMPLETED == 1 )); then
      if [[ -d "$RUNTIME_DIR" && ! -L "$RUNTIME_DIR" && \
            "$(basename -- "$RUNTIME_DIR")" == agent-multiplex-live-four.* ]]; then
        find "$RUNTIME_DIR" -mindepth 1 -depth -delete && rmdir "$RUNTIME_DIR"
      fi
    else
      note "cleanup was incomplete; preserving runtime directory for recovery: $RUNTIME_DIR"
    fi
  fi
  if (( COMPLETED == 0 )); then
    printf 'The live four-container run failed. Inspect browser-failure.json, verification-failure.json, and logs/.\n' \
      >"$RECEIPT_DIR/FAILED.txt"
    if secret_values_present_in_receipt; then
      printf 'WARNING: the failed receipt still contains a sensitive value and should not be shared.\n' \
        >>"$RECEIPT_DIR/FAILED.txt"
    fi
  fi
  if (( status == 0 && COMPLETED == 1 )); then
    note "PASS: receipts saved to $RECEIPT_DIR"
    [[ "$KEEP" == 1 ]] && note "retained dashboard: $GATEWAY_URL (token is in $RUNTIME_DIR/access-token)"
  else
    note "partial receipts saved to $RECEIPT_DIR"
    [[ "$KEEP" == 1 ]] && note "retained topology details: $RECEIPT_DIR/handoff.json"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

wait_for_log() {
  local container=$1 pattern=$2 description=$3 attempt logs
  for attempt in $(seq 1 180); do
    if [[ $(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null) != true ]]; then
      docker logs "$container" 2>&1 | redact_stream >&2 || true
      fail "$description container exited"
      return
    fi
    logs=$(docker logs "$container" 2>&1 || true)
    if rg --quiet "$pattern" <<<"$logs"; then return; fi
    if (( attempt % 30 == 0 )); then note "waiting for $description (${attempt}s)"; fi
    sleep 1
  done
  fail "timed out waiting for $description"
}

wait_for_file() {
  local filename=$1 description=$2 attempt
  for attempt in $(seq 1 $(( TIMEOUT_MS / 100 + 1 ))); do
    [[ -s "$filename" ]] && return
    if [[ -n "$WATCH_PID" ]] && ! kill -0 "$WATCH_PID" 2>/dev/null; then
      wait "$WATCH_PID" || true
      WATCH_PID=""
      fail "watcher exited while waiting for $description"
      return
    fi
    sleep 0.1
  done
  fail "timed out waiting for $description"
}

sample_resources() {
  while [[ ! -e "$RECEIPT_DIR/coord/stop-stats" ]]; do
    local sampled_at raw
    sampled_at=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
    raw=$(timeout 25s docker stats --no-stream --format '{{json .}}' "${CONTAINERS[@]}" 2>/dev/null || true)
    if [[ -n "$raw" ]]; then
      jq -c --arg sampledAt "$sampled_at" '. + {sampledAt:$sampledAt}' <<<"$raw" \
        >>"$RECEIPT_DIR/logs/docker-stats.ndjson" || true
    fi
    sleep 2
  done
}

assert_json() {
  local description=$1 filter=$2 filename=$3
  shift 3
  if ! jq -e "$@" "$filter" "$filename" >/dev/null; then
    fail "$description (see ${filename#"$RECEIPT_DIR/"})"
  fi
}

note "extracting the narrow codex-lb provider configuration"
if ! API_KEY_LITERAL=$(node -e '
  const fs = require("node:fs");
  const raw = fs.readFileSync(process.argv[1], "utf8");
  if (!/^[^\r\n]+(?:\r?\n)?$/.test(raw)) process.exit(1);
  process.stdout.write(raw.replace(/\r?\n$/, ""));
' "$SOURCE_KEY"); then
  fail "codex-lb API key must contain exactly one non-empty line"
fi
if (( ${#API_KEY_LITERAL} < 16 )); then fail "codex-lb API key is unexpectedly short"; fi
PROVIDER_URL=$(awk '
  /^\[model_providers\.codex-lb\]$/ { in_provider = 1; next }
  in_provider && /^\[/ { exit }
  in_provider && /^[[:space:]]*base_url[[:space:]]*=/ {
    sub(/^[^=]*=[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit
  }
' "$SOURCE_CONFIG")
if [[ -z "$PROVIDER_URL" ]]; then fail "codex-lb base_url was not found"; fi
if ! node -e '
  const url = new URL(process.argv[1]);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) process.exit(1);
' "$PROVIDER_URL"; then
  fail "codex-lb base_url is not a credential-free HTTP(S) URL"
fi
PROVIDER_ORIGIN=$(node -e 'process.stdout.write(new URL(process.argv[1]).origin)' "$PROVIDER_URL")

MINIMAL_CONFIG_RAW="$RUNTIME_DIR/config.raw.toml"
MINIMAL_CONFIG="$RUNTIME_DIR/config.toml"
awk '
  /^[[:space:]]*model_provider[[:space:]]*=/ {
    if ($0 ~ /"codex-lb"/) print
    next
  }
  /^[[:space:]]*model[[:space:]]*=/ { print; next }
  /^\[model_providers\.codex-lb\]$/ { in_provider = 1; print; next }
  in_provider && /^\[/ {
    if ($0 == "[model_providers.codex-lb.auth]") { print; next }
    in_provider = 0
  }
  in_provider { print }
' "$SOURCE_CONFIG" >"$MINIMAL_CONFIG_RAW"

note "building one immutable image for all four application containers"
if ! docker build --progress=plain \
  --secret "id=npmrc,src=$DOCKER_NPMRC" \
  --file "$SCRIPT_DIR/Dockerfile" --tag "$IMAGE_TAG" "$REPO_ROOT" \
  >"$RECEIPT_DIR/logs/docker-build.log" 2>&1; then
  tail -n 100 "$RECEIPT_DIR/logs/docker-build.log" >&2 || true
  fail "Docker image build failed"
fi
IMAGE_BUILT=1
IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")
docker network create --driver bridge "$NETWORK_NAME" >/dev/null
NETWORK_CREATED=1

# The codex-lb service is on the host's private overlay network. Docker bridge
# traffic is not necessarily SNATed into that overlay, so bind a credential-
# blind HTTP relay only to this run's isolated bridge. This is host-side test
# plumbing (like Playwright), not a fifth application container or public
# ingress. Both real runtimes still authenticate directly with their narrow
# key mounts.
PROVIDER_BRIDGE_HOST=$(docker network inspect --format '{{(index .IPAM.Config 0).Gateway}}' "$NETWORK_NAME")
if [[ -z "$PROVIDER_BRIDGE_HOST" ]]; then fail "isolated network has no bridge gateway"; fi
PROVIDER_PROXY_READY="$RUNTIME_DIR/provider-proxy-ready.json"
PROVIDER_PROXY_UNIT="agent-multiplex-provider-$NAME_SUFFIX.service"
PROVIDER_PROXY_STOP_STATE=not-stopped
systemd-run --user --quiet --collect \
  --unit "$PROVIDER_PROXY_UNIT" \
  --property Type=simple \
  --property KillMode=control-group \
  --property NoNewPrivileges=yes \
  --property UMask=0077 \
  --property "StandardOutput=append:$RUNTIME_DIR/provider-proxy.log" \
  --property "StandardError=append:$RUNTIME_DIR/provider-proxy.log" \
  --setenv "AGENT_MULTIPLEX_PROVIDER_PROXY_UPSTREAM=$PROVIDER_URL" \
  "$(command -v node)" "$SCRIPT_DIR/provider-proxy.mjs" \
  "$PROVIDER_BRIDGE_HOST" "$PROVIDER_PROXY_READY"
for attempt in $(seq 1 100); do
  if [[ -s "$PROVIDER_PROXY_READY" ]]; then break; fi
  if ! systemctl --user is-active --quiet "$PROVIDER_PROXY_UNIT"; then
    sed -n '1,80p' "$RUNTIME_DIR/provider-proxy.log" >&2 || true
    fail "provider reachability relay exited during startup"
  fi
  if (( attempt == 100 )); then fail "provider reachability relay did not become ready"; fi
  sleep 0.1
done
PROVIDER_PROXY_PID=$(systemctl --user show --property=MainPID --value "$PROVIDER_PROXY_UNIT")
if [[ ! "$PROVIDER_PROXY_PID" =~ ^[1-9][0-9]*$ ]]; then
  fail "provider reachability relay has no live service PID"
fi
PROVIDER_PROXY_PORT=$(jq -er '.port | select(type == "number" and . >= 1 and . <= 65535)' \
  "$PROVIDER_PROXY_READY")
PROVIDER_PATH=$(node -e 'process.stdout.write(new URL(process.argv[1]).pathname)' "$PROVIDER_URL")
PROXIED_PROVIDER_URL="http://$PROVIDER_BRIDGE_HOST:$PROVIDER_PROXY_PORT$PROVIDER_PATH"
PROXIED_PROVIDER_ORIGIN="http://$PROVIDER_BRIDGE_HOST:$PROVIDER_PROXY_PORT"

{
  # These are root Codex settings, so they must precede the first TOML table.
  # The web spawn form deliberately stays harness-neutral; this isolated
  # acceptance home supplies the safe command defaults used by the interrupt
  # proof.
  printf 'approval_policy = "never"\nsandbox_mode = "read-only"\n'
  sed -E \
    's#^([[:space:]]*args[[:space:]]*=[[:space:]]*)\["[^"]*codex-lb-api-key"\]#\1["/home/arduano/.codex/codex-lb-api-key"]#' \
    "$MINIMAL_CONFIG_RAW" | \
    AGENT_MULTIPLEX_PROXY_CONFIG_URL="$PROXIED_PROVIDER_URL" perl -pe '
      if (/^([[:space:]]*base_url[[:space:]]*=[[:space:]]*).*$/) {
        $_ = $1 . "\"" . $ENV{AGENT_MULTIPLEX_PROXY_CONFIG_URL} . "\"\n";
      }
    '
} >"$MINIMAL_CONFIG"
printf '\n[projects."/workspace/project"]\ntrust_level = "trusted"\n' >>"$MINIMAL_CONFIG"
chmod 600 "$MINIMAL_CONFIG"
if ! rg --quiet '^model_provider = "codex-lb"$' "$MINIMAL_CONFIG" || \
   ! rg --quiet '^\[model_providers\.codex-lb\.auth\]$' "$MINIMAL_CONFIG" || \
   ! rg --quiet '/home/arduano/.codex/codex-lb-api-key' "$MINIMAL_CONFIG" || \
   ! rg --fixed-strings --quiet "base_url = \"$PROXIED_PROVIDER_URL\"" "$MINIMAL_CONFIG"; then
  fail "generated minimal Codex config did not pass validation"
fi

# Prepare a deliberately narrow Codex home before the container exists. A
# writable bind is needed because codex app-server owns its own native session
# state; it contains only the provider config/key copied below, never the
# caller's full Codex home or auth.json.
cp -- "$MINIMAL_CONFIG" "$RUNTIME_DIR/codex-home/config.toml"
cp -- "$SOURCE_KEY" "$RUNTIME_DIR/codex-home/codex-lb-api-key"
chown 1000:100 "$RUNTIME_DIR/codex-home" \
  "$RUNTIME_DIR/codex-home/config.toml" "$RUNTIME_DIR/codex-home/codex-lb-api-key"
chmod 700 "$RUNTIME_DIR/codex-home"
chmod 600 "$RUNTIME_DIR/codex-home/config.toml" "$RUNTIME_DIR/codex-home/codex-lb-api-key"
CODEX_AUTH_PREPARED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)

note "starting the canonical metadata authority"
docker run --detach \
  --name "$CONTROL_CONTAINER" --hostname live-control --network "$NETWORK_NAME" \
  --init --user 1000:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --mount type=bind,src="$RUNTIME_DIR/authority-state",dst=/state \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_NAME=live-canonical-authority \
  --env AGENT_MULTIPLEX_CONTROL_NODE_STATE=/state/control-node.sqlite \
  --env AGENT_MULTIPLEX_CONTROL_NODE_IDENTITY=/state/control-node.identity \
  --env AGENT_MULTIPLEX_CONTROL_NODE_HTTP_BIND=127.0.0.1 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_HTTP_PORT=4317 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_P2P_BIND=0.0.0.0:49117 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_RUNTIME_STALE_MS=120000 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_RUNTIME_NODE_ENROLLMENT=1 \
  --env AGENT_MULTIPLEX_CONTROL_NODE_ALLOW_ACCESS_GATEWAY_ENROLLMENT=1 \
  --env 'AGENT_MULTIPLEX_CONTROL_NODE_ACCESS_GATEWAY_SCOPES=["read","agent-launch","agent-control","terminal-view","terminal-control","metadata-propose"]' \
  --env AGENT_MULTIPLEX_CONTROL_NODE_RECONNECT_MAX_MS=1000 \
  "$IMAGE_TAG" node apps/control-node/dist/main.js >/dev/null
CONTROL_STARTED=1
CONTAINERS+=("$CONTROL_CONTAINER")
wait_for_log "$CONTROL_CONTAINER" '^P2P ticket \(' 'control-node startup'
CONTROL_LOGS=$(docker logs "$CONTROL_CONTAINER" 2>&1)
CONTROL_NODE_ID=$(sed -n 's/^Control node ID:[[:space:]]*//p' <<<"$CONTROL_LOGS" | tail -n 1)
CONTROL_ENDPOINT_ID=$(sed -n 's/^P2P endpoint:[[:space:]]*//p' <<<"$CONTROL_LOGS" | tail -n 1)
CONTROL_TICKET=$(awk '/^P2P ticket \(/ { getline; print; exit }' <<<"$CONTROL_LOGS")
if [[ -z "$CONTROL_NODE_ID" || ! "$CONTROL_ENDPOINT_ID" =~ ^[a-z2-7]{52}$ ]]; then
  fail "control node emitted invalid identities"
fi
if (( ${#CONTROL_TICKET} < 20 || ${#CONTROL_TICKET} > 8192 )) || \
   [[ "$CONTROL_TICKET" =~ [[:space:]] ]]; then
  fail "control node emitted an invalid P2P ticket"
fi
CONTROL_TICKET_SHA256=$(printf '%s' "$CONTROL_TICKET" | sha256sum | awk '{print $1}')

note "starting the isolated Codex runtime with a narrow writable CODEX_HOME bind"
CODEX_CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
docker run --detach \
  --name "$CODEX_CONTAINER" --hostname live-codex --network "$NETWORK_NAME" \
  --init --user 1000:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --security-opt seccomp=unconfined \
  --tmpfs /state:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --mount type=bind,src="$RUNTIME_DIR/codex-home",dst=/home/arduano/.codex \
  --mount type=bind,src="$RUNTIME_DIR/codex-workspace",dst=/workspace/project \
  --env HOME=/home/arduano --env CODEX_HOME=/home/arduano/.codex \
  --env XDG_CACHE_HOME=/tmp/cache \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID="$CONTROL_ENDPOINT_ID" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_TICKET="$CONTROL_TICKET" \
  --env 'AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS=["/workspace/project"]' \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_STATE_DIR=/state/runtime-node \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_NAME="$CODEX_RUNTIME_NAME" \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES=codex \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_HEARTBEAT_MS=1000 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_INVENTORY_REFRESH_MS=3000 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_METADATA_FLUSH_MS=500 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_RECONNECT_MAX_MS=1000 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_CODEX_BINARY=/opt/src/agent-multiplex/node_modules/.bin/codex \
  "$IMAGE_TAG" /usr/local/bin/agent-multiplex-live-codex-runtime >/dev/null
CODEX_STARTED=1
CONTAINERS+=("$CODEX_CONTAINER")
wait_for_log "$CODEX_CONTAINER" '^Connected to control node ' 'Codex runtime attachment'

docker exec "$CODEX_CONTAINER" node -e '
  const fs = require("node:fs");
  const names = ["config.toml", "codex-lb-api-key"];
  const files = Object.fromEntries(names.map((name) => {
    const stat = fs.statSync(`/home/arduano/.codex/${name}`);
    return [name, {present:stat.isFile(),mode:(stat.mode & 0o777).toString(8).padStart(3,"0"),uid:stat.uid,gid:stat.gid}];
  }));
  process.stdout.write(JSON.stringify({files}, null, 2));
' >"$RUNTIME_DIR/codex-auth-stat.json"
jq -n --arg preparedAt "$CODEX_AUTH_PREPARED_AT" --arg createdAt "$CODEX_CREATED_AT" \
  --slurpfile stat "$RUNTIME_DIR/codex-auth-stat.json" '
    {
      source:"host codex-lb provider config/key only",
      method:"host-side narrow copy into an isolated writable CODEX_HOME bind before container creation",
      preparedAt:$preparedAt,
      containerCreatedAt:$createdAt,
      authJsonCopied:false,
      fullHostCodexHomeMounted:false,
      files:$stat[0].files,
      secretValuesRecorded:false
    }
  ' >"$RECEIPT_DIR/codex-auth-proof.json"
assert_json "Codex auth copy is not narrow or private" '
  .authJsonCopied == false and .fullHostCodexHomeMounted == false and
  all(.files[]; .present == true and .mode == "600" and .uid == 1000 and .gid == 100)
' "$RECEIPT_DIR/codex-auth-proof.json"

note "starting the isolated Copilot runtime with codex-lb BYOK"
COPILOT_MODELS=$(jq -cn --arg model "$COPILOT_MODEL" '[ $model ]')
docker run --detach \
  --name "$COPILOT_CONTAINER" --hostname live-copilot --network "$NETWORK_NAME" \
  --init --user 1000:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --security-opt seccomp=unconfined \
  --tmpfs /state:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
  --tmpfs /tmp:rw,exec,nosuid,nodev,mode=1777 \
  --tmpfs /home/arduano/.copilot:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
  --mount type=bind,src="$RUNTIME_DIR/copilot-workspace",dst=/workspace/project \
  --mount type=bind,src="$SOURCE_KEY",dst=/run/secrets/codex-lb-api-key,readonly \
  --env HOME=/home/arduano --env XDG_CACHE_HOME=/tmp/cache \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID="$CONTROL_ENDPOINT_ID" \
  --env AGENT_MULTIPLEX_CONTROL_NODE_TICKET="$CONTROL_TICKET" \
  --env 'AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS=["/workspace/project"]' \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_STATE_DIR=/state/runtime-node \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_NAME="$COPILOT_RUNTIME_NAME" \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES=copilot \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_HEARTBEAT_MS=1000 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_INVENTORY_REFRESH_MS=3000 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_METADATA_FLUSH_MS=500 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_RECONNECT_MAX_MS=1000 \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_HOME=/home/arduano/.copilot \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_LOG_LEVEL=none \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TYPE=openai \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BASE_URL="$PROXIED_PROVIDER_URL" \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_WIRE_API=responses \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TRANSPORT=http \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODEL="$COPILOT_MODEL" \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODELS="$COPILOT_MODELS" \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_API_KEY_FILE=/run/secrets/codex-lb-api-key \
  --env AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_EXPERIMENTAL_UI_SERVER=0 \
  "$IMAGE_TAG" node apps/runtime-node/dist/main.js >/dev/null
COPILOT_STARTED=1
CONTAINERS+=("$COPILOT_CONTAINER")
wait_for_log "$COPILOT_CONTAINER" '^Connected to control node ' 'Copilot runtime attachment'

docker inspect "$COPILOT_CONTAINER" | jq '
  .[0] as $container |
  ($container.Mounts | map(select(.Destination == "/run/secrets/codex-lb-api-key"))[0]) as $mount |
  {
    sourceKind:"host codex-lb API-key file",
    destination:$mount.Destination,
    mountType:$mount.Type,
    readOnly:($mount.RW | not),
    isolatedCopilotHome:true,
    apiKeyCopiedIntoImage:false,
    fullCodexHomeMounted:false,
    secretValuesRecorded:false
  }
' >"$RECEIPT_DIR/copilot-auth-proof.json"
assert_json "Copilot BYOK mount is not narrow and read-only" '
  .destination == "/run/secrets/codex-lb-api-key" and .mountType == "bind" and
  .readOnly == true and .isolatedCopilotHome == true and
  .apiKeyCopiedIntoImage == false and .fullCodexHomeMounted == false
' "$RECEIPT_DIR/copilot-auth-proof.json"

jq -n --arg protocol "$(jq -r '.upstreamProtocol' "$PROVIDER_PROXY_READY")" '
  {
    purpose:"make a host-private provider reachable from the isolated Docker bridge",
    placement:"persistent host-side systemd user service used as acceptance plumbing",
    containerized:false,
    serviceManager:"systemd --user",
    survivesAcceptanceRunnerExit:true,
    bindScope:"isolated per-run Docker bridge only",
    publiclyPublished:false,
    upstreamProtocol:$protocol,
    readsCredentialFiles:false,
    storesOrLogsHeaders:false,
    endpointRecorded:false
  }
' >"$RECEIPT_DIR/provider-relay-proof.json"

GATEWAY_SOURCES=$(jq -cn --arg endpoint "$CONTROL_ENDPOINT_ID" --arg ticket "$CONTROL_TICKET" '
  {
    version:1,
    sources:[{
      sourceId:"canonical",
      displayName:"Live canonical authority",
      endpointId:$endpoint,
      locator:{kind:"ticket",ticket:$ticket},
      priority:100,
      enabled:true,
      requestedScopes:["read","agent-launch","agent-control","terminal-view","terminal-control","metadata-propose"]
    }]
  }
')
note "starting the bearer-authenticated zero-authority gateway (the only published port)"
docker run --detach \
  --name "$GATEWAY_CONTAINER" --hostname live-gateway --network "$NETWORK_NAME" \
  --init --user 1000:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --mount type=bind,src="$RUNTIME_DIR/gateway-state",dst=/state \
  --mount type=bind,src="$RUNTIME_DIR/access-token",dst=/run/access-token,readonly \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --publish 127.0.0.1::4318 \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_STATE=/state/access-gateway.sqlite \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_IDENTITY=/state/access-gateway.identity \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_SOURCES="$GATEWAY_SOURCES" \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_HTTP_BIND=0.0.0.0 \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_HTTP_PORT=4318 \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_BEARER_TOKEN_FILE=/run/access-token \
  --env 'AGENT_MULTIPLEX_ACCESS_GATEWAY_SCOPES=["read","agent-launch","agent-control","terminal-view","terminal-control","metadata-propose"]' \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_AUTH_SUBJECT=live-browser \
  --env AGENT_MULTIPLEX_ACCESS_GATEWAY_RECONNECT_MAX_MS=1000 \
  "$IMAGE_TAG" node apps/gateway/dist/main.js >/dev/null
GATEWAY_STARTED=1
CONTAINERS+=("$GATEWAY_CONTAINER")
wait_for_log "$GATEWAY_CONTAINER" '^Dashboard:' 'gateway startup'
PORT_MAPPING=$(docker port "$GATEWAY_CONTAINER" 4318/tcp | tail -n 1)
GATEWAY_PORT=${PORT_MAPPING##*:}
if [[ ! "$GATEWAY_PORT" =~ ^[0-9]+$ ]]; then fail "could not resolve gateway port"; fi
GATEWAY_URL="http://127.0.0.1:$GATEWAY_PORT/"
TRPC_URL="http://127.0.0.1:$GATEWAY_PORT/trpc"
for attempt in $(seq 1 60); do
  if curl --fail --silent "$GATEWAY_URL" >/dev/null; then break; fi
  if (( attempt == 60 )); then fail "gateway UI did not become reachable"; fi
  sleep 1
done
UNAUTHENTICATED_STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  "$TRPC_URL/system.describe")
AUTHENTICATED_STATUS=$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --header "Authorization: Bearer $ACCESS_TOKEN" "$TRPC_URL/system.describe")
jq -n --argjson unauthenticated "$UNAUTHENTICATED_STATUS" --argjson authenticated "$AUTHENTICATED_STATUS" '
  {
    unauthenticatedStatus:$unauthenticated,
    authenticatedStatus:$authenticated,
    unauthenticatedRejected:($unauthenticated == 401),
    authenticatedAccepted:($authenticated >= 200 and $authenticated < 300),
    bearerTokenRecorded:false
  }
' >"$RECEIPT_DIR/rpc/auth-boundary.json"
assert_json "gateway bearer boundary is incorrect" \
  '.unauthenticatedRejected == true and .authenticatedAccepted == true' \
  "$RECEIPT_DIR/rpc/auth-boundary.json"

if [[ $(docker network inspect --format '{{len .Containers}}' "$NETWORK_NAME") != 4 ]]; then
  fail "the isolated network does not contain exactly four application containers"
fi
for hidden in "$CONTROL_CONTAINER" "$CODEX_CONTAINER" "$COPILOT_CONTAINER"; do
  if [[ -n $(docker port "$hidden" 2>/dev/null) ]]; then
    fail "$hidden unexpectedly publishes a host port"
  fi
done

: >"$RECEIPT_DIR/logs/docker-stats.ndjson"
sample_resources &
STATS_PID=$!

note "starting an independent, gateway-only fleet stream watcher"
SOAK_SECONDS=$(( (SOAK_MS + 999) / 1000 ))
WATCH_TIMEOUT_SECONDS=$(( TIMEOUT_MS * 6 / 1000 + SOAK_SECONDS + 300 ))
AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE="$RUNTIME_DIR/access-token" \
timeout "${WATCH_TIMEOUT_SECONDS}s" node "$SCRIPT_DIR/watch.mjs" \
  "$TRPC_URL" "$RECEIPT_DIR" "$(( TIMEOUT_MS * 5 ))" \
  >"$RECEIPT_DIR/logs/watcher.log" 2>&1 &
WATCH_PID=$!
wait_for_file "$RECEIPT_DIR/coord/watcher-ready.json" 'gateway fleet watcher readiness'

note "driving Codex and Copilot entirely through the gateway web UI"
DRIVER_TIMEOUT_SECONDS=$(( TIMEOUT_MS * 5 / 1000 + SOAK_SECONDS + 300 ))
set +e
AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE="$RUNTIME_DIR/access-token" \
AGENT_MULTIPLEX_ACCEPTANCE_TERMINAL_MARKER_FILE="$TERMINAL_MARKER_FILE" \
timeout "${DRIVER_TIMEOUT_SECONDS}s" node "$SCRIPT_DIR/driver.mjs" \
  "$GATEWAY_URL" "$RECEIPT_DIR" "$RUN_ID" \
  "$CODEX_RUNTIME_NAME" "$COPILOT_RUNTIME_NAME" \
  "$INITIAL_CODEX_MODEL" "$SECOND_CODEX_MODEL" "$COPILOT_MODEL" "$TIMEOUT_MS" "$SOAK_MS" \
  >"$RECEIPT_DIR/logs/browser-driver.log" 2>&1
DRIVER_STATUS=$?
set -e
jq -n --arg stoppedAt "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" \
  '{stoppedAt:$stoppedAt,reason:"browser phase complete"}' \
  >"$RECEIPT_DIR/coord/watcher-stop.json"
if [[ -n "$WATCH_PID" ]]; then
  set +e
  wait "$WATCH_PID"
  WATCH_STATUS=$?
  set -e
  WATCH_PID=""
else
  WATCH_STATUS=1
fi
if (( DRIVER_STATUS != 0 )); then
  tail -n 120 "$RECEIPT_DIR/logs/browser-driver.log" >&2 || true
  fail "Playwright UI driver failed"
fi
if (( WATCH_STATUS != 0 )); then
  tail -n 120 "$RECEIPT_DIR/logs/watcher.log" >&2 || true
  fail "gateway fleet watcher failed"
fi

note "verifying authority, routing, native streams, controls, interactions, and history"
AGENT_MULTIPLEX_ACCEPTANCE_BEARER_TOKEN_FILE="$RUNTIME_DIR/access-token" \
AGENT_MULTIPLEX_ACCEPTANCE_TERMINAL_MARKER_FILE="$TERMINAL_MARKER_FILE" \
timeout "$(( TIMEOUT_MS / 1000 + 180 ))s" node "$SCRIPT_DIR/verify.mjs" \
  "$TRPC_URL" "$RECEIPT_DIR" "$TIMEOUT_MS" \
  >"$RECEIPT_DIR/summary.json" 2>"$RECEIPT_DIR/logs/verifier.log"
assert_json "final gateway/API verification failed" '.passed == true' "$RECEIPT_DIR/checks.json"

touch "$RECEIPT_DIR/coord/stop-stats"
if [[ -n "$STATS_PID" ]]; then wait "$STATS_PID" || true; fi
STATS_PID=""
rm -f "$RECEIPT_DIR/coord/stop-stats"

note "capturing native runtime process and container lifecycle evidence"
docker exec "$CODEX_CONTAINER" node -e '
  const fs = require("node:fs"), path = require("node:path");
  const processes = [];
  const managedTuiProcesses = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const args = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
      const encoded = args.join(" ");
      if (encoded.includes("app-server") && encoded.toLowerCase().includes("codex")) {
        processes.push({pid:Number(entry),executable:path.basename(args[0] ?? "unknown"),role:"codex app-server"});
      } else if (
        encoded.toLowerCase().includes("codex") &&
        args.includes("resume") && args.includes("--remote")
      ) {
        managedTuiProcesses.push({pid:Number(entry),executable:path.basename(args[0] ?? "unknown"),role:"managed Codex TUI"});
      }
    } catch {}
  }
  process.stdout.write(JSON.stringify({
    processes:processes.sort((a,b)=>a.pid-b.pid),
    managedTuiProcesses:managedTuiProcesses.sort((a,b)=>a.pid-b.pid),
  }, null, 2));
' >"$RECEIPT_DIR/codex-process-proof.json"
docker exec "$COPILOT_CONTAINER" node -e '
  const fs = require("node:fs"), path = require("node:path");
  const processes = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const args = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
      const encoded = args.join(" ").toLowerCase();
      if (encoded.includes("copilot") && !encoded.includes("apps/runtime-node/dist/main.js")) {
        processes.push({pid:Number(entry),executable:path.basename(args[0] ?? "unknown"),role:"Copilot runtime"});
      }
    } catch {}
  }
  process.stdout.write(JSON.stringify({processes:processes.sort((a,b)=>a.pid-b.pid)}, null, 2));
' >"$RECEIPT_DIR/copilot-process-proof.json"
assert_json "live Codex app-server process was not observed" '.processes | length >= 1' \
  "$RECEIPT_DIR/codex-process-proof.json"
assert_json "managed Codex TUI process survived confirmed termination" \
  '.managedTuiProcesses | length == 0' "$RECEIPT_DIR/codex-process-proof.json"
assert_json "live Copilot runtime process was not observed" '.processes | length >= 1' \
  "$RECEIPT_DIR/copilot-process-proof.json"

docker inspect --format \
  '{"name":"{{.Name}}","id":"{{.Id}}","image":"{{.Image}}","running":{{.State.Running}},"oomKilled":{{.State.OOMKilled}},"exitCode":{{.State.ExitCode}},"restartCount":{{.RestartCount}},"startedAt":"{{.State.StartedAt}}"}' \
  "${CONTAINERS[@]}" | jq -s 'map(.name |= ltrimstr("/"))' \
  >"$RECEIPT_DIR/container-lifecycle.json"
assert_json "a live container failed its lifecycle check" '
  length == 4 and (map(.id) | unique | length) == 4 and
  all(.[]; .image == $image and .running == true and .oomKilled == false and .restartCount == 0)
' "$RECEIPT_DIR/container-lifecycle.json" --arg image "$IMAGE_ID"

jq -s '
  def percent: sub("%$"; "") | tonumber;
  {
    sampleRows:length,
    sampleTimes:(map(.sampledAt) | unique | length),
    containers:(sort_by(.Name) | group_by(.Name) | map({
      name:.[0].Name,
      sampleCount:length,
      maxCpuPercent:(map(.CPUPerc | percent) | max),
      maxMemoryPercent:(map(.MemPerc | percent) | max),
      maxPids:(map(.PIDs | tonumber) | max),
      final:{cpu:.[-1].CPUPerc,memory:.[-1].MemUsage,networkIo:.[-1].NetIO,blockIo:.[-1].BlockIO,pids:.[-1].PIDs}
    }))
  }
' "$RECEIPT_DIR/logs/docker-stats.ndjson" >"$RECEIPT_DIR/resource-summary.json"
assert_json "resource sampling did not cover all four containers" '
  .sampleTimes >= 1 and (.containers | length) == 4 and all(.containers[]; .sampleCount >= 1 and .maxPids >= 1)
' "$RECEIPT_DIR/resource-summary.json"

CONTROL_CONTAINER_ID=$(docker inspect --format '{{.Id}}' "$CONTROL_CONTAINER")
GATEWAY_CONTAINER_ID=$(docker inspect --format '{{.Id}}' "$GATEWAY_CONTAINER")
CODEX_CONTAINER_ID=$(docker inspect --format '{{.Id}}' "$CODEX_CONTAINER")
COPILOT_CONTAINER_ID=$(docker inspect --format '{{.Id}}' "$COPILOT_CONTAINER")
jq -n \
  --arg network "$NETWORK_NAME" --arg image "$IMAGE_ID" --arg dashboard "$GATEWAY_URL" \
  --arg controlName "$CONTROL_CONTAINER" --arg controlId "$CONTROL_CONTAINER_ID" \
  --arg gatewayName "$GATEWAY_CONTAINER" --arg gatewayId "$GATEWAY_CONTAINER_ID" \
  --arg codexName "$CODEX_CONTAINER" --arg codexId "$CODEX_CONTAINER_ID" \
  --arg copilotName "$COPILOT_CONTAINER" --arg copilotId "$COPILOT_CONTAINER_ID" \
  --arg controlNodeId "$CONTROL_NODE_ID" --arg endpoint "$CONTROL_ENDPOINT_ID" \
  --arg ticketDigest "$CONTROL_TICKET_SHA256" '
    {
      applicationContainerCount:4,
      sharedImageId:$image,
      network:{name:$network,driver:"bridge",containerCount:4},
      containers:[
        {name:$controlName,id:$controlId,role:"canonical durable metadata authority",publishedPorts:[]},
        {name:$gatewayName,id:$gatewayId,role:"zero-authority authenticated gateway + web UI",publishedDashboard:$dashboard},
        {name:$codexName,id:$codexId,role:"Codex-only runtime node + real codex app-server",publishedPorts:[]},
        {name:$copilotName,id:$copilotId,role:"Copilot-only runtime node + real Copilot BYOK runtime",publishedPorts:[]}
      ],
      authority:{controlNodeId:$controlNodeId,sqliteBacked:true},
      transport:{protocol:"p2prpc v1 over Iroh",controlEndpointId:$endpoint,ticketRecorded:false,ticketSha256:$ticketDigest},
      ingress:{onlyPublishedApplicationPort:"gateway HTTP/WebSocket",browserAndVerifierUseGatewayOnly:true},
      browserRunsOnDockerHost:true,
      acceptancePlumbing:{
        providerReachabilityRelay:"persistent systemd user service bound only to the isolated Docker bridge",
        applicationContainer:false,
        publicIngress:false,
        endpointRecorded:false
      }
    }
  ' >"$RECEIPT_DIR/topology.json"

jq -n '
  {
    codex:{provider:"codex-lb",credentialMode:"isolated writable CODEX_HOME bind containing only minimal config plus key",endpointRecorded:false},
    copilot:{providerType:"openai",wireApi:"responses",transport:"http",credentialMode:"read-only API-key bind mount",endpointRecorded:false},
    reachabilityRelay:{bindScope:"isolated Docker bridge only",storesOrLogsHeaders:false,endpointRecorded:false},
    credentialsRecorded:false
  }
' >"$RECEIPT_DIR/provider-proof.json"

NODE_VERSION=$(docker exec "$CONTROL_CONTAINER" node --version | tr -d '\r\n')
CODEX_VERSION=$(docker exec "$CODEX_CONTAINER" \
  /opt/src/agent-multiplex/node_modules/.bin/codex --version | tr -d '\r\n')
COPILOT_CLI_VERSION=$(docker exec "$COPILOT_CONTAINER" \
  /opt/src/agent-multiplex/node_modules/.bin/copilot --version | sed -n '1p' | tr -d '\r\n')
COPILOT_VERSION=$(jq -r '.[] | select(.harness == "copilot") | .runtimeVersion // "unavailable"' \
  "$RECEIPT_DIR/rpc/harness-catalog.json")
DOCKER_VERSION=$(docker version --format '{{.Server.Version}}')
IFS=$'\t' read -r P2PRPC_VERSION P2PRPC_INTEGRITY < <(
  node -e '
    const lock = require(process.argv[1]);
    const dependency = lock.packages?.["node_modules/@arduano/p2prpc-core"];
    if (!dependency?.version || !dependency?.integrity) process.exit(1);
    process.stdout.write(`${dependency.version}\t${dependency.integrity}\n`);
  ' "$REPO_ROOT/package-lock.json"
)
capture_logs
if rg --quiet '(UnhandledPromiseRejection|uncaught exception|SQLITE_CORRUPT|database disk image is malformed)' \
  "$RECEIPT_DIR/logs/control-node.log" \
  "$RECEIPT_DIR/logs/access-gateway.log" \
  "$RECEIPT_DIR/logs/codex-runtime-node.log" \
  "$RECEIPT_DIR/logs/copilot-runtime-node.log"; then
  fail "fatal runtime error appeared in captured logs"
fi
if rg --quiet 'unknown handle: [0-9]+' \
  "$RECEIPT_DIR/logs/control-node.log" \
  "$RECEIPT_DIR/logs/access-gateway.log" \
  "$RECEIPT_DIR/logs/codex-runtime-node.log" \
  "$RECEIPT_DIR/logs/copilot-runtime-node.log"; then
  fail "stale native p2prpc handle failure appeared in captured logs"
fi
note "proving terminal canary bytes remained ephemeral"
mkdir -p "$RUNTIME_DIR/codex-runtime-state-copy" "$RUNTIME_DIR/copilot-runtime-state-copy"
# Docker's archive endpoint cannot see files beneath a tmpfs mount on some
# daemon/storage-driver combinations even while `docker exec` can. Stream the
# two private runtime stores through tar instead; nothing is written to the
# receipt until the canary scanner has proved the copies clean.
docker exec "$CODEX_CONTAINER" tar -C /state/runtime-node -cf - . \
  | tar -C "$RUNTIME_DIR/codex-runtime-state-copy" --no-same-owner -xf -
docker exec "$COPILOT_CONTAINER" tar -C /state/runtime-node -cf - . \
  | tar -C "$RUNTIME_DIR/copilot-runtime-state-copy" --no-same-owner -xf -
node "$SCRIPT_DIR/verify-terminal-ephemerality.mjs" \
  "$RECEIPT_DIR" "$TERMINAL_MARKER_FILE" \
  "$RUNTIME_DIR/authority-state" "$RUNTIME_DIR/gateway-state" \
  "$RUNTIME_DIR/codex-runtime-state-copy" "$RUNTIME_DIR/copilot-runtime-state-copy" \
  >"$RECEIPT_DIR/logs/terminal-ephemerality-verifier.log"
assert_json "terminal transport bytes reached a forbidden durable surface" \
  '.passed == true and .canary.rawValueRecorded == false and
   (.assertions | to_entries | all(.value == true))' \
  "$RECEIPT_DIR/terminal-ephemerality.json"
jq --slurpfile terminal "$RECEIPT_DIR/terminal-ephemerality.json" '
  .terminalStorage = $terminal[0].assertions |
  .passed = (.passed and $terminal[0].passed)
' "$RECEIPT_DIR/checks.json" >"$RUNTIME_DIR/checks-with-terminal-storage.json"
mv -- "$RUNTIME_DIR/checks-with-terminal-storage.json" "$RECEIPT_DIR/checks.json"
assert_json "combined acceptance checks failed after terminal storage scan" \
  '.passed == true and (.terminalStorage | to_entries | all(.value == true))' \
  "$RECEIPT_DIR/checks.json"
rm -f -- "$TERMINAL_MARKER_FILE"
TRUNCATED_FRAME_OBSERVED=false
if rg --quiet 'Stream ended with [0-9]+ bytes remaining' \
  "$RECEIPT_DIR/logs/control-node.log" \
  "$RECEIPT_DIR/logs/access-gateway.log" \
  "$RECEIPT_DIR/logs/codex-runtime-node.log" \
  "$RECEIPT_DIR/logs/copilot-runtime-node.log"; then
  # QUIC can report a partial terminal frame when an authenticated session is
  # deliberately expired. Post-soak RPC, history, and stream checks establish
  # whether the replacement session is healthy; this diagnostic alone is not
  # a retained-peer failure.
  TRUNCATED_FRAME_OBSERVED=true
fi
jq -n --argjson soakMs "$SOAK_MS" --argjson truncated "$TRUNCATED_FRAME_OBSERVED" '
  {
    passed:true,
    configuredSoakMs:$soakMs,
    nativeHandleExpiryObserved:false,
    truncatedTransportFrameObserved:$truncated
  }
' >"$RECEIPT_DIR/transport-liveness.json"
if secret_values_present_in_receipt; then
  fail "credential, provider, or reachability material leaked into the receipt"
fi
jq -n '{passed:true,rawSecrets:false,providerEndpoint:false,p2pTicket:false,ticketShape:false}' \
  >"$RECEIPT_DIR/security-scan.json"

if [[ "$KEEP" == 1 ]]; then
  write_handoff
else
  note "removing the exact four containers, network, image, and temporary runtime data"
  remove_resources
  write_cleanup
  assert_json "normal-mode cleanup was incomplete" '.cleanupCompleted == true' \
    "$RECEIPT_DIR/cleanup.json"
  if (( CLEANUP_COMPLETED == 1 )) && [[ -d "$RUNTIME_DIR" && ! -L "$RUNTIME_DIR" && \
       "$(basename -- "$RUNTIME_DIR")" == agent-multiplex-live-four.* ]]; then
    find "$RUNTIME_DIR" -mindepth 1 -depth -delete && rmdir "$RUNTIME_DIR"
  fi
fi

if [[ "$(git -C "$REPO_ROOT" rev-parse --verify 'HEAD^{commit}')" != "$SOURCE_COMMIT" || \
      -n "$(git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)" ]]; then
  fail "source commit or worktree changed during live qualification"
fi
RUN_COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

jq -n \
  --arg runId "$RUN_ID" --arg startedAt "$RUN_STARTED_AT" --arg completedAt "$RUN_COMPLETED_AT" \
  --arg sourceCommit "$SOURCE_COMMIT" \
  --arg docker "$DOCKER_VERSION" --arg node "$NODE_VERSION" --arg codex "$CODEX_VERSION" \
  --arg copilotCli "$COPILOT_CLI_VERSION" --arg copilot "$COPILOT_VERSION" \
  --arg p2prpcVersion "$P2PRPC_VERSION" \
  --arg p2prpcIntegrity "$P2PRPC_INTEGRITY" \
  --arg initialCodexModel "$INITIAL_CODEX_MODEL" --arg secondCodexModel "$SECOND_CODEX_MODEL" \
  --arg copilotModel "$COPILOT_MODEL" --arg imageId "$IMAGE_ID" --argjson retained "$KEEP" \
  --argjson soakMs "$SOAK_MS" '
    {
      runId:$runId,status:"passed",sourceCommit:$sourceCommit,
      startedAt:$startedAt,completedAt:$completedAt,
      topology:{applicationContainers:4,canonicalAuthorities:1,runtimeNodes:2,accessGateways:1,onlyGatewayPublished:true},
      versions:{
        dockerServer:$docker,
        nodeInImage:$node,
        codexRuntime:$codex,
        copilotCli:$copilotCli,
        copilotRuntime:$copilot,
        multiplexProtocol:4,
        p2prpcVersion:$p2prpcVersion,
        p2prpcIntegrity:$p2prpcIntegrity
      },
      models:{codexInitial:$initialCodexModel,codexSwitched:$secondCodexModel,copilot:$copilotModel},
      livenessSoak:{requestedMs:$soakMs,performed:($soakMs > 0)},
      imageId:$imageId,
      resourcesRetained:($retained == 1),
      credentialMaterialRecorded:false,
      evidence:{checks:"checks.json",summary:"summary.json",topology:"topology.json",transportLiveness:"transport-liveness.json",terminalEphemerality:"terminal-ephemerality.json",logs:"logs/",rpc:"rpc/",phases:"phases/",screenshots:"screenshots/",checksums:"SHA256SUMS"}
    }
  ' >"$RECEIPT_DIR/manifest.json"

{
  printf '# Live protocol-v4 four-container acceptance receipt\n\n'
  printf 'Status: **PASS**\n\nRun: `%s`\n\n' "$RUN_ID"
  printf 'Exactly four application containers were used: one canonical control node, one zero-authority gateway, one real Codex runtime, and one real Copilot BYOK runtime. Playwright and the verifier ran on the Docker host and reached the system only through the gateway.\n\n'
  printf 'The browser spawned both agents, edited canonical metadata, streamed native chats, switched the Codex model and mode, answered a Codex Plan-mode question, interrupted an active shell turn, and reloaded native histories. It also opened the managed stock Codex TUI, attached a second read-only browser, acquired the single renewable keyboard lease, streamed a private raw-input canary to both viewers, submitted a separate semantic TUI prompt, propagated a resize, terminated only the TUI through confirmation, and then proved structured chat still worked.\n\n'
  printf 'Copilot remained on the default structured adapter and the UI showed its native TUI as explicit opt-in experimental. The private terminal canary was erased before submission and its raw/base64 bytes were absent from all four application SQLite stores, native-history responses, the fleet event journal, and application logs; only its SHA-256 digest is retained.\n\n'
  if (( SOAK_MS > 0 )); then
    printf 'The same browser and gateway-only fleet stream remained attached for a %sms liveness soak, then verified the selected source, both online runtimes, both retained sessions, and fresh streamed Codex and Copilot replies.\n\n' "$SOAK_MS"
  fi
  printf 'No API key, bearer token, shared secret, provider endpoint, or raw p2prpc ticket is present in this receipt.\n'
} >"$RECEIPT_DIR/README.md"

# Scan the final receipt population, including retained handoff/cleanup files.
if secret_values_present_in_receipt; then
  fail "credential, provider, or reachability material leaked into the final receipt"
fi

(
  cd "$RECEIPT_DIR"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)

COMPLETED=1
note "all live four-container assertions passed"
