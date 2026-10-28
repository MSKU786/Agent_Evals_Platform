import { Controller, Get, NotFoundException, Param, Query } from "@nestjs/common";
import { ReportsService } from "./reports.service";

@Controller()
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("experiments/:id/report")
  async report(@Param("id") id: string, @Query("vs") vs?: string) {
    const report = await this.reports.getReport(id, vs);
    if (!report) throw new NotFoundException(`experiment ${id} not found`);
    return report;
  }
}
