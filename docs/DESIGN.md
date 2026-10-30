# Design

How the Agent Evals platform is built and why. This assembles the decisions from
[PLAN.md](PLAN.md) and the Phase 0 spike ([hermes-findings.md](hermes-findings.md))
as actually implemented. The guiding priority, in order: **statistical honesty →
run inspectability → clean Hermes integration → engineering quality → a real
experiment.** Depth on the comparison engine beats breadth of features.

## Architecture

One NestJS codebase with two entry points — the **API** and a **worker** — plus a
Vue UI, all on one Postgres. The job queue is **pg-boss** on that same Postgres,
so there is no Redis to run. The browser only talks to the API; the worker pulls
trial jobs and spawns one isolated Hermes process per trial.

```
                 ┌──────────────┐
   browser ────► │  web (Vue 3) │  :5173
                 └──────┬───────┘
                        │ HTTP (JSON)
                 ┌──────▼───────┐        ┌───────────────┐
                 │  API (Nest)  │ ─────► │   Postgres    │  :5432
                 │  :3000       │ ◄───── │  data + pg-boss│
                 └──────────────┘  SQL   └──────▲────────┘
                   POST /experiments             │ pulls jobs
                   fans out 1 job/trial          │
                 ┌───────────────┐               │
                 │ worker (Nest) │ ◄─────────────┘
                 └──────┬────────┘
                        │ one-shot per trial
                 ┌──────▼─────────────────────────┐
                 │ Hermes CLI in a throwaway        │
                 │ Docker volume (fresh HERMES_HOME)│  ← or FakeRunner (recorded)
                 └──────────────────────────────────┘
```

Six components: **web**, **API**, **worker**, **Postgres** (data + pg-boss),
the **runner** (`HermesCliRunner` / `FakeRunner`) and the **Hermes process**.
The API enqueues one job per `(task × config × repeat)`; the worker creates/updates
the `Trial` rows, runs the agent, grades the result and writes it back. Reports
are computed on read, never stored.

### Repo layout

```
apps/
  api/          NestJS: suites, configs, experiments, trials, reports
    src/runner/   AgentRunner interface, HermesCliRunner, FakeRunner
    src/grading/  one class per grader type
    src/stats/    bootstrap, permutation test, Holm (pure functions)
    src/main.ts   API entry   src/worker.ts  worker entry
    fixtures/recordings/  FakeRunner recordings (per-task + per-config)
  web/          Vue 3 + Vite + Vue Router + Naive UI
packages/shared/  zod schemas + TS types shared by api and web
suites/core/      suite.yaml (the 10-task sample suite)
skills/           custom Hermes skill(s) for the skill task
docs/             DESIGN, EXPERIMENT, LIMITS, COSTS, PLAN, hermes-findings
docker-compose.yml
```

## Core entities

| Entity | What it is | Key fields |
| --- | --- | --- |
| TaskSuite | Versioned set of tasks, loaded from YAML in the repo | name, version |
| Task | One thing the agent must do, plus how it's scored | prompt or sessions[], fixtures, graders[], timeoutSec, tags |
| Grader | A scoring rule attached to a task | type (regex, script, llm-judge), weight, passThreshold |
| AgentConfig | Immutable bundle of Hermes knobs | model, provider, toolsets[], skills[], memoryEnabled, maxTurns, configHash |
| Experiment | Suite × configs × k repeats, with one baseline | suiteId, configIds, baselineConfigId, repeats, seed |
| Trial | One task × one config × one repetition | status, finalAnswer, trajectory, score, passed, tokens, costUsd, latencyMs, error |
| GradeResult | One grader's verdict on one trial | score, passed, reason, evidence |
| ComparisonReport | Derived on read, not stored as truth | per-config pass rate + CI, paired diff + CI, p-value, per-task breakdown |

**AgentConfig is immutable:** editing creates a new version with a new content
`configHash`, so an experiment always points at exactly what it ran. Task specs,
graders and trajectories live in **JSONB** (nothing queries inside them), which
saves three or four tables. See the Prisma schema at
[apps/api/prisma/schema.prisma](../apps/api/prisma/schema.prisma).

## Key decisions

| Decision | Choice | Why, and what we rejected |
| --- | --- | --- |
| Database | Postgres 16 in Docker | Parallel workers write trials concurrently; trajectories fit JSONB; pg-boss needs Postgres. SQLite locks the whole file per write and rules out pg-boss. |
| Packaging | docker compose: postgres, api, worker, web | One command for a reviewer with no Node/Hermes/Postgres. Rejected: native install scripts (OS-specific, fragile). |
| Hermes integration | One-shot CLI per trial with a fresh `HERMES_HOME` | Memory/skills/sessions can't leak between trials; the rendered config is a file we can show. Rejected: one long-lived API server (state leaks), importing Hermes as a library (ties us to internals). |
| Trajectory source | That trial's `state.db` | Hermes already records messages, tool calls and tokens there — no log scraping. Fallback: the API server's tool-progress SSE. |
| Job queue | pg-boss on the same Postgres | Retries, concurrency limits, crash recovery, no Redis. Rejected: BullMQ (adds Redis), in-memory (loses trials on restart). |
| Worker | Same codebase, separate process | Long agent runs never block API requests; shares types and the Prisma client. |
| ORM | Prisma | Typed queries, readable schema, simple migrations. Rejected: TypeORM (decorator-heavy, weaker typing). |
| Data shape | Task specs, graders, trajectories as JSONB | Nothing queries inside them; saves tables. Reports computed on read. |
| Config versioning | Immutable configs with a content hash | An experiment always points at exactly what ran. |
| Repeats | k = 5 per task per config | Agents are non-deterministic; one run can't separate luck from a real difference. |
| Unit of analysis | The **task**, not the trial | Repeats of one task are correlated; counting trials as independent overstates confidence. |
| Confidence interval | Paired bootstrap over tasks, 10,000 resamples, seeded | No normality assumption; works for pass/fail and partial scores. Rejected: Wilson on pooled trials (ignores correlation), paired t-test (assumes normal diffs at n=10). |
| p-value | Sign-flip permutation test over tasks | Matches the paired design without distribution assumptions. |
| Verdict | Better / Worse / No detectable difference, **from the CI** | Makes "not enough evidence" an explicit, honest outcome. |
| Graders | Code-based first; LLM judge only for open answers | Deterministic, free, explainable. The judge sits behind an interface with a stub for tests. |
| Model provider | Per-config (Gemini or OpenRouter) | One schema, swap the key by provider; reviewers reproduce at no cost in fake mode. |
| Offline mode | FakeRunner + StubJudge | Tests and a UI demo run with no key and no cost. |
| Progress updates | Polling every 3 s | Simpler than SSE and enough for one user. |
| Code sharing | pnpm monorepo, zod in `packages/shared` | One schema validates suite YAML, API bodies and UI forms. |

### Why CLI-per-run (not a long-lived gateway)

Each trial runs as a one-shot `hermes chat -q` in its own throwaway
`HERMES_HOME`/Docker volume. **Isolation:** memory, auto-created skills and
session history can't leak into later trials — with one long-lived gateway the
agent's learning loop would silently bias exactly the thing we measure.
**Config fidelity:** each trial renders its own `config.yaml` from the
AgentConfig, so the run record shows exactly what Hermes saw. **Trade-off:**
process start-up adds a few seconds per trial — acceptable for a few hundred
trials, noted in LIMITS. The spike ([hermes-findings.md](hermes-findings.md))
confirmed `state.db` holds the full trajectory (tool calls with args + outputs)
and per-session tokens/cost.

### Why task-level bootstrap

