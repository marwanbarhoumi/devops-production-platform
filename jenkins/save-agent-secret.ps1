<#
.SYNOPSIS
  Fetches the inbound secret of a Jenkins agent node and saves it to jenkins/secrets/agent-secret.

.DESCRIPTION
  Avoids copy/paste mistakes (empty file, quotes, "-secret" prefix, UTF-16 encoding). The secret is
  written as ASCII without a trailing newline and is never printed. Your Jenkins credentials are
  read from a hidden prompt, used for one HTTPS/HTTP request to the local controller and discarded.
  Use an API token (Jenkins: your name > Security > API Token > Add new token) or your password.

.EXAMPLE
  cd jenkins
  .\save-agent-secret.ps1
  docker compose up -d agent
#>
[CmdletBinding()]
param(
    [string]$JenkinsUrl = 'http://localhost:8090',
    [string]$NodeName = 'ci-agent-1',
    [string]$OutFile = (Join-Path $PSScriptRoot 'secrets\agent-secret')
)
$ErrorActionPreference = 'Stop'

$user = Read-Host 'Jenkins username'
$secure = Read-Host 'API token or password (hidden)' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    $basic = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("${user}:${plain}"))
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    Remove-Variable plain -ErrorAction SilentlyContinue
}

$uri = '{0}/computer/{1}/jenkins-agent.jnlp' -f $JenkinsUrl.TrimEnd('/'), [Uri]::EscapeDataString($NodeName)
try {
    $response = Invoke-WebRequest -Uri $uri -Headers @{ Authorization = "Basic $basic" } -UseBasicParsing
} catch {
    throw "Request to $uri failed: $($_.Exception.Message). Check the URL, node name, username and token."
} finally {
    Remove-Variable basic -ErrorAction SilentlyContinue
}

$match = [regex]::Match([string]$response.Content, '<argument>([0-9a-f]{64})</argument>')
if (-not $match.Success) {
    throw "No agent secret found in the response from $uri (is '$NodeName' an inbound agent, and does the user have Agent/Connect permission?)."
}

New-Item -ItemType Directory -Force -Path (Split-Path $OutFile) | Out-Null
[IO.File]::WriteAllText($OutFile, $match.Groups[1].Value, [Text.Encoding]::ASCII)
Write-Host "Saved the secret of node '$NodeName' to $OutFile (64 characters, not displayed)."
Write-Host 'Next: docker compose up -d agent'
