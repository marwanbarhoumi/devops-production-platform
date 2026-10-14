<#
.SYNOPSIS
  Runs an Ansible command in the controller container (no Ansible installation on Windows).

.EXAMPLE
  .\ansible\ansible.ps1 -Build                     # build the controller image (first time / after changes)
  .\ansible\ansible.ps1 ansible --version
  .\ansible\ansible.ps1 ansible-inventory -i inventory/dev.ini --graph
  .\ansible\ansible.ps1 ansible managed -i inventory/dev.ini -m ansible.builtin.ping
  .\ansible\ansible.ps1 ansible-playbook -i inventory/dev.ini playbooks/site.yml --check --diff
  .\ansible\ansible.ps1 ansible-lint

  Paths are relative to the ansible/ directory (the container's working directory /ansible).
  No param() block on purpose: Ansible options such as -i and -m must reach the container untouched.
#>
# 'Continue': docker writes progress to stderr, which Windows PowerShell 5.1 would turn into a terminating
# error under 'Stop' when output is redirected. Exit codes are checked explicitly instead.
$ErrorActionPreference = 'Continue'
$compose = Join-Path $PSScriptRoot 'docker-compose.yml'
$command = @($args)

if ($command.Count -gt 0 -and $command[0] -eq '-Build') {
    docker compose -f $compose build ansible
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $command = @($command | Select-Object -Skip 1)
    if ($command.Count -eq 0) { exit 0 }
}
if ($command.Count -eq 0) { $command = @('ansible', '--version') }

docker compose -f $compose run --rm ansible @command
exit $LASTEXITCODE
