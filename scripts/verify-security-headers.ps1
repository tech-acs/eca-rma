param(
  [Parameter(Mandatory = $true)]
  [string]$Url
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Result {
  param(
    [string]$Name,
    [bool]$Passed,
    [string]$Detail
  )
  $status = if ($Passed) { "PASS" } else { "FAIL" }
  Write-Host ("[{0}] {1} - {2}" -f $status, $Name, $Detail)
}

function Get-Headers {
  param([string]$TargetUrl)

  try {
    $resp = Invoke-WebRequest -Uri $TargetUrl -Method Head -MaximumRedirection 5 -UseBasicParsing
    return $resp.Headers
  } catch {
    # Fallback for servers that do not support HEAD cleanly.
    $resp = Invoke-WebRequest -Uri $TargetUrl -Method Get -MaximumRedirection 5 -UseBasicParsing
    return $resp.Headers
  }
}

$headers = Get-Headers -TargetUrl $Url

$requiredExact = @{
  "X-Frame-Options" = "DENY"
  "X-Content-Type-Options" = "nosniff"
  "Cross-Origin-Opener-Policy" = "same-origin"
  "Cross-Origin-Embedder-Policy" = "require-corp"
  "Cross-Origin-Resource-Policy" = "same-origin"
}

$requiredContains = @{
  "Content-Security-Policy" = @("frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'")
  "Referrer-Policy" = @("strict-origin-when-cross-origin")
  "Permissions-Policy" = @("geolocation=()", "microphone=()", "camera=()")
  "Cache-Control" = @("no-store", "no-cache")
}

$allPassed = $true

foreach ($name in $requiredExact.Keys) {
  $actual = [string]($headers[$name])
  $ok = -not [string]::IsNullOrWhiteSpace($actual) -and ($actual.Trim().ToLowerInvariant() -eq $requiredExact[$name].ToLowerInvariant())
  if (-not $ok) { $allPassed = $false }
  Write-Result -Name $name -Passed $ok -Detail ("expected='{0}' actual='{1}'" -f $requiredExact[$name], $actual)
}

foreach ($name in $requiredContains.Keys) {
  $actual = [string]($headers[$name])
  $missing = @()
  foreach ($token in $requiredContains[$name]) {
    if ($actual -notmatch [Regex]::Escape($token)) {
      $missing += $token
    }
  }
  $ok = -not [string]::IsNullOrWhiteSpace($actual) -and ($missing.Count -eq 0)
  if (-not $ok) { $allPassed = $false }
  $detail = if ($ok) {
    "required tokens present"
  } else {
    "missing tokens: " + ($missing -join ", ") + "; actual='" + $actual + "'"
  }
  Write-Result -Name $name -Passed $ok -Detail $detail
}

if ($allPassed) {
  Write-Host "\nAll required security headers validated successfully."
  exit 0
}

Write-Host "\nOne or more security header checks failed."
exit 1
