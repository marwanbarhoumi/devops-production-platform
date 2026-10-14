<#
.SYNOPSIS
  Tests the playbooks end to end against a disposable Ubuntu 24.04 container (systemd + sshd), then
  removes it. Touches only the dpp-ansible Compose project; no other container or volume is affected.

.EXAMPLE
  .\ansible\test\run-local-test.ps1          # build, test, clean up
  .\ansible\test\run-local-test.ps1 -Keep    # leave the target running for inspection
#>
param([switch]$Keep)

# 'Continue': docker writes progress to stderr (see ansible.ps1). Exit codes are checked explicitly.
$ErrorActionPreference = 'Continue'
$compose = @('compose', '-f', (Join-Path $PSScriptRoot '..\docker-compose.yml'), '--profile', 'test')

function Invoke-Compose {
    docker @compose @args
    if ($LASTEXITCODE -ne 0) { throw "docker compose $($args -join ' ') failed (exit $LASTEXITCODE)" }
}

$result = 1
try {
    Invoke-Compose build ansible test-target
    Invoke-Compose run --rm test-keygen
    Invoke-Compose up -d test-target
    docker @compose run --rm test-runner sh test/verify.sh
    $result = $LASTEXITCODE
}
catch {
    Write-Host "ERROR: $_"
}
finally {
    if ($Keep) {
        Write-Host 'Test target kept. Remove it with:'
        Write-Host '  docker compose -f ansible/docker-compose.yml --profile test rm -fsv test-target'
        Write-Host '  docker volume rm dpp-ansible_test-keys dpp-ansible_test-target-docker dpp-ansible_test-target-containerd'
    }
    else {
        docker @compose rm --force --stop --volumes test-target 2>&1 | Out-Null
        foreach ($volume in 'dpp-ansible_test-keys', 'dpp-ansible_test-target-docker', 'dpp-ansible_test-target-containerd') {
            docker volume rm $volume 2>$null | Out-Null
        }
        Write-Host 'Test target and its volumes removed.'
    }
}
if ($result -eq 0) { Write-Host 'Local test: PASSED' } else { Write-Host "Local test: FAILED (exit $result)" }
exit $result
