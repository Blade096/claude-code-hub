import { createCoverageConfig } from "../vitest.base";
export default createCoverageConfig({
  name: "text-transform-ui",
  environment: "happy-dom",
  testFiles: ["tests/unit/settings/text-transform-form.test.tsx"],
  sourceFiles: ["src/app/[[]locale]/settings/text-transform/text-transform-form.tsx"],
  thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
});
