/**
 * Phase 4 Step 1 — de-risk the real runner.
 *
 * Seeds a one-task, tool-using suite + the strong OpenRouter config, launches a
 * 1×1×1 experiment THROUGH THE QUEUE (so the API + worker path is exercised,
 * not the runner in isolation), polls until it settles, then prints the trial:
 * status, tokens, cost, the trajectory step count and the grader verdict.
 *
 * Requires the API (RUNNER=hermes) and worker (RUNNER=hermes) to be running.
 * Run:  pnpm --filter @agent-evals/api derisk
 */
import { PrismaClient } from "@prisma/client";
import {
  AgentConfigSpec,
  TaskSpec,
  configHash,
} from "@agent-evals/shared";

const prisma = new PrismaClient();
const API = `http://localhost:${process.env.PORT ?? 3000}`;

const task = TaskSpec.parse({
  slug: "derisk-terminal",
  // Force one real tool call, then a checkable numeric answer.
  prompt:
    "Use the terminal tool to compute 6 times 7 — for example run `expr 6 \\* 7`. " +
    "Then reply with only the resulting number.",
  fixtures: {},
  graders: [{ type: "regex", weight: 1, passThreshold: 1, config: { pattern: "\\b42\\b" } }],
  timeoutSec: 420,
  tags: ["derisk", "file"],
});

const config = AgentConfigSpec.parse({
  model: "gemini-3.8-flash", // the strong arm
  provider: "gemini",
  toolsets: ["terminal"],
  skills: [],
  memoryEnabled: false,
  maxTurns: 10,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // 0. Reset any prior derisk state so we always launch exactly one trial
  //    (FK-safe order: grades → trials → experiment_configs → experiments → tasks).
  const existing = await prisma.taskSuite.findUnique({
    where: { name_version: { name: "derisk", version: "1" } },
  });
  if (existing) {
    const exps = await prisma.experiment.findMany({
      where: { suiteId: existing.id }, select: { id: true },
    });
    const expIds = exps.map((e) => e.id);
    const trials = await prisma.trial.findMany({
      where: { experimentId: { in: expIds } }, select: { id: true },
    });
    const trialIds = trials.map((t) => t.id);
    await prisma.gradeResult.deleteMany({ where: { trialId: { in: trialIds } } });
    await prisma.trial.deleteMany({ where: { experimentId: { in: expIds } } });
    await prisma.experimentConfig.deleteMany({ where: { experimentId: { in: expIds } } });
    await prisma.experiment.deleteMany({ where: { id: { in: expIds } } });
    await prisma.task.deleteMany({ where: { suiteId: existing.id } });
  }

  // 1. Seed a dedicated derisk suite + the strong config.
  const suite = await prisma.taskSuite.upsert({
    where: { name_version: { name: "derisk", version: "1" } },
    create: { name: "derisk", version: "1" },
    update: {},
  });
  await prisma.task.upsert({
    where: { suiteId_slug: { suiteId: suite.id, slug: task.slug } },
    create: { suiteId: suite.id, slug: task.slug, spec: task as object, tags: task.tags ?? [] },
    update: { spec: task as object, tags: task.tags ?? [] },
  });
  const hash = configHash(config);
  const cfgRow = await prisma.agentConfig.upsert({
    where: { configHash: hash },
    create: { name: "flash", spec: config as object, configHash: hash },
    update: {},
  });

  // 2. Launch 1 task × 1 config × 1 rep through the API (→ queue → worker).
  const res = await fetch(`${API}/experiments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      suiteId: suite.id,
      configIds: [cfgRow.id],
      baselineConfigId: cfgRow.id,
      repeats: 1,
    }),
  });
  if (!res.ok) throw new Error(`POST /experiments ${res.status}: ${await res.text()}`);
  const exp = (await res.json()) as { id: string; plannedTrials: number };
  console.log(`launched experiment ${exp.id} (${exp.plannedTrials} trial)`);

  // 3. Poll until the trial settles (done/failed), up to ~12 min.
  const deadline = Date.now() + 12 * 60 * 1000;
  let status = "running";
  while (Date.now() < deadline) {
    await sleep(3000);
    const e = (await (await fetch(`${API}/experiments/${exp.id}`)).json()) as {
      status: string;
      progress: Record<string, number>;
    };
    process.stdout.write(`\r  status=${e.status} progress=${JSON.stringify(e.progress)}        `);
    if (e.status === "finished") { status = "finished"; break; }
  }
  process.stdout.write("\n");

  // 4. Show the trial in full.
  const list = (await (await fetch(`${API}/trials?experimentId=${exp.id}`)).json()) as Array<{ id: string }>;
  if (!list.length) throw new Error("no trial row found");
  const trial = await (await fetch(`${API}/trials/${list[0].id}`)).json();
  const steps = (trial.trajectory?.steps ?? []) as unknown[];
  console.log(JSON.stringify({
    pollStatus: status,
    trialStatus: trial.status,
    finalAnswer: trial.finalAnswer,
    inputTokens: trial.inputTokens,
    outputTokens: trial.outputTokens,
    costUsd: trial.costUsd,
    latencyMs: trial.latencyMs,
    stepCount: steps.length,
    toolSteps: (steps as Array<{ role?: string; toolName?: string }>).filter(
      (s) => s.role === "tool" || s.toolName,
    ).length,
    score: trial.score,
    passed: trial.passed,
    error: trial.error,
    grades: (trial.gradeResults ?? []).map((g: { graderType: string; score: number; passed: boolean; reason: string }) => ({
      graderType: g.graderType, score: g.score, passed: g.passed, reason: g.reason,
    })),
  }, null, 2));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
