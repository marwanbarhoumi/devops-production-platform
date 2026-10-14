#!/usr/bin/env node
// Runs the unit/API tests of every workspace and writes one JUnit report per service:
//   reports/junit/unit/<service>.xml
//
//   npm run test:ci
//
// Every suite runs even if an earlier one fails, so Jenkins always receives all reports.
// Exits non-zero if any suite fails or any expected report is missing.
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot, run, serviceName, verifyJUnitReports, workspaces } from './lib.mjs';

const reportsDir = resolve(repoRoot, process.env.JUNIT_REPORTS_DIR ?? 'reports/junit');
const unitDir = resolve(reportsDir, 'unit');
// LCOV for SonarQube: reports/coverage/unit/<service>/lcov.info
const coverageDir = resolve(repoRoot, process.env.COVERAGE_REPORTS_DIR ?? 'reports/coverage');
rmSync(unitDir, { recursive: true, force: true });
rmSync(resolve(coverageDir, 'unit'), { recursive: true, force: true });

const failedSuites = [];
const expectedReports = [];
for (const workspace of workspaces()) {
  const service = serviceName(workspace);
  console.log(`\n=== Unit/API tests: ${service} ===`);
  expectedReports.push(resolve(unitDir, `${service}.xml`));
  const { code } = await run('npm', ['run', 'test', '--workspace', workspace], {
    env: { ...process.env, JUNIT_REPORTS_DIR: reportsDir, COVERAGE_REPORTS_DIR: coverageDir },
  });
  if (code !== 0) failedSuites.push(service);
}

const reportProblems = verifyJUnitReports(expectedReports);
for (const problem of reportProblems) console.error(`ERROR: ${problem}`);
if (failedSuites.length > 0) console.error(`ERROR: unit/API tests failed in: ${failedSuites.join(', ')}`);

if (failedSuites.length > 0 || reportProblems.length > 0) process.exit(1);
console.log(`\nUnit/API tests passed. JUnit reports: ${unitDir}`);
