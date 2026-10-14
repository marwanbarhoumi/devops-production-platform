import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const SERVICE = 'order-service';
const KIND = 'unit';
// Set by CI (scripts/ci/run-unit-tests.mjs); resolved against the repository root.
const reportsDir = process.env.JUNIT_REPORTS_DIR;
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
  },
});
