FROM oven/bun:1-debian

# Bun runtime (per Railway Bun service pattern, same as tech-news-bot):
# the Hono app + ESM sources run unmodified under Bun — no node-specific APIs.
WORKDIR /app

COPY package.json package-lock.json* ./
RUN bun install --production --no-save || bun install --production

COPY src ./src

# NOTE: no Docker VOLUME directive — Railway's Metal builder rejects it.
# The /data volume is attached via the Railway template definition instead.

ENV NODE_ENV=production
EXPOSE 3000

# Railway ignores Dockerfile HEALTHCHECK (it uses its own healthcheck path),
# kept for docker-compose/local parity.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD bun -e "await fetch('http://localhost:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" || exit 1

CMD ["bun", "src/server.js"]