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

## Security Notes
- URL imports are `HTTPS` only
- URL credentials and non-default HTTPS ports are blocked
- Private/internal hosts are blocked for URL imports
- CSP and safe DOM rendering patterns are enabled in the app
- Deploy CSP as an HTTP response header (recommended) and set `frame-ancestors 'none'` there (`frame-ancestors` is ignored in `<meta>` CSP)

## Repository Notes
- `vendor/` contains local third-party dependencies used by the app
- `.vscode/` is ignored and not tracked
