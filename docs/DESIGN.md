# DESIGN notes

Early design notes. The full design doc (architecture diagram, entities, why
CLI-per-run, why task-level bootstrap, grader strategy) is written in Phase 6;
this file carries decisions made before then so they aren't lost.

## Provider selection (Gemini or OpenRouter)

The runner is provider-agnostic: an `AgentConfig` names a `provider`
(`gemini` | `openrouter`) and a `model`, and the runner passes the one key that
provider needs into the Hermes container:

| provider     | .env key             | model id form (example)         |
| ------------ | -------------------- | ------------------------------- |
| `gemini`     | `GEMINI_API_KEY`     | `gemini-3.8-flash`              |
| `openrouter` | `OPENROUTER_API_KEY` | `google/gemini-3.5-flash`       |

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

The experiment changes one variable: model capability (cheap vs strong). We keep
the generation constant so nothing else moves. OpenRouter serves
`google/gemini-3.8-flash` but no 3.8 `-lite`, so the pair is:

- **cheap:** `google/gemini-3.5-flash-lite`
- **strong:** `google/gemini-3.5-flash`

Same 3.5 generation, differing only in tier — a clean single-variable swap.
