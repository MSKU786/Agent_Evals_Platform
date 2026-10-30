import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ExperimentsService } from "./experiments.service";

@Controller("experiments")
export class ExperimentsController {
  constructor(private readonly experiments: ExperimentsService) {}

  @Post()
  create(@Body() body: unknown) {
    return this.experiments.create(body);
  }

  @Get()
  list() {
    return this.experiments.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.experiments.get(id);
  }
}
