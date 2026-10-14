# syntax=docker/dockerfile:1
# Jenkins inbound build agent for devops-production-platform.
# Adds the tools the Jenkinsfile needs to the official inbound agent (Java 21 + git):
#   - Node.js 24.16.0 + npm (same Node version as the service Dockerfiles; satisfies engines >=22.12.0)
#   - Docker CLI (talks to the Docker-in-Docker sidecar for the integration-test database)
ARG NODE_IMAGE=node:24.16.0-trixie-slim
ARG DOCKER_CLI_IMAGE=docker:29.9.0-cli
ARG AGENT_IMAGE=jenkins/inbound-agent:3391.va_37fa_a_305d6d-2-jdk21

FROM ${NODE_IMAGE} AS node
FROM ${DOCKER_CLI_IMAGE} AS docker-cli

FROM ${AGENT_IMAGE}
USER root
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN node --version && npm --version && docker --version && git --version
COPY --chmod=0755 entrypoint.sh /usr/local/bin/dpp-agent-entrypoint

USER jenkins
# Checks the secret file, then execs the base image's /usr/local/bin/jenkins-agent.
ENTRYPOINT ["/usr/local/bin/dpp-agent-entrypoint"]
