[CmdletBinding()]
param(
    [string]$GoExecutable = $env:VWD_GO_EXE,
    [string]$Version = "",
    [string]$ReleaseNotes = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceDirectory = Join-Path $projectRoot "inc/server-go"
$outputDirectory = Join-Path $projectRoot "bin"
$manifestPath = Join-Path $projectRoot "inc/visualwavedrom-release.json"
if (-not $Version) {
    $datePrefix = Get-Date -Format 'yyyy.M.d'
    $revision = 1
    if (Test-Path -LiteralPath $manifestPath) {
        $previous = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($previous.version.StartsWith("$datePrefix.")) {
            $revision = [int]($previous.version.Split('.')[-1]) + 1
        }
    }
    $Version = "$datePrefix.$revision"
}
if ($Version -notmatch '^\d{1,6}\.\d{1,6}\.\d{1,6}\.\d{1,6}$') {
    throw 'Version must have four numeric components, e.g. 2026.9.12.1.'
}

if (-not $GoExecutable) {
    $goCommand = Get-Command go -ErrorAction SilentlyContinue
    if ($goCommand) {
        $GoExecutable = $goCommand.Source
    }
}
if (-not $GoExecutable -or -not (Test-Path -LiteralPath $GoExecutable)) {
    throw "Go was not found. Install Go or set VWD_GO_EXE to go.exe."
}

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$originalGoOS = $env:GOOS
$originalGoArch = $env:GOARCH
$originalCGO = $env:CGO_ENABLED
try {
    $env:CGO_ENABLED = "0"
    $targets = @(
        @{
            OS = "windows"
            Arch = "amd64"
            Output = (Join-Path $outputDirectory "VisualWaveDrom-server.exe")
        },
        @{
            OS = "linux"
            Arch = "amd64"
            Output = (Join-Path $outputDirectory "VisualWaveDrom-server-linux-amd64")
        }
    )
    Push-Location $sourceDirectory
    try {
        foreach ($target in $targets) {
            $env:GOOS = $target.OS
            $env:GOARCH = $target.Arch
            & $GoExecutable build `
                -trimpath `
                -buildvcs=false `
                -ldflags "-s -w -X main.buildVersion=$Version" `
                -o $target.Output `
                .
            if ($LASTEXITCODE -ne 0) {
                throw "Go build failed for $($target.OS)/$($target.Arch)."
            }
        }
    } finally {
        Pop-Location
    }

    $env:GOOS = ""
    $env:GOARCH = ""
    Push-Location $sourceDirectory
    try {
        & $GoExecutable test ./...
        if ($LASTEXITCODE -ne 0) {
            throw "Go server verification failed."
        }
    } finally {
        Pop-Location
    }

    $checksumLines = Get-ChildItem -LiteralPath $outputDirectory -File |
        Where-Object {
            $_.Name -like "VisualWaveDrom-server*" -and -not $_.Name.EndsWith("~")
        } |
        Sort-Object Name |
        ForEach-Object {
            $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            "$hash  $($_.Name)"
        }
    Set-Content -LiteralPath (Join-Path $outputDirectory "SHA256SUMS.txt") `
        -Value $checksumLines -Encoding ascii
    $releaseArgs = @('--root', $projectRoot, '--make-release', $Version)
    if ($ReleaseNotes) { $releaseArgs += @('--release-notes', $ReleaseNotes) }
    & (Join-Path $outputDirectory "VisualWaveDrom-server.exe") @releaseArgs
    if ($LASTEXITCODE -ne 0) { throw 'Release manifest generation failed.' }
    Write-Host "VisualWaveDrom version $Version is ready."
} finally {
    $env:GOOS = $originalGoOS
    $env:GOARCH = $originalGoArch
    $env:CGO_ENABLED = $originalCGO
}
