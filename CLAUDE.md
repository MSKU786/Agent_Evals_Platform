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
Model provider: configurable per AgentConfig — Gemini or OpenRouter. The runner
selects the key by provider (gemini→GEMINI_API_KEY, openrouter→OPENROUTER_API_KEY).
Default is OpenRouter for now because the Gemini free-tier quota is exhausted
under agent load; switching the whole experiment back is a one-line config/env
change, not a code edit. Keys live in .env (never committed).
