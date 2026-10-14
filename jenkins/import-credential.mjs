#!/usr/bin/env node
// Imports a git-ignored secret file into Jenkins as a global "Secret text" credential, without an
// administrator login. The value is never printed. Safe to re-run: an existing credential with the
// same id is updated; other credentials are left untouched.
//
//   node jenkins/import-credential.mjs --id sonarqube-token --file jenkins/secrets/sonarqube-token
//
// How: the value is streamed into the controller's jenkins_home together with a one-shot
// init.groovy.d script, and the controller is restarted (container only; no rebuild, volumes kept).
// The script stores the credential (encrypted in credentials.xml), then deletes the value and itself.
// The agent reconnects automatically after the restart.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const jenkinsDir = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    id: { type: 'string' },
    file: { type: 'string' },
    description: { type: 'string' },
  },
});
if (!values.id || !values.file || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(values.id)) {
  console.error('Usage: node jenkins/import-credential.mjs --id <credential-id> --file <secret file> [--description <text>]');
  process.exit(2);
}
const file = resolve(values.file);
if (!existsSync(file)) {
  console.error(`ERROR: ${values.file} does not exist.`);
  process.exit(1);
}
const secret = readFileSync(file, 'utf8').trim();
if (secret === '' || /[\r\n]/.test(secret)) {
  console.error(`ERROR: ${values.file} must contain a single non-empty line.`);
  process.exit(1);
}
const description = (values.description ?? `${values.id} (imported by jenkins/import-credential.mjs)`).replace(/[\r\n]/g, ' ');

const HOME = '/var/jenkins_home';
const IMPORT_DIR = `${HOME}/.dpp-credential-import`;
const SCRIPT = `${HOME}/init.groovy.d/dpp-import-credentials.groovy`;

const groovy = `
import com.cloudbees.plugins.credentials.CredentialsScope
import com.cloudbees.plugins.credentials.SystemCredentialsProvider
import com.cloudbees.plugins.credentials.domains.Domain
import hudson.util.Secret
import jenkins.model.Jenkins
import org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl

def dir = new File(Jenkins.get().rootDir, '.dpp-credential-import')
def store = SystemCredentialsProvider.getInstance().getStore()
def results = []
try {
  dir.listFiles().findAll { it.name.endsWith('.secret') }.each { f ->
    def id = f.name - '.secret'
    def descFile = new File(dir, id + '.description')
    def desc = descFile.exists() ? descFile.text.trim() : id
    def credential = new StringCredentialsImpl(CredentialsScope.GLOBAL, id, desc, Secret.fromString(f.text.trim()))
    def existing = store.getCredentials(Domain.global()).find { it.id == id }
    if (existing) { store.updateCredentials(Domain.global(), existing, credential); results << "updated " + id }
    else { store.addCredentials(Domain.global(), credential); results << "added " + id }
  }
} catch (e) {
  results << "error " + e.class.simpleName
} finally {
  dir.listFiles().findAll { it.name.endsWith('.secret') || it.name.endsWith('.description') }.each { it.delete() }
  new File(dir, 'result').text = results.join('\\n')
  new File(Jenkins.get().rootDir, 'init.groovy.d/dpp-import-credentials.groovy').delete()
}
`;

function compose(args, { input, quiet = false } = {}) {
  const result = spawnSync('docker', ['compose', ...args], {
    cwd: jenkinsDir,
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (result.status !== 0 && !quiet) {
    throw new Error(`docker compose ${args.slice(0, 2).join(' ')} failed: ${(result.stderr || '').trim().split('\n').pop()}`);
  }
  return result;
}
/** Runs a shell script in the controller as the jenkins user, optionally feeding stdin. */
const inController = (script, input) => compose(['exec', '-T', 'controller', 'sh', '-euc', script], { input });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  console.log(`[import-credential] staging ${values.id} in the controller`);
  inController(`umask 077; mkdir -p ${IMPORT_DIR} ${HOME}/init.groovy.d; rm -f ${IMPORT_DIR}/result`);
  inController(`umask 077; cat > ${IMPORT_DIR}/${values.id}.secret`, secret);
  inController(`umask 077; cat > ${IMPORT_DIR}/${values.id}.description`, description);
  inController(`cat > ${SCRIPT}`, groovy);

  console.log('[import-credential] restarting the controller (container only; data is kept)');
  compose(['restart', 'controller']);

  const deadline = Date.now() + 5 * 60_000;
  let result = '';
  while (Date.now() < deadline) {
    await sleep(5000);
    const r = compose(['exec', '-T', 'controller', 'sh', '-c', `cat ${IMPORT_DIR}/result 2>/dev/null`], { quiet: true });
    if (r.status === 0 && r.stdout.trim() !== '') {
      result = r.stdout.trim();
      break;
    }
  }
  if (!/^(added|updated) /m.test(result) || /^error /m.test(result)) {
    throw new Error(`the controller did not import the credential (result: ${result || 'none'})`);
  }
  console.log(`[import-credential] ${result}`);
} catch (err) {
  console.error(`[import-credential] ERROR: ${err.message}`);
  // Never leave the plain value or the script behind.
  compose(['exec', '-T', 'controller', 'sh', '-c', `rm -f ${IMPORT_DIR}/*.secret ${IMPORT_DIR}/*.description ${SCRIPT}`], {
    quiet: true,
  });
  process.exit(1);
} finally {
  compose(['exec', '-T', 'controller', 'sh', '-c', `rm -rf ${IMPORT_DIR}`], { quiet: true });
}
