# kubernetes

**Status: complete (Phase 5), validated on Minikube** (results in
[docs/PROJECT_PLAN.md](../docs/PROJECT_PLAN.md), Phase 5). Plain manifests assembled with Kustomize (built into
`kubectl`, no Helm): the three services and PostgreSQL in namespace `devops-platform`, Prometheus, Alertmanager,
Grafana, kube-state-metrics and node-exporter in namespace `monitoring`. Images are the ones Jenkins publishes to
GHCR; nothing is built in the cluster. The Docker Compose stacks are unchanged and remain the quickest way to run
the platform locally. Decision: D-031 in [docs/DECISIONS.md](../docs/DECISIONS.md).

```text
 namespace devops-platform (Pod Security: restricted)                    namespace monitoring
                                                                         (Pod Security: privileged, warn restricted)
  port-forward 17000                                                     port-forward 19090 / 13000 / 19093
        │                                                                ┌────────────┐   ┌──────────────┐
  ┌─────▼──────┐  http  ┌─────────────────┐                              │ Prometheus │──►│ Alertmanager │──► webhook
  │ api-gateway├───────►│ product-service │◄──┐                          │  (PVC 5Gi) │   │  (PVC 256Mi) │
  │  2 pods    │        │     2 pods      │   │ http                     └──▲───▲───▲─┘   └──────────────┘
  └─────┬──────┘        └────────┬────────┘   │                             │   │   │     ┌──────────────┐
        │ http          ┌────────┴────────┐   │                             │   │   └─────│   Grafana    │
        └──────────────►│  order-service  ├───┘                             │   │         │  (PVC 1Gi)   │
                        │     2 pods      │                                 │   │         └──────────────┘
                        └────────┬────────┘                                 │   │ kube-state-metrics (API objects)
                          ┌──────▼──────┐  products_db, orders_db           │   └ node-exporter (DaemonSet, /proc /sys)
                          │ postgres-0  │  StatefulSet, PVC 2Gi             │
                          └─────────────┘                                   │ scrape /metrics of every annotated pod
                  ◄─────────────────────────────────────────────────────────┘ (Kubernetes service discovery)
```

Services reach each other by Service name through cluster DNS (`http://product-service:7001`, `postgres:5432`),
never `localhost` or pod IPs. No Service is exposed outside the cluster (all `ClusterIP`); access is through
`kubectl port-forward`.

## Contents

| Path | Purpose |
| --- | --- |
| `app/kustomization.yaml` | Namespace `devops-platform`: image tags, service configuration (ConfigMaps), database Secret |
| `app/namespace.yaml` | Namespace with Pod Security Admission `restricted` (enforced) |
| `app/postgres.yaml` | PostgreSQL 17 StatefulSet, headless Service, volume claim template |
| `app/product-service.yaml`, `app/order-service.yaml`, `app/api-gateway.yaml` | Service, Deployment (2 replicas), PodDisruptionBudget |
| `app/network-policies.yaml` | Default deny ingress plus the allowed paths |
| `app/monitoring-access.yaml` | Role that lets Prometheus list pods in this namespace (service discovery) |
| `app/.env.example` | Database passwords (copy to `app/.env`, git-ignored) |
| `monitoring/kustomization.yaml` | Namespace `monitoring`: configuration from [../monitoring](../monitoring), Grafana Secret |
| `monitoring/prometheus.yaml`, `alertmanager.yaml`, `grafana.yaml` | Deployments, Services, PVCs, Prometheus ServiceAccount and Role |
| `monitoring/kube-state-metrics.yaml` | kube-state-metrics with a read-only ClusterRole limited to the resources it reports |
| `monitoring/node-exporter.yaml` | node-exporter DaemonSet (host `/proc` and `/sys`, read-only) |
| `monitoring/network-policies.yaml` | Default deny ingress plus the allowed paths |
| `monitoring/.env.example` | Grafana admin account (copy to `monitoring/.env`, git-ignored) |
| `../infra/postgres/kustomization.yaml` | The first-boot SQL script shared with Docker Compose, as a ConfigMap |
| `../monitoring/kustomization.yaml` | Prometheus, Alertmanager and Grafana configuration shared with Docker Compose, as ConfigMaps |

Nothing is copied: the PostgreSQL init script, `alertmanager.yml`, the platform alert rules, the Grafana data
source and the Platform overview dashboard are the same files the Compose stacks use. Kubernetes-only
monitoring files live under `monitoring/prometheus/prometheus-kubernetes.yml`, `rules-kubernetes/` and
`grafana/dashboards-kubernetes/` (monitoring/README.md, section 7).

