# monitoring

**Status: complete for Docker Compose (Phase 8) and Kubernetes (Phase 5).** Prometheus scrapes the services'
existing `/metrics` endpoints, Grafana shows provisioned dashboards, and Alertmanager routes the alerts to a
webhook. The same configuration files also feed the Kubernetes deployment in
[kubernetes/monitoring](../kubernetes/monitoring), which adds kube-state-metrics, node-exporter, Kubernetes
alerts and a "Kubernetes platform" dashboard (section 7). Decisions: D-011, D-030 and D-031 in
[docs/DECISIONS.md](../docs/DECISIONS.md).

```text
 application stack (docker-compose.yml)            observability stack (monitoring/docker-compose.yml, project dpp-monitoring)
 network devops-production-platform-backend        network dpp-monitoring

 ┌─────────────┐ ┌─────────────────┐ ┌───────────────┐   scrape /metrics    ┌────────────┐  alerts  ┌──────────────┐ url_file ┌─────────┐
 │ api-gateway │ │ product-service │ │ order-service │ ◄──── every 15s ───── │ Prometheus │ ───────► │ Alertmanager │ ───────► │ webhook │
 │    :7000    │ │      :7001      │ │     :7002     │                       │   :9090    │          │    :9093     │          └─────────┘
 └─────────────┘ └─────────────────┘ └───────────────┘                       └─────▲──────┘          └──────────────┘
                                                                                   │ PromQL
                                                                             ┌─────┴──────┐
                                                                             │  Grafana   │ ◄── browser, 127.0.0.1:3000
                                                                             │   :3000    │
                                                                             └────────────┘
```

Only Prometheus joins the application network. All three UIs are published on `127.0.0.1` only.

## Contents

| Path | Purpose |
| --- | --- |
| `docker-compose.yml` | Prometheus, Alertmanager, Grafana: digest-pinned images, health checks, limits, named volumes |
| `.env.example` | Grafana admin account, webhook URL file, ports, Prometheus retention (copy to `.env`) |
| `prometheus/prometheus.yml` | Scrape jobs and the Alertmanager address |
| `prometheus/rules/platform-alerts.yml` | 6 alert rules |
| `prometheus/tests/platform-alerts.test.yml` | `promtool` unit tests for the alert rules |
| `alertmanager/alertmanager.yml` | Routing, grouping, webhook receiver, inhibit rule |
| `alertmanager/webhook-url.empty` | Default (empty) webhook URL: no notification channel configured |
| `grafana/provisioning/` | Prometheus data source and dashboard provider (provisioned, read-only) |
| `grafana/dashboards/platform-overview.json` | The "Platform overview" dashboard |
| `kustomization.yaml` | Kubernetes only: turns the files below and the shared ones above into ConfigMaps |
| `prometheus/prometheus-kubernetes.yml` | Kubernetes only: scrape jobs using Kubernetes service discovery |
| `prometheus/rules-kubernetes/kubernetes-alerts.yml` | Kubernetes only: 8 alert rules |
| `prometheus/tests/kubernetes-alerts.test.yml` | `promtool` unit tests for the Kubernetes rules |
| `grafana/dashboards-kubernetes/kubernetes-platform.json` | Kubernetes only: the "Kubernetes platform" dashboard |

The Kubernetes-only files sit in their own directories so the Compose stack, which mounts `prometheus/rules/`
and `grafana/dashboards/`, does not load rules and panels for metrics it does not have.

## Services and ports

| Service | Image | Host address | Health check | Data volume | Limits |
| --- | --- | --- | --- | --- | --- |
| `prometheus` | `prom/prometheus:v3.15.0` | `127.0.0.1:9090` | `GET /-/ready` | `dpp-monitoring-prometheus-data` | 1 CPU / 1 GiB |
| `alertmanager` | `prom/alertmanager:v0.34.1` | `127.0.0.1:9093` | `GET /-/ready` | `dpp-monitoring-alertmanager-data` (silences, notification log) | 0.25 CPU / 128 MiB |
| `grafana` | `grafana/grafana:13.2.4` | `127.0.0.1:3000` | `GET /api/health` (database check) | `dpp-monitoring-grafana-data` | 1 CPU / 512 MiB |

