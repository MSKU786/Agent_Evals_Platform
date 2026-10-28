# Hermes Agent — Phase 0 spike findings

Written for: the engineer building the Phase 2 `AgentRunner`. This records what
Hermes actually does (as opposed to what docs/PLAN.md assumed), so the runner,
grading, and stats phases build on verified behavior.

Pinned to **Hermes `v2026.9.24`** (git commit `f97608f`), image digest
`sha256:fca358f12efd65bfaaca05884166f15c0e2788375ca30d77061ac1ebc96452b7`.

---

## TL;DR

- **Gemini is a first-class provider** (`--provider gemini`, key `GEMINI_API_KEY`).
  It is not only via OpenRouter as the first docs pages implied.
- **The model id in the plan is dead.** `gemini-2.5-flash` now returns HTTP 404
  ("no longer available to new users"); Google's API itself recommends
  **`gemini-3.8-flash`**, which works. Treat model ids as provider-owned and
  current, not as whatever a design doc froze.
- **We pull the prebuilt image instead of building from the Dockerfile** — forced
  by this environment's network (see [Deviations](#deviations-and-environment-constraints)).
  The image already contains the pinned Hermes + Playwright browser, so runtime
  behavior is identical to a local build.
- **`state.db` lives at `$HERMES_HOME/state.db`** (`/opt/data/state.db` in the
  container) and is **WAL-mode SQLite**. The trajectory, tool calls (args +
  outputs), per-message and per-session token counts, **and Hermes-computed
  cost** are all there. The plan was right that it's the ground truth; it
  under-sold how much is pre-computed for us (cost especially).
- A trial is **one `hermes chat -q … --oneshot` process in its own throwaway
  Docker volume** → perfect per-trial isolation, exactly as the plan wanted.

---

## How we drive Hermes

### Provider & model

| Knob | Value used | Notes |
|------|-----------|-------|
| provider | `gemini` | Google AI Studio direct; reads `GEMINI_API_KEY` (or `GOOGLE_API_KEY`). Confirmed in `cli-config.yaml.example`. |
| model | `gemini-3.8-flash` | `gemini-2.5-flash` → 404. Verify live model ids per provider; don't hard-code stale ones. |
| toolsets | `-t terminal` | Comma-separated. Others seen: `web`, `file`, `skills`. |
| skills | `-s <name>` | Preloads by name from `$HERMES_HOME/skills/<name>/SKILL.md`. Repeatable / comma-separated. |
| memory | `memory.memory_enabled` in `config.yaml` | **No CLI flag** — it is config-only. Set with `hermes config set memory.memory_enabled <bool>`. |

Other flags that matter for an eval harness (from `hermes chat --help`):
`--oneshot` (answer and exit; implied on non-TTY), `--yolo` (bypass command
approval prompts — **required** for non-interactive terminal tool use),
`--max-turns N`, `--run-budget SECONDS` (hard wall-clock ceiling, purpose-built
for one-shot/eval runs), `--format {text,stream-json}` (a machine-readable
stdout stream — an alternative to parsing `state.db`), `--ignore-user-config` /
`--safe-mode` (fully isolated runs), `--source tool` (keep eval sessions out of
user session lists).

### One-shot invocation & isolation

The image's entrypoint is `["/init", "/opt/hermes/docker/main-wrapper.sh"]`.
`/init` (s6-overlay) runs the `cont-init.d` setup — seeds `config.yaml`, syncs
58 bundled skills, registers the `default` profile — then the wrapper routes any
trailing args to `hermes <args>`. **Do not bypass `/init`**; the gateway setup
depends on it. So a one-shot is simply:

```
docker run --rm -e GEMINI_API_KEY -e HERMES_UID=10000 -e HERMES_GID=10000 \
  -v <throwaway-volume>:/opt/data \
  nousresearch/hermes-agent:v2026.9.24 \
  chat -q "<prompt>" --oneshot --provider gemini -m gemini-3.8-flash \
       -t terminal -s <skill> --yolo --max-turns 20
```

A fresh volume per trial is the isolation boundary: memory, auto-created skills,
and session history cannot leak between trials. `spike/run-one.sh` implements
exactly this (seed config → create container → copy custom skill in → run →
inspect), and is the seed of the Phase 2 `HermesCliRunner`.

Boot overhead: `/init` + bundled-skill sync adds a few seconds per run — fine at
a few hundred trials, as the plan already noted. Agent/s6 logs go to **stderr**;
we read the trajectory from `state.db`, not stdout.

