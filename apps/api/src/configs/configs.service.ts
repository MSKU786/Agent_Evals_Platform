import { BadRequestException, Injectable } from "@nestjs/common";
import { AgentConfigSpec, configHash } from "@agent-evals/shared";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ConfigsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create an immutable config. The spec is content-hashed; an identical spec
   * returns the existing row (editing = a new version with a new hash).
   */
  async create(name: string, specInput: unknown) {
    const parsed = AgentConfigSpec.safeParse(specInput);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const spec = parsed.data;
    const hash = configHash(spec);

    const existing = await this.prisma.agentConfig.findUnique({
      where: { configHash: hash },
    });
    if (existing) return existing;

    return this.prisma.agentConfig.create({
      data: { name, spec: spec as object, configHash: hash },
    });
  }

  list() {
    return this.prisma.agentConfig.findMany({ orderBy: { createdAt: "desc" } });
  }
}
