import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      openclaw: path.resolve(process.env.HOME ?? "", "Downloads/openclaw-2026.5.4/src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.e2e.test.ts"],
  },
});