The ports can be changed in `monitoring/.env`. Every container is read-only with a `/tmp` tmpfs, has all
capabilities dropped and `no-new-privileges`, runs as the image's non-root user, and uses rotated JSON logs
(3 × 10 MB). Prometheus keeps 15 days or 2 GB of data, whichever limit is reached first
(`PROMETHEUS_RETENTION_TIME`, `PROMETHEUS_RETENTION_SIZE`). Startup order: Alertmanager, then Prometheus,
then Grafana, each waiting for the previous one to be healthy.

## 1. Start

The application stack must be running first: it creates the network that Prometheus joins.

```powershell
docker compose up -d --build --wait                       # application stack (repository root)
Copy-Item monitoring/.env.example monitoring/.env         # once; then set GRAFANA_ADMIN_PASSWORD
docker compose -f monitoring/docker-compose.yml up -d --wait
docker compose -f monitoring/docker-compose.yml ps
```

`GRAFANA_ADMIN_PASSWORD` is required; Compose refuses to start without it. `monitoring/.env` is git-ignored.

```powershell
docker compose -f monitoring/docker-compose.yml stop      # stop, keep containers and data
docker compose -f monitoring/docker-compose.yml down      # remove containers, keep the volumes (metrics, dashboards state)
```

Stopping or removing the observability stack does not affect the application containers. `down -v` would delete
the stored metrics, silences and Grafana state.

## 2. Grafana

Open <http://localhost:3000> and sign in with `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` from
`monitoring/.env`. Sign-up and anonymous access are disabled. The dashboard is under
**Dashboards → devops-production-platform → Platform overview** (`/d/dpp-platform-overview`).

The data source and dashboard are provisioned from files and cannot be edited or deleted in the UI. To change
the dashboard, edit `grafana/dashboards/platform-overview.json` (or export a modified copy from the UI with
**Save as** under a new name) and Grafana reloads it within about 30 seconds.

The admin password from `.env` is only applied when Grafana's database is created (first start). To change it
afterwards, without deleting the volume:

```powershell
docker compose -f monitoring/docker-compose.yml exec grafana grafana cli admin reset-admin-password '<new-password>'
```

Then update `monitoring/.env` to match (and clear the command from your shell history).

### Dashboard "Platform overview"

A `service` drop-down filters every panel. Probe endpoints (`/health`, `/ready`, `/metrics`) are excluded from
the traffic panels, so health checks and scrapes do not dilute error rates or latency.

| Area | Panels |
| --- | --- |
| Overview | Service availability (`up`), requests per second, 5xx error rate, p95 latency, firing alerts |
| Traffic (RED) | Requests per second by service, 5xx error rate by service, latency p50/p95/p99, responses by status code, 4xx per second, 5xx per second, request volume in the selected range |
| Dependencies | Gateway upstream calls by upstream and outcome (`success`, `timeout`, `unavailable`, `invalid_response`, `rejected`) |
| Resources | CPU as a share of the 0.50 CPU limit, memory (RSS and V8 heap) against the 256 MiB limit, event loop lag p99 |
| Alerts | Table of firing alerts |

## 3. Prometheus and metrics

<http://localhost:9090/targets> lists the scrape targets; all six should be **UP**:

| Job | Targets | Network |
| --- | --- | --- |
| `platform-services` | `api-gateway:7000`, `product-service:7001`, `order-service:7002` | application network |
| `prometheus` | `prometheus:9090` | dpp-monitoring |
| `alertmanager` | `alertmanager:9093` | dpp-monitoring |
| `grafana` | `grafana:3000` | dpp-monitoring |

