# Security and quality (Phase 3)

The Jenkins pipeline ([../Jenkinsfile](../Jenkinsfile)) gates every build on code quality and security:

| Stage | Tool | Fails the build when |
| --- | --- | --- |
| Unit & API / Integration Tests | Vitest + v8 coverage | a test fails (coverage is recorded as LCOV for SonarQube) |
| SonarQube Analysis | SonarScanner CLI 8.1 → SonarQube Community Build 26.10 | the project's quality gate is not passed |
| Trivy Filesystem Scan | Trivy 0.75 | a fixable HIGH/CRITICAL vulnerability in `package-lock.json`, or any HIGH/CRITICAL secret or Dockerfile misconfiguration |
| Build Images | Docker (BuildKit) in the CI Docker-in-Docker daemon | an image does not build |
| Scan Images | Trivy 0.75 | a fixable HIGH/CRITICAL vulnerability or a HIGH/CRITICAL secret in an image (a CycloneDX SBOM is produced for each image) |
| Publish Images | Docker → GitHub Container Registry | a push fails (skipped on other branches than `main`, and skipped with a message when no registry credential exists) |

Images are published only after every earlier stage passed: nothing unscanned or below the quality gate
reaches the registry.

```
security/
├── README.md                 # this guide
└── sonarqube/
    ├── docker-compose.yml    # SonarQube + its own PostgreSQL (project "dpp-sonarqube")
    ├── .env.example          # database password template (.env is git-ignored)
    └── bootstrap.mjs         # start + first-time setup (admin password, project, Jenkins token)
sonar-project.properties      # analysis scope, coverage paths, quality gate wait (repository root)
.trivyignore                  # accepted Trivy findings, each with a reason and expiry (repository root)
scripts/ci/trivy-scan.mjs     # Trivy runs + the blocking policy
scripts/ci/images.mjs         # image build / scan / push / cleanup, tag strategy
jenkins/import-credential.mjs # stores a git-ignored secret file as a Jenkins credential
```

## Versions

| Component | Version | Why |
| --- | --- | --- |
| SonarQube | Community Build `26.10.0.133078` (October 2026) | Current free edition; analyzes TypeScript and imports LCOV coverage. Analyzes one branch (`main`), which matches the Jenkins job. |
| SonarQube database | PostgreSQL `17.11-alpine3.24` | Supported by SonarQube; separate container and volume from the application database. |
| SonarScanner CLI | `8.1.0.6389` (from `sonarsource/sonar-scanner-cli:12.2.0.4256_8.1.0`) | Runs on the agent's existing Java 21; no JRE download. The npm `@sonar/scan` wrapper was rejected: it pulls `node-forge` with an unfixed HIGH advisory. |
| Trivy | `0.75.0` | Current release; one tool for dependencies, OS packages, secrets, Dockerfile misconfigurations and SBOMs. |
| Coverage | `@vitest/coverage-v8` `5.0.4` | Must match the Vitest version exactly. |

All images (SonarQube stack, agent tool images, service base image) are pinned by tag **and** digest.

## SonarQube

### First-time setup

```powershell
node security/sonarqube/bootstrap.mjs
node jenkins/import-credential.mjs --id sonarqube-token --file jenkins/secrets/sonarqube-token --description "SonarQube project analysis token (devops-production-platform)"
```

`bootstrap.mjs` is safe to re-run. It:

1. creates `security/sonarqube/.env` with a random database password (git-ignored);
2. starts the stack and waits until SonarQube is `UP` (first start: about 2 minutes);
3. replaces the default `admin`/`admin` login with a random password, saved to
   `security/sonarqube/secrets/admin-password` (git-ignored) — use it to log in at http://localhost:9100;
4. creates the private project `devops-production-platform`;
5. generates a **project analysis token** (`jenkins-ci`, valid for this project only) and writes it to
   `jenkins/secrets/sonarqube-token` (git-ignored). No secret is printed.

`import-credential.mjs` stores that file as the Jenkins *Secret text* credential `sonarqube-token`. It
needs no Jenkins login: it stages the value and a one-shot init script in the controller, restarts the
controller container (no rebuild, volumes kept), and the script stores the credential encrypted and
deletes the value and itself. Credentials added in the Jenkins UI are not touched. Alternative: add the
credential in *Manage Jenkins > Credentials > System > Global* (kind *Secret text*, ID `sonarqube-token`).

Rotate the token: `node security/sonarqube/bootstrap.mjs --rotate-token`, then run the import again.

### Start, stop, upgrade

```powershell
cd security/sonarqube
docker compose up -d --wait     # start (about 1-2 minutes until healthy)
docker compose stop             # stop; all data is kept
docker compose ps               # status
docker compose logs -f sonarqube
```

- UI: http://localhost:9100 (127.0.0.1 only; 9100 because 9000 is often taken). Anonymous access is off.
- Data lives in the volumes `dpp-sonarqube_sonarqube-db`, `..._sonarqube-data`, `..._sonarqube-extensions`
  and `..._sonarqube-logs`. `docker compose down` keeps them; `down -v` deletes all analyses.
- Upgrade: back up the database volume, change tag and digest together in `docker-compose.yml`,
  `docker compose up -d --wait`, then open http://localhost:9100/setup if SonarQube asks for a migration.
