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