Agents are non-deterministic, so each task runs k = 5 times per config. The 5
repeats of one task are **not** independent — they share the task's difficulty.
Treating 100 trials as 100 coin flips makes the intervals look far tighter than
they are. So the unit of analysis is the **task**: average a task's reps into a
per-task score `p_{c,t}`, take the paired difference `d_t = p_{B,t} − p_{A,t}`,
and bootstrap/permute over tasks (seeded, 10,000 resamples, reproducible). The
verdict comes from whether the difference CI excludes 0. With only 10 tasks this
detects large effects and honestly reports "no detectable difference" (or a wide
CI) otherwise — power is a documented limit, not hidden. The stats are pure
functions, unit-tested against hand-computed cases
([apps/api/src/stats/stats.ts](../apps/api/src/stats/stats.ts)).

### Grader strategy

Cheapest and most reliable first; every grader returns a human-readable **reason**
(that's what makes the trial viewer useful):

| Grader | Use it for | Notes |
| --- | --- | --- |
| regex / exact | Short factual answers | Matched against the normalized (whitespace-collapsed, lower-cased) final answer |
| script | Anything checkable by code | Runs a check in a temp dir; the final answer is `agent_answer.txt` / `$FINAL_ANSWER`; uses `node -e` so no host Python needed; exit code + stdout reason |
| llm-judge | Open-ended answers only | `OpenAICompatibleJudge` + `StubJudge`; fixed judge model, temperature 0, returns `{score, reason}`; "ungraded" when no judge is configured |

A trial's score is the weighted mean of its graders (0–1); `passed = score ≥
threshold`. Code graders are preferred over the judge for determinism and cost;
the judge sits behind an interface with a stub so tests never call a model.

## Provider selection (Gemini or OpenRouter)

The runner is provider-agnostic: an `AgentConfig` names a `provider`
(`gemini` | `openrouter`) and a `model`, and the runner passes the one key that
provider needs into the Hermes container:

| provider | .env key | model id form (example) |
| --- | --- | --- |
| `gemini` | `GEMINI_API_KEY` | `gemini-3.8-flash` |
| `openrouter` | `OPENROUTER_API_KEY` | `google/gemini-3.5-flash` |

This is a ~15-line key-selection map (`PROVIDER_ENV` in
`apps/api/src/runner/hermes-cli-runner.ts`), not a provider framework. The key is
passed by name only (`docker run -e NAME`), so the secret value never appears in
argv or logs.

**Default is OpenRouter** right now because the Gemini free tier is exhausted
under agent load (a single agent session spends its daily quota in a few turns).
Switching the whole experiment back to Gemini is a one-line change — set each
config's `provider`/`model` in the seed (or `POST /configs`) — not a code edit.

**No silent fallback.** An experiment holds one variable constant, so the runner
never switches provider mid-run. If a trial comes back with no answer and zero
tokens (a quota/auth refusal), the runner captures what the provider said and
marks that trial **failed**, with the provider's message in `trial.error`.

### Model pair for the real experiment

The experiment changes one variable: model capability (cheap vs strong), same
generation. OpenRouter serves `google/gemini-3.8-flash` but no 3.8 `-lite`, so
the pair is **cheap:** `google/gemini-3.5-flash-lite` and **strong:**
`google/gemini-3.5-flash` — same 3.5 generation, differing only in tier.

## Deviations from the plan

Small, deliberate deviations, recorded so they aren't surprises:

- **`ts-node` instead of `tsx` for the long-running services.** The plan's
  scaffold used `tsx` to run `.ts` ESM directly. The API and worker entry points
  (`start:api` / `start:worker`) run under `ts-node --transpile-only` instead,
  which proved more reliable for NestJS's decorator metadata + CommonJS interop
  in the container. The one-shot scripts (`seed`, `derisk`, `smoke`) still use
  `tsx`. No build step is added for the services beyond building
  `packages/shared` and generating the Prisma client.
- **Added `GET /experiments`.** The plan's API table listed `POST /experiments`
  and `GET /experiments/:id` but no list endpoint; the experiments-list UI page
  needs one, so a minimal list (status, suite name, config count, created) was
  added. No new tables; the verdict shown in the list is fetched from the
  existing report endpoint.
- **Recorded (synthetic) experiment, Hermes image pulled not built, OpenRouter
  over Gemini free tier** — see [LIMITS.md](LIMITS.md).
