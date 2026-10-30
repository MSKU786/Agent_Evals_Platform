<script setup lang="ts">
import { computed } from "vue";
import type { Verdict } from "@agent-evals/shared";

const props = defineProps<{
  verdict: Verdict | null | undefined;
  baseline: string;
  candidate: string;
}>();

const meta = computed(() => {
  switch (props.verdict) {
    case "better":
      return { type: "success" as const, label: "Better" };
    case "worse":
      return { type: "error" as const, label: "Worse" };
    case "no-difference":
      return { type: "warning" as const, label: "No detectable difference" };
    default:
      return { type: "default" as const, label: "Insufficient data" };
  }
});
</script>

<template>
  <n-alert :type="meta.type" :show-icon="true">
    <template #header>
      <span style="font-size: 16px; font-weight: 700">{{ meta.label }}</span>
    </template>
    <span class="mono">{{ candidate }}</span> vs baseline
    <span class="mono">{{ baseline }}</span>
  </n-alert>
</template>
