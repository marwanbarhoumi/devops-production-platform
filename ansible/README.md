# ansible

**Status: Phase 4 complete for the local scope.** Reusable Ansible automation that prepares Ubuntu servers
for the platform: a common baseline and Docker Engine. Ansible runs in a container, so nothing is installed
on Windows. The roles were verified end to end against a disposable Ubuntu 24.04 test server (section 9).
**No real VM has been configured yet**: that needs a target host and working SSH credentials from you.

Decisions: D-026 to D-029 in [docs/DECISIONS.md](../docs/DECISIONS.md). Roadmap: [docs/PROJECT_PLAN.md](../docs/PROJECT_PLAN.md).

```text
ansible/
├── Dockerfile, entrypoint.sh      # controller image: Python 3.13, ansible-core 2.21.5, ansible-lint 26.10.1
├── docker-compose.yml             # project dpp-ansible: controller + local test services (profile "test")
├── ansible.ps1                    # PowerShell wrapper: runs any Ansible command in the controller
├── ansible.cfg, .ansible-lint     # strict SSH host key checking, no default inventory; lint profile "production"
├── requirements.in / .txt         # direct / fully pinned Python dependencies (scripts/lock-requirements.sh)
├── inventory/
│   ├── dev.ini.example            # templates with unresolvable .invalid placeholders
│   ├── prod.ini.example
│   ├── local-test.ini             # the disposable test server only
│   └── group_vars/all.yml(.example)
├── playbooks/
│   ├── site.yml                   # common + docker_engine
│   ├── common.yml, docker.yml     # one role each
│   └── tasks/preflight.yml        # safety checks imported by every playbook
├── roles/
│   ├── common/                    # supported-OS check, admin packages, apt keyrings dir, unattended upgrades
│   └── docker_engine/             # Docker's signed apt repo, Engine + Buildx + Compose, daemon.json, services
└── test/                          # local end-to-end test (test target image, verify.sh, run-local-test.ps1)
```

Not here: your inventories (`inventory/*.ini`), SSH keys and known hosts (`ansible/.ssh/`) and Vault password
files. All are git-ignored.

## 1. What the playbooks do

All playbooks target the inventory group `managed`, escalate with `sudo`, and start with the preflight checks
(section 2).

