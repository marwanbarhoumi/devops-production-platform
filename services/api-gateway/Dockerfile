# syntax=docker/dockerfile:1
# Build context: repository root (needed for the npm workspace lockfile).
#   docker build -f services/api-gateway/Dockerfile -t devops-production-platform/api-gateway:local .

ARG NODE_IMAGE=node:24.16-alpine3.22

# ---- build: install all dependencies and compile TypeScript -----------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/api-gateway/package.json services/api-gateway/
COPY services/product-service/package.json services/product-service/
COPY services/order-service/package.json services/order-service/
RUN npm ci --workspace services/api-gateway --no-audit --no-fund
COPY tsconfig.base.json ./
COPY services/api-gateway/ services/api-gateway/
RUN npm run build --workspace services/api-gateway

# ---- runtime: production dependencies + compiled output only ----------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/api-gateway/package.json services/api-gateway/
COPY services/product-service/package.json services/product-service/
COPY services/order-service/package.json services/order-service/
RUN npm ci --workspace services/api-gateway --omit=dev --no-audit --no-fund \
    && npm cache clean --force
COPY --from=build /app/services/api-gateway/dist services/api-gateway/dist

WORKDIR /app/services/api-gateway
USER node
EXPOSE 7000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/server.js"]
