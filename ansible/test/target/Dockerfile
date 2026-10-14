# syntax=docker/dockerfile:1
# Disposable Ubuntu 24.04 "server" for testing the playbooks locally (test/run-local-test.ps1).
# Prepared like a fresh server after the one-time steps in ansible/README.md ("Prepare a target"):
# an "automation" user with key-only SSH login and passwordless sudo. Test use only.
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
FROM ${UBUNTU_IMAGE}

ENV container=docker
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        systemd systemd-sysv dbus openssh-server sudo python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    # The base image's "ubuntu" user has uid 1000, which the automation user needs (key file ownership).
    && userdel --remove ubuntu \
    && useradd --create-home --uid 1000 --shell /bin/bash automation \
    && printf 'automation ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/90-automation \
    && chmod 0440 /etc/sudoers.d/90-automation \
    && visudo --check --quiet \
    # Host keys are generated at first boot, so no two test targets share them.
    && rm -f /etc/ssh/ssh_host_* \
    # Ubuntu 24.04 starts sshd through ssh.socket (socket activation), as on a real server.
    && systemctl mask getty.target systemd-logind.service

COPY sshd-test.conf /etc/ssh/sshd_config.d/10-dpp-test.conf
COPY ssh-hostkeys.conf /etc/systemd/system/ssh.service.d/10-hostkeys.conf

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
