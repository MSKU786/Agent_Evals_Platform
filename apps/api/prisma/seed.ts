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
      graders: [
        { type: "regex", weight: 1, passThreshold: 1, config: { pattern: "\\b42\\b" } },
      ],
      timeoutSec: 120,
      tags: ["reasoning"],
    },
  ],
};

const configs: Array<{ name: string; spec: AgentConfigSpec }> = [
  {
    name: "flash-lite",
    spec: AgentConfigSpec.parse({
      model: "gemini-3.8-flash-lite",
      provider: "gemini",
      toolsets: [],
      skills: [],
      memoryEnabled: false,
      maxTurns: 10,
    }),
  },
  {
    name: "flash",
    spec: AgentConfigSpec.parse({
      model: "gemini-3.8-flash",
      provider: "gemini",
      toolsets: [],
      skills: [],
      memoryEnabled: false,
      maxTurns: 10,
    }),
  },
];

async function main(): Promise<void> {
  const existing = await prisma.taskSuite.findUnique({
    where: { name_version: { name: suite.name, version: suite.version } },
  });
  if (existing) {
    await prisma.task.deleteMany({ where: { suiteId: existing.id } });
  }
  const suiteRow =
    existing ??
    (await prisma.taskSuite.create({
      data: { name: suite.name, version: suite.version },
    }));
  await prisma.task.createMany({
    data: suite.tasks.map((t) => ({
      suiteId: suiteRow.id,
      slug: t.slug,
      spec: t as object,
      tags: t.tags ?? [],
    })),
  });

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
