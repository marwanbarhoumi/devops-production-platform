# Technical decisions

Lightweight architecture decision records. Each entry states the decision, why it was made and what
it costs. New entries are appended; superseded ones are marked rather than deleted.

## D-001 Monorepo with npm workspaces

**Decision:** one Git repository, root `package.json` with workspaces `services/*`, a single lockfile.

**Why:** one place for CI configuration, consistent tooling versions, one `npm ci`, and simple atomic
changes across services, which suits a portfolio project and a single Jenkins pipeline (Phase 2).

**Trade-off:** services are not independently versioned repos. Each still has its own `package.json`,
Dockerfile and image, so they can be built and deployed independently.

## D-002 No shared library package (for now)

**Decision:** small infrastructure modules (`logger.ts`, `metrics.ts`, `http.ts`, `db.ts`) are duplicated
in each service instead of living in a shared workspace package.

**Why:** keeps every Docker build self-contained (no build-order coupling between workspaces) and lets
services evolve independently. The duplicated code is around 250 lines.

**Trade-off:** fixes must be applied in more than one place. Revisit if the shared surface grows;
a `packages/service-kit` workspace would be the next step.

## D-003 Node.js 24 LTS, TypeScript 6.0, Express 5

- **Node.js 24** is the Active LTS line; the Docker base image is pinned to `node:24.16-alpine3.22`
  (same version used locally). `engines` allows Node >= 22.12 for development.
- **TypeScript is pinned to `~6.0`** even though 7.x exists, because `typescript-eslint` 8.x supports
  TypeScript `<6.1` only. Type-aware linting was judged more valuable than the newest compiler.
- **Express 5** forwards rejected promises from async handlers to the error middleware natively,
  removing the need for wrapper utilities.
- ESM (`"type": "module"`, `NodeNext` resolution) throughout.

## D-004 Validation with zod, both for requests and configuration

Request bodies, query strings, path parameters, environment variables and the product-service
response consumed by order-service are all parsed with `zod`. Error messages identify fields or
variable names only, so secrets cannot leak through validation errors.

## D-005 Money as integer cents

`priceCents`, `unitPriceCents` and `totalCents` are integers. `total_cents` is `BIGINT` and is computed
in SQL. Floating-point currency arithmetic is avoided entirely.

## D-006 One PostgreSQL server, one database and role per service

**Why:** "database per service" ownership without the resource cost of three PostgreSQL containers on
a laptop. Separate roles with `CONNECT` revoked from `PUBLIC` prevent a service from touching another
service's data.

**Trade-off:** a single server is a shared failure domain. In production each database could move to
its own instance (or a managed service) without code changes, since services only see connection settings.

## D-007 Startup migrations in code, not a migration framework

**Decision:** a ~50-line migration runner (`db.ts`) with a `schema_migrations` table, transactional
migrations and an advisory lock.

**Why:** no extra dependency or container, works identically in Compose and Kubernetes, and is safe
with multiple replicas thanks to the advisory lock.

**Trade-off:** no down-migrations. Rollbacks must be handled by writing backward-compatible
("expand/contract") migrations, which is also what zero-downtime deployments in Phase 7 require.
A dedicated tool (e.g. a Kubernetes Job running migrations) can replace this later.

## D-008 Hand-written gateway proxy

**Decision:** the gateway uses `fetch` with `AbortSignal.timeout` instead of `http-proxy-middleware`.

**Why:** the requirements (timeouts, mapping failures to 502/503/504, rejecting invalid upstream
responses, header allow-listing, path-escape protection, Location rewriting, per-upstream metrics) are
easier to express and test explicitly. Responses are buffered, which is acceptable for small JSON APIs.

**Trade-off:** no streaming or WebSocket support. An ingress controller or dedicated gateway (Envoy,
NGINX, Kong) would be the production choice at scale; this is revisited in Phase 5.

## D-009 Order creation: synchronous validation and price snapshot

