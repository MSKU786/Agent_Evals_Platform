import type { Interval, Verdict } from "@agent-evals/shared";
import { mulberry32 } from "./rng";

/**
 * Task-level paired statistics. The unit of analysis is the TASK, not the
 * trial: the k repeats of a task share its difficulty, so we average reps into
 * a per-task score and bootstrap/permute over tasks. See docs/Plan.md.
 *
 * All functions are pure and seeded, so a report is fully reproducible.
 */

export const DEFAULT_RESAMPLES = 10_000;

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** Resample `values` with replacement and return the CI of the mean. */
export function bootstrapMeanCI(
  values: number[],
  opts: { resamples?: number; seed?: number; ci?: number } = {},
): { point: number; ci: Interval } {
  const n = values.length;
  const point = mean(values);
  if (n < 2) return { point, ci: { lo: point, hi: point } };

  const resamples = opts.resamples ?? DEFAULT_RESAMPLES;
  const ci = opts.ci ?? 0.95;
  const rand = mulberry32(opts.seed ?? 1);
  const means = new Array<number>(resamples);
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += values[Math.floor(rand() * n)];
    means[i] = sum / n;
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - ci) / 2;
  return { point, ci: { lo: percentile(means, alpha), hi: percentile(means, 1 - alpha) } };
}

/**
 * Paired sign-flip permutation test over tasks. H0: the paired differences are
 * symmetric about 0. Randomly flips the sign of each d_t and counts how often
 * |mean| reaches the observed |mean|. Two-sided; (count+1)/(resamples+1).
 */
export function signFlipPValue(
  diffs: number[],
  opts: { resamples?: number; seed?: number } = {},
): number {
  const n = diffs.length;
  if (n === 0) return 1;
  const observed = Math.abs(mean(diffs));
  if (observed === 0) return 1;

  const resamples = opts.resamples ?? DEFAULT_RESAMPLES;
  const rand = mulberry32(opts.seed ?? 1);
  let atLeast = 0;
  for (let i = 0; i < resamples; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) sum += rand() < 0.5 ? -diffs[j] : diffs[j];
    if (Math.abs(sum / n) >= observed - 1e-12) atLeast++;
  }
  return (atLeast + 1) / (resamples + 1);
}

/** Verdict from a difference CI (candidate − baseline). */
export function verdictFromCI(ci: Interval, nTasks: number): Verdict {
  if (nTasks < 2) return "insufficient-data";
  if (ci.lo > 0) return "better";
  if (ci.hi < 0) return "worse";
  return "no-difference";
}

/** Holm–Bonferroni step-down adjustment, returned in the input order. */
export function holm(pValues: number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const adj = new Array<number>(m);
  let running = 0;
  order.forEach((entry, rank) => {
    const value = Math.min(1, (m - rank) * entry.p);
    running = Math.max(running, value); // enforce monotonicity
    adj[entry.i] = running;
  });
  return adj;
}

/**
 * Collapse rep-level trial scores into per-task, per-config means.
 * Returns Map<taskId, Map<configId, meanScore>>.
 */
export function perTaskConfigMeans(
  trials: Array<{ taskId: string; configId: string; score: number }>,
): Map<string, Map<string, number>> {
  const acc = new Map<string, Map<string, { sum: number; n: number }>>();
  for (const t of trials) {
    if (!acc.has(t.taskId)) acc.set(t.taskId, new Map());
    const byConfig = acc.get(t.taskId)!;
    const cur = byConfig.get(t.configId) ?? { sum: 0, n: 0 };
    cur.sum += t.score;
    cur.n += 1;
    byConfig.set(t.configId, cur);
  }
  const out = new Map<string, Map<string, number>>();
  for (const [taskId, byConfig] of acc) {
    const m = new Map<string, number>();
    for (const [configId, { sum, n }] of byConfig) m.set(configId, n ? sum / n : 0);
    out.set(taskId, m);
  }
  return out;
}

/** Paired per-task differences (candidate − baseline) over tasks both ran. */
export function pairedDiffs(
  taskMeans: Map<string, Map<string, number>>,
  baselineId: string,
  candidateId: string,
): number[] {
  const diffs: number[] = [];
  for (const byConfig of taskMeans.values()) {
    const b = byConfig.get(baselineId);
    const c = byConfig.get(candidateId);
    if (b !== undefined && c !== undefined) diffs.push(c - b);
  }
  return diffs;
}
