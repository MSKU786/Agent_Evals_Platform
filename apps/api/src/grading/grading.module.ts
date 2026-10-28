import { Logger, Module } from "@nestjs/common";
import { GradingService } from "./grading.service";
import { RegexGrader } from "./regex-grader";
import { ScriptGrader } from "./script-grader";
import { LlmJudgeGrader } from "./llm-judge-grader";
import { JUDGE, type Judge, OpenAiCompatibleJudge, StubJudge } from "./judge";

/**
 * Grading. The JUDGE provider is chosen by env:
 *   JUDGE=stub   (default) → StubJudge (offline, deterministic)
 *   JUDGE=openai           → OpenAiCompatibleJudge (JUDGE_BASE_URL/_API_KEY/_MODEL)
 *   JUDGE=none             → null → llm-judge tasks are "ungraded"
 */
@Module({
  providers: [
    RegexGrader,
    ScriptGrader,
    LlmJudgeGrader,
    GradingService,
    {
      provide: JUDGE,
      useFactory: (): Judge | null => {
        const kind = (process.env.JUDGE ?? "stub").toLowerCase();
        const log = new Logger("GradingModule");
        if (kind === "none") {
          log.log("JUDGE = none (llm-judge tasks ungraded)");
          return null;
        }
        if (kind === "openai") {
          const baseUrl =
            process.env.JUDGE_BASE_URL ??
            "https://generativelanguage.googleapis.com/v1beta/openai";
          const apiKey = process.env.JUDGE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
          const model = process.env.JUDGE_MODEL ?? "gemini-3.8-flash";
          log.log(`JUDGE = openai-compatible (${model})`);
          return new OpenAiCompatibleJudge({ baseUrl, apiKey, model });
        }
        log.log("JUDGE = stub");
        return new StubJudge();
      },
    },
  ],
  exports: [GradingService],
})
export class GradingModule {}