Targets use Compose service names, never `localhost`. Scrape interval 15 s, timeout 5 s. Every series carries a
`service` label: the services set it themselves (prom-client default label, kept by `honor_labels`), and the
other jobs get it from the target configuration.

The application metrics are the ones the services have exposed since Phase 1 (README.md, section 7): no metric
was added for this phase. The dashboard and alerts use:

| Metric | Source | Used for |
| --- | --- | --- |
| `up` | Prometheus | Availability, ServiceDown, PrometheusTargetDown |
| `http_requests_total{method,route,status_code}` | all services | Request rate, error rate, status codes |
| `http_request_duration_seconds_bucket` | all services | Latency percentiles, HighLatency |
| `gateway_upstream_requests_total{upstream,outcome}` | api-gateway | Upstream health |
| `process_cpu_seconds_total`, `process_resident_memory_bytes`, `nodejs_heap_size_used_bytes`, `nodejs_eventloop_lag_p99_seconds` | all services (prom-client defaults) | Resources, HighCPU, HighMemory |
| `ALERTS` | Prometheus | Firing alert panels |

Useful queries (Prometheus **Graph** page or Grafana **Explore**):

```promql
up{job="platform-services"}
sum by (service) (rate(http_requests_total{route!~"/health|/ready|/metrics"}[5m]))
sum by (service, status_code) (rate(http_requests_total{route!~"/health|/ready|/metrics"}[5m]))
histogram_quantile(0.95, sum by (service, le) (rate(http_request_duration_seconds_bucket{route!~"/health|/ready|/metrics"}[5m])))
sum by (upstream, outcome) (rate(gateway_upstream_requests_total[5m]))
```

After editing `prometheus.yml` or a rule file, reload without a restart:

```powershell
docker compose -f monitoring/docker-compose.yml kill -s SIGHUP prometheus
docker compose -f monitoring/docker-compose.yml logs --since 1m prometheus    # "Completed loading of configuration file"
```

