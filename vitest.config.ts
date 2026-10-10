import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { obsidian: resolve(__dirname, "test/mocks/obsidian.ts") },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
