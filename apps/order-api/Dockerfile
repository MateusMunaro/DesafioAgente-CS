# syntax=docker/dockerfile:1
# Build context is the repository root (npm workspaces):
#   docker build -f apps/order-api/Dockerfile -t desafio-order-api .

# ---- build: full install, compile contracts + this app ----
FROM node:24-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/order-api/package.json apps/order-api/
RUN npm ci -w @desafio/contracts -w @desafio/order-api --include-workspace-root
COPY packages/contracts packages/contracts
COPY apps/order-api apps/order-api
RUN npm run build -w @desafio/contracts && npm run build -w @desafio/order-api

# ---- prod-deps: production dependencies only ----
FROM node:24-alpine AS prod-deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/order-api/package.json apps/order-api/
RUN npm ci --omit=dev -w @desafio/contracts -w @desafio/order-api

# ---- runtime ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=prod-deps /repo/node_modules node_modules
COPY --from=prod-deps /repo/package.json package.json
COPY --from=build /repo/packages/contracts/package.json packages/contracts/package.json
COPY --from=build /repo/packages/contracts/dist packages/contracts/dist
COPY --from=build /repo/apps/order-api/package.json apps/order-api/package.json
COPY --from=build /repo/apps/order-api/dist apps/order-api/dist
COPY --from=build /repo/apps/order-api/migrations apps/order-api/migrations
COPY --from=build /repo/apps/order-api/seed.sql apps/order-api/seed.sql
COPY --from=build /repo/apps/order-api/openapi.yaml apps/order-api/openapi.yaml
USER node
WORKDIR /repo/apps/order-api
EXPOSE 3001
CMD ["node", "dist/index.js"]
