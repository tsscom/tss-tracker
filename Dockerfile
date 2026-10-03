# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN npm install --global pnpm@11.25.0
COPY package.json pnpm-lock.yaml ./

FROM base AS production-dependencies
RUN pnpm install --prod --frozen-lockfile

FROM base AS test
RUN pnpm install --frozen-lockfile
COPY server.mjs ./
COPY lib ./lib
COPY public ./public
COPY migrations ./migrations
COPY tools ./tools
COPY tests ./tests
COPY documentacao ./documentacao
USER node
CMD ["pnpm", "test"]

FROM base AS production
ENV NODE_ENV=production HOST=0.0.0.0 PORT=10000 ENV_FILE="" DATA_DIR=/var/data ATTACHMENTS_DIR=/var/data/attachments
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY server.mjs ./
COPY lib ./lib
COPY public ./public
COPY migrations ./migrations
COPY tools ./tools
COPY documentacao ./documentacao
COPY --chmod=755 deploy/entrypoint.sh /usr/local/bin/tss-entrypoint
EXPOSE 10000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=6 CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '10000') + '/healthz').then(response => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1))"
ENTRYPOINT ["/usr/local/bin/tss-entrypoint"]
CMD ["node", "server.mjs"]
