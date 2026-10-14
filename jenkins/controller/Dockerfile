# syntax=docker/dockerfile:1
# Jenkins controller: official LTS image + pinned plugins + Configuration as Code.
# Builds never run here (0 executors); they run on the separate agent (../agent/Dockerfile).
FROM jenkins/jenkins:2.580.1-lts-jdk21

COPY --chown=jenkins:jenkins plugins.txt /usr/share/jenkins/ref/plugins.txt
RUN jenkins-plugin-cli --plugin-file /usr/share/jenkins/ref/plugins.txt

COPY --chown=jenkins:jenkins casc.yaml /usr/share/jenkins/casc/jenkins.yaml
ENV CASC_JENKINS_CONFIG=/usr/share/jenkins/casc/jenkins.yaml \
    # Plugin versions from this image replace older ones already present in the jenkins_home volume.
    PLUGINS_FORCE_UPGRADE=true

# Already the base image's user; stated explicitly so image scanners can verify it (Trivy DS-0002).
USER jenkins

HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=5 \
    CMD curl -fsS -o /dev/null http://localhost:8080/login || exit 1
