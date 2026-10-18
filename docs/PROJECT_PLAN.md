# Project plan

**Objective:** build a small microservices application and automate its entire delivery lifecycle,
demonstrating the skills expected of a Junior DevOps / Platform Engineer. The application is a vehicle;
the DevOps tooling and practices are the product.

Status legend: **Complete** · In progress · Pending

| # | Phase | Status |
| --- | --- | --- |
| 1 | Foundation | **Complete** (2026-10-13) |
| 2 | CI with Jenkins | **Complete** (2026-10-14); one-time UI setup and a public webhook endpoint remain manual |
| 3 | CI quality and security | **Complete** (2026-10-14); GHCR publishing verified by build #6 (2026-10-17) |
| 4 | Ansible automation | **Complete** (2026-10-14) for the local scope; a real VM still needs a host and SSH credentials |
| 5 | Kubernetes | **Complete** (2026-10-18) on Minikube; HPA and Ingress moved to Phase 6 |
| 6 | Helm | Pending |
| 7 | Continuous deployment | Pending |
| 8 | Monitoring and alerting | **Complete** (2026-10-17) for Docker Compose; Kubernetes metrics delivered with Phase 5 |
| 9 | Platform hardening | Pending |
| 10 | Portfolio completion | Pending |

---

## Phase 1 - Foundation — **Complete**

Repository, microservices, PostgreSQL, Docker Compose, tests, health endpoints and metrics.

### Deliverables

- [x] Monorepo (npm workspaces), `.gitignore`, `.gitattributes`, `.dockerignore`, `.env.example`
- [x] Documentation: `README.md`, `docs/PROJECT_PLAN.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`
- [x] `api-gateway` (7000): routes `/api/products` and `/api/orders`, timeouts, 502/503/504 mapping, request logging
- [x] `product-service` (7001): list, get by ID, create with validation; PostgreSQL persistence; migrations + seed data
- [x] `order-service` (7002): create, list, get; product validation via product-service; PostgreSQL persistence
- [x] Separate database and least-privilege role per service (`products_db`/`product_svc`, `orders_db`/`order_svc`)
- [x] Startup configuration validation for every service
- [x] `/health`, `/ready`, `/metrics` on every service; bounded Prometheus labels
- [x] Structured JSON logging with secret redaction and request-ID propagation
- [x] Multi-stage, non-root Dockerfiles; hardened `docker-compose.yml` with health checks, dependencies, persistent volume, resource limits
- [x] Unit, API, service-to-service, database integration and end-to-end smoke tests
- [x] Root scripts: `dev`, `lint`, `typecheck`, `test`, `test:integration`, `test:smoke`, `build`, `validate`, `compose:*`

### Verification results (2026-10-13, Windows 11, Node 24.16.0, npm 11.13.0, Docker 29.2.1, Compose v5.0.2)

