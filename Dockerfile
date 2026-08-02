# ── Single-stage, no build — Bun runs TypeScript directly ─────────
FROM oven/bun:alpine
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
    && rm -rf /var/cache/apk/*

# Copy everything
COPY . .

# Install deps
RUN bun install

# Create data dirs and non-root user
RUN mkdir -p /app/.qwen /app/logs /data && \
    addgroup -g 1001 -S qwen 2>/dev/null || true && \
    adduser -S qwen -u 1001 -G qwen 2>/dev/null || true && \
    chown -R qwen:qwen /app /data 2>/dev/null || true
USER qwen

ENV PORT=8080
ENV HOST=0.0.0.0
ENV NODE_ENV=production
ENV CONFIG_PATH=/data/config.json
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:8080/ping || exit 1

CMD ["bun", "src/index.tsx"]
