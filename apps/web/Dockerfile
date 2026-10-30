# Build context is the repo root (see docker-compose.yml).
# Serves the Vue app via the Vite dev server so `docker compose up` brings up the
# whole stack with no separate build step. The browser (on the host) calls the
# API at VITE_API_BASE, which compose publishes on localhost:3000.
FROM node:22-slim

RUN corepack enable
WORKDIR /app

# Install deps first (better layer caching) from the workspace manifests.
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install

# Source (shared provides the types the UI imports).
COPY packages/shared packages/shared
COPY apps/web apps/web

EXPOSE 5173
CMD ["pnpm", "--filter", "@agent-evals/web", "dev", "--", "--host", "0.0.0.0", "--port", "5173"]