| Check | Command | Result |
| --- | --- | --- |
| Lint | `npm run lint` | Pass (0 problems) |
| Type check | `npm run typecheck` | Pass (3 services) |
| Unit/API tests | `npm test` | Pass: 68 tests (gateway 14, product 25, order 29) |
| Build | `npm run build` | Pass (3 services compiled to `dist/`) |
| Compose validation | `docker compose config --quiet` | Pass |
| Image build + start | `docker compose up -d --build --wait` | Pass: 4/4 containers healthy |
| DB integration tests | `npm run test:integration` | Pass: 8 tests (product 5, order 3) against PostgreSQL 17.7 |
| End-to-end smoke | `npm run test:smoke` | Pass: 17/17 checks (Compose stack and `npm run dev`) |
| Dependency outage | stop product-service, call the gateway | Orders list 200; products 503 or 504 and order create 504 (a stopped container's DNS name can hang rather than fail fast); gateway `/ready` 503 naming the failed upstream; order-service `/ready` stays 200 by design |
| Persistence | `docker compose restart`, re-query orders | Data retained |
| Fresh database init | throwaway `postgres:17.7-alpine3.22` container with `infra/postgres/init` mounted | Both databases created with their own owner; `product_svc` denied `CONNECT` on `orders_db` |
| Metric labels | requests that succeed and fail on the same endpoint, then `GET /metrics` | One `route` pattern per endpoint (`/products/:id`, `/orders`) regardless of status |
| Dev mode | `npm run dev` + `npm run test:smoke` | Pass: 17/17; no processes left on ports 7000-7002 after stopping |
| Non-root | `docker compose exec <svc> id -u` | 1000 for all three app containers |
| Secrets in logs | search `docker compose logs` for `.env` passwords | 0 occurrences |
| `npm audit` (during install) | `npm install` | 0 vulnerabilities reported |

**Issue found and fixed during verification:** the first real order creation returned `500`;
PostgreSQL rejected a query that used parameters as both `integer` and `bigint`. Unit tests (in-memory
repository) could not catch it; the integration test now covers it.

**Issue found and fixed during re-verification:** failed requests (400/404/409/422) were recorded with
the route label stripped of its router prefix (`/:id` instead of `/products/:id`), because Express
restores `req.baseUrl` when an error leaves a router. One endpoint was split across two series, which
would have broken per-endpoint error-rate queries in Phase 8. Routers are now mounted behind
`captureRoutePrefix`, list routes are labelled without a trailing slash (`/products`), and unit tests
in both services assert consistent labels.

### Known limitations carried forward

- Base images pinned by tag, not digest (Phase 3: now pinned by digest too).
- No authentication or rate limiting on the gateway (Phase 9).
- One shared PostgreSQL server (separate databases/roles); no backups yet (Phase 9).
- `.github/workflows/` exists but contains no workflow; Jenkins is the CI system of record (Phase 2).

---

## Phase 2 - CI with Jenkins — **Complete**

Jenkins pipeline for every push: toolchain check, `npm ci`, lint, type check, unit/API tests, database
integration tests against a disposable PostgreSQL, build. Local Jenkins controller and separate build agent.
Guide: [jenkins/README.md](../jenkins/README.md). Decisions: D-015 to D-020 in [DECISIONS.md](DECISIONS.md).

### Deliverables

- [x] Root `Jenkinsfile` (declarative): stages Checkout, Verify Toolchain, Install Dependencies, Lint,
      Type Check, Unit & API Tests, Integration Tests, Build. Options: 30 min timeout (10 min for install
      and integration), timestamps, `disableConcurrentBuilds()`, build discarder, `githubPush()` trigger,
      per-stage failure hints, workspace cleanup. No credentials.
- [x] JUnit XML from Vitest's built-in reporter (`JUNIT_REPORTS_DIR`): `reports/junit/unit/<service>.xml`,
      `reports/junit/integration/<service>.xml`. Published with `allowEmptyResults: false`. Runners fail on missing reports
- [x] `npm run test:ci` (all suites run even after a failure, then reports are verified)
- [x] `npm run test:integration:ci`: disposable PostgreSQL per run (same image and init script as Compose,
      tmpfs data, random port, random passwords passed via env), cleanup on success, failure and abort plus a
      label-scoped `post { always }` backstop
- [x] `npm run ci:toolchain`: Node/npm checked against `engines`, git and Docker client/daemon present
- [x] `jenkins/docker-compose.yml` (project `dpp-jenkins`): controller (Jenkins 2.580.1 LTS, JDK 21, 0 executors),
      inbound agent `ci-agent-1` (Node 24.16.0, npm 11.13.0, Docker CLI 29.9.0, WebSocket), Docker-in-Docker sidecar;
      UI on `127.0.0.1:8090`; persistent volumes; health checks; resource limits
- [x] 75 plugins pinned in `jenkins/controller/plugins.txt`; JCasC for the agent node, executors and URL
- [x] Agent secret via git-ignored Compose secret file; admin created in the setup wizard (no credentials in git)
- [x] GitHub webhook documentation (endpoint, settings, shared secret, testing, diagnosis, localhost limitation)
- [x] Build artifacts (`services/*/dist/**`) archived and fingerprinted; build retention (30 builds, 10 with artifacts)

### Verification results (2026-10-14, Windows 11, Docker Desktop 29.2.1 / Compose v5.0.2)

| Check | Command / method | Result |
| --- | --- | --- |
| Lint, type check, unit tests, build | `npm run validate` | Pass (68 unit/API tests) |
| Unit tests with JUnit | `npm run test:ci` | Pass; 3 reports, e.g. `<testsuites name="api-gateway unit" tests="14" failures="0">` |
| Integration tests, disposable DB (host Docker) | `npm run test:integration:ci` | Pass: 8 tests; container on random `127.0.0.1` port, removed afterwards |
| Integration tests, Compose DB (unchanged mode) | `npm run test:integration` | Pass: 8 tests |
| Failure paths (local) | Temporarily broken unit and integration test | Exit 1; other suites still run; reports show `failures="1"`; DB container removed |
| Compose validation | `docker compose config --quiet` (root and `jenkins/`) | Pass |
| Jenkins images | `docker compose build` in `jenkins/` | Built with the pinned plugins |
| Jenkinsfile syntax | Jenkins declarative linter on the controller | `Jenkinsfile successfully validated.` |
| Controller | `docker compose up -d --wait controller dind` | Healthy on 127.0.0.1:8090; JCasC applied; setup wizard waiting for the owner |
| Agent + full pipeline in Jenkins | Throwaway instance (separate Compose project/volumes, local snapshot of the working tree, temporary admin) | Agent connected over WebSocket. Build #1 and #5 SUCCESS: all 8 stages, 76 tests in the Tests tab, 56 artifacts. Integration DB ran in DinD (`docker:<port>`) |
| Failure handling in Jenkins | Builds #2 (broken unit test), #3 (broken integration test), #4 (aborted during integration tests) | FAILURE, FAILURE, ABORTED; reports published; later stages skipped; 0 containers left in DinD |
| Secrets in build logs | Search of all 5 console logs | No passwords |
| Development stack untouched | `docker ps -a` / `docker volume ls` before and after | All app containers still up; dev volume intact; nothing removed |
| Webhook endpoint | GitHub-style `ping` POST to `/github-webhook/` | HTTP 200 |
| Owner's agent (2026-10-14) | Agent looped on the Remoting help: `secrets/agent-secret` was empty, so `-secret @file` expanded to nothing. Fixed with a validating entrypoint; secret rotated with `rotate-agent-secret.ps1` | `ci-agent-1` connected over WebSocket; reconnects after `restart` and `stop`/`start`; no secret in logs, env, process list or files |
| Owner's Jenkins, job `devops-production-platform` | Pipeline from SCM (`*/main`, `Jenkinsfile`), triggered by a GitHub-format `push` POST to `/github-webhook/` | Build #1 (`b567ae6`): FAILURE in Integration Tests — Docker Hub cut off a postgres layer download (`short read ... unexpected EOF`); 68 unit/API tests passed. Fixed in `5cb0022` (pull with retries; cleanup before `junit`). Build #2 (`5cb0022`): **SUCCESS** in 1 min 56 s, 76 tests (68 unit/API + 8 integration) recorded, 0 failed; `dist` of 3 services archived; test DB removed; no secrets in the log |
| Phase 1 regression | `npm run test:smoke` on the running Compose stack | 17/17 |

The throwaway verification instance was removed afterwards (`docker compose -p dpp-jenkins-verify down -v`,
which only affects that project).

### Not verified / manual steps remaining

- **Real GitHub webhook delivery:** impossible while Jenkins is reachable only on `localhost`; needs a public
  HTTPS endpoint (documented, intentionally not created).
- **Owner's instance:** setup wizard, agent secret and job creation are one-time UI steps (jenkins/README.md, sections 3-5).
  The pipeline will find the Jenkinsfile on GitHub only after the Phase 2 changes are committed and pushed.

### Moved to Phase 3

- Coverage publishing (consumed by the SonarQube quality gate) and Docker image build validation (built,
  scanned and tagged there). See "Roadmap changes" in DECISIONS.md.

## Phase 3 - CI quality and security — **Complete**

Quality and security gates in the existing pipeline, then image build, scan and publishing.
Guide: [security/README.md](../security/README.md). Decisions: D-021 to D-025 in [DECISIONS.md](DECISIONS.md).

### Deliverables

- [x] Test coverage (v8, LCOV) from unit and integration tests, for SonarQube (moved from Phase 2)
- [x] Local SonarQube 26.10 + own PostgreSQL (`security/sonarqube/`, port 9100), reproducible bootstrap
      (admin password, project, project analysis token) and token import into Jenkins without a login
- [x] Pipeline stage "SonarQube Analysis": quality gate "Sonar way" enforced (`sonar.qualitygate.wait`)
- [x] Pipeline stage "Trivy Filesystem Scan": lockfile vulnerabilities, secrets, Dockerfile misconfigurations
- [x] Pipeline stages "Build Images" / "Scan Images": three service images built in DinD, Trivy
      vulnerabilities + secrets, CycloneDX SBOM per image; fail on fixable HIGH/CRITICAL
- [x] Secure images: digest-pinned base images (services, agent tools, SonarQube stack); runtime images
      without npm/yarn/corepack; Alpine security updates
- [x] Tag strategy `<sha12>` + `<version>-<sha7>`, OCI labels; stage "Publish Images" to GHCR from `main`
      (needs the `container-registry` credential; skipped with a message without it)
- [x] Agent image: SonarScanner CLI 8.1, Trivy 0.75, docker buildx; toolchain check covers them
- [x] First full pipeline runs on the owner's Jenkins with all Phase 3 stages green (builds #3 and #4)
- [x] Registry publishing verified: build #6 (`2d89c05`) pushed all three service images to GHCR

### Verification (2026-10-14, owner's Jenkins, job `devops-production-platform`)

| What | How | Result |
| --- | --- | --- |
| Local checks | `npm run lint`, `typecheck`, `test:ci`, `test:integration:ci`, `build`; `docker compose config` for all three stacks | All pass; coverage LCOV written for 3 + 2 suites |
| SonarQube stack | `node security/sonarqube/bootstrap.mjs` (twice) | Healthy on 127.0.0.1:9100; admin password replaced; project and project analysis token created; second run changes nothing |
| Token into Jenkins | `node jenkins/import-credential.mjs` | `added sonarqube-token`; no staging file or init script left; builds #1-#2 kept; agent reconnected |
| Agent image | `docker compose build agent`, then recreate the agent only | buildx 0.38.0, SonarScanner CLI 8.1.0.6389, Trivy 0.75.0; reaches SonarQube and reads DinD images over TLS |
| Image hardening | Trivy before/after on `api-gateway` | Before: 13 HIGH + 1 CRITICAL (npm's bundled packages) + 4 HIGH (OpenSSL). After: 0 fixable HIGH/CRITICAL; container healthy |
| Build #3 (`efda25f`) | Webhook push event | **SUCCESS**, 5 min 38 s; 76 tests; quality gate PASSED (coverage 83.4 %, 0 bugs, 0 vulnerabilities, 0 hotspots, 2 code smells); Trivy fs: 0 HIGH/CRITICAL; 3 images built, 0 vulnerabilities of any severity, 3 SBOMs (123 components each); publishing skipped (no credential); 6 tags cleaned from DinD |
| Build #4 (`2fb89ad`) | Webhook push event, after fixing the 2 code smells (rule S8786) | **SUCCESS**, 2 min 56 s; 78 tests; quality gate PASSED: 0 code smells, new-code coverage 100 %, overall 85.2 % |
| Build #6 (`2d89c05`, 2026-10-17) | Build Now, after the `.trivyignore.yaml` and text-report change | **SUCCESS**; 13/13 stages; 78 tests; quality gate PASSED; Trivy fs: CRITICAL 0, HIGH 0, MEDIUM 0, LOW 3 (missing `HEALTHCHECK`, not blocking); 3 images, 0 vulnerabilities each; 3 SBOMs (CycloneDX 1.7); 12 report artifacts archived; published to GHCR as `2d89c059ed41` and `0.1.0-2d89c05` for all three services |
| Secrets in logs | Search of build #3 log | 84 hex strings, all `sha256:` image digests; no token |

### Known findings

- **Duplication 47 %** (SonarQube): `db.ts`, `metrics.ts`, `http.ts`, `server.ts` and parts of `config.ts`
  are deliberately copied per service (D-002, no shared package). The gate only checks duplication on new
  code, so it passes; extracting a shared package is a candidate for Phase 9.
- Trivy LOW DS-0026: the agent image has no `HEALTHCHECK` (the inbound agent has no health endpoint; Jenkins
  shows the node's state). Not blocking.
- Registry publishing: verified by build #6 with the `container-registry` credential (see Verification).
- The controller Dockerfile's explicit `USER jenkins` (Trivy DS-0002) takes effect at the next controller
  image rebuild; it does not change behaviour (the base image already runs as `jenkins`).
- Follow-up (2026-10-16): Phase 4's `ansible/test/target/Dockerfile` broke the filesystem scan (HIGH DS-0002,
  root user; systemd needs it). Accepted for that file only in `.trivyignore.yaml` (expires 2027-04-16), which
  replaced `.trivyignore`. Trivy scans now also write text reports (`reports/trivy/*.txt`), archived by Jenkins.
  Local re-run at `985f55b`: Trivy fs 0 HIGH/CRITICAL after the exception; 3 images 0 vulnerabilities, 3 SBOMs
  (CycloneDX 1.7, 122 components each). Confirmed by Jenkins build #6 (`2d89c05`, see Verification).

## Phase 4 - Ansible automation — **Complete**

Reusable automation that prepares Ubuntu servers to run the platform's containers. Guide:
[ansible/README.md](../ansible/README.md). Decisions: D-026 to D-029 in [DECISIONS.md](DECISIONS.md).

### Deliverables

- [x] Containerized controller (`ansible/Dockerfile`, Compose project `dpp-ansible`): digest-pinned Python 3.13,
      ansible-core 2.21.5, ansible-lint 26.10.1, 29 pinned Python packages; non-root, read-only, no capabilities,
      no Docker socket; PowerShell wrapper `ansible.ps1`
- [x] `ansible.cfg`: no default inventory, strict host key checking with a project `known_hosts`, key-only SSH,
      `become` off by default (playbooks opt in), pipelining
- [x] Inventories: `dev.ini.example`, `prod.ini.example` (unresolvable `.invalid` placeholders, git-ignored copies),
      `local-test.ini`; `group_vars/all.yml` and an `.example` of overrides
- [x] Playbooks `site.yml`, `common.yml`, `docker.yml` with a shared preflight: environment check, placeholder and
      non-SSH targets refused before connecting, prod changes need `-e confirm_production=true`
- [x] Role `common`: supported Ubuntu check (22.04/24.04/26.04), apt Python libraries, admin packages, keyrings
      directory, unattended security upgrades (template + handler)
- [x] Role `docker_engine`: conflict check, Docker key fingerprint verification, deb822 repository, Engine +
      containerd + Buildx + Compose, optional version pin, validated `daemon.json` with log rotation, services,
      opt-in docker group membership for existing users only (handler restarts Docker)
- [x] Target preparation, SSH key, host key verification, privilege escalation, Vault pattern, docker group risk,
      troubleshooting (ansible/README.md)
- [x] Local end-to-end test (`ansible/test/run-local-test.ps1`) against a disposable systemd Ubuntu 24.04 container
- [ ] Run against a real server (needs a target host and SSH credentials from the owner)

### Verification (2026-10-14, Windows 11, Docker Desktop 29.2.1 / Compose v5.0.2)

| Check | Command / method | Result |
| --- | --- | --- |
| Controller image | `.\ansible\ansible.ps1 -Build`, `.\ansible\ansible.ps1` | Built; `ansible [core 2.21.5]`, `pip check` clean |
| Lint | `.\ansible\ansible.ps1 ansible-lint` | Passed, profile `production`: 0 failures, 0 warnings |
| Syntax and inventories | `--syntax-check` (3 playbooks); `ansible-inventory --graph` and `--list-hosts` for all 3 inventories | Pass; `managed` resolves to the expected single host in each |
| Compose | `docker compose -f ansible/docker-compose.yml config --quiet` (default and `--profile test`) | Pass |
| Placeholder safety | `site.yml --check` with `dev.ini.example` | Refused by the preflight, exit 2, no connection attempt |
| Host key workflow | `ssh-keyscan` + `ssh-keygen -lf` through `ansible.ps1` (github.com as a public stand-in) | Fingerprint matches the published one; `ansible/.ssh/` is git-ignored |
| End-to-end on the test target | `.\ansible\test\run-local-test.ps1` | **PASSED**: ping and sudo; placeholder and unconfirmed prod refused; check mode on the minimal target refused with the `python3-apt` message; `common.yml` applied (changed=4); `site.yml --check` changed nothing (Docker absent afterwards); `site.yml` applied (changed=7, Docker 29.9.0, Compose 5.6.0); second run **changed=0**; check mode after apply **changed=0** (also as unconfirmed prod); docker and containerd active and enabled; `docker run hello-world` OK; target and test volumes removed |
| Other stacks untouched | `docker ps -a` before and after | Application, Jenkins and SonarQube containers kept running with unchanged uptime; no volume removed |

**Issues found and fixed by the test:**

- On a minimal Ubuntu image, Ansible's apt modules fail in check mode without `python3-apt`. Both roles now
  install `python3-apt` and `python3-debian` on a normal run and stop check mode with a clear message instead.
- The test target's sshd did not start: masking `ssh.socket` also blocks `ssh.service` on Ubuntu 24.04. The
  target now uses Ubuntu's default socket activation.
- Docker 29 stores images through containerd; in the nested test target `/var/lib/containerd` needs its own volume.

### Not verified / remaining

- **A real VM:** no target host or credentials were provided. The playbooks have not configured any real
  machine; the first real run should be `--check --diff` (ansible/README.md, sections 4-6).
- Ubuntu 22.04/26.04, arm64, sudo with a password (`-K`), Ansible Vault (pattern only).

### Moved to later phases

Jenkins agent role (Phase 7), Kubernetes node prerequisites (Phase 5), SSH/firewall hardening (Phase 9). See
"Roadmap changes" in DECISIONS.md.

## Phase 5 - Kubernetes — **Complete**

The platform on a local Kubernetes cluster (Minikube, Calico), from plain manifests assembled with Kustomize.
Guide: [kubernetes/README.md](../kubernetes/README.md). Decision: D-031 in [DECISIONS.md](DECISIONS.md).

### Deliverables

- [x] Namespaces `devops-platform` (Pod Security `restricted` enforced) and `monitoring`
- [x] Deployment, Service and PodDisruptionBudget per service: GHCR images with a configurable `<sha12>` tag,
      2 replicas, rolling updates (`maxSurge: 1`, `maxUnavailable: 0`, `minReadySeconds: 45`, `preStop` pause), startup/liveness probes on
      `/health`, readiness on `/ready` (gateway `/health`), Compose resource limits
- [x] ConfigMaps (the services' existing variables) and Secrets from git-ignored `.env` files (`secretGenerator`)
- [x] PostgreSQL StatefulSet with a 2Gi volume claim, the shared init script and per-service roles; migrations
      at service startup, serialised by the existing advisory locks
- [x] Security contexts (non-root, read-only, no capabilities, `RuntimeDefault` seccomp), no service account
      token where the API is not used, default-deny NetworkPolicies with explicit allowed paths
- [x] Prometheus, Alertmanager and Grafana with PVCs and the shared Compose configuration; Kubernetes service
      discovery with namespaced Roles; kube-state-metrics (scoped ClusterRole) and node-exporter (DaemonSet)
- [x] 8 Kubernetes alert rules with runbooks and `promtool` tests; 3 new inhibit rules; "Kubernetes platform"
      dashboard (15 panels); the platform rules and Platform overview dashboard unchanged
- [x] Private GHCR images pulled with an in-cluster `ghcr-pull` Secret (classic token, `read:packages` only),
      created from a credential prompt and passed on standard input; packages stay private
- [x] Controlled failure tests with recovery: pod deletion, no available replica, restart and crash loop, missing
      metric source
- [ ] HorizontalPodAutoscaler and Ingress: moved to Phase 6 (see "Roadmap changes" in DECISIONS.md)
- [ ] Ansible role for Kubernetes node prerequisites: not needed for a local cluster

### Verification (2026-10-17 and 18, Windows 11, Minikube 1.39.0, Kubernetes 1.36.4, Docker driver, Calico)

| Check | Command / method | Result |
| --- | --- | --- |
| Rendering and admission | `kubectl kustomize`, `kubectl apply -k --dry-run=server` (both namespaces) | Pass; only Pod Security warning: node-exporter host paths (accepted) |
| Alert rules | `promtool check rules`, `promtool test rules` (platform and Kubernetes), `amtool check-config` | Pass: 6 + 8 rules, 4 inhibit rules |
| Trivy | Repository scan with the pipeline's scanners (vuln, secret, misconfig), HIGH/CRITICAL | 0 findings; KSV-0121 accepted for `node-exporter.yaml` only |
| Monitoring namespace | `kubectl get pods,pvc -n monitoring` | 5 workloads Running and Ready, 3 PVCs Bound |
| Service discovery | Prometheus `/api/v1/targets` | kube-state-metrics and node-exporter discovered by pod IP; Prometheus, Alertmanager, Grafana UP |
| Grafana | `/api/health`, data source health, dashboard API | OK; both dashboards provisioned (17 and 15 panels) |
| PostgreSQL | StatefulSet, init script, `pg_database` | Running as UID 70; `products_db`/`product_svc` and `orders_db`/`order_svc` created |
| NetworkPolicies | `pg_isready`/`wget`/`net.connect` from a pod in `default`, a pod labelled product-service and an api-gateway pod | `default` → PostgreSQL and → product-service blocked; product-service → PostgreSQL allowed; api-gateway → PostgreSQL blocked, → product-service allowed (HTTP 200) |
| Persistence | Delete `postgres-0` and the Prometheus pod; later scale PostgreSQL to 0 and back | PostgreSQL skipped initialisation and kept both databases and their rows; Prometheus kept its oldest samples |
| GHCR pull | `ghcr-pull` Secret, `rollout restart` | First token refused (`403 Forbidden` from the GHCR token endpoint: wrong token type); with a classic `read:packages` token all 6 pods pulled `2d89c059ed41` (digests recorded) |
| Application pods | `kubectl get pods,deploy,svc,pdb -n devops-platform` | 3 Deployments 2/2, PostgreSQL 1/1, 0 restarts; migrations applied; services resolve each other by Service name |
| Traffic | Gateway port-forward: health, ready, list/get/create product, create/list order, 404/422/400 cases; `scripts/smoke-test.mjs` with `GATEWAY_URL` | All expected status codes; smoke test passed |
| Targets | Prometheus `/api/v1/targets` | 11/11 UP: 6 application pods (discovered), kube-state-metrics, node-exporter, Prometheus, Alertmanager, Grafana |
| Metrics follow traffic | 30 product reads and 10 orders through the gateway | `http_requests_total` grew by exactly 40 (api-gateway), 40 (product-service: 30 + 10 order validations), 10 (order-service) |
| Grafana | Every panel query of both dashboards through Grafana's `/api/ds/query` | All panels return data; restart and firing-alert panels after the failure tests; only the 5xx panel stays empty (no 5xx) |
| Pod deletion | Delete a product-service pod under ~5 requests/s | Replacement Ready in ~20 s, 269/269 requests succeeded, target replaced in Prometheus, no alert |
| No available replica | Scale PostgreSQL to 0 for 6 minutes, then back to 1 | DeploymentReplicasUnavailable (critical) firing for product-service and order-service after ~1.5 min, KubernetesPodNotReady for the 4 pods after ~5.5 min, both in Alertmanager; gateway 503 on those routes; after restore: Ready in seconds, all alerts resolved, data intact |
| Restarts | Liveness probe on a missing path for order-service, then `rollout undo` | PodRestartingFrequently firing after ~3.5 min, PodCrashLooping after ~8.5 min; Alertmanager inhibited PodRestartingFrequently; resolved after rollback |
| Missing metric source | Scale kube-state-metrics to 0, then back | KubernetesTargetDown firing after 3 min ("has no scrape target") and in Alertmanager; resolved after restore |
| Recovery | After all tests | 7/7 application pods Ready, 11/11 targets UP, 0 alerts in Prometheus and Alertmanager, 4 PVCs Bound, all rows present |
| Existing checks | `npm run lint`, `typecheck`, `test:ci` (70 tests), `test:integration:ci` (8 tests); `docker compose config` (root, monitoring) | Pass |

**Issue found and fixed on the cluster:** KubernetesContainerWaiting never fired for the image pull failures:
the kubelet alternates `ErrImagePull` and `ImagePullBackOff`, kube-state-metrics replaces the per-reason series,
and each switch restarted the 10-minute `for` timer. The rule now aggregates per container and looks up the
current reason for the description; a `promtool` test with alternating reasons covers it. After the fix it fired
on the cluster for all six waiting containers ("current reason ImagePullBackOff") and reached Alertmanager.

**Issue found and fixed by the restart test:** the first run replaced *both* order-service pods with the broken
version: each new pod passed readiness for ~30 seconds before the liveness probe killed it, which was enough for
the rollout to count it as available and stop an old pod, so the orders API returned 503 until the rollback. The
services now set `minReadySeconds: 45`; on the second run the rollout stalled with one crash-looping pod, the old
pods kept serving and 285 of 285 order requests succeeded.

**Issue found and fixed by the metric-source test:** KubernetesTargetDown only matched `up == 0`, but
kube-state-metrics and node-exporter are discovered from their pods, so a missing pod removes the target instead of
marking it down. The rule now also fires on `absent(up{job=...})`; a `promtool` test and the live test cover it.

### Not verified / remaining

- KubernetesNodeNotReady and DeploymentReplicasMismatch on a real failure: a node test is unsafe on a single node
  (Prometheus runs on it), and the mismatch needs 10 minutes of partial availability. Both are covered by
  `promtool` tests; DeploymentReplicasMismatch also fired (and was inhibited) during the image pull failure.
- No notification channel: Alertmanager has no webhook URL in the cluster (optional Secret, kubernetes/README.md).

## Phase 6 - Helm — Pending

- Reusable chart (or umbrella chart) for the platform, starting from the Phase 5 manifests
- Ingress for the gateway and HorizontalPodAutoscaler with metrics-server (from Phase 5)
- Configurable values; environment-specific values files (dev, staging, prod)
- Release management: install, upgrade, history, rollback; chart linting and templating checks in CI

## Phase 7 - Continuous deployment — Pending

- Jenkins deployment pipeline with staged promotion (dev → staging → production approval)
- Immutable image versioning; deployment verification using readiness and smoke tests
- Rolling update strategy and automated rollback (`helm rollback`) on failed verification
- Ansible role for a Jenkins agent on a managed server, if deployments need one (from Phase 4)

## Phase 8 - Monitoring and alerting — **Complete** (Docker Compose)

Prometheus, Grafana and Alertmanager for the Compose environment. Guide:
[monitoring/README.md](../monitoring/README.md). Decision: D-030 in [DECISIONS.md](DECISIONS.md).

### Deliverables

- [x] Separate Compose project `monitoring/docker-compose.yml` (`dpp-monitoring`): Prometheus v3.15.0,
      Alertmanager v0.34.1, Grafana 13.2.4, digest-pinned; read-only, no capabilities, non-root; health checks on
      `/-/ready` and `/api/health`; resource limits; named volumes; ports bound to `127.0.0.1` (9090, 9093, 3000)
- [x] Prometheus scrapes the three services by Compose service name on the application network, plus itself,
      Alertmanager and Grafana (6 targets, 15 s); retention 15 days / 2 GB, configurable
- [x] Six alert rules with severities and runbooks: ServiceDown, PrometheusTargetDown, HighErrorRate,
      HighLatency, HighCPU, HighMemory; `promtool` unit tests for all of them
- [x] Alertmanager: grouping per alert and service, faster critical route, inhibit rule, webhook receiver with
      resolved notifications; the URL comes from a git-ignored file through a Compose secret
- [x] Grafana: provisioned Prometheus data source and "Platform overview" dashboard (17 panels: availability,
      RED metrics, status codes, gateway upstream outcomes, CPU and memory against the container limits, event
      loop lag, firing alerts); admin password from `monitoring/.env`, sign-up and anonymous access disabled
- [x] No application change: the services' existing metrics (Phase 1) were sufficient
- [ ] Database metrics (`postgres_exporter`): moved to Phase 9
- [x] Kubernetes metrics, pod-restart alerts, cluster dashboards: delivered with Phase 5

### Verification (2026-10-17, Windows 11, Docker Desktop, Compose v5)

| Check | Command / method | Result |
| --- | --- | --- |
| Configuration | `promtool check config`, `promtool check rules`, `amtool check-config`, `docker compose config` (both stacks) | Pass; 6 rules |
| Alert unit tests | `promtool test rules tests/platform-alerts.test.yml` | Pass: every rule fires when expected and not before; probe-route 503s and low traffic ignored |
| Stack health | `docker compose -f monitoring/docker-compose.yml up -d --wait` | 3/3 containers healthy |
| Targets | Prometheus `/api/v1/targets` | 6/6 UP |
| Alertmanager link | Prometheus `/api/v1/alertmanagers` | `http://alertmanager:9093/api/v2/alerts` active |
| Grafana | `/api/health`, data source health, dashboard API, `/api/ds/query` | OK; data source queries Prometheus; dashboard provisioned with 17 panels; anonymous API request rejected (401) |
| Metrics follow traffic | 40 rounds of 5 requests through the gateway (200, 404, 400 responses) | Prometheus counters matched the client's counts exactly per service and status code |
| Controlled failure | `docker compose stop product-service` with ~0.5 requests/s through the gateway, then `start` | Target DOWN within one scrape; ServiceDown pending, then **firing** after 1 min; HighErrorRate on api-gateway (503/504) **firing**; PrometheusTargetDown fired in Prometheus but was inhibited in Alertmanager; a test webhook received FIRING for ServiceDown and HighErrorRate, then RESOLVED for both after the restart (ServiceDown ~1.5 min, HighErrorRate ~3 min); product-service healthy again |
| Reload and persistence | `kill -s SIGHUP prometheus`; recreate the Prometheus container | Configuration reloaded; stored samples kept |
| Existing checks | `npm run lint`, `typecheck`, `test:ci` (70 tests), `test:integration:ci` (8 tests) | Pass |
| DevSecOps unchanged | `git diff` on Jenkinsfile, Trivy, SonarQube, Ansible, services, root Compose; Trivy fs scan with the pipeline's scanners | No changes; 0 HIGH/CRITICAL in tracked files |

### Not verified / remaining

- No real notification channel: notifications were tested against a temporary local webhook receiver. A team
  webhook (chat or incident tool) needs a URL from the owner (monitoring/README.md, section 5).
- HighLatency, HighCPU and HighMemory were verified by unit tests only, not by load on the real stack.
- PostgreSQL internals and Docker-level container metrics are not collected (D-030).

## Phase 9 - Platform hardening — Pending

- Security review; secret management (e.g. Sealed Secrets or External Secrets)
- NetworkPolicies and Pod Security Admission: delivered with Phase 5; egress restrictions remain
- Resource quotas and limit ranges
- Database backup/restore and disaster-recovery considerations; authentication and rate limiting at the edge
- PostgreSQL metrics with `postgres_exporter` and a dedicated monitoring role (from Phase 8)
- Server hardening with Ansible: SSH daemon settings, firewall, users (from Phase 4)

## Phase 10 - Portfolio completion — Pending

- Architecture diagrams, demo scenarios (deploy, break, alert, roll back), troubleshooting guides
- Screenshots of pipelines and dashboards, CI/CD demonstrations, final documentation pass
