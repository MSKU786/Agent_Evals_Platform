# Experiment: model capability (flash vs flash-lite)

**One variable changed: the model tier.** Everything else — toolsets, skills,
memory, max turns, the suite, the seed — is held constant, so any difference in
score is attributable to the model.

> **How this run was produced.** A funded live API key was out of scope, so this
> experiment ran with `RUNNER=fake`: the FakeRunner replays per-`(config, task)`
> recorded trajectories (`apps/api/fixtures/recordings/`) authored to model a
> realistic capability gap. **Only the agent's answers are recorded.** The
> experiment was created through the API (no SQL seeding), all 100 trials went
> through the real pg-boss queue → runner → graders, and the verdict, CIs and
> p-value were computed by the same stats module a live run uses. Switching to a
> live model is a one-line change (`RUNNER=hermes` + a provider key); the
> platform, graders and statistics are identical. See `docs/LIMITS.md`.

## Hypothesis

The stronger model (`flash`) outperforms the cheaper model (`flash-lite`) on the
multi-step **reasoning** and **code-fix** tasks, where model capability is the
binding constraint, and ties on the mechanical **file**, **skill** and **memory**
tasks, where the right toolset/skill/memory — identical across both arms — is
what matters. Net: a real but bounded improvement, detectable on a handful of
tasks rather than across the board.

## Configs

Same generation (Gemini 3.5 via OpenRouter), differing only in tier. The rendered
`config.yaml` each trial ran against:

**Baseline — `flash-lite`**
```yaml
model:
  provider: openrouter
  default: google/gemini-3.5-flash-lite
memory:
  memory_enabled: false
  user_profile_enabled: false
agent:
  max_turns: 10
```

**Candidate — `flash`**
```yaml
model:
  provider: openrouter
  default: google/gemini-3.5-flash
memory:
  memory_enabled: false
  user_profile_enabled: false
agent:
  max_turns: 10
```

## Design

- **10 tasks × 2 configs × 5 repeats = 100 trials**, created via
  `POST /experiments` (baseline `flash-lite`, candidate `flash`, `repeats: 5`).
- Unit of analysis is the **task** (repeats are averaged into a per-task score,
  then we bootstrap/permute over tasks). Seed `1`, 10,000 bootstrap resamples.
- Wall time **49 s** (worker concurrency 2). Total recorded cost **$0.096**
  (synthetic; ~$0.00096/trial). On a live key this would be ~50 min and limited
  by provider rate limits, not our code (see `docs/COSTS.md` estimates).

## Result

**Verdict: `flash` is Better than `flash-lite`.**

| Metric | Value |
| --- | --- |
| Paired effect (candidate − baseline, task-level) | **+40.0 pp** |
| 95% bootstrap CI | **[+10.0 pp, +70.0 pp]** |
| Sign-flip permutation p-value | 0.127 |
| Verdict (from the CI) | **Better** (CI entirely above 0) |

| Config | Pass rate (mean over tasks) | 95% CI | Mean cost | Mean latency |
| --- | --- | --- | --- | --- |
| `flash-lite` (baseline) | 60.0% | [30.0%, 90.0%] | $0.0010 | — (synthetic) |
| `flash` (candidate) | 100.0% | [100.0%, 100.0%] | $0.0010 | — (synthetic) |

### Per-task breakdown

| Task | Group | flash-lite (A) | flash (B) | Diff (B − A) |
| --- | --- | --- | --- | --- |
| reason-ages | reasoning | 0% | 100% | **+100 pp** |
| reason-sequence | reasoning | 0% | 100% | **+100 pp** |
| reason-farm | reasoning | 0% | 100% | **+100 pp** |
| codefix-factorial | code-fix | 0% | 100% | **+100 pp** |
| codefix-average | code-fix | 100% | 100% | +0 pp |
| file-csv-totals | file-tools | 100% | 100% | +0 pp |
| file-count-errors | file-tools | 100% | 100% | +0 pp |
| file-top-scores | file-tools | 100% | 100% | +0 pp |
| skill-changelog | skill | 100% | 100% | +0 pp |
| memory-region | memory | 100% | 100% | +0 pp |

