# Build context is the repository root so the store can serve the built PayForge.js SDK.
FROM node:24-alpine AS sdk
WORKDIR /sdk
COPY sdk/payforge-js/package.json sdk/payforge-js/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY sdk/payforge-js/ ./
RUN npm run build

FROM node:24-alpine
WORKDIR /app/web/demo-store
COPY web/demo-store/package.json web/demo-store/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY web/demo-store/server.mjs ./
COPY web/demo-store/public ./public
COPY --from=sdk /sdk/dist /app/sdk/payforge-js/dist
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]
