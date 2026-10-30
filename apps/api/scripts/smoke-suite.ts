/**
 * Phase 4 Step 2 — smoke-test the core suite.
 *
 * Imports suites/core/suite.yaml through the API, seeds ONE fully-capable strong
 * config (gemini-3.8-flash with the terminal toolset, the changelog-style skill
 * and memory on, so every task is passable), then launches all 10 tasks × 1
 * config × 1 rep THROUGH THE QUEUE and polls until they settle. Prints one row
 * per task: status, pass/fail, the grader reason and a snippet of the final
 * answer — so a broken or trivially-easy task is easy to spot.
 *
 * Requires the API and worker running with RUNNER=hermes and GEMINI_API_KEY set.
 * Run:  pnpm --filter @agent-evals/api smoke
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { AgentConfigSpec, configHash } from "@agent-evals/shared";

const prisma = new PrismaClient();
const API = `http://localhost:${process.env.PORT ?? 3000}`;
const SUITE_YAML = join(__dirname, "..", "..", "..", "suites", "core", "suite.yaml");

// The strong, fully-capable arm. Smoke-testing wants every task to be *passable*,
// so this config turns on every knob any task needs: terminal (file-tools,
// code-fix), the changelog skill, and memory (memory task).
const config = AgentConfigSpec.parse({
  model: "gemini-3.8-flash",
  provider: "gemini",
  toolsets: ["terminal"],
  skills: ["changelog-style"],
  memoryEnabled: true,
  maxTurns: 10,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const snippet = (s: string | null, n = 120) =>
  (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

async function main(): Promise<void> {
  // 1. Import the suite through the real import path (validates the YAML).
  const yaml = readFileSync(SUITE_YAML, "utf8");
  const impRes = await fetch(`${API}/suites/import`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ yaml }),
  });
  if (!impRes.ok) throw new Error(`POST /suites/import ${impRes.status}: ${await impRes.text()}`);
  const suite = (await impRes.json()) as { id: string; tasks: Array<{ id: string; slug: string }> };
  console.log(`imported suite ${suite.id} with ${suite.tasks.length} tasks`);

  // 2. Seed the strong config (content-addressed; re-runs reuse the row).
  const hash = configHash(config);
  const cfgRow = await prisma.agentConfig.upsert({
    where: { configHash: hash },
    create: { name: "smoke-flash", spec: config as object, configHash: hash },
    update: {},
  });

  // 3. Launch 10 tasks × 1 config × 1 rep via the API (→ queue → worker).
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
  console.log(`launched experiment ${exp.id} (${exp.plannedTrials} trials)\n`);

  // 4. Poll until every trial settles (up to ~45 min at concurrency 2).
  const deadline = Date.now() + 45 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(5000);
    const e = (await (await fetch(`${API}/experiments/${exp.id}`)).json()) as {
      status: string;
      progress: Record<string, number>;
    };
    process.stdout.write(`\r  status=${e.status} progress=${JSON.stringify(e.progress)}            `);
    if (e.status === "finished") break;
  }
  process.stdout.write("\n\n");

  // 5. Pull every trial and print a per-task result row.
  const list = (await (await fetch(`${API}/trials?experimentId=${exp.id}`)).json()) as Array<{ id: string }>;
  const rows: Array<{
    slug: string; status: string; passed: boolean | null; score: number | null;
    tokens: string; cost: number | null; reason: string; answer: string; error: string | null;
  }> = [];
  for (const { id } of list) {
    const t = (await (await fetch(`${API}/trials/${id}`)).json()) as {
      status: string; passed: boolean | null; score: number | null;
      finalAnswer: string | null; error: string | null;
      inputTokens: number | null; outputTokens: number | null; costUsd: number | null;
      task: { slug: string };
      gradeResults: Array<{ passed: boolean; reason: string }>;
    };
    rows.push({
      slug: t.task.slug,
      status: t.status,
      passed: t.passed,
      score: t.score,
      tokens: `${t.inputTokens ?? 0}+${t.outputTokens ?? 0}`,
      cost: t.costUsd,
      reason: t.gradeResults.map((g) => `${g.passed ? "PASS" : "FAIL"} ${g.reason}`).join(" | "),
      answer: snippet(t.finalAnswer),
      error: t.error,
    });
  }
  rows.sort((a, b) => a.slug.localeCompare(b.slug));

  const passCount = rows.filter((r) => r.passed === true).length;
  console.log(`=== SMOKE RESULTS: ${passCount}/${rows.length} passed ===\n`);
  for (const r of rows) {
    const mark = r.passed ? "PASS" : "FAIL";
    console.log(`[${mark}] ${r.slug}  (status=${r.status}, score=${r.score ?? "n/a"}, tok=${r.tokens}, cost=${r.cost ?? "n/a"})`);
    if (r.error) console.log(`       error: ${r.error}`);
    console.log(`       grader: ${r.reason || "(none)"}`);
    console.log(`       answer: ${r.answer}`);
    console.log("");
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
