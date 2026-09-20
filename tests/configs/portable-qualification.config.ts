import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { sharedResolve } from "../vitest.base";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: [path.resolve(root, "tests/setup.ts")],
    include: ["tests/unit/e2e/portable-qualification.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json"],
      reportsDirectory: path.resolve(root, "coverage/portable-qualification"),
      include: ["tests/e2e/_helpers/portable-qualification.ts"],
      exclude: ["node_modules/", "**/*.d.ts"],
      thresholds: { lines: 75, functions: 75, branches: 70, statements: 75 },
    },
    reporters: ["verbose"],
    isolate: true,
    mockReset: true,
    restoreMocks: true,
    clearMocks: true,
  },
  resolve: sharedResolve(),
});
