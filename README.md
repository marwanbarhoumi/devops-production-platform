# devops-production-platform

A production-oriented microservices platform built as a **DevOps portfolio project**. The application
(a tiny product/order system) is deliberately small; the focus is on automating and operating its full
software delivery lifecycle: CI/CD with Jenkins, container security, Ansible, Kubernetes, Helm,
Prometheus/Grafana/Alertmanager monitoring, and documented deployment and rollback strategies.

## Current status

| Phase | Scope | Status |
| --- | --- | --- |
| 1 | Foundation: microservices, PostgreSQL, Docker Compose, tests, health checks, metrics | **Complete** |
| 2 | CI with Jenkins: `Jenkinsfile`, local controller + build agent, JUnit reports, disposable test database | **Complete** ([jenkins/README.md](jenkins/README.md)) |
| 3 | DevSecOps: coverage, SonarQube quality gate, Trivy scans, image build + SBOM, GHCR publishing | **Complete** ([security/README.md](security/README.md)); registry push needs a GHCR token |
| 4 | Ansible: containerized controller, inventories, `common` and `docker_engine` roles, safety checks, local end-to-end test | **Complete** ([ansible/README.md](ansible/README.md)); no real VM configured yet |
| 8 | Monitoring and alerting: Prometheus, Grafana dashboard, Alertmanager, 6 tested alert rules (Docker Compose) | **Complete** ([monitoring/README.md](monitoring/README.md)) |
| 5 | Kubernetes (Minikube, Kustomize): services, PostgreSQL StatefulSet, probes, RBAC, NetworkPolicies, Prometheus with kube-state-metrics and node-exporter, 8 tested Kubernetes alerts, "Kubernetes platform" dashboard | **Complete** ([kubernetes/README.md](kubernetes/README.md)); validated on Minikube with real failure tests |
| 6-7, 9-10 | Helm, CD, hardening, portfolio | Pending |

