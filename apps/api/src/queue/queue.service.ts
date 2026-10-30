import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import PgBoss from "pg-boss";
import { TRIAL_QUEUE, type TrialJob } from "@agent-evals/shared";

/**
 * How long a worker may hold a trial job before pg-boss considers it expired and
 * makes it available again. This MUST comfortably exceed the longest possible
 * trial: a single prompt is ~5 min, but a multi-session memory task runs two
 * Hermes sessions back to back (each up to task.timeoutSec, currently 420 s),
 * plus Docker start-up. 30 min leaves a generous margin so a slow-but-healthy
 * trial is never redelivered and run twice. (pg-boss's own default is 15 min.)
 */
const TRIAL_EXPIRE_SECONDS = 30 * 60;

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

    // Queue-level retry + expiration defaults. createQueue is a no-op once the
    // queue exists, so updateQueue is what actually pushes the raised expiration
    // onto a queue created by an earlier run (which still had pg-boss's 15-min
    // default). Sent jobs also carry expireInSeconds, so the setting applies
    // whichever pg-boss honours.
    const queueOptions: PgBoss.Queue = {
      name: TRIAL_QUEUE,
      expireInSeconds: TRIAL_EXPIRE_SECONDS,
      retryLimit: 1,
      retryDelay: 5,
    };
    await this.boss.createQueue(TRIAL_QUEUE, queueOptions).catch(() => undefined);
    await this.boss
      .updateQueue(TRIAL_QUEUE, queueOptions)
      .catch((e) => this.logger.warn(`updateQueue failed: ${e instanceof Error ? e.message : e}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: true }).catch(() => undefined);
  }

  async publishTrial(job: TrialJob): Promise<void> {
    await this.boss.send(TRIAL_QUEUE, job, {
      singletonKey: `${job.experimentId}:${job.taskId}:${job.configId}:${job.repIndex}`,
      retryLimit: 1,
      retryDelay: 5,
      // Don't let a slow (but healthy) trial expire and get run a second time;
      // the executor's done-guard is the backstop if it ever does.
      expireInSeconds: TRIAL_EXPIRE_SECONDS,
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
