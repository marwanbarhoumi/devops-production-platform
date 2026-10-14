# syntax=docker/dockerfile:1
# Jenkins inbound build agent for devops-production-platform.
# Adds the tools the Jenkinsfile needs to the official inbound agent (Java 21 + git):
#   - Node.js 24.16.0 + npm (same Node version as the service Dockerfiles; satisfies engines >=22.12.0)
#   - Docker CLI with buildx (talks to the Docker-in-Docker sidecar: test database, image builds)
#   - SonarScanner CLI 8.1 (runs on the agent's Java 21; no bundled JRE)
#   - Trivy 0.75 (filesystem, image and SBOM scans; vulnerability DB cached in /home/jenkins/.cache)
# Tool images are pinned by digest as well as tag, so a rebuild gives the same binaries.
ARG NODE_IMAGE=node:24.16.0-trixie-slim
ARG DOCKER_CLI_IMAGE=docker:29.9.0-cli
ARG SONAR_SCANNER_IMAGE=sonarsource/sonar-scanner-cli:12.2.0.4256_8.1.0@sha256:a3f4215076706c95a17a68c19322ee916e40a3acd081a8c1a1e839e0194afa57
ARG TRIVY_IMAGE=aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa
ARG AGENT_IMAGE=jenkins/inbound-agent:3391.va_37fa_a_305d6d-2-jdk21

FROM ${NODE_IMAGE} AS node
FROM ${DOCKER_CLI_IMAGE} AS docker-cli
FROM ${SONAR_SCANNER_IMAGE} AS sonar-scanner
FROM ${TRIVY_IMAGE} AS trivy

FROM ${AGENT_IMAGE}
USER root
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY --from=sonar-scanner /opt/sonar-scanner/bin /opt/sonar-scanner/bin
COPY --from=sonar-scanner /opt/sonar-scanner/lib /opt/sonar-scanner/lib
COPY --from=sonar-scanner /opt/sonar-scanner/conf /opt/sonar-scanner/conf
RUN ln -s /opt/sonar-scanner/bin/sonar-scanner /usr/local/bin/sonar-scanner
COPY --from=trivy /usr/local/bin/trivy /usr/local/bin/trivy
RUN node --version && npm --version && docker --version && docker buildx version && git --version \
    && sonar-scanner --version && trivy --version
COPY --chmod=0755 entrypoint.sh /usr/local/bin/dpp-agent-entrypoint

USER jenkins
# Checks the secret file, then execs the base image's /usr/local/bin/jenkins-agent.
ENTRYPOINT ["/usr/local/bin/dpp-agent-entrypoint"]
