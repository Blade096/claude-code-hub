import { createCoverageConfig } from "../vitest.base";

export default createCoverageConfig({
  name: "codex-multi-agent-v2-gate",
  environment: "happy-dom",
  testFiles: ["tests/unit/proxy/codex-multi-agent-v2-gate.test.ts"],
  sourceFiles: ["src/app/v1/_lib/proxy/codex-multi-agent-v2-gate.ts"],
  thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
});
