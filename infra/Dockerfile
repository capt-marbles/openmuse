# API + task worker and the static web UI, built from one workspace install.
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile
# The web client inlines its API origin at build time; UI and API share one origin.
ARG PUBLIC_URL
RUN test -n "$PUBLIC_URL" || (echo "Set PUBLIC_API_URL for the build" && exit 1)
RUN pnpm build:server && EXPO_PUBLIC_API_URL="$PUBLIC_URL" pnpm build:web

FROM node:24-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
CMD ["node", "dist/apps/server/src/index.js"]

FROM caddy:2-alpine AS web
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/apps/mobile/dist/web /srv
