import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import PgBoss from "pg-boss";
import { TRIAL_QUEUE, type TrialJob } from "@agent-evals/shared";

/**
 * Thin wrapper over pg-boss (the job queue, on the same Postgres — no Redis).
 * The API publishes one job per trial; the worker consumes them. Jobs carry a
 * singletonKey per (experiment, task, config, rep) so re-enqueues dedupe, which
 * — together with the unique Trial row — makes retries idempotent.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private boss!: PgBoss;

  async onModuleInit(): Promise<void> {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    this.boss = new PgBoss({ connectionString });
    this.boss.on("error", (err) => this.logger.error(err));
    await this.boss.start();
    await this.boss.createQueue(TRIAL_QUEUE).catch(() => undefined); // idempotent
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: true }).catch(() => undefined);
  }

  async publishTrial(job: TrialJob): Promise<void> {
    await this.boss.send(TRIAL_QUEUE, job, {
      singletonKey: `${job.experimentId}:${job.taskId}:${job.configId}:${job.repIndex}`,
      retryLimit: 1,
      retryDelay: 5,
    });
  }

  /** Register the worker handler. batchSize sets how many trials run at once. */
  async work(
    concurrency: number,
    handler: (job: TrialJob) => Promise<void>,
  ): Promise<void> {
    await this.boss.work<TrialJob>(
      TRIAL_QUEUE,
      { batchSize: Math.max(1, concurrency), pollingIntervalSeconds: 1 },
      async (jobs) => {
        await Promise.all(jobs.map((j) => handler(j.data)));
      },
    );
    this.logger.log(`worker listening on "${TRIAL_QUEUE}" (concurrency=${concurrency})`);
  }
}
