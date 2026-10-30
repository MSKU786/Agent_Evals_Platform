import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: () => import("./pages/Landing.vue") },
    { path: "/experiments", component: () => import("./pages/ExperimentsList.vue") },
    { path: "/new", component: () => import("./pages/NewExperiment.vue") },
    { path: "/trials", component: () => import("./pages/TrialsList.vue") },
    {
      path: "/experiments/:id",
      component: () => import("./pages/ExperimentReport.vue"),
      props: true,
    },
    {
      path: "/trials/:id",
      component: () => import("./pages/TrialViewer.vue"),
      props: true,
    },
  ],
});
