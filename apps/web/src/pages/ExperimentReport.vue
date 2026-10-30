<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { api, type ComparisonReport, type ExperimentDetail } from "../api";
import { ciPct, ciPp, int, money, ms, pct, pp, pval } from "../format";
import VerdictBanner from "../components/VerdictBanner.vue";

const props = defineProps<{ id: string }>();

const experiment = ref<ExperimentDetail | null>(null);
const report = ref<ComparisonReport | null>(null);
const candidateId = ref<string | null>(null);
const trialByKey = ref<Map<string, string>>(new Map());
const loading = ref(true);
const errorMsg = ref<string | null>(null);
let pollTimer: ReturnType<typeof setInterval> | null = null;

const baselineId = computed(() => experiment.value?.baselineConfigId ?? null);

const candidates = computed(() =>
  (experiment.value?.configs ?? [])
    .map((c) => c.configId)
    .filter((cid) => cid !== baselineId.value),
);

function configName(cid: string | null | undefined): string {
  if (!cid) return "—";
  return report.value?.configs.find((c) => c.configId === cid)?.name ?? cid;
}

const comparison = computed(() =>
  report.value?.comparisons.find((c) => c.configId === candidateId.value) ?? null,
);
const baselineSummary = computed(() =>
  report.value?.configs.find((c) => c.configId === baselineId.value) ?? null,
);
const candidateSummary = computed(() =>
  report.value?.configs.find((c) => c.configId === candidateId.value) ?? null,
);

const progressTotal = computed(() => experiment.value?.expected ?? 0);
const progressDone = computed(() => {
  const p = experiment.value?.progress ?? {};
  return (p.done ?? 0) + (p.failed ?? 0);
});
const isRunning = computed(() => experiment.value?.status === "running");

const candidateOptions = computed(() =>
  candidates.value.map((cid) => ({ label: configName(cid), value: cid })),
);

function trialLink(taskId: string, configId: string | null): string | null {
  if (!configId) return null;
  const id = trialByKey.value.get(`${taskId}|${configId}`);
  return id ? `/trials/${id}` : null;
}

async function loadExperiment() {
  const exp = await api.getExperiment(props.id);
  if (!exp) throw new Error(`experiment ${props.id} not found`);
  experiment.value = exp;
  if (!candidateId.value && candidates.value.length > 0) {
    candidateId.value = candidates.value[0];
  }
}

async function loadReport() {
  report.value = await api.getReport(props.id, candidateId.value ?? undefined);
}

async function loadTrialsMap() {
  const trials = await api.listTrials({ experimentId: props.id });
  const map = new Map<string, string>();
  // list is ordered by task/config/rep; keep the first (rep 0) per task+config.
  for (const t of trials) {
    const key = `${t.taskId}|${t.configId}`;
    if (!map.has(key)) map.set(key, t.id);
  }
  trialByKey.value = map;
}

async function refresh(initial = false) {
  try {
    if (initial) loading.value = true;
    await loadExperiment();
    await Promise.all([loadReport(), loadTrialsMap()]);
    errorMsg.value = null;
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
    syncPolling();
  }
}

