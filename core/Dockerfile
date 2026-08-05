# Build context is the repo root (see infra/docker-compose.yml's `context: ..`), not just
# `/core` — this stage needs `/frontend` too, to build the real static assets core itself serves
# (Frontend Phase 10, docs/frontend-deploy.md: folded into core's own Fastify instance rather than
# a separate static-file container, so CORS drops out of the production path entirely — same
# origin, by construction).
FROM node:20-alpine AS frontend-build
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
# Real runtime values come from core's own /runtime-config.js at request time, not from these —
# Vite's own build-time check (src/config.ts) just needs *something* non-empty set to complete a
# `vite build`, and using an obviously-fake value here (instead of a plausible-looking one) means
# any bug in the runtime-config wiring fails loudly and visibly rather than silently masking
# itself behind a value that happens to look reasonable.
ENV VITE_CORE_API_URL=http://build-time-value-should-never-be-used.invalid
ENV VITE_CORE_WS_URL=ws://build-time-value-should-never-be-used.invalid
RUN npm run build

FROM node:20-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY core/package*.json ./
RUN npm install

COPY core/tsconfig.json ./
COPY core/src ./src
RUN npm run build

# The exact path config.ts's frontendDistPath defaults to (`path.join(__dirname, "../public")`,
# i.e. a sibling of dist/) — no FRONTEND_DIST_PATH env var needed for this, the normal, real
# deployment layout.
COPY --from=frontend-build /frontend/dist ./public

COPY core/migrations ./migrations
COPY core/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=5 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["./docker-entrypoint.sh"]
