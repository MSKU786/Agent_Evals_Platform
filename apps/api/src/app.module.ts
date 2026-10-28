import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { QueueModule } from "./queue/queue.module";
import { HealthController } from "./health/health.controller";
import { SuitesModule } from "./suites/suites.module";
import { ConfigsModule } from "./configs/configs.module";
import { ExperimentsModule } from "./experiments/experiments.module";
import { TrialsModule } from "./trials/trials.module";

@Module({
  imports: [
    PrismaModule,
    QueueModule,
    SuitesModule,
    ConfigsModule,
    ExperimentsModule,
    TrialsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