function syncPolling() {
  if (isRunning.value && !pollTimer) {
    pollTimer = setInterval(() => void refresh(), 3000);
  } else if (!isRunning.value && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

watch(candidateId, () => {
  if (!loading.value) void loadReport();
});

onMounted(() => void refresh(true));
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div class="stack">
    <n-alert v-if="errorMsg" type="error" title="Could not load experiment">
      {{ errorMsg }}
    </n-alert>

    <n-spin v-if="loading && !experiment" :show="true">
      <div style="height: 120px" />
    </n-spin>

    <template v-if="experiment">
      <!-- Status + progress -->
      <n-card>
        <n-space align="center" justify="space-between">
          <n-space align="center">
            <n-tag :type="isRunning ? 'info' : 'success'" round>{{ experiment.status }}</n-tag>
            <span class="muted mono">{{ experiment.id }}</span>
          </n-space>
          <n-space v-if="candidates.length > 1" align="center">
            <span class="muted">compare</span>
            <n-select
              v-model:value="candidateId"
              :options="candidateOptions"
              style="width: 220px"
            />
            <span class="muted">vs {{ configName(baselineId) }}</span>
          </n-space>
        </n-space>
        <div style="margin-top: 12px">
          <n-progress
            type="line"
            :percentage="progressTotal ? Math.round((progressDone / progressTotal) * 100) : 0"
            :processing="isRunning"
            indicator-placement="inside"
          />
          <span class="muted">{{ progressDone }} / {{ progressTotal }} trials settled</span>
        </div>
      </n-card>

      <!-- Verdict -->
      <VerdictBanner
        :verdict="comparison?.verdict"
        :baseline="configName(baselineId)"
        :candidate="configName(candidateId)"
      />

      <!-- Paired effect -->
      <n-card title="Paired effect (candidate − baseline, task-level)">
        <div class="kv" v-if="comparison">
          <div><div class="k">Effect</div><div class="v">{{ pp(comparison.effect) }}</div></div>
          <div><div class="k">95% CI</div><div class="v">{{ ciPp(comparison.effectCI.lo, comparison.effectCI.hi) }}</div></div>
          <div><div class="k">p-value</div><div class="v">{{ pval(comparison.pValue) }}</div></div>
          <div v-if="report && report.comparisons.length > 1">
            <div class="k">p (Holm)</div><div class="v">{{ pval(comparison.pValueAdjusted) }}</div>
          </div>
          <div><div class="k">Tasks</div><div class="v">{{ report?.tasks ?? 0 }}</div></div>
          <div><div class="k">Repeats</div><div class="v">{{ report?.repeats ?? 0 }}</div></div>
        </div>
        <p v-else class="muted" style="margin: 0">No completed trials yet.</p>
        <p v-if="report" class="muted" style="margin: 12px 0 0">
          Bootstrap {{ int(report.bootstrapResamples) }} resamples, seed {{ report.seed }}.
          CI entirely above 0 → Better; entirely below → Worse; otherwise no detectable difference.
        </p>
      </n-card>

      <!-- Per-config pass rate -->
      <n-card title="Pass rate per config (mean over tasks, with 95% CI)">
        <n-table :bordered="false" :single-line="false" size="small">
          <thead>
            <tr>
              <th>Config</th>
              <th class="num">Pass rate</th>
              <th class="num">95% CI</th>
              <th class="num">Mean cost</th>
              <th class="num">Mean latency</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="baselineSummary">
              <td><span class="mono">{{ baselineSummary.name }}</span> <n-tag size="tiny" :bordered="false">baseline</n-tag></td>
              <td class="num">{{ pct(baselineSummary.passRate) }}</td>
              <td class="num">{{ ciPct(baselineSummary.passRateCI.lo, baselineSummary.passRateCI.hi) }}</td>
              <td class="num">{{ money(baselineSummary.meanCostUsd) }}</td>
              <td class="num">{{ ms(baselineSummary.meanLatencyMs) }}</td>
            </tr>
            <tr v-if="candidateSummary">
              <td><span class="mono">{{ candidateSummary.name }}</span> <n-tag size="tiny" type="info" :bordered="false">candidate</n-tag></td>
              <td class="num">{{ pct(candidateSummary.passRate) }}</td>
              <td class="num">{{ ciPct(candidateSummary.passRateCI.lo, candidateSummary.passRateCI.hi) }}</td>
              <td class="num">{{ money(candidateSummary.meanCostUsd) }}</td>
              <td class="num">{{ ms(candidateSummary.meanLatencyMs) }}</td>
            </tr>
          </tbody>
        </n-table>
      </n-card>

      <!-- Per-task breakdown -->
      <n-card title="Per-task breakdown">
        <n-table :bordered="false" :single-line="false" size="small">
          <thead>
            <tr>
              <th>Task</th>
              <th class="num">{{ configName(baselineId) }} (A)</th>
              <th class="num">{{ configName(candidateId) }} (B)</th>
              <th class="num">Diff (B − A)</th>
              <th>Flaky</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in report?.perTask ?? []" :key="t.taskId">
              <td class="mono">{{ t.slug }}</td>
              <td class="num">
                <RouterLink v-if="baselineId && trialLink(t.taskId, baselineId)" :to="trialLink(t.taskId, baselineId)!">
                  {{ pct(t.byConfig[baselineId]) }}
                </RouterLink>
                <span v-else>{{ pct(t.byConfig[baselineId ?? '']) }}</span>
              </td>
              <td class="num">
                <RouterLink v-if="candidateId && trialLink(t.taskId, candidateId)" :to="trialLink(t.taskId, candidateId)!">
                  {{ pct(t.byConfig[candidateId]) }}
                </RouterLink>
                <span v-else>{{ pct(candidateId ? t.byConfig[candidateId] : undefined) }}</span>
              </td>
              <td class="num">{{ pp(t.diff) }}</td>
              <td><n-tag v-if="t.flaky" size="small" type="warning" :bordered="false">flaky</n-tag></td>
            </tr>
            <tr v-if="(report?.perTask ?? []).length === 0">
              <td colspan="5" class="muted">No completed trials yet.</td>
            </tr>
          </tbody>
        </n-table>
        <p class="muted" style="margin: 12px 0 0">Click a score to open that task's run for this config.</p>
      </n-card>
    </template>
  </div>
</template>
