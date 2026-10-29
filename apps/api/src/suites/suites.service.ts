import { BadRequestException, Injectable } from "@nestjs/common";
import { load } from "js-yaml";
import { SuiteSpec } from "@agent-evals/shared";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SuitesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Import or update a suite from YAML (or an already-parsed object). */
  async import(source: string | object) {
    const raw = typeof source === "string" ? load(source) : source;
    const parsed = SuiteSpec.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }
    const spec = parsed.data;
    const sourceYaml = typeof source === "string" ? source : JSON.stringify(raw);

    return this.prisma.$transaction(async (tx) => {
      // Upsert the suite row so re-import keeps the same suite id (and its
      // experiments) instead of creating a duplicate.
      const suite = await tx.taskSuite.upsert({
        where: { name_version: { name: spec.name, version: spec.version } },
        create: { name: spec.name, version: spec.version, sourceYaml },
        update: { sourceYaml },
      });

      // Upsert each task by (suite, slug). Existing task rows — and the trials
      // that reference them — are preserved; only the spec/tags are refreshed.
      // (The old path did a blanket deleteMany, which violated
      // trials_task_id_fkey whenever a task already had trials.)
      for (const t of spec.tasks) {
        await tx.task.upsert({
          where: { suiteId_slug: { suiteId: suite.id, slug: t.slug } },
          create: { suiteId: suite.id, slug: t.slug, spec: t as object, tags: t.tags },
          update: { spec: t as object, tags: t.tags },
        });
      }

      // Drop tasks no longer in the suite — but only when they have no trials,
      // so re-importing never destroys recorded results (trials.task_id has no
      // cascade). A removed task that still has trials is left in place.
      const keep = spec.tasks.map((t) => t.slug);
      const stale = await tx.task.findMany({
        where: { suiteId: suite.id, slug: { notIn: keep } },
        select: { id: true, _count: { select: { trials: true } } },
      });
      const removable = stale.filter((s) => s._count.trials === 0).map((s) => s.id);
      if (removable.length > 0) {
        await tx.task.deleteMany({ where: { id: { in: removable } } });
      }

      return tx.taskSuite.findUniqueOrThrow({
        where: { id: suite.id },
        include: { tasks: true },
      });
    });
  }

  list() {
    return this.prisma.taskSuite.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { tasks: true } } },
    });
  }

  get(id: string) {
    return this.prisma.taskSuite.findUnique({
      where: { id },
      include: { tasks: true },
    });
  }
}
