#!/usr/bin/env node
// Starts the local SonarQube and prepares it for Jenkins. Safe to re-run; no secret is ever printed.
//
//   node security/sonarqube/bootstrap.mjs                 # start + set up
//   node security/sonarqube/bootstrap.mjs --rotate-token  # also replace the Jenkins analysis token
//
// 1. Creates security/sonarqube/.env with a random database password (first run only).
// 2. Starts the stack (docker compose up -d --wait).
// 3. Replaces the default admin/admin password with a random one, saved to
//    security/sonarqube/secrets/admin-password (git-ignored; use it to log in to the UI).
// 4. Creates the private project "devops-production-platform" (main branch: main).
// 5. Generates a project analysis token named "jenkins-ci" (scoped to this project only) and writes it
//    to jenkins/secrets/sonarqube-token (git-ignored). Import it into Jenkins with
//    node jenkins/import-credential.mjs --id sonarqube-token --file jenkins/secrets/sonarqube-token
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const envFile = resolve(here, '.env');
const adminPasswordFile = resolve(here, 'secrets/admin-password');
const tokenFile = resolve(repoRoot, 'jenkins/secrets/sonarqube-token');
const PROJECT_KEY = 'devops-production-platform';
const TOKEN_NAME = 'jenkins-ci';
const rotateToken = process.argv.includes('--rotate-token');

function readEnvValue(name) {
  if (!existsSync(envFile)) return undefined;
  const line = readFileSync(envFile, 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim() || undefined;
}

const port = process.env.SONARQUBE_HTTP_PORT ?? readEnvValue('SONARQUBE_HTTP_PORT') ?? '9100';
const baseUrl = `http://127.0.0.1:${port}`;

function writeSecret(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value, { encoding: 'ascii', mode: 0o600 });
}

/** SonarQube rejects weak passwords (12+ chars with upper, lower, digit and special character). */
const strongPassword = () => `${randomBytes(18).toString('base64url')}aA1!`;

async function api(method, path, { auth, form } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Basic ${Buffer.from(`${auth.user}:${auth.password}`).toString('base64')}`;
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body });
  const text = await res.text();
  return { status: res.status, json: text.startsWith('{') ? JSON.parse(text) : undefined, text };
}

function step(message) {
  console.log(`[sonarqube] ${message}`);
}

// 1. Database password
if (!readEnvValue('SONARQUBE_DB_PASSWORD')) {
  const existing = existsSync(envFile) ? readFileSync(envFile, 'utf8').replace(/\s*$/, '\n') : '';
  writeFileSync(envFile, `${existing}SONARQUBE_DB_PASSWORD=${randomBytes(24).toString('base64url')}\n`, { mode: 0o600 });
  step('created security/sonarqube/.env with a random database password');
}

// 2. Start
step('starting the stack (first start pulls images and can take a few minutes)');
const up = spawnSync('docker', ['compose', 'up', '-d', '--wait'], { cwd: here, stdio: 'inherit' });
if (up.status !== 0) {
  console.error('[sonarqube] ERROR: docker compose up failed; see the output above.');
  process.exit(1);
}
const deadline = Date.now() + 5 * 60_000;
for (;;) {
  const status = await api('GET', '/api/system/status').catch(() => undefined);
  if (status?.json?.status === 'UP') break;
  if (Date.now() > deadline) {
    console.error(`[sonarqube] ERROR: SonarQube is not UP at ${baseUrl} (status: ${status?.json?.status ?? 'unreachable'})`);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
step(`UP at ${baseUrl}`);

// 3. Admin password
let admin;
if (existsSync(adminPasswordFile)) {
  admin = { user: 'admin', password: readFileSync(adminPasswordFile, 'ascii').trim() };
  if ((await api('GET', '/api/authentication/validate', { auth: admin })).json?.valid !== true) {
    console.error('[sonarqube] ERROR: the password in security/sonarqube/secrets/admin-password is not accepted.');
    process.exit(1);
  }
} else {
  const initial = { user: 'admin', password: 'admin' };
  if ((await api('GET', '/api/authentication/validate', { auth: initial })).json?.valid !== true) {
    console.error(
      '[sonarqube] ERROR: the admin password was already changed but security/sonarqube/secrets/admin-password is missing.\n' +
        'Write the current admin password to that file (no newline) and re-run.',
    );
    process.exit(1);
  }
  const password = strongPassword();
  const changed = await api('POST', '/api/users/change_password', {
    auth: initial,
    form: { login: 'admin', previousPassword: 'admin', password },
  });
  if (changed.status !== 204) {
    console.error(`[sonarqube] ERROR: could not change the default admin password (HTTP ${changed.status}).`);
    process.exit(1);
  }
  writeSecret(adminPasswordFile, password);
  admin = { user: 'admin', password };
  step('replaced the default admin password; saved to security/sonarqube/secrets/admin-password');
}

// 4. Project
const search = await api('GET', `/api/projects/search?projects=${PROJECT_KEY}`, { auth: admin });
if (search.json?.components?.length) {
  step(`project ${PROJECT_KEY} exists`);
} else {
  const created = await api('POST', '/api/projects/create', {
    auth: admin,
    form: { project: PROJECT_KEY, name: PROJECT_KEY, mainBranch: 'main', visibility: 'private' },
  });
  if (created.status !== 200) {
    console.error(`[sonarqube] ERROR: could not create project ${PROJECT_KEY} (HTTP ${created.status}): ${created.text}`);
    process.exit(1);
  }
  step(`created private project ${PROJECT_KEY}`);
}

// 5. Jenkins analysis token
if (existsSync(tokenFile) && !rotateToken) {
  step('jenkins/secrets/sonarqube-token already exists (use --rotate-token to replace it)');
} else {
  const tokens = await api('GET', '/api/user_tokens/search', { auth: admin });
  if (tokens.json?.userTokens?.some((t) => t.name === TOKEN_NAME)) {
    await api('POST', '/api/user_tokens/revoke', { auth: admin, form: { name: TOKEN_NAME } });
    step(`revoked the previous ${TOKEN_NAME} token`);
  }
  const generated = await api('POST', '/api/user_tokens/generate', {
    auth: admin,
    form: { name: TOKEN_NAME, type: 'PROJECT_ANALYSIS_TOKEN', projectKey: PROJECT_KEY },
  });
  const token = generated.json?.token;
  if (generated.status !== 200 || typeof token !== 'string' || token.length < 20) {
    console.error(`[sonarqube] ERROR: could not generate the analysis token (HTTP ${generated.status}).`);
    process.exit(1);
  }
  writeSecret(tokenFile, token);
  step(`wrote a project analysis token (${TOKEN_NAME}) to jenkins/secrets/sonarqube-token`);
  step('next: node jenkins/import-credential.mjs --id sonarqube-token --file jenkins/secrets/sonarqube-token');
}
