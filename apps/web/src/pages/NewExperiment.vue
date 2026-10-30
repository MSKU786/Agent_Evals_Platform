<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api, type ConfigRow, type SuiteListItem } from "../api";

const router = useRouter();

const suites = ref<SuiteListItem[]>([]);
const configs = ref<ConfigRow[]>([]);

const suiteId = ref<string | null>(null);
const configIds = ref<string[]>([]);
const baselineConfigId = ref<string | null>(null);
const repeats = ref<number>(5);

const submitting = ref(false);
const loadError = ref<string | null>(null);
const submitError = ref<string | null>(null);

const suiteOptions = computed(() =>
  suites.value.map((s) => ({
    label: `${s.name} ${s.version} (${s._count.tasks} tasks)`,
    value: s.id,
  })),
);
const configOptions = computed(() =>
  configs.value.map((c) => ({ label: c.name, value: c.id })),
);
// Baseline must be one of the chosen configs.
const baselineOptions = computed(() =>
  configIds.value.map((id) => ({
    label: configs.value.find((c) => c.id === id)?.name ?? id,
    value: id,
  })),
);

// Keep the baseline valid as the config selection changes.
watch(configIds, (ids) => {
  if (baselineConfigId.value && !ids.includes(baselineConfigId.value)) {
    baselineConfigId.value = null;
  }
  if (!baselineConfigId.value && ids.length > 0) {
    baselineConfigId.value = ids[0];
  }
});

const canSubmit = computed(
  () =>
    !!suiteId.value &&
    configIds.value.length >= 1 &&
    !!baselineConfigId.value &&
    repeats.value >= 1,
);

async function submit() {
  if (!canSubmit.value || !suiteId.value || !baselineConfigId.value) return;
  submitting.value = true;
  submitError.value = null;
  try {
    const res = await api.createExperiment({
      suiteId: suiteId.value,
      configIds: configIds.value,
      baselineConfigId: baselineConfigId.value,
      repeats: repeats.value,
    });
    router.push(`/experiments/${res.id}`);
  } catch (e) {
    submitError.value = e instanceof Error ? e.message : String(e);
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  try {
    [suites.value, configs.value] = await Promise.all([
      api.listSuites(),
      api.listConfigs(),
    ]);
    if (suites.value.length > 0) suiteId.value = suites.value[0].id;
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  }
});
</script>

<template>
  <div class="stack">
    <h2 style="margin: 0; font-size: 16px">New experiment</h2>

    <n-alert v-if="loadError" type="error" title="Could not load suites/configs">{{ loadError }}</n-alert>

    <n-card>
      <n-form label-placement="top" @submit.prevent="submit">
        <n-form-item label="Suite">
          <n-select v-model:value="suiteId" :options="suiteOptions" placeholder="pick a suite" />
        </n-form-item>

        <n-form-item label="Configs (pick one or more to compare)">
          <n-select
            v-model:value="configIds"
            :options="configOptions"
            multiple
            placeholder="pick configs"
          />
        </n-form-item>

        <n-form-item label="Baseline (compared against)">
          <n-select
            v-model:value="baselineConfigId"
            :options="baselineOptions"
            :disabled="configIds.length === 0"
            placeholder="pick the baseline config"
          />
        </n-form-item>

        <n-form-item label="Repeats per task per config">
          <n-input-number v-model:value="repeats" :min="1" :max="50" style="width: 160px" />
        </n-form-item>

        <n-alert v-if="submitError" type="error" title="Could not start experiment" style="margin-bottom: 12px">
          {{ submitError }}
        </n-alert>

        <n-space align="center">
          <n-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="submit">
            Start experiment
          </n-button>
          <span class="muted">
            Enqueues {{ configIds.length }} config(s) × repeats per task, then opens the report.
          </span>
        </n-space>
      </n-form>
    </n-card>
  </div>
</template>
