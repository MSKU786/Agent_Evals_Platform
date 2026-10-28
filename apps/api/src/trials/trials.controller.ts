import { Controller, Get, Param, Query } from "@nestjs/common";
import { TrialsService } from "./trials.service";

@Controller("trials")
export class TrialsController {
  constructor(private readonly trials: TrialsService) {}

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
