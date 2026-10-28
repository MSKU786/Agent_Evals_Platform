import { Module } from "@nestjs/common";
import { RunnerModule } from "../runner/runner.module";
import { TrialExecutor } from "./trial-executor";
import { TrialsController } from "./trials.controller";
import { TrialsService } from "./trials.service";

@Module({
  imports: [RunnerModule],
  controllers: [TrialsController],
  providers: [TrialExecutor, TrialsService],
  exports: [TrialExecutor, TrialsService],
})
export class TrialsModule {}
