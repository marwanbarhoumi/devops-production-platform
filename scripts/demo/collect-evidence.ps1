<#
.SYNOPSIS
  Runs the Ansible validation commands and writes their real output to docs/demo/evidence/ansible-validation.txt.

.PARAMETER RunLocalTest
  Also runs ansible/test/run-local-test.ps1 (about 8 minutes; disposable test containers only).

.PARAMETER LocalTestLog
  Summarize an existing log of run-local-test.ps1 instead of running it again.
#>
param(
    [switch]$RunLocalTest,
    [string]$LocalTestLog
)
$ErrorActionPreference = 'Continue'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$runner = Join-Path $root 'ansible\ansible.ps1'
$outDir = Join-Path $root 'docs\demo\evidence'
New-Item -ItemType Directory -Force $outDir | Out-Null
$out = Join-Path $outDir 'ansible-validation.txt'

function Clear-Output($lines) {
    $lines | ForEach-Object { "$_" -replace '\x1b\[[0-9;]*m', '' } |
        Where-Object { $_ -notmatch 'Container dpp-ansible-|NativeCommandError|CategoryInfo|^\s*\+ |^Au caract|^At line|RemoteException|^\s*$' }
}

function Invoke-Ansible([string]$Label, [string[]]$Arguments, [string]$Keep) {
    $raw = & $runner @Arguments 2>&1
    $code = $LASTEXITCODE
    $lines = @(Clear-Output $raw)
    if ($Keep) { $lines = @($lines | Where-Object { $_ -match $Keep }) }
    $script:report += "`$ $Label"
    $script:report += $lines
    $script:report += "(exit code $code)"
    $script:report += ''
    return $code
}

$commit = (git -C $root rev-parse --short HEAD).Trim()
$script:report = @(
    '# Ansible validation evidence - devops-production-platform'
    "# Captured $(Get-Date -Format 'yyyy-MM-dd HH:mm (zzz)') by scripts/demo/collect-evidence.ps1 at commit $commit"
    '# Commands run in the containerized controller (ansible/ansible.ps1); output copied verbatim (colours removed).'
    ''
)

$failures = 0
if ((Invoke-Ansible 'ansible --version' @('ansible', '--version') '^ansible \[core') -ne 0) { $failures++ }
if ((Invoke-Ansible 'ansible-lint' @('ansible-lint') 'Passed|failure|warning') -ne 0) { $failures++ }
foreach ($p in 'site', 'common', 'docker') {
    if ((Invoke-Ansible "ansible-playbook -i inventory/dev.ini.example playbooks/$p.yml --syntax-check" @('ansible-playbook', '-i', 'inventory/dev.ini.example', "playbooks/$p.yml", '--syntax-check') 'playbook:|ERROR') -ne 0) { $failures++ }
}
if ((Invoke-Ansible 'ansible-inventory -i inventory/local-test.ini --graph' @('ansible-inventory', '-i', 'inventory/local-test.ini', '--graph') '') -ne 0) { $failures++ }
$code = Invoke-Ansible 'ansible-playbook -i inventory/dev.ini.example playbooks/site.yml   # unedited template: must be refused' @('ansible-playbook', '-i', 'inventory/dev.ini.example', 'playbooks/site.yml') 'Refuse placeholder|is a placeholder|PLAY RECAP|dev-app-1 +:'
if ($code -eq 0) { $failures++ }

if ($RunLocalTest) {
    $LocalTestLog = Join-Path ([IO.Path]::GetTempPath()) 'dpp-ansible-local-test.log'
    & (Join-Path $root 'ansible\test\run-local-test.ps1') *> $LocalTestLog
}
if ($LocalTestLog) {
    if (-not (Test-Path $LocalTestLog)) { throw "Local test log not found: $LocalTestLog" }
    $logLines = @(Clear-Output (Get-Content $LocalTestLog))
    $script:report += '$ .\ansible\test\run-local-test.ps1   # end-to-end test against a disposable Ubuntu 24.04 target (summary)'
    $script:report += $logLines | Where-Object {
        $_ -match '^=====|dpp-test-target +: ok=|refused as expected|hello-world: OK|ALL TESTS PASSED|Local test: |Docker Engine [0-9]|Compose [0-9]'
    } | ForEach-Object { $_.TrimEnd() }
    $script:report += ''
    if (-not ($logLines -match 'ALL TESTS PASSED')) { $failures++ }
}

$script:report | Set-Content -Path $out -Encoding UTF8
Write-Host "Evidence written to $out"
if ($failures -gt 0) { Write-Host "$failures check(s) did not give the expected result; see the file."; exit 1 }
exit 0
