import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Thin dev server. The browser (on the host) talks to the API at
// VITE_API_BASE (default http://localhost:3000), which docker compose publishes.
export default defineConfig({
  plugins: [vue()],
  server: { host: true, port: 5173, strictPort: true },
  preview: { host: true, port: 5173, strictPort: true },
});
