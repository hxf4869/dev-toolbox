FROM node:24.20.0-alpine3.23 AS build

RUN corepack enable
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches patches
COPY apps/ai-worker/package.json apps/ai-worker/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @dev-toolbox/ai-worker...
COPY apps/ai-worker apps/ai-worker
RUN pnpm --filter @dev-toolbox/ai-worker build \
    && pnpm deploy --legacy --filter @dev-toolbox/ai-worker --prod /out

FROM node:24.20.0-alpine3.23

ARG APP_VERSION=development
LABEL org.opencontainers.image.title="dev-toolbox-ai-worker" \
      org.opencontainers.image.version=$APP_VERSION

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --chown=node:node docs/contracts /app/contracts
COPY --chown=node:node apps/ai-worker/prompts /app/prompts
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
