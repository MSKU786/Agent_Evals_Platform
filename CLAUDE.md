# Agent Evals Platform

Read docs/PLAN.md before any work. It is the source of truth.

## Rules

- Work only on the phase I name. Stop when its exit check passes, show me the output, and wait.
- Commit at the end of each phase with a clear message.
- Do not add features or tables beyond the plan. Prefer the simpler option and tell me if you deviate.
- If something in the plan turns out to be wrong (e.g. Hermes behaves differently), stop and tell me before working around it.
- Never commit .env or print secret values.

## Stack

pnpm monorepo · NestJS · Prisma + Postgres · pg-boss · Vue 3 + Vite · TypeScript strict · Jest/Vitest · docker compose
Model provider: Gemini API (GEMINI_API_KEY in .env)
