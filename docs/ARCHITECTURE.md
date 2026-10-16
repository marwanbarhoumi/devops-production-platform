# Architecture

## Overview

The platform is a small e-commerce style system split into three Node.js/TypeScript microservices
and one PostgreSQL server. The business logic is intentionally minimal; the architecture exists to
give later phases (CI/CD, Kubernetes, Helm, monitoring) something realistic to build, ship and operate.

```text
                         ┌──────────────────────────────────────────────┐
                         │ Docker network: devops-production-platform-   │
   client ──► :7000 ───► │                 backend                       │
                         │  ┌─────────────┐                              │
                         │  │ api-gateway │                              │
                         │  └──┬───────┬──┘                              │
                         │     │ HTTP  │ HTTP                            │
                         │     ▼       ▼                                 │
                         │ ┌─────────────────┐ HTTP ┌───────────────┐    │
                         │ │ product-service │◄─────┤ order-service │    │
                         │ └───────┬─────────┘      └──────┬────────┘    │
                         │         │ SQL (product_svc)     │ SQL (order_svc)
                         │         ▼                       ▼             │
                         │   ┌──────────────────────────────────────┐    │
                         │   │ postgres: products_db │ orders_db    │    │
                         │   └──────────────────────────────────────┘    │
                         └──────────────────────────────────────────────┘
```

## Services

### api-gateway (port 7000)

- The only component intended for clients.
- Routes by path prefix:

  | Public path | Upstream |
  | --- | --- |
  | `/api/products`, `/api/products/*` | `PRODUCT_SERVICE_URL` + `/products...` |
  | `/api/orders`, `/api/orders/*` | `ORDER_SERVICE_URL` + `/orders...` |

- Implemented as a small `fetch`-based reverse proxy (`src/proxy.ts`) rather than a generic proxy
  library, so timeout handling, error mapping and response validation are explicit and testable.
- Forwards only an allow-list of headers (`accept`, `content-type`, `accept-language`, `x-request-id`)
  plus `x-forwarded-for`. Cookies and `Authorization` are **not** forwarded.
- Normalises the target URL and rejects paths that would escape the upstream prefix
  (e.g. `/api/products/%2e%2e/metrics`) with `400 INVALID_PATH`.
- Rewrites upstream `Location` headers (`/orders/7` → `/api/orders/7`).
- Error mapping:
  - connection failure → `503 UPSTREAM_UNAVAILABLE`
  - no response within `UPSTREAM_TIMEOUT_MS` → `504 UPSTREAM_TIMEOUT`
  - non-JSON body or 3xx response → `502 BAD_GATEWAY`
  - any other upstream status (2xx/4xx/5xx with JSON) is passed through unchanged.
- Readiness (`/ready`) probes each upstream's `/health` with a 1 s timeout.

### product-service (port 7001)

- `GET /products?limit&offset`, `GET /products/:id`, `POST /products`.
- Validation with `zod`: SKU `^[A-Z0-9][A-Z0-9-]{2,31}$` (input upper-cased), name 1-120 chars,
  optional description up to 1000 chars, `priceCents` positive integer up to 10,000,000. Unknown fields
  are rejected.
- Prices are stored as integer cents to avoid floating-point rounding.
- Duplicate SKU → `409 SKU_ALREADY_EXISTS` (from PostgreSQL unique-constraint violation `23505`).

### order-service (port 7002)

- `GET /orders?limit&offset` (newest first), `GET /orders/:id`, `POST /orders`.
- `POST /orders` flow:
  1. Validate `{ productId: positive int, quantity: int 1..1000 }`.
  2. `GET {PRODUCT_SERVICE_URL}/products/{id}` with a `PRODUCT_SERVICE_TIMEOUT_MS` timeout,
     forwarding `X-Request-Id`. The response body is schema-validated.
  3. Map the outcome: 404 → `422 PRODUCT_NOT_FOUND`; timeout → `504 PRODUCT_SERVICE_TIMEOUT`;
     connection error, 5xx, invalid JSON or wrong shape → `503 PRODUCT_SERVICE_UNAVAILABLE`.
  4. Insert the order. SKU, name and unit price are **snapshotted** into the order row, and the
     total is computed in SQL as `BIGINT` (1000 × 10,000,000 exceeds a 32-bit integer).
- Note: when the product-service container is stopped, Docker's embedded DNS may not fail fast,
  so the lookup typically ends as a `504` timeout rather than a `503`. Both are handled and both leave
  no partial data.

## Data ownership

| Database | Owner role | Tables | Used by |
| --- | --- | --- | --- |
| `products_db` | `product_svc` | `products`, `schema_migrations` | product-service only |
| `orders_db` | `order_svc` | `orders`, `schema_migrations` | order-service only |

- `infra/postgres/init/01-create-service-databases.sh` runs once on an empty volume, creating the two
  roles and databases and revoking `PUBLIC` access. Passwords come from environment variables.
- Each role can only connect to its own database: services cannot read each other's tables, which
  enforces the "database per service" boundary even though one PostgreSQL server is shared.
- There is no cross-database foreign key from `orders.product_id` to `products.id`. Integrity is
  checked at write time over HTTP, and the order keeps a snapshot of the product data it needs.

### Migrations

Each service ships its migrations in `src/migrations.ts` and applies them at startup:

