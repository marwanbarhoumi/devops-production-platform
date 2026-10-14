# Jenkins CI (Phase 2)

Local, reproducible Jenkins for this repository: a controller, one build agent and a private Docker
daemon, all defined in [`docker-compose.yml`](docker-compose.yml). The pipeline itself is the root
[`Jenkinsfile`](../Jenkinsfile).

```text
 browser ──► 127.0.0.1:8090
                 │
        ┌────────▼─────────┐  WebSocket (internal network)  ┌──────────────────────┐
        │ controller       │◄───────────────────────────────┤ agent  (ci-agent-1)  │
        │ Jenkins LTS      │                                │ Node 24, npm, git,   │
        │ 0 executors,JCasC│                                │ Docker CLI, Java 21  │
        └──────────────────┘                                └──────────┬───────────┘
                                                      TLS tcp://docker:2376
                                                            ┌──────────▼───────────┐
                                                            │ dind (docker:dind)   │
                                                            │ throwaway PostgreSQL │
                                                            │ for integration tests│
                                                            └──────────────────────┘
```

| Component | Image / build | Purpose |
| --- | --- | --- |
| `controller` | [`controller/Dockerfile`](controller/Dockerfile): `jenkins/jenkins:2.580.1-lts-jdk21` + 75 pinned plugins ([`plugins.txt`](controller/plugins.txt)) + [`casc.yaml`](controller/casc.yaml) | UI, scheduling, build history. Never runs builds (0 executors). |
| `agent` | [`agent/Dockerfile`](agent/Dockerfile): `jenkins/inbound-agent:3391.va_37fa_a_305d6d-2-jdk21` + Node.js 24.16.0 / npm 11.13.0 + Docker CLI 29.9.0 | Runs every pipeline step. Labels `linux nodejs24 docker`. |
| `dind` | `docker:29.9.0-dind` (privileged) | Private Docker daemon for containers started by builds. |

The application stack (`../docker-compose.yml`, project `devops-production-platform`) and this stack
(project `dpp-jenkins`) are fully independent: separate networks, volumes and lifecycle.

### Verification status

