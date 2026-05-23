# syntax=docker/dockerfile:1.7
#
# Multi-stage Dockerfile for the Cloud Run api.
# Stage 1 builds with dev deps; stage 2 ships only prod deps and compiled JS.
#
# Image size goal: < 200 MB. Cold start goal: < 1s on Cloud Run default settings.

# ─── Stage 1: build ──────────────────────────────────────────────────────────
FROM node:20-slim AS build

WORKDIR /repo

# Copy workspace manifests first so npm cache layer is reused when only source
# files change. The `shared` workspace is consumed by source path, so we copy
# its manifest too.
COPY package.json package-lock.json* tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY api/package.json ./api/

# Install ALL workspace deps (dev included) — needed to compile.
# Use --workspaces so npm resolves the internal @cloud-webapp/shared link.
RUN npm ci --workspaces --include-workspace-root

# Now copy the source and build the api.
COPY shared ./shared
COPY api ./api
RUN npm run build -w @cloud-webapp/api

# ─── Stage 2: runtime ────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps" \
    PORT=8080

WORKDIR /app

# Copy only what production needs: api manifests + shared source (TS is fine,
# Node won't import it — the compiled api/dist references it through built
# .js paths). We re-install with --omit=dev to drop tsx/vitest/eslint.
COPY package.json package-lock.json* ./
COPY shared/package.json ./shared/
COPY api/package.json ./api/
COPY --from=build /repo/shared ./shared
COPY --from=build /repo/api/dist ./api/dist

RUN npm ci --workspaces --include-workspace-root --omit=dev \
    && npm cache clean --force

# Cloud Run sends SIGTERM on shutdown; the app handles it.
# Use a non-root user for defense in depth.
RUN useradd --no-create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080
CMD ["node", "api/dist/index.js"]