- a `schema_migrations` table records applied migration IDs;
- each migration runs in its own transaction;
- a PostgreSQL advisory lock (unique per service) serialises concurrent starts, so several replicas
  can boot at once safely (relevant from Phase 5);
- startup retries the migration step up to 10 times (2 s apart) while the database comes up.

## Cross-cutting concerns

| Concern | Implementation |
| --- | --- |
| Configuration | Environment variables validated with `zod` at startup; invalid config exits with code 1 and lists variable names only |
| Health | `/health` = liveness (process is up, no dependency checks) |
| Readiness | `/ready` = dependencies usable (DB for product/order, upstream `/health` for gateway); `503` when not |
| Metrics | `prom-client`, per-service registry with `service` default label; bounded labels |
| Logging | `pino` JSON logs, `pino-http` access logs, redaction of secrets; `/health`, `/ready`, `/metrics` not access-logged |
| Tracing (basic) | `X-Request-Id` generated or accepted at the edge, propagated gateway → order → product, logged everywhere |
| Shutdown | `SIGTERM`/`SIGINT` stop accepting connections, drain, close the DB pool; forced exit after 10 s |
| Timeouts | Gateway 5 s → services; order → product 2 s; DB `statement_timeout` 5 s; DB connect 5 s; HTTP server request timeout 30 s |

### Why order-service readiness ignores product-service

If order-service reported "not ready" whenever product-service was down, an orchestrator would pull
order-service out of rotation too, turning a partial outage (cannot create orders) into a full one
(cannot even list orders). Readiness therefore checks only hard dependencies; soft dependencies fail
individual requests quickly with clear status codes. This was verified with the real stack: with
product-service stopped, `GET /api/orders` still returned 200.

## Runtime (Docker Compose)

| Service | Image | Published | Health check | Starts after |
| --- | --- | --- | --- | --- |
| `postgres` | `postgres:17.7-alpine3.22` | `127.0.0.1:15432` | `pg_isready` | - |
| `product-service` | built, `node:24.16-alpine3.22` base | `127.0.0.1:7001` | `/ready` | postgres healthy |
| `order-service` | built, `node:24.16-alpine3.22` base | `127.0.0.1:7002` | `/ready` | postgres + product-service healthy |
| `api-gateway` | built, `node:24.16-alpine3.22` base | `127.0.0.1:7000` | `/health` | both services healthy |

All application containers: non-root `node` user (UID 1000), read-only root filesystem with a `/tmp`
tmpfs, all capabilities dropped, `no-new-privileges`, `init: true` for signal handling, 0.5 CPU / 256 MiB
memory limits, rotated JSON logs (3 × 10 MB). PostgreSQL data lives in the named volume
`devops-production-platform-postgres-data`.

Internal services are published on `127.0.0.1` only for local debugging. In Kubernetes (Phase 5)
they will be `ClusterIP` services reachable only through the gateway/ingress.

## Continuous integration (Jenkins)

```text
GitHub push ──webhook──► Jenkins controller ──WebSocket──► agent ci-agent-1 ──TLS──► DinD daemon
                         (0 executors)                     runs the Jenkinsfile         └─ dpp-it-<BUILD_TAG>
                                                                                           (throwaway PostgreSQL)
```

Pipeline: Checkout → Verify Toolchain → Install Dependencies (`npm ci`) → Lint → Type Check →
Unit & API Tests → Integration Tests → Build. Tests publish JUnit XML from `reports/junit/`. The
integration-test database uses the same image and init script as the Compose stack, lives only for one
build, and runs on the CI stack's private Docker daemon, so CI cannot affect the application stack. The
Jenkins stack (`jenkins/docker-compose.yml`, project `dpp-jenkins`) is independent of the application
stack. Details: [jenkins/README.md](../jenkins/README.md); rationale: DECISIONS D-015 to D-020.

Phase 3 continues the same pipeline: SonarQube Analysis (quality gate) → Trivy Filesystem Scan →
Build Images → Scan Images (Trivy + CycloneDX SBOM) → Publish Images (GHCR, `main` only). Trivy reports
(JSON and text) and SBOMs land in `reports/trivy/` and `reports/sbom/` and are archived with each build. SonarQube runs
as its own Compose project (`security/sonarqube`, `dpp-sonarqube`, 127.0.0.1:9100) with its own
PostgreSQL; the agent reaches it through `host.docker.internal`. Images are built and scanned on the
DinD daemon, so CI images never appear on the host daemon. Details:
[security/README.md](../security/README.md); rationale: DECISIONS D-021 to D-025.

## Server automation (Ansible)

```text
ansible.ps1 ──► controller container (dpp-ansible) ──SSH, key + verified host key──► Ubuntu server
                ansible-core, roles, inventory          sudo as "automation"        common, docker_engine
```

The controller is a short-lived container with the repository's `ansible/` directory mounted; it has no Docker
socket and no published ports. Inventories select servers by group `managed`; every playbook runs a preflight
that refuses placeholder addresses, non-SSH connections and unconfirmed production changes before connecting.
The roles prepare a server to run containers (baseline packages, unattended security updates, Docker Engine
and Compose from Docker's verified repository). They will provide the hosts for later phases. The local test
target (`--profile test`) is a systemd Ubuntu container on the project's own network. Details:
[ansible/README.md](../ansible/README.md); rationale: DECISIONS D-026 to D-029.
