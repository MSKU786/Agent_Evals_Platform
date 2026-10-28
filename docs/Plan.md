# Agent Evals Platform — Project Plan

Oct 27, 2026 · @Manish

## Goal and what reviewers will judge

The platform must answer one question with evidence: _is config B better than config A, and how sure are we?_ Everything else (UI, task editor, run viewer) serves that question.

What a reviewer is most likely scoring, in priority order:

1. **Statistical honesty** — repeats per task, confidence intervals, a clear "no significant difference" outcome. This is the core differentiator; most submissions stop at a pass-rate table.
2. **Run inspectability** — open one run, see the full trajectory (messages, tool calls, tool outputs), the grader's verdict and _why_.
3. **Clean Hermes integration** — configs map to real Hermes knobs (model, toolsets, skills, memory), each run isolated so memory/skills from one run don't leak into the next.
4. **Engineering quality** — one-command startup, typed DTOs, tests on the stats and graders, sensible job queue, README + design doc.
5. **A real experiment** with a written conclusion, costs and limits.

Scope rule: depth on the comparison engine beats breadth of features. Skip auth, multi-user and fancy task editors unless time is left.

## How we drive Hermes Agent

Decision: run each trial as a **one-shot Hermes CLI process with its own throwaway `HERMES_HOME`**, inside a Python worker container. This gives perfect isolation between runs and maps every config knob to a flag or a `config.yaml` key.

What Hermes gives us (verified in its docs, Oct 2026):

