import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const SERVICE = 'product-service';
const KIND = 'unit';
// Set by CI (scripts/ci/run-unit-tests.mjs); resolved against the repository root.
const reportsDir = process.env.JUNIT_REPORTS_DIR;
const coverageDir = process.env.COVERAGE_REPORTS_DIR;
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.int.test.ts'],
    reporters: reportsDir
      ? [
          'default',
          [
            'junit',
            {
              outputFile: resolve(repoRoot, reportsDir, KIND, `${SERVICE}.xml`),
              suiteName: `${SERVICE} ${KIND}`,
              suiteNameTemplate: ({ filename }) => `${SERVICE}/${filename}`,
              classnameTemplate: ({ basename }) => `${SERVICE}.${KIND}.${basename.replace(/\.test\.ts$/, '')}`,
            },
          ],
        ]
      : ['default'],
    // LCOV for SonarQube when CI sets COVERAGE_REPORTS_DIR: <dir>/<kind>/<service>/lcov.info
    coverage: {
      enabled: Boolean(coverageDir),
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: [['lcov', { projectRoot: repoRoot }], 'text-summary'],
      reportsDirectory: resolve(repoRoot, coverageDir ?? 'coverage', KIND, SERVICE),
    },
  },
});
