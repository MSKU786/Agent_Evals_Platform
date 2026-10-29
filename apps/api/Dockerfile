# Build context is the repo root (see docker-compose.yml).
FROM node:22-slim

# Prisma needs openssl at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable

WORKDIR /app

# Install deps first (better layer caching) from the workspace manifests.
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install

# Source, then build shared + generate the Prisma client.
COPY packages/shared packages/shared
COPY apps/api apps/api
# The sample suite YAML the seed loads at startup.
COPY suites suites
RUN pnpm --filter @agent-evals/shared build \
    && pnpm --filter @agent-evals/api prisma:generate

EXPOSE 3000
# Overridden to start:worker for the worker service.
CMD ["pnpm", "--filter", "@agent-evals/api", "start:api"]
