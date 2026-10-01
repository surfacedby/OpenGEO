FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --ignore-scripts && npm rebuild better-sqlite3
COPY tsconfig.json vite.config.ts index.html ./
COPY README.md CONTRIBUTING.md SECURITY.md ./
COPY docs ./docs
COPY src ./src
COPY server ./server
COPY public ./public
COPY brand ./brand
COPY scripts/sync-identity.mjs scripts/brand-assets.mjs ./scripts/
RUN npm run build && npm prune --omit=dev && rm -rf node_modules/fastify/docs node_modules/zod/src

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production OPENGEO_CONTAINER=1 OPENGEO_DATA_DIR=/data OPENGEO_SECRET_FILE=/run/secrets/opengeo_secret PLAYWRIGHT_BROWSERS_PATH=/opt/opengeo-browsers
COPY --from=build /app/node_modules ./node_modules
RUN mkdir /data && chown node:node /data && node node_modules/playwright/cli.js install --with-deps chromium
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/assets/Inter-OFL.txt ./assets/Inter-OFL.txt
COPY LICENSE THIRD_PARTY_NOTICES.md ./
USER node
VOLUME /data
EXPOSE 4318
HEALTHCHECK --interval=30s CMD node -e "fetch('http://127.0.0.1:4318/api/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","dist-server/main.js"]
