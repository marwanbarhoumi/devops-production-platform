<#
.SYNOPSIS
  Records the LinkedIn showcase from the real project UIs in your running Brave (or Chrome/Edge) session:
  screenshots, cover, thumbnail and docs/demo/devops-platform-demo.mp4.

.DESCRIPTION
  Opens one extra window in the browser you are already signed in with (Jenkins, SonarQube, GitHub), switches
  it to full screen on a 1920x1080 monitor, visits each page, records it with ffmpeg (gdigrab) and closes the
  window again. It only reads pages: no build is started, nothing is changed in Jenkins, SonarQube or GitHub.
  Do not touch the keyboard or mouse while it runs (about 3 minutes); it stops if another window takes focus.
  See docs/demo/README.md.

.PARAMETER Monitor
  primary or secondary; the monitor must be 1920x1080.

.PARAMETER Build
  Jenkins build number to show (default: the build whose evidence is described in docs/demo/README.md).

.PARAMETER ScreenshotsOnly
  Capture screenshots, cover and thumbnail, but no video.

.PARAMETER Ffmpeg
  Path to ffmpeg.exe (default: $env:DEMO_FFMPEG, %LOCALAPPDATA%\dpp-demo\tools\*\bin\ffmpeg.exe, or PATH).
#>
param(
    [ValidateSet('primary', 'secondary')][string]$Monitor = 'primary',
    [int]$Build = 5,
    [switch]$ScreenshotsOnly,
    [string]$Ffmpeg,
    # Width of the frame Brave draws around a full-screen window (excluded from captures).
    [int]$FrameInset = 6
)
$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot\BraveDemo.psm1" -Force

$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$outDir = Join-Path $root 'docs\demo'
$shotDir = Join-Path $outDir 'screenshots'
$evidence = Join-Path $outDir 'evidence\ansible-validation.txt'
$work = Join-Path $env:LOCALAPPDATA 'dpp-demo\work'
$clipDir = Join-Path $work 'clips'
$assetDir = Join-Path $work 'assets'

$repoUrl = 'https://github.com/marwanbarhoumi/devops-production-platform'
$jenkins = 'http://localhost:8090'
$job = "$jenkins/job/devops-production-platform"
$sonarProject = 'devops-production-platform'

function Write-Step([string]$Text) { Write-Host "==> $Text" }

# ---------- preflight ----------
if (-not $Ffmpeg) { $Ffmpeg = $env:DEMO_FFMPEG }
if (-not $Ffmpeg) {
    $Ffmpeg = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'dpp-demo\tools') -Recurse -Filter ffmpeg.exe -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Ffmpeg) { $Ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source }
if (-not $Ffmpeg -or -not (Test-Path $Ffmpeg)) { throw 'ffmpeg not found. Install it (docs/demo/README.md) or pass -Ffmpeg.' }
$ffprobe = Join-Path (Split-Path $Ffmpeg) 'ffprobe.exe'

foreach ($check in @(
        @('Jenkins', "$jenkins/login"),
        @('SonarQube', 'http://localhost:9100/api/system/status'),
        @('GitHub', $repoUrl))) {
    try { [void](Invoke-WebRequest $check[1] -UseBasicParsing -TimeoutSec 10) }
    catch { throw "$($check[0]) is not reachable at $($check[1]): $($_.Exception.Message)" }
}
if (-not (Test-Path $evidence)) { throw "Missing $evidence. Run scripts/demo/collect-evidence.ps1 first." }
$fontFile = 'C:\Windows\Fonts\segoeuib.ttf'
if (-not $ScreenshotsOnly -and -not (Test-Path $fontFile)) { throw "Caption font not found: $fontFile" }

New-Item -ItemType Directory -Force $shotDir, $clipDir, $assetDir | Out-Null
Get-ChildItem $clipDir -File | Remove-Item
Copy-Item "$PSScriptRoot\assets\*" $assetDir -Force

