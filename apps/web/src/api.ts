// Thin fetch wrapper to the NestJS API. Base URL from env (default localhost:3000).
// Response-shaping types reuse the zod-inferred types from packages/shared where
// they exist, so the UI and API can't drift. Prisma row shapes (Experiment, Trial)
// are declared here to match the controllers in apps/api.
import type {
  ComparisonReport,
  TrajectoryStep,
  Usage,
} from "@agent-evals/shared";

export type { ComparisonReport, TrajectoryStep, Usage };

const BASE = (import.meta.env.VITE_API_BASE ?? "http://localhost:3000").replace(/\/+$/, "");

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} → ${res.status}${body ? `: ${body}` : ""}`);
  }
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${path} → ${res.status}${text ? `: ${text}` : ""}`);
  }
  return (await res.json()) as T;
}

// --- Experiment (GET /experiments/:id) ---
export interface ExperimentConfigRow {
  experimentId: string;
  configId: string;
}
export interface ExperimentDetail {
  id: string;
  suiteId: string;
  baselineConfigId: string;
  repeats: number;
  seed: number;
  status: string;
  hermesVersion: string | null;
  createdAt: string;
  finishedAt: string | null;
  configs: ExperimentConfigRow[];
  progress: Record<string, number>;
  expected: number;
}

// --- Trial (GET /trials/:id and GET /trials?...) ---
export interface GradeResultRow {
  id: string;
  trialId: string;
  graderType: string;
  score: number;
  passed: boolean;
  reason: string;
  evidence: unknown;
}
export interface TrialDetail {
  id: string;
  experimentId: string;
  taskId: string;
  configId: string;
  repIndex: number;
  status: string;
  finalAnswer: string | null;
  score: number | null;
  passed: boolean | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number | null;
  error: string | null;
  trajectory: { steps: TrajectoryStep[]; usage: Usage } | null;
  renderedConfig: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  gradeResults: GradeResultRow[];
  task: { id: string; slug: string; spec: unknown; tags: string[] };
  config: { id: string; name: string; spec: unknown; configHash: string };
}
export interface TrialListItem {
  id: string;
  experimentId: string;
  taskId: string;
  configId: string;
  repIndex: number;
  status: string;
  finalAnswer: string | null;
  score: number | null;
  passed: boolean | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number | null;
  error: string | null;
}

// --- Experiment list (GET /experiments) ---
export interface ExperimentListItem {
  id: string;
  suiteId: string;
  baselineConfigId: string;
  repeats: number;
  seed: number;
  status: string;
  hermesVersion: string | null;
  createdAt: string;
  finishedAt: string | null;
  suite: { name: string; version: string };
  _count: { configs: number };
}

// --- Suites (GET /suites) and configs (GET /configs) ---
export interface SuiteListItem {
  id: string;
  name: string;
  version: string;
  createdAt: string;
  _count: { tasks: number };
}
export interface ConfigRow {
  id: string;
  name: string;
  spec: unknown;
  configHash: string;
  createdAt: string;
}

export interface CreateExperimentResult {
  id: string;
  status: string;
  plannedTrials: number;
}

export const api = {
  getExperiment: (id: string) => getJson<ExperimentDetail>(`/experiments/${id}`),
  listExperiments: () => getJson<ExperimentListItem[]>("/experiments"),
  createExperiment: (body: {
    suiteId: string;
    configIds: string[];
    baselineConfigId: string;
    repeats: number;
  }) => postJson<CreateExperimentResult>("/experiments", body),
  getReport: (id: string, vs?: string) =>
    getJson<ComparisonReport>(
      `/experiments/${id}/report${vs ? `?vs=${encodeURIComponent(vs)}` : ""}`,
    ),
  getTrial: (id: string) => getJson<TrialDetail>(`/trials/${id}`),
  listTrials: (q: {
    experimentId?: string;
    taskId?: string;
    configId?: string;
    passed?: boolean;
  }) => {
    const p = new URLSearchParams();
    if (q.experimentId) p.set("experimentId", q.experimentId);
    if (q.taskId) p.set("taskId", q.taskId);
    if (q.configId) p.set("configId", q.configId);
    if (q.passed !== undefined) p.set("passed", String(q.passed));
    const qs = p.toString();
    return getJson<TrialListItem[]>(`/trials${qs ? `?${qs}` : ""}`);
  },
  listSuites: () => getJson<SuiteListItem[]>("/suites"),
  listConfigs: () => getJson<ConfigRow[]>("/configs"),
};
