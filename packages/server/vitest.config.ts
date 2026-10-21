import { defineConfig } from "vitest/config";
export default defineConfig({ test: { passWithNoTests: true, testTimeout: 60000, hookTimeout: 60000, pool: "forks" } });