# Render the evidence file into the terminal page (HTML-escaped, verbatim lines).
$lines = Get-Content $evidence -Encoding UTF8 | ForEach-Object {
    $html = [System.Net.WebUtility]::HtmlEncode($_)
    if ($_ -match '^\$ ') { "<span class=`"cmd`">$html</span>" }
    elseif ($_ -match '^#|^=====') { "<span class=`"dim`">$html</span>" }
    elseif ($_ -match 'Passed:|changed=0 |ALL TESTS PASSED|PASSED|refused as expected|hello-world: OK|\(exit code 0\)') { "<span class=`"ok`">$html</span>" }
    elseif ($_ -match 'is a placeholder|\(exit code [1-9]') { "<span class=`"bad`">$html</span>" }
    else { $html }
}
$template = Get-Content (Join-Path $assetDir 'terminal.html') -Raw -Encoding UTF8
[IO.File]::WriteAllText((Join-Path $assetDir 'terminal.html'), $template.Replace('<!--EVIDENCE-->', ($lines -join "`n")), [Text.UTF8Encoding]::new($false))

function Get-AssetUrl([string]$Name) { return 'file:///' + ((Join-Path $assetDir $Name) -replace '\\', '/') }
function Get-TextFragment([string]$Text) {
    return '#:~:text=' + ([uri]::EscapeDataString($Text) -replace '-', '%2D')
}

# ---------- capture ----------
$scenes = New-Object System.Collections.Generic.List[object]
$notes = New-Object System.Collections.Generic.List[string]

function Invoke-Scene([string]$Name, [string]$Caption, [scriptblock]$Actions) {
    if ($ScreenshotsOnly) { return }
    $clip = Join-Path $clipDir ('{0:D2}-{1}.mkv' -f ($scenes.Count + 1), $Name)
    $recorder = Start-DemoRecording $Ffmpeg $shot $clip
    try { & $Actions }
    finally { Stop-DemoRecording $recorder }
    $scenes.Add([pscustomobject]@{ Name = $Name; Clip = $clip; Caption = $Caption })
}

function Save-Shot([string]$Name) {
    Save-DemoScreenshot $shot (Join-Path $shotDir $Name)
    Write-Host "    screenshot $Name"
}

Write-Step "Opening a full-screen window in your running browser on the $Monitor monitor (hands off keyboard and mouse)"
$bounds = Open-DemoWindow $Monitor
# Inside the frame, trimmed to exactly 16:9 (1898x1068 on a 1920x1080 monitor with a 6 px frame).
$content = Get-DemoContentBounds $bounds $FrameInset
$shotWidth = [int][math]::Floor($content.Height * 16 / 9 / 2) * 2
$shot = New-Object System.Drawing.Rectangle ($content.X + [int](($content.Width - $shotWidth) / 2)), $content.Y, $shotWidth, $content.Height
try {
    Write-Step 'Cover and thumbnail'
    [void](Open-DemoUrl (Get-AssetUrl 'cover.html') 'DPP showcase - cover' 1.5)
    Save-DemoScreenshot $shot (Join-Path $work 'cover-full.png')
    [void](Open-DemoUrl (Get-AssetUrl 'thumbnail.html') 'DPP showcase - thumbnail' 1.5)
    Save-DemoScreenshot $shot (Join-Path $work 'thumbnail-full.png')

    Write-Step 'Title and architecture'
    [void](Open-DemoUrl (Get-AssetUrl 'title.html') 'DPP showcase - title' 1)
    Invoke-Scene 'title' '' { Start-Sleep -Milliseconds 5200 }
    [void](Open-DemoUrl (Get-AssetUrl 'architecture.html') 'DPP showcase - architecture' 1)
    Save-Shot '00-architecture-overview.png'
    Invoke-Scene 'architecture' '' { Start-Sleep -Milliseconds 7500 }

    Write-Step 'GitHub repository'
    [void](Open-DemoUrl $repoUrl 'marwanbarhoumi/devops-production-platform' 3)
    Save-Shot '01-github-repository.png'
    Invoke-Scene 'github' 'GitHub monorepo: TypeScript microservices, Jenkinsfile, security and Ansible' {
        Start-Sleep -Milliseconds 1800; Invoke-DemoScroll $bounds 4 200; Start-Sleep -Milliseconds 2200
    }

    Write-Step 'Jenkins'
    [void](Open-DemoUrl "$job/" 'devops-production-platform - Jenkins' 3)
    Save-Shot '02-jenkins-job.png'
    Invoke-Scene 'jenkins-job' 'Jenkins: build history and test-result trend' { Start-Sleep -Milliseconds 4500 }

    [void](Open-DemoUrl "$job/$Build/stages/" "#$Build" 3.5)
    Save-Shot '03-jenkins-pipeline-stages.png'
    Invoke-Scene 'jenkins-stages' "Build #${Build}: every stage passed, from lint and tests to image publishing" {
        Start-Sleep -Milliseconds 2500; Invoke-DemoScroll $bounds 5 220; Start-Sleep -Milliseconds 1800
    }

    [void](Open-DemoUrl "$job/$Build/testReport/" 'Tests' 3)
    Save-Shot '04-jenkins-test-results.png'
    Invoke-Scene 'jenkins-tests' '78 tests passed: unit, API and database integration (JUnit reports)' { Start-Sleep -Milliseconds 4800 }

    Write-Step 'SonarQube'
    $sonarShown = $false
    foreach ($host_ in 'localhost', '127.0.0.1') {
        try {
            [void](Open-DemoUrl "http://${host_}:9100/dashboard?id=$sonarProject" 'devops-production-platform|Overview' 4)
            $sonarShown = $true
            break
        }
        catch { Write-Host "    SonarQube on ${host_}: $($_.Exception.Message)" }
    }
    if ($sonarShown) {
        Save-Shot '05-sonarqube-quality-gate.png'
        Invoke-Scene 'sonarqube' 'SonarQube: quality gate passed' {
            Start-Sleep -Milliseconds 3000; Invoke-DemoScroll $bounds 3 220; Start-Sleep -Milliseconds 1800
        }
    }
    else {
        $notes.Add('SonarQube UI not signed in: the quality gate is shown in the Jenkins console log instead.')
        [void](Open-DemoUrl ("$job/$Build/console" + (Get-TextFragment 'QUALITY GATE STATUS: PASSED')) "#$Build" 3)
        Save-Shot '05-quality-gate-jenkins-log.png'
        Invoke-Scene 'quality-gate' 'SonarQube quality gate result, as reported in the Jenkins log: PASSED' { Start-Sleep -Milliseconds 5000 }
    }

    Write-Step 'Trivy and SBOM'
    [void](Open-DemoUrl ("$job/$Build/console" + (Get-TextFragment '[trivy] repository (filesystem)')) "#$Build" 3)
    Save-Shot '06-trivy-scan-results.png'
    Invoke-Scene 'trivy' 'Trivy: no HIGH/CRITICAL findings in the repository, 0 vulnerabilities in the 3 images' { Start-Sleep -Milliseconds 5500 }

    [void](Open-DemoUrl "$job/$Build/artifact/reports/" 'Artifacts' 2.5)
    Save-Shot '07-build-artifacts-reports.png'
    Invoke-Scene 'artifacts' 'Archived with every build: image manifest, Trivy reports, SBOMs' { Start-Sleep -Milliseconds 3500 }

    [void](Open-DemoUrl "$job/$Build/artifact/reports/sbom/api-gateway.cdx.json" 'cdx\.json' 2.5)
    Save-Shot '08-sbom-cyclonedx.png'
    Invoke-Scene 'sbom' 'CycloneDX SBOM generated by Trivy for each image' { Start-Sleep -Milliseconds 4200 }

    Write-Step 'GitHub Container Registry'
    [void](Open-DemoUrl 'https://github.com/marwanbarhoumi?tab=packages' 'Packages' 3.5)
    Save-Shot '09-ghcr-packages.png'
    Invoke-Scene 'ghcr' 'GitHub Container Registry: the 3 service images published by the pipeline' { Start-Sleep -Milliseconds 5000 }

    Write-Step 'Ansible'
    [void](Open-DemoUrl "$repoUrl/tree/main/ansible" 'ansible at main' 3)
    Save-Shot '10-ansible-structure.png'
    Invoke-Scene 'ansible-tree' 'Ansible: roles, playbooks, inventories and a local end-to-end test' {
        Start-Sleep -Milliseconds 2000; Invoke-DemoScroll $bounds 3 220; Start-Sleep -Milliseconds 1800
    }

    [void](Open-DemoUrl (Get-AssetUrl 'terminal.html') 'ansible evidence' 1.5)
    Save-Shot '11-ansible-validation.png'
    Invoke-Scene 'ansible-evidence' 'Real output: lint, syntax checks, safety refusal, idempotent second run (changed=0)' {
        Start-Sleep -Milliseconds 2500; Invoke-DemoScroll $bounds 14 260; Start-Sleep -Milliseconds 2200
    }

    [void](Open-DemoUrl (Get-AssetUrl 'end.html') 'DPP showcase - end' 1)
    Invoke-Scene 'end' '' { Start-Sleep -Milliseconds 5000 }
}
finally {
    Close-DemoWindow
}

# ---------- images ----------
Write-Step 'Cover (1200x627) and thumbnail (1280x720)'
# cover.html fills the top 1200:627 band of the page; keep that band at the capture width.
$coverHeight = [int][math]::Round($shot.Width * 627 / 1200)
& $Ffmpeg -hide_banner -loglevel error -y -i (Join-Path $work 'cover-full.png') -vf "crop=$($shot.Width):${coverHeight}:0:0,scale=1200:627:flags=lanczos" -frames:v 1 -update 1 (Join-Path $outDir 'devops-platform-cover.png')
if ($LASTEXITCODE -ne 0) { throw 'Cover rendering failed.' }
& $Ffmpeg -hide_banner -loglevel error -y -i (Join-Path $work 'thumbnail-full.png') -vf 'scale=1280:720:flags=lanczos' -frames:v 1 -update 1 (Join-Path $outDir 'devops-platform-thumbnail.png')
if ($LASTEXITCODE -ne 0) { throw 'Thumbnail rendering failed.' }

# ---------- video ----------
if (-not $ScreenshotsOnly) {
    Write-Step "Editing $($scenes.Count) clips into the demo video"
    Copy-Item $fontFile (Join-Path $work 'caption.ttf') -Force
    $inputs = @()
    $filters = @()
    $fade = 0.35
    for ($i = 0; $i -lt $scenes.Count; $i++) {
        $scene = $scenes[$i]
        $duration = [double](& $ffprobe -v error -show_entries format=duration -of csv=p=0 $scene.Clip) - 0.25
        $inputs += @('-i', $scene.Clip)
        $chain = "[${i}:v]trim=start=0.25,setpts=PTS-STARTPTS,fps=30,scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p," +
            "fade=t=in:st=0:d=$fade,fade=t=out:st=$([math]::Round($duration - $fade, 2)):d=$fade"
        if ($scene.Caption) {
            $captionFile = "caption-$i.txt"
            [IO.File]::WriteAllText((Join-Path $work $captionFile), $scene.Caption, [Text.UTF8Encoding]::new($false))
            $chain += ",drawtext=fontfile=caption.ttf:textfile=${captionFile}:fontsize=34:fontcolor=white:" +
                "box=1:boxcolor=0x0B1426@0.90:boxborderw=22:x=56:y=h-th-70:alpha='min(1,max(0,(t-0.4)/0.5))'"
        }
        $filters += "$chain[v$i]"
    }
    $concatInputs = (0..($scenes.Count - 1) | ForEach-Object { "[v$_]" }) -join ''
    $filterGraph = ($filters -join ';') + ";${concatInputs}concat=n=$($scenes.Count):v=1:a=0[out]"
    $video = Join-Path $outDir 'devops-platform-demo.mp4'
    Push-Location $work
    try {
        & $Ffmpeg -hide_banner -loglevel error -y @inputs -filter_complex $filterGraph -map '[out]' `
            -c:v libx264 -preset slow -crf 20 -profile:v high -pix_fmt yuv420p -r 30 -movflags +faststart $video
        if ($LASTEXITCODE -ne 0) { throw 'Video encoding failed.' }
    }
    finally { Pop-Location }
    $info = & $ffprobe -v error -show_entries stream=codec_name,width,height:format=duration,size -of default=nw=1 $video
    Write-Host ($info -join '  ')
}

Write-Step 'Done'
foreach ($note in $notes) { Write-Host "NOTE: $note" }