See [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for the full roadmap and verification results,
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the system design and
[docs/DECISIONS.md](docs/DECISIONS.md) for the reasoning behind technical choices.

## Architecture at a glance

```text
                 client
                   │  :7000
            ┌──────▼──────┐
            │ api-gateway │  /api/products/*  /api/orders/*
            └──┬───────┬──┘
     :7001     │       │      :7002
 ┌─────────────▼──┐  ┌─▼─────────────┐
 │product-service │◄─┤ order-service │  validates products over HTTP
 └───────┬────────┘  └───────┬───────┘
         │ products_db       │ orders_db
         └────────┬──────────┘
            ┌─────▼─────┐
            │PostgreSQL │  one server, one database + role per service
            └───────────┘
```

| Component | Port | Responsibility |
| --- | --- | --- |
| `api-gateway` | 7000 | Single entry point, routing, timeouts, upstream error mapping |
| `product-service` | 7001 | Product catalogue (list, get, create) in `products_db` |
| `order-service` | 7002 | Orders (create, list, get) in `orders_db`; validates products via `product-service` |
| `postgres` | 5432 (host: 15432) | PostgreSQL 17 with persistent volume |

Stack: Node.js 24 LTS, TypeScript, Express 5, PostgreSQL 17, `pg`, `zod`, `pino`, `prom-client`,
Vitest + Supertest, ESLint (typescript-eslint), Docker multi-stage builds, Docker Compose.

## Repository layout

```text
devops-production-platform/
├── services/
│   ├── api-gateway/          # src/, test/, Dockerfile
│   ├── product-service/      # src/, test/ (unit + *.int.test.ts), Dockerfile
│   └── order-service/        # src/, test/ (unit + *.int.test.ts), Dockerfile
├── infra/postgres/init/      # first-boot script: per-service roles and databases
├── scripts/                  # dev runner, integration-test runner, smoke test
│   └── ci/                   # CI helpers: toolchain, tests, disposable PostgreSQL, Trivy, images
├── jenkins/                  # local Jenkins: controller + agent + DinD (docker-compose.yml, README)
├── security/                 # SonarQube stack + bootstrap, security guide (Phase 3)
├── ansible/                  # Ansible controller (container), inventories, roles, playbooks, local test (Phase 4)
├── monitoring/               # Prometheus, Grafana, Alertmanager stack, alert rules + tests, dashboards (Phase 8, 5)
├── kubernetes/               # Kustomize manifests: app/ (devops-platform), monitoring/ (Phase 5)
├── docs/                     # PROJECT_PLAN, ARCHITECTURE, DECISIONS
├── helm/                     # future phase (placeholder)
├── Jenkinsfile               # CI pipeline
├── sonar-project.properties  # SonarQube analysis settings
├── .trivyignore.yaml         # accepted Trivy findings (path-scoped, with expiry)
├── docker-compose.yml
├── .env.example
├── eslint.config.mjs
├── tsconfig.base.json
└── package.json              # npm workspaces root
```

## 1. Prerequisites

| Tool | Version | Used for |
| --- | --- | --- |
| [Docker Desktop](https://docs.docker.com/get-docker/) or Docker Engine + Compose v2 | Docker 24+, Compose 2.20+ | Running the platform |
| [Node.js](https://nodejs.org/) | 22.12+ (24 LTS recommended) | Tests, lint, build, local dev |
| npm | 10+ (bundled with Node.js) | Workspaces and scripts |
| Git | any recent | Version control |

`curl` is used in the examples (`curl.exe` on Windows PowerShell; plain `curl` is an alias for
`Invoke-WebRequest` in Windows PowerShell 5.1).

## 2. Configure environment variables

```bash
cp .env.example .env              # Linux / macOS / Git Bash
Copy-Item .env.example .env       # Windows PowerShell
```

Then edit `.env` and replace the three `change-me-*` passwords. `.env` is git-ignored; never commit it.

| Variable | Default | Purpose |
| --- | --- | --- |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` | `postgres` / *(required)* | PostgreSQL superuser (container + init only) |
| `PRODUCT_DB_PASSWORD` | *(required)* | Password for role `product_svc` (owns `products_db`) |
| `ORDER_DB_PASSWORD` | *(required)* | Password for role `order_svc` (owns `orders_db`) |
| `POSTGRES_HOST_PORT` | `15432` | Host port for PostgreSQL (bound to 127.0.0.1) |
| `GATEWAY_BIND_ADDRESS` / `GATEWAY_HOST_PORT` | `127.0.0.1` / `7000` | Where the gateway is published |
| `PRODUCT_SERVICE_HOST_PORT` / `ORDER_SERVICE_HOST_PORT` | `7001` / `7002` | Debug ports for internal services (127.0.0.1 only) |
| `UPSTREAM_TIMEOUT_MS` | `5000` | Gateway → service timeout |
| `PRODUCT_SERVICE_TIMEOUT_MS` | `2000` | order-service → product-service timeout |
| `LOG_LEVEL` | `info` | `fatal`/`error`/`warn`/`info`/`debug`/`trace` |
| `IMAGE_TAG` | `local` | Tag for locally built images |

> The PostgreSQL init script only runs when the data volume is created for the first time. If you
> change the database passwords afterwards, recreate the volume: `docker compose down -v` (this deletes all data).

Each service validates its own configuration at startup and exits with a clear message listing
the invalid **variable names** (never their values) if something is missing.

## 3. Install dependencies

```bash
npm ci          # installs all workspaces from the lockfile (use `npm install` to add/upgrade packages)
```

Not required just to run the platform with Docker Compose; the images install their own dependencies.

## 4. Start the platform

```bash
docker compose up -d --build --wait     # or: npm run compose:up
docker compose ps
```

`--wait` returns once every container is healthy. Startup order is enforced by health checks:
PostgreSQL → product-service → order-service → api-gateway. Each service applies its own database
migrations on startup; product-service seeds five sample products.

### Local development with hot reload (optional)

```bash
docker compose up -d postgres --wait
docker compose stop api-gateway order-service product-service   # free ports 7000-7002 if running
npm run dev                                                      # tsx watch for all three services
```

## 5. Check health

```bash
curl http://localhost:7000/health        # liveness
curl http://localhost:7000/ready         # readiness: can the gateway reach both services?
curl http://localhost:7001/ready         # product-service: database reachable?
curl http://localhost:7002/ready         # order-service: database reachable?
```

```json
{"status":"ok","service":"api-gateway","uptimeSeconds":24}
{"status":"ready","service":"api-gateway","checks":{"product-service":"ok","order-service":"ok"}}
{"status":"ready","service":"product-service","checks":{"database":"ok"}}
```

When a dependency is down, `/ready` returns **HTTP 503**, for example
`{"status":"not_ready","service":"api-gateway","checks":{"product-service":"unavailable","order-service":"ok"}}`.

## 6. Use the API (always through the gateway)

```bash
# List products (pagination: limit 1-100, default 50; offset >= 0)
curl "http://localhost:7000/api/products?limit=2&offset=0"
```

```json
{
  "data": [
    {"id":1,"sku":"KB-001","name":"Mechanical Keyboard","description":"Tenkeyless keyboard with hot-swappable switches","priceCents":8999,"createdAt":"2026-10-13T22:31:45.129Z"},
    {"id":2,"sku":"MS-001","name":"Wireless Mouse","description":"Ergonomic 2.4 GHz wireless mouse","priceCents":2999,"createdAt":"2026-10-13T22:31:45.129Z"}
  ],
  "pagination": {"limit":2,"offset":0,"count":2}
}
```

```bash
# Get one product
curl http://localhost:7000/api/products/1          # -> {"data":{...product...}}

# Create a product (201 + Location: /api/products/<id>)
curl -X POST http://localhost:7000/api/products \
  -H "Content-Type: application/json" \
  -d '{"sku":"CAM-001","name":"Webcam","description":"1080p webcam","priceCents":4999}'

# Create an order (201 + Location: /api/orders/<id>)
curl -X POST http://localhost:7000/api/orders \
  -H "Content-Type: application/json" \
  -d '{"productId":1,"quantity":2}'
```

```json
{"data":{"id":1,"productId":1,"productSku":"KB-001","productName":"Mechanical Keyboard","quantity":2,"unitPriceCents":8999,"totalCents":17998,"status":"CREATED","createdAt":"2026-10-13T22:40:00.000Z"}}
```

```bash
# List orders (newest first) and get one order
curl http://localhost:7000/api/orders
curl http://localhost:7000/api/orders/1
```

PowerShell users: use `curl.exe` and escape inner quotes, e.g.
`curl.exe -X POST http://localhost:7000/api/orders -H "Content-Type: application/json" -d '{\"productId\":1,\"quantity\":2}'`.

### Error format and status codes

All errors share one shape: `{"error":{"code":"...","message":"...","details":[...],"requestId":"..."}}`.
`details` is present only for validation errors. Every response carries an `X-Request-Id` header
(a client-supplied one is reused), which is propagated to downstream services and appears in logs.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR`, `INVALID_ID`, `INVALID_JSON`, `INVALID_PATH` | Bad input |
| 404 | `NOT_FOUND`, `PRODUCT_NOT_FOUND`, `ORDER_NOT_FOUND` | Unknown route or resource |
| 409 | `SKU_ALREADY_EXISTS` | Duplicate product SKU |
| 413 | `PAYLOAD_TOO_LARGE` | Body over the size limit |
| 422 | `PRODUCT_NOT_FOUND` | Order references a product that does not exist |
| 500 | `INTERNAL_ERROR` | Unexpected error (details are logged, never returned) |
| 502 | `BAD_GATEWAY` | A service returned a non-JSON or otherwise invalid response |
| 503 | `UPSTREAM_UNAVAILABLE`, `PRODUCT_SERVICE_UNAVAILABLE` | A dependency could not be reached |
| 504 | `UPSTREAM_TIMEOUT`, `PRODUCT_SERVICE_TIMEOUT` | A dependency did not answer within its timeout |

## 7. Metrics

Every service exposes Prometheus metrics at `GET /metrics`:

```bash
curl http://localhost:7000/metrics
curl http://localhost:7001/metrics
curl http://localhost:7002/metrics
```

```text
http_requests_total{method="GET",route="/products/:id",status_code="200",service="product-service"} 1
http_request_duration_seconds_bucket{le="0.05",method="GET",route="/products/:id",status_code="200",service="product-service"} 1
gateway_upstream_requests_total{upstream="product-service",outcome="success",service="api-gateway"} 1
orders_created_total{service="order-service"} 1
process_resident_memory_bytes{service="product-service"} 83128320
```

| Metric | Service | Labels |
| --- | --- | --- |
| `http_requests_total`, `http_request_duration_seconds` | all | `method`, `route` (pattern, not raw URL), `status_code` |
| `gateway_upstream_requests_total`, `gateway_upstream_request_duration_seconds` | gateway | `upstream`, `outcome` |
| `orders_created_total` | order-service | - |
| `order_product_lookup_failures_total` | order-service | `reason` (`not_found`/`timeout`/`unavailable`) |
| Node.js process metrics (`process_*`, `nodejs_*`) | all | - |

Labels are bounded to keep cardinality low: routes are recorded as patterns (`/products/:id`),
unknown paths collapse into `route="unmatched"`.

### Monitoring stack (Prometheus, Grafana, Alertmanager)

A separate Compose project in `monitoring/` scrapes these endpoints, shows them on a Grafana dashboard and
alerts on availability, error rate, latency, CPU and memory. Start it after the application stack:

```powershell
Copy-Item monitoring/.env.example monitoring/.env     # once; set GRAFANA_ADMIN_PASSWORD
docker compose -f monitoring/docker-compose.yml up -d --wait
```

| UI | Address | Notes |
| --- | --- | --- |
| Grafana | <http://localhost:3000> | Login from `monitoring/.env`; dashboard **Platform overview** |
| Prometheus | <http://localhost:9090/targets> | All 6 targets should be UP; alerts at `/alerts` |
| Alertmanager | <http://localhost:9093> | Active alerts, silences; notifications go to a webhook URL kept in a git-ignored file |

All three are bound to 127.0.0.1. Alert rules, runbooks, notification setup and alert tests:
[monitoring/README.md](monitoring/README.md).

### Kubernetes (optional)

The same images and monitoring configuration also run on a local Kubernetes cluster (Minikube), with
kube-state-metrics, node-exporter, Kubernetes alerts and a "Kubernetes platform" dashboard. Compose stays the
default way to run the platform. Cluster setup, private image access, deployment and port-forwards:
[kubernetes/README.md](kubernetes/README.md).

## 8. Test, lint, type-check and build

| Command | What it does |
| --- | --- |
| `npm run lint` | ESLint with type-aware typescript-eslint rules |
| `npm run typecheck` | `tsc --noEmit` for every service (sources and tests) |
| `npm test` | Unit/API tests for all services (no database or Docker needed) |
| `npm run build` | Compiles each service to `services/<name>/dist` |
| `npm run validate` | lint + typecheck + test + build |
| `npm run test:integration` | Repository tests against real PostgreSQL (needs `docker compose up -d postgres --wait`) |
| `npm run test:smoke` | End-to-end checks through the gateway against a running platform |
| `npm run compose:validate` | `docker compose config --quiet` (needs `.env`) |
| `npm run test:ci` | Unit/API tests with JUnit XML in `reports/junit/unit/` (used by Jenkins) |
| `npm run test:integration:ci` | Integration tests against a disposable PostgreSQL container, JUnit XML in `reports/junit/integration/`. Needs Docker, not `.env`; never touches the Compose stack |
| `npm run ci:toolchain` | Checks Node/npm against `engines`, plus git and Docker (first CI stage) |

Continuous integration runs these same commands in Jenkins; see [jenkins/README.md](jenkins/README.md).

## 9. Logs and shutdown

```bash
docker compose logs -f --tail=100                 # all services (npm run compose:logs)
docker compose logs -f order-service              # one service
docker compose logs order-service | grep <request-id>   # trace a single request
docker compose stop                               # stop, keep containers and data
docker compose down                               # remove containers, keep the database volume
docker compose down -v                            # remove containers AND delete all data
```

Logs are structured JSON (one object per line) produced by `pino`. Health, readiness and metrics
requests are not access-logged to keep noise down. Authorization and cookie headers, passwords and
connection strings are redacted.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `POSTGRES_PASSWORD must be set in .env` | Create `.env` from `.env.example` |
| `ports are not available ... 15432` (or 7000-7002) | Change the matching `*_HOST_PORT` in `.env` |
| Services restart with `password authentication failed` | Passwords changed after first start: `docker compose down -v` then start again |
| `npm run test:integration` cannot connect | Start PostgreSQL first: `docker compose up -d postgres --wait` |
| `npm run dev` fails with `EADDRINUSE` | Stop the Compose app containers (see section 4) |

## Security notes

No real credentials are stored in the repository; `.env` is git-ignored and `.env.example` only contains
placeholders. Containers run as the unprivileged `node` user with a read-only root filesystem, all Linux
capabilities dropped and `no-new-privileges`. Each service connects with its own least-privilege
database role. See [docs/DECISIONS.md](docs/DECISIONS.md) for details and known limitations.