| What | How it was checked | Result |
| --- | --- | --- |
| Jenkinsfile syntax | Jenkins' declarative linter (`/pipeline-model-converter/validate`) on this controller image | `Jenkinsfile successfully validated.` |
| Images, plugins, JCasC | `docker compose build`; controller logs; node config in `jenkins_home` | Built; no JCasC errors; `ci-agent-1` with labels `linux nodejs24 docker`, WebSocket, 0 controller executors |
| Controller + setup wizard | `docker compose up -d --wait controller dind` | Healthy on `127.0.0.1:8090`; setup wizard active; initial password file present |
| Agent connection | Separate throwaway instance (own Compose project and volumes) | `WebSocket connection open` / `Connected`; node online |
| Full pipeline in Jenkins | Same throwaway instance, job "Pipeline script from SCM" on a local snapshot of this working tree | Success: all 8 stages, 76 tests (68 unit/API + 8 integration) in the Tests tab, 56 artifacts |
| Failure handling | Builds with a deliberately broken unit test, broken integration test, and a build aborted during integration tests | FAILURE / FAILURE / ABORTED; reports published; later stages skipped; 0 containers left in DinD |
| `/github-webhook/` endpoint | GitHub-style `ping` POST to the controller | HTTP 200 |
| Real GitHub webhook delivery | Not possible: the controller is only reachable on `localhost` | **Not verified** (see [GitHub integration](#6-github-integration)) |

The throwaway instance replaced the setup wizard with a temporary admin account so it could be scripted.
Your instance uses the normal wizard described below.

---

## 1. Prerequisites (Windows + Docker Desktop)

- Docker Desktop with the WSL 2 backend and **Linux containers** (default). Compose v2.24 or newer.
- About 4 GB of free RAM for the stack (limits: controller 1.5 GB, agent 3 GB, dind 2 GB) and 5 GB of disk.
- Port `8090` free on `127.0.0.1` (or set another one, see [`.env.example`](.env.example)).
- Nothing else: Node.js, npm and Java run inside the agent image.

Commands below are for PowerShell, run from the repository root unless stated otherwise.

> **Security: Docker access.** The `dind` service runs **privileged**, and the agent can run any container
> on it. That is root-equivalent on the Docker Desktop VM (or a Linux host). This is acceptable for a
> local portfolio CI that builds only this repository's own branches. **Do not** use this setup to build
> untrusted pull requests (for example from forks), and do not expose it to a network. CI deliberately
> does **not** mount the host's `/var/run/docker.sock`, so builds cannot see or delete your other
> containers or volumes, including the application database (see `docs/DECISIONS.md` D-016).

## 2. Start the controller

```powershell
cd jenkins
docker compose up -d --build --wait controller dind
docker compose ps
```

First build: a few minutes (plugin download). `--wait` returns when both are healthy. Open
<http://localhost:8090>.

The agent is started in step 4, after it has been given its secret.

## 3. First-time setup (once)

1. **Initial admin password.** Read it from the controller's volume instead of searching the logs:

   ```powershell
   docker compose exec controller cat /var/jenkins_home/secrets/initialAdminPassword
   ```

   Paste it into the "Unlock Jenkins" page. Do not share it or store it anywhere. It stops working once
   setup is complete. (Jenkins also prints it once in `docker compose logs controller`, so treat those
   logs as sensitive until setup is finished.)
2. **Customize Jenkins.** Choose **"Select plugins to install"**, click **"None"**, then **Install**. Every
   plugin the pipeline needs is already baked into the image and pinned. Installing extra plugins here
   would make the controller differ from `plugins.txt`.
3. **Create First Admin User** with your own strong password. It is stored only in the `jenkins-home` volume.
4. **Instance Configuration.** Keep `http://localhost:8090/` (this comes from `JENKINS_URL`).

Configuration as Code has already done the rest: the agent node `ci-agent-1` exists, and the built-in node
has 0 executors. These settings are re-applied from [`casc.yaml`](controller/casc.yaml) at every start, so
change them there, not in the UI.

## 4. Connect the build agent (once)

The agent needs the secret of node `ci-agent-1` in the git-ignored file `jenkins/secrets/agent-secret`
(only the 64 hexadecimal characters). Never paste it into chats, screenshots or tracked files. Pick one
way to create the file, running from the `jenkins/` directory:

**A. Rotate and save (recommended; no Jenkins login needed, restarts the controller once)**

```powershell
powershell -ExecutionPolicy Bypass -File .\rotate-agent-secret.ps1
```

This generates a **new** agent key, so any previously seen secret stops working. It writes the new
secret to the file without displaying it and recreates the agent. Users, jobs, build history and
plugins are kept. If a step fails, the previous key is restored. Use it whenever the secret may have
been exposed.

**B. Fetch the current secret with your Jenkins login (no restart)**

```powershell
powershell -ExecutionPolicy Bypass -File .\save-agent-secret.ps1
docker compose up -d agent
```

It prompts for your Jenkins username and an API token (your name → Security → API Token) or password,
with hidden input, and sends them only to `http://localhost:8090`.

**C. By hand:** copy the secret shown under **Manage Jenkins → Nodes → ci-agent-1** ("Run from agent
command line", the value after `-secret`), then
`Set-Content -NoNewline -Path secrets\agent-secret -Value '<secret>'` and `docker compose up -d agent`.

Then check:

```powershell
git check-ignore -v secrets/agent-secret     # must print a matching .gitignore rule
docker compose logs agent | Select-String "Connected"
```

`ci-agent-1` turns online under **Manage Jenkins → Nodes**. The file is mounted as a Compose secret
(`/run/secrets/jenkins_agent_secret`). [`agent/entrypoint.sh`](agent/entrypoint.sh) checks that it
holds exactly one 64-character hexadecimal value, and stops with a clear error if it is missing, empty
or malformed. It then starts `agent.jar` with `-secret @/run/secrets/jenkins_agent_secret`, so the
secret itself never appears in an environment variable or the process list.

## 5. Create the pipeline job

> The job builds what is on GitHub. **Commit and push the Phase 2 changes first** (including
> `Jenkinsfile`), otherwise Jenkins finds no Jenkinsfile.

**Main branch: Pipeline job (recommended start)**

1. **New Item** → name `devops-production-platform` → **Pipeline** → OK.
2. **Triggers:** tick **GitHub hook trigger for GITScm polling**. The Jenkinsfile also declares
   `githubPush()`, which Jenkins registers after the first run.
3. **Pipeline:**
   - Definition: **Pipeline script from SCM**
   - SCM: **Git**
   - Repository URL: `https://github.com/marwanbarhoumi/devops-production-platform.git`
   - Credentials: **- none -** (public repository; read-only checkout needs no token)
   - Branch Specifier: `*/main`
   - Script Path: `Jenkinsfile`; keep **Lightweight checkout** ticked
4. **Save**.

**Feature branches: Multibranch Pipeline (optional)**

**New Item** → **Multibranch Pipeline** → Branch Sources → **Git** with the same URL and no credentials.
Build Configuration: by Jenkinsfile. Under Scan Multibranch Pipeline Triggers, tick
**Periodically if not otherwise run** (for example 5 minutes). Every branch containing the Jenkinsfile
gets its own job. Builds of one branch never overlap (`disableConcurrentBuilds()`), and the
integration-test database is unique per build (`BUILD_TAG`), so branches can build in parallel when the
agent has free executors. Webhook-driven branch discovery would need the GitHub Branch Source plugin,
which is not part of this phase.

## 6. GitHub integration

**How it works:** GitHub POSTs a push event to `<JENKINS_URL>/github-webhook/` (GitHub plugin). Jenkins
finds jobs whose Git URL matches the repository and that have the GitHub hook trigger enabled. It polls
them, and starts a build if there are new commits.

**Limitation:** GitHub's servers cannot reach `http://localhost:8090`. A webhook pointing at
`localhost`, `127.0.0.1` or a private LAN address will always fail. A real webhook needs Jenkins
reachable from the internet over **HTTPS**, with authentication enabled (it is) and a webhook secret.
Typical options are a VM or cloud host with a TLS reverse proxy (later phases automate hosts with
Ansible), or a tunnel you run consciously for a short demo. **This repository does not open any
tunnel or public port.** Do not change `JENKINS_BIND_ADDRESS` to `0.0.0.0` on an untrusted network.

**GitHub settings** (repository → Settings → Webhooks → Add webhook), once Jenkins is publicly reachable:

| Field | Value |
| --- | --- |
| Payload URL | `https://<your-public-jenkins>/github-webhook/` (keep the trailing slash) |
| Content type | `application/json` |
| Secret | A long random string, for example `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| SSL verification | Enabled |
| Events | **Just the push event** |

**Matching Jenkins settings:**
1. **Manage Jenkins → Credentials → System → Global → Add Credentials** → kind **Secret text**, the same
   secret, ID `github-webhook-secret`.
2. **Manage Jenkins → System → GitHub → Advanced → Shared secrets** → add that credential. Jenkins then
   rejects webhook calls without a valid `X-Hub-Signature-256`.
3. No GitHub server entry or token is needed for receiving webhooks or checking out a public repository.
   Only "Manage hooks" (letting Jenkins create webhooks itself) would need a token, and it is not used here.

**Testing a delivery:** on GitHub, open the webhook → **Recent Deliveries**. The initial `ping` should
show response `200`; use **Redeliver** to resend any event. Then push a commit and check that a build
starts, and that the job's **GitHub Hook Log** page shows the event.

**Safe local test without GitHub** (proves the endpoint and plugin respond; does not trigger a build):

```powershell
curl.exe -s -o NUL -w "%{http_code}`n" -X POST http://localhost:8090/github-webhook/ `
  -H "Content-Type: application/json" -H "X-GitHub-Event: ping" -d '{\"zen\":\"local test\"}'
```

This prints `200` while no shared secret is configured (verified). Once a secret is configured, the same
unsigned request must be rejected, which is a quick check that the secret is enforced. To run the pipeline
locally, use **Build Now**.

**Diagnosing a failed webhook:**

| GitHub delivery shows | Likely cause |
| --- | --- |
| Timeout / "failed to connect" | Jenkins is not publicly reachable (always the case for `localhost`), or a firewall or proxy blocks it |
| `404` | Wrong path. It must be `/github-webhook/` with the trailing slash, at the Jenkins root (check the reverse proxy prefix) |
| `403` / signature error | Secret in GitHub and Jenkins differ, or the proxy changes the request body |
| `200` but no build | Job URL differs from the repository URL (`.git` and `https` must match), the hook trigger is not ticked, the job never ran once, or there are no new commits |

Jenkins-side details: **Manage Jenkins → System Log**, and the job's **GitHub Hook Log**.

## 7. Run a build manually

Open the job → **Build Now**. The first build takes longer: `npm ci` fills the npm cache in the
`agent-home` volume, and DinD pulls `postgres:17.7-alpine3.22` into its `docker-data` volume.

## 8. Console output and test reports

- **Console Output** (build page): timestamped log of every step. **Pipeline Overview** (Pipeline Graph View
  plugin) shows the stages and the log of each one.
- **Tests** (build page) / **Test Result Trend** (job page): JUnit results from

  | Stage | Report files (in the workspace) | Suite / class naming |
  | --- | --- | --- |
  | Unit & API Tests | `reports/junit/unit/{api-gateway,product-service,order-service}.xml` | `product-service/test/products.test.ts`, class `product-service.unit.products` |
  | Integration Tests | `reports/junit/integration/{product-service,order-service}.xml` | `order-service/test/repository.int.test.ts`, class `order-service.integration.repository` |

  The same files are produced locally by `npm run test:ci` and `npm run test:integration:ci`.
- **Build Artifacts**: compiled `services/*/dist/**` from successful builds, fingerprinted (last 10 kept).
  The build description shows the branch and commit, for example `origin/main @ 62981430ad5a`.

## 9. Pipeline stages and failures

| Stage | Command | Fails when |
| --- | --- | --- |
| Checkout | `checkout scm` (records commit in the log and build description) | Repository unreachable or branch missing |
| Verify Toolchain | `node scripts/ci/verify-toolchain.mjs` | Node/npm do not satisfy `engines` in `package.json` (`>=22.12.0` / `>=10`), or git, the Docker CLI or the Docker daemon is missing |
| Install Dependencies | `npm ci` | Lockfile out of sync, registry unreachable (10 min timeout) |
| Lint | `npm run lint` | Any ESLint error |
| Type Check | `npm run typecheck` | Any TypeScript error |
| Unit & API Tests | `npm run test:ci` | Any test fails, or a report is missing/empty/invalid |
| Integration Tests | `npm run test:integration:ci` | Database cannot start, any test fails, or a report is missing (10 min timeout) |
| Build | `npm run build` | Compilation fails |

The whole build is limited to 30 minutes, and builds of the same job queue up instead of running
concurrently. Every command's exit code is respected: a failed stage marks the build **FAILURE**, and
the remaining stages show as *skipped due to earlier failure(s)*. Test reports are published even when
tests fail. Each failed stage prints a one-line hint with the local command that reproduces it. Open
the first red stage in Pipeline Overview, or search the console output for `ERROR`.

## 10. Stop, restart, upgrade

```powershell
cd jenkins
docker compose stop                 # stop everything; jobs, history and agent workspace are kept
docker compose start                # start again
docker compose restart controller   # restart only the controller
docker compose up -d --build        # rebuild after changing plugins.txt, casc.yaml or a Dockerfile
docker compose down                 # remove containers and network; volumes (history) are kept
```

Build history, jobs and users live in the `dpp-jenkins_jenkins-home` volume. `docker compose down -v`
**deletes all of it** (and the agent secret becomes invalid), so only use it to start over completely.

## 11. Cleaning up the integration-test database

Normally there is nothing to do: each run removes its own container on success, failure and abort, and
the Jenkinsfile's `post { always }` block runs a second, label-scoped cleanup. The container never has a
volume (data on tmpfs). To check for leftovers (for example after the Docker daemon was killed mid-build):

```powershell
cd jenkins
# Inside the CI Docker daemon (never the host daemon):
docker compose exec dind docker ps -a --filter label=dpp.ci.purpose=integration-db
docker compose exec dind docker rm -f -v <container-name>
```

For local runs of `npm run test:integration:ci` on the host, the same filter works with plain `docker`:
`docker ps -a --filter label=dpp.ci.purpose=integration-db`. Containers are named `dpp-it-<run id>`.
Never use `docker compose down -v` in the repository root for this: that deletes the application's
development database volume.

## 12. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `ports are not available ... 8090` | Another program uses the port: copy `.env.example` to `.env` and set `JENKINS_HTTP_PORT` and `JENKINS_URL` |
| `secret file ... agent-secret` not found when starting the agent | Do step 4 first; the file must be `jenkins/secrets/agent-secret` |
| Agent log: `ERROR: agent secret file is empty` / `is malformed`, agent keeps restarting | The file has no valid secret (empty, quotes, `-secret` prefix, or UTF-16 from `Out-File`). Recreate it with `rotate-agent-secret.ps1` or `save-agent-secret.ps1` (step 4) |
| Agent prints the `java -jar agent.jar [options...]` help and `Two arguments required` | Agent image older than the entrypoint check, with an empty secret file: Remoting replaced `@file` with nothing, which shifted the arguments. `docker compose build agent`, fix the file (step 4), then `docker compose up -d agent` |
| Agent log: `401`/`403`, or `is already connected`/`Unknown client name` | Wrong or stale secret (for example after `down -v` or a rotation): run `save-agent-secret.ps1` again (or `rotate-agent-secret.ps1`), then `docker compose up -d --force-recreate agent` |
| Agent log: connection refused / `UnknownHost controller` | Controller not healthy yet: `docker compose ps`, `docker compose logs controller` |
| Build waits with "Waiting for next available executor on 'linux && nodejs24 && docker'" | Agent offline, or its labels changed: check **Nodes**; labels come from `casc.yaml` |
| Verify Toolchain: `node ... does not satisfy` | Agent image is outdated: `docker compose build --pull agent; docker compose up -d agent` |
| Verify Toolchain: `docker daemon ... exited` / `Cannot connect to the Docker daemon` | `dind` unhealthy: `docker compose ps dind`, `docker compose logs dind`. TLS certificates are shared via the `docker-certs` volume; `docker compose restart dind agent` |
| `npm ci` fails with `EUSAGE` / lockfile mismatch | Run `npm install` locally, commit the updated `package-lock.json` |
| `npm ci` network errors (`ETIMEDOUT`, `EAI_AGAIN`) | Agent has no internet: check Docker Desktop network or proxy settings |
| Integration Tests: `PostgreSQL not ready after 90s` or image pull errors | DinD cannot reach Docker Hub, or the pull hit a rate limit; see `docker compose logs dind` |
| Integration Tests: `not reachable at docker:<port>` | The agent is not using the DinD daemon: `DOCKER_HOST` must be `tcp://docker:2376` |
| Permission denied in the workspace | Volume created by another user ID: `docker compose down`, `docker volume rm dpp-jenkins_agent-home`, start again (only the agent workspace and npm cache are lost) |
| Controller unhealthy or out of memory | Docker Desktop needs more memory (Settings → Resources); `docker compose logs controller` |
| Plugin errors after editing `plugins.txt` | Pin compatible versions (see the header of `plugins.txt`), then `docker compose up -d --build controller` |

Local equivalents of the CI stages (on your machine, without Jenkins):

```powershell
npm run ci:toolchain
npm ci
npm run lint
npm run typecheck
npm run test:ci
npm run test:integration:ci     # needs Docker Desktop running
npm run build
```
