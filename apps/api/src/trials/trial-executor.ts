import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  AgentConfigSpec,
  TaskSpec,
  type TrialJob,
} from "@agent-evals/shared";
import { PrismaService } from "../prisma/prisma.service";
import { AGENT_RUNNER, type AgentRunner } from "../runner/agent-runner";
import { renderHermesConfig } from "../runner/render-config";

/**
 * Runs one trial job end to end: load the task + config, run the agent through
 * the active runner, and persist the trajectory + usage on the Trial row.
 * Grading (score/passed) is Phase 3 and left null here.
 */
@Injectable()
export class TrialExecutor {
  private readonly logger = new Logger(TrialExecutor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AGENT_RUNNER) private readonly runner: AgentRunner,
  ) {}

  async execute(job: TrialJob): Promise<void> {
    const where = {
      experimentId_taskId_configId_repIndex: {
        experimentId: job.experimentId,
        taskId: job.taskId,
        configId: job.configId,
        repIndex: job.repIndex,
      },
    };

    const [task, config] = await Promise.all([
      this.prisma.task.findUniqueOrThrow({ where: { id: job.taskId } }),
      this.prisma.agentConfig.findUniqueOrThrow({ where: { id: job.configId } }),
    ]);
    const taskSpec = TaskSpec.parse(task.spec);
    const configSpec = AgentConfigSpec.parse(config.spec);

    // Create (or re-open) the trial row as running. Idempotent on retry.
    await this.prisma.trial.upsert({
      where,
      create: {
        experimentId: job.experimentId,
        taskId: job.taskId,
        configId: job.configId,
        repIndex: job.repIndex,
        status: "running",
        startedAt: new Date(),
        renderedConfig: renderHermesConfig(configSpec),
      },
      update: { status: "running", startedAt: new Date(), error: null },
    });

    try {
      const result = await this.runner.run({
        trialId: `${job.experimentId}_${job.taskId}_${job.configId}_${job.repIndex}`,
        taskSpec,
        configSpec,
      });

      await this.prisma.trial.update({
        where,
        data: {
          status: result.error ? "failed" : "done",
          finalAnswer: result.finalAnswer,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: result.usage.costUsd,
          latencyMs: result.latencyMs,
          error: result.error,
          trajectory: { steps: result.steps, usage: result.usage } as object,
          finishedAt: new Date(),
        },
      });
      this.logger.log(
        `trial done: task=${task.slug} config=${config.name} rep=${job.repIndex} ` +
          `(${result.steps.length} steps, ${result.usage.inputTokens}+${result.usage.outputTokens} tok)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.prisma.trial.update({
        where,
        data: { status: "failed", error: message, finishedAt: new Date() },
      });
      this.logger.error(`trial failed: ${message}`);
      throw err;
    }
  }
}
