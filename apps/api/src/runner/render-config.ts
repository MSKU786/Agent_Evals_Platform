import { dump } from "js-yaml";
import type { AgentConfigSpec } from "@agent-evals/shared";

/**
 * Render the Hermes `config.yaml` a trial would run under. Stored on the Trial
 * as `renderedConfig` so a run record shows exactly what Hermes saw. Model and
 * provider are also passed as CLI flags; memory is config-only.
 */
export function renderHermesConfig(spec: AgentConfigSpec): string {
  const config: Record<string, unknown> = {
    model: {
      provider: spec.provider,
      default: spec.model,
      ...(spec.temperature !== undefined
        ? { temperature: spec.temperature }
        : {}),
    },
    memory: {
      memory_enabled: spec.memoryEnabled,
      user_profile_enabled: spec.memoryEnabled,
    },
    agent: {
      max_turns: spec.maxTurns,
    },
  };
  return dump(config, { lineWidth: 100 });
}
