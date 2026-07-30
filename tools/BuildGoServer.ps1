[CmdletBinding()]
param(
    [string]$GoExecutable = $env:VWD_GO_EXE,
    [string]$Version = "dev"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$sourceDirectory = Join-Path $projectRoot "server-go"
$outputDirectory = Join-Path $projectRoot "bin"

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
        Where-Object { $_.Name -like "VisualWaveDrom-server*" } |
        Sort-Object Name |
        ForEach-Object {
            $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            "$hash  $($_.Name)"
        }
    Set-Content -LiteralPath (Join-Path $outputDirectory "SHA256SUMS.txt") `
        -Value $checksumLines -Encoding ascii
} finally {
    $env:GOOS = $originalGoOS
    $env:GOARCH = $originalGoArch
    $env:CGO_ENABLED = $originalCGO
}
