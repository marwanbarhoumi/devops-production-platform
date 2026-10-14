<#
.SYNOPSIS
  Rotates the inbound agent secret and saves the new secret of ci-agent-1 to jenkins/secrets/agent-secret.

.DESCRIPTION
  Use when the agent secret may have been exposed (screenshot, log, chat) or the secret file was lost.
  No Jenkins credentials are needed; it requires Docker access to the local dpp-jenkins stack.

  Inbound agent secrets are HMAC(node name) with one controller key,
  $JENKINS_HOME/secrets/jenkins.slaves.JnlpSlaveAgentProtocol.secret. The script:
    1. backs up and removes that key (Jenkins generates a new random key at the next start),
    2. adds a one-shot init.groovy.d script that writes the new secret of the node to a file readable
       only by the jenkins user (the script deletes itself after running),
    3. restarts the controller (container, volumes, users, jobs, history and plugins are kept),
    4. copies the secret into jenkins/secrets/agent-secret without displaying it, then removes the
       export file and the key backup,
    5. recreates the agent so it connects with the new secret.
  Every previously issued agent secret stops working. If anything fails before step 4 completes, the
  old key is restored and the controller restarted, so the previous state is kept.

.EXAMPLE
  cd jenkins
  powershell -ExecutionPolicy Bypass -File .\rotate-agent-secret.ps1
#>
[CmdletBinding()]
param(
    [string]$NodeName = 'ci-agent-1',
    [int]$TimeoutSeconds = 300
)
# Docker Compose reports progress on stderr, which Windows PowerShell 5.1 would turn into terminating
# errors under 'Stop'. Exit codes are checked explicitly instead.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot

if ($NodeName -notmatch '^[A-Za-z0-9._-]+$') { throw "Invalid node name '$NodeName'." }

$home_ = '/var/jenkins_home'
$keyFile = "$home_/secrets/jenkins.slaves.JnlpSlaveAgentProtocol.secret"
$backup = "$home_/secrets/.agent-key-rotation-backup"
$initScript = "$home_/init.groovy.d/dpp-export-agent-secret.groovy"
$exportFile = "$home_/.dpp-agent-secret-export"
$outFile = Join-Path $PSScriptRoot 'secrets\agent-secret'

function Invoke-Controller([string]$Script) {
    # Passed base64-encoded: Windows PowerShell adds CRLF to piped stdin and mangles quotes in native
    # arguments. The script text never contains secrets.
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($Script -replace "`r", '') + "`n"))
    docker compose exec -T controller sh -c "echo $b64 | base64 -d | sh -eu"
    if ($LASTEXITCODE -ne 0) { throw "Command in the controller failed (exit $LASTEXITCODE)." }
}

function Wait-Controller {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $health = docker inspect -f '{{.State.Health.Status}}' dpp-jenkins-controller-1 2>$null
        if ($health -eq 'healthy') {
            docker compose exec -T controller test -s $exportFile 2>$null
            if ($LASTEXITCODE -eq 0) { return }
        }
        Start-Sleep -Seconds 5
    }
    throw "Controller did not become healthy with a new agent secret within $TimeoutSeconds s."
}

$state = docker inspect -f '{{.State.Health.Status}}' dpp-jenkins-controller-1 2>$null
if ($state -ne 'healthy') { throw "Controller is not healthy (state: '$state'). Start it first: docker compose up -d --wait controller dind" }
Invoke-Controller "test -f $keyFile || { echo 'agent key file not found' >&2; exit 1; }"

Write-Host "Rotating the inbound agent key and exporting the new secret of '$NodeName'..."
$groovy = @"
import jenkins.slaves.JnlpAgentReceiver
def out = new File('$exportFile')
def tmp = new File(out.path + '.tmp')
tmp.text = JnlpAgentReceiver.SLAVE_SECRET.mac('$NodeName')
tmp.setReadable(false, false); tmp.setReadable(true, true); tmp.setWritable(false, false); tmp.setWritable(true, true)
tmp.renameTo(out)
new File('$initScript').delete()
"@
$rotated = $false
try {
    Invoke-Controller @"
umask 077
cp -p $keyFile $backup
rm -f $exportFile $exportFile.tmp
mkdir -p $home_/init.groovy.d
cat > $initScript <<'EOF'
$groovy
EOF
rm -f $keyFile
"@
    docker compose stop agent | Out-Null
    Write-Host 'Restarting the controller (data and configuration are kept)...'
    docker compose restart controller | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'docker compose restart controller failed.' }
    Wait-Controller

    $secret = ((docker compose exec -T controller cat $exportFile) -join '').Trim()
    if ($secret -notmatch '^[0-9a-f]{64}$') { throw 'Exported value is not a 64-character hexadecimal secret.' }
    New-Item -ItemType Directory -Force -Path (Split-Path $outFile) -ErrorAction Stop | Out-Null
    [IO.File]::WriteAllText($outFile, $secret, [Text.Encoding]::ASCII)
    Remove-Variable secret
    $rotated = $true
} catch {
    Write-Warning "Rotation failed: $($_.Exception.Message) Restoring the previous agent key..."
    Invoke-Controller @"
rm -f $initScript $exportFile $exportFile.tmp
if [ -f $backup ]; then mv -f $backup $keyFile; fi
rmdir $home_/init.groovy.d 2>/dev/null || true
"@
    docker compose restart controller | Out-Null
    throw
} finally {
    if ($rotated) {
        Invoke-Controller @"
rm -f $exportFile $exportFile.tmp $backup $initScript
rmdir $home_/init.groovy.d 2>/dev/null || true
"@
    }
}

Write-Host "New secret saved to $outFile (64 characters, not displayed). Old agent secrets are now invalid."
Write-Host 'Recreating the agent...'
docker compose up -d --force-recreate --no-deps agent | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'docker compose up agent failed.' }
Write-Host "Done. Check: docker compose logs agent | Select-String Connected"
