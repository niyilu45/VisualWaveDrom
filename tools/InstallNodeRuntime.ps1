[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)]
  [string]$Destination = (Join-Path $PSScriptRoot '..\inc\node-runtime')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ([Net.ServicePointManager]::SecurityProtocol -band [Net.SecurityProtocolType]::Tls12) {
  # TLS 1.2 is already enabled.
} else {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
}

$machineArchitecture = if ($env:PROCESSOR_ARCHITEW6432) {
  $env:PROCESSOR_ARCHITEW6432
} else {
  $env:PROCESSOR_ARCHITECTURE
}

switch -Regex ($machineArchitecture) {
  'ARM64' { $platform = 'win-arm64'; break }
  'AMD64|x64' { $platform = 'win-x64'; break }
  'x86' { $platform = 'win-x86'; break }
  default { throw "Unsupported Windows architecture: $machineArchitecture" }
}

$destinationPath = [IO.Path]::GetFullPath($Destination)
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ('VisualWaveDrom-node-' + [Guid]::NewGuid().ToString('N'))

try {
  Write-Host 'Reading the official Node.js release list...'
  $releases = Invoke-RestMethod -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json'
  $release = $releases |
    Where-Object { $_.lts -and $_.files -contains ($platform + '-zip') } |
    Select-Object -First 1
  if (-not $release) {
    throw "No Node.js LTS archive is available for $platform."
  }

  $version = [string]$release.version
  $archiveName = "node-$version-$platform.zip"
  $releaseBaseUrl = "https://nodejs.org/dist/$version"
  $archivePath = Join-Path $tempRoot $archiveName
  $checksumPath = Join-Path $tempRoot 'SHASUMS256.txt'
  $extractPath = Join-Path $tempRoot 'extract'

  New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
  Write-Host "Downloading Node.js $version ($platform)..."
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBaseUrl/$archiveName" -OutFile $archivePath
  Invoke-WebRequest -UseBasicParsing -Uri "$releaseBaseUrl/SHASUMS256.txt" -OutFile $checksumPath

  $checksumText = Get-Content -Raw -Encoding ASCII $checksumPath
  $archivePattern = [Regex]::Escape($archiveName)
  $checksumMatch = [Regex]::Match($checksumText, "(?m)^([a-fA-F0-9]{64})\s+$archivePattern\s*$")
  if (-not $checksumMatch.Success) {
    throw "The official checksum for $archiveName was not found."
  }
  $expectedHash = $checksumMatch.Groups[1].Value.ToUpperInvariant()
  $actualHash = (Get-FileHash -Algorithm SHA256 -Path $archivePath).Hash.ToUpperInvariant()
  if ($actualHash -ne $expectedHash) {
    throw 'The downloaded Node.js archive failed SHA-256 verification.'
  }

  Write-Host 'Installing the verified portable runtime...'
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath -Force
  $sourcePath = Join-Path $extractPath ("node-$version-$platform")
  if (-not (Test-Path -LiteralPath (Join-Path $sourcePath 'node.exe') -PathType Leaf)) {
    throw 'node.exe was not found in the downloaded archive.'
  }

  New-Item -ItemType Directory -Force -Path $destinationPath | Out-Null
  Copy-Item -Path (Join-Path $sourcePath '*') -Destination $destinationPath -Recurse -Force
  $installedNode = Join-Path $destinationPath 'node.exe'
  & $installedNode --version
  if ($LASTEXITCODE -ne 0) {
    throw 'The portable Node.js runtime could not be started after installation.'
  }
  Write-Host "Portable Node.js is ready: $installedNode"
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
