#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
P2PRPC_CORE=${AGENT_MULTIPLEX_P2PRPC_CORE:-"$REPO_ROOT/../p2prpc/packages/core"}
RECEIPT_ROOT=${AGENT_MULTIPLEX_NESTED_RECEIPT_ROOT:-"$REPO_ROOT/receipts/nested-docker"}
HOST_COUNT=4
WORKER_COUNT=10
GATEWAY_COUNT=2
SESSIONS_PER_WORKER=10
TOTAL_SESSIONS=$(( WORKER_COUNT * SESSIONS_PER_WORKER ))
TOTAL_CONTAINERS=$(( HOST_COUNT + WORKER_COUNT + GATEWAY_COUNT ))
CHUNK_COUNT=${AGENT_MULTIPLEX_MOCK_CHUNK_COUNT:-24}
CHUNK_INTERVAL_MS=${AGENT_MULTIPLEX_MOCK_CHUNK_INTERVAL_MS:-100}
TIMEOUT_MS=${AGENT_MULTIPLEX_NESTED_TIMEOUT_MS:-240000}
SOAK_MS=${AGENT_MULTIPLEX_NESTED_SOAK_MS:-8000}
PLAYWRIGHT_MODULE=${AGENT_MULTIPLEX_PLAYWRIGHT_MODULE:-/home/arduano/.bun/install/global/node_modules/playwright/index.mjs}
CHROME_EXECUTABLE=${AGENT_MULTIPLEX_CHROME_EXECUTABLE:-/home/arduano/.nix-profile/bin/google-chrome}
KEEP_IMAGE=${AGENT_MULTIPLEX_NESTED_KEEP_IMAGE:-0}

for value_name in CHUNK_COUNT CHUNK_INTERVAL_MS TIMEOUT_MS SOAK_MS; do
  value=${!value_name}
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( value < 1 )); then
    echo "nested Docker acceptance: $value_name must be a positive integer" >&2
    exit 1
  fi
done
if (( CHUNK_COUNT < 8 )); then
  echo "nested Docker acceptance: CHUNK_COUNT must be at least 8" >&2
  exit 1
fi
if (( SOAK_MS < 2000 )); then
  echo "nested Docker acceptance: SOAK_MS must be at least 2000" >&2
  exit 1
fi
if (( CHUNK_COUNT * CHUNK_INTERVAL_MS < 2000 || (CHUNK_COUNT - 3) * CHUNK_INTERVAL_MS < 1500 )); then
  echo "nested Docker acceptance: mock turns must last at least 2000ms with 1500ms remaining after three chunks so interruption is observable" >&2
  exit 1
fi
if [[ "$KEEP_IMAGE" != 0 && "$KEEP_IMAGE" != 1 ]]; then
  echo "nested Docker acceptance: AGENT_MULTIPLEX_NESTED_KEEP_IMAGE must be 0 or 1" >&2
  exit 1
fi
for tool in docker jq node curl sha256sum awk sed perl rg timeout find sort xargs cp dirname; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "nested Docker acceptance: required tool '$tool' is unavailable" >&2
    exit 1
  fi
done
if [[ ! -f "$P2PRPC_CORE/package.json" || ! -d "$P2PRPC_CORE/dist" ]]; then
  echo "nested Docker acceptance: built p2prpc core is required at $P2PRPC_CORE" >&2
  exit 1
fi
if [[ ! -x "$CHROME_EXECUTABLE" ]]; then
  echo "nested Docker acceptance: Chrome executable is unavailable: $CHROME_EXECUTABLE" >&2
  exit 1
fi
if ! node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const value = process.argv[1];
  await import(value.startsWith("/") ? pathToFileURL(value).href : value);
' "$PLAYWRIGHT_MODULE" >/dev/null 2>&1; then
  echo "nested Docker acceptance: Playwright module cannot be imported: $PLAYWRIGHT_MODULE" >&2
  exit 1
fi

random_hex() {
  node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))'
}

RUN_ID=${AGENT_MULTIPLEX_NESTED_RUN_ID:-"$(date -u +%Y%m%dT%H%M%SZ)-$(random_hex)"}
if [[ ! "$RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]] || (( ${#RUN_ID} > 128 )); then
  echo "nested Docker acceptance: invalid run id" >&2
  exit 1
fi
if [[ "$RUN_ID" =~ p2prpc3\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{80,} ]]; then
  echo "nested Docker acceptance: run id must not resemble a p2prpc ticket" >&2
  exit 1
fi
RECEIPT_DIR="$RECEIPT_ROOT/$RUN_ID"
if [[ -e "$RECEIPT_DIR" ]]; then
  echo "nested Docker acceptance: receipt directory exists: $RECEIPT_DIR" >&2
  exit 1
fi
mkdir -p \
  "$RECEIPT_DIR/logs/hosts" \
  "$RECEIPT_DIR/logs/workers" \
  "$RECEIPT_DIR/logs/gateways" \
  "$RECEIPT_DIR/rpc" \
  "$RECEIPT_DIR/phases" \
  "$RECEIPT_DIR/coord" \
  "$RECEIPT_DIR/screenshots"

RUNTIME_DIR=$(mktemp -d "${TMPDIR:-/tmp}/agent-multiplex-nested.XXXXXXXX")
P2PRPC_DOCKER_CONTEXT="$RUNTIME_DIR/p2prpc-core"
AGENT_DOCKER_CONTEXT="$RUNTIME_DIR/agent-multiplex"
NAME_SUFFIX=$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 20))' -- "$RUN_ID")
NETWORK_NAME="agent-multiplex-nested-$NAME_SUFFIX"
IMAGE_TAG="agent-multiplex-nested:$NAME_SUFFIX"
CONTAINER_PREFIX="agent-multiplex-nested-$NAME_SUFFIX"
HOST_PREFIX="nested-$NAME_SUFFIX"
WORKER_PREFIX="nested-worker-$NAME_SUFFIX"
SHARED_SECRET=$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))')
RUN_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

ROOT_CONTAINER="$CONTAINER_PREFIX-root"
AGGREGATE_A_CONTAINER="$CONTAINER_PREFIX-aggregate-a"
LEAF_A1_CONTAINER="$CONTAINER_PREFIX-leaf-a1"
AGGREGATE_B_CONTAINER="$CONTAINER_PREFIX-aggregate-b"
GATEWAY_ONE_CONTAINER="$CONTAINER_PREFIX-gateway-01"
GATEWAY_TWO_CONTAINER="$CONTAINER_PREFIX-gateway-02"
declare -a HOST_CONTAINERS=(
  "$ROOT_CONTAINER" "$AGGREGATE_A_CONTAINER" "$LEAF_A1_CONTAINER" "$AGGREGATE_B_CONTAINER"
)
declare -a HOST_NAMES=(
  "$HOST_PREFIX-root" "$HOST_PREFIX-aggregate-a" "$HOST_PREFIX-leaf-a1" "$HOST_PREFIX-aggregate-b"
)
declare -a GATEWAY_CONTAINERS=("$GATEWAY_ONE_CONTAINER" "$GATEWAY_TWO_CONTAINER")
declare -a WORKER_CONTAINERS=()
declare -a WORKER_NAMES=()
declare -a ALL_CONTAINERS=()

ROOT_ENDPOINT=""
ROOT_TICKET=""
AGGREGATE_A_ENDPOINT=""
AGGREGATE_A_TICKET=""
LEAF_A1_ENDPOINT=""
LEAF_A1_TICKET=""
AGGREGATE_B_ENDPOINT=""
AGGREGATE_B_TICKET=""
DRIVER_PID=""
RESOURCE_PID=""
NETWORK_CREATED=0
IMAGE_BUILT=0
IMAGE_REMOVED=0
LOGS_CAPTURED=0
COMPLETED=0

note() { printf '[nested-docker] %s\n' "$*" >&2; }
fail() { note "FAILED: $*"; return 1; }
report_shell_error() {
  local status=$?
  # Do not echo BASH_COMMAND: Docker invocations contain transport bootstrap
  # material. A source line and status are sufficient for a safe receipt.
  note "shell command failed at line ${BASH_LINENO[0]} (status $status)"
  return "$status"
}
trap report_shell_error ERR

