import { createCoverageConfig } from "../vitest.base";

export default createCoverageConfig({
  name: "text-transform",
  environment: "node",
  testFiles: [
    "tests/unit/proxy/text-transform.test.ts",
    "tests/unit/lib/text-transform-settings.test.ts",
    "tests/unit/lib/text-transform-api.test.ts",
    "tests/unit/lib/text-transform-repository.test.ts",
  ],
  sourceFiles: [
    "src/app/v1/_lib/proxy/text-transform/**/*.ts",
    "src/lib/text-transform/**/*.ts",
    "src/app/api/v1/resources/text-transform/**/*.ts",
    "src/repository/text-transform.ts",
  ],
  thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
});