## Workloads

| Workload | Kind | Replicas | Requests / limits | Probes | Storage |
| --- | --- | --- | --- | --- | --- |
| api-gateway | Deployment | 2 | 100m / 128Mi, 500m / 256Mi | startup + liveness `/health`, readiness `/health` | none |
| product-service | Deployment | 2 | 100m / 128Mi, 500m / 256Mi | startup + liveness `/health`, readiness `/ready` (database) | none |
| order-service | Deployment | 2 | 100m / 128Mi, 500m / 256Mi | startup + liveness `/health`, readiness `/ready` (database) | none |
| postgres | StatefulSet | 1 | 250m / 256Mi, 1 / 512Mi | startup, readiness, liveness `pg_isready` | PVC `data-postgres-0`, 2Gi |
| prometheus | Deployment (Recreate) | 1 | 200m / 384Mi, 1 / 1Gi | `/-/ready`, `/-/healthy` | PVC `prometheus-data`, 5Gi (15 days or 4 GB) |
| alertmanager | Deployment (Recreate) | 1 | 25m / 32Mi, 250m / 128Mi | `/-/ready`, `/-/healthy` | PVC `alertmanager-data`, 256Mi |
| grafana | Deployment (Recreate) | 1 | 100m / 192Mi, 1 / 512Mi | `/api/health` | PVC `grafana-data`, 1Gi |
| kube-state-metrics | Deployment | 1 | 20m / 64Mi, 200m / 192Mi | `/livez`, `/readyz` | none |
| node-exporter | DaemonSet | 1 per node | 20m / 32Mi, 200m / 96Mi | `/` | none |

The service limits match Docker Compose (`x-node-service`), so the HighCPU and HighMemory thresholds stay valid.
Rolling updates of the services use `maxUnavailable: 0`, `maxSurge: 1` and `minReadySeconds: 45`: a new pod must
stay Ready for 45 seconds before an old one stops. That is longer than the liveness probe needs to kill a broken
pod (3 failures 10 seconds apart), so a version that passes readiness but fails liveness stalls the rollout
instead of replacing every healthy pod (found by the restart test, section 6). A `preStop` pause of 5 seconds
lets the endpoints update before the process receives SIGTERM.
Each service has a PodDisruptionBudget of `maxUnavailable: 1` for node drains. The workloads with a
ReadWriteOnce volume use `Recreate` (or a StatefulSet) because two pods cannot mount it at once.

Configuration is the services' existing environment variables (README.md, section 5), in ConfigMaps generated by
`app/kustomization.yaml`. Generated ConfigMap and Secret names carry a content hash, so a change rolls the pods
that use it.

## Security

- **Pods**: non-root (`runAsNonRoot`, explicit UID), `allowPrivilegeEscalation: false`, all capabilities dropped,
  read-only root filesystem (writable `emptyDir` only where needed, e.g. `/tmp`), `seccompProfile: RuntimeDefault`.
  `devops-platform` enforces the Pod Security `restricted` profile, so a pod violating it is rejected.
- **Service account tokens** are not mounted, except in Prometheus and kube-state-metrics, which call the API.
- **RBAC**: Prometheus has namespaced Roles in `devops-platform` (pods) and `monitoring` (pods, services,
  EndpointSlices), no cluster-wide permission. kube-state-metrics has a read-only ClusterRole limited to the
  resources it reports; it cannot read Secrets, ConfigMaps or RBAC objects.
