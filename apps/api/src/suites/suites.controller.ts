import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { SuitesService } from "./suites.service";

@Controller("suites")
export class SuitesController {
  constructor(private readonly suites: SuitesService) {}

  /** Body is either {yaml: "..."} or a parsed suite object. */
  @Post("import")
  import(@Body() body: { yaml?: string } & Record<string, unknown>) {
    return this.suites.import(body.yaml ?? body);
  }

  @Get()
  list() {
    return this.suites.list();
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.suites.get(id);
  }
}
