import { Controller, Get, Param, Post, Query } from "@nestjs/common";
import { TrialsService } from "./trials.service";
import { GradingService } from "../grading/grading.service";

@Controller("trials")
export class TrialsController {
  constructor(
    private readonly trials: TrialsService,
    private readonly grading: GradingService,
  ) {}

  /** Re-run graders on the stored trajectory — no agent re-run. */
  @Post(":id/regrade")
  regrade(@Param("id") id: string) {
    return this.grading.gradeTrial(id);
  }

  @Get()
  list(
    @Query("experimentId") experimentId?: string,
    @Query("taskId") taskId?: string,
    @Query("configId") configId?: string,
    @Query("passed") passed?: string,
  ) {
    return this.trials.list({
      experimentId,
      taskId,
      configId,
      passed: passed === undefined ? undefined : passed === "true",
    });
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.trials.get(id);
  }
}