redact_stream() {
  AM_REDACT_SHARED="$SHARED_SECRET" \
  AM_REDACT_ROOT="$ROOT_TICKET" \
  AM_REDACT_A="$AGGREGATE_A_TICKET" \
  AM_REDACT_A1="$LEAF_A1_TICKET" \
  AM_REDACT_B="$AGGREGATE_B_TICKET" \
    perl -0pe '
      BEGIN {
        @pairs = (
          [$ENV{AM_REDACT_SHARED} // "", "<redacted-shared-secret>"],
          [$ENV{AM_REDACT_ROOT} // "", "<redacted-root-ticket>"],
          [$ENV{AM_REDACT_A} // "", "<redacted-aggregate-a-ticket>"],
          [$ENV{AM_REDACT_A1} // "", "<redacted-leaf-a1-ticket>"],
          [$ENV{AM_REDACT_B} // "", "<redacted-aggregate-b-ticket>"],
        );
      }
      for $pair (@pairs) {
        ($value, $replacement) = @$pair;
        s/\Q$value\E/$replacement/g if length($value);
      }
      s/p2prpc3\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{80,}/<redacted-p2p-ticket>/g;
    '
}

hash_source_tree() {
  (
    cd "$REPO_ROOT"
    {
      for file in package.json package-lock.json tsconfig.base.json tsconfig.json \
        .dockerignore; do
        [[ ! -f "$file" ]] || printf './%s\0' "$file"
      done
      find ./apps ./packages ./tests/docker-nested-hosts -type f \
        ! -path '*/node_modules/*' \
        ! -path '*/dist/*' \
        ! -name '.env' \
        ! -name '.env.*' \
        ! -name '.npmrc' \
        ! -name '*.pem' \
        ! -name '*.key' \
        ! -name '*.p12' \
        ! -name '*.pfx' \
        -print0
    } \
      | sort -z \
      | xargs -0 sha256sum \
      | sha256sum \
      | awk '{print $1}'
  )
}

hash_p2prpc_context() {
  local context_root=${1:-$P2PRPC_CORE}
  (
    cd "$context_root"
    {
      for file in package.json LICENSE README.md SECURITY.md THIRD_PARTY_NOTICES.md; do
        [[ ! -f "$file" ]] || printf './%s\0' "$file"
      done
      find ./dist -type f -print0
    } \
      | sort -z \
      | xargs -0 sha256sum \
      | sha256sum \
      | awk '{print $1}'
  )
}

hash_staged_context() {
  local context_root=$1
  (
    cd "$context_root"
    find . -type f -print0 \
      | sort -z \
      | xargs -0 sha256sum \
      | sha256sum \
      | awk '{print $1}'
  )
}

prepare_p2prpc_docker_context() {
  local file
  mkdir -p "$P2PRPC_DOCKER_CONTEXT/dist"
  for file in package.json LICENSE README.md SECURITY.md THIRD_PARTY_NOTICES.md; do
    if [[ ! -f "$P2PRPC_CORE/$file" ]]; then
      fail "p2prpc Docker context requires $P2PRPC_CORE/$file"
      return
    fi
    cp "$P2PRPC_CORE/$file" "$P2PRPC_DOCKER_CONTEXT/$file"
  done
  cp -R "$P2PRPC_CORE/dist/." "$P2PRPC_DOCKER_CONTEXT/dist/"
}

prepare_agent_docker_context() {
  local file relative destination
  mkdir -p "$AGENT_DOCKER_CONTEXT"
  for file in package.json package-lock.json tsconfig.base.json tsconfig.json; do
    if [[ ! -f "$REPO_ROOT/$file" ]]; then
      fail "agent Docker context requires $REPO_ROOT/$file"
      return
    fi
    cp "$REPO_ROOT/$file" "$AGENT_DOCKER_CONTEXT/$file"
  done
  while IFS= read -r -d '' file; do
    relative=${file#"$REPO_ROOT/"}
    destination="$AGENT_DOCKER_CONTEXT/$relative"
    mkdir -p "$(dirname -- "$destination")"
    cp -- "$file" "$destination"
  done < <(
    find "$REPO_ROOT/apps" "$REPO_ROOT/packages" -type f \
      \( -path '*/src/*' -o -name 'package.json' -o -name 'tsconfig.json' \) \
      -print0
  )
}

assert_receipt_has_no_locators() {
  local path
  for path in "$@"; do
    for forbidden in "$SHARED_SECRET" "$ROOT_TICKET" "$AGGREGATE_A_TICKET" "$LEAF_A1_TICKET" "$AGGREGATE_B_TICKET"; do
      if [[ -n "$forbidden" ]] && rg --text --fixed-strings --quiet -- "$forbidden" "$path"; then
        fail "transport secret or exact locator leaked into receipt material"
        return
      fi
    done
    if rg --text --pcre2 --quiet -- 'p2prpc3\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{80,}' "$path"; then
      fail "p2prpc ticket-shaped locator leaked into receipt material"
      return
    fi
  done
}

sanitize_host_log() {
  awk '
    redact_next { print "<redacted-p2p-locator>"; redact_next = 0; next }
    /^P2P ticket \(/ { print; redact_next = 1; next }
    { print }
  ' | redact_stream
}

capture_logs() {
  # Cleanup invokes this defensively after the success path has already
  # captured logs. Return success explicitly so the global ERR trap does not
  # report a phantom failure after a passing run.
  if (( LOGS_CAPTURED != 0 )); then return 0; fi
  local index container raw
  for (( index = 0; index < ${#HOST_CONTAINERS[@]}; index++ )); do
    container=${HOST_CONTAINERS[$index]}
    if docker container inspect "$container" >/dev/null 2>&1; then
      raw="$RUNTIME_DIR/host-$index.raw.log"
      docker logs "$container" >"$raw" 2>&1 || true
      sanitize_host_log <"$raw" >"$RECEIPT_DIR/logs/hosts/${HOST_NAMES[$index]}.log"
    fi
  done
  for (( index = 0; index < ${#WORKER_CONTAINERS[@]}; index++ )); do
    container=${WORKER_CONTAINERS[$index]}
    if docker container inspect "$container" >/dev/null 2>&1; then
      raw="$RUNTIME_DIR/worker-$index.raw.log"
      docker logs "$container" >"$raw" 2>&1 || true
      redact_stream <"$raw" >"$RECEIPT_DIR/logs/workers/${WORKER_NAMES[$index]}.log"
    fi
  done
  for (( index = 0; index < ${#GATEWAY_CONTAINERS[@]}; index++ )); do
    container=${GATEWAY_CONTAINERS[$index]}
    if docker container inspect "$container" >/dev/null 2>&1; then
      raw="$RUNTIME_DIR/gateway-$index.raw.log"
      docker logs "$container" >"$raw" 2>&1 || true
      redact_stream <"$raw" >"$RECEIPT_DIR/logs/gateways/gateway-$(printf '%02d' "$(( index + 1 ))").log"
    fi
  done
  LOGS_CAPTURED=1
}

remove_test_topology() {
  local container
  for container in "${ALL_CONTAINERS[@]}"; do
    docker rm --force "$container" >/dev/null 2>&1 || true
  done
  if (( NETWORK_CREATED == 1 )); then
    docker network rm "$NETWORK_NAME" >/dev/null 2>&1 || true
    NETWORK_CREATED=0
  fi
  if (( IMAGE_BUILT == 1 )) && [[ "$KEEP_IMAGE" != 1 ]]; then
    if docker image rm "$IMAGE_TAG" >/dev/null 2>&1; then
      IMAGE_BUILT=0
      IMAGE_REMOVED=1
    fi
  fi
}

cleanup() {
  local status=$?
  if (( COMPLETED == 0 && status == 0 )); then status=1; fi
  trap - EXIT INT TERM
  set +e
  if [[ -n "$DRIVER_PID" ]] && kill -0 "$DRIVER_PID" 2>/dev/null; then
    kill "$DRIVER_PID" 2>/dev/null
    wait "$DRIVER_PID" 2>/dev/null
  fi
  if [[ -n "$RESOURCE_PID" ]] && kill -0 "$RESOURCE_PID" 2>/dev/null; then
    kill "$RESOURCE_PID" 2>/dev/null
    wait "$RESOURCE_PID" 2>/dev/null
  fi
  capture_logs
  remove_test_topology
  if [[ -d "$RUNTIME_DIR" && "$RUNTIME_DIR" != "/" && \
        "$(basename -- "$RUNTIME_DIR")" == agent-multiplex-nested.* ]]; then
    rm -rf -- "$RUNTIME_DIR"
  fi
  if (( COMPLETED == 0 )); then
    rm -f -- \
      "$RECEIPT_DIR/manifest.json" \
      "$RECEIPT_DIR/checks.json" \
      "$RECEIPT_DIR/README.md" \
      "$RECEIPT_DIR/SHA256SUMS"
    printf 'The nested Docker acceptance failed. Inspect driver-failure.json and logs/.\n' \
      >"$RECEIPT_DIR/FAILED.txt"
  fi
  if (( status == 0 && COMPLETED == 1 )); then
    note "PASS: receipts saved to $RECEIPT_DIR"
  else
    note "Run failed; partial receipts saved to $RECEIPT_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

container_running() {
  [[ $(docker inspect --format '{{.State.Running}}' "$1" 2>/dev/null) == true ]]
}

wait_for_host_startup() {
  local container=$1 attempt logs
  for attempt in $(seq 1 120); do
    if ! container_running "$container"; then
      docker logs "$container" 2>&1 | sanitize_host_log >&2 || true
      fail "$container exited during host startup"
      return
    fi
    logs=$(docker logs "$container" 2>&1 || true)
    if rg --quiet '^Host ID:' <<<"$logs" && rg --quiet '^P2P ID:' <<<"$logs" && \
       rg --quiet '^P2P ticket \(' <<<"$logs"; then
      return
    fi
    (( attempt % 20 != 0 )) || note "waiting for $container endpoint (${attempt}s)"
    sleep 1
  done
  fail "timed out waiting for $container startup"
}

wait_for_parent_attachment() {
  local container=$1 attempt logs
  for attempt in $(seq 1 120); do
    if ! container_running "$container"; then
      docker logs "$container" 2>&1 | sanitize_host_log >&2 || true
      fail "$container exited before parent attachment"
      return
    fi
    logs=$(docker logs "$container" 2>&1 || true)
    if rg --quiet '^Attached to parent host ' <<<"$logs"; then return; fi
    (( attempt % 20 != 0 )) || note "waiting for $container parent attachment (${attempt}s)"
    sleep 1
  done
  fail "timed out waiting for $container parent attachment"
}

wait_for_gateway_startup() {
  local container=$1 attempt logs
  for attempt in $(seq 1 120); do
    if ! container_running "$container"; then
      docker logs "$container" 2>&1 | redact_stream >&2 || true
      fail "$container exited during observer enrollment"
      return
    fi
    logs=$(docker logs "$container" 2>&1 || true)
    if rg --quiet '^Agent Multiplex edge gateway$' <<<"$logs" && \
       rg --quiet '^Observer endpoint:' <<<"$logs"; then
      return
    fi
    (( attempt % 20 != 0 )) || note "waiting for $container observer enrollment (${attempt}s)"
    sleep 1
  done
  fail "timed out waiting for $container gateway startup"
}

host_endpoint() { docker logs "$1" 2>&1 | sed -n 's/^P2P ID:[[:space:]]*//p' | tail -n 1; }
host_ticket() {
  # Read the complete `docker logs` stream. Exiting awk after the first ticket
  # can close the pipe while Docker is still writing later startup lines;
  # under `set -o pipefail`, Docker's resulting SIGPIPE aborts the harness.
  docker logs "$1" 2>&1 | awk '
    capture { ticket = $0; capture = 0 }
    /^P2P ticket \(/ { capture = 1 }
    END { if (ticket != "") print ticket }
  '
}

validate_host_bootstrap() {
  local label=$1 endpoint=$2 ticket=$3
  if [[ ! "$endpoint" =~ ^[a-z2-7]{52}$ ]] || \
     [[ ! "$ticket" =~ ^p2prpc3\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{80,}$ ]]; then
    fail "$label emitted invalid p2prpc bootstrap data"
  fi
}

published_url() {
  local mapping published
  mapping=$(docker port "$1" "$2/tcp" | tail -n 1)
  published=${mapping##*:}
  if [[ ! "$published" =~ ^[0-9]+$ ]]; then
    fail "could not resolve published port $2 for $1"
    return
  fi
  printf 'http://127.0.0.1:%s' "$published"
}

sample_resources() {
  local sampled_at raw
  while [[ ! -e "$RECEIPT_DIR/coord/stop-resource-sampling" ]]; do
    sampled_at=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
    raw=$(timeout 30s docker stats --no-stream --format '{{json .}}' \
      "${ALL_CONTAINERS[@]}" 2>/dev/null || true)
    if [[ -n "$raw" ]]; then
      jq -c --arg sampledAt "$sampled_at" '. + {sampledAt: $sampledAt}' \
        <<<"$raw" >>"$RECEIPT_DIR/logs/docker-stats.ndjson" || true
    fi
    sleep 1
  done
}

assert_json() {
  local description=$1 filter=$2 file=$3
  shift 3
  if ! jq -e "$@" "$filter" "$file" >/dev/null; then
    fail "$description (see ${file#"$RECEIPT_DIR/"})"
  fi
}

prepare_p2prpc_docker_context
prepare_agent_docker_context
SOURCE_DIGEST_BEFORE=$(hash_source_tree)
P2PRPC_CONTEXT_DIGEST_BEFORE=$(hash_p2prpc_context)
P2PRPC_STAGED_CONTEXT_DIGEST=$(hash_p2prpc_context "$P2PRPC_DOCKER_CONTEXT")
AGENT_DOCKER_CONTEXT_DIGEST=$(hash_staged_context "$AGENT_DOCKER_CONTEXT")
if [[ "$P2PRPC_STAGED_CONTEXT_DIGEST" != "$P2PRPC_CONTEXT_DIGEST_BEFORE" ]]; then
  fail "staged p2prpc Docker context differs from its allowlisted source"
fi
if docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  fail "refusing to overwrite pre-existing image tag $IMAGE_TAG"
fi
if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  fail "refusing to reuse pre-existing network $NETWORK_NAME"
fi
EXISTING_CONTAINER_NAMES=$(docker ps --all --format '{{.Names}}')
if rg --fixed-strings --line-regexp --quiet "$CONTAINER_PREFIX" <<<"$EXISTING_CONTAINER_NAMES" || \
   rg --quiet "^${CONTAINER_PREFIX}-" <<<"$EXISTING_CONTAINER_NAMES"; then
  fail "refusing to reuse a pre-existing container name under $CONTAINER_PREFIX"
fi

note "building one immutable image for all 16 application containers"
if ! docker build \
  --progress=plain \
  --build-context "p2prpc-core=$P2PRPC_DOCKER_CONTEXT" \
  --file "$SCRIPT_DIR/Dockerfile" \
  --tag "$IMAGE_TAG" \
  "$AGENT_DOCKER_CONTEXT" >"$RECEIPT_DIR/logs/docker-build.log" 2>&1; then
  tail -n 120 "$RECEIPT_DIR/logs/docker-build.log" >&2 || true
  fail "Docker image build failed"
fi
IMAGE_BUILT=1
IMAGE_ID=$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")
docker network create --driver bridge "$NETWORK_NAME" >/dev/null
NETWORK_CREATED=1

note "starting root host"
docker run --detach \
  --name "$ROOT_CONTAINER" --hostname nested-root --network "$NETWORK_NAME" \
  --init --user 1000:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /state:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --publish 127.0.0.1::4317 \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_HOST_NAME="$HOST_PREFIX-root" \
  --env AGENT_MULTIPLEX_HOST_STATE=/state/host.sqlite \
  --env AGENT_MULTIPLEX_HOST_IDENTITY=/state/host.identity \
  --env AGENT_MULTIPLEX_HTTP_BIND=0.0.0.0 \
  --env AGENT_MULTIPLEX_HTTP_PORT=4317 \
  --env AGENT_MULTIPLEX_CHILD_STALE_MS=1500 \
  --env AGENT_MULTIPLEX_WORKER_STALE_MS=120000 \
  --env AGENT_MULTIPLEX_ALLOW_HOST_ENROLLMENT=1 \
  --env AGENT_MULTIPLEX_ALLOW_OBSERVER_ENROLLMENT=1 \
  "$IMAGE_TAG" node apps/host/dist/main.js >/dev/null
ALL_CONTAINERS+=("$ROOT_CONTAINER")
wait_for_host_startup "$ROOT_CONTAINER"
ROOT_ENDPOINT=$(host_endpoint "$ROOT_CONTAINER")
ROOT_TICKET=$(host_ticket "$ROOT_CONTAINER")
validate_host_bootstrap root "$ROOT_ENDPOINT" "$ROOT_TICKET"

note "starting sibling aggregate hosts A and B"
docker run --detach \
  --name "$AGGREGATE_A_CONTAINER" --hostname nested-aggregate-a --network "$NETWORK_NAME" \
  --init --user 1000:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /state:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_HOST_NAME="$HOST_PREFIX-aggregate-a" \
  --env AGENT_MULTIPLEX_HOST_STATE=/state/host.sqlite \
  --env AGENT_MULTIPLEX_HOST_IDENTITY=/state/host.identity \
  --env AGENT_MULTIPLEX_HTTP_BIND=0.0.0.0 \
  --env AGENT_MULTIPLEX_PARENT_ENDPOINT_ID="$ROOT_ENDPOINT" \
  --env AGENT_MULTIPLEX_PARENT_TICKET="$ROOT_TICKET" \
  --env AGENT_MULTIPLEX_PARENT_HEARTBEAT_MS=300 \
  --env AGENT_MULTIPLEX_RECONNECT_MAX_MS=500 \
  --env AGENT_MULTIPLEX_CHILD_STALE_MS=1500 \
  --env AGENT_MULTIPLEX_WORKER_STALE_MS=120000 \
  --env AGENT_MULTIPLEX_ALLOW_HOST_ENROLLMENT=1 \
  --env AGENT_MULTIPLEX_ALLOW_WORKER_ENROLLMENT=1 \
  "$IMAGE_TAG" node apps/host/dist/main.js >/dev/null
ALL_CONTAINERS+=("$AGGREGATE_A_CONTAINER")

docker run --detach \
  --name "$AGGREGATE_B_CONTAINER" --hostname nested-aggregate-b --network "$NETWORK_NAME" \
  --init --user 1000:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /state:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_HOST_NAME="$HOST_PREFIX-aggregate-b" \
  --env AGENT_MULTIPLEX_HOST_STATE=/state/host.sqlite \
  --env AGENT_MULTIPLEX_HOST_IDENTITY=/state/host.identity \
  --env AGENT_MULTIPLEX_HTTP_BIND=0.0.0.0 \
  --env AGENT_MULTIPLEX_PARENT_ENDPOINT_ID="$ROOT_ENDPOINT" \
  --env AGENT_MULTIPLEX_PARENT_TICKET="$ROOT_TICKET" \
  --env AGENT_MULTIPLEX_PARENT_HEARTBEAT_MS=300 \
  --env AGENT_MULTIPLEX_RECONNECT_MAX_MS=500 \
  --env AGENT_MULTIPLEX_CHILD_STALE_MS=1500 \
  --env AGENT_MULTIPLEX_WORKER_STALE_MS=120000 \
  --env AGENT_MULTIPLEX_ALLOW_WORKER_ENROLLMENT=1 \
  "$IMAGE_TAG" node apps/host/dist/main.js >/dev/null
ALL_CONTAINERS+=("$AGGREGATE_B_CONTAINER")
wait_for_host_startup "$AGGREGATE_A_CONTAINER"
wait_for_host_startup "$AGGREGATE_B_CONTAINER"
AGGREGATE_A_ENDPOINT=$(host_endpoint "$AGGREGATE_A_CONTAINER")
AGGREGATE_A_TICKET=$(host_ticket "$AGGREGATE_A_CONTAINER")
AGGREGATE_B_ENDPOINT=$(host_endpoint "$AGGREGATE_B_CONTAINER")
AGGREGATE_B_TICKET=$(host_ticket "$AGGREGATE_B_CONTAINER")
validate_host_bootstrap aggregate-a "$AGGREGATE_A_ENDPOINT" "$AGGREGATE_A_TICKET"
validate_host_bootstrap aggregate-b "$AGGREGATE_B_ENDPOINT" "$AGGREGATE_B_TICKET"
wait_for_parent_attachment "$AGGREGATE_A_CONTAINER"
wait_for_parent_attachment "$AGGREGATE_B_CONTAINER"

note "starting nested leaf A1 beneath aggregate A"
docker run --detach \
  --name "$LEAF_A1_CONTAINER" --hostname nested-leaf-a1 --network "$NETWORK_NAME" \
  --init --user 1000:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /state:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
  --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --publish 127.0.0.1::4317 \
  --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
  --env AGENT_MULTIPLEX_HOST_NAME="$HOST_PREFIX-leaf-a1" \
  --env AGENT_MULTIPLEX_HOST_STATE=/state/host.sqlite \
  --env AGENT_MULTIPLEX_HOST_IDENTITY=/state/host.identity \
  --env AGENT_MULTIPLEX_HTTP_BIND=0.0.0.0 \
  --env AGENT_MULTIPLEX_HTTP_PORT=4317 \
  --env AGENT_MULTIPLEX_PARENT_ENDPOINT_ID="$AGGREGATE_A_ENDPOINT" \
  --env AGENT_MULTIPLEX_PARENT_TICKET="$AGGREGATE_A_TICKET" \
  --env AGENT_MULTIPLEX_PARENT_HEARTBEAT_MS=300 \
  --env AGENT_MULTIPLEX_RECONNECT_MAX_MS=500 \
  --env AGENT_MULTIPLEX_CHILD_STALE_MS=1500 \
  --env AGENT_MULTIPLEX_WORKER_STALE_MS=120000 \
  --env AGENT_MULTIPLEX_ALLOW_WORKER_ENROLLMENT=1 \
  "$IMAGE_TAG" node apps/host/dist/main.js >/dev/null
ALL_CONTAINERS+=("$LEAF_A1_CONTAINER")
wait_for_host_startup "$LEAF_A1_CONTAINER"
LEAF_A1_ENDPOINT=$(host_endpoint "$LEAF_A1_CONTAINER")
LEAF_A1_TICKET=$(host_ticket "$LEAF_A1_CONTAINER")
validate_host_bootstrap leaf-a1 "$LEAF_A1_ENDPOINT" "$LEAF_A1_TICKET"
wait_for_parent_attachment "$LEAF_A1_CONTAINER"

ROOT_BASE_URL=$(published_url "$ROOT_CONTAINER" 4317)
LEAF_BASE_URL=$(published_url "$LEAF_A1_CONTAINER" 4317)
ROOT_TRPC_URL="$ROOT_BASE_URL/trpc"
LEAF_TRPC_URL="$LEAF_BASE_URL/trpc"

launch_worker() {
  local branch=$1 index=$2 endpoint=$3 ticket=$4 suffix container worker_name
  suffix=$(printf '%02d' "$index")
  worker_name="$WORKER_PREFIX-$branch-$suffix"
  container="$CONTAINER_PREFIX-worker-$branch-$suffix"
  WORKER_NAMES+=("$worker_name")
  WORKER_CONTAINERS+=("$container")
  docker run --detach \
    --name "$container" --hostname "worker-$branch-$suffix" --network "$NETWORK_NAME" \
    --init --user 1000:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
    --tmpfs /state:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
    --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
    --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
    --env AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID="$endpoint" \
    --env AGENT_MULTIPLEX_CONTROL_NODE_TICKET="$ticket" \
    --env 'AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS=["/workspace"]' \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_STATE_DIR=/state/runtime-node \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_NAME="$worker_name" \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES=codex \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_ADAPTER_MODE=mock \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_MOCK_CHUNK_COUNT="$CHUNK_COUNT" \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_MOCK_STREAM_INTERVAL_MS="$CHUNK_INTERVAL_MS" \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_HEARTBEAT_MS=300 \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_INVENTORY_REFRESH_MS=750 \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_METADATA_FLUSH_MS=200 \
    --env AGENT_MULTIPLEX_RUNTIME_NODE_RECONNECT_MAX_MS=500 \
    "$IMAGE_TAG" node apps/runtime-node/dist/main.js >/dev/null
  ALL_CONTAINERS+=("$container")
}

note "starting ten isolated workers across all three owning hosts"
for index in 0 1 2 3; do launch_worker a1 "$index" "$LEAF_A1_ENDPOINT" "$LEAF_A1_TICKET"; done
for index in 0 1; do launch_worker a "$index" "$AGGREGATE_A_ENDPOINT" "$AGGREGATE_A_TICKET"; done
for index in 0 1 2 3; do launch_worker b "$index" "$AGGREGATE_B_ENDPOINT" "$AGGREGATE_B_TICKET"; done

note "starting two standalone p2prpc observer gateways"
for gateway_index in 1 2; do
  gateway_suffix=$(printf '%02d' "$gateway_index")
  gateway_container="$CONTAINER_PREFIX-gateway-$gateway_suffix"
  docker run --detach \
    --name "$gateway_container" --hostname "observer-gateway-$gateway_suffix" \
    --network "$NETWORK_NAME" \
    --init --user 1000:100 --read-only --cap-drop ALL --security-opt no-new-privileges \
    --tmpfs /state:rw,nosuid,nodev,mode=0700,uid=1000,gid=100 \
    --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
    --publish 127.0.0.1::4318 \
    --env AGENT_MULTIPLEX_SHARED_SECRET="$SHARED_SECRET" \
    --env AGENT_MULTIPLEX_GATEWAY_IDENTITY=/state/gateway.identity \
    --env AGENT_MULTIPLEX_HOST_ENDPOINT_ID="$ROOT_ENDPOINT" \
    --env AGENT_MULTIPLEX_HOST_TICKET="$ROOT_TICKET" \
    --env AGENT_MULTIPLEX_GATEWAY_HTTP_BIND=0.0.0.0 \
    --env AGENT_MULTIPLEX_GATEWAY_HTTP_PORT=4318 \
    "$IMAGE_TAG" node apps/gateway/dist/main.js >/dev/null
  ALL_CONTAINERS+=("$gateway_container")
done
wait_for_gateway_startup "$GATEWAY_ONE_CONTAINER"
wait_for_gateway_startup "$GATEWAY_TWO_CONTAINER"
GATEWAY_ONE_BASE_URL=$(published_url "$GATEWAY_ONE_CONTAINER" 4318)
GATEWAY_TWO_BASE_URL=$(published_url "$GATEWAY_TWO_CONTAINER" 4318)
GATEWAY_ONE_TRPC_URL="$GATEWAY_ONE_BASE_URL/trpc"
GATEWAY_TWO_TRPC_URL="$GATEWAY_TWO_BASE_URL/trpc"

for url in "$ROOT_BASE_URL" "$LEAF_BASE_URL" "$GATEWAY_ONE_BASE_URL" "$GATEWAY_TWO_BASE_URL"; do
  for attempt in $(seq 1 30); do
    if curl --fail --silent --show-error "$url/" >/dev/null; then break; fi
    if (( attempt == 30 )); then fail "HTTP surface did not become reachable at $url"; fi
    sleep 1
  done
done

: >"$RECEIPT_DIR/logs/docker-stats.ndjson"
sample_resources &
RESOURCE_PID=$!

note "driving 100 sessions through observer gateway 1 and nested host routing"
DRIVER_TIMEOUT_SECONDS=$(( (TIMEOUT_MS * 5 + SOAK_MS) / 1000 + 180 ))
timeout "${DRIVER_TIMEOUT_SECONDS}s" node "$SCRIPT_DIR/driver.mjs" \
  "$GATEWAY_ONE_TRPC_URL" "$GATEWAY_TWO_TRPC_URL" \
  "$ROOT_TRPC_URL" "$LEAF_TRPC_URL" \
  "$RECEIPT_DIR" "$RUN_ID" "$HOST_PREFIX" "$WORKER_PREFIX" \
  "$SESSIONS_PER_WORKER" "$CHUNK_COUNT" "$TIMEOUT_MS" "$SOAK_MS" \
  >"$RECEIPT_DIR/driver-summary.json" 2>"$RECEIPT_DIR/logs/driver.log" &
DRIVER_PID=$!

for attempt in $(seq 1 $(( TIMEOUT_MS / 100 + 1 ))); do
  if [[ -s "$RECEIPT_DIR/coord/disconnect-request.json" ]]; then break; fi
  if ! kill -0 "$DRIVER_PID" 2>/dev/null; then
    wait "$DRIVER_PID" || true
    DRIVER_PID=""
    tail -n 100 "$RECEIPT_DIR/logs/driver.log" >&2 || true
    fail "driver exited before requesting aggregate-A disconnect"
  fi
  sleep 0.1
done
if [[ ! -s "$RECEIPT_DIR/coord/disconnect-request.json" ]]; then
  fail "timed out waiting for aggregate-A disconnect request"
fi
if [[ $(jq -r '.targetHostName' "$RECEIPT_DIR/coord/disconnect-request.json") != "$HOST_PREFIX-aggregate-a" ]]; then
  fail "driver requested another host disconnect"
fi

AGGREGATE_A_CONTAINER_ID=$(docker inspect --format '{{.Id}}' "$AGGREGATE_A_CONTAINER")
DISCONNECTED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
docker network disconnect "$NETWORK_NAME" "$AGGREGATE_A_CONTAINER"
if docker inspect --format '{{json .NetworkSettings.Networks}}' "$AGGREGATE_A_CONTAINER" \
  | jq -e --arg network "$NETWORK_NAME" 'has($network)' >/dev/null; then
  fail "aggregate A still reports nested-network membership"
fi
jq -n \
  --arg hostName "$HOST_PREFIX-aggregate-a" \
  --arg containerName "$AGGREGATE_A_CONTAINER" \
  --arg containerId "$AGGREGATE_A_CONTAINER_ID" \
  --arg disconnectedAt "$DISCONNECTED_AT" '
    {
      hostName: $hostName,
      containerName: $containerName,
      containerId: $containerId,
      disconnectedAt: $disconnectedAt,
      containerStayedRunning: true,
      absentFromDockerNetwork: true
    }
  ' >"$RECEIPT_DIR/coord/disconnect-started.json"

for attempt in $(seq 1 $(( TIMEOUT_MS / 100 + 1 ))); do
  if [[ -s "$RECEIPT_DIR/coord/reconnect-request.json" ]]; then break; fi
  if ! kill -0 "$DRIVER_PID" 2>/dev/null; then
    wait "$DRIVER_PID" || true
    DRIVER_PID=""
    tail -n 100 "$RECEIPT_DIR/logs/driver.log" >&2 || true
    fail "driver exited before proving disconnected topology"
  fi
  sleep 0.1
done
if [[ ! -s "$RECEIPT_DIR/coord/reconnect-request.json" ]]; then
  fail "timed out waiting for disconnected topology proof"
fi
if ! container_running "$AGGREGATE_A_CONTAINER"; then fail "aggregate A exited while isolated"; fi

RECONNECTED_AT=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
docker network connect "$NETWORK_NAME" "$AGGREGATE_A_CONTAINER"
for attempt in $(seq 1 100); do
  if docker inspect --format '{{json .NetworkSettings.Networks}}' "$AGGREGATE_A_CONTAINER" \
    | jq -e --arg network "$NETWORK_NAME" 'has($network)' >/dev/null; then break; fi
  if (( attempt == 100 )); then fail "aggregate A did not rejoin the Docker network"; fi
  sleep 0.05
done
AGGREGATE_A_RECONNECTED_CONTAINER_ID=$(docker inspect --format '{{.Id}}' "$AGGREGATE_A_CONTAINER")
if [[ "$AGGREGATE_A_RECONNECTED_CONTAINER_ID" != "$AGGREGATE_A_CONTAINER_ID" ]]; then
  fail "aggregate A reconnect used another container identity"
fi
if ! container_running "$AGGREGATE_A_CONTAINER"; then
  fail "aggregate A stopped during its network reconnect"
fi
jq -n \
  --arg hostName "$HOST_PREFIX-aggregate-a" \
  --arg containerName "$AGGREGATE_A_CONTAINER" \
  --arg containerId "$AGGREGATE_A_CONTAINER_ID" \
  --arg reconnectedContainerId "$AGGREGATE_A_RECONNECTED_CONTAINER_ID" \
  --arg disconnectedAt "$DISCONNECTED_AT" \
  --arg reconnectedAt "$RECONNECTED_AT" '
    {
      hostName: $hostName,
      containerName: $containerName,
      containerId: $containerId,
      reconnectedContainerId: $reconnectedContainerId,
      disconnectedAt: $disconnectedAt,
      reconnectedAt: $reconnectedAt,
      sameContainer: true,
      containerStayedRunning: true,
      absentDuringDisconnect: true,
      presentAfterReconnect: true
    }
  ' >"$RECEIPT_DIR/coord/reconnect-complete.json"

if ! wait "$DRIVER_PID"; then
  DRIVER_PID=""
  tail -n 120 "$RECEIPT_DIR/logs/driver.log" >&2 || true
  fail "nested acceptance driver failed"
fi
DRIVER_PID=""
touch "$RECEIPT_DIR/coord/stop-resource-sampling"
if [[ -n "$RESOURCE_PID" ]]; then wait "$RESOURCE_PID" || true; fi
RESOURCE_PID=""
rm "$RECEIPT_DIR/coord/stop-resource-sampling"

assert_json "driver summary did not pass" '
  .passed == true and
  .topology.hosts == 4 and
  .topology.maximumDepth == 2 and
  .topology.workers == 10 and
  .topology.totalSessions == 100 and
  .topology.observerGateways == 2 and
  .commands.spawnSucceeded == 100 and
  .commands.sendSucceeded == 100 and
  .commands.settingsSucceeded == 3 and
  .commands.interruptSucceeded == true and
  .commands.postReconnectSendSucceeded == true and
  .streaming.initialTurnsCompleted == 100 and
  .streaming.nativeGaps == 0 and
  .streaming.duplicateEventKeys == 0 and
  .streaming.exactTranscripts == 100 and
  .streaming.peakConcurrentTurns >= 80 and
  .metadata.leafWriteInitiallyQueued == true and
  .metadata.leafWriteAcceptedAtRoot == true and
  .nativeHistory.beforeDisconnectMatchesLeafExactly == true and
  .nativeHistory.afterReconnectMatchesLeafExactly == true and
  .nativeHistory.payloadPreservedExactlyAcrossHostLinks == true and
  .reconnect.attachmentRetained == true and
  .reconnect.noReparentOrPromotion == true and
  .observers.finalParity == true and
  .stability.everySampleExact == true and
  .stability.allHostsOnline == true and
  .stability.allWorkersOnlineAndReachable == true and
  .stability.allSessionsActiveAndIdle == true
' "$RECEIPT_DIR/driver-summary.json"

note "capturing the complete tree from observer gateway 2 with Playwright"
if ! timeout 120s env \
  AGENT_MULTIPLEX_PLAYWRIGHT_MODULE="$PLAYWRIGHT_MODULE" \
  AGENT_MULTIPLEX_CHROME_EXECUTABLE="$CHROME_EXECUTABLE" \
  node "$SCRIPT_DIR/capture.mjs" \
  "$GATEWAY_TWO_BASE_URL/" \
  "$RECEIPT_DIR/screenshots/nested-100-agents.png" \
  "$RECEIPT_DIR/logs/browser-console.txt" \
  "$HOST_PREFIX" "$WORKER_PREFIX" "$RUN_ID" \
  "$HOST_COUNT" "$WORKER_COUNT" "$TOTAL_SESSIONS" \
  >"$RECEIPT_DIR/rpc/playwright-dashboard.json" \
  2>"$RECEIPT_DIR/logs/playwright.log"; then
  fail "Playwright dashboard capture failed"
fi
assert_json "gateway dashboard did not render the nested fleet" '
  .assertions.exactHostCards == true and
  .assertions.everyHostOnline == true and
  .assertions.exactWorkerCards == true and
  .assertions.everyWorkerOnlineAndReachable == true and
  .assertions.exactSessionCards == true and
  .assertions.everySessionActiveAndIdle == true and
  .assertions.globalStatusConnected == true and
  .assertions.selectedSessionStreamLive == true and
  .assertions.browserConsoleErrors == 0 and
  .visible.hostCardCount == 4 and
  .visible.onlineHostCardCount == 4 and
  .visible.workerCardCount == 10 and
  .visible.onlineReachableWorkerCardCount == 10 and
  .visible.sessionCardCount == 100 and
  .visible.activeIdleSessionCardCount == 100
' "$RECEIPT_DIR/rpc/playwright-dashboard.json"
if [[ ! -s "$RECEIPT_DIR/screenshots/nested-100-agents.png" ]]; then
  fail "Playwright did not write the nested dashboard screenshot"
fi

if [[ $(docker network inspect --format '{{len .Containers}}' "$NETWORK_NAME") != "$TOTAL_CONTAINERS" ]]; then
  fail "nested network does not contain exactly $TOTAL_CONTAINERS containers"
fi
for container in "${ALL_CONTAINERS[@]}"; do
  if ! container_running "$container"; then fail "$container is not running"; fi
done
for container in "${WORKER_CONTAINERS[@]}"; do
  if [[ -n $(docker port "$container" 2>/dev/null) ]]; then
    fail "$container unexpectedly publishes a host port"
  fi
done

docker inspect --format \
  '{"name":"{{.Name}}","id":"{{.Id}}","image":"{{.Image}}","running":{{.State.Running}},"oomKilled":{{.State.OOMKilled}},"exitCode":{{.State.ExitCode}},"restartCount":{{.RestartCount}},"startedAt":"{{.State.StartedAt}}"}' \
  "${ALL_CONTAINERS[@]}" | jq -s 'map(.name |= ltrimstr("/"))' \
  >"$RECEIPT_DIR/container-lifecycle.json"
assert_json "an application container failed its lifecycle check" '
  length == 16 and
  (map(.id) | unique | length) == 16 and
  all(.[];
    .image == $image and
    .running == true and
    .oomKilled == false and
    .exitCode == 0 and
    .restartCount == 0)
' "$RECEIPT_DIR/container-lifecycle.json" --arg image "$IMAGE_ID"

jq -s '
  def percent: sub("%$"; "") | tonumber;
  {
    sampleRows: length,
    sampleTimes: (map(.sampledAt) | unique | length),
    containers: (
      sort_by(.Name) | group_by(.Name) | map({
        name: .[0].Name,
        sampleCount: length,
        cpuPercent: {
          max: (map(.CPUPerc | percent) | max),
          average: ((map(.CPUPerc | percent) | add) / length)
        },
        memoryPercent: {
          max: (map(.MemPerc | percent) | max),
          average: ((map(.MemPerc | percent) | add) / length)
        },
        pids: {
          max: (map(.PIDs | tonumber) | max),
          average: ((map(.PIDs | tonumber) | add) / length)
        },
        final: {
          cpu: .[-1].CPUPerc,
          memory: .[-1].MemUsage,
          memoryPercent: .[-1].MemPerc,
          networkIo: .[-1].NetIO,
          blockIo: .[-1].BlockIO,
          pids: .[-1].PIDs
        }
      })
    )
  }
' "$RECEIPT_DIR/logs/docker-stats.ndjson" >"$RECEIPT_DIR/resource-summary.json"
assert_json "resource sampling did not cover every application container" '
  .sampleTimes >= 2 and
  (.containers | length) == 16 and
  all(.containers[]; .sampleCount >= 2 and .pids.max >= 1)
' "$RECEIPT_DIR/resource-summary.json"

GATEWAY_ONE_ENDPOINT=$(docker logs "$GATEWAY_ONE_CONTAINER" 2>&1 | sed -n 's/^Observer endpoint:[[:space:]]*//p' | tail -n 1)
GATEWAY_TWO_ENDPOINT=$(docker logs "$GATEWAY_TWO_CONTAINER" 2>&1 | sed -n 's/^Observer endpoint:[[:space:]]*//p' | tail -n 1)
if [[ ! "$GATEWAY_ONE_ENDPOINT" =~ ^[a-z2-7]{52}$ ]] || \
   [[ ! "$GATEWAY_TWO_ENDPOINT" =~ ^[a-z2-7]{52}$ ]] || \
   [[ "$GATEWAY_ONE_ENDPOINT" == "$GATEWAY_TWO_ENDPOINT" ]]; then
  fail "gateways did not expose distinct observer endpoint identities"
fi

jq -n \
  --slurpfile initial "$RECEIPT_DIR/rpc/hosts-initial.json" \
  --slurpfile disconnected "$RECEIPT_DIR/phases/disconnected-root-view.json" \
  --slurpfile reconnected "$RECEIPT_DIR/phases/reconnected-root-view.json" \
  --arg network "$NETWORK_NAME" \
  --arg image "$IMAGE_ID" \
  --arg rootEndpoint "$ROOT_ENDPOINT" \
  --arg gatewayOneEndpoint "$GATEWAY_ONE_ENDPOINT" \
  --arg gatewayTwoEndpoint "$GATEWAY_TWO_ENDPOINT" '
    {
      applicationContainerCount: 16,
      hostContainerCount: 4,
      workerContainerCount: 10,
      gatewayContainerCount: 2,
      sessionsPerWorker: 10,
      totalMockSessions: 100,
      sharedImageId: $image,
      network: {
        name: $network,
        driver: "bridge",
        dedicatedBridge: true,
        externalEgressPrevented: false
      },
      tree: {
        rootHostId: $initial[0].rootHostId,
        authorityHostId: $initial[0].authorityHostId,
        edges: $initial[0].edges,
        maximumDepth: 2,
        aggregateAOwnsWorkersAndChildHost: true
      },
      disconnect: $disconnected[0].assertions,
      reconnect: $reconnected[0].assertions,
      transport: {
        protocol: "p2prpc over Iroh",
        multiplexProtocolVersion: 2,
        rootEndpointId: $rootEndpoint,
        ticketsRecorded: false
      },
      observers: [
        { endpointId: $gatewayOneEndpoint, role: "standalone HTTP/WebSocket gateway" },
        { endpointId: $gatewayTwoEndpoint, role: "standalone gateway + Playwright target" }
      ],
      realAgentProcesses: 0,
      realInferenceRequests: 0,
      browserRunsOnDockerHost: true,
      physicalMachines: 1,
      crossMachineTransportTested: false
    }
' >"$RECEIPT_DIR/topology.json"

capture_logs
NODE_VERSION=$(docker exec "$ROOT_CONTAINER" node --version | tr -d '\r\n')
DOCKER_VERSION=$(docker version --format '{{.Server.Version}}')
P2PRPC_REVISION=$(git -C "$P2PRPC_CORE" rev-parse HEAD 2>/dev/null || printf 'unavailable')
SOURCE_DIGEST_AFTER=$(hash_source_tree)
P2PRPC_CONTEXT_DIGEST_AFTER=$(hash_p2prpc_context)
if [[ "$SOURCE_DIGEST_AFTER" != "$SOURCE_DIGEST_BEFORE" ]]; then
  fail "repository source changed after the acceptance image was built"
fi
if [[ "$P2PRPC_CONTEXT_DIGEST_AFTER" != "$P2PRPC_CONTEXT_DIGEST_BEFORE" ]]; then
  fail "p2prpc build context changed after the acceptance image was built"
fi

jq -n \
  --slurpfile driver "$RECEIPT_DIR/driver-summary.json" \
  --slurpfile topology "$RECEIPT_DIR/topology.json" \
  --slurpfile lifecycle "$RECEIPT_DIR/container-lifecycle.json" \
  --slurpfile resources "$RECEIPT_DIR/resource-summary.json" \
  --slurpfile dashboard "$RECEIPT_DIR/rpc/playwright-dashboard.json" \
  --slurpfile leafMetadata "$RECEIPT_DIR/rpc/metadata-leaf-outbox.json" '
    {
      topology: {
        exactFourHostTree: ($topology[0].hostContainerCount == 4 and ($topology[0].tree.edges | length) == 3),
        exactTenWorkersAndHundredSessions: ($topology[0].workerContainerCount == 10 and $topology[0].totalMockSessions == 100),
        mixedDirectAndChildOwnership: ($topology[0].tree.aggregateAOwnsWorkersAndChildHost == true),
        twoIndependentObservers: (
          ($topology[0].observers | length) == 2 and
          ($topology[0].observers | map(.endpointId) | unique | length) == 2
        )
      },
      routing: {
        rootToLeafSpawnAndSend: ($driver[0].commands.spawnSucceeded == 100 and $driver[0].commands.sendSucceeded == 100),
        rootToLeafSettingsAndInterrupt: ($driver[0].commands.settingsSucceeded == 3 and $driver[0].commands.interruptSucceeded == true),
        rootToLeafNativeHistoryBeforeAndAfterReconnect: (
          $driver[0].nativeHistory.beforeDisconnectRoutedToLeaf == true and
          $driver[0].nativeHistory.afterReconnectRoutedToLeaf == true and
          $driver[0].nativeHistory.beforeDisconnectMatchesLeafExactly == true and
          $driver[0].nativeHistory.afterReconnectMatchesLeafExactly == true and
          $driver[0].nativeHistory.payloadPreservedExactlyAcrossHostLinks == true
        ),
        postReconnectControlAndStream: (
          $driver[0].commands.postReconnectSendSucceeded == true and
          $driver[0].streaming.postReconnectStreamObserved == true
        )
      },
      streaming: {
        turns: $driver[0].streaming.initialTurnsCompleted,
        nativeGaps: $driver[0].streaming.nativeGaps,
        duplicateEventKeys: $driver[0].streaming.duplicateEventKeys,
        exactTranscripts: $driver[0].streaming.exactTranscripts,
        peakConcurrentTurns: $driver[0].streaming.peakConcurrentTurns
      },
      metadata: {
        rootWriteReplicatedDownstream: $driver[0].metadata.rootWriteReplicatedToLeaf,
        leafWriteInitiallyDurableAndQueued: $leafMetadata[0].assertions.initiallyDurableAndQueued,
        leafWriteAcceptedAtRoot: $leafMetadata[0].assertions.rootAuthorityAccepted,
        terminalReceiptReplicatedDownstream: $leafMetadata[0].assertions.terminalReceiptReplicatedDownstream
      },
      reconnect: {
        reachabilityOnly: $topology[0].disconnect.immediateChildNotOnline,
        cachedSessionsRetained: $topology[0].disconnect.cachedSessionsRetained,
        attachmentsAndLineageRetained: (
          $topology[0].reconnect.exactAttachmentsRetained and
          $topology[0].reconnect.exactLineagesRetained
        ),
        idsRetained: $topology[0].reconnect.exactLogicalAndNativeIdsRetained,
        noReparentOrPromotion: $topology[0].disconnect.noPromotionOrReparenting,
        routingRestored: $topology[0].reconnect.routingRestoredWithoutReparenting
      },
      observers: {
        finalExactParity: $driver[0].observers.finalParity,
        dashboardHosts: $dashboard[0].visible.hostCardCount,
        dashboardWorkers: $dashboard[0].visible.workerCardCount,
        dashboardSessions: $dashboard[0].visible.sessionCardCount,
        browserConsoleErrors: $dashboard[0].assertions.browserConsoleErrors,
        dashboardConnected: $dashboard[0].assertions.globalStatusConnected,
        dashboardStreamLive: $dashboard[0].assertions.selectedSessionStreamLive
      },
      runtime: {
        applicationContainers: ($lifecycle[0] | length),
        noRestarts: ($lifecycle[0] | all(.[]; .restartCount == 0)),
        noOomKills: ($lifecycle[0] | all(.[]; .oomKilled == false)),
        resourceSampleRows: $resources[0].sampleRows,
        resourceSampleTimes: $resources[0].sampleTimes,
        everySoakSampleExact: $driver[0].stability.everySampleExact
      },
      limitations: {
        mockWorkloadOnly: true,
        realAppServerProcessCostMeasured: false,
        realInferenceLatencyMeasured: false
      }
    } as $body |
    {
      readyForCleanup: (
        ($body.topology | all(.[]; . == true)) and
        ($body.routing | all(.[]; . == true)) and
        $body.streaming.turns == 100 and
        $body.streaming.nativeGaps == 0 and
        $body.streaming.duplicateEventKeys == 0 and
        $body.streaming.exactTranscripts == 100 and
        $body.streaming.peakConcurrentTurns >= 80 and
        ($body.metadata | all(.[]; . == true)) and
        ($body.reconnect | all(.[]; . == true)) and
        $body.observers.finalExactParity == true and
        $body.observers.dashboardHosts == 4 and
        $body.observers.dashboardWorkers == 10 and
        $body.observers.dashboardSessions == 100 and
        $body.observers.browserConsoleErrors == 0 and
        $body.observers.dashboardConnected == true and
        $body.observers.dashboardStreamLive == true and
        $body.runtime.applicationContainers == 16 and
        $body.runtime.noRestarts == true and
        $body.runtime.noOomKills == true and
        $body.runtime.resourceSampleTimes >= 2 and
        $body.runtime.everySoakSampleExact == true
      )
    } + $body
' >"$RECEIPT_DIR/pre-cleanup-checks.json"
assert_json "derived nested-host pre-cleanup checks did not pass" \
  '.readyForCleanup == true' "$RECEIPT_DIR/pre-cleanup-checks.json"

note "removing the exact nested acceptance containers and network"
remove_test_topology
REMOVED_CONTAINERS=true
REMAINING_CONTAINER_NAMES=$(docker ps --all --format '{{.Names}}')
for container in "${ALL_CONTAINERS[@]}"; do
  if rg --fixed-strings --line-regexp --quiet "$container" <<<"$REMAINING_CONTAINER_NAMES"; then
    REMOVED_CONTAINERS=false
  fi
done
NETWORK_REMOVED=true
REMAINING_NETWORK_NAMES=$(docker network ls --format '{{.Name}}')
if rg --fixed-strings --line-regexp --quiet "$NETWORK_NAME" <<<"$REMAINING_NETWORK_NAMES"; then
  NETWORK_REMOVED=false
fi
IMAGE_RETAINED_BY_REQUEST=false
IMAGE_DISPOSITION_OK=false
REMAINING_IMAGE_TAGS=$(docker image ls --format '{{.Repository}}:{{.Tag}}')
IMAGE_TAG_PRESENT=false
if rg --fixed-strings --line-regexp --quiet "$IMAGE_TAG" <<<"$REMAINING_IMAGE_TAGS"; then
  IMAGE_TAG_PRESENT=true
fi
if [[ "$KEEP_IMAGE" == 1 ]]; then
  IMAGE_RETAINED_BY_REQUEST=true
  if [[ "$IMAGE_TAG_PRESENT" == true ]]; then IMAGE_DISPOSITION_OK=true; fi
else
  if [[ "$IMAGE_TAG_PRESENT" == false ]]; then
    IMAGE_REMOVED=1
    IMAGE_DISPOSITION_OK=true
  fi
fi
jq -n \
  --argjson containersRemoved "$REMOVED_CONTAINERS" \
  --argjson networkRemoved "$NETWORK_REMOVED" \
  --argjson imageRemoved "$IMAGE_REMOVED" \
  --argjson imageRetainedByRequest "$IMAGE_RETAINED_BY_REQUEST" \
  --argjson imageDispositionOk "$IMAGE_DISPOSITION_OK" \
  --arg containerTargetPrefix "$CONTAINER_PREFIX" \
  --arg imageTarget "$IMAGE_TAG" \
  --arg networkTarget "$NETWORK_NAME" '
    {
      cleanupCompleted: ($containersRemoved and $networkRemoved and $imageDispositionOk),
      exactContainerTargetsRemoved: $containersRemoved,
      dedicatedNetworkRemoved: $networkRemoved,
      temporaryImageRemoved: $imageRemoved,
      imageRetainedByExplicitRequest: $imageRetainedByRequest,
      imageDispositionVerified: $imageDispositionOk,
      containerTargetPrefix: $containerTargetPrefix,
      imageTarget: $imageTarget,
      networkTarget: $networkTarget,
      recoverable: false,
      materialUserDataRemoved: false
    }
' >"$RECEIPT_DIR/cleanup.json"
assert_json "nested topology cleanup was incomplete" '.cleanupCompleted == true' "$RECEIPT_DIR/cleanup.json"

jq -n \
  --slurpfile pre "$RECEIPT_DIR/pre-cleanup-checks.json" \
  --slurpfile cleanup "$RECEIPT_DIR/cleanup.json" '
    {
      passed: (
        $pre[0].readyForCleanup == true and
        $cleanup[0].cleanupCompleted == true
      ),
      cleanup: $cleanup[0]
    } + ($pre[0] | del(.readyForCleanup))
' >"$RECEIPT_DIR/checks.json"
assert_json "final nested-host checks did not pass" '.passed == true' "$RECEIPT_DIR/checks.json"
rm "$RECEIPT_DIR/pre-cleanup-checks.json"

RUN_COMPLETED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n \
  --arg runId "$RUN_ID" \
  --arg startedAt "$RUN_STARTED_AT" \
  --arg completedAt "$RUN_COMPLETED_AT" \
  --arg docker "$DOCKER_VERSION" \
  --arg node "$NODE_VERSION" \
  --arg image "$IMAGE_ID" \
  --arg sourceDigest "$SOURCE_DIGEST_BEFORE" \
  --arg agentContextDigest "$AGENT_DOCKER_CONTEXT_DIGEST" \
  --arg p2prpcContextDigest "$P2PRPC_CONTEXT_DIGEST_BEFORE" \
  --arg p2prpcRevision "$P2PRPC_REVISION" \
  --argjson chunks "$CHUNK_COUNT" \
  --argjson intervalMs "$CHUNK_INTERVAL_MS" \
  --argjson soakMs "$SOAK_MS" '
    {
      runId: $runId,
      status: "passed",
      workloadType: "deterministic nested-host capacity/integration acceptance",
      startedAt: $startedAt,
      completedAt: $completedAt,
      versions: {
        dockerServer: $docker,
        nodeInImage: $node,
        multiplexProtocol: 2,
        p2prpcRevision: $p2prpcRevision
      },
      topology: {
        hostContainers: 4,
        workerContainers: 10,
        observerGatewayContainers: 2,
        sessionsPerWorker: 10,
        sessionsTotal: 100,
        maximumHostDepth: 2,
        physicalMachines: 1,
        crossMachineTransportTested: false
      },
      network: {
        dedicatedDockerBridge: true,
        externalEgressPrevented: false
      },
      streamConfiguration: { chunksPerSession: $chunks, chunkIntervalMs: $intervalMs },
      soakMs: $soakMs,
      imageId: $image,
      sourceTreeSha256: $sourceDigest,
      sourceHashScope: "workspace build inputs plus nested acceptance harness",
      agentDockerBuildContextSha256: $agentContextDigest,
      p2prpcBuildContextSha256: $p2prpcContextDigest,
      sourceAndTransportContextsStableForRun: true,
      realAgentProcesses: 0,
      realInferenceRequests: 0,
      credentialMaterialRecorded: false
    }
' >"$RECEIPT_DIR/manifest.json"

{
  printf '# Nested-host Docker acceptance receipt\n\n'
  printf 'Status: **PASS**\n\n'
  printf 'Run: `%s`\n\n' "$RUN_ID"
  printf 'This run used 16 application containers on one physical Docker host: four hosts in a two-level tree, ten mock-agent workers, and two p2prpc observer gateways. The root observed exactly 100 sessions. It did not test cross-machine links, start a real agent, or make an inference request.\n\n'
  printf '## What passed\n\n'
  printf -- '- The root materialized root → aggregate A → leaf A1 plus sibling aggregate B; aggregate A simultaneously owned direct workers and a child host.\n'
  printf -- '- Gateway 1 drove 100 spawns and sends. All native transcripts were exact, with zero gaps and zero duplicate event keys.\n'
  printf -- '- Model lookup, settings, interruption, command recovery, exact preservation of native history, and post-reconnect streaming reached a session two host links below root.\n'
  printf -- '- A root metadata write replicated down; a leaf write was durable/queued before root acceptance and downstream terminal convergence.\n'
  printf -- '- Aggregate A left the dedicated Docker bridge. Root retained parentage, attachment, lineage, logical/native IDs, and cached sessions while the branch was unreachable. The same container rejoined without reparenting or promotion. The bridge did not prevent external egress.\n'
  printf -- '- Two observer endpoints produced exact fleet parity. Gateway 2 rendered four hosts, ten workers, and 100 sessions with exact statuses in Playwright without console errors.\n'
  printf -- '- No container restarted or was OOM-killed; resources were sampled throughout, and temporary resources were removed or explicitly retained according to the run configuration.\n\n'
  printf '## Evidence map\n\n'
  printf -- '- `checks.json`, `manifest.json`, `topology.json`, and `cleanup.json`\n'
  printf -- '- `rpc/hosts-initial.json`, `phases/disconnected-root-view.json`, and `phases/reconnected-root-view.json`\n'
  printf -- '- `driver-summary.json`, `phases/stream-assertions.json`, and `logs/fleet-events.ndjson`\n'
  printf -- '- `rpc/native-history-before-interrupt.json` and `rpc/native-history-after-reconnect.json`\n'
  printf -- '- `rpc/metadata-root-write.json` and `rpc/metadata-leaf-outbox.json`\n'
  printf -- '- `rpc/observer-parity-initial.json`, `rpc/observer-parity-final.json`, and `rpc/playwright-dashboard.json`\n'
  printf -- '- `screenshots/nested-100-agents.png`, sanitized `logs/`, resource samples, and lifecycle records\n\n'
  printf 'This deterministic receipt does not estimate the cost of 100 real Codex/Copilot app servers or prove behavior across multiple physical machines.\n'
} >"$RECEIPT_DIR/README.md"

assert_receipt_has_no_locators "$RECEIPT_DIR"
(
  cd "$RECEIPT_DIR"
  find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS
  sha256sum --check SHA256SUMS >/dev/null
)
COMPLETED=1
