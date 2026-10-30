# Agent Evals Platform

A platform for answering one question with evidence: **is agent config B better
than config A, and how sure are we?** It runs a suite of tasks against two (or
more) agent configurations, repeats each task to average out non-determinism,
grades every run, and reports a **verdict** — *Better / Worse / No detectable
difference* — backed by task-level bootstrap confidence intervals and a
permutation p-value. Every run is fully inspectable: the trajectory (messages,
tool calls, outputs), each grader's score and reason, tokens, cost and latency.

It drives the [Hermes Agent](https://hermes-agent.nousresearch.com) as a
one-shot CLI process per trial, each in a throwaway `HERMES_HOME`, so memory and
skills can't leak between runs. A **FakeRunner** replays recorded trajectories so
the whole thing — including the sample experiment — runs with **no API key and
no cost**.

- **What to score, and why**, in priority order: statistical honesty →
  run inspectability → clean Hermes integration → engineering quality → a real
  written-up experiment. See [docs/PLAN.md](docs/PLAN.md).
- **Design & decisions:** [docs/DESIGN.md](docs/DESIGN.md)
- **The real experiment** (verdict, CIs, p-value, per-task table):
  [docs/EXPERIMENT.md](docs/EXPERIMENT.md)
- **Limits & costs:** [docs/LIMITS.md](docs/LIMITS.md) · [docs/COSTS.md](docs/COSTS.md)

## Quick start

Requires Docker (and Docker Compose). No local Node, Postgres or Hermes needed.

```bash
cp .env.example .env      # defaults are fine for demo mode (RUNNER=fake)
docker compose up         # add -d to run detached
```

This starts Postgres, pushes the Prisma schema, seeds the sample suite and two
configs, then starts the API, worker and web UI. When it's up:

- **Web UI:** <http://localhost:5173> — experiments list, report, trial viewer,
  new-experiment form.
- **API:** <http://localhost:3000> — `GET /health` returns `{"status":"ok"}`.

### Demo mode (no key)

`RUNNER=fake` (the default) replays recorded trajectories from
`apps/api/fixtures/recordings/`, so you can create experiments and explore the
full UI without any provider key or cost. The sample experiment in
[docs/EXPERIMENT.md](docs/EXPERIMENT.md) was produced this way. To run against a
live model, set `RUNNER=hermes` and a provider key (`OPENROUTER_API_KEY` or
`GEMINI_API_KEY`) in `.env` — nothing else changes.

## Create an experiment (API)

Experiments are created through the API (the web UI's **New** page does the same).
Pick a suite, one or more configs, a baseline, and the repeats per task:

```bash
# 1. Find the seeded suite and config ids
curl -s localhost:3000/suites  | python -m json.tool   # -> suite id
curl -s localhost:3000/configs | python -m json.tool   # -> flash / flash-lite ids

# 2. Create: 10 tasks x 2 configs x 5 repeats = 100 trials
curl -s -X POST localhost:3000/experiments \
  -H 'content-type: application/json' \
  -d '{
    "suiteId": "<suite id>",
    "configIds": ["<flash-lite id>", "<flash id>"],
    "baselineConfigId": "<flash-lite id>",
    "repeats": 5
  }'
# -> { "id": "<experimentId>", "status": "running", "plannedTrials": 100 }
```

The worker pulls the trials off the pg-boss queue, runs and grades each one.

## View results

- **Web UI:** open `http://localhost:5173/experiments`, click the experiment →
  verdict banner, per-config pass rates + CIs, paired effect + CI + p-value, and
  the per-task breakdown. Click any task score to open that run's trajectory,
  grader reasons, tokens, cost and the rendered `config.yaml`.
- **API:**
  - `GET /experiments` — list with status/suite/created
  - `GET /experiments/:id` — status + progress
  - `GET /experiments/:id/report` — the full ComparisonReport (verdict, CIs, p-value, per-task)
  - `GET /trials?experimentId=&taskId=&configId=&passed=` — filterable trial list
  - `GET /trials/:id` — one trial's trajectory, grades, rendered config
  - `POST /trials/:id/regrade` — re-run graders on the stored trajectory (no agent re-run)

## Development

pnpm monorepo. See [docs/DESIGN.md](docs/DESIGN.md) for the layout.

```bash
pnpm install
pnpm --filter @agent-evals/api test      # stats + graders + runner + e2e (Vitest)
pnpm --filter @agent-evals/web build      # type-check + bundle the UI
```
