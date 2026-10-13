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
| End-to-end smoke | Node script through the gateway | running stack | `npm run test:smoke` |

The integration layer earned its place during Phase 1: it caught a PostgreSQL parameter-type error in
order creation (`$4` used as both `integer` and `bigint`) that in-memory unit tests could not detect.

## D-014 Host port for PostgreSQL defaults to 15432

Many developer machines already run PostgreSQL on 5432 (on the build machine for this project both 5432
and 5433 were taken). The container still listens on 5432 internally; only the host mapping changed.

## Roadmap changes

None so far. Any change to [PROJECT_PLAN.md](PROJECT_PLAN.md) phases will be recorded here.