| Knob we compare       | How Hermes exposes it                                                                                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model / provider      | `hermes chat -q "..." -m <model> --provider <p>` ([CLI docs](https://hermes-agent.nousresearch.com/docs/user-guide/cli))                                                                                                           |
| Tools                 | `-t / --toolsets "web,terminal,file"`                                                                                                                                                                                              |
| Skills                | `-s skill-a,skill-b` preloads skills; skill files live in `$HERMES_HOME/skills/`                                                                                                                                                   |
| Memory                | `memory.memory_enabled` and `memory.user_profile_enabled` in `config.yaml` ([memory docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory))                                                                  |
| Trajectory            | Sessions, messages and token counters are stored in SQLite at `$HERMES_HOME/state.db`                                                                                                                                              |
| Alternative interface | `hermes gateway` with `API_SERVER_ENABLED=true` serves an OpenAI-compatible `/v1/chat/completions` and `/v1/responses` on port 8642 ([API server docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)) |

Why CLI-per-run over the API server:

- **Isolation.** A fresh `HERMES_HOME` per trial means memory, auto-created skills and session history can't leak between trials. With one long-lived gateway, the agent's learning loop would contaminate later runs — a silent bias in exactly the thing we measure.
- **Config fidelity.** Each trial renders its own `config.yaml` from the AgentConfig, so the run record shows exactly what Hermes saw.
- **Trade-off.** Process start-up adds a few seconds per trial. Acceptable for a few hundred trials; note it in Known limits. Keep the API-server path behind the same `AgentRunner` interface as a stretch option.

**Memory needs multi-session tasks.** Memory only matters across sessions, so a task can define a `setup` session (e.g. "my deploy region is ap-south-1") followed by a fresh `eval` session in the same `HERMES_HOME` that asks a question depending on it. Memory-off should fail these; memory-on should pass.

**Determinism.** Set temperature where the provider allows, pin the Hermes git commit in the Dockerfile, and set `approvals.mode` so terminal commands never block on a prompt. Run tools against a Docker or local sandbox per trial with a fixed working directory seeded from the task's fixtures.

Day-1 spike to confirm before building on it: does `hermes chat -q` exit cleanly with a parseable final answer, and does `state.db` hold tool calls with arguments and outputs? If not, fall back to the API server's SSE `hermes.tool.progress` events for the trajectory.

## System design

### 1. Core entities

| Entity           | What it is                                           | Key fields                                                                                  |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| TaskSuite        | Versioned set of tasks, loaded from YAML in the repo | name, version                                                                               |
| Task             | One thing the agent must do, plus how it's scored    | prompt or sessions\[\], fixtures, graders\[\], timeoutSec, tags                             |
| Grader           | A scoring rule attached to a task                    | type (exact, regex, json-schema, script, file-state, llm-judge), weight, passThreshold      |
| AgentConfig      | Immutable bundle of Hermes knobs                     | model, provider, toolsets\[\], skills\[\], memoryEnabled, maxTurns, temperature, configHash |
| Experiment       | Suite × configs × k repeats, with one baseline       | suiteId, configIds, baselineConfigId, repeats, seed, hermesVersion                          |
| Trial            | One task × one config × one repetition               | status, finalAnswer, trajectory, score, passed, tokens, costUsd, latencyMs, error           |
| GradeResult      | One grader's verdict on one trial                    | score, passed, reason, evidence                                                             |
| ComparisonReport | Derived, not stored as truth                         | per-config pass rate + CI, paired diff + CI, p-value, per-task breakdown                    |

**AgentConfig is immutable.** Editing creates a new version with a new `configHash`; old experiments keep pointing at what they actually ran.

### 2. Back-of-the-envelope estimation

The sample experiment: 10 tasks × 2 configs × 5 repeats = **100 trials**.

- **Time.** \~60 s per trial (agent loop + process start). With 2 parallel workers (free-tier rate limits): 100 × 60 / 2 ≈ **50 minutes**. Provider rate limits, not our code, set the ceiling.
- **Tokens.** Agent loops re-send context each turn. Assume \~30k input + \~3k output tokens per trial, plus \~4k for an LLM-judge grader where used.
- **Cost.** See the cost section; $0 on the Gemini free tier, roughly $2–$15 on paid tiers.
- **Storage.** \~100 KB trajectory per trial → \~10 MB per experiment. Postgres JSONB handles this easily; no blob store needed.
- **Load on our API.** One user, a few requests per second at most. Throughput is irrelevant; correctness and isolation matter.

### 3. API

| Method + path                                     | Purpose                                                                  |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| `POST /suites/import`                             | Load or update a suite from YAML (validated with zod/class-validator)    |
| `GET /suites`, `GET /suites/:id`                  | List suites; tasks with their graders                                    |
| `POST /configs`, `GET /configs`                   | Create (new version) and list agent configs                              |
| `POST /experiments`                               | `{suiteId, configIds, baselineConfigId, repeats}` → enqueue all trials   |
| `GET /experiments/:id`                            | Status and progress counts                                               |
| `GET /experiments/:id/events`                     | SSE stream of trial status changes for the live progress bar             |
| `POST /experiments/:id/cancel`                    | Stop queued trials                                                       |
| `GET /experiments/:id/report?vs=<configId>`       | ComparisonReport: rates, CIs, paired diff, per-task table                |
| `GET /trials?experimentId&taskId&configId&passed` | Filterable trial list                                                    |
| `GET /trials/:id`                                 | Full trajectory, grader verdicts, rendered config, tokens, cost          |
| `POST /trials/:id/regrade`                        | Re-run graders without re-running the agent (cheap iteration on graders) |

### 4. DB models (Postgres)

- `task_suites(id, name, version, source_yaml, created_at)`
- `tasks(id, suite_id, slug, spec jsonb, tags text[])` — `spec` holds prompt/sessions, fixtures and graders; no separate graders table.
- `agent_configs(id, name, spec jsonb, config_hash unique, created_at)`
- `experiments(id, suite_id, baseline_config_id, repeats, status, hermes_version, created_at, finished_at)`
- `experiment_configs(experiment_id, config_id)`
- `trials(id, experiment_id, task_id, config_id, rep_index, status, final_answer, score, passed, input_tokens, output_tokens, cost_usd, latency_ms, error, trajectory jsonb, rendered_config text, started_at, finished_at)`, unique on `(experiment_id, task_id, config_id, rep_index)` so retries are idempotent.
- `grade_results(id, trial_id, grader_type, score, passed, reason, evidence jsonb)`

Kept deliberately simple: graders and trajectory steps live in JSONB rather than their own tables, because nothing queries inside them. Reports are computed on read from `trials`, not stored.

### 5. High-level design

One NestJS codebase with two entry points: the **API** and a **worker**. The worker image also has Hermes installed and spawns one `hermes chat -q` subprocess per trial. The job queue is **pg-boss** on the same Postgres, so there is no Redis to run.

&#91;embedded content: architecture · 6 components\]

The browser only talks to the API; the worker pulls trial jobs from Postgres, spawns one isolated Hermes process per trial, grades the result and writes it back.

## Scoring and statistics

The verdict is **Better / Worse / No detectable difference**, decided by a paired, task-level bootstrap confidence interval — never by comparing two raw pass rates.

### Graders (cheapest and most reliable first)

| Grader        | Use it for                     | Notes                                                                                                                |
| ------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| exact / regex | Short factual answers          | Normalise case and whitespace                                                                                        |
| json-schema   | Structured output tasks        | ajv; partial credit = fraction of required fields valid                                                              |
| script        | Anything checkable by code     | Runs a check script in the trial's sandbox dir; exit code + stdout reason                                            |
| file-state    | Agent had to create/edit files | Assert file exists, contains X, tests pass                                                                           |
| llm-judge     | Open-ended answers only        | Fixed judge model, different from the agent model; rubric in the task; returns `{score, reason}` JSON; temperature 0 |

A trial's score is the weighted mean of its graders (0–1); `passed = score ≥ threshold`. Every grader must return a human-readable **reason** — that's what makes the run viewer useful. Hand-check \~10 LLM-judge verdicts and report the agreement rate in the design doc.

### Why repeats, and why task-level

Agents are non-deterministic, so each task runs **k = 5 times per config**. The 5 repeats of one task are not independent samples — they share the task's difficulty. Treating 100 trials as 100 independent coin flips would make the intervals look far tighter than they are. So the unit of analysis is the **task**:

```latex
p_{c,t} = \frac{1}{k}\sum_{r=1}^{k} \text{score}_{c,t,r} \qquad d_t = p_{B,t} - p_{A,t} \qquad \bar{d} = \frac{1}{T}\sum_{t=1}^{T} d_t
```

### The comparison

1. **Effect:** mean paired difference d̄ across tasks (B minus A, in percentage points).
2. **95% CI:** bootstrap — resample tasks with replacement 10,000 times, take the 2.5th and 97.5th percentiles of d̄. Same method gives each config's own CI.
3. **p-value:** paired sign-flip permutation test over tasks (randomly flip the sign of each d_t, 10,000 times).
4. **Verdict:** CI entirely above 0 → Better; entirely below 0 → Worse; otherwise "No detectable difference" plus the CI width, so the user sees how big a change could still be hiding.
5. **More than two configs:** each vs baseline, Holm-corrected p-values.
6. **Secondary metrics:** cost, latency and tokens per task, same paired bootstrap. A config that is 2 points better at 3× the cost should be visible.

Also flag **flaky tasks** (0 < p < 1 within a config) and **task-level wins/losses**, so the user sees _which_ tasks moved, not just the average.

Use a seeded RNG for the bootstrap so reports are reproducible, and unit-test the stats module against hand-computed small cases. Be upfront about power: with 10 tasks, only large effects (roughly 20–25+ points) will reach significance.

## Sample task set and the real experiment

Ship one suite of **10 tasks in five groups**, each group chosen so that a specific config knob should matter. That way the demo can show both a real difference and a real "no difference".

| Group      | Count | Example                                                                           | Grader                     | Knob it exercises    |
| ---------- | ----- | --------------------------------------------------------------------------------- | -------------------------- | -------------------- |
| Reasoning  | 3     | Multi-step word problem with a numeric answer                                     | regex on final number      | model                |
| File tools | 3     | "Summarise `fixtures/sales.csv` into `report.json` with totals per region"        | script                     | toolsets             |
| Code fix   | 2     | Fix a bug in a small Python module so `pytest` passes                             | script (runs tests)        | model, terminal tool |
| Skill use  | 1     | "Write a changelog for these commits" where a repo skill defines the house format | script checks format rules | skills on/off        |
| Memory     | 1     | Session 1 states a preference; session 2 asks something that depends on it        | llm-judge                  | memory on/off        |

Rules for the task set:

- **No web tasks.** Live web results change between runs and would add noise unrelated to the config. Disable the web toolset.
- **Every task self-contained:** fixtures in `suites/core/<task>/fixtures`, copied into the trial's sandbox dir.
- **Validate the suite first:** run each task once with a strong model and fix any task nobody can pass, or that everyone passes trivially.

### The real experiment

Change **one variable only**. Recommended primary experiment: **model swap** — a cheap model vs a stronger model, same toolsets, skills and memory, both on the Gemini API (for example a gemini-3.8-flash-lite vs gemini-3.8-flash) so one free key covers both. It touches most tasks, so it's the most likely to give a clear, significant result.

Optional second experiment if budget allows: **skills off vs on** with the same model — likely a big effect on the skill task and none elsewhere, which demonstrates the per-task breakdown nicely.

Write it up as `docs/EXPERIMENT.md`: hypothesis, configs (rendered `config.yaml` for each), 10 × 2 × 5 = 100 trials, the report table, the verdict with CI and p-value, three inspected trials (one win, one loss, one flaky), total cost and wall time.

## Repo layout and tech choices

`docker compose up` is the single command: it starts Postgres, runs migrations, seeds the sample suite and two configs, then starts the API, worker and web app. The only input is an `.env` with `GEMINI_API_KEY`.

```
agent-evals/
  apps/
    api/          NestJS: suites, configs, experiments, trials, reports, SSE
      src/runner/   AgentRunner interface, HermesCliRunner, FakeRunner
      src/grading/  one class per grader type
      src/stats/    bootstrap, permutation test, Holm (pure functions)
      src/main.ts   API entry   src/worker.ts  worker entry
    web/          Vue 3 + Vite + Pinia + Vue Router
  packages/shared/  zod schemas + TS types shared by api and web
  suites/core/      suite.yaml + per-task fixtures and check scripts
  skills/           custom Hermes skills used by the skill tasks
  docker/           worker image = Node + pinned Hermes commit
  docs/             DESIGN.md, EXPERIMENT.md, COSTS.md, LIMITS.md
  docker-compose.yml
```

| Choice     | Pick                     | Why                                                  |
| ---------- | ------------------------ | ---------------------------------------------------- |
| Monorepo   | pnpm workspaces          | Shared types between API and UI without publishing   |
| ORM        | Prisma                   | Typed client, simple migrations                      |
| Queue      | pg-boss                  | Retries, concurrency, no Redis to run                |
| Validation | zod in `packages/shared` | Same schema validates YAML, API bodies and UI forms  |
| Charts     | ECharts (vue-echarts)    | Forest plot and error bars out of the box            |
| UI kit     | Naive UI or PrimeVue     | Tables and tabs without hand-rolling                 |
| Tests      | Jest (api), Vitest (web) | Stats + graders unit-tested; one e2e with FakeRunner |

**FakeRunner** replays recorded trajectories from `fixtures/recordings/`. It lets the e2e test and a "demo mode" run with no API key and no cost — reviewers can try the UI even without a key.

### UI screens

1. **Suites** — tasks, graders, tags.
2. **Configs** — create a version; see the rendered `config.yaml`.
3. **New experiment** — pick suite, configs, baseline, k; shows the estimated trial count and cost before starting.
4. **Experiment report** — verdict banner, pass rate per config with CI bars, a forest plot of per-task differences, cost/latency comparison, live progress while running.
5. **Trial viewer** — timeline of messages and tool calls (collapsible args and outputs), each grader's score and reason, tokens and cost; a side-by-side mode comparing the same task under config A and B.

## Build phases

Seven phases, each ending in an exit check you can verify in under a minute. Don't start a phase until the previous exit check passes.

### Phase 0 — Model access and Hermes spike

- [ ] Get a free-tier key (Gemini / Groq / OpenRouter `:free`) or start `ollama pull` for two model sizes as fallback
- [ ] Clone Hermes at a pinned commit; build it in a Docker image
- [ ] Run `hermes chat -q` with `-m`, `-t` and `-s`; toggle `memory.memory_enabled` in `config.yaml`
- [ ] Open `state.db`: find where messages, tool calls (args + output) and token counts live
- [ ] Save this run's output as the first FakeRunner recording

**Exit:** `spike/run-one.sh "<prompt>"` prints JSON `{finalAnswer, steps[], tokens}`.

### Phase 1 — Skeleton

- [ ] pnpm monorepo: `apps/api` (API + worker entry points), `apps/web`, `packages/shared`
- [ ] Prisma schema from the DB models section; first migration; seed script
- [ ] `docker-compose.yml` (postgres, api, worker, web) and `.env.example`

**Exit:** `docker compose up` on a clean checkout; `GET /health` returns ok and the web app loads.

### Phase 2 — Runner and worker

- [ ] `AgentRunner` interface; `HermesCliRunner`: temp `HERMES_HOME`, render `config.yaml`, copy fixtures, spawn with timeout, parse `state.db` into a Trajectory
- [ ] Multi-session tasks: run the setup session, then the eval session in the same `HERMES_HOME`
- [ ] `FakeRunner` that replays recordings
- [ ] pg-boss: `POST /experiments` enqueues one job per trial; worker concurrency from env; one retry on infra errors; unique key per trial
- [ ] Record tokens, cost and latency per trial

**Exit:** an experiment of 1 task × 2 configs × 2 repeats finishes and all 4 trials are in the DB with trajectories.

### Phase 3 — Graders and stats

- [ ] `Grader` interface: regex, script, llm-judge (`OpenAICompatibleJudge` + `StubJudge`); "ungraded" when no judge is configured
- [ ] Stats module: per-task means, paired differences, seeded bootstrap CI, sign-flip p-value, verdict
- [ ] `GET /experiments/:id/report` and `POST /trials/:id/regrade`
- [ ] Jest tests: stats against hand-computed cases; each grader; judge JSON parsing and retry

**Exit:** the report endpoint returns a verdict for the Phase 2 experiment, and `pnpm test` is green.

### Phase 4 — Task suite and launch

- [ ] 10 tasks in `suites/core` with fixtures and check scripts; one custom skill in `skills/`
- [ ] Two config YAMLs that differ in one variable
- [ ] Smoke-test every task once on the stronger config; fix tasks that are broken or trivially easy
- [ ] Launch the real experiment (100 trials on an API key; 60 with k = 3 on a local model)

**Exit:** experiment running, with the estimated finish time and cost noted.

### Phase 5 — Results and UI

- [ ] Review failed trials; fix graders and regrade (no agent re-runs needed)
- [ ] Vue pages: experiments list, report (verdict banner, CI bars, per-task A vs B table), trial viewer (messages and tool calls, grader reasons, tokens, cost), simple new-experiment form
- [ ] Progress by polling every 3 s

**Exit:** from the verdict, you can click through to a failed trial and see exactly why it failed.

### Phase 6 — Docs, video, submit

- [ ] README, DESIGN (with the architecture diagram), LIMITS, COSTS, EXPERIMENT
- [ ] Fresh-clone test: `git clone` into a new folder, then `docker compose up`
- [ ] Record the 5-minute video
- [ ] Push and submit, with an hour of buffer

**Exit:** submitted.

## Phase 0 findings (verified against the real Hermes image)

The spike confirmed the integration works and corrected three assumptions. These override the matching rows elsewhere in the plan.

- **Model id:** `gemini-2.5-flash` now returns 404. Use **`gemini-3.8-flash`** (and `gemini-3.8-flash-lite` as the cheap arm of the model-swap experiment). Model ids are provider-owned and current; don't pin them from memory.
- **Cost is read, not derived:** Hermes records `estimated_cost_usd` per session and per model in `state.db` (`cost_source: official_docs_snapshot`). The runner reads that figure directly, keeping token × price only as a fallback for unpriced models. Simplifies the COSTS section.
- **Image is pulled, not built:** this environment blocks the GitHub release-asset CDN that Hermes's Dockerfile needs (s6-overlay, Playwright), so the spike pulled `nousresearch/hermes-agent:v2026.9.24`, pinned by digest. Reproducible, but a deviation from "build on top of Hermes" — record it in LIMITS.md with the one-line reason and the true-build path (allow egress to that CDN, or build in CI and load the image).
- **Confirmed as planned:** one-shot `hermes chat -q --oneshot` per trial in a throwaway Docker volume gives clean per-trial isolation; `state.db` holds the full trajectory (assistant `tool_calls` rows paired with `tool` result rows), per-message and per-session tokens. Memory is config-only (`memory.memory_enabled`), no CLI flag — the runner patches `config.yaml` per trial.
- **Watch-out:** Google API latency is high, so each trial needs a generous `--run-budget` / timeout; a tool-using trial takes a few minutes. This reinforces low worker concurrency and an overnight run.

## Key decisions and why

Every major choice, what was rejected, and the reason. DESIGN.md should carry this table almost as is.

| Decision            | Choice                                                               | Why, and what we rejected                                                                                                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database            | Postgres 16 in Docker                                                | Parallel workers write trials at the same time, trajectories fit JSONB, and pg-boss needs Postgres. SQLite would cope with the data size (\~10 MB, one user), but it locks the whole file on each write and rules out pg-boss. Docker is needed for Hermes anyway, so Postgres adds no setup for the reviewer. |
| Packaging           | docker compose: postgres, app, web                                   | One command for a reviewer who has no Python, Hermes or Postgres installed. Rejected: native install scripts (OS-specific and fragile).                                                                                                                                                                        |
| Hermes integration  | One-shot CLI process per trial with a fresh `HERMES_HOME`            | Memory, skills and sessions can't leak between trials; the rendered config is a file we can show. Rejected: one long-lived API server (state leaks), importing Hermes as a Python library (ties us to its internals and needs a Python service).                                                               |
| Trajectory source   | That trial's `state.db`                                              | Hermes already records messages, tool calls and tokens there, so no log scraping. Fallback: the API server's tool-progress events.                                                                                                                                                                             |
| Job queue           | pg-boss on the same Postgres                                         | Retries, concurrency limits and crash recovery without running Redis. Rejected: BullMQ (adds Redis), an in-memory queue (loses trials on restart).                                                                                                                                                             |
| Worker              | Same NestJS codebase, separate process                               | Long agent runs never block API requests; shares types and the Prisma client.                                                                                                                                                                                                                                  |
| ORM                 | Prisma                                                               | Typed queries, readable schema, simple migrations. Rejected: TypeORM (decorator-heavy, weaker typing).                                                                                                                                                                                                         |
| Data shape          | Task specs, graders and trajectories as JSONB                        | Nothing queries inside them, which saves three or four tables. Reports are computed on read.                                                                                                                                                                                                                   |
| Config versioning   | Immutable configs with a content hash                                | An experiment always points at exactly what ran.                                                                                                                                                                                                                                                               |
| Repeats             | k = 5 per task per config                                            | Agents are non-deterministic; one run per task can't separate luck from real difference.                                                                                                                                                                                                                       |
| Unit of analysis    | The task, not the trial                                              | Repeats of one task are correlated; counting trials as independent overstates confidence.                                                                                                                                                                                                                      |
| Confidence interval | Paired bootstrap over tasks, 10,000 resamples, seeded                | No normality assumption, works for pass/fail and partial scores, easy to explain. Rejected: Wilson interval on pooled trials (ignores correlation), paired t-test (assumes normal differences with only 10 tasks).                                                                                             |
| p-value             | Sign-flip permutation test                                           | Matches the paired design without distribution assumptions.                                                                                                                                                                                                                                                    |
| Verdict             | Better / Worse / No detectable difference, from the CI               | Makes "not enough evidence" an explicit, honest outcome.                                                                                                                                                                                                                                                       |
| Graders             | Code-based first; LLM judge only for open answers                    | Deterministic, free and explainable. The judge sits behind an interface with a stub for tests.                                                                                                                                                                                                                 |
| Judge setup         | Separate model where possible, temperature 0, JSON `{score, reason}` | Reduces self-preference bias; listed as a limit when one free model plays both roles.                                                                                                                                                                                                                          |
| Model provider      | Gemini API free tier                                                 | Reviewers can reproduce at no cost; one key covers agent and judge. Low worker concurrency keeps within rate limits.                                                                                                                                                                                           |
| Offline mode        | FakeRunner and StubJudge                                             | Tests and a UI demo run with no key and no cost.                                                                                                                                                                                                                                                               |
| Progress updates    | Polling every 3 s                                                    | Simpler than SSE and enough for one user.                                                                                                                                                                                                                                                                      |
| Code sharing        | pnpm monorepo, zod schemas in `packages/shared`                      | One schema validates suite YAML, API bodies and UI forms.                                                                                                                                                                                                                                                      |

## Assumptions, limits, costs and risks

### Assumptions to document

- Single user, local machine; no auth or multi-tenancy.
- One LLM provider (Gemini API, free tier) for agent and judge; user supplies the key.
- Tasks are offline and self-contained; web tools are out of scope for scoring.
- "Better" means higher mean task-level score; cost and latency are reported but not folded into the verdict.
- Hermes is pinned to one commit; results are only comparable within that version (recorded on each experiment).

### Known limits (to write in LIMITS.md)

- **Statistical power:** 10 tasks only detects large effects; small real improvements will show as "no detectable difference".
- **LLM-judge bias:** judge can favour certain styles; mitigated by preferring code graders and reporting judge agreement.
- **Provider drift:** the same model name can change behaviour over time; old experiments are not exactly reproducible.
- **Isolation is per-process, not a hard sandbox** unless Hermes's Docker terminal backend is used; agents can still reach the network.
- **Throughput:** \~1 trial per worker-minute; large suites need more workers and hit provider rate limits.
- **Memory tasks** test only within-experiment recall over two sessions, not long-term learning.

### Approximate costs

Per trial ≈ input tokens × input price + output tokens × output price (+ judge). With \~30k input and \~3k output tokens per trial and 100 trials (3M input, 0.3M output):

| Model tier (example prices, approximate)        | Agent cost | + LLM judge (\~0.5M tokens) | Total                      |
| ----------------------------------------------- | ---------- | --------------------------- | -------------------------- |
| Gemini free tier (used for the real experiment) | $0         | $0                          | $0, limited by rate limits |
| Budget: \~$0.50 in / $2 out per 1M              | \~$2       | \~$0.50                     | \~$2.50                    |
| Mid: \~$3 in / $15 out per 1M                   | \~$14      | \~$0.50                     | \~$15                      |

Check live prices before any paid run and put the measured numbers (the platform records tokens and cost per trial) in COSTS.md. Infrastructure is free locally; a small cloud VM to host it would be \~$10–$20/month.

### Risks and fallbacks

| Risk                                                                      | Fallback                                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `hermes chat -q` output or `state.db` doesn't expose clean tool-call data | Use the API server's SSE tool-progress events, or parse `--verbose` logs                                                              |
| Hermes install inside Docker is heavy or flaky                            | Use the official Hermes Dockerfile as the worker base image                                                                           |
| Provider rate limits slow the experiment                                  | Lower concurrency, add retry with backoff in pg-boss, run overnight                                                                   |
| Running out of time                                                       | Cut: side-by-side trial view, >2 config comparison, config editor UI (YAML only). Never cut: stats, trial viewer, experiment write-up |

## Deliverables checklist

- [ ] Git repo with README: what it is, quick start (`cp .env.example .env && docker compose up`), demo mode without a key, screenshots
- [ ] `docs/DESIGN.md`: architecture diagram, entities, why CLI-per-run, why task-level bootstrap, grader strategy
- [ ] `docs/LIMITS.md`: known limits
- [ ] `docs/COSTS.md`: formula + measured cost of the real experiment
- [ ] `docs/EXPERIMENT.md`: two configs, 200 trials, verdict with CI and p-value, three inspected trials
- [ ] Sample suite of \~20 tasks with fixtures and graders
- [ ] Unit tests for stats and graders; one e2e test with FakeRunner; CI workflow running them
- [ ] Video, 5–7 minutes

### Video outline

1. **0:00** — The problem in one sentence and the architecture diagram.
2. **0:45** — `docker compose up`; show the seeded suite and two configs, including the rendered `config.yaml`.
3. **1:45** — Start an experiment; live progress bar via SSE.
4. **2:45** — Open the finished real experiment: verdict, CIs, forest plot, cost comparison.
5. **4:00** — Drill into a failed trial: tool calls, grader reason; then side-by-side with the passing config.
6. **5:15** — Limits and what you'd build next (more tasks for power, sandboxed backend, CI integration).

Record the real experiment _before_ the video so the report is already full; start a small 2-task experiment live just to show progress.
