<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api, type ExperimentListItem, type TrialListItem } from "../api";
import { money, ms, pct } from "../format";

const experiments = ref<ExperimentListItem[]>([]);
const trials = ref<TrialListItem[]>([]);
const taskName = ref<Map<string, string>>(new Map());
const configName = ref<Map<string, string>>(new Map());

const experimentId = ref<string | null>(null);
const taskId = ref<string | null>(null);
const configId = ref<string | null>(null);
const passed = ref<"all" | "pass" | "fail">("all");

const loading = ref(true);
const errorMsg = ref<string | null>(null);

const experimentOptions = computed(() =>
  experiments.value.map((e) => ({ label: `${e.id} (${e.suite.name})`, value: e.id })),
);
const taskOptions = computed(() => [
  { label: "All tasks", value: "" },
  ...[...taskName.value].map(([id, slug]) => ({ label: slug, value: id })),
]);
const configOptions = computed(() => [
  { label: "All configs", value: "" },
  ...[...configName.value].map(([id, name]) => ({ label: name, value: id })),
]);
const passedOptions = [
  { label: "All", value: "all" },
  { label: "Passed", value: "pass" },
  { label: "Failed", value: "fail" },
];

function taskLabel(id: string): string {
  return taskName.value.get(id) ?? id;
}
function configLabel(id: string): string {
  return configName.value.get(id) ?? id;
}

// Build task/config name maps for the selected experiment from its report.
async function loadNameMaps(expId: string) {
  taskName.value = new Map();
  configName.value = new Map();
  try {
    const report = await api.getReport(expId);
    configName.value = new Map(report.configs.map((c) => [c.configId, c.name]));
    taskName.value = new Map(report.perTask.map((t) => [t.taskId, t.slug]));
  } catch {
    /* no report yet (e.g. no settled trials) — fall back to ids */
  }
}

async function loadTrials() {
  if (!experimentId.value) {
    trials.value = [];
    return;
  }
  trials.value = await api.listTrials({
    experimentId: experimentId.value,
    taskId: taskId.value || undefined,
    configId: configId.value || undefined,
    passed: passed.value === "all" ? undefined : passed.value === "pass",
  });
}

async function onExperimentChange() {
  if (!experimentId.value) return;
  taskId.value = null;
  configId.value = null;
  await loadNameMaps(experimentId.value);
  await loadTrials();
}

watch([taskId, configId, passed], () => void loadTrials());

onMounted(async () => {
  try {
    experiments.value = await api.listExperiments();
    if (experiments.value.length > 0) {
      experimentId.value = experiments.value[0].id;
      await onExperimentChange();
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="stack">
    <h2 style="margin: 0; font-size: 16px">Trials</h2>

    <n-alert v-if="errorMsg" type="error" title="Could not load trials">{{ errorMsg }}</n-alert>

    <n-card>
      <n-space align="center" wrap>
        <div>
          <div class="muted" style="font-size: 12px">Experiment</div>
          <n-select
            v-model:value="experimentId"
            :options="experimentOptions"
            style="width: 300px"
            @update:value="onExperimentChange"
          />
        </div>
        <div>
          <div class="muted" style="font-size: 12px">Task</div>
          <n-select v-model:value="taskId" :options="taskOptions" style="width: 180px" />
        </div>
        <div>
          <div class="muted" style="font-size: 12px">Config</div>
          <n-select v-model:value="configId" :options="configOptions" style="width: 180px" />
        </div>
        <div>
          <div class="muted" style="font-size: 12px">Result</div>
          <n-select v-model:value="passed" :options="passedOptions" style="width: 130px" />
        </div>
      </n-space>
    </n-card>

    <n-card>
      <n-table :bordered="false" :single-line="false" size="small">
        <thead>
          <tr>
            <th>Trial</th>
            <th>Task</th>
            <th>Config</th>
            <th class="num">Rep</th>
            <th>Status</th>
            <th>Result</th>
            <th class="num">Score</th>
            <th class="num">Cost</th>
            <th class="num">Latency</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in trials" :key="t.id">
            <td><RouterLink class="mono" :to="`/trials/${t.id}`">open</RouterLink></td>
            <td class="mono">{{ taskLabel(t.taskId) }}</td>
            <td class="mono">{{ configLabel(t.configId) }}</td>
            <td class="num">{{ t.repIndex }}</td>
            <td>
              <n-tag size="small" :type="t.status === 'done' ? 'success' : t.status === 'failed' ? 'error' : 'info'" :bordered="false">
                {{ t.status }}
              </n-tag>
            </td>
            <td>
              <n-tag v-if="t.passed !== null" size="small" :type="t.passed ? 'success' : 'error'" :bordered="false">
                {{ t.passed ? "pass" : "fail" }}
              </n-tag>
              <span v-else class="muted">—</span>
            </td>
            <td class="num">{{ pct(t.score) }}</td>
            <td class="num">{{ money(t.costUsd) }}</td>
            <td class="num">{{ ms(t.latencyMs) }}</td>
          </tr>
          <tr v-if="!loading && trials.length === 0">
            <td colspan="9" class="muted">No trials match these filters.</td>
          </tr>
        </tbody>
      </n-table>
    </n-card>
  </div>
</template>
