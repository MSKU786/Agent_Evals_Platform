# Costs

## How cost is measured

Cost is **read, not derived**. Hermes records an `estimated_cost_usd` per session
and per model in its `state.db` (`cost_source: official_docs_snapshot`), and the
runner reads that figure directly onto each `Trial` (`costUsd`), keeping
token × price only as a fallback for unpriced models. The report then averages
and compares cost per task with the same paired bootstrap used for scores, so a
config that is a few points better at several times the cost is visible.

## Formula (for a live run)

Per trial ≈ input tokens × input price + output tokens × output price
(+ an LLM-judge call where a task uses one). With the plan's envelope of ~30k
input and ~3k output tokens per trial and 100 trials (≈3M input, ≈0.3M output):

| Model tier (example prices, approximate) | Agent cost | + LLM judge (~0.5M tok) | Total |
| --- | --- | --- | --- |
| Gemini free tier | $0 | $0 | $0, limited by rate limits |
| Budget: ~$0.50 in / $2 out per 1M | ~$2 | ~$0.50 | ~$2.50 |
| Mid: ~$3 in / $15 out per 1M | ~$14 | ~$0.50 | ~$15 |

Check live prices before any paid run; the platform records tokens and cost per
trial, so the measured numbers land in the report automatically. Infrastructure
is free locally; a small cloud VM to host it would be ~$10–$20/month.

## The shipped run (measured)

The experiment in [EXPERIMENT.md](EXPERIMENT.md) ran in **demo mode**
(`RUNNER=fake`), so the recorded trajectories carry **synthetic** token/cost
figures, not live billing. What the platform recorded:

| Metric | Value |
| --- | --- |
| Trials | 100 (10 tasks × 2 configs × 5 repeats) |
| Total recorded cost | **$0.096** |
| Mean cost / trial | ~$0.00096 (both arms, synthetic) |
| Wall time | **49 s** (worker concurrency 2) |
| Latency | ~0 ms (replay; no network) |

Because the recordings carry equal synthetic cost for both arms, this run does
**not** demonstrate the cheap-vs-strong *price* gap — only the capability gap
(see [LIMITS.md](LIMITS.md)). A live OpenRouter run of the same design would cost
on the order of the Budget/Mid rows above and take ~50 min, bounded by provider
rate limits rather than our code.
