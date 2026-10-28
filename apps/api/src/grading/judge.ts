/** DI token for the active Judge (or null when no judge is configured). */
export const JUDGE = Symbol("JUDGE");

export interface JudgeInput {
  question: string;
  rubric: string;
  answer: string;
}
export interface JudgeVerdict {
  score: number; // 0..1
  reason: string;
}
export interface Judge {
  readonly name: string;
  judge(input: JudgeInput): Promise<JudgeVerdict>;
}

/**
 * Deterministic offline judge for tests and demo mode (no key, no cost). Not a
 * real quality signal — it checks the answer is non-empty and, when the rubric
 * lists points, that the answer mentions at least one. The reason says so, so a
 * reviewer is never misled into thinking a real model graded it.
 */
export class StubJudge implements Judge {
  readonly name = "stub";

  async judge({ rubric, answer }: JudgeInput): Promise<JudgeVerdict> {
    const a = answer.trim().toLowerCase();
    if (!a) return { score: 0, reason: "StubJudge: empty answer" };
    const points = rubric
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4);
    if (points.length === 0) {
      return { score: 1, reason: "StubJudge: non-empty answer, no rubric to check" };
    }
    const hit = points.filter((p) => a.includes(p));
    const score = hit.length / points.length;
    return {
      score,
      reason: `StubJudge: answer mentions ${hit.length}/${points.length} rubric terms (${hit.slice(0, 5).join(", ") || "none"})`,
    };
  }
}

type FetchFn = typeof fetch;

/**
 * Real judge: an OpenAI-compatible chat endpoint (Gemini's compat endpoint or
 * OpenRouter), temperature 0, asked to return `{"score":0..1,"reason":"..."}`.
 * Parses JSON out of the reply and retries once with a stricter instruction if
 * the first reply isn't parseable.
 */
export class OpenAiCompatibleJudge implements Judge {
  readonly name = "openai-compatible";

  constructor(
    private readonly opts: { baseUrl: string; apiKey: string; model: string },
    private readonly fetchFn: FetchFn = fetch,
    private readonly maxAttempts = 2,
  ) {}

  async judge(input: JudgeInput): Promise<JudgeVerdict> {
    const system =
      "You are a strict grader. Score how well the answer satisfies the rubric. " +
      'Reply with ONLY compact JSON: {"score": <number 0..1>, "reason": "<one sentence>"}.';
    const user = `Question:\n${input.question}\n\nRubric:\n${input.rubric}\n\nAnswer:\n${input.answer}`;

    let lastErr = "";
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const content = await this.call(
        system + (attempt > 1 ? " Your previous reply was not valid JSON. Return JSON only." : ""),
        user,
      );
      const parsed = extractVerdict(content);
      if (parsed) return parsed;
      lastErr = content.slice(0, 200);
    }
    return { score: 0, reason: `judge returned unparseable output after ${this.maxAttempts} attempts: ${lastErr}` };
  }

  private async call(system: string, user: string): Promise<string> {
    const res = await this.fetchFn(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify({
        model: this.opts.model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`judge HTTP ${res.status}`);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? "";
  }
}

/** Pull a {score, reason} object out of a model reply (handles code fences). */
export function extractVerdict(content: string): JudgeVerdict | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const obj = JSON.parse(match[0]) as { score?: unknown; reason?: unknown };
    const score = typeof obj.score === "number" ? obj.score : Number(obj.score);
    if (!Number.isFinite(score)) return null;
    return {
      score: Math.max(0, Math.min(1, score)),
      reason: typeof obj.reason === "string" ? obj.reason : "(no reason given)",
    };
  } catch {
    return null;
  }
}