order-service calls product-service synchronously and stores SKU, name and price in the order row.
Inventory/stock and distributed transactions are deliberately out of scope. Orders remain correct even
if a product's price changes later.

## D-010 Readiness only checks hard dependencies

See [ARCHITECTURE.md](ARCHITECTURE.md#why-order-service-readiness-ignores-product-service). The gateway
is the exception: it has no function without its upstreams, so its readiness reflects theirs.

## D-011 Observability conventions

- One Prometheus registry per app instance (also makes tests isolated), a `service` default label.
- Label values are bounded: route *patterns*, a fixed method set (`OTHER` for anything else), status
  codes, upstream names and outcome enums. No IDs, raw URLs or user input in labels.
- JSON logs to stdout (12-factor) so Docker, Kubernetes and later a log stack can collect them.
- `X-Request-Id` is the correlation ID across services until proper tracing is introduced.

## D-012 Container hardening defaults

Multi-stage builds (compiler and dev dependencies never reach the runtime image), `npm ci` from the
lockfile, `USER node`, `read_only` root filesystem, `cap_drop: ALL`, `no-new-privileges`, CPU/memory
limits, `init: true`, log rotation, explicit image tags. Services bind to `127.0.0.1` on the host by default.

**Known limitation:** base images are pinned by tag, not digest. Digest pinning plus automated updates
and Trivy scanning are planned for Phase 3.

## D-013 Testing strategy

| Layer | Tooling | Needs | Command |
| --- | --- | --- | --- |
| Unit / HTTP API | Vitest + Supertest, in-memory fakes | nothing | `npm test` |
| Service-to-service | Real local HTTP stub servers (gateway, product client) | nothing | `npm test` |
| Database integration | Real PostgreSQL from Compose | Docker | `npm run test:integration` |
| Database integration (CI) | Disposable PostgreSQL container per run, JUnit XML | Docker | `npm run test:integration:ci` |
| End-to-end smoke | Node script through the gateway | running stack | `npm run test:smoke` |

`npm run test:ci` runs the unit/API layer with JUnit XML output (see D-018).

The integration layer earned its place during Phase 1: it caught a PostgreSQL parameter-type error in
order creation (`$4` used as both `integer` and `bigint`) that in-memory unit tests could not detect.

## D-014 Host port for PostgreSQL defaults to 15432

Many developer machines already run PostgreSQL on 5432 (on the build machine for this project both 5432
and 5433 were taken). The container still listens on 5432 internally; only the host mapping changed.

## D-015 Jenkins: controller plus one inbound Docker agent, WebSocket transport

**Decision:** a Jenkins LTS controller with **0 executors** and a separate inbound agent container
(`ci-agent-1`, labels `linux nodejs24 docker`) defined in `jenkins/docker-compose.yml`. The agent connects
over WebSocket through the controller's HTTP port.

**Why:** application builds never run inside the controller process (Jenkins' own security guidance).
WebSocket removes the need for the inbound TCP port 50000; only the web UI is published, on `127.0.0.1`.
An inbound agent avoids giving the controller SSH keys to the agent.

**Trade-off:** registering the agent needs its secret, which Jenkins generates only once security is
set up. `jenkins/rotate-agent-secret.ps1` (no login; rotates the key) or `jenkins/save-agent-secret.ps1`
(with a login) write it to the git-ignored `jenkins/secrets/agent-secret`. Manual copying produced an
empty file in practice, so the agent entrypoint now validates the file. An SSH or cloud (Docker plugin)
agent could remove that step at the cost of more credentials and plugins.

## D-016 Docker-in-Docker for pipeline containers instead of the host Docker socket

**Decision:** the agent talks to a private `docker:dind` sidecar over mutual TLS (`DOCKER_HOST=tcp://docker:2376`),
not to the host daemon through `/var/run/docker.sock`.

**Why:** with the host socket, any pipeline step can see, stop or delete every container and volume on
the machine, including the application stack and its database. With DinD, the integration-test database
and anything else a build starts live in a separate daemon. It also works the same on Docker Desktop for
Windows/macOS and on Linux, and it is the setup described in Jenkins' official Docker guide.

**Trade-off:** the DinD container must run `privileged`, which is root-equivalent on the Docker Desktop VM
or Linux host. Acceptable for a local portfolio CI that only builds this repository's trusted branches.
Not acceptable for building untrusted pull requests; Kubernetes agents with rootless builders are the
production direction (Phases 5 and 9). Images pulled inside DinD are cached in its own volume.

## D-017 Disposable integration-test database driven by a Node script

**Decision:** `scripts/run-integration-tests.mjs --ephemeral-db` starts one PostgreSQL container per run
(`scripts/ci/ephemeral-postgres.mjs`), using the image tag from `docker-compose.yml` and the existing
`infra/postgres/init` script, then removes it.

**Why:**
- Same code path locally (Docker Desktop) and in Jenkins (DinD), so CI failures are reproducible on a laptop.
- `docker cp` copies the init script into the container instead of bind-mounting it, because bind-mount
  paths are resolved by the daemon. A path inside the agent's workspace does not exist on the DinD host.
- Data on `tmpfs`: no volume is ever created, so nothing can be left behind or confused with the
  development volume. The container is published on a random port.
- Random per-run passwords are passed to Docker as environment variables (`--env NAME` without a value),
  so they never appear in process arguments or build logs. No Jenkins credential is needed.
- Cleanup is layered: `finally`-style shutdown, SIGTERM/SIGINT handlers (Jenkins abort), and a Jenkinsfile
  `post { always }` backstop that removes only containers labelled `dpp.ci.run=<BUILD_TAG>`.

**Trade-off:** a few dozen lines of orchestration code instead of a Compose file. A Compose file was
rejected because it would need bind mounts (see above) or a custom image, and gives no extra safety.

## D-018 JUnit reports from Vitest's built-in reporter

**Decision:** each Vitest config adds the built-in `junit` reporter only when `JUNIT_REPORTS_DIR` is set.
Reports go to `reports/junit/unit/<service>.xml` and `reports/junit/integration/<service>.xml`, with
suite and class names prefixed by service (`product-service.unit.products`). The CI runners delete old
reports first, run every suite even after a failure, and fail if any expected report is missing, empty or
not a JUnit document. The Jenkinsfile publishes with `allowEmptyResults: false`.

**Why:** no extra dependency. Plain `npm test` output is unchanged for developers, and a crashed runner
cannot pass as "no tests".

## D-019 Jenkins controller configuration as code, security through the setup wizard

**Decision:** the controller image pins Jenkins `2.580.1-lts-jdk21` and all 75 plugins (direct and transitive)
in `jenkins/controller/plugins.txt`. JCasC (`casc.yaml`) defines the agent node, 0 controller executors
and the root URL. The admin account is created in the setup wizard, not in code.

**Why:** a rebuilt image gives the same controller. Keeping security out of JCasC means no admin
password, even a placeholder, lives in the repository, and the setup wizard's one-time password flow is used as intended.

**Trade-off:** the pipeline job is created once in the UI (documented step by step) rather than with
Job DSL, to keep the plugin set small.

## D-020 Jenkins web UI on port 8090

Port 8080 (Jenkins' default) was already taken on the build machine by Docker Desktop and WSL port relays,
and is commonly used by other local tools. The controller still listens on 8080 inside its container.
Change `JENKINS_HTTP_PORT` and `JENKINS_URL` in `jenkins/.env` to use another port.

## D-021 SonarQube as a separate local stack, reached through the host

**Decision:** SonarQube Community Build 26.10 with its own PostgreSQL 17 runs as the Compose project
`dpp-sonarqube` (`security/sonarqube/`), published on `127.0.0.1:9100`. The Jenkins agent reaches it at
`host.docker.internal:9100`.

**Why:** SonarQube, Jenkins and the application keep separate lifecycles, networks, databases and volumes;
stopping one never affects the others. Going through the host avoids a shared Docker network that would make
one Compose project depend on another. Port 9000 was taken on the build machine.

**Trade-off:** `host.docker.internal` is a Docker Desktop name; on plain Linux the agent's
`extra_hosts: host-gateway` entry provides it, but SonarQube must then listen on an address the Docker
bridge can reach.

## D-022 Quality gate enforced by the scanner, not by a Jenkins plugin

**Decision:** `sonar.qualitygate.wait=true` makes SonarScanner CLI (installed in the agent image) wait for
the gate and fail the stage. The token is a SonarQube *project analysis token* stored as the Jenkins
credential `sonarqube-token`. The default gate "Sonar way" applies.

**Why:** no extra Jenkins plugin (and its transitive dependencies) to pin, and no webhook from SonarQube
back to Jenkins, which would need Jenkins to be reachable from SonarQube. The project-scoped token can only
analyze this project.

**Trade-off:** the Jenkins UI shows no SonarQube badge; the log prints the dashboard link instead.

## D-023 Trivy policy: block fixable HIGH/CRITICAL, report the rest

**Decision:** Trivy scans the repository (lockfile, secrets, Dockerfiles) and each image. HIGH/CRITICAL
vulnerabilities with a fixed version, and HIGH/CRITICAL secrets and misconfigurations, fail the build. Unfixed
vulnerabilities are reported only. Exceptions need a `.trivyignore` entry with an expiry date. The policy is
evaluated in Node from Trivy's JSON report.

**Why:** a gate developers can always act on (upgrade to the fixed version) instead of one that blocks on
issues nobody can fix yet. One Trivy run per target gives both the full archived report and the decision.

## D-024 Minimal runtime images: package managers removed, OS updates applied

**Decision:** the service runtime stage runs `apk upgrade` and deletes npm, npx, corepack and yarn after
installing production dependencies. The Node base image is pinned by digest.

**Why:** Trivy found 13 HIGH and 1 CRITICAL advisories, all in npm's bundled dependencies (tar, undici,
sigstore, ...) and in Alpine's OpenSSL. The services only run `node dist/server.js`, so a package manager in a
production image is attack surface without benefit.

**Trade-off:** `apk upgrade` makes the runtime layer depend on the build date; the digest-pinned base
keeps everything else reproducible, and Trivy verifies every build.

## D-025 Image tags and registry

**Decision:** images are tagged `<sha12>` and `<version>-<sha7>` (service `package.json` version), never
`latest`, and published to GitHub Container Registry only from `main`, after all checks. Publishing uses a
Jenkins *Username with password* credential (`container-registry`) and a throwaway Docker config; without the
credential the stage is skipped with an explicit message.

**Why:** immutable, traceable tags (the SHA ties an image to its commit; the version is readable). GHCR sits
next to the source repository and needs no extra account. The pipeline stays green and useful before a
registry token exists, and the token never persists on the agent.

## D-026 Ansible runs in a container, not on Windows

**Decision:** the Ansible controller is a local image (`ansible/Dockerfile`: digest-pinned Python 3.13, ansible-core
2.21.5, ansible-lint 26.10.1, all Python dependencies pinned in `requirements.txt`) run through `ansible.ps1`
as the Compose project `dpp-ansible`. The container runs as a non-root user with a read-only root filesystem,
no capabilities and no Docker socket. SSH keys are read at run time from git-ignored `ansible/.ssh/` and copied
into a tmpfs with mode 600; `ANSIBLE_CONFIG` points to `/ansible/ansible.cfg`.

**Why:** Ansible does not run natively on Windows, and a pinned image gives every run (and later Jenkins) the
same versions. Keys cannot be baked into the image, and the copy is needed because Windows bind mounts show
every file as 0777, which OpenSSH rejects for private keys and which makes Ansible ignore a config file in the
working directory.

**Trade-off:** no SSH agent in the container, so automation keys cannot have a passphrase; they are dedicated
keys, separate for production. A password file for Vault would also appear executable; `--ask-vault-pass` is
documented instead.

## D-027 Guard rails before any connection

**Decision:** `ansible.cfg` has no default inventory and enforces `StrictHostKeyChecking=yes` with a project
`known_hosts` file. Example inventories use the reserved `.invalid` domain and are copied to git-ignored
`*.ini` files. Every playbook first runs `playbooks/tasks/preflight.yml` with `gather_facts: false`: it requires
`deployment_environment` (test, dev or prod), refuses `.invalid`/placeholder addresses and non-SSH connections
(`local`, `docker`, `winrm`, `psrp`), and refuses changes to prod hosts without `-e confirm_production=true`
(check mode is allowed).

**Why:** the dangerous mistakes are running against the wrong machine (including the Windows host) or against
production by accident; both are stopped before Ansible opens a connection. Host keys are added only after an
out-of-band fingerprint check, so a changed key stops the run instead of being trusted silently.

## D-028 Docker Engine from Docker's repository, verified, with no implicit docker group members

**Decision:** the `docker_engine` role installs Docker CE, containerd, Buildx and Compose from Docker's apt
repository (deb822 `docker.sources`, `Signed-By` a key in `/etc/apt/keyrings`). The downloaded key must match the
pinned fingerprint `9DC858229FC7DD38854AE2D88D81803C0EBFCD88` before the repository is added. Distribution
Docker packages stop the run unless their removal is explicitly allowed. `docker_engine_users` is empty by
default, the role never creates users, and listed users must already exist. Packages use `state: present`;
an optional exact version can be pinned.

**Why:** Docker's repository is the supported source for current Engine and Compose v2 versions; verifying the
fingerprint protects against a substituted key. Docker group membership is root-equivalent, so it is only ever
granted on purpose. Upgrades are deliberate operations, not side effects of a configuration run.

**Common role scope:** packages, unattended security upgrades and the keyrings directory only. SSH, firewall,
network and user hardening are left for Phase 9, where they can be designed and tested without the risk of
locking an administrator out of a server.

## D-029 Local test target: a systemd Ubuntu container reached over SSH

**Decision:** `ansible/test/` builds a disposable Ubuntu 24.04 container running systemd and OpenSSH (key-only,
an `automation` user with passwordless sudo, keys from a Docker volume generated per run) and runs the real
playbooks against it over SSH from the controller: lint, syntax, safety refusals, check mode, apply, a second run
and check mode with `changed=0`, and `docker run hello-world` inside the target. Everything is removed
afterwards.

**Why:** no VM was available, and Ansible's SSH path, `sudo`, apt, systemd and the Docker daemon can all be
exercised realistically this way, on any machine with Docker Desktop. The target is privileged (systemd and a
nested Docker Engine need it) and gets volumes for `/var/lib/docker` and `/var/lib/containerd`, because
overlayfs cannot be stacked on the container's own overlay root.

**Trade-off:** a container is not a VM: kernel, boot, cloud-init, firewall and real network behaviour are not
tested. The first run against a real server must start with `--check --diff`.

## Roadmap changes

Any change to [PROJECT_PLAN.md](PROJECT_PLAN.md) phases is recorded here.

- **2026-10-14:** coverage publishing and Docker image build validation moved from Phase 2 to Phase 3.
  Coverage is mainly an input to the SonarQube quality gate, and image builds belong with Trivy scanning,
  tagging and registry publishing. Phase 2 focuses on the pipeline, test reporting and the Jenkins platform.
  The DevOps-first order of the roadmap is unchanged.
- **2026-10-14:** Phase 4 delivers the `common` and `docker_engine` roles with a local end-to-end test. The
  Jenkins agent role moves to Phase 7, which decides how deployments reach servers, and Kubernetes node
  prerequisites move to Phase 5, where the cluster type (local or kubeadm) is chosen. Server hardening
  (SSH, firewall) moves to Phase 9 (D-028). Ansible Vault is documented as a pattern; no role needs a secret yet.