| Role | Changes on the server |
| --- | --- |
| `common` | Refuses anything but Ubuntu 22.04/24.04/26.04. Installs `python3-apt`/`python3-debian` (needed by Ansible's apt modules), `ca-certificates curl gnupg jq htop unzip tzdata` and `unattended-upgrades`; creates `/etc/apt/keyrings`; writes `/etc/apt/apt.conf.d/20auto-upgrades` (security updates on). |
| `docker_engine` | Refuses if distribution Docker packages (`docker.io`, `podman-docker`, ...) are installed, unless removal is explicitly allowed. Downloads Docker's signing key to `/etc/apt/keyrings/docker.asc` and **stops unless its fingerprint is `9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88`**. Adds `/etc/apt/sources.list.d/docker.sources` (deb822, signed by that key only), installs `docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin`, writes `/etc/docker/daemon.json` (validated by `dockerd --validate`; log rotation 3 × 10 MB), enables and starts `containerd` and `docker`. Adds users to the `docker` group only if you list them. |

The roles never touch SSH configuration, firewall rules, network configuration or existing users, and never
upgrade packages that are already installed (`state: present`; unattended-upgrades applies security updates).

## 2. Safety model

| Risk | Protection |
| --- | --- |
| Running against a machine you did not choose | No default inventory: every command needs `-i`. Example inventories use `*.example.invalid` names (RFC 2606: can never resolve), and the preflight refuses `.invalid`, `CHANGE_ME` and `<...>` addresses **before connecting**. |
| Running against the Windows host or a container | Preflight refuses `ansible_connection` `local`, `docker`, `winrm` and `psrp`; the playbooks only manage Ubuntu over SSH. |
| Production by accident | Changes to hosts with `deployment_environment=prod` are refused unless `-e confirm_production=true` is given (`--check` runs are allowed). |
| Man-in-the-middle | `StrictHostKeyChecking=yes` with `ansible/.ssh/known_hosts`: unknown or changed host keys stop the run. You add host keys yourself after checking the fingerprint (section 4). |
| Leaked credentials | No password or key in the image or in git. Keys are read from git-ignored `ansible/.ssh/` at run time and copied to a RAM-only directory inside the short-lived container. Password authentication is disabled for Ansible's SSH. |
| A compromised download | Docker's key fingerprint is verified before the repository is added; Python dependencies and base images are pinned. |
| Surprise changes | `--check --diff` shows every change first; a second run must report `changed=0`. |

The controller container runs as a non-root user with a read-only root filesystem, no Linux capabilities and
`no-new-privileges`. It does not mount the Docker socket and is in its own Compose project (`dpp-ansible`),
so it cannot affect the application, Jenkins or SonarQube stacks.

## 3. Build the controller

Requirements: Docker Desktop. All commands run from the repository root in PowerShell.

```powershell
.\ansible\ansible.ps1 -Build                 # build dpp-ansible/controller:local (first time, after changes)
.\ansible\ansible.ps1                        # = ansible --version
```

`ansible.ps1` runs its arguments in a fresh controller container (`docker compose run --rm`), with
`ansible/` as the working directory. **Paths are relative to `ansible/`**, for example `-i inventory/dev.ini`.

## 4. Prepare a target server (one time)

The playbooks expect a fresh Ubuntu 22.04, 24.04 or 26.04 server reachable over SSH, with Python 3 (preinstalled
on Ubuntu) and a dedicated automation user that logs in with a key and may use `sudo`.

**4.1 Create a key pair for the automation user** (on Windows, in the repository root):

```powershell
New-Item -ItemType Directory -Force ansible\.ssh
ssh-keygen -t ed25519 -f ansible\.ssh\id_ed25519_dpp -C dpp-automation
```

The controller has no SSH agent, so it can only use a key without a passphrase (press Enter twice). Use this key
only for automation, keep it out of backups that leave your machine, and use a separate key for production
(`id_ed25519_dpp_prod`). Key files named `id_*` or `*.key` in `ansible/.ssh/` are picked up automatically.

**4.2 Create the automation user on the server** (as an existing administrator, on the server console or your
usual SSH session). Paste the content of `ansible\.ssh\id_ed25519_dpp.pub` in place of the placeholder:

```bash
sudo adduser --disabled-password --gecos "" automation
sudo install -d -m 700 -o automation -g automation /home/automation/.ssh
echo 'ssh-ed25519 AAAA...PASTE-PUBLIC-KEY... dpp-automation' | sudo tee /home/automation/.ssh/authorized_keys
sudo chown automation:automation /home/automation/.ssh/authorized_keys
sudo chmod 600 /home/automation/.ssh/authorized_keys
echo 'automation ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/90-automation
sudo chmod 440 /etc/sudoers.d/90-automation
sudo visudo -cf /etc/sudoers.d/90-automation
```

`--disabled-password` means the account has no password at all: it can only log in with the key.
Passwordless `sudo` is what lets Ansible run unattended. If you prefer a sudo password, give the user a
password, leave out `NOPASSWD:` and add `--ask-become-pass` (`-K`) to every command (this variant is not covered
by the local test). Your existing SSH server settings stay as they are; the playbooks never change them.

**4.3 Record the server's host key after verifying it.** On the server console (not over the network you are
trying to trust), print the fingerprint:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Then fetch the key from your machine, replacing `203.0.113.10` with the address you will put in the inventory
(IP or DNS name, exactly as in `ansible_host`):

```powershell
.\ansible\ansible.ps1 sh -c "ssh-keyscan -t ed25519 203.0.113.10 2>/dev/null > .ssh/scan.tmp && ssh-keygen -lf .ssh/scan.tmp"
```

**Only if both fingerprints are identical**, add it to the known hosts file and delete the temporary file:

```powershell
.\ansible\ansible.ps1 sh -c "cat .ssh/scan.tmp >> .ssh/known_hosts && rm .ssh/scan.tmp"
```

If they differ, stop: you are not talking to your server. If the server is reinstalled later, its host key
changes and Ansible refuses to connect until you remove the old line from `ansible\.ssh\known_hosts` and repeat
this step.

## 5. Create your inventory

```powershell
Copy-Item ansible\inventory\dev.ini.example ansible\inventory\dev.ini
notepad ansible\inventory\dev.ini
```

Replace `dev-app-1.example.invalid` with the server's address. The host name on the left (`dev-app-1`) is just
a label. `dev.ini` is git-ignored. For production, copy `prod.ini.example` to `prod.ini` the same way.

