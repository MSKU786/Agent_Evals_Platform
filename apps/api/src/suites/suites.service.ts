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
      const existing = await tx.taskSuite.findUnique({
        where: { name_version: { name: spec.name, version: spec.version } },
      });
      if (existing) {
        await tx.task.deleteMany({ where: { suiteId: existing.id } });
        await tx.taskSuite.update({
          where: { id: existing.id },
          data: { sourceYaml },
        });
      }
      const suite =
        existing ??
        (await tx.taskSuite.create({
          data: { name: spec.name, version: spec.version, sourceYaml },
        }));

      await tx.task.createMany({
        data: spec.tasks.map((t) => ({
          suiteId: suite.id,
          slug: t.slug,
          spec: t as object,
          tags: t.tags,
        })),
      });
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
