import { PrismaClient } from "@prisma/client";
import {
  AgentConfigSpec,
  configHash,
  type SuiteSpec,
} from "@agent-evals/shared";

const prisma = new PrismaClient();

/** A tiny suite + two configs that differ in one variable (model). */
const suite: SuiteSpec = {
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

async function main(): Promise<void> {
  const suiteRow = await prisma.taskSuite.upsert({
    where: { name_version: { name: suite.name, version: suite.version } },
    create: { name: suite.name, version: suite.version },
    update: {},
  });
  // Upsert tasks (non-destructive: existing trials keep their FK).
  for (const t of suite.tasks) {
    await prisma.task.upsert({
      where: { suiteId_slug: { suiteId: suiteRow.id, slug: t.slug } },
      create: { suiteId: suiteRow.id, slug: t.slug, spec: t as object, tags: t.tags ?? [] },
      update: { spec: t as object, tags: t.tags ?? [] },
    });
  }

  for (const c of configs) {
    const hash = configHash(c.spec);
    await prisma.agentConfig.upsert({
      where: { configHash: hash },
      create: { name: c.name, spec: c.spec as object, configHash: hash },
      update: {},
    });
  }

  const suiteId = suiteRow.id;
  const configIds = await prisma.agentConfig.findMany({ select: { id: true, name: true } });
  console.log(JSON.stringify({ suiteId, configs: configIds }, null, 2));
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
