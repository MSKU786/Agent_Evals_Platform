<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";

const router = useRouter();
const experimentId = ref("");
const trialId = ref("");

function openExperiment() {
  const id = experimentId.value.trim();
  if (id) router.push(`/experiments/${id}`);
}
function openTrial() {
  const id = trialId.value.trim();
  if (id) router.push(`/trials/${id}`);
}
</script>

<template>
  <div class="stack">
    <n-card title="Open an experiment report">
      <n-space>
        <n-input
          v-model:value="experimentId"
          placeholder="experiment id"
          style="width: 360px"
          @keyup.enter="openExperiment"
        />
        <n-button type="primary" :disabled="!experimentId.trim()" @click="openExperiment">
          Open report
        </n-button>
      </n-space>
    </n-card>

    <n-card title="Open a single trial">
      <n-space>
        <n-input
          v-model:value="trialId"
          placeholder="trial id"
          style="width: 360px"
          @keyup.enter="openTrial"
        />
        <n-button :disabled="!trialId.trim()" @click="openTrial">Open trial</n-button>
      </n-space>
    </n-card>

    <n-card>
      <p class="muted" style="margin: 0 0 8px">
        Paste an experiment id to see the verdict, confidence intervals and the
        per-task breakdown; drill into any task's runs to inspect the full
        trajectory and grader reasons. Or browse from here:
      </p>
      <n-space>
        <RouterLink to="/experiments"><n-button size="small">All experiments</n-button></RouterLink>
        <RouterLink to="/trials"><n-button size="small">Browse trials</n-button></RouterLink>
        <RouterLink to="/new"><n-button size="small" type="primary">New experiment</n-button></RouterLink>
      </n-space>
    </n-card>
  </div>
</template>
