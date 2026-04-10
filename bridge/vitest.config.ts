import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/runtime/__tests__/**/*.test.ts"],
    reporter: "verbose",
  },
});
