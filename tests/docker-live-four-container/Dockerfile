# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS build

ENV NODE_ENV=production
WORKDIR /opt/src/agent-multiplex

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json tsconfig.json .npmrc ./
COPY release-packages.json ./

# Keep the expensive native dependency installation independent from source
# edits. Every workspace manifest is needed for npm's root workspace graph;
# implementation files are copied only after that graph is installed.
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/storage-sqlite/package.json packages/storage-sqlite/package.json
COPY packages/control-node-core/package.json packages/control-node-core/package.json
COPY packages/runtime-node-core/package.json packages/runtime-node-core/package.json
COPY packages/gateway-core/package.json packages/gateway-core/package.json
COPY packages/transport-p2prpc/package.json packages/transport-p2prpc/package.json
COPY packages/client/package.json packages/client/package.json
COPY packages/client-p2prpc/package.json packages/client-p2prpc/package.json
COPY packages/adapter-codex/package.json packages/adapter-codex/package.json
COPY packages/adapter-copilot/package.json packages/adapter-copilot/package.json
COPY packages/adapter-mock/package.json packages/adapter-mock/package.json
COPY apps/control-node/package.json apps/control-node/package.json
COPY apps/runtime-node/package.json apps/runtime-node/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/web/package.json apps/web/package.json

RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=true \
    --mount=type=cache,id=agent-multiplex-live-four-npm,target=/root/.npm,sharing=locked \
    npm ci --include=dev

COPY scripts/ ./scripts/
COPY packages/ ./packages/
COPY apps/ ./apps/

RUN npm run build -- --force \
    && npm prune --omit=dev \
    && test -f apps/control-node/dist/main.js \
    && test -f apps/runtime-node/dist/main.js \
    && test -f apps/gateway/dist/main.js \
    && test -x node_modules/.bin/codex \
    && node -e 'import("@github/copilot-sdk").then(() => undefined)'

# Keep compilers and Python out of the runtime boundary. node-pty is compiled
# above against the same Debian/Node base and only its runtime artefacts cross
# into this stage.
FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /opt/src/agent-multiplex

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/src/agent-multiplex/ /opt/src/agent-multiplex/

# npm and COPY create package/source content with world-readable files and
# executable package bins. Avoid walking the entire dependency tree merely to
# restate those modes; create and own only the runtime-writable paths here.
RUN mkdir -p /home/arduano/.codex /home/arduano/.copilot /state /workspace/project \
    && chown -R 1000:100 /home/arduano /state /workspace

COPY --chmod=0755 tests/docker-live-four-container/codex-runtime-entrypoint.sh \
  /usr/local/bin/agent-multiplex-live-codex-runtime

LABEL org.opencontainers.image.title="Agent Multiplex four-container live acceptance"
LABEL org.opencontainers.image.description="Protocol-v4 authority, gateway UI, Codex runtime, and Copilot BYOK runtime"
