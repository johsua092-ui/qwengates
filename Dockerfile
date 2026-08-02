# ── Build stage ─────────────────────────────────────────────────────
FROM oven/bun:alpine AS build
WORKDIR /app
COPY package.json bun.lock* package-lock.json* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install
COPY . .
RUN bun run build
# Copy .mjs worker files (not compiled by tsc) into dist/
RUN mkdir -p dist/worker && cp src/worker/*.mjs dist/worker/ 2>/dev/null || true

# ── Production stage ────────────────────────────────────────────────
FROM oven/bun:alpine AS production
WORKDIR /app

# Install system deps for Playwright/Chromium + Node.js for wreq worker
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    glib \
    font-noto-cjk \
    dbus \
    ttf-freefont \
    nodejs \
    npm \
    && rm -rf /var/cache/apk/*

# Copy built artifacts
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Non-root user for security
RUN addgroup -g 1001 -S qwen && \
    adduser -S qwen -u 1001 -G qwen && \
    mkdir -p /app/.qwen /app/logs /data && \
    chown -R qwen:qwen /app /data
USER qwen

# Railway sets PORT env var automatically; default to 26405 for standalone Docker
ENV PORT=26405
ENV HOST=0.0.0.0
ENV NODE_ENV=production
# Persistent config on Railway volume mounts
ENV CONFIG_PATH=/data/config.json
EXPOSE ${PORT}
VOLUME [ "/app/.qwen", "/data" ]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/ping || exit 1

CMD [ "bun", "dist/index.js" ]
