import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { PrismaClient } from "@prisma/client";
import { AgentConfigSpec, configHash, SuiteSpec } from "@agent-evals/shared";

const prisma = new PrismaClient();

// The real sample suite the plan describes: 10 tasks in five groups, loaded
// from the repo's YAML so a fresh `docker compose up` presents exactly what a
// reviewer should see. seed.ts lives at apps/api/prisma/, so the repo root is
// three levels up.
const repoRoot = resolve(__dirname, "..", "..", "..");
const coreYamlPath = resolve(repoRoot, "suites", "core", "suite.yaml");

/**
 * A tiny 3-task suite kept around for quick smoke checks. It is NOT seeded by
 * default — set SEED_SMOKE=1 to also seed it — so the core suite is what a
 * fresh checkout surfaces.
 */
const smokeSuite: SuiteSpec = {
  name: "smoke",
  version: "1",
  tasks: [
    {
      slug: "reasoning-mult",
      prompt: "What is 7 times 6? Reply with only the number.",
      fixtures: {},
      graders: [{ type: "regex", weight: 1, passThreshold: 1, config: { pattern: "\\b42\\b" } }],
      timeoutSec: 120,
      tags: ["reasoning"],
    },
    {
      slug: "reasoning-add",
      prompt: "What is 19 plus 23? Reply with only the number.",
      fixtures: {},
      graders: [{ type: "regex", weight: 1, passThreshold: 1, config: { pattern: "\\b42\\b" } }],
      timeoutSec: 120,
      tags: ["reasoning"],
    },
    {
      slug: "reasoning-half",
      prompt: "What is half of 84? Reply with only the number.",
      fixtures: {},
      graders: [{ type: "regex", weight: 1, passThreshold: 1, config: { pattern: "\\b42\\b" } }],
      timeoutSec: 120,
      tags: ["reasoning"],
    },
  ],
};

// The real experiment's one variable: model capability (cheap vs strong),
// same generation so nothing else changes. Via OpenRouter — Gemini's free tier
// is exhausted under agent load (see docs/LIMITS.md). OpenRouter serves
// gemini-3.8-flash but no 3.8 lite, so we use the 3.5 flash / flash-lite pair,
// which holds the generation constant and changes only the tier.
const configs: Array<{ name: string; spec: AgentConfigSpec }> = [
  {
    name: "flash-lite",
    spec: AgentConfigSpec.parse({
      model: "google/gemini-3.5-flash-lite",
      provider: "openrouter",
      toolsets: [],
      skills: [],
      memoryEnabled: false,
      maxTurns: 10,
    }),
  },
  {
    name: "flash",
    spec: AgentConfigSpec.parse({
      model: "google/gemini-3.5-flash",
      provider: "openrouter",
      toolsets: [],
      skills: [],
      memoryEnabled: false,
      maxTurns: 10,
    }),
  },
];

const truthy = (v: string | undefined): boolean =>
  v === "1" || v?.toLowerCase() === "true";

/**
 * Upsert a suite and its tasks by (suite, slug) — never destructive, so
 * re-seeding preserves existing task rows (and any trials pointing at them).
 */
async function seedSuite(spec: SuiteSpec, sourceYaml: string | null): Promise<string> {
  const suiteRow = await prisma.taskSuite.upsert({
    where: { name_version: { name: spec.name, version: spec.version } },
    create: { name: spec.name, version: spec.version, sourceYaml },
    update: sourceYaml ? { sourceYaml } : {},
  });
  for (const t of spec.tasks) {
    await prisma.task.upsert({
      where: { suiteId_slug: { suiteId: suiteRow.id, slug: t.slug } },
      create: { suiteId: suiteRow.id, slug: t.slug, spec: t as object, tags: t.tags ?? [] },
      update: { spec: t as object, tags: t.tags ?? [] },
    });
  }
  return suiteRow.id;
}

async function main(): Promise<void> {
  // Primary: the real 10-task core suite from suites/core/suite.yaml.
  const coreYaml = readFileSync(coreYamlPath, "utf8");
  const coreSuite = SuiteSpec.parse(load(coreYaml));
  const suiteId = await seedSuite(coreSuite, coreYaml);

  // Optional smoke suite for quick checks (SEED_SMOKE=1).
  if (truthy(process.env.SEED_SMOKE)) {
    await seedSuite(smokeSuite, null);
  }

  for (const c of configs) {
    const hash = configHash(c.spec);
    await prisma.agentConfig.upsert({
      where: { configHash: hash },
      create: { name: c.name, spec: c.spec as object, configHash: hash },
      update: {},
    });
  }

  const configIds = await prisma.agentConfig.findMany({ select: { id: true, name: true } });
  console.log(
    JSON.stringify(
      { suiteId, suite: coreSuite.name, tasks: coreSuite.tasks.length, configs: configIds },
      null,
      2,
    ),
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
