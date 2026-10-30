<script setup lang="ts">
import { RouterView, RouterLink } from "vue-router";
</script>

<template>
  <n-message-provider>
    <div class="app-shell">
      <header class="app-header">
        <h1><RouterLink to="/">Agent Evals</RouterLink></h1>
        <span class="crumb">config comparison &amp; run inspection</span>
        <nav class="app-nav">
          <RouterLink to="/experiments">Experiments</RouterLink>
          <RouterLink to="/trials">Trials</RouterLink>
          <RouterLink to="/new">New</RouterLink>
        </nav>
      </header>
      <RouterView />
    </div>
  </n-message-provider>
</template>