Check what an inventory would target before running anything:

```powershell
.\ansible\ansible.ps1 ansible-inventory -i inventory/dev.ini --graph
.\ansible\ansible.ps1 ansible-playbook -i inventory/dev.ini playbooks/site.yml --list-hosts
```

## 6. Run

```powershell
# Connectivity, key login and Python on the server
.\ansible\ansible.ps1 ansible managed -i inventory/dev.ini -m ansible.builtin.ping

# Privilege escalation (must print "root")
.\ansible\ansible.ps1 ansible managed -i inventory/dev.ini -b -m ansible.builtin.command -a "id -un"

# Preview: changes nothing, shows file diffs
.\ansible\ansible.ps1 ansible-playbook -i inventory/dev.ini playbooks/site.yml --check --diff

# Apply (or playbooks/common.yml / playbooks/docker.yml for one role)
.\ansible\ansible.ps1 ansible-playbook -i inventory/dev.ini playbooks/site.yml --diff

# Idempotency: run again; the recap must show changed=0
.\ansible\ansible.ps1 ansible-playbook -i inventory/dev.ini playbooks/site.yml
```

On a minimal image without `python3-apt`, `--check` stops with a message naming the missing packages: check mode
must not install anything, and Ansible's apt modules cannot predict changes without them. Run once without
`--check` (the roles install them), or install them on the server first. Standard Ubuntu Server images already
have `python3-apt`.

Limit a run to one host with `--limit dev-app-1`.

**Production:**

```powershell
.\ansible\ansible.ps1 ansible-playbook -i inventory/prod.ini playbooks/site.yml --check --diff
.\ansible\ansible.ps1 ansible-playbook -i inventory/prod.ini playbooks/site.yml --diff -e confirm_production=true
```

Check mode needs no confirmation. Applying without `-e confirm_production=true` stops with
"... is a production host" before any change.

## 7. Configuration

Role defaults are in `roles/<role>/defaults/main.yml`. Override them in `inventory/group_vars/all.yml` (all
environments), in a new `inventory/group_vars/<group>.yml` (for example `prod.yml`), or per host in the
inventory. `inventory/group_vars/all.yml.example` shows common overrides; files ending in `.example` are not
loaded.

| Variable | Default | Purpose |
| --- | --- | --- |
| `common_extra_packages` | `[]` | Additional apt packages |
| `common_unattended_upgrades_enabled` | `true` | Automatic security updates |
| `docker_engine_version` | `""` (latest at first install) | Exact version of `docker-ce`/`docker-ce-cli`, e.g. `5:29.9.0-1~ubuntu.24.04~noble` (`apt-cache madison docker-ce`) |
| `docker_engine_daemon_options` | json-file logs, 10m × 3 | Content of `/etc/docker/daemon.json`; `{}` leaves the file unmanaged |
| `docker_engine_remove_conflicting_packages` | `false` | Allow removing `docker.io`, `podman-docker`, ... (removed, not purged; `/var/lib/docker` kept) |
| `docker_engine_users` | `[]` | Existing users to add to the `docker` group (see below) |
| `docker_engine_service_enabled` / `_state` | `true` / `started` | Docker and containerd service state |

**Docker group.** Membership in `docker` is equivalent to root on the server (any member can start a privileged
container that mounts `/`). The role therefore adds nobody by default, never creates users, and fails if a
listed user does not exist. Add only trusted administrator accounts, and record why in the inventory or
`group_vars`. The automation user does not need it: Ansible uses `sudo`. Removing a user from the list does not
remove them from the group; do that with `sudo gpasswd -d <user> docker`.

## 8. Secrets

The current roles need no secrets. Connection credentials are the SSH key in `ansible/.ssh/` and, optionally, a
sudo password typed at run time with `-K`. When a role needs a secret, use Ansible Vault:

```powershell
.\ansible\ansible.ps1 ansible-vault create inventory/group_vars/prod/vault.yml
.\ansible\ansible.ps1 ansible-playbook -i inventory/prod.ini playbooks/site.yml --check --ask-vault-pass
```

The encrypted file can be committed; the Vault password must never be committed. Prefer `--ask-vault-pass`: a
password *file* bind-mounted from Windows shows up as executable, and Ansible would try to run it as a script.
`ansible/.vault-pass*` is git-ignored as a safety net. This is the documented pattern only; no Vault file exists yet.