---

## state.db — where trajectory, tool calls, tokens and cost live

Location: `$HERMES_HOME/state.db` = `/opt/data/state.db`. **WAL mode**: recent
rows sit in the `-wal` sidecar until checkpointed, so a naive `mode=ro` open
reads an empty/stale main file. Inspect *after* the process exits and open the
quiescent DB normally (it attaches the WAL). See `spike/inspect_statedb.py`.

Canonical schema is `hermes_state_common.py`. The three tables that matter:

**`sessions`** — one row per session = the trajectory container. Key columns:
`id`, `model`, `model_config`, `parent_session_id` (→ multi-session memory
tasks), `started_at`/`ended_at`/`end_reason`, `message_count`,
`tool_call_count`, token aggregates (`input_tokens`, `output_tokens`,
`cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens`), **cost**
(`estimated_cost_usd`, `actual_cost_usd`, `cost_source`, `pricing_version`),
`cwd`/`git_branch`, `title`, `tool_names`.

**`messages`** — the ordered steps. Columns: `id`, `session_id`, `role`
(`user`/`assistant`/`tool`), `content`, `tool_calls` (JSON — the calls an
**assistant** row requested, with arguments), `tool_call_id` + `tool_name` (on
`tool` rows — the **output** of a call, in that row's `content`), `token_count`
(per message), `finish_reason`, `reasoning`/`reasoning_content`, plus
`active`/`compacted`/`display_order` for ordering and context-compression state.
So an agent tool call is **two rows**: the assistant row carrying `tool_calls`
(args), then a `tool` row carrying the result keyed by `tool_call_id`. Order by
`COALESCE(display_order, id)`.

**`session_model_usage`** — per `(model, task, provider, …)` token + cost
breakdown. `task` separates the agent model from auxiliary calls (title gen,
context compression, and — relevant to us — an LLM-judge). This is where to read
precise per-model cost when a trial uses more than one model.

### Confirmed token/cost record (trivial no-tool query)

A `"What is 7×6?"` run recorded on the session / `session_model_usage`:

```json
"tokens": {
  "input_tokens": 13151, "output_tokens": 55, "reasoning_tokens": 53,
  "tool_call_count": 0, "message_count": 2,
  "estimated_cost_usd": 0.0100695, "cost_source": "official_docs_snapshot",
  "model": "gemini-3.8-flash",
  "by_model_and_task": [{"model": "gemini-3.8-flash", "task": "", "billing_provider": "gemini",
    "api_call_count": 1, "input_tokens": 13151, "output_tokens": 55, "estimated_cost_usd": 0.0100695}]
}
```

Note the ~13k input tokens for a one-line question: the system prompt + preloaded
skills + tool schemas dominate. Budget accordingly (the plan's ~30k/trial
estimate is the right order of magnitude).

### Confirmed tool-call storage (terminal toolset)

From a `-t terminal` run of "run `echo 42 > answer.txt` then `cat` it". One
logical tool call = an **assistant** row carrying the request, then a **tool**
row carrying the result:

```jsonc
// assistant row — the call + arguments
{ "role": "assistant", "content": "", "finish_reason": "tool_calls",
  "tool_calls": [{
    "id": "call_6717724", "type": "function",
    "function": { "name": "terminal",
                  "arguments": "{\"command\": \"echo 42 > answer.txt && cat answer.txt\"}" },
    "extra_content": { "google": { "thought_signature": "EpsICpgIA…(provider-specific, elided)" } }
  }] }
// tool row — the result, keyed by tool_call_id
{ "role": "tool", "tool_name": "terminal", "tool_call_id": "call_6717724",
  "content": "{\"output\": \"…\", \"exit_code\": 1, \"error\": null, \"hint\": \"…\"}" }
```

Takeaways for the runner:
- Tool **arguments** are a JSON string under `messages.tool_calls[].function.arguments`
  (OpenAI tool-call shape). Tool **output** is the paired `tool` row's `content`,
  itself JSON (`{output, exit_code, error, hint}` for the terminal tool).
- Gemini attaches a `extra_content.google.thought_signature` blob per call —
  store/ignore it, but don't choke on provider-specific fields.
- Session aggregates on that run: `tool_call_count=2`, `cache_read_tokens=2352`
  (**prompt caching is active** even on Gemini), `reasoning_tokens=267`,
  `estimated_cost_usd≈0.0064`.
- **The terminal tool's default cwd is `/`** (root-owned) → `echo > answer.txt`
  got **Permission denied**. Phase 2 MUST launch each trial with a writable
  working directory (the plan's per-trial sandbox dir, seeded from fixtures),
  e.g. `docker run -w /work …` or `hermes --in <dir>`.

---

## Differences from docs/PLAN.md

1. **Provider.** Gemini is native (`provider: gemini`), not OpenRouter-only. The
   plan/CLAUDE.md "Gemini API" assumption holds — with the model-id caveat.
2. **Model id.** `gemini-2.5-flash` is 404; use `gemini-3.8-flash`.
3. **Cost is given, not derived.** The plan planned to compute cost from
   tokens × price. Hermes already records `estimated_cost_usd` per session and
   per model (`cost_source=official_docs_snapshot`). Prefer reading it; keep a
   token×price fallback only for providers Hermes can't price.
4. **Memory is config-only** — no `--memory` flag. The runner must render/patch
   `config.yaml` (or `hermes config set`) per trial, which it does anyway.
5. **Trajectory shape.** Not a single `steps[]` blob — reconstruct it by ordering
   `messages` and pairing assistant `tool_calls` with their `tool` result rows.
6. **A `--format stream-json` exists**, so a stdout-stream runner is a viable
   alternative to the `state.db` parser if the DB path ever proves awkward.
7. **Build vs pull** — see below.

---

## Deviations and environment constraints

- **Dockerfile needs a syntax directive on this old Docker.** Docker 20.10.14's
  builtin frontend rejects `COPY --link`. Prepending `# syntax=docker/dockerfile:1.4`
  fixes parsing (no logic change).
- **Building from source is blocked by network egress here.** The build must
  download s6-overlay (and later Playwright browsers) from GitHub's release-asset
  CDN (`release-assets.githubusercontent.com` → Azure blob). That host is
  unreachable from **both** the host machine and containers in this environment
  (21s connect timeout, 0 bytes), while plain `github.com` and `deb.debian.org`
  work. Can't vendor either, since the host can't fetch the bytes. **Decision
  (approved): pull the prebuilt `nousresearch/hermes-agent:v2026.9.24` from
  Docker Hub** (reachable), pinned by digest. For a real build, allow egress to
  those two CDNs, or build in CI/a cloud VM and load the image.
- **Windows/Git-Bash path mangling.** `run-one.sh` sets `MSYS_NO_PATHCONV=1`
  (so `:/opt/data` mount targets survive) and converts `docker cp` host sources
  with `cygpath -w`.
- Minor, non-blocking: the `tirith` security scanner is unavailable in the image
  (falls back to pattern matching); auxiliary title-generation calls to Google
  sometimes read-time-out (the main turn still succeeds). Google API latency is
  high here, so give eval trials a generous `--run-budget`/timeout.

---

## Exit check

`spike/run-one.sh "<prompt>"` prints `{finalAnswer, steps[], tokens}` JSON.

```
$ spike/run-one.sh "What is 7 times 6? Reply with only the number."
{
  "sessionId": "20261028_063956_4d400e",
  "finalAnswer": "42",
  "steps": [
    { "role": "user", "content": "What is 7 times 6? Reply with only the number." },
    { "role": "assistant", "content": "42", "finish_reason": "stop" }
  ],
  "tokens": { "input_tokens": 13151, "output_tokens": 55, "reasoning_tokens": 53,
              "tool_call_count": 0, "estimated_cost_usd": 0.0100695,
              "model": "gemini-3.8-flash", ... }
}
```

`run-one.sh` does the whole trial in an isolated throwaway volume: seed
`config.yaml` (memory on/off) → create container → copy the custom skill in →
run `hermes chat -q … --oneshot` with model/toolsets/skill/memory → parse
`state.db` into the JSON above. A **tool-using** trial exercises the same path
and records the tool-call rows shown in the section above; it just takes a few
minutes here because of Google API latency, so give it a longer timeout
(`--run-budget` in the real runner).

---

## Follow-ups for later phases

- Decide runner transport: `state.db` parse (done here) vs `--format stream-json`.
- Multi-session memory tasks: run a setup session then an eval session in the
  **same** volume; link via `sessions.parent_session_id`. Verify memory-off fails
  and memory-on passes (the plan's memory group).
- Use `--run-budget` + `--max-turns` as the per-trial hard ceilings.
- Pricing: trust `estimated_cost_usd`; add token×price fallback for unpriced models.
- Consider pinning the image by digest in compose for reproducibility.
