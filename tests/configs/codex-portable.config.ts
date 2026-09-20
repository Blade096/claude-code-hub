import { createCoverageConfig } from "../vitest.base";

export default createCoverageConfig({
  name: "codex-portable",
  environment: "happy-dom",
  testFiles: [
    "tests/unit/proxy/codex-multi-agent-v2-gate.test.ts",
    "tests/unit/proxy/codex-portable-fake-streaming.test.ts",
    "tests/unit/proxy/codex-portable-forwarder-seam.test.ts",
    "tests/unit/proxy/codex-portable-request-codec.test.ts",
    "tests/unit/proxy/codex-portable-response-codec.test.ts",
    "tests/unit/proxy/codex-portable-sse-transform.test.ts",
    "tests/unit/proxy/codex-portable-websocket.test.ts",
    "tests/unit/proxy/remote-compaction-synthesizer.test.ts",
  ],
  sourceFiles: [
    "src/app/v1/_lib/proxy/codex-multi-agent-v2-gate.ts",
    "src/app/v1/_lib/proxy/codex-portable-compatibility/**/*.ts",
    "src/app/v1/_lib/proxy/fake-streaming/proxy-integration.ts",
    "src/app/v1/_lib/proxy/remote-compaction-synthesizer.ts",
  ],
  thresholds: {
    lines: 80,
    functions: 80,
    branches: 80,
    statements: 80,
  },
});
