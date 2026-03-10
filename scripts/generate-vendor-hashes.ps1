param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

$vendorDir = Join-Path $RepoRoot "vendor"
$manifestPath = Join-Path $RepoRoot "vendor-hashes.json"

if (-not (Test-Path $vendorDir)) {
  throw "Vendor directory not found: $vendorDir"
}

$rootPrefix = ($RepoRoot.TrimEnd('\') + '\')
$entries = @{}

Get-ChildItem -Path $vendorDir -File -Recurse |
  Sort-Object FullName |
  ForEach-Object {
    $hash = (Get-FileHash -Algorithm SHA256 -Path $_.FullName).Hash.ToLowerInvariant()
    $relativePath = $_.FullName.Substring($rootPrefix.Length).Replace('\', '/')
    $entries[$relativePath] = $hash
  }

$manifest = [ordered]@{
  algorithm = "SHA256"
  generatedAt = (Get-Date).ToString("yyyy-MM-dd")
  files = $entries
}

$json = $manifest | ConvertTo-Json -Depth 10
[System.IO.File]::WriteAllText($manifestPath, $json + [Environment]::NewLine, [System.Text.Encoding]::UTF8)
Write-Host "Wrote manifest:" $manifestPath
