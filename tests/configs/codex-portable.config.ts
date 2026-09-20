import { createCoverageConfig } from "../vitest.base";

export default createCoverageConfig({
  name: "codex-portable",
  environment: "happy-dom",
  testFiles: [
    "tests/unit/proxy/codex-portable-forwarder-seam.test.ts",
    "tests/unit/proxy/codex-portable-request-codec.test.ts",
    "tests/unit/proxy/codex-portable-response-codec.test.ts",
  ],
  sourceFiles: ["src/app/v1/_lib/proxy/codex-portable-compatibility/**/*.ts"],
  thresholds: {
    lines: 80,
    functions: 80,
    branches: 80,
    statements: 80,
  },
});