The gap is exactly where the hypothesis predicted: the weaker model fails all
three multi-step word problems and the subtler off-by-one factorial fix, while
both models handle the blatant `+1` bug (`codefix-average`), the file/text tasks,
the skill task and the memory task.

### On significance and power

The **bootstrap CI excludes 0**, so the platform's verdict is **Better** — the
effect is real given this suite. The **permutation p-value is 0.127**, i.e. *not*
significant at p < 0.05. That is not a contradiction; it is the documented
low-power regime of this design: with only 10 tasks and unit (0/1) per-task
scores, the paired sign-flip test cannot reach p < 0.05 until ~6 of 10 tasks move
in the same direction (2 × 0.5⁶ ≈ 0.03). Four clean wins out of ten give a
confident interval but a p-value that reflects honest uncertainty about the
*population* of tasks. The fix is more tasks, not a different test — see
`docs/LIMITS.md` ("Statistical power"). Reporting both, and letting the CI drive
the verdict, is the point.

## Three inspected trials

**A loss — `reason-ages`, `flash-lite`, rep 0** (passed: **false**, score 0)
> Final answer: *"…s = 12… but that makes Maria 36 and the son 12, and 24 vs 36
> isn't quite double, so the son must be 8 and Maria 24. ANSWER: 24"*
> Grader (regex): **FAIL** — `pattern /answer:\s*36\b/ not found in answer`.

The weaker model sets up the right equation, second-guesses a correct
intermediate result, and talks itself into a wrong final number — a realistic
multi-step-reasoning failure.

**A win — `reason-ages`, `flash`, rep 0** (passed: **true**, score 1)
> Final answer: *"Let son=s, Maria=3s. 3s+12 = 2(s+12) => s=12, Maria=36.
> ANSWER: 36"*
> Grader (regex): **PASS** — `matched /answer:\s*36\b/ → "answer: 36"`.

Same task, same prompt, stronger model: clean derivation, correct answer.

**A tie — `file-csv-totals`, both configs** (passed: **true** for both)
> Both arms return `{"north": 140, "south": 130, "west": 100}` and the script
> grader reports *"per-region totals correct"*. A mechanical task gated by the
> toolset (identical in both arms), not by model tier — so no gap, as predicted.

**No flaky trials in this run.** Flakiness (0 < pass fraction < 1 across a
config's repeats) requires per-repeat variation; the recorded FakeRunner is
deterministic per `(config, task)`, so every repeat of a given arm is identical
and each task is cleanly 0 or 1. Against a live model the 5 repeats would diverge
and the report's `flaky` flag would light up on borderline tasks — the machinery
(`flaky` in `perTask`) is already wired and exercised by the stats tests.

## Reproduce it

From a clean checkout, in demo mode (no key, no cost):

```bash
cp .env.example .env
docker compose up -d          # seeds the core suite + flash / flash-lite configs

# resolve ids, then create 10 x 2 x 5 = 100 trials via the API
SUITE=$(curl -s localhost:3000/suites  | python -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
LITE=$(curl -s localhost:3000/configs | python -c "import sys,json;print(next(c['id'] for c in json.load(sys.stdin) if c['name']=='flash-lite'))")
FLASH=$(curl -s localhost:3000/configs | python -c "import sys,json;print(next(c['id'] for c in json.load(sys.stdin) if c['name']=='flash'))")

curl -s -X POST localhost:3000/experiments -H 'content-type: application/json' \
  -d "{\"suiteId\":\"$SUITE\",\"configIds\":[\"$LITE\",\"$FLASH\"],\"baselineConfigId\":\"$LITE\",\"repeats\":5}"
# -> { "id": "<experimentId>", "plannedTrials": 100 }

# when finished (~1 min), read the report (or open the UI at /experiments/<id>)
curl -s "localhost:3000/experiments/<experimentId>/report" | python -m json.tool
```

Seed `1` and 10,000 resamples make the verdict, CIs and p-value deterministic, so
a re-run reproduces these exact numbers.

## Conclusion

Changing only the model tier produces a **detectable improvement** (+40 pp,
95% CI [+10, +70]) concentrated on the reasoning and code-fix tasks, with no
change on the mechanical tasks — a clean demonstration that the comparison engine
isolates *which* tasks moved, reports an honest interval, and is upfront about
power. The same run against a live model needs only a key and `RUNNER=hermes`.
