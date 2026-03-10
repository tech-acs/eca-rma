# Security Checklist Status

This file tracks implementation status for the UNECA Rapid Mapping security controls.
It is intended to be audit-friendly and deployment-safe.

## Application Controls

| ID | Control | Status | Evidence |
|---|---|---|---|
| 1 | HTTPS-only URL import | Complete | URL validation blocks non-HTTPS imports. |
| 2 | Block URL credentials and non-443 port | Complete | URL validation rejects credentials and non-default HTTPS ports. |
| 3 | Block private/local/intranet hosts | Complete | Host validation blocks localhost/private ranges and local-only hostnames. |
| 4 | Remote import timeout and max size cap | Complete | Timeout and byte cap enforced in remote import pipeline. |
| 5 | Local file max size cap | Complete | 1 GB local file cap enforced before processing. |
| 6 | Local file extension allowlist (.geojson, .csv, .zip) | Complete | Extension checks run before import. |
| 7 | Dataset complexity limits (max features/vertices) | Complete | Limits enforced before rendering/export processing. |
| 8 | Safe popup rendering (no HTML sink) | Complete | Popups and dynamic UI text use text-safe paths. |
| 9 | contenteditable handling as plain text | Complete | Paste converted to plain text and sanitized on blur. |
| 10 | Redirect re-validation for URL import | Complete | Redirect target is re-validated after fetch redirection. |
| 11 | Remove inline JS handlers | Complete | Event listeners are wired in app code (CSP-friendly). |
| 12 | ZIP bomb/decompression bomb guard | Complete | ZIP entries, uncompressed total, and expansion ratio are checked. |
| 13 | Vendor supply-chain integrity controls | Complete | Vendor checksums tracked in `vendor-hashes.json` and verified by script. |
| 14 | Strict MIME/content-type enforcement (remote GeoJSON/CSV) | Complete | Remote content-type checks are enforced before parsing. |

## IIS / Deployment Controls

| ID | Control | Status | Deployment Note |
|---|---|---|---|
| 15 | CSP header with `frame-ancestors 'none'` | Prepared | Defined in `web.config`; verify on deployed IIS endpoint. |
| 16 | `X-Frame-Options: DENY` | Prepared | Defined in `web.config`; verify as response header. |
| 17 | `X-Content-Type-Options: nosniff` | Prepared | Defined in `web.config`; verify as response header. |
| 18 | `Referrer-Policy` | Prepared | Defined in `web.config`; verify as response header. |
| 19 | Cache-control for sensitive exports/data | Prepared | `no-store/no-cache` policy and IIS static cache disable are set in `web.config`. |

## Verification Commands

- Vendor integrity:
  - `powershell -ExecutionPolicy Bypass -File .\scripts\verify-vendor-hashes.ps1`
- IIS response headers (after deployment):
  - `powershell -ExecutionPolicy Bypass -File .\scripts\verify-security-headers.ps1 -Url https://<your-host>/`
