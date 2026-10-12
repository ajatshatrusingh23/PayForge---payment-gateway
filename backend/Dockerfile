# One image for all nine services; the APP env var picks which one a container runs.
# (Same build, same dependencies: building once is faster and keeps every service on identical versions.)

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx nest build --all

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
ARG APP=gateway
ENV APP=${APP}
CMD ["sh", "-c", "exec node --enable-source-maps --disable-warning=TimeoutNegativeWarning dist/apps/${APP}/main.js"]
