import { Injectable } from "@nestjs/common";
import type {
  ComparisonArm,
  ComparisonReport,
  ConfigSummary,
  TaskBreakdown,
} from "@agent-evals/shared";
import { PrismaService } from "../prisma/prisma.service";
import {
  DEFAULT_RESAMPLES,
  bootstrapMeanCI,
  holm,
  mean,
  pairedDiffs,
  perTaskConfigMeans,
  signFlipPValue,
  verdictFromCI,
} from "../stats/stats";

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build the ComparisonReport for an experiment (derived on read, never
   * stored). `vs` restricts the comparison to a single candidate config.
   */
  async getReport(experimentId: string, vs?: string): Promise<ComparisonReport | null> {
    const exp = await this.prisma.experiment.findUnique({
      where: { id: experimentId },
      include: { configs: { include: { config: true } } },
    });
    if (!exp) return null;

    const names = new Map(exp.configs.map((c) => [c.configId, c.config.name]));
    const configIds = exp.configs.map((c) => c.configId);
    const baselineId = exp.baselineConfigId;
    const seed = exp.seed;

    const tasks = await this.prisma.task.findMany({
      where: { suiteId: exp.suiteId },
      select: { id: true, slug: true },
    });
    const slugOf = new Map(tasks.map((t) => [t.id, t.slug]));

    const trials = await this.prisma.trial.findMany({
      where: { experimentId, status: "done", score: { not: null } },
      select: {
        taskId: true,
        configId: true,
        score: true,
        passed: true,
        costUsd: true,
        latencyMs: true,
      },
    });
    const scored = trials.map((t) => ({
      taskId: t.taskId,
      configId: t.configId,
      score: t.score as number,
    }));
    const taskMeans = perTaskConfigMeans(scored);

    // --- per-config summaries (pass rate over tasks + its bootstrap CI) ---
    const configs: ConfigSummary[] = configIds.map((configId) => {
      const perTaskValues: number[] = [];
      for (const byConfig of taskMeans.values()) {
        const v = byConfig.get(configId);
        if (v !== undefined) perTaskValues.push(v);
      }
      const { point, ci } = bootstrapMeanCI(perTaskValues, { seed, resamples: DEFAULT_RESAMPLES });
      const mine = trials.filter((t) => t.configId === configId);
      return {
        configId,
        name: names.get(configId) ?? configId,
        passRate: point,
        passRateCI: ci,
        meanCostUsd: mean(mine.map((t) => t.costUsd ?? 0)),
        meanLatencyMs: mean(mine.map((t) => t.latencyMs ?? 0)),
      };
    });

    // --- comparisons vs baseline (Holm-adjusted across candidates) ---
    const candidates = (vs ? [vs] : configIds).filter((c) => c !== baselineId);
    const raw = candidates.map((candidateId) => {
      const diffs = pairedDiffs(taskMeans, baselineId, candidateId);
      const { point, ci } = bootstrapMeanCI(diffs, { seed, resamples: DEFAULT_RESAMPLES });
      const pValue = signFlipPValue(diffs, { seed, resamples: DEFAULT_RESAMPLES });
      return { candidateId, diffs, effect: point, effectCI: ci, pValue };
    });
    const adjusted = holm(raw.map((r) => r.pValue));
    const comparisons: ComparisonArm[] = raw.map((r, i) => ({
      configId: r.candidateId,
      name: names.get(r.candidateId) ?? r.candidateId,
      effect: r.effect,
      effectCI: r.effectCI,
      pValue: r.pValue,
      pValueAdjusted: adjusted[i],
      verdict: verdictFromCI(r.effectCI, r.diffs.length),
    }));

    // --- per-task breakdown (+ flaky flag from rep-level pass mix) ---
    const primary = candidates[0];
    const passByTaskConfig = new Map<string, boolean[]>();
    for (const t of trials) {
      const key = `${t.taskId}|${t.configId}`;
      const arr = passByTaskConfig.get(key) ?? [];
      arr.push(Boolean(t.passed));
      passByTaskConfig.set(key, arr);
    }
    const perTask: TaskBreakdown[] = [...taskMeans.entries()].map(([taskId, byConfig]) => {
      const byConfigObj: Record<string, number> = {};
      for (const [cid, v] of byConfig) byConfigObj[cid] = v;
      const base = byConfig.get(baselineId);
      const cand = primary ? byConfig.get(primary) : undefined;
      const flaky = configIds.some((cid) => {
        const arr = passByTaskConfig.get(`${taskId}|${cid}`) ?? [];
        return arr.length > 1 && arr.some((p) => p) && arr.some((p) => !p);
      });
      return {
        taskId,
        slug: slugOf.get(taskId) ?? taskId,
        byConfig: byConfigObj,
        diff: base !== undefined && cand !== undefined ? cand - base : 0,
        flaky,
      };
    });

    return {
      experimentId,
      baselineConfigId: baselineId,
      tasks: taskMeans.size,
      repeats: exp.repeats,
      configs,
      comparisons,
      perTask,
      bootstrapResamples: DEFAULT_RESAMPLES,
      seed,
    };
  }
}
