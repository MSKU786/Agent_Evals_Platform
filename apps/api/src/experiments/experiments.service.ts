import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { CreateExperimentBody } from "@agent-evals/shared";
import { PrismaService } from "../prisma/prisma.service";
import { QueueService } from "../queue/queue.service";

@Injectable()
export class ExperimentsService {
  private readonly logger = new Logger(ExperimentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /** Create an experiment and enqueue one trial job per (task × config × rep). */
  async create(input: unknown) {
    const parsed = CreateExperimentBody.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const body = parsed.data;

    if (!body.configIds.includes(body.baselineConfigId)) {
      throw new BadRequestException("baselineConfigId must be in configIds");
    }

    const suite = await this.prisma.taskSuite.findUnique({
      where: { id: body.suiteId },
      include: { tasks: true },
    });
    if (!suite) throw new BadRequestException(`suite ${body.suiteId} not found`);
    if (suite.tasks.length === 0) {
      throw new BadRequestException("suite has no tasks");
    }

    const configs = await this.prisma.agentConfig.findMany({
      where: { id: { in: body.configIds } },
    });
    if (configs.length !== body.configIds.length) {
      throw new BadRequestException("one or more configIds not found");
    }

    const experiment = await this.prisma.experiment.create({
      data: {
        suiteId: body.suiteId,
        baselineConfigId: body.baselineConfigId,
        repeats: body.repeats,
        seed: body.seed,
        status: "running",
        hermesVersion: process.env.HERMES_IMAGE ?? null,
        configs: {
          create: body.configIds.map((configId) => ({ configId })),
        },
      },
    });

    // Fan out: one job per trial. The worker creates/updates the Trial rows.
    let enqueued = 0;
    for (const task of suite.tasks) {
      for (const configId of body.configIds) {
        for (let rep = 0; rep < body.repeats; rep++) {
          await this.queue.publishTrial({
            experimentId: experiment.id,
            taskId: task.id,
            configId,
            repIndex: rep,
          });
          enqueued++;
        }
      }
    }

    this.logger.log(`experiment ${experiment.id}: enqueued ${enqueued} trials`);
    return { id: experiment.id, status: experiment.status, plannedTrials: enqueued };
  }

  async get(id: string) {
    const experiment = await this.prisma.experiment.findUnique({
      where: { id },
      include: { configs: true },
    });
    if (!experiment) return null;

    const grouped = await this.prisma.trial.groupBy({
      by: ["status"],
      where: { experimentId: id },
      _count: { _all: true },
    });
    const progress = Object.fromEntries(
      grouped.map((g) => [g.status, g._count._all]),
    );
    const total = Object.values(progress).reduce((a, b) => a + b, 0);
    const done = (progress.done ?? 0) + (progress.failed ?? 0);

    // Flip to finished once every enqueued trial has settled.
    const expected =
      experiment.repeats *
      experiment.configs.length *
      (await this.prisma.task.count({ where: { suiteId: experiment.suiteId } }));
    if (
      experiment.status === "running" &&
      total >= expected &&
      done >= expected
    ) {
      await this.prisma.experiment.update({
        where: { id },
        data: { status: "finished", finishedAt: new Date() },
      });
      experiment.status = "finished";
    }

    return { ...experiment, progress, expected };
  }
}
