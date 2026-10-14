# syntax=docker/dockerfile:1
# Ansible controller for devops-production-platform (Phase 4). Runs ansible-core and ansible-lint in
# Linux, so nothing has to be installed on the Windows host.
#
# No credentials are baked in: SSH keys are mounted at run time from the git-ignored ansible/.ssh/
# directory and copied into a tmpfs by entrypoint.sh (see docker-compose.yml).
ARG PYTHON_IMAGE=python:3.13-slim-trixie@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f
FROM ${PYTHON_IMAGE}

# openssh-client: SSH transport. git: used by ansible-lint to find the project root.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --no-deps -r /tmp/requirements.txt \
    && pip check \
    && rm /tmp/requirements.txt

RUN useradd --create-home --uid 1000 --shell /bin/bash ansible
COPY --chmod=0755 entrypoint.sh /usr/local/bin/dpp-ansible-entrypoint

USER ansible
WORKDIR /ansible
ENV ANSIBLE_CONFIG=/ansible/ansible.cfg \
    ANSIBLE_HOME=/home/ansible/.ansible \
    ANSIBLE_FORCE_COLOR=1 \
    PYTHONDONTWRITEBYTECODE=1
RUN ansible --version && ansible-lint --version

ENTRYPOINT ["/usr/local/bin/dpp-ansible-entrypoint"]
CMD ["ansible", "--version"]
