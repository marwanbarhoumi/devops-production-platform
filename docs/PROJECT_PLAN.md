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
| 5 | Kubernetes | Pending |
| 6 | Helm | Pending |
| 7 | Continuous deployment | Pending |
| 8 | Monitoring and alerting | Pending |
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

## Phase 5 - Kubernetes — Pending

- Namespaces per environment; Deployments and Services for each microservice
- ConfigMaps and Secrets; liveness/readiness probes mapped to `/health` and `/ready`
- Resource requests and limits; HorizontalPodAutoscaler
- PostgreSQL StatefulSet with PersistentVolumeClaim (or an external database), migration strategy
- Ingress for the gateway; RBAC and service accounts
- Ansible role for Kubernetes node prerequisites, if the chosen cluster runs on managed servers (from Phase 4)

## Phase 6 - Helm — Pending

- Reusable chart (or umbrella chart) for the platform
- Configurable values; environment-specific values files (dev, staging, prod)
- Release management: install, upgrade, history, rollback; chart linting and templating checks in CI

## Phase 7 - Continuous deployment — Pending

- Jenkins deployment pipeline with staged promotion (dev → staging → production approval)
- Immutable image versioning; deployment verification using readiness and smoke tests
- Rolling update strategy and automated rollback (`helm rollback`) on failed verification
- Ansible role for a Jenkins agent on a managed server, if deployments need one (from Phase 4)

## Phase 8 - Monitoring and alerting — Pending

- Prometheus scraping service `/metrics` and Kubernetes metrics (kube-state-metrics, node-exporter)
- Grafana dashboards: RED metrics per service, upstream health, database, cluster resources
- Alertmanager with actionable alerts (error rate, latency, availability, pod restarts, saturation) and runbooks

## Phase 9 - Platform hardening — Pending

- Security review; secret management (e.g. Sealed Secrets or External Secrets)
- NetworkPolicies (only the gateway reachable from ingress; services reachable only by their callers)
- Pod security standards, resource quotas and limit ranges
- Database backup/restore and disaster-recovery considerations; authentication and rate limiting at the edge
- Server hardening with Ansible: SSH daemon settings, firewall, users (from Phase 4)

## Phase 10 - Portfolio completion — Pending

- Architecture diagrams, demo scenarios (deploy, break, alert, roll back), troubleshooting guides
- Screenshots of pipelines and dashboards, CI/CD demonstrations, final documentation pass
