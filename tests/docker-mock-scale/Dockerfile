# syntax=docker/dockerfile:1.7

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build

ENV NODE_ENV=production
WORKDIR /opt/src/agent-multiplex

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.base.json tsconfig.json .npmrc .node-version ./
COPY release-packages.json ./
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
    --mount=type=cache,id=agent-multiplex-deterministic-npm,target=/root/.npm,sharing=locked \
    npm ci --include=dev

COPY scripts/ ./scripts/
COPY packages/ ./packages/
COPY apps/ ./apps/

RUN npm run build -- --force \
    && npm prune --omit=dev \
    && test -f apps/control-node/dist/main.js \
    && test -f apps/runtime-node/dist/main.js \
    && test -f apps/gateway/dist/main.js \
    && chmod -R a+rX /opt/src/agent-multiplex

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

ENV NODE_ENV=production
WORKDIR /opt/src/agent-multiplex

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /opt/src/agent-multiplex/ /opt/src/agent-multiplex/

RUN mkdir -p /state /workspace \
    && chown -R 1000:100 /state /workspace

LABEL org.opencontainers.image.title="Agent Multiplex protocol-v4 mock scale acceptance"
LABEL org.opencontainers.image.description="Control node, authenticated access gateway, and ten mock runtime nodes"
