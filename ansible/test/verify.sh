#!/bin/sh
# End-to-end test of the playbooks against the disposable test target (run by test/run-local-test.ps1
# inside the test-runner container). Exits non-zero on the first failed expectation.
set -eu

step() { printf '\n===== %s =====\n' "$*"; }
fail() { printf '\nTEST FAILED: %s\n' "$*" >&2; exit 1; }
INV=inventory/local-test.ini
# Output is grepped and parsed below, so no ANSI colour codes.
export ANSIBLE_FORCE_COLOR=0 ANSIBLE_NOCOLOR=1

# Throwaway key from the test-keys volume; same tmpfs copy as entrypoint.sh does for real keys.
install -m 600 /test-keys/automation "$HOME/.ssh/dpp-local-test"

step "Wait for sshd on the test target"
i=0
until ssh-keyscan -T 2 -t ed25519 test-target > "$HOME/.ssh/known_hosts_test" 2>/dev/null && [ -s "$HOME/.ssh/known_hosts_test" ]; do
  i=$((i + 1)); [ "$i" -lt 60 ] || fail "sshd did not come up on test-target"
  sleep 2
done
# Trust on first use is acceptable only for this throwaway local target; real hosts are verified against
# a fingerprint obtained out of band (README "SSH and host keys"). Strict checking stays on.
export ANSIBLE_SSH_ARGS="-o ControlMaster=auto -o ControlPersist=60s -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$HOME/.ssh/known_hosts_test -o IdentitiesOnly=yes -o PasswordAuthentication=no"
echo "host key recorded: $(cut -d' ' -f2 "$HOME/.ssh/known_hosts_test")"

step "Versions"
ansible --version | head -1
ansible-lint --version | head -1

step "Inventory"
ansible-inventory -i "$INV" --graph

step "Lint and syntax"
ansible-lint
for p in site common docker; do ansible-playbook -i "$INV" "playbooks/$p.yml" --syntax-check; done

step "Connectivity (ping) and privilege escalation"
ansible managed -i "$INV" -m ansible.builtin.ping
ansible managed -i "$INV" -b -m ansible.builtin.command -a "id -un" | tee /tmp/become.txt
grep -q '^root$' /tmp/become.txt || fail "sudo did not give root"

step "Safety: placeholder inventory is refused without contacting the host"
if ansible-playbook -i inventory/dev.ini.example playbooks/site.yml > /tmp/placeholder.txt 2>&1; then
  fail "site.yml ran against the placeholder inventory"
fi
grep -q 'is a placeholder or not an SSH target' /tmp/placeholder.txt || { cat /tmp/placeholder.txt; fail "unexpected placeholder failure"; }
grep -q 'UNREACHABLE' /tmp/placeholder.txt && fail "Ansible tried to connect to a placeholder host"
echo "refused as expected"

step "Safety: production requires confirm_production=true"
if ansible-playbook -i "$INV" playbooks/site.yml -e deployment_environment=prod > /tmp/prod.txt 2>&1; then
  fail "site.yml ran for a prod host without confirmation"
fi
grep -q 'is a production host' /tmp/prod.txt || { cat /tmp/prod.txt; fail "unexpected production failure"; }
echo "refused as expected"

step "Check mode on a fresh minimal target stops with a clear message"
if ansible-playbook -i "$INV" playbooks/site.yml --check > /tmp/check0.txt 2>&1; then
  fail "check mode passed although python3-apt is missing on the fresh target"
fi
grep -q 'Check mode needs python3-apt and python3-debian' /tmp/check0.txt || { cat /tmp/check0.txt; fail "unexpected check-mode failure"; }
echo "refused as expected"

step "Apply common.yml only"
ansible-playbook -i "$INV" playbooks/common.yml --diff

step "Check mode of site.yml before Docker is installed (no changes made)"
ansible-playbook -i "$INV" playbooks/site.yml --check --diff
ansible managed -i "$INV" -m ansible.builtin.command -a "sh -c 'command -v docker || echo absent'" | grep -q '^absent$' \
  || fail "check mode installed Docker"

step "Apply site.yml"
ansible-playbook -i "$INV" playbooks/site.yml --diff

recap_changed() { sed -n 's/.*dpp-test-target.*changed=\([0-9]*\).*failed=\([0-9]*\).*/\1 \2/p' "$1" | tail -1; }

step "Idempotency: second run must report changed=0"
ansible-playbook -i "$INV" playbooks/site.yml | tee /tmp/second.txt
set -- $(recap_changed /tmp/second.txt)
[ "${1:-x}" = 0 ] && [ "${2:-x}" = 0 ] || fail "second run: changed=${1:-?} failed=${2:-?}"

step "Check mode on the configured target must report changed=0"
ansible-playbook -i "$INV" playbooks/site.yml --check --diff | tee /tmp/check2.txt
set -- $(recap_changed /tmp/check2.txt)
[ "${1:-x}" = 0 ] && [ "${2:-x}" = 0 ] || fail "check mode after apply: changed=${1:-?} failed=${2:-?}"

step "Safety: check mode of a production host is allowed without confirmation"
ansible-playbook -i "$INV" playbooks/site.yml --check -e deployment_environment=prod | tee /tmp/prodcheck.txt
set -- $(recap_changed /tmp/prodcheck.txt)
[ "${1:-x}" = 0 ] && [ "${2:-x}" = 0 ] || fail "prod check mode: changed=${1:-?} failed=${2:-?}"

step "Verify the result on the target"
ansible managed -i "$INV" -b -m ansible.builtin.command -a "systemctl is-active docker containerd"
ansible managed -i "$INV" -b -m ansible.builtin.command -a "systemctl is-enabled docker containerd"
ansible managed -i "$INV" -b -m ansible.builtin.command -a "docker compose version"
ansible managed -i "$INV" -b -m ansible.builtin.command -a "docker run --rm hello-world" > /tmp/hello.txt 2>&1 || true
grep -q 'Hello from Docker!' /tmp/hello.txt || { cat /tmp/hello.txt; fail "docker run hello-world failed"; }
echo "docker run hello-world: OK"
ansible managed -i "$INV" -b -m ansible.builtin.command -a "cat /etc/apt/sources.list.d/docker.sources /etc/docker/daemon.json"
ansible managed -i "$INV" -b -m ansible.builtin.command -a "getent group docker"

printf '\nALL TESTS PASSED\n'
