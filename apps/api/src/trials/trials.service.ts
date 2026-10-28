import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class TrialsService {
  constructor(private readonly prisma: PrismaService) {}

  list(filter: {
    experimentId?: string;
    taskId?: string;
    configId?: string;
    passed?: boolean;
  }) {
    return this.prisma.trial.findMany({
      where: {
        experimentId: filter.experimentId,
        taskId: filter.taskId,
        configId: filter.configId,
        passed: filter.passed,
      },
      orderBy: [{ taskId: "asc" }, { configId: "asc" }, { repIndex: "asc" }],
      select: {
        id: true,
        experimentId: true,
        taskId: true,
        configId: true,
        repIndex: true,
        status: true,
        finalAnswer: true,
        score: true,
        passed: true,
        inputTokens: true,
        outputTokens: true,
        costUsd: true,
        latencyMs: true,
        error: true,
      },
    });
  }

  get(id: string) {
    return this.prisma.trial.findUnique({
      where: { id },
      include: { gradeResults: true, task: true, config: true },
    });
  }
}
