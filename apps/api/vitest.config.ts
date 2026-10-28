import { defineConfig } from "vitest/config";

// Local config so vitest doesn't walk up to an unrelated parent config.
export default defineConfig({
  test: {
    root: __dirname,
    include: ["test/**/*.test.ts"],
  },
});
