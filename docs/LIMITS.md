# Known limits

(Expanded in Phase 6; early entries recorded here as decisions are made.)

- **Statistical power:** 10 tasks only detects large effects (~20–25+ points);
  small real improvements will read as "no detectable difference".
- **Repeats k = 3, not 5 (cost-driven).** The real experiment is 10 tasks × 2
  configs × **3** repeats = **60 trials** rather than 100. Each trial is a paid
  OpenRouter call, so k = 3 keeps spend down. k = 5 would tighten the confidence
  intervals with more budget; the method is unchanged, only the sample per task.
- **Gemini free tier is unusable under agent load.** It exhausts its quota in a
  handful of messages and can't sustain an agent session, so the real experiment
  runs on **OpenRouter** (paid, per-trial cost). Gemini remains fully supported
  as a provider; switching back is a one-line config/env change (see DESIGN.md).
- **Provider drift:** the same model id can change behaviour over time; old
  experiments are not exactly reproducible. The Hermes image is pinned by digest.
- **Isolation is per-process** (fresh Docker volume per trial), not a hardened
  sandbox; the agent's terminal tool can still reach the network.
- **Image is pulled, not built** (`nousresearch/hermes-agent:v2026.9.24`): this
  environment blocks the GitHub release-asset CDN the Dockerfile needs. The true
  build path is to allow egress to that CDN or build in CI and load the image.
- **Memory tasks** test only within-experiment recall across two sessions, not
  long-term learning.
- **Grading is on the final-answer text only.** The platform currently scores a
  trial from its final reply text (the regex/script/judge graders see
  `finalAnswer`; the script grader additionally gets it as `agent_answer.txt` /
  `$FINAL_ANSWER`). It does **not** inject task fixtures into the agent's sandbox,
  nor recover the agent's output files for grading — the Hermes run happens in a
  throwaway Docker volume that is removed right after the run. Consequently the
  core suite is designed to be **answer-checkable**: any input the agent needs is
  embedded inline in the prompt, and the graded result is always text in the
  reply (e.g. "read this CSV and output per-region totals as JSON"; "fix this
  function and report what it now returns"). True file-producing tasks —
  fixtures copied in, the agent's work dir copied out, a `sandboxDir` threaded
  through runner → executor → grader, and a test runner (pytest) available in the
  grader env — are **scoped but deferred** under time constraints. This is a known
  limit, not a bug: `TaskSpec.fixtures` and the grader `sandboxDir` hooks already
  exist in the schema, so wiring them is additive and does not change the data
  model.
- **The shipped experiment uses recorded (synthetic) trajectories, not a live
  model.** A funded live API key was out of scope, so `docs/EXPERIMENT.md` was
  produced with `RUNNER=fake`: the FakeRunner replays per-`(config, task)`
  recordings from `apps/api/fixtures/recordings/`, authored to model a realistic
  capability gap — the weaker arm (`flash-lite`) gives wrong answers on the
  multi-step reasoning tasks and the subtler off-by-one code fix, while the
  stronger arm (`flash`) answers them correctly; both pass the mechanical
  file/skill/memory tasks. **Nothing about the run is hand-seeded or faked
  downstream**: the experiment is created through the API, all 100 trials go
  through the real pg-boss queue → runner → graders, and the verdict/CIs/p-value
  are computed by the same stats module a live run would use. Swapping to a live
  model is a one-line change (`RUNNER=hermes` + a provider key, per
  `docs/PLAN.md`); the platform, graders and statistics are identical. The
  recorded answers therefore model *agent capability*, not the platform — which
  is what's being demonstrated.
