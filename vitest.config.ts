import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    testTimeout: 30_000,
    reporters: ["default"],
    projects: [
      {
        test: {
          name: "node",
          include: ["tests/**/*.test.ts"],
          environment: "node",
          testTimeout: 30_000,
        },
      },
      {
        plugins: [react()],
        resolve: { alias: { "@src": resolve(here, "src") } },
        test: {
          name: "web",
          include: ["web/src/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["web/src/test-setup.ts"],
          testTimeout: 30_000,
        },
      },
    ],
  },
});
