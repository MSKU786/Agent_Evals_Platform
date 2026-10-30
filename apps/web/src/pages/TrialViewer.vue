<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, type TrialDetail } from "../api";
import { int, money, ms, pct } from "../format";

const props = defineProps<{ id: string }>();

const trial = ref<TrialDetail | null>(null);
const loading = ref(true);
const errorMsg = ref<string | null>(null);

const steps = computed(() => trial.value?.trajectory?.steps ?? []);

function prettyJson(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  return JSON.stringify(raw, null, 2);
}

onMounted(async () => {
  try {
    trial.value = await api.getTrial(props.id);
    if (!trial.value) throw new Error(`trial ${props.id} not found`);
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="stack">
    <n-alert v-if="errorMsg" type="error" title="Could not load trial">{{ errorMsg }}</n-alert>
    <n-spin v-if="loading && !trial" :show="true"><div style="height: 120px" /></n-spin>

    <template v-if="trial">
      <!-- Header -->
      <n-card>
        <n-space align="center" justify="space-between">
          <n-space align="center">
            <span class="mono" style="font-size: 16px; font-weight: 600">{{ trial.task.slug }}</span>
            <n-tag size="small" :bordered="false">config: {{ trial.config.name }}</n-tag>
            <n-tag size="small" :bordered="false">rep {{ trial.repIndex }}</n-tag>
          </n-space>
          <n-space align="center">
            <n-tag :type="trial.status === 'done' ? 'success' : trial.status === 'failed' ? 'error' : 'info'" round>
              {{ trial.status }}
            </n-tag>
            <n-tag v-if="trial.passed !== null" :type="trial.passed ? 'success' : 'error'" round>
              {{ trial.passed ? "passed" : "failed" }}
            </n-tag>
            <span v-if="trial.score !== null" class="muted">score {{ pct(trial.score) }}</span>
          </n-space>
        </n-space>
        <RouterLink class="muted" :to="`/experiments/${trial.experimentId}`" style="display: inline-block; margin-top: 8px">
          ← back to experiment report
        </RouterLink>
      </n-card>

      <n-alert v-if="trial.error" type="error" title="Trial error">{{ trial.error }}</n-alert>

      <!-- Metrics -->
      <n-card title="Metrics">
        <div class="kv">
          <div><div class="k">Input tokens</div><div class="v">{{ int(trial.inputTokens) }}</div></div>
          <div><div class="k">Output tokens</div><div class="v">{{ int(trial.outputTokens) }}</div></div>
          <div><div class="k">Cost</div><div class="v">{{ money(trial.costUsd) }}</div></div>
          <div><div class="k">Latency</div><div class="v">{{ ms(trial.latencyMs) }}</div></div>
        </div>
      </n-card>

      <!-- Graders — the point of the viewer -->
      <n-card title="Graders">
        <div v-if="trial.gradeResults.length === 0" class="muted">No grader results recorded.</div>
        <div v-for="g in trial.gradeResults" :key="g.id" class="stack" style="gap: 6px; margin-bottom: 14px">
          <n-space align="center">
            <n-tag size="small" :bordered="false">{{ g.graderType }}</n-tag>
            <n-tag size="small" :type="g.passed ? 'success' : 'error'" :bordered="false">
              {{ g.passed ? "PASS" : "FAIL" }}
            </n-tag>
            <span class="muted">score {{ pct(g.score) }}</span>
          </n-space>
          <div><strong>Reason:</strong> {{ g.reason }}</div>
          <n-collapse v-if="g.evidence">
            <n-collapse-item title="evidence">
              <pre class="block">{{ prettyJson(g.evidence) }}</pre>
            </n-collapse-item>
          </n-collapse>
        </div>
      </n-card>

      <!-- Final answer -->
      <n-card title="Final answer">
        <pre class="block" v-if="trial.finalAnswer">{{ trial.finalAnswer }}</pre>
        <span v-else class="muted">(none)</span>
      </n-card>

      <!-- Trajectory -->
      <n-card :title="`Trajectory (${steps.length} steps)`">
        <div v-if="steps.length === 0" class="muted">No trajectory recorded.</div>
        <div v-for="(s, i) in steps" :key="i" class="step" :class="s.role">
          <div class="role">
            {{ s.role }}<template v-if="s.toolName"> · {{ s.toolName }}</template>
          </div>
          <!-- tool outputs can be long → collapsible; other roles inline -->
          <n-collapse v-if="s.role === 'tool' && s.content">
            <n-collapse-item title="tool output">
              <pre class="block">{{ s.content }}</pre>
            </n-collapse-item>
          </n-collapse>
          <div v-else-if="s.content" class="content">{{ s.content }}</div>

          <!-- assistant tool calls -->
          <n-collapse v-if="s.toolCalls && s.toolCalls.length" style="margin-top: 6px">
            <n-collapse-item
              v-for="(tc, j) in s.toolCalls"
              :key="j"
              :title="`tool call: ${tc.name}`"
            >
              <pre class="block">{{ prettyJson(tc.arguments) }}</pre>
            </n-collapse-item>
          </n-collapse>

          <span v-if="s.finishReason" class="muted" style="font-size: 11px">finish: {{ s.finishReason }}</span>
        </div>
      </n-card>

      <!-- Rendered config -->
      <n-card title="Rendered config.yaml">
        <pre class="config" v-if="trial.renderedConfig">{{ trial.renderedConfig }}</pre>
        <span v-else class="muted">(none)</span>
      </n-card>
    </template>
  </div>
</template>