- **NetworkPolicies** (enforced by Calico; Minikube's default CNI ignores them): both namespaces deny all
  ingress by default, then allow only these paths:

  | Destination | Allowed sources |
  | --- | --- |
  | api-gateway :7000 | any (port-forward, future Ingress) |
  | product-service :7001 | api-gateway, order-service, Prometheus |
  | order-service :7002 | api-gateway, Prometheus |
  | postgres :5432 | product-service, order-service |
  | Prometheus :9090 | Grafana, Prometheus |
  | Alertmanager :9093 | Prometheus |
  | Grafana :3000, kube-state-metrics :8080, node-exporter :9100 | Prometheus |

  `kubectl port-forward` goes through the kubelet and is not affected. Egress is not restricted.
- **node-exporter** is the only exception to the restricted profile: it mounts the node's `/proc` and `/sys`
  (read-only, type `Directory`) to report node CPU and memory. It runs non-root, without capabilities, host
  network or host PID, with a read-only root filesystem; the filesystem and network collectors that would need
  more are disabled. For this reason the `monitoring` namespace enforces `privileged` and only warns on
  `restricted`. Trivy finding KSV-0121 is accepted for this one file in `.trivyignore.yaml`, with an expiry date.
- **Secrets** come from git-ignored `.env` files through Kustomize `secretGenerator`; no credential is in a tracked
  file. Images are pinned: application images by commit tag, third-party images by digest.

## 1. Prerequisites

- Docker Desktop, [Minikube](https://minikube.sigs.k8s.io/) 1.39 or later. `minikube kubectl` downloads a
  `kubectl` matching the cluster version; a separately installed `kubectl` must be within one minor version of it.
- About 4 CPUs and 4 GiB of memory free for the cluster.
- Read access to the private GHCR packages (section 3).

## 2. Start the cluster

```powershell
minikube start -p dpp --driver=docker --kubernetes-version=v1.36.4 --cni=calico --cpus=4 --memory=4096 --disk-size=20g
function k { minikube -p dpp kubectl -- @args }    # shorthand used below
k get nodes
```

`--cni=calico` is required for the NetworkPolicies to be enforced. The profile name `dpp` keeps the cluster
separate from any other Minikube cluster. Minikube's default `standard` StorageClass provisions the volumes.
PowerShell removes a bare `--` from a function's arguments, so write `k exec <pod> '--' <command>`.

After a reboot or a Docker Desktop restart, start Docker Desktop, then `minikube start -p dpp`: the cluster,
its Secrets and its volumes are kept, and the pods come back on their own.

## 3. Image access (private GHCR packages)

The application images stay private. Two ways to make them available to the cluster; neither writes a credential
to a file in the repository.

**Option A, pull secret (used by the manifests).** The Deployments reference a Secret of type
`kubernetes.io/dockerconfigjson` named `ghcr-pull` in `devops-platform`. It needs a **classic** personal access
token (`ghp_...`) with only the `read:packages` scope
([create one](https://github.com/settings/tokens/new?scopes=read:packages&description=dpp-minikube-ghcr-pull));
GHCR rejects fine-grained tokens with `403 Forbidden`. The token is typed into the Windows credential dialog and
the Secret is built in memory and passed to `kubectl` on standard input, so the token never appears in a command
line, the shell history, a file or a log:

```powershell
k create namespace devops-platform --dry-run=client -o yaml | minikube -p dpp kubectl -- apply -f -
$cred = Get-Credential -UserName <github-user> -Message 'Classic GitHub token (ghp_...) with read:packages scope'
$auth = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($cred.UserName + ':' + $cred.GetNetworkCredential().Password))
$config = '{"auths":{"ghcr.io":{"username":"' + $cred.UserName + '","auth":"' + $auth + '"}}}'
$data = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($config))
"apiVersion: v1`nkind: Secret`nmetadata:`n  name: ghcr-pull`n  namespace: devops-platform`ntype: kubernetes.io/dockerconfigjson`ndata:`n  .dockerconfigjson: $data`n" | minikube -p dpp kubectl -- create -f -
Remove-Variable cred, auth, config, data
k -n devops-platform get secret ghcr-pull      # metadata only; never print the data
```

`kubectl create` is used rather than `apply`, which would keep a second copy of the data in an annotation. The
Secret lives only in the cluster and survives `minikube stop`/`start`. To rotate the token, delete the Secret and
create it again, then `k -n devops-platform rollout restart deploy`; pods already running keep their image.

**Option B, load the images into the node.** If the Docker host is logged in to GHCR (`docker login ghcr.io` in an
interactive terminal), pull the images there and copy them into Minikube; no Secret is needed in the cluster:

```powershell
$tag = '2d89c059ed41'
foreach ($s in 'api-gateway', 'product-service', 'order-service') {
  docker pull "ghcr.io/marwanbarhoumi/devops-production-platform/${s}:$tag"
  minikube -p dpp image load "ghcr.io/marwanbarhoumi/devops-production-platform/${s}:$tag"
}
```

The containers use `imagePullPolicy: IfNotPresent`, so loaded images are used as they are; the kubelet only
logs a warning about the missing `ghcr-pull` Secret.

**Choosing the version**: `images[].newTag` in `app/kustomization.yaml` is the 12-character commit SHA of a build
Jenkins validated and published (D-025), never `latest`.

## 4. Deploy

```powershell
Copy-Item kubernetes/app/.env.example kubernetes/app/.env                 # then set three random passwords
Copy-Item kubernetes/monitoring/.env.example kubernetes/monitoring/.env   # then set the Grafana password
k apply -k kubernetes/monitoring
k apply -k kubernetes/app
k -n monitoring rollout status deploy/prometheus deploy/alertmanager deploy/grafana deploy/kube-state-metrics
k -n monitoring rollout status daemonset/node-exporter
k -n devops-platform rollout status statefulset/postgres
k -n devops-platform rollout status deploy/product-service deploy/order-service deploy/api-gateway
k get pods -A
```

Use new random values in the `.env` files; never copy `monitoring/.env` or the root `.env` of Docker Compose.
PostgreSQL applies the passwords only when its volume is first initialised, like in Compose; to change them
later, use `ALTER ROLE` in the database, then update `.env` and re-apply.

To check the manifests without changing anything:

```powershell
k kustomize kubernetes/app        # rendered YAML
k apply -k kubernetes/app --dry-run=server
```

Re-running `k apply -k` after a change is safe; changed ConfigMaps and Secrets roll the pods that use them.

## 5. Access

| What | Command | Address |
| --- | --- | --- |
| API (gateway) | `k -n devops-platform port-forward svc/api-gateway 17000:7000` | <http://localhost:17000/api/products> |
| Prometheus | `k -n monitoring port-forward svc/prometheus 19090:9090` | <http://localhost:19090/targets> |
| Grafana | `k -n monitoring port-forward svc/grafana 13000:3000` | <http://localhost:13000> |
| Alertmanager | `k -n monitoring port-forward svc/alertmanager 19093:9093` | <http://localhost:19093> |

The local ports differ from the Compose ones (7000, 9090, 3000, 9093), so both environments can run at the same
time. Each port-forward runs in its own terminal until stopped with Ctrl+C; it is bound to one pod and exits
when that pod is replaced, so restart it after a rollout (or run it in a loop:
`while ($true) { k -n monitoring port-forward svc/prometheus 19090:9090; Start-Sleep 2 }`). Grafana's login is
`GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` from `kubernetes/monitoring/.env`.

```powershell
curl.exe -s http://localhost:17000/health
curl.exe -s http://localhost:17000/api/products
curl.exe -s -X POST http://localhost:17000/api/orders -H 'Content-Type: application/json' -d '{\"productId\":1,\"quantity\":1}'
```

The repository's end-to-end smoke test also runs against the cluster:
`$env:GATEWAY_URL = 'http://127.0.0.1:17000'; node scripts/smoke-test.mjs`.

Prometheus should list 11 targets **UP**: `platform-services` (6 pods), `kube-state-metrics`, `node-exporter`,
`prometheus`, `alertmanager`, `grafana`. Monitoring details, dashboards and runbooks:
[monitoring/README.md](../monitoring/README.md), section 7.

**Alert notifications**: Alertmanager reads the webhook URL from the optional Secret `alertmanager-webhook`. Without
it, alerts are evaluated and visible but sent nowhere. The URL usually embeds a token, so it is entered at a prompt
and passed on standard input, like the pull secret:

```powershell
$url = Read-Host -AsSecureString 'Webhook URL'
$data = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Net.NetworkCredential]::new('', $url).Password))
"apiVersion: v1`nkind: Secret`nmetadata:`n  name: alertmanager-webhook`n  namespace: monitoring`ndata:`n  alertmanager_webhook_url: $data`n" | minikube -p dpp kubectl -- create -f -
Remove-Variable url, data
k -n monitoring rollout restart deploy/alertmanager
```

## 6. Controlled failure tests

Each test is reversible and keeps the volumes. Watch <http://localhost:19090/alerts>, <http://localhost:19093> and
the Kubernetes platform dashboard.

Timings below are those observed on Minikube (docs/PROJECT_PLAN.md, Phase 5).

**Pod deletion (self-healing).** Delete one pod, taking its name from `k -n devops-platform get pods`:
`k -n devops-platform delete pod <product-service-pod>`. The Deployment creates a replacement (Ready in about
20 seconds), the other replica keeps serving, and the gateway keeps answering (269 of 269 requests succeeded
during the test). Prometheus drops the old pod's target and discovers the new one. No alert fires: the pod is
replaced well within the `for` durations.

**No available replica (DeploymentReplicasUnavailable, KubernetesPodNotReady).** Stop the database, so
product-service and order-service report not ready:

```powershell
k -n devops-platform scale statefulset/postgres --replicas=0
# ~1.5 min: DeploymentReplicasUnavailable fires (critical) for product-service and order-service and reaches
# Alertmanager; the gateway answers 503 for their routes. ~5.5 min: KubernetesPodNotReady for the 4 pods.
k -n devops-platform scale statefulset/postgres --replicas=1
k -n devops-platform rollout status statefulset/postgres
# the services are Ready again within seconds, all alerts resolve within ~4 minutes; the data is kept on the PVC.
```

**Restarts (PodRestartingFrequently, PodCrashLooping).** Point one deployment's liveness probe at a path that
does not exist, then undo:

```powershell
Set-Content $env:TEMP\liveness.json '[{"op":"replace","path":"/spec/template/spec/containers/0/livenessProbe/httpGet/path","value":"/does-not-exist"}]'
k -n devops-platform patch deployment order-service --type=json --patch-file $env:TEMP\liveness.json
# the new pod is restarted every ~30 s and then backs off (CrashLoopBackOff). minReadySeconds stalls the rollout,
# so the old pods keep serving. ~3.5 min: PodRestartingFrequently fires; ~8.5 min: PodCrashLooping fires and
# Alertmanager suppresses PodRestartingFrequently for the same pod.
k -n devops-platform rollout undo deployment/order-service
k apply -k kubernetes/app      # re-sync with the manifests after the undo
```

PodRestartingFrequently counts restarts over 15 minutes, so it stays active for up to 15 minutes after the
rollback (also for the deleted pod), then resolves.

**Metric source missing (KubernetesTargetDown).** `k -n monitoring scale deploy/kube-state-metrics --replicas=0`:
after 3 minutes the alert fires with "kube-state-metrics has no scrape target"; while it lasts, the other Kubernetes
alerts are blind. Restore with `--replicas=1`.

A node failure (KubernetesNodeNotReady) is not tested on the cluster: on a single node, Prometheus would go down
with it. The rule is covered by `promtool` unit tests.

## 7. Stop and clean up

```powershell
minikube -p dpp stop       # stop the cluster, keep everything (volumes included)
minikube -p dpp start      # resume
```

`k delete -k kubernetes/app` removes the application objects but keeps the PostgreSQL volume (StatefulSet volume
claims are not deleted); deleting the namespaces or `minikube -p dpp delete` removes every volume.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `ImagePullBackOff`, `401 Unauthorized` / `unauthorized` | No credentials sent: the `ghcr-pull` Secret is missing or in another namespace (section 3) |
| `ImagePullBackOff`, `failed to fetch oauth token ... 403 Forbidden` | The token was sent but refused: use a classic token with `read:packages`, not a fine-grained one; recreate the Secret, then `k -n devops-platform rollout restart deploy` |
| Every command fails with `docker API ... dockerDesktopLinuxEngine` or `connection refused` on 127.0.0.1 | Docker Desktop is not running: start it, then `minikube start -p dpp` (section 2) |
| A rollout hangs with one pod in `CrashLoopBackOff` | The new version fails its liveness probe; `minReadySeconds` keeps the old pods serving. `k -n devops-platform rollout undo deployment/<name>` |
| A port-forward stopped answering | Its pod was replaced; restart the port-forward (section 5) |
| `CreateContainerConfigError` | A `.env` file is missing a key, or the Secret was not generated: `k -n <namespace> describe pod <pod>` |
| `error: ... .env: no such file or directory` on apply | Create `kubernetes/app/.env` / `kubernetes/monitoring/.env` from the examples |
| `violates PodSecurity "restricted"` | A manifest change removed a security setting; the namespace rejects the pod |
| product-service or order-service Running but not Ready | PostgreSQL is not ready: `k -n devops-platform logs postgres-0` |
| `platform-services` targets missing | Pods are not Running, or the `prometheus.io/scrape` annotation or the `prometheus-discovery` Role is missing |
| Targets DOWN with `context deadline exceeded` | A NetworkPolicy blocks Prometheus: `k get networkpolicy -A` |
| NetworkPolicies have no effect | The cluster was started without `--cni=calico` |
| Grafana login fails | The password applies only when Grafana's volume is first created (monitoring/README.md, section 2) |
| `kubectl` version skew warning | Use `minikube -p dpp kubectl --` |

## Limitations

- Single-node local cluster: no high availability; KubernetesNodeNotReady cannot be delivered while the only node
  is down, because Prometheus runs on it.
- One PostgreSQL instance (StatefulSet with one replica), no backups or replication; a managed database or an
  operator is the production answer.
- No Ingress, TLS or autoscaling: access is by port-forward, replicas are fixed at 2. The Horizontal Pod
  Autoscaler would need metrics-server, which is not installed.
- No per-container CPU and memory metrics (cAdvisor or metrics-server); the services' own process metrics are
  used, as in Compose.
- Secrets are plain Kubernetes Secrets (base64 in etcd); a production cluster would use encryption at rest and an
  external secret store.
- The cluster is deployed manually with `kubectl apply -k`; the Jenkins pipeline publishes the images but does not
  deploy them.
