<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api, type ExperimentListItem } from "../api";
import type { Verdict } from "@agent-evals/shared";
import { dateShort } from "../format";

const experiments = ref<ExperimentListItem[]>([]);
const verdicts = ref<Map<string, Verdict>>(new Map());
const loading = ref(true);
const errorMsg = ref<string | null>(null);

const verdictMeta: Record<Verdict, { type: "success" | "error" | "warning" | "default"; label: string }> = {
  better: { type: "success", label: "Better" },
  worse: { type: "error", label: "Worse" },
  "no-difference": { type: "warning", label: "No difference" },
  "insufficient-data": { type: "default", label: "Insufficient data" },
};

// Verdict is derived on read by the report endpoint; fetch it only for finished
// experiments (one small request each; fine at demo scale). The verdict shown is
// the first candidate-vs-baseline comparison.
async function loadVerdicts(rows: ExperimentListItem[]) {
  const finished = rows.filter((e) => e.status === "finished");
  await Promise.all(
    finished.map(async (e) => {
      try {
        const report = await api.getReport(e.id);
        const v = report.comparisons[0]?.verdict;
        if (v) verdicts.value.set(e.id, v);
      } catch {
        /* leave blank if the report can't be computed */
      }
    }),
  );
  // trigger reactivity on the Map
  verdicts.value = new Map(verdicts.value);
}

onMounted(async () => {
  try {
    experiments.value = await api.listExperiments();
    await loadVerdicts(experiments.value);
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="stack">
    <n-space align="center" justify="space-between">
      <h2 style="margin: 0; font-size: 16px">Experiments</h2>
      <RouterLink to="/new"><n-button type="primary" size="small">New experiment</n-button></RouterLink>
    </n-space>

    <n-alert v-if="errorMsg" type="error" title="Could not load experiments">{{ errorMsg }}</n-alert>
    <n-spin v-if="loading" :show="true"><div style="height: 80px" /></n-spin>

    <n-card v-if="!loading">
      <n-table :bordered="false" :single-line="false" size="small">
        <thead>
          <tr>
            <th>Experiment</th>
            <th>Status</th>
            <th>Suite</th>
            <th class="num">Configs</th>
            <th class="num">Repeats</th>
            <th>Created</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in experiments" :key="e.id">
            <td>
              <RouterLink class="mono" :to="`/experiments/${e.id}`">{{ e.id }}</RouterLink>
            </td>
            <td>
              <n-tag size="small" :type="e.status === 'finished' ? 'success' : e.status === 'running' ? 'info' : 'default'" :bordered="false">
                {{ e.status }}
              </n-tag>
            </td>
            <td><span class="mono">{{ e.suite.name }}</span> <span class="muted">{{ e.suite.version }}</span></td>
            <td class="num">{{ e._count.configs }}</td>
            <td class="num">{{ e.repeats }}</td>
            <td>{{ dateShort(e.createdAt) }}</td>
            <td>
              <n-tag
                v-if="e.status === 'finished' && verdicts.get(e.id)"
                size="small"
                :type="verdictMeta[verdicts.get(e.id)!].type"
                :bordered="false"
              >
                {{ verdictMeta[verdicts.get(e.id)!].label }}
              </n-tag>
              <span v-else class="muted">—</span>
            </td>
          </tr>
          <tr v-if="experiments.length === 0">
            <td colspan="7" class="muted">No experiments yet. Start one from the new-experiment form.</td>
          </tr>
        </tbody>
      </n-table>
    </n-card>
  </div>
</template>
