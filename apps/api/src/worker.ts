import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { QueueService } from "./queue/queue.service";
import { TrialExecutor } from "./trials/trial-executor";

/**
 * Worker entry point. Shares the NestJS DI container (Prisma, runner, queue)
 * but starts no HTTP server — it just consumes trial jobs from pg-boss.
 */
async function bootstrap(): Promise<void> {
  const logger = new Logger("Worker");
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();

  const queue = app.get(QueueService);
  const executor = app.get(TrialExecutor);
  const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2);

  await queue.work(concurrency, (job) => executor.execute(job));
  logger.log("worker started");

  const shutdown = async () => {
    logger.log("shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void bootstrap();
