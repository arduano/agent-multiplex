# syntax=docker/dockerfile:1.7

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df

ENV NODE_ENV=production
WORKDIR /opt/src/agent-multiplex

# ../p2prpc is the v1 transport source of record. Copy only the package surface
# consumed by this workspace; source/test trees, node_modules, and untracked
# configuration from the sibling repository never enter the image.
COPY --from=p2prpc-core /package.json /opt/src/p2prpc/packages/core/package.json
COPY --from=p2prpc-core /dist/ /opt/src/p2prpc/packages/core/dist/
COPY --from=p2prpc-core /LICENSE /opt/src/p2prpc/packages/core/LICENSE
COPY --from=p2prpc-core /README.md /opt/src/p2prpc/packages/core/README.md
COPY --from=p2prpc-core /SECURITY.md /opt/src/p2prpc/packages/core/SECURITY.md
COPY --from=p2prpc-core /THIRD_PARTY_NOTICES.md /opt/src/p2prpc/packages/core/THIRD_PARTY_NOTICES.md

# The acceptance image needs workspace manifests and sources only. Root tests,
# receipts, local environment files, and unrelated repository material stay on
# the Docker host.
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/

# Composite build state must never let a context with ignored dist/ files look
# current. Force emission and fail the image build if a runtime is absent. The
# harness uses umask 077, so normalize immutable runtime-code permissions after
# npm has touched the workspace while private state remains 0700.
RUN npm install \
      --prefix /opt/src/p2prpc/packages/core \
      --omit=dev \
      --no-package-lock \
    && npm ci --include=dev \
    && npm run build -- --force \
    && npm prune --omit=dev \
    && test -f apps/host/dist/main.js \
    && test -f apps/runtime-node/dist/main.js \
    && test -f apps/gateway/dist/main.js \
    && chmod -R a+rX /opt/src/agent-multiplex /opt/src/p2prpc \
    && mkdir -p /state /workspace \
    && chown -R 1000:100 /state /workspace

LABEL org.opencontainers.image.title="Agent Multiplex nested-host acceptance"
LABEL org.opencontainers.image.description="Four-host tree, ten mock workers, two p2prpc observer gateways"
