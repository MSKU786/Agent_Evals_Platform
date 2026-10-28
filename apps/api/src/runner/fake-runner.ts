import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Injectable } from "@nestjs/common";
import {
  type RunResult,
  TrajectoryStep,
  type Usage,
} from "@agent-evals/shared";
import { AgentRunner, primaryPrompt, type RunInput } from "./agent-runner";

const RECORDINGS_DIR =
  process.env.RECORDINGS_DIR ?? join(process.cwd(), "fixtures", "recordings");

interface Recording {
  finalAnswer: string;
  steps: unknown[];
  usage: Partial<Usage>;
}

/**
 * Replays a recorded trajectory — no API key, no cost, deterministic. Powers
 * the e2e test and "demo mode". If a per-task recording
 * `fixtures/recordings/<slug>.json` exists it is used; otherwise a generic one.
 * The recorded final answer has `{{PROMPT}}` substituted so each trial's record
 * reflects its own prompt.
 */
@Injectable()
export class FakeRunner implements AgentRunner {
  readonly kind = "fake" as const;

  async run(input: RunInput): Promise<RunResult> {
    const started = Date.now();
    const prompt = primaryPrompt(input.taskSpec);
    const rec = this.load(input.taskSpec.slug);

    const steps = [
      TrajectoryStep.parse({ role: "user", content: prompt }),
      ...rec.steps.map((s) => TrajectoryStep.parse(s)),
    ];
    const finalAnswer = rec.finalAnswer.replace("{{PROMPT}}", prompt);

    const usage: Usage = {
      inputTokens: rec.usage.inputTokens ?? 0,
      outputTokens: rec.usage.outputTokens ?? 0,
      reasoningTokens: rec.usage.reasoningTokens ?? 0,
      cacheReadTokens: rec.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: rec.usage.cacheWriteTokens ?? 0,
      toolCallCount: rec.usage.toolCallCount ?? 0,
      costUsd: rec.usage.costUsd ?? 0,
      model: input.configSpec.model,
    };

    return {
      sessionId: `fake_${input.trialId}`,
      finalAnswer,
      steps,
      usage,
      latencyMs: Date.now() - started,
      error: null,
    };
  }

  private load(slug: string): Recording {
    for (const name of [`${slug}.json`, "default.json"]) {
      try {
        return JSON.parse(readFileSync(join(RECORDINGS_DIR, name), "utf8"));
      } catch {
        // try next
      }
    }
    // Last resort so the runner never hard-fails with no recordings on disk.
    return {
      finalAnswer: "42",
      steps: [{ role: "assistant", content: "42", finishReason: "stop" }],
      usage: { inputTokens: 13151, outputTokens: 55, costUsd: 0.01 },
    };
  }
}