**Not monitored yet:** PostgreSQL internals (would need `postgres_exporter` and a dedicated monitoring role; the
services' `/ready` checks and `ServiceDown` cover database reachability) and container-level metrics from the
Docker engine (cAdvisor needs the host Docker socket and host filesystem mounts, see D-030). CPU and memory come
from each Node.js process, which is the only process in its container.

## 4. Alerts and runbooks

Rules: `prometheus/rules/platform-alerts.yml`. Firing alerts appear on <http://localhost:9090/alerts>, in
Alertmanager at <http://localhost:9093> and on the dashboard.

| Alert | Condition | For | Severity |
| --- | --- | --- | --- |
| ServiceDown | An application service cannot be scraped | 1 min | critical |
| PrometheusTargetDown | Any scrape target cannot be scraped | 3 min | warning |
| HighErrorRate | More than 5 % of a service's requests return 5xx (5-minute window, at least 0.05 requests/s) | 2 min | critical |
| HighLatency | p95 response time of a service above 1 s (5-minute window) | 10 min | warning |
| HighCPU | A service uses more than 0.4 CPU (80 % of its 0.50 limit) | 10 min | warning |
| HighMemory | A service's resident memory is above 85 % of its 256 MiB limit | 10 min | warning |

Thresholds come from the Compose resource limits (`x-node-service` in `docker-compose.yml`); change both together.

### ServiceDown

Prometheus cannot reach `<service>:<port>/metrics` on the application network.

1. `docker compose ps`: is the container running and healthy? `docker compose logs --tail=100 <service>`.
2. A stopped or crashed container: `docker compose up -d --wait <service>`. Configuration errors are logged at
   startup with the invalid variable names.
3. Container healthy but still down: check that it is on the `devops-production-platform-backend` network
   (`docker network inspect devops-production-platform-backend`) and that `/metrics` answers
   (`curl.exe http://localhost:7001/metrics`).

Expect HighErrorRate on `api-gateway` as a consequence: it returns 503/504 for routes that need the missing service.

### PrometheusTargetDown

Any target, including Prometheus, Alertmanager and Grafana. For the application services Alertmanager suppresses
it while ServiceDown fires for the same instance, so on its own it usually concerns the monitoring stack:
`docker compose -f monitoring/docker-compose.yml ps` and `logs <service>`. While a target is down its metrics and
alerts are missing, so the dashboard shows gaps.

### HighErrorRate

1. The dashboard's "Responses by status code" and "Gateway upstream calls" panels show which status codes and
   which upstream are involved.
2. On `api-gateway`, `unavailable` or `timeout` outcomes mean an upstream service is down or slow: check its
   ServiceDown/HighLatency alerts and `/ready`.
3. Otherwise read the service's error logs: `docker compose logs <service> | Select-String '"level":"error"'`. Every
   error response carries a `requestId` that appears in the logs of every service it touched.

### HighLatency

1. Is one route slow, or all of them? Query `histogram_quantile(0.95, sum by (route, le) (rate(http_request_duration_seconds_bucket{service="<service>"}[5m])))`.
2. Gateway latency follows its upstreams; a stopped upstream causes `UPSTREAM_TIMEOUT_MS` waits.
3. Check HighCPU on the same service (throttling) and database health (`/ready` on product-service and order-service).

### HighCPU

The container is throttled at 0.50 CPU, so latency rises. Look for a traffic increase on the dashboard and for
event loop lag. If the load is legitimate, raise the limit in `x-node-service` (and the alert threshold) or scale
the service (Kubernetes, Phase 5).

### HighMemory

At 256 MiB the kernel OOM-kills the container and Compose restarts it (`docker inspect --format '{{.RestartCount}}'
<container>`). A steadily growing V8 heap on the memory panel suggests a leak; a jump with traffic suggests large
responses. Raise the limit in `x-node-service` (and the alert threshold) only after understanding the cause.

## 5. Notifications (Alertmanager)

Alerts are grouped by `alertname` and `service`: one notification per group. Critical alerts are sent after
10 s and repeated hourly while firing; warnings after 30 s and every 4 hours. Resolved notifications are sent
too. The inhibit rule suppresses PrometheusTargetDown while ServiceDown fires for the same instance; three more
rules apply to the Kubernetes alerts (section 7) and never match in Compose.

The receiver is a generic webhook (Alertmanager's JSON format), so any chat integration or incident tool that
accepts it works. The URL often embeds a token, so it never goes into a tracked file. It is a Compose secret read
from a file:

```powershell
New-Item -ItemType Directory -Force monitoring/secrets                 # git-ignored
Set-Content monitoring/secrets/alertmanager-webhook-url 'https://...'  # only the URL
# in monitoring/.env:  ALERTMANAGER_WEBHOOK_URL_FILE=./secrets/alertmanager-webhook-url
docker compose -f monitoring/docker-compose.yml up -d --wait --force-recreate alertmanager
docker compose -f monitoring/docker-compose.yml exec alertmanager wc -c /run/secrets/alertmanager_webhook_url   # non-zero
```

Create the file before starting Alertmanager. Without `ALERTMANAGER_WEBHOOK_URL_FILE` the tracked empty file
`alertmanager/webhook-url.empty` is used: alerts are still evaluated and visible in Prometheus, Alertmanager and
Grafana, but sent nowhere. Email or Slack receivers can be added in `alertmanager/alertmanager.yml` the same way
(`*_file` settings for credentials); validate with the `amtool check-config` command in that file's header.

Silence an alert during maintenance at <http://localhost:9093> (**New Silence**, matcher e.g. `service="order-service"`).

## 6. Testing the alerts

**Unit tests** (no running stack needed): fire and non-fire cases for every rule, including the probe-route
exclusion and the minimum-traffic condition.

```powershell
docker run --rm -v "${PWD}/monitoring/prometheus:/p:ro" -w /p --entrypoint promtool prom/prometheus:v3.15.0 test rules tests/platform-alerts.test.yml
docker run --rm -v "${PWD}/monitoring/prometheus:/p:ro" -w /p --entrypoint promtool prom/prometheus:v3.15.0 check rules rules/platform-alerts.yml
docker run --rm -v "${PWD}/monitoring/prometheus:/p:ro" -w /p --entrypoint promtool prom/prometheus:v3.15.0 check config prometheus.yml
```

**Controlled failure** against the real stack (ServiceDown and HighErrorRate):

```powershell
docker compose stop product-service
# generate traffic through the gateway for about 4 minutes, e.g.:
1..300 | % { curl.exe -s -o NUL http://localhost:7000/api/products; Start-Sleep -Milliseconds 500 }
# watch http://localhost:9090/alerts (pending -> firing) and http://localhost:9093
docker compose start product-service
# alerts resolve within about 1 minute (ServiceDown) and 3-5 minutes (HighErrorRate, 5-minute window)
```

To see the notifications, point `ALERTMANAGER_WEBHOOK_URL_FILE` at any webhook receiver you control.

## 7. Kubernetes

Deployment, port-forwards and credentials: [kubernetes/README.md](../kubernetes/README.md). Prometheus, Alertmanager
and Grafana run in the `monitoring` namespace with the same images, `alertmanager.yml`, platform rules, data
source and "Platform overview" dashboard as in Compose. What differs:

| | Compose | Kubernetes |
| --- | --- | --- |
| Scrape configuration | `prometheus/prometheus.yml` (Compose DNS names) | `prometheus/prometheus-kubernetes.yml` (Kubernetes service discovery) |
| Application targets | 3 containers | every Running pod in `devops-platform` annotated `prometheus.io/scrape: "true"` (2 per service) |
| Extra targets | none | `kube-state-metrics` (object state), `node-exporter` (node CPU, memory, load) |
| Rules | 6 platform rules | 6 platform rules + 8 Kubernetes rules |
| Dashboards | Platform overview | Platform overview + Kubernetes platform |
| UI addresses | `localhost:9090`, `:9093`, `:3000` | port-forwards `localhost:19090`, `:19093`, `:13000` |

The scrape jobs keep the Compose names (`platform-services`, `prometheus`, `alertmanager`, `grafana`) and the
`service` label, so the platform rules and the Platform overview dashboard work unchanged; with two replicas per
service, their panels and ServiceDown are per pod (`instance` is the pod address, the `pod` label names it).
Prometheus discovers pods and EndpointSlices through namespaced Roles in `devops-platform` and `monitoring` only;
it has no cluster-wide permission. No address is hard-coded except the in-namespace Service names of Prometheus,
Alertmanager and Grafana.

### Kubernetes metrics

| Metric | Source | Used for |
| --- | --- | --- |
| `kube_pod_status_ready`, `kube_pod_status_phase`, `kube_pod_labels` | kube-state-metrics | KubernetesPodNotReady, pod readiness panels |
| `kube_pod_container_status_restarts_total` | kube-state-metrics | PodRestartingFrequently, restart panels |
| `kube_pod_container_status_waiting_reason` | kube-state-metrics | PodCrashLooping, KubernetesContainerWaiting |
| `kube_deployment_spec_replicas`, `kube_deployment_status_replicas_available` | kube-state-metrics | DeploymentReplicas*, desired vs available panel |
| `kube_node_status_condition` | kube-state-metrics | KubernetesNodeNotReady, nodes ready panel |
| `node_cpu_seconds_total`, `node_memory_MemAvailable_bytes`, `node_load1` | node-exporter | Node CPU and memory panels |

kube-state-metrics is limited to the resources it needs (no Secrets, ConfigMaps or RBAC objects). node-exporter
reads the node's `/proc` and `/sys` read-only; its filesystem and network collectors are disabled because they
would need the host root filesystem or host network (see `kubernetes/monitoring/node-exporter.yaml`).
Container CPU and memory per pod (cAdvisor, metrics-server) are not collected; the application's own process
metrics cover the Node.js containers, as in Compose.

### Dashboard "Kubernetes platform"

**Dashboards → devops-production-platform → Kubernetes platform** (`/d/dpp-kubernetes-platform`), with a
`namespace` drop-down: nodes ready, running and not-ready pods, restarts, unavailable replicas, firing alerts,
node CPU and memory, desired vs available replicas per deployment, restarts per pod, a pod readiness table, and
the application's request rate, 5xx rate and p95 latency per service.

### Kubernetes alerts

Rules: `prometheus/rules-kubernetes/kubernetes-alerts.yml`. Container-level alerts copy the container name into
`service`, deployment alerts the deployment name, so they are grouped with the service's platform alerts.

| Alert | Condition | For | Severity |
| --- | --- | --- | --- |
| PodCrashLooping | A container was in `CrashLoopBackOff` during the last 5 minutes | 5 min | warning |
| PodRestartingFrequently | A container restarted more than 3 times in 15 minutes | 1 min | warning |
| DeploymentReplicasUnavailable | A deployment with desired replicas has 0 available | 1 min | critical |
| DeploymentReplicasMismatch | Desired and available replicas differ | 10 min | warning |
| KubernetesPodNotReady | A Pending/Running/Unknown pod is not Ready | 5 min | warning |
| KubernetesContainerWaiting | A container waits to start for a reason other than `CrashLoopBackOff` | 10 min | warning |
| KubernetesNodeNotReady | A node does not report Ready | 5 min | critical |
| KubernetesTargetDown | kube-state-metrics or node-exporter cannot be scraped, or has no pod to scrape | 3 min | warning |

Alertmanager inhibits PodRestartingFrequently while PodCrashLooping fires for the same container,
DeploymentReplicasMismatch while DeploymentReplicasUnavailable fires for the same deployment, and
PrometheusTargetDown while KubernetesTargetDown fires for the same instance.

The commands below use `kubectl`; with Minikube use `minikube -p dpp kubectl --` (kubernetes/README.md).

### PodCrashLooping

The container keeps exiting, or keeps failing its liveness probe, and Kubernetes backs off between restarts.

1. `kubectl -n <namespace> describe pod <pod>`: **Last State** shows the exit code and reason (`Error`,
   `OOMKilled`); **Events** show `Liveness probe failed`.
2. `kubectl -n <namespace> logs <pod> -c <container> --previous`: the services log invalid configuration at
   startup with the variable names.
3. A bad rollout: `kubectl -n <namespace> rollout undo deployment/<deployment>`. `OOMKilled`: see HighMemory.

### PodRestartingFrequently

Restarts that recover quickly (OOM kills, liveness failures under load) never show `CrashLoopBackOff`. Same
diagnosis as PodCrashLooping: `describe pod` for the last termination reason and `logs --previous`. Liveness
failures under load point to CPU throttling (HighCPU) or a blocked event loop (event loop lag panel). The rule
counts restarts over 15 minutes, so after a fix (or for a pod that was deleted) it stays active for up to 15
minutes before resolving.

### DeploymentReplicasUnavailable

The deployment's Service has no ready endpoint, so every request to it fails. Expect ServiceDown or
KubernetesPodNotReady for the same service, and HighErrorRate on `api-gateway`.

1. `kubectl -n devops-platform get pods -l app.kubernetes.io/name=<deployment>`: pods missing, not Ready,
   waiting or crash looping (see the matching alert).
2. Pods Running but not Ready: product-service and order-service report not ready while PostgreSQL is
   unreachable (`kubectl -n devops-platform get pod postgres-0`, `logs postgres-0`). The readiness response
   says which check failed:
   `kubectl -n devops-platform exec deploy/<deployment> -- node -e "fetch('http://127.0.0.1:<port>/ready').then(r=>r.text()).then(console.log)"`.
3. Pods missing: `kubectl -n devops-platform describe deployment <deployment>` and
   `get events --sort-by=.lastTimestamp` (quota, scheduling, image pull).

### DeploymentReplicasMismatch

Some, but not all, replicas have been unavailable for 10 minutes: a stuck rolling update (`kubectl -n <namespace>
rollout status deployment/<deployment>`), a pod that cannot be scheduled (`describe pod`, insufficient CPU or
memory on the node), or one crash-looping replica. `kubectl rollout undo` reverts a stuck rollout.

### KubernetesPodNotReady

The pod is excluded from its Service. `kubectl -n <namespace> describe pod <pod>`: `Readiness probe failed` events
(dependency down, see DeploymentReplicasUnavailable step 2), `Pending` with `FailedScheduling` (not enough
resources, PVC not bound), or a waiting container (KubernetesContainerWaiting).

### KubernetesContainerWaiting

`kubectl -n <namespace> describe pod <pod>`, by reason:

| Reason | Usual cause |
| --- | --- |
| `ImagePullBackOff`, `ErrImagePull` | Wrong tag, or the private GHCR image cannot be pulled: check the `ghcr-pull` Secret or load the image into the cluster (kubernetes/README.md) |
| `CreateContainerConfigError` | A referenced Secret, ConfigMap or key is missing (e.g. `postgres-credentials`, `grafana-admin`) |
| `ContainerCreating` | A volume cannot be mounted (PVC not bound: `kubectl -n <namespace> get pvc`) |

### KubernetesNodeNotReady

The kubelet stopped reporting: node out of memory or disk, container runtime down, or the node (Minikube VM or
container) stopped. `kubectl describe node <node>` (**Conditions**, **Events**); with Minikube,
`minikube -p dpp status` and `minikube -p dpp start`. Pods on the node stop receiving traffic and are evicted after
about 5 minutes. On a single-node cluster everything else is down too, including Prometheus, so this alert can
only be delivered if the node recovers or Prometheus runs elsewhere.

### KubernetesTargetDown

While kube-state-metrics is down every Kubernetes alert is blind; while node-exporter is down the node panels are
empty. Both are discovered from their pods, so the alert also fires when the pod is missing ("has no scrape
target": Deployment scaled to 0, DaemonSet pod not scheduled). `kubectl -n monitoring get pods -l
app.kubernetes.io/name=<job>`, `get deploy,daemonset`, `logs`, and `describe pod`. Pods running but not scraped:
check the `monitoring` NetworkPolicies and, at <http://localhost:19090/targets>, the scrape error.

### Testing the Kubernetes alerts

```powershell
docker run --rm -v "${PWD}/monitoring/prometheus:/p:ro" -w /p --entrypoint promtool prom/prometheus:v3.15.0 test rules tests/kubernetes-alerts.test.yml
docker run --rm -v "${PWD}/monitoring/prometheus:/p:ro" -w /p --entrypoint promtool prom/prometheus:v3.15.0 check rules rules-kubernetes/kubernetes-alerts.yml
```

Controlled failures against the cluster are described in kubernetes/README.md.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `GRAFANA_ADMIN_PASSWORD must be set in monitoring/.env` | Create `monitoring/.env` from `.env.example` |
| `network devops-production-platform-backend ... not found` | Start the application stack first |
| `platform-services` targets DOWN, `no such host` | The application containers are stopped, or were started from another Compose project name |
| Grafana login fails after changing `.env` | The password only applies on first start; see section 2 |
| Alerts fire but no notification arrives | `wc -c` on the secret (section 5) and `docker compose -f monitoring/docker-compose.yml logs alertmanager` |
| `ports are not available` (3000, 9090, 9093) | Change the `*_HOST_PORT` values in `monitoring/.env` |
