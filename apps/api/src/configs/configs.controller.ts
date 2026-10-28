import { Body, Controller, Get, Post } from "@nestjs/common";
import { ConfigsService } from "./configs.service";

@Controller("configs")
export class ConfigsController {
  constructor(private readonly configs: ConfigsService) {}

  @Post()
  create(@Body() body: { name: string; spec: unknown }) {
    return this.configs.create(body.name, body.spec);
  }

  @Get()
  list() {
    return this.configs.list();
  }
}