## 9. Local end-to-end test

The roles are tested against a disposable Ubuntu 24.04 container that behaves like a small server (systemd,
OpenSSH with key-only login, an `automation` user with passwordless sudo). It is not your Windows host and
not any real machine.

```powershell
.\ansible\test\run-local-test.ps1           # about 6-7 minutes; add -Keep to leave the target running
```

It builds the images, generates a throwaway key pair into a Docker volume, starts the target, and runs
`test/verify.sh` in a controller container. The test:

1. Waits for SSH and records the target's host key (trust on first use, acceptable only for this throwaway target;
   strict checking stays on).
2. Runs `ansible-lint` (production profile) and `--syntax-check` for the three playbooks.
3. Checks ping and `sudo` (`id -un` = `root`).
4. Expects refusals: the unedited `dev.ini.example` (without any connection attempt), and a prod host without
   `confirm_production=true`.
5. Expects check mode on the fresh, minimal target to stop with the `python3-apt` message.
6. Applies `common.yml`, then runs `site.yml --check --diff` and verifies Docker was **not** installed.
7. Applies `site.yml`, runs it again (must be `changed=0`), and runs check mode again (must be `changed=0`),
   also as a prod host without confirmation (check mode is allowed).
8. Verifies the `docker` and `containerd` services are active and enabled, `docker compose version`, and
   `docker run --rm hello-world` inside the target; prints `docker.sources`, `daemon.json` and the docker group.

Then it removes the target container and the three test volumes (`dpp-ansible_test-*`). Nothing else is
touched. The target runs privileged, because it hosts systemd and its own Docker Engine; it is only started
by this test and has no published ports.

## 10. Validation commands

```powershell
.\ansible\ansible.ps1 ansible-lint
.\ansible\ansible.ps1 ansible-playbook -i inventory/dev.ini.example playbooks/site.yml --syntax-check
.\ansible\ansible.ps1 ansible-inventory -i inventory/dev.ini.example --graph
docker compose -f ansible/docker-compose.yml config --quiet
docker compose -f ansible/docker-compose.yml --profile test config --quiet
```

## 11. Upgrading Ansible or ansible-lint

Edit the versions in `requirements.in`, regenerate the pinned `requirements.txt` with the same base image as the
Dockerfile, then rebuild and re-run the local test:

```powershell
docker run --rm -v "${PWD}/ansible:/src" -w /src python:3.13-slim-trixie@sha256:70729b46c69b4f1e97c4822c1af3df53a1476cf5ddc6c087c0c10bc3a5678c2f sh scripts/lock-requirements.sh
.\ansible\ansible.ps1 -Build
.\ansible\test\run-local-test.ps1
```

## 12. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `is a placeholder or not an SSH target` | You used an `.example` inventory or left a placeholder. Edit your copy (section 5). |
| `is a production host` | Intended. Add `-e confirm_production=true` after reviewing `--check --diff`. |
| `Host key verification failed` / `REMOTE HOST IDENTIFICATION HAS CHANGED` | The host is not in `ansible/.ssh/known_hosts`, or its key changed. Verify and add it (section 4.3). Never disable host key checking. |
| `Permission denied (publickey)` | Wrong `ansible_user`, key file name, or `authorized_keys` content/permissions on the server. The path in the inventory is inside the container: `/home/ansible/.ssh/<file name>`. |
| `Missing sudo password` | The server user needs a sudo password: add `-K`, or configure passwordless sudo (section 4.2). |
| `Check mode needs python3-apt and python3-debian` | Minimal image; see section 6. |
| `conflict with Docker's packages` | Distribution Docker packages are installed. Remove them yourself or set `docker_engine_remove_conflicting_packages: true`. |
| `does not contain the expected key` | The downloaded Docker key does not match the pinned fingerprint. Do not override; check Docker's install documentation for a key rotation. |
| Ansible ignores `ansible.cfg` | Run through `ansible.ps1` (sets `ANSIBLE_CONFIG`); Windows bind mounts look world-writable, so Ansible skips a config file found in the current directory. |

## 13. Not verified

- **A real VM.** No target host or credentials were provided, so the playbooks have only run against the local
  test container. The first real run should use `--check --diff`.
- Ubuntu 22.04 and 26.04 (the test target is 24.04), arm64, and the sudo-password (`-K`) variant.
- Ansible Vault (documented pattern; no secret is used yet).
