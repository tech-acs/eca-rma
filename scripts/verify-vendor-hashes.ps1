param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
)

$ErrorActionPreference = "Stop"

$vendorDir = Join-Path $RepoRoot "vendor"
$manifestPath = Join-Path $RepoRoot "vendor-hashes.json"

if (-not (Test-Path $vendorDir)) {
  throw "Vendor directory not found: $vendorDir"
}
if (-not (Test-Path $manifestPath)) {
  throw "Manifest not found: $manifestPath"
}

$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
if ($manifest.algorithm -ne "SHA256") {
  throw "Unsupported manifest algorithm: $($manifest.algorithm)"
}
if (-not $manifest.files) {
  throw "Manifest has no files section."
}

$rootPrefix = ($RepoRoot.TrimEnd('\') + '\')
$expected = @{}
$manifest.files.PSObject.Properties | ForEach-Object {
  $expected[$_.Name] = [string]$_.Value
}

$actual = @{}
Get-ChildItem -Path $vendorDir -File -Recurse |
  Sort-Object FullName |
  ForEach-Object {
    $hash = (Get-FileHash -Algorithm SHA256 -Path $_.FullName).Hash.ToLowerInvariant()
    $relativePath = $_.FullName.Substring($rootPrefix.Length).Replace('\', '/')
    $actual[$relativePath] = $hash
  }

$missing = @()
$mismatch = @()
$unexpected = @()

foreach ($path in $expected.Keys) {
  if (-not $actual.ContainsKey($path)) {
    $missing += $path
    continue
  }
  if ($actual[$path] -ne $expected[$path].ToLowerInvariant()) {
    $mismatch += "$path expected=$($expected[$path]) actual=$($actual[$path])"
  }
}

foreach ($path in $actual.Keys) {
  if (-not $expected.ContainsKey($path)) {
    $unexpected += $path
  }
}

if ($missing.Count -gt 0 -or $mismatch.Count -gt 0 -or $unexpected.Count -gt 0) {
  if ($missing.Count -gt 0) {
    Write-Host "Missing vendor files listed in manifest:"
    $missing | Sort-Object | ForEach-Object { Write-Host "  - $_" }
  }
  if ($mismatch.Count -gt 0) {
    Write-Host "Hash mismatches:"
    $mismatch | Sort-Object | ForEach-Object { Write-Host "  - $_" }
  }
  if ($unexpected.Count -gt 0) {
    Write-Host "Unexpected vendor files not listed in manifest:"
    $unexpected | Sort-Object | ForEach-Object { Write-Host "  - $_" }
  }
  throw "Vendor hash verification failed."
}

Write-Host "Vendor hash verification passed."
