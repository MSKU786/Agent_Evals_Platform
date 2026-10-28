import { z } from "zod";
import { createHash } from "node:crypto";

/**
 * Shared contracts for the Agent Evals platform.
 *
 * These zod schemas are the single source of truth validated at three
 * boundaries: suite YAML import, API request bodies, and (later) UI forms.
 * Types are inferred from the schemas so the TS types can never drift.
 */

// ---------------------------------------------------------------------------
// Agent configuration (an immutable bundle of Hermes knobs)
// ---------------------------------------------------------------------------

export const AgentConfigSpec = z.object({
  model: z.string().min(1),
  provider: z.string().min(1).default("gemini"),
  toolsets: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  memoryEnabled: z.boolean().default(false),
  maxTurns: z.number().int().positive().default(20),
  temperature: z.number().min(0).max(2).optional(),
});
export type AgentConfigSpec = z.infer<typeof AgentConfigSpec>;

/**
 * Content hash of a config. Immutable configs are addressed by this hash, so
 * editing a config produces a new version and old experiments keep pointing at
 * exactly what they ran. Keys are sorted so logically-equal configs hash equal.
 */
export function configHash(spec: AgentConfigSpec): string {
  const canonical = JSON.stringify(spec, Object.keys(spec).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Tasks and graders
// ---------------------------------------------------------------------------

export const GraderType = z.enum(["exact", "regex", "script", "llm-judge"]);
export type GraderType = z.infer<typeof GraderType>;

export const GraderSpec = z.object({
  type: GraderType,
  weight: z.number().positive().default(1),
  passThreshold: z.number().min(0).max(1).default(1),
  // Grader-specific knobs (expected answer, pattern, script path, rubric, …).
  config: z.record(z.unknown()).default({}),
});
export type GraderSpec = z.infer<typeof GraderSpec>;

/** One turn of a multi-session (memory) task; most tasks use a single prompt. */
export const SessionSpec = z.object({
  role: z.enum(["setup", "eval"]).default("eval"),
  prompt: z.string().min(1),
});
export type SessionSpec = z.infer<typeof SessionSpec>;

export const TaskSpec = z
  .object({
    slug: z.string().min(1),
    prompt: z.string().min(1).optional(),
    sessions: z.array(SessionSpec).optional(),
    fixtures: z.record(z.string()).default({}),
    graders: z.array(GraderSpec).min(1),
    timeoutSec: z.number().int().positive().default(300),
    tags: z.array(z.string()).default([]),
  })
  .refine((t) => t.prompt || (t.sessions && t.sessions.length > 0), {
    message: "a task needs either `prompt` or at least one `sessions[]` entry",
  });
export type TaskSpec = z.infer<typeof TaskSpec>;

export const SuiteSpec = z.object({
  name: z.string().min(1),
  version: z.string().min(1).default("1"),
  tasks: z.array(TaskSpec).min(1),
});
export type SuiteSpec = z.infer<typeof SuiteSpec>;

// ---------------------------------------------------------------------------
// Trajectory + usage (what a runner produces for one trial)
// ---------------------------------------------------------------------------

export const ToolCall = z.object({
  id: z.string().optional(),
  name: z.string(),
  arguments: z.string(), // raw JSON string, as Hermes stores it
});
export type ToolCall = z.infer<typeof ToolCall>;

export const TrajectoryStep = z.object({
  role: z.enum(["user", "assistant", "tool", "system"]),
  content: z.string().nullable().default(null),
  toolName: z.string().nullable().optional(),
  toolCallId: z.string().nullable().optional(),
  toolCalls: z.array(ToolCall).nullable().optional(),
  tokenCount: z.number().nullable().optional(),
  finishReason: z.string().nullable().optional(),
});
export type TrajectoryStep = z.infer<typeof TrajectoryStep>;

export const Usage = z.object({
  inputTokens: z.number().default(0),
  outputTokens: z.number().default(0),
  reasoningTokens: z.number().default(0),
  cacheReadTokens: z.number().default(0),
  cacheWriteTokens: z.number().default(0),
  toolCallCount: z.number().default(0),
  costUsd: z.number().nullable().default(null),
  model: z.string().nullable().default(null),
});
export type Usage = z.infer<typeof Usage>;

/** The result of running one trial through any AgentRunner. */
export const RunResult = z.object({
  sessionId: z.string().nullable().default(null),
  finalAnswer: z.string(),
  steps: z.array(TrajectoryStep),
  usage: Usage,
  latencyMs: z.number(),
  error: z.string().nullable().default(null),
});
export type RunResult = z.infer<typeof RunResult>;

// ---------------------------------------------------------------------------
// Status enums + API request shapes
// ---------------------------------------------------------------------------

export const TrialStatus = z.enum(["queued", "running", "done", "failed"]);
export type TrialStatus = z.infer<typeof TrialStatus>;

export const ExperimentStatus = z.enum([
  "pending",
  "running",
  "finished",
  "cancelled",
]);
export type ExperimentStatus = z.infer<typeof ExperimentStatus>;

export const CreateExperimentBody = z.object({
  suiteId: z.string().min(1),
  configIds: z.array(z.string().min(1)).min(1),
  baselineConfigId: z.string().min(1),
  repeats: z.number().int().positive().max(50).default(5),
  seed: z.number().int().default(1),
});
export type CreateExperimentBody = z.infer<typeof CreateExperimentBody>;

/** pg-boss job payload: one trial = task × config × repeat. */
export const TrialJob = z.object({
  experimentId: z.string(),
  taskId: z.string(),
  configId: z.string(),
  repIndex: z.number().int().min(0),
});
export type TrialJob = z.infer<typeof TrialJob>;

export const TRIAL_QUEUE = "trial" as const;
