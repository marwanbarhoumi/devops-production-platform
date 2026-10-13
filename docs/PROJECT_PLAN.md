# Project plan

**Objective:** build a small microservices application and automate its entire delivery lifecycle,
demonstrating the skills expected of a Junior DevOps / Platform Engineer. The application is a vehicle;
the DevOps tooling and practices are the product.

Status legend: **Complete** · In progress · Pending

| # | Phase | Status |
| --- | --- | --- |
| 1 | Foundation | **Complete** (2026-10-13) |
| 2 | CI with Jenkins | Pending |
| 3 | CI quality and security | Pending |
| 4 | Ansible automation | Pending |
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

- Base images pinned by tag, not digest (Phase 3).
- No authentication or rate limiting on the gateway (Phase 9).
- One shared PostgreSQL server (separate databases/roles); no backups yet (Phase 9).
- `.github/workflows/` exists but contains no workflow; Jenkins is the CI system of record (Phase 2).

---

## Phase 2 - CI with Jenkins — Pending

- Jenkins installation guidance (Jenkins in Docker with a dedicated agent, JCasC where practical)
- GitHub webhook integration and multibranch pipeline
- `Jenkinsfile`: `npm ci`, lint, type check, unit tests, build, integration tests against an ephemeral PostgreSQL
- Test reports (JUnit) and coverage publishing; artifact handling and build retention
- Docker image build validation for all three services

## Phase 3 - CI quality and security — Pending

- SonarQube server and quality gate enforced in the pipeline
- Trivy scanning of images and filesystem (dependencies, misconfigurations, secrets); fail on HIGH/CRITICAL
- Secure image builds: digest-pinned base images, SBOM generation
- Image tagging strategy (git SHA + semantic version) and publishing to a container registry

## Phase 4 - Ansible automation — Pending

- Inventory (local VMs or cloud hosts) and group variables
- Reusable roles: common hardening, Docker, Jenkins agent, Kubernetes node prerequisites
- Playbooks for provisioning the CI and runtime hosts; idempotency verified by a second run reporting no changes
- Secrets handled with Ansible Vault

## Phase 5 - Kubernetes — Pending

- Namespaces per environment; Deployments and Services for each microservice
- ConfigMaps and Secrets; liveness/readiness probes mapped to `/health` and `/ready`
- Resource requests and limits; HorizontalPodAutoscaler
- PostgreSQL StatefulSet with PersistentVolumeClaim (or an external database), migration strategy
- Ingress for the gateway; RBAC and service accounts

## Phase 6 - Helm — Pending

- Reusable chart (or umbrella chart) for the platform
- Configurable values; environment-specific values files (dev, staging, prod)
- Release management: install, upgrade, history, rollback; chart linting and templating checks in CI

## Phase 7 - Continuous deployment — Pending

- Jenkins deployment pipeline with staged promotion (dev → staging → production approval)
- Immutable image versioning; deployment verification using readiness and smoke tests
- Rolling update strategy and automated rollback (`helm rollback`) on failed verification

## Phase 8 - Monitoring and alerting — Pending

- Prometheus scraping service `/metrics` and Kubernetes metrics (kube-state-metrics, node-exporter)
- Grafana dashboards: RED metrics per service, upstream health, database, cluster resources
- Alertmanager with actionable alerts (error rate, latency, availability, pod restarts, saturation) and runbooks

## Phase 9 - Platform hardening — Pending

- Security review; secret management (e.g. Sealed Secrets or External Secrets)
- NetworkPolicies (only the gateway reachable from ingress; services reachable only by their callers)
- Pod security standards, resource quotas and limit ranges
- Database backup/restore and disaster-recovery considerations; authentication and rate limiting at the edge

## Phase 10 - Portfolio completion — Pending

- Architecture diagrams, demo scenarios (deploy, break, alert, roll back), troubleshooting guides
- Screenshots of pipelines and dashboards, CI/CD demonstrations, final documentation pass