- Resources: up to 3 GB RAM for SonarQube; its Elasticsearch needs `vm.max_map_count >= 262144` on the
  Docker host (Docker Desktop's WSL 2 VM already has 1048576).
- Jenkins reaches it at `http://host.docker.internal:9100` (`SONAR_HOST_URL` in the Jenkinsfile). The two
  stacks stay independent: no shared Docker network.

### Analysis and quality gate

[`sonar-project.properties`](../sonar-project.properties) defines the scope (`services/*/src`, tests in
`services/*/test`) and imports five LCOV files (unit tests of three services, integration tests of two).
`sonar.qualitygate.wait=true` makes the scanner wait for the server's verdict and fail the stage when the
gate fails, so no Jenkins SonarQube plugin or webhook back to Jenkins is needed.

The project uses SonarQube's default gate **Sonar way**: on new code, no new issues, all security hotspots
reviewed, coverage ≥ 80 % and duplication ≤ 3 %. "New code" is measured against the previous analysis, so the
first analysis sets the baseline and later commits must keep new code clean.

## Trivy

Policy (implemented in [`scripts/ci/trivy-scan.mjs`](../scripts/ci/trivy-scan.mjs)):

- **Vulnerabilities:** HIGH and CRITICAL fail the build **when a fixed version exists**. Unfixed ones are
  counted in the log and in the report but do not block, because no upgrade can remove them yet.
- **Secrets** and **misconfigurations** (Dockerfiles): HIGH and CRITICAL always fail the build.
- Only the file, line and rule of a secret are printed, never the value.
- Every scan writes the full JSON report (all severities) to `reports/trivy/`, archived by Jenkins.
- The vulnerability database is cached in the agent's persistent home (`/home/jenkins/.cache/trivy`).

Accepted risks go in [`.trivyignore`](../.trivyignore) with the reason, an owner and an `exp:` date; after
that date the finding blocks again.

Hardening done so the images pass: the runtime stage of each service Dockerfile now installs Alpine
security updates (`apk upgrade`) and removes npm, npx, corepack and yarn, which the services do not need
at runtime and which carried 13 HIGH and 1 CRITICAL advisories in npm's bundled dependencies.

Run the filesystem scan locally (Docker Desktop, no install):

```powershell
docker run --rm -v "${PWD}:/src:ro" aquasec/trivy:0.75.0 fs --scanners vuln,secret,misconfig --skip-dirs '**/node_modules' --severity HIGH,CRITICAL /src
```

## Images

Built for all three services from their existing Dockerfiles, inside the CI Docker-in-Docker daemon.

| Tag | Example | Purpose |
| --- | --- | --- |
| `<git sha, 12>` | `ghcr.io/marwanbarhoumi/devops-production-platform/api-gateway:5cb002204bb2` | exact commit; what deployments reference |
| `<version>-<git sha, 7>` | `.../api-gateway:0.1.0-5cb0022` | human-readable: service version (`package.json`) + commit |

No mutable `latest` tag. OCI labels record title, version, revision, creation time and source repository.
Each image gets a CycloneDX SBOM (`reports/sbom/<service>.cdx.json`), archived and fingerprinted by Jenkins.
The build's tags are removed from the CI daemon afterwards; base layers stay cached.

### Publishing

Target: GitHub Container Registry (`IMAGE_REGISTRY` / `IMAGE_PREFIX` in the Jenkinsfile), next to the
source repository. Only builds of `main` publish. To enable it:

1. Create a GitHub **personal access token (classic)** with only the `write:packages` scope (it implies
   `read:packages`) and an expiry date. Check GitHub's current GHCR docs before using a fine-grained token.
2. In Jenkins: *Manage Jenkins > Credentials > System > Global credentials > Add Credentials*, kind
   *Username with password*, username = your GitHub user, password = the token, ID `container-registry`.
3. Run a build of `main`. The first push creates private packages under your GitHub profile; make them
   public in the package settings if wanted, and link them to the repository.

The login uses a throwaway `DOCKER_CONFIG` directory and `--password-stdin`; it is logged out and deleted
when the step ends, so the token never reaches the agent's home or the build log. Pushed digests are
recorded in `reports/images/published.json`.

Without the credential the stage prints *"Publishing skipped: no Jenkins credential 'container-registry'"*,
adds "(images not published)" to the build description and the build stays green: the images were built
and passed every check.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| SonarQube stage: `Connection refused` / `UnknownHost` | SonarQube is not running: `cd security/sonarqube; docker compose up -d --wait`. |
| SonarQube stage: `401` / `Not authorized` | Missing or revoked token: `node security/sonarqube/bootstrap.mjs --rotate-token`, then re-import the credential. |
| SonarQube stage: `CredentialNotFoundException: sonarqube-token` | Run `node jenkins/import-credential.mjs ...` (above). |
| `QUALITY GATE STATUS: FAILED` | Open the dashboard link in the log; fix the issues or add tests for new code. |
| SonarQube container restarts, log mentions `max virtual memory areas` | Raise `vm.max_map_count` to 262144 on the Docker host. |
| `bootstrap.mjs`: admin password not accepted | Write the current admin password to `security/sonarqube/secrets/admin-password` (no newline) and re-run. |
| Trivy: `BLOCKING HIGH CVE-...` | Upgrade the package to the fixed version shown; for base-image packages, rebuild (`apk upgrade`) or move to a newer base image digest. Accept only with a `.trivyignore` entry. |
| Trivy: `failed to download vulnerability DB` | The agent needs internet access to `mirror.gcr.io` / `ghcr.io`; retry the build. |
| Publish: `denied` / `unauthorized` | The token lacks `write:packages` or expired; update the `container-registry` credential. |
