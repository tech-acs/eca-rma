# UNECA Rapid Mapping

Browser-based rapid mapping tool for loading, styling, filtering, and exporting geospatial data.

## Features
- Load data from local files (`.geojson`, `.zip`, `.csv`)
- Import datasets from public HTTPS URLs (`.geojson`, `.json`, `.csv`)
- Attribute-based thematic styling and class table editing
- Continent/country filtering
- Export outputs as PNG, PDF, and SVG

## Run
No build step is required.

1. Open `index.html` in a browser, or
2. Serve the folder with any static server.

## Data Limits
- Local upload size: `1 GB` per file
- Remote URL import size: `512 MB`
- Remote import timeout: `300 seconds`
- Maximum features per dataset: `1,000,000`
- Maximum vertices per dataset: `10,000,000`

## Browser Compatibility
- Recommended: latest stable versions of Microsoft Edge, Google Chrome, and Mozilla Firefox.
- Supported: Safari 16+ on macOS.
- Not supported: Internet Explorer and legacy, non-evergreen browsers.
- For best performance with large datasets, use a desktop browser with hardware acceleration enabled.

### Tested Export Matrix

Test baseline date: 2026-03-11 (latest stable browser channels).

| Browser | Rendering | PNG Export | PDF Export | SVG Export | Notes |
|---|---|---|---|---|---|
| Microsoft Edge (latest) | Supported | Supported | Supported | Supported | Recommended for large map exports. |
| Google Chrome (latest) | Supported | Supported | Supported | Supported | Recommended for large map exports. |
| Mozilla Firefox (latest) | Supported | Supported | Supported | Supported | Supported with good stability in normal dataset sizes. |
| Safari 16+ | Supported | Supported | Supported | Supported | Works, but can be more sensitive to cross-origin canvas constraints. |

Export reliability depends on data size and CORS:
- If remote tiles or images do not allow CORS, raster exports (PNG/PDF) can fail or be incomplete.
- SVG export is generally most resilient for vector-heavy outputs.
- Very large layers can exceed browser memory limits in any browser.

## Coordinate System
- Map display uses Leaflet default web map projection (Web Mercator, EPSG:3857) for tiled basemaps.
- Imported GeoJSON and CSV coordinates should be in WGS84 geographic coordinates (EPSG:4326), using decimal degrees.
- CSV files should provide latitude/longitude fields (for example: `lat` and `lon`, or `latitude` and `longitude`).
- If source data is in another CRS/projection, reproject it to EPSG:4326 before import.

## Security Notes
- URL imports are `HTTPS` only
- URL credentials and non-default HTTPS ports are blocked
- Private/internal hosts are blocked for URL imports
- CSP and safe DOM rendering patterns are enabled in the app
- Deploy CSP as an HTTP response header (recommended) and set `frame-ancestors 'none'` there (`frame-ancestors` is ignored in `<meta>` CSP)
- Vendor dependency integrity is pinned in `vendor-hashes.json`
- Additional deployment headers are defined in `web.config`: `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`, `Cross-Origin-Resource-Policy`, `Cache-Control`, and `Strict-Transport-Security`

### Security Verification
- Application and deployment control status is tracked in `SECURITY_CHECKLIST.md`.
- Verify vendor integrity locally:
	- `powershell -ExecutionPolicy Bypass -File .\scripts\verify-vendor-hashes.ps1`
- Regenerate vendor hash baseline after approved library updates:
	- `powershell -ExecutionPolicy Bypass -File .\scripts\generate-vendor-hashes.ps1`
- Verify deployed IIS response headers:
	- `powershell -ExecutionPolicy Bypass -File .\scripts\verify-security-headers.ps1 -Url https://<your-host>/`

### Control Mapping
- `SECURITY_CHECKLIST.md` IDs `1-14`: application-level controls.
- `SECURITY_CHECKLIST.md` IDs `15-24`: IIS/deployment headers and cache controls.

### Release Security Steps
1. Confirm local vendor integrity before packaging:
	- `powershell -ExecutionPolicy Bypass -File .\scripts\verify-vendor-hashes.ps1`
2. If approved vendor libraries changed, regenerate and review hash baseline:
	- `powershell -ExecutionPolicy Bypass -File .\scripts\generate-vendor-hashes.ps1`
3. Ensure IIS deployment includes `web.config` so security headers and cache controls are applied.
4. Deploy to the target HTTPS environment.
5. Validate deployed response headers:
	- `powershell -ExecutionPolicy Bypass -File .\scripts\verify-security-headers.ps1 -Url https://<your-host>/`
6. Update status/evidence in `SECURITY_CHECKLIST.md` for the release record.

## Repository Notes
- `vendor/` contains local third-party dependencies used by the app
- `.vscode/` is ignored and not tracked
