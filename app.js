// --- Globals & Utilities ---
const MAX_SIZE = 1024 * 1024 * 1024; // 1 GB limit used in handlers
const MAX_FEATURES = 1000000;// adjust to device expectations
const MAX_VERTICES = 10000000; // total coordinate points across all features
const MAX_REMOTE_IMPORT_BYTES = 512 * 1024 * 1024; // 512 MB cap for URL imports
const REMOTE_IMPORT_TIMEOUT_MS = 300000; // 300s timeout for URL imports
const ENFORCE_IMPORT_HOST_ALLOWLIST = false;
const ALLOWED_IMPORT_HOSTS = new Set([
  "cdn.jsdelivr.net",
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
  "data.humdata.org"
]);
// Optional override list for trusted internal hosts when private-network blocking is enabled.
const ALLOWED_PRIVATE_IMPORT_HOSTS = new Set([]);
const WORLD_BOUNDARY_LOCAL_URL = null; // set a local file path if vendored
const WORLD_COUNTRIES_LOCAL_URL = null; // set a local file path if vendored
const WORLD_BOUNDARY_REMOTE_URL = "https://cdn.jsdelivr.net/gh/johan/world.geo.json@master/countries.geo.json";
const WORLD_COUNTRIES_REMOTE_URL = "https://cdn.jsdelivr.net/npm/world-countries@5.1.0/dist/countries.json";
// Minimal global state (kept intentionally small)
let overlayData = {};
let currentLayerName = null;
let geojsonData = null;
let geojsonLayer = null;
let layerGroup = null;
let numericUserColors = null;
let categoricalUserColors = null;
let currentAttribute = null;
let layerOrder = [];
let disclaimerUserPos = null;
let activeContinentField = null;
let activeCountryField = null;
let selectedContinentValues = new Set();
let selectedCountryValues = new Set();
let worldBoundaryIndex = null;
let worldBoundaryIndexPromise = null;
let worldCountriesByContinent = null;

// Best-effort clickjacking mitigation for static hosting where CSP headers
// may not be fully controllable at the web server layer.
const IS_FRAMED_CONTEXT = (() => {
  try { return window.top !== window.self; } catch (e) { return true; }
})();
if (IS_FRAMED_CONTEXT) {
  try { window.top.location = window.self.location.href; } catch (e) {}
  try {
    document.documentElement.innerHTML = "";
    document.documentElement.style.display = "none";
  } catch (e) {}
  throw new Error("Framed execution is blocked.");
}
// --- Helpers ---
function sanitizeId(str) {
  return String(str).replace(/[^\w\-]/g, "_");
}

function sanitizePlainText(value, fallback = "") {
  const clean = String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean || fallback;
}

function insertTextAtCaret(targetEl, text) {
  if (!targetEl) return;
  const safeText = sanitizePlainText(text);
  targetEl.focus();
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.rangeCount === 0) {
    targetEl.textContent = sanitizePlainText((targetEl.textContent || "") + " " + safeText);
    return;
  }
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const textNode = document.createTextNode(safeText);
  range.insertNode(textNode);
  range.setStartAfter(textNode);
  range.setEndAfter(textNode);
  sel.removeAllRanges();
  sel.addRange(range);
}

function stripKnownDataExtension(name) {
  return String(name || "").replace(/\.(geojson|zip|csv)$/i, "");
}

function humanizeLabel(value) {
  return sanitizePlainText(String(value || "").replace(/[_-]+/g, " "));
}

function sanitizeName(name) {
  const raw = String(name || "").split(/[\\/]/).pop() || "";
  const noExt = stripKnownDataExtension(raw);
  const human = humanizeLabel(noExt);
  const safe = sanitizePlainText(
    human
      .replace(/[^\w\s]/g, " ")
      .replace(/_/g, " ")
  );
  return safe || ("Layer " + Date.now());
}

function countVerticesInCoordinates(coords) {
  let total = 0;
  const walk = (node) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === "number" && typeof node[1] === "number") {
      total++;
      return;
    }
    node.forEach(walk);
  };
  walk(coords);
  return total;
}

function countVerticesInFeature(feature) {
  const geom = feature && feature.geometry;
  if (!geom || !geom.type) return 0;
  if (geom.type === "Point") return 1;
  return countVerticesInCoordinates(geom.coordinates);
}

function datasetBudgetStats(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const featureCount = features.length;
  let vertexCount = 0;
  for (let i = 0; i < features.length; i++) {
    vertexCount += countVerticesInFeature(features[i]);
  }
  return { featureCount, vertexCount };
}

function assertDatasetWithinLimits(geojson, sourceLabel = "dataset") {
  const stats = datasetBudgetStats(geojson);
  if (stats.featureCount > MAX_FEATURES) {
    throw new Error(`${sourceLabel} has too many features (${stats.featureCount}).`);
  }
  if (stats.vertexCount > MAX_VERTICES) {
    throw new Error(`${sourceLabel} is too complex (${stats.vertexCount} vertices).`);
  }
  return stats;
}

function isNearDatasetLimits(stats) {
  if (!stats) return false;
  const featureRatio = MAX_FEATURES > 0 ? (stats.featureCount / MAX_FEATURES) : 0;
  const vertexRatio = MAX_VERTICES > 0 ? (stats.vertexCount / MAX_VERTICES) : 0;
  return featureRatio >= 0.8 || vertexRatio >= 0.8;
}

async function confirmLargeDatasetLoad(stats, sourceLabel = "Dataset") {
  if (!isNearDatasetLimits(stats)) return true;
  const featurePct = Math.round((stats.featureCount / MAX_FEATURES) * 100);
  const vertexPct = Math.round((stats.vertexCount / MAX_VERTICES) * 100);
  const message =
    `${sourceLabel} is large and may slow or freeze your browser.\n\n` +
    `Features: ${stats.featureCount} (${featurePct}% of limit ${MAX_FEATURES})\n` +
    `Vertices: ${stats.vertexCount} (${vertexPct}% of limit ${MAX_VERTICES})\n\n` +
    `Continue loading this layer?`;
  return window.confirm(message);
}

async function fetchJsonWithLimits(url, label) {
  const fetched = await fetchWithLimits(url);
  try {
    return JSON.parse(fetched.text || "");
  } catch (e) {
    throw new Error(`Invalid JSON from ${label}.`);
  }
}

async function fetchJsonWithFallback(localUrl, remoteUrl, label) {
  if (!localUrl && remoteUrl) {
    return fetchJsonWithLimits(remoteUrl, `${label} (remote)`);
  }
  try {
    return await fetchJsonWithLimits(localUrl, `${label} (local)`);
  } catch (localErr) {
    if (!remoteUrl) {
      throw localErr;
    }
    return fetchJsonWithLimits(remoteUrl, `${label} (remote)`);
  }
}

function validateImportUrl(rawUrl) {
  if (!rawUrl) throw new Error("Enter a valid URL");
  const parsed = new URL(rawUrl);
  const host = normalizeHostname(parsed.hostname);
  if (parsed.protocol !== "https:") {
    throw new Error("Only HTTPS URLs are allowed.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URL credentials are not allowed.");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error("Only default HTTPS port is allowed.");
  }
  if (isBlockedPrivateImportHost(host)) {
    throw new Error("Private/internal hosts are blocked by security policy.");
  }
  if (ENFORCE_IMPORT_HOST_ALLOWLIST && !ALLOWED_IMPORT_HOSTS.has(host)) {
    throw new Error("URL host is not allowed by security policy.");
  }
  const ext = parsed.pathname.slice(parsed.pathname.lastIndexOf('.')).toLowerCase();
  if (![".csv", ".geojson", ".json"].includes(ext)) {
    throw new Error("Only .csv, .geojson, or .json URLs are allowed.");
  }
  return { parsed, ext };
}

function isIpv4Address(hostname) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
}

function normalizeHostname(hostname) {
  let h = String(hostname || "").toLowerCase().trim();
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

function isPrivateOrLocalIpv4(hostname) {
  if (!isIpv4Address(hostname)) return false;
  const parts = hostname.split(".").map(n => Number(n));
  if (parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 0) return true; // invalid/self-identification range
  return false;
}

function normalizeIpv6Host(hostname) {
  return String(hostname || "").toLowerCase().trim();
}

function isLocalOrPrivateIpv6(hostname) {
  const h = normalizeIpv6Host(hostname);
  if (!h.includes(":")) return false;
  if (h === "::1") return true; // loopback
  if (h.startsWith("fe80:")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique local
  return false;
}

function isLikelyInternalHostname(hostname) {
  const h = normalizeHostname(hostname);
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".corp")) return true;
  // Single-label hostnames (e.g., "intranet") are usually internal DNS names.
  if (!h.includes(".") && !h.includes(":")) return true;
  return false;
}

function isPotentialRebindingDomain(hostname) {
  const h = normalizeHostname(hostname);
  return h.endsWith(".nip.io") || h.endsWith(".xip.io") || h.endsWith(".sslip.io");
}

function isBlockedPrivateImportHost(hostname) {
  const h = normalizeHostname(hostname);
  if (ALLOWED_PRIVATE_IMPORT_HOSTS.has(h)) return false;
  if (isPrivateOrLocalIpv4(h)) return true;
  if (isLocalOrPrivateIpv6(h)) return true;
  if (isLikelyInternalHostname(h)) return true;
  if (isPotentialRebindingDomain(h)) return true;
  return false;
}

async function fetchWithLimits(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_IMPORT_TIMEOUT_MS);
  const maxRemoteMb = Math.round(MAX_REMOTE_IMPORT_BYTES / (1024 * 1024));
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "Accept": "*/*" },
      mode: "cors",
      credentials: "omit",
      signal: controller.signal
    });

    if (!response.ok) throw new Error("Network error: " + response.status);

    const contentLenHeader = response.headers.get("Content-Length");
    const contentLen = contentLenHeader ? Number(contentLenHeader) : 0;
    if (contentLen && contentLen > MAX_REMOTE_IMPORT_BYTES) {
      throw new Error(`Remote file too large (max ${maxRemoteMb} MB).`);
    }

    if (!response.body || typeof response.body.getReader !== "function") {
      const textFallback = await response.text();
      if (textFallback.length > MAX_REMOTE_IMPORT_BYTES) {
        throw new Error(`Remote file too large (max ${maxRemoteMb} MB).`);
      }
      return { text: textFallback, contentType: response.headers.get("Content-Type") || "" };
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > MAX_REMOTE_IMPORT_BYTES) {
        try { reader.cancel(); } catch (e) {}
        throw new Error(`Remote file too large (max ${maxRemoteMb} MB).`);
      }
      chunks.push(value);
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    chunks.forEach(c => { merged.set(c, offset); offset += c.length; });
    const text = new TextDecoder("utf-8").decode(merged);
    return { text, contentType: response.headers.get("Content-Type") || "" };
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new Error("Remote request timed out.");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function initializeMapTitleFromLayer(layerName) {
  const el = document.getElementById("map-title");
  if (!el) return;
  const current = sanitizePlainText(el.textContent, "");
  const isDefault = !current || /^custom map title$/i.test(current);
  if (isDefault) {
    el.textContent = sanitizePlainText(layerName, "Custom Map Title");
  }
}

function trackLayerOrder(layerName) {
  const name = sanitizePlainText(layerName);
  layerOrder = layerOrder.filter(n => n !== name);
  layerOrder.unshift(name); // latest on top
}

function getOrderedLayerNames() {
  const existing = new Set(Object.keys(overlayData));
  const ordered = layerOrder.filter(n => existing.has(n));
  const leftovers = Object.keys(overlayData).filter(n => !ordered.includes(n));
  return ordered.concat(leftovers);
}

function applyLayerStackOrder() {
  // Re-apply z-order so list order controls visual stacking on map.
  ensureBaseLayerAtBack();
  const ordered = getOrderedLayerNames(); // first = top
  for (let i = ordered.length - 1; i >= 0; i--) {
    const name = ordered[i];
    const group = overlayData[name] && overlayData[name].layerGroup;
    if (!group || typeof group.eachLayer !== 'function') continue;
    group.eachLayer(layer => {
      if (layer && typeof layer.bringToFront === 'function') {
        try { layer.bringToFront(); } catch (e) {}
      }
      if (layer && typeof layer.setZIndexOffset === 'function') {
        try { layer.setZIndexOffset(1000 + i); } catch (e) {}
      }
    });
  }
  ensureBaseLayerAtBack();
}

function reorderLegendBlocks() {
  const legendRoot = document.getElementById('legend-items');
  if (!legendRoot) return;
  const ordered = getOrderedLayerNames(); // first = top
  ordered.forEach(name => {
    const block = document.getElementById('legend-' + sanitizeId(name));
    if (block) legendRoot.appendChild(block);
  });
}

function moveLayerOrder(name, direction) {
  const ordered = getOrderedLayerNames();
  const idx = ordered.indexOf(name);
  if (idx < 0) return;

  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= ordered.length) return;

  const tmp = ordered[idx];
  ordered[idx] = ordered[swapIdx];
  ordered[swapIdx] = tmp;

  layerOrder = ordered.slice();
  reorderLayersControlUI();
  refreshLayerSelector();
  applyLayerStackOrder();
  reorderLegendBlocks();
}

function getLayerNameFromLabel(labelEl) {
  if (!labelEl) return "";
  if (labelEl.dataset && labelEl.dataset.layerName) {
    return sanitizePlainText(labelEl.dataset.layerName);
  }
  const textSpan = labelEl.querySelector('span:not(.layer-reorder-controls)');
  if (textSpan) return sanitizePlainText(textSpan.textContent);
  const clone = labelEl.cloneNode(true);
  clone.querySelectorAll('.layer-reorder-controls').forEach(el => el.remove());
  return sanitizePlainText(clone.textContent);
}

function decorateLayerOrderControls() {
  const controlContainer = layersControl && layersControl.getContainer ? layersControl.getContainer() : null;
  if (!controlContainer) return;
  const overlays = controlContainer.querySelector('.leaflet-control-layers-overlays');
  if (!overlays) return;

  const labels = Array.from(overlays.querySelectorAll('label'));
  labels.forEach(lbl => {
    const layerName = getLayerNameFromLabel(lbl);
    if (!layerName) return;
    lbl.dataset.layerName = layerName;
    if (lbl.querySelector('.layer-reorder-controls')) return;

    lbl.classList.add('layer-row-with-controls');
    const controls = document.createElement('span');
    controls.className = 'layer-reorder-controls';

    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'layer-reorder-btn';
    upBtn.title = 'Move layer up';
    upBtn.textContent = '^';
    upBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      moveLayerOrder(layerName, -1);
    });

    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'layer-reorder-btn';
    downBtn.title = 'Move layer down';
    downBtn.textContent = 'v';
    downBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      moveLayerOrder(layerName, +1);
    });

    controls.append(upBtn, downBtn);
    lbl.appendChild(controls);
  });
}

function reorderLayersControlUI() {
  const controlContainer = layersControl && layersControl.getContainer ? layersControl.getContainer() : null;
  if (!controlContainer) return;
  const overlays = controlContainer.querySelector('.leaflet-control-layers-overlays');
  if (!overlays) return;

  const labels = Array.from(overlays.querySelectorAll('label'));
  const orderedNames = getOrderedLayerNames();
  for (let i = orderedNames.length - 1; i >= 0; i--) {
    const target = sanitizePlainText(orderedNames[i]);
    const match = labels.find(lbl => getLayerNameFromLabel(lbl) === target);
    if (match) overlays.prepend(match);
  }
  ensureBaseLayerListedLastInControl();
  decorateLayerOrderControls();
  reorderLegendBlocks();
}

function ensureBaseLayerListedLastInControl() {
  const controlContainer = layersControl && layersControl.getContainer ? layersControl.getContainer() : null;
  if (!controlContainer) return;

  const list = controlContainer.querySelector('.leaflet-control-layers-list');
  const overlays = controlContainer.querySelector('.leaflet-control-layers-overlays');
  const base = controlContainer.querySelector('.leaflet-control-layers-base');
  const sep = controlContainer.querySelector('.leaflet-control-layers-separator');

  if (!list || !overlays || !base) return;

  // Force visual order: overlays first, base layers last.
  list.appendChild(overlays);
  if (sep) list.appendChild(sep);
  list.appendChild(base);
}

function showRow(id) {
  const el = document.getElementById(id);
  if (el) {
    el.style.display = 'block';
  } else {
    console.warn(`showRow: element not found: ${id}`);
  }
}

function hideRow(id) {
  const el = document.getElementById(id);
  if (el) {
    el.style.display = 'none';
  } else {
    console.warn(`hideRow: element not found: ${id}`);
  }
}

function formatNumber(val, decimals = 2) {
  const num = Number(val);
  if (isNaN(num)) return "NaN";
  return num.toFixed(decimals);
}

function norm(v) {
  return String(v == null ? "" : v).trim().toLowerCase();
}

function normKey(v) {
  return String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getKeyByCandidates(props, candidates) {
  const keys = Object.keys(props || {});
  const keyMap = new Map(keys.map(k => [normKey(k), k]));
  for (const c of candidates) {
    const nc = normKey(c);
    if (keyMap.has(nc)) return keyMap.get(nc);
  }
  // Fuzzy fallback for variants like "Country Name" vs "country_name".
  for (const k of keys) {
    const nk = normKey(k);
    for (const c of candidates) {
      const nc = normKey(c);
      if (!nc || nc.length < 5) continue;
      if (nk.includes(nc) || nc.includes(nk)) return k;
    }
  }
  return null;
}

function getKeyByCandidatesFromFeatures(features, candidates) {
  const keyMap = new Map();
  (features || []).slice(0, 50).forEach(f => {
    const props = f?.properties || {};
    Object.keys(props).forEach(k => {
      const nk = normKey(k);
      if (!keyMap.has(nk)) keyMap.set(nk, k);
    });
  });
  for (const c of candidates) {
    const hit = keyMap.get(normKey(c));
    if (hit) return hit;
  }
  // Fuzzy fallback across sampled keys.
  const sampledKeys = Array.from(keyMap.values());
  for (const k of sampledKeys) {
    const nk = normKey(k);
    for (const c of candidates) {
      const nc = normKey(c);
      if (!nc || nc.length < 5) continue;
      if (nk.includes(nc) || nc.includes(nk)) return k;
    }
  }
  return null;
}

function inferContinentKeyFromValues(features) {
  const feats = (features || []).slice(0, 400);
  if (!feats.length) return null;
  const codeTokens = new Set(["af", "afr", "as", "asi", "eu", "eur", "na", "nam", "sa", "sam", "oc", "oce", "an", "ant"]);
  const nameTokens = ["africa", "asia", "europe", "north america", "south america", "oceania", "antarctica", "americas"];
  const stats = new Map();
  feats.forEach(f => {
    const props = f?.properties || {};
    Object.entries(props).forEach(([k, v]) => {
      const val = norm(v);
      if (!val) return;
      if (!stats.has(k)) stats.set(k, { knownHits: 0, stringCount: 0 });
      const s = stats.get(k);
      s.stringCount += 1;
      const nk = normKey(val);
      const hit = codeTokens.has(nk) || nameTokens.some(t => nk.includes(normKey(t)));
      if (hit) s.knownHits += 1;
    });
  });
  let bestKey = null;
  let bestHits = 0;
  stats.forEach((s, k) => {
    if (s.knownHits > bestHits) {
      bestHits = s.knownHits;
      bestKey = k;
    }
  });
  return bestHits >= 2 ? bestKey : null;
}

function continentLabel(raw) {
  const nk = normKey(raw);
  if (nk === "af" || nk === "afr" || nk.includes("africa")) return "Africa";
  if (nk === "as" || nk === "asi" || nk === "asia") return "Asia";
  if (nk === "eu" || nk === "eur" || nk === "europe") return "Europe";
  if (nk === "na" || nk === "namerica" || nk.includes("northamerica")) return "North America";
  if (nk === "sa" || nk === "samerica" || nk.includes("southamerica")) return "South America";
  if (nk === "oc" || nk === "oce" || nk.includes("oceania")) return "Oceania";
  if (nk === "an" || nk.includes("antarctica")) return "Antarctica";
  return sanitizePlainText(raw);
}

function isAfricaContinentValue(raw) {
  const nk = normKey(raw);
  return nk === "af" || nk === "afr" || nk.includes("africa");
}

function getFeatureSampleCoord(feature) {
  const g = feature?.geometry;
  if (!g || !g.type || !g.coordinates) return null;
  if (g.type === "Point") return g.coordinates;
  if (g.type === "MultiPoint" && g.coordinates[0]) return g.coordinates[0];
  if (g.type === "LineString" && g.coordinates[0]) return g.coordinates[0];
  if (g.type === "MultiLineString" && g.coordinates[0] && g.coordinates[0][0]) return g.coordinates[0][0];
  if (g.type === "Polygon" && g.coordinates[0] && g.coordinates[0][0]) return g.coordinates[0][0];
  if (g.type === "MultiPolygon" && g.coordinates[0] && g.coordinates[0][0] && g.coordinates[0][0][0]) return g.coordinates[0][0][0];
  return null;
}

function normalizeCountryName(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]/g, "");
}

function normalizeContinentFromMeta(region, subregion) {
  const r = sanitizePlainText(region || "");
  const s = sanitizePlainText(subregion || "");
  if (!r) return "";
  if (/^americas$/i.test(r)) {
    if (/south/i.test(s)) return "South America";
    return "North America";
  }
  if (/^africa$/i.test(r)) return "Africa";
  if (/^asia$/i.test(r)) return "Asia";
  if (/^europe$/i.test(r)) return "Europe";
  if (/^oceania$/i.test(r)) return "Oceania";
  if (/^antarctic/i.test(r)) return "Antarctica";
  return r;
}

function bboxFromCoordinates(coords) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      const x = Number(c[0]);
      const y = Number(c[1]);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      return;
    }
    c.forEach(walk);
  };
  walk(coords);
  if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) return null;
  return [minX, minY, maxX, maxY];
}

function pointInRing(point, ring) {
  const x = point[0];
  const y = point[1];
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygonCoordinates(point, polygonCoords) {
  if (!Array.isArray(polygonCoords) || !polygonCoords.length) return false;
  if (!pointInRing(point, polygonCoords[0])) return false;
  for (let i = 1; i < polygonCoords.length; i++) {
    if (pointInRing(point, polygonCoords[i])) return false;
  }
  return true;
}

function pointInGeometry(point, geom) {
  if (!geom || !geom.type || !geom.coordinates) return false;
  if (geom.type === "Polygon") return pointInPolygonCoordinates(point, geom.coordinates);
  if (geom.type === "MultiPolygon") {
    return geom.coordinates.some(poly => pointInPolygonCoordinates(point, poly));
  }
  return false;
}

function guessContinentFromCountryName(countryName) {
  const n = normalizeCountryName(countryName);
  const direct = {
    westernsahara: "Africa",
    ivorycoast: "Africa",
    czechia: "Europe",
    russia: "Europe",
    kosovo: "Europe"
  };
  return direct[n] || null;
}

async function loadWorldBoundaryIndex() {
  if (worldBoundaryIndex) return worldBoundaryIndex;
  if (worldBoundaryIndexPromise) return worldBoundaryIndexPromise;

  worldBoundaryIndexPromise = (async () => {
    const [boundaryGeojson, meta] = await Promise.all([
      fetchJsonWithFallback(WORLD_BOUNDARY_LOCAL_URL, WORLD_BOUNDARY_REMOTE_URL, "world boundaries"),
      fetchJsonWithFallback(WORLD_COUNTRIES_LOCAL_URL, WORLD_COUNTRIES_REMOTE_URL, "world country metadata")
    ]);
    if (!Array.isArray(boundaryGeojson?.features)) {
      throw new Error("World boundaries payload is invalid.");
    }
    if (!Array.isArray(meta)) {
      throw new Error("World country metadata payload is invalid.");
    }

    const continentByCountryNorm = new Map();
    const countriesByContinentMeta = new Map();
    (Array.isArray(meta) ? meta : []).forEach(c => {
      const region = normalizeContinentFromMeta(c?.region, c?.subregion);
      if (!region) return;
      const add = (nm) => {
        const k = normalizeCountryName(nm);
        if (k) continentByCountryNorm.set(k, region);
      };
      const addToContinent = (nm) => {
        const clean = sanitizePlainText(nm || "");
        if (!clean) return;
        if (!countriesByContinentMeta.has(region)) countriesByContinentMeta.set(region, new Set());
        countriesByContinentMeta.get(region).add(clean);
      };
      add(c?.name?.common);
      add(c?.name?.official);
      (Array.isArray(c?.altSpellings) ? c.altSpellings : []).forEach(add);
      addToContinent(c?.name?.common);
    });

    const feats = Array.isArray(boundaryGeojson?.features) ? boundaryGeojson.features : [];
    worldBoundaryIndex = feats.map(f => {
      const country = sanitizePlainText(f?.properties?.name || "");
      const key = normalizeCountryName(country);
      const continent = continentByCountryNorm.get(key) || guessContinentFromCountryName(country);
      return {
        country,
        continent,
        bbox: bboxFromCoordinates(f?.geometry?.coordinates),
        geometry: f?.geometry || null
      };
    }).filter(x => x.country && x.bbox && x.geometry);

    worldCountriesByContinent = new Map();
    // Start from metadata to ensure complete country lists per continent.
    countriesByContinentMeta.forEach((set, cont) => {
      worldCountriesByContinent.set(cont, new Set(set));
    });
    // Merge countries derived from boundary features (for name compatibility with hit-testing).
    worldBoundaryIndex.forEach(entry => {
      const cont = sanitizePlainText(entry.continent || "");
      if (!cont) return;
      if (!worldCountriesByContinent.has(cont)) worldCountriesByContinent.set(cont, new Set());
      worldCountriesByContinent.get(cont).add(entry.country);
    });

    return worldBoundaryIndex;
  })().catch(err => {
    worldBoundaryIndexPromise = null;
    throw err;
  });

  return worldBoundaryIndexPromise;
}

async function ensureSpatialCountryContinentFields(data) {
  const feats = Array.isArray(data?.features) ? data.features : [];
  if (!feats.length) return false;
  const boundaryIndex = await loadWorldBoundaryIndex();
  if (!Array.isArray(boundaryIndex) || !boundaryIndex.length) return false;

  let tagged = 0;
  feats.forEach(f => {
    if (!f.properties) f.properties = {};
    if (f.properties.__rma_country && f.properties.__rma_continent_spatial) return;
    const coord = getFeatureSampleCoord(f);
    if (!Array.isArray(coord) || coord.length < 2) return;
    const x = Number(coord[0]);
    const y = Number(coord[1]);
    if (isNaN(x) || isNaN(y)) return;

    const candidates = boundaryIndex.filter(b =>
      x >= b.bbox[0] && x <= b.bbox[2] && y >= b.bbox[1] && y <= b.bbox[3]
    );
    const hit = candidates.find(c => pointInGeometry([x, y], c.geometry));
    if (!hit) return;

    f.properties.__rma_country = hit.country;
    if (hit.continent) f.properties.__rma_continent_spatial = hit.continent;
    tagged++;
  });

  return tagged > 0;
}

function inferContinentFromCoord(coord) {
  if (!Array.isArray(coord) || coord.length < 2) return null;
  const lon = Number(coord[0]);
  const lat = Number(coord[1]);
  if (isNaN(lon) || isNaN(lat)) return null;
  if (lat < -60) return "Antarctica";
  if (lat >= -37 && lat <= 38 && lon >= -20 && lon <= 55) return "Africa";
  if (lat >= 8 && lat <= 84 && lon >= -170 && lon <= -20) return "North America";
  if (lat >= -56 && lat <= 15 && lon >= -95 && lon <= -30) return "South America";
  if (lat >= 35 && lat <= 72 && lon >= -25 && lon <= 60) return "Europe";
  if (lat >= -10 && lat <= 82 && lon >= 25 && lon <= 180) return "Asia";
  if (lat >= -50 && lat <= 15 && lon >= 110 && lon <= 180) return "Oceania";
  return null;
}

function ensureSyntheticContinentField(data) {
  const feats = Array.isArray(data?.features) ? data.features : [];
  if (!feats.length) return null;
  const field = "__rma_continent";
  let inferredCount = 0;
  feats.forEach(f => {
    if (!f.properties) f.properties = {};
    const coord = getFeatureSampleCoord(f);
    const inferred = inferContinentFromCoord(coord);
    if (inferred) {
      f.properties[field] = inferred;
      inferredCount++;
    }
  });
  return inferredCount > 0 ? field : null;
}

function inferCountryKeyFromValues(features, excludeKey) {
  const feats = (features || []).slice(0, 500);
  if (!feats.length) return null;
  const badKeys = new Set(["lat", "latitude", "lon", "lng", "longitude", "x", "y", "fid", "id", "objectid"]);
  const stats = new Map();
  feats.forEach(f => {
    const props = f?.properties || {};
    Object.entries(props).forEach(([k, v]) => {
      if (excludeKey && norm(k) === norm(excludeKey)) return;
      if (badKeys.has(norm(k))) return;
      const sv = String(v == null ? "" : v).trim();
      if (!sv) return;
      if (!isNaN(Number(sv))) return; // skip numeric-like columns
      if (!stats.has(k)) stats.set(k, new Set());
      stats.get(k).add(sv);
    });
  });
  let bestKey = null;
  let bestUnique = 0;
  stats.forEach((set, k) => {
    const count = set.size;
    if (count > bestUnique) {
      bestUnique = count;
      bestKey = k;
    }
  });
  return bestUnique >= 8 ? bestKey : null;
}

function uniqueValuesForKey(features, key) {
  if (!key) return [];
  const set = new Set();
  (features || []).forEach(f => {
    const v = f && f.properties ? f.properties[key] : null;
    if (v != null && String(v).trim() !== "") set.add(String(v).trim());
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function detectFilterFields(data) {
  const features = Array.isArray(data?.features) ? data.features : [];
  const continentCandidates = [
    "continent", "cont", "region", "world_region", "continent_name", "region_un", "un_region",
    "continente", "ctn", "wb_region", "continentname", "cont_name", "contcd", "continentcode"
  ];
  const countryCandidates = [
    "country", "country_name", "name", "name_en", "name_long", "admin", "adm0_name",
    "sovereignt", "sovereign", "cntry_name", "country_na", "formal_en", "country_en",
    "name_0", "admin0name", "countryaff", "geounit", "brk_name", "name_short",
    "countryname", "country_name_en"
  ];
  const sample = features[0]?.properties || {};
  const continentKey =
    getKeyByCandidatesFromFeatures(features, continentCandidates) ||
    getKeyByCandidates(sample, continentCandidates) ||
    inferContinentKeyFromValues(features);
  const countryKey =
    getKeyByCandidatesFromFeatures(features, countryCandidates) ||
    getKeyByCandidates(sample, countryCandidates) ||
    inferCountryKeyFromValues(features, continentKey);

  return {
    continentKey,
    countryKey
  };
}

function getFilteredFeatures(data) {
  const feats = Array.isArray(data?.features) ? data.features : [];
  return feats.filter(f => {
    const props = f?.properties || {};
    if (activeContinentField && selectedContinentValues.size > 0) {
      const continentNorm = norm(props[activeContinentField]);
      const ok = Array.from(selectedContinentValues).some(v => norm(v) === continentNorm);
      if (!ok) return false;
    }
    if (activeCountryField && selectedCountryValues.size > 0) {
      const countryNorm = norm(props[activeCountryField]);
      const ok = Array.from(selectedCountryValues).some(v => norm(v) === countryNorm);
      if (!ok) return false;
    }
    return true;
  });
}

function getFilteredGeojson(data) {
  return { ...(data || {}), features: getFilteredFeatures(data) };
}
// Add a Secure Popup Binding
function bindFeaturePopup(feature, layer) {
  if (feature.properties) {
    // Build safe popup content
    const content = Object.keys(feature.properties)
      .map(k => `${k}: ${feature.properties[k]}`)
      .join("\n");

    // Use textContent inside a <pre> for safety
    const div = document.createElement("div");
    div.style.whiteSpace = "pre-wrap";
    div.textContent = content;

    layer.bindPopup(div);
  }
}

//TextDecoder Patch
// --- Monkey-patch TextDecoder to sanitize encoding labels (kept once) ---
(function() {
  const OriginalTextDecoder = window.TextDecoder;
  window.TextDecoder = function(label, options) {
    let cleanLabel = "utf-8";
    if (label && typeof label === "string") {
      cleanLabel = label.split(/[, ]/)[0].trim().toLowerCase();
      try {
        return new OriginalTextDecoder(cleanLabel, options);
      } catch (e) {
        console.warn("Invalid encoding label:", label, "→ defaulting to UTF-8");
        return new OriginalTextDecoder("utf-8", options);
      }
    }
    return new OriginalTextDecoder(cleanLabel, options);
  };
})();
//Map Initialization and Controls
// Use explicit local marker icon URLs from vendor/images.
// Prevent Leaflet from prefixing detected imagePath onto explicit icon URLs.
delete L.Icon.Default.prototype._getIconUrl;
const DEFAULT_MARKER_ICON_URLS = {
  iconRetinaUrl: new URL("vendor/images/marker-icon-2x.png", window.location.href).href,
  iconUrl: new URL("vendor/images/marker-icon.png", window.location.href).href,
  shadowUrl: new URL("vendor/images/marker-shadow.png", window.location.href).href
};
L.Icon.Default.mergeOptions({
  iconRetinaUrl: DEFAULT_MARKER_ICON_URLS.iconRetinaUrl,
  iconUrl: DEFAULT_MARKER_ICON_URLS.iconUrl,
  shadowUrl: DEFAULT_MARKER_ICON_URLS.shadowUrl
});

// --- Initialize Leaflet Map ---
const map = L.map('map', {
  preferCanvas: true,
  attributionControl: true,
  zoomAnimation: false,
  fadeAnimation: false,
  markerZoomAnimation: false,
  zoomSnap: 0.1,
  zoomDelta: 0.1
});

// Deterministic startup/home view centered on Africa.
// Keep west/east span wide enough for Cape Verde and Mauritius, while
// tightening vertical fit a bit so the map starts slightly more zoomed in.
const INITIAL_HOME_CENTER = [0, 17];
const INITIAL_HOME_ZOOM = 3;
const INITIAL_HOME_BOUNDS = L.latLngBounds([[-36, -26], [38.5, 60]]);
const MAP_NAV_BOUNDS = L.latLngBounds([[-85, -180], [85, 180]]);

function applyHomeView() {
  if (INITIAL_HOME_BOUNDS && typeof map.fitBounds === "function") {
    map.fitBounds(INITIAL_HOME_BOUNDS, {
      animate: false,
      // Keep horizontal padding to preserve edge islands, trim vertical
      // padding to achieve a slightly closer initial view.
      paddingTopLeft: [20, 10],
      paddingBottomRight: [20, 10],
      maxZoom: 3.6
    });
  } else {
    map.setView(INITIAL_HOME_CENTER, INITIAL_HOME_ZOOM, { animate: false });
  }
  map.panBy([0, 10], { animate: false });
  map.panInsideBounds(MAP_NAV_BOUNDS, { animate: false });
}

function syncLayoutWithHeaderHeight() {
  const header = document.querySelector('header.fixed-top');
  if (!header || !document.documentElement) return;
  const headerHeight = Math.max(0, Math.ceil(header.getBoundingClientRect().height));
  if (!headerHeight) return;
  document.documentElement.style.setProperty('--app-header-height', `${headerHeight}px`);
  if (map && typeof map.invalidateSize === "function") {
    setTimeout(() => map.invalidateSize({ pan: false }), 0);
  }
}

applyHomeView();
map.setMaxBounds(MAP_NAV_BOUNDS);
map.options.maxBoundsViscosity = 1.0;

function goHomeView() {
  applyHomeView();
}

function fitToLayerExtent(layer) {
  if (!layer || typeof layer.getBounds !== "function") return false;
  const bounds = layer.getBounds();
  if (!bounds || typeof bounds.isValid !== "function" || !bounds.isValid()) return false;
  map.fitBounds(bounds, { padding: [20, 20] });
  map.panBy([0, 10], { animate: false });
  map.panInsideBounds(MAP_NAV_BOUNDS, { animate: false });
  return true;
}

const HomeControl = L.Control.extend({
  options: { position: 'topleft' },
  onAdd: function() {
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-home');
    const link = L.DomUtil.create('a', 'leaflet-control-home-btn', container);
    link.href = '#';
    link.title = 'Home view';
    link.setAttribute('aria-label', 'Home view');
    link.textContent = '⌂';
    // Inline style to avoid stylesheet caching issues.
    link.style.display = 'block';
    link.style.width = '30px';
    link.style.height = '30px';
    link.style.lineHeight = '30px';
    link.style.textAlign = 'center';
    link.style.fontSize = '18px';
    link.style.fontWeight = '700';
    link.style.background = '#ffffff';
    link.style.color = '#1E90FF';
    link.style.textDecoration = 'none';
    L.DomEvent.on(link, 'click', L.DomEvent.stop)
      .on(link, 'click', () => goHomeView());
    return container;
  }
});
const homeControl = new HomeControl();
map.addControl(homeControl);
// Force the Home control below zoom buttons.
setTimeout(() => {
  const zoomControl = map.zoomControl && map.zoomControl.getContainer ? map.zoomControl.getContainer() : null;
  const homeContainer = homeControl && homeControl.getContainer ? homeControl.getContainer() : null;
  if (!zoomControl || !homeContainer || !zoomControl.parentNode) return;
  homeContainer.style.marginTop = '8px';
  zoomControl.parentNode.insertBefore(homeContainer, zoomControl.nextSibling);
}, 0);

function makeControlDraggable(control, initial) {
  if (!control || typeof control.getContainer !== "function") return;
  const el = control.getContainer();
  const mapEl = map.getContainer();
  if (!el || !mapEl) return;

  // Move to map root so the control can be freely positioned.
  mapEl.appendChild(el);
  el.classList.add("draggable-map-control");
  const initialPos = typeof initial === "function" ? initial(el, mapEl) : initial;
  el.style.left = `${Math.max(0, Math.round(initialPos.left || 0))}px`;
  el.style.top = `${Math.max(0, Math.round(initialPos.top || 0))}px`;
  el.style.right = "auto";
  el.style.bottom = "auto";

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let baseLeft = 0;
  let baseTop = 0;

  const onPointerMove = (evt) => {
    if (!dragging) return;
    const rect = mapEl.getBoundingClientRect();
    const dx = evt.clientX - startX;
    const dy = evt.clientY - startY;
    const maxLeft = Math.max(0, rect.width - el.offsetWidth);
    const maxTop = Math.max(0, rect.height - el.offsetHeight);
    const nextLeft = Math.max(0, Math.min(maxLeft, baseLeft + dx));
    const nextTop = Math.max(0, Math.min(maxTop, baseTop + dy));
    el.style.left = `${nextLeft}px`;
    el.style.top = `${nextTop}px`;
  };

  const stopDrag = () => {
    dragging = false;
    map.dragging.enable();
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopDrag);
  };

  el.addEventListener("pointerdown", (evt) => {
    if (evt.button !== 0) return;
    evt.preventDefault();
    dragging = true;
    startX = evt.clientX;
    startY = evt.clientY;
    baseLeft = parseFloat(el.style.left) || 0;
    baseTop = parseFloat(el.style.top) || 0;
    map.dragging.disable();
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDrag);
  });
}

function getBottomCenterPosition(el, mapEl, bottomPx = 14, offsetXPx = 0) {
  const mapW = mapEl.clientWidth || 0;
  const mapH = mapEl.clientHeight || 0;
  const left = Math.max(0, Math.round((mapW - el.offsetWidth) / 2) + offsetXPx);
  const top = Math.max(0, Math.round(mapH - bottomPx - el.offsetHeight));
  return { left, top };
}

function getTopRightPosition(el, mapEl, marginPx = 12) {
  const mapW = mapEl.clientWidth || 0;
  const left = Math.max(0, Math.round(mapW - el.offsetWidth - marginPx));
  const top = Math.max(0, marginPx);
  return { left, top };
}

function formatScaleDistance(meters) {
  if (!isFinite(meters) || meters <= 0) return "--";
  if (meters >= 1000) {
    const km = meters / 1000;
    if (km >= 1000) return `${Math.round(km)} kilometer`;
    if (km >= 100) return `${km.toFixed(1)} kilometer`;
    if (km >= 10) return `${km.toFixed(2)} kilometer`;
    return `${km.toFixed(3)} kilometer`;
  }
  return `${Math.round(meters)} meter`;
}

const ExactScaleControl = L.Control.extend({
  options: { position: "bottomleft", widthPx: 160 },
  onAdd: function(controlMap) {
    this._map = controlMap;
    const container = L.DomUtil.create("div", "leaflet-control leaflet-control-exact-scale");
    const label = L.DomUtil.create("div", "exact-scale-label", container);
    const prefix = L.DomUtil.create("span", "exact-scale-prefix", label);
    const value = L.DomUtil.create("span", "exact-scale-value", label);
    prefix.textContent = "Scale: ";
    value.textContent = "--";
    this._value = value;
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    this._map.on("zoom move resize", this._update, this);
    this._update();
    return container;
  },
  onRemove: function(controlMap) {
    controlMap.off("zoom move resize", this._update, this);
  },
  _update: function() {
    if (!this._map || !this._value) return;
    const size = this._map.getSize();
    const y = Math.max(0, size.y - 24);
    const x = Math.max(0, Math.round((size.x - this.options.widthPx) / 2));
    const p1 = L.point(x, y);
    const p2 = L.point(x + this.options.widthPx, y);
    const ll1 = this._map.containerPointToLatLng(p1);
    const ll2 = this._map.containerPointToLatLng(p2);
    const meters = this._map.distance(ll1, ll2);
    this._value.textContent = formatScaleDistance(meters);
  }
});
const scaleControl = new ExactScaleControl({ widthPx: 160 });
map.addControl(scaleControl);

// North arrow
const NorthArrowControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd: function() {
    const container = L.DomUtil.create('div', 'leaflet-control leaflet-control-north-arrow');
    const label = L.DomUtil.create('div', 'north-arrow-symbol', container);
    label.textContent = 'N';
    label.setAttribute('aria-label', 'North arrow');
    label.setAttribute('title', 'North');
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    return container;
  }
});
const northArrowControl = new NorthArrowControl();
map.addControl(northArrowControl);

// Make both controls draggable.
makeControlDraggable(scaleControl, (el, mapEl) => getBottomCenterPosition(el, mapEl, 5, 20));
makeControlDraggable(northArrowControl, (el, mapEl) => {
  const pos = getTopRightPosition(el, mapEl, 12);
  return { left: pos.left, top: pos.top + 30 };
});

// Base layer
const baseLayer = L.tileLayer(
  'https://geoservices.un.org/arcgis/rest/services/ClearMap_WebTopo/MapServer/tile/{z}/{y}/{x}',
  {
    attribution: '© United Nations',
    crossOrigin: 'anonymous',
    maxZoom: 18,
    tileSize: 256
  }
).addTo(map);

function ensureBaseLayerAtBack() {
  if (!baseLayer || !map || !map.hasLayer(baseLayer)) return;
  try {
    if (typeof baseLayer.bringToBack === 'function') baseLayer.bringToBack();
    if (typeof baseLayer.setZIndex === 'function') baseLayer.setZIndex(1);
  } catch (e) {
    console.warn("Failed to keep UN Topo at back:", e);
  }
}

ensureBaseLayerAtBack();
map.on('layeradd', (e) => {
  if (e && e.layer === baseLayer) ensureBaseLayerAtBack();
});

// --- Draw control ---
const drawnItems = new L.FeatureGroup();
map.addLayer(drawnItems);

const drawControl = new L.Control.Draw({
  position: 'bottomright',
  edit: { featureGroup: drawnItems },
  draw: {
    polygon: true,
    polyline: true,
    rectangle: true,
    circle: true,
    marker: {
      icon: new L.Icon.Default(DEFAULT_MARKER_ICON_URLS)
    }
  }
});
map.addControl(drawControl);

map.on(L.Draw.Event.CREATED, (e) => {
  const layer = e.layer;
  if (layer && typeof layer.addTo === 'function') {
    drawnItems.addLayer(layer);
  } else {
    console.warn("Invalid layer object received from draw event");
  }
});

// Position the disclaimer at the bottom-left of the map container
function positionDisclaimer() {
  try {
    const disc = document.getElementById('disclaimer');
    if (!disc) return;
    const mapEl = map.getContainer();
    const mapRect = mapEl ? mapEl.getBoundingClientRect() : null;

    const left = 12;
    const bottom = 30;
    const preferredFixedWidth = 240;
    const margin = 12;
    const maxAvailableWidth = mapRect
      ? Math.max(120, Math.round(mapRect.width - left - margin))
      : preferredFixedWidth;
    const desiredWidth = Math.min(maxAvailableWidth, preferredFixedWidth);

    disc.classList.add('clamp-5-lines');
    disc.style.top = 'auto';
    disc.style.left = left + 'px';
    disc.style.right = 'auto';
    disc.style.bottom = bottom + 'px';
    disc.style.width = desiredWidth + 'px';
    disc.style.maxWidth = desiredWidth + 'px';

    // Keep user-dragged position across resize/move while clamping to map bounds.
    if (disclaimerUserPos) {
      const mW = mapEl ? mapEl.clientWidth : 0;
      const mH = mapEl ? mapEl.clientHeight : 0;
      const dW = disc.offsetWidth || desiredWidth;
      const dH = disc.offsetHeight || 0;
      const marginClamp = 6;
      const maxLeft = Math.max(marginClamp, mW - dW - marginClamp);
      const maxTop = Math.max(marginClamp, mH - dH - marginClamp);
      const leftPx = Math.min(maxLeft, Math.max(marginClamp, disclaimerUserPos.left));
      const topPx = Math.min(maxTop, Math.max(marginClamp, disclaimerUserPos.top));
      disc.style.top = topPx + 'px';
      disc.style.left = leftPx + 'px';
      disc.style.bottom = 'auto';
      disclaimerUserPos = { left: leftPx, top: topPx };
    }
  } catch (e) {
    console.warn('positionDisclaimer failed', e);
  }
}

function initDisclaimerDrag() {
  const disc = document.getElementById('disclaimer');
  const mapEl = map && typeof map.getContainer === 'function' ? map.getContainer() : null;
  if (!disc || !mapEl || disc.dataset.dragInit === '1') return;

  disc.dataset.dragInit = '1';
  disc.setAttribute('contenteditable', 'false');
  disc.setAttribute('draggable', 'false');

  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  const clampAndApply = (left, top) => {
    const mW = mapEl.clientWidth || 0;
    const mH = mapEl.clientHeight || 0;
    const dW = disc.offsetWidth || 0;
    const dH = disc.offsetHeight || 0;
    const marginClamp = 6;
    const maxLeft = Math.max(marginClamp, mW - dW - marginClamp);
    const maxTop = Math.max(marginClamp, mH - dH - marginClamp);
    const clampedLeft = Math.min(maxLeft, Math.max(marginClamp, left));
    const clampedTop = Math.min(maxTop, Math.max(marginClamp, top));

    disc.style.top = clampedTop + 'px';
    disc.style.left = clampedLeft + 'px';
    disc.style.bottom = 'auto';
    disclaimerUserPos = { left: clampedLeft, top: clampedTop };
  };

  const onPointerDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const mapRect = mapEl.getBoundingClientRect();
    const discRect = disc.getBoundingClientRect();
    dragging = true;
    offsetX = e.clientX - discRect.left;
    offsetY = e.clientY - discRect.top;
    disc.classList.add('is-dragging');
    if (disc.setPointerCapture) disc.setPointerCapture(e.pointerId);
    if (map.dragging && map.dragging.enabled && map.dragging.enabled()) map.dragging.disable();
    e.preventDefault();
    e.stopPropagation();
    clampAndApply(discRect.left - mapRect.left, discRect.top - mapRect.top);
  };

  const onPointerMove = (e) => {
    if (!dragging) return;
    const mapRect = mapEl.getBoundingClientRect();
    const nextLeft = e.clientX - mapRect.left - offsetX;
    const nextTop = e.clientY - mapRect.top - offsetY;
    clampAndApply(nextLeft, nextTop);
    e.preventDefault();
  };

  const onPointerUp = (e) => {
    if (!dragging) return;
    dragging = false;
    disc.classList.remove('is-dragging');
    if (disc.releasePointerCapture) {
      try { disc.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    if (map.dragging && map.dragging.enabled && !map.dragging.enabled()) map.dragging.enable();
  };

  disc.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

// run initially and on relevant events
window.addEventListener('load', () => {
  syncLayoutWithHeaderHeight();
  // Re-apply initial home once layout settles to avoid late layout shifts.
  setTimeout(applyHomeView, 50);
  setTimeout(syncLayoutWithHeaderHeight, 80);
  setTimeout(positionDisclaimer, 300);
  setTimeout(initDisclaimerDrag, 350);
});
window.addEventListener('resize', () => {
  setTimeout(syncLayoutWithHeaderHeight, 20);
  setTimeout(positionDisclaimer, 50);
});
map.on && map.on('resize', () => {
  setTimeout(syncLayoutWithHeaderHeight, 20);
  setTimeout(positionDisclaimer, 50);
});
map.on && map.on('moveend', () => setTimeout(positionDisclaimer, 50));

// --- Layers control (moved into sidebar if present) ---
const layersControl = L.control.layers(
  { 'UN Topo': baseLayer },
  {},
  { collapsed: false }
).addTo(map);

const layersContainer = document.getElementById('layers-container');
if (layersContainer) {
  const controlContainer = layersControl.getContainer();
  if (controlContainer) {
      layersContainer.appendChild(controlContainer);
      controlContainer.classList.add('layers-control-container');
      ensureBaseLayerListedLastInControl();
  }
}
//Legend Update
// --- Legend update ---
function updateLegend(layerName, vals, cols, isNumeric, geojson) {
  const leg = document.getElementById('legend-items');
  if (!leg) return;

  const safeId = 'legend-' + String(layerName).replace(/[^\w\-]/g, "_");
  let block = document.getElementById(safeId);
  if (!block) {
    block = document.createElement('div');
    block.id = safeId;
    block.className = 'legend-block';
    leg.appendChild(block);
  }

  block.textContent = "";

  const defaultLegendTitle = sanitizePlainText(
    `${humanizeLabel(layerName)}: ${humanizeLabel(currentAttribute || "")}`,
    humanizeLabel(layerName)
  );
  if (overlayData[layerName]) {
    overlayData[layerName].legendTitle = sanitizePlainText(overlayData[layerName].legendTitle, defaultLegendTitle);
  }

  const header = document.createElement('div');
  header.className = 'legend-header';
  header.contentEditable = 'true';
  header.setAttribute('role', 'textbox');
  header.setAttribute('aria-label', `Legend title for ${layerName}`);
  header.spellcheck = false;
  header.textContent = overlayData[layerName]?.legendTitle || defaultLegendTitle;
  header.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
    insertTextAtCaret(header, text);
  });
  header.addEventListener('blur', () => {
    const next = sanitizePlainText(header.textContent, defaultLegendTitle);
    header.textContent = next;
    if (overlayData[layerName]) overlayData[layerName].legendTitle = next;
  });
  block.appendChild(header);

  const geom = geojson?.features?.[0]?.geometry?.type || 'Polygon';

  const makeRow = (label, color) => {
    const row = document.createElement('div');
    row.className = 'legend-row';

    const sym = document.createElement('div');
    sym.className = 'legend-sym';
    if (/LineString/.test(geom)) sym.classList.add('legend-sym-line');
    if (/Point/.test(geom)) sym.classList.add('legend-sym-point');
    if (/Polygon/.test(geom)) sym.classList.add('legend-sym-polygon');

    if (/^#[0-9A-Fa-f]{3,6}$/.test(color) || /^[a-zA-Z]+$/.test(color)) {
      sym.style.backgroundColor = color;
    } else {
      sym.style.backgroundColor = "#ccc";
      console.warn("Invalid color blocked:", color);
    }

    const lbl = document.createElement('span');
    lbl.textContent = label;

    row.append(sym, lbl);
    return row;
  };

  if (isNumeric) {
    for (let i = 0; i < vals.length - 1; i++) {
      block.appendChild(makeRow(`${vals[i]} – ${vals[i + 1]}`, cols[i]));
    }
  } else {
    vals.forEach((v, i) => block.appendChild(makeRow(v, cols[i])));
  }

  reorderLegendBlocks();
}
//Overlay Add/Remove Wiring
// --- Overlay add/remove legend wiring ---
map.on('overlayadd', (e) => {
  const name = Object.keys(overlayData).find(
    key => overlayData[key].layerGroup === e.layer
  );
  if (!name) return;

  const data = overlayData[name];
  if (!data || !data.vals || !data.cols) return;

  updateLegend(name, data.vals, data.cols, data.isNumeric, data.geojson);
  applyLayerStackOrder();
  reorderLegendBlocks();
});

map.on('overlayremove', (e) => {
  const name = Object.keys(overlayData).find(
    key => overlayData[key].layerGroup === e.layer
  );
  if (!name) return;

  const block = document.getElementById('legend-' + sanitizeId(name));
  if (block) block.remove();
  reorderLegendBlocks();
});
//Styling, Defaults, and Live Refresh Helpers
// --- Default styles (use getLineWidth/getPointRadius) ---
function getPointRadius() {
  const el = document.getElementById('point-size');
  return el ? (+el.value || 4) : 4;
}
function getLineWidth() {
  const el = document.getElementById('line-width');
  return el ? (+el.value || 3) : 3;
}

function defaultStyle(feature) {
  const t = feature?.geometry?.type || "";
  if (/Polygon/.test(t)) return { weight: 0, fillColor: '#ccc', fillOpacity: 0.6 };
  if (/LineString/.test(t)) return { color: '#007aff', weight: getLineWidth() };
  return { color: '#000', weight: 1, fillColor: '#ccc', fillOpacity: 0.6 };
}

function defaultPoint(feature, latlng) {
  const size = getPointRadius();
  return L.circleMarker(latlng, {
    radius: size,
    fillColor: '#ccc',
    color: '#000',
    weight: 1,
    fillOpacity: 0.6
  });
}

// Refresh styles for existing layers (works before and after classification)
function refreshStyles() {
  if (!layerGroup) return;

  layerGroup.eachLayer(layer => {
    // GeoJSON vector layers and path layers support setStyle
    if (typeof layer.setStyle === 'function') {
      try {
        const feat = layer.feature || {};
        layer.setStyle(defaultStyle(feat));
      } catch (e) {
        console.warn("Failed to set style on layer:", e);
      }
    }

    // CircleMarker and similar support setRadius
    if (typeof layer.setRadius === 'function') {
      try {
        layer.setRadius(getPointRadius());
      } catch (e) {
        console.warn("Failed to set radius on marker:", e);
      }
    }

    // Some feature groups may contain nested layers
    if (typeof layer.eachLayer === 'function') {
      layer.eachLayer(sub => {
        if (typeof sub.setStyle === 'function') {
          try { sub.setStyle(defaultStyle(sub.feature || {})); } catch (e) {}
        }
        if (typeof sub.setRadius === 'function') {
          try { sub.setRadius(getPointRadius()); } catch (e) {}
        }
      });
    }
  });

  // Also update the raw geojsonLayer if present
  if (geojsonLayer && typeof geojsonLayer.setStyle === 'function') {
    try { geojsonLayer.setStyle(defaultStyle); } catch (e) {}
  }
}
//File Upload and URL Add Handlers
function getDataExtension(nameOrPath) {
  return String(nameOrPath || "").slice(String(nameOrPath || "").lastIndexOf(".")).toLowerCase();
}

function parseCsvToGeojson(csvText, sourceLabel = "CSV") {
  if (!window.Papa || typeof window.Papa.parse !== "function") {
    throw new Error("CSV parser is unavailable.");
  }
  const parsed = window.Papa.parse(csvText, {
    header: true,
    skipEmptyLines: "greedy"
  });
  if (Array.isArray(parsed.errors) && parsed.errors.length) {
    const firstErr = parsed.errors[0];
    throw new Error(`${sourceLabel} parse error near row ${firstErr.row ?? "?"}.`);
  }
  const rows = Array.isArray(parsed.data) ? parsed.data : [];
  if (!rows.length) return { type: "FeatureCollection", features: [] };

  const keys = Object.keys(rows[0] || {});
  const latKey = keys.find(k => /lat/i.test(String(k)));
  const lonKey = keys.find(k => /lon|lng|long/i.test(String(k)));
  if (!latKey || !lonKey) {
    throw new Error("CSV must have latitude/longitude columns.");
  }

  const features = rows.map((r, rowIdx) => {
    const lat = Number.parseFloat(r?.[latKey]);
    const lon = Number.parseFloat(r?.[lonKey]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      console.warn("Skipping out-of-range coordinates on CSV row:", rowIdx + 2);
      return null;
    }
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: { ...(r || {}) }
    };
  }).filter(f => f !== null);

  return { type: "FeatureCollection", features };
}

function parseImportedData(ext, bodyText, contentType = "") {
  if (ext === ".csv") {
    return parseCsvToGeojson(bodyText, "CSV");
  }
  if (!contentType.includes("json")) {
    console.warn("Non-standard content type for JSON-like import:", contentType);
  }
  const geojson = JSON.parse(bodyText);
  if (!geojson || geojson.type !== "FeatureCollection") {
    throw new Error("Invalid GeoJSON structure");
  }
  return geojson;
}

async function addImportedLayer(geojson, rawName, sourceLabel) {
  if (!geojson || !Array.isArray(geojson.features)) {
    throw new Error("Invalid data structure");
  }

  const stats = assertDatasetWithinLimits(geojson, sourceLabel);
  const proceed = await confirmLargeDatasetLoad(stats, sourceLabel);
  if (!proceed) {
    throw new Error("Import canceled by user.");
  }

  const safeName = sanitizeName(rawName);
  const fg = L.featureGroup().addTo(map);
  geojsonLayer = L.geoJSON(geojson, {
    style: defaultStyle,
    pointToLayer: defaultPoint,
    onEachFeature: bindFeaturePopup
  }).addTo(fg);
  layerGroup = fg;
  setTimeout(() => { fitToLayerExtent(fg); }, 0);

  overlayData[safeName] = { layerGroup: fg, geojson: geojson };
  layersControl.addOverlay(fg, safeName);
  trackLayerOrder(safeName);
  reorderLayersControlUI();
  applyLayerStackOrder();
  refreshLayerSelector();
  setActiveLayer(safeName);
  initializeMapTitleFromLayer(safeName);

  return safeName;
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(String(e?.target?.result || ""));
    reader.onerror = () => reject(new Error("Failed to read file as text."));
    reader.readAsText(file);
  });
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e?.target?.result);
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsArrayBuffer(file);
  });
}

async function importFile(file) {
  const fileNameEl = document.getElementById("file-name");
  const ext = getDataExtension(file?.name || "");
  const allowedExtensions = new Set([".zip", ".csv", ".geojson"]);
  if (!allowedExtensions.has(ext)) {
    throw new Error(`Unsupported file type: ${file?.name || "unknown file"}`);
  }
  if (file.size > MAX_SIZE) {
    const maxMb = Math.round(MAX_SIZE / (1024 * 1024));
    throw new Error(`File "${file.name}" too large (max ${maxMb} MB).`);
  }

  showLoading("Loading data from file...");
  try {
    let geojson;
    if (ext === ".zip") {
      const bytes = await readFileAsArrayBuffer(file);
      geojson = await shp(bytes);
    } else {
      const text = await readFileAsText(file);
      geojson = parseImportedData(ext, text, ext === ".geojson" ? "application/json" : "text/csv");
    }

    const safeName = await addImportedLayer(geojson, file.name, "Imported file");
    if (fileNameEl) fileNameEl.textContent = safeName;
    showPopup(`File "${safeName}" uploaded successfully`, "success");
  } finally {
    hideLoading();
  }
}

async function importUrl(rawUrl) {
  const fileNameEl = document.getElementById("file-name");
  const urlInput = document.getElementById("geojson-url");
  if (!rawUrl) throw new Error("Enter a valid URL");

  showLoading("Loading data from URL...");
  try {
    const { parsed, ext } = validateImportUrl(rawUrl);
    const fetched = await fetchWithLimits(parsed.href);
    const geojson = parseImportedData(ext, fetched.text || "", fetched.contentType || "");
    const fallbackName = parsed.pathname.split("/").pop() || ("Layer_" + Date.now());
    const safeName = await addImportedLayer(geojson, fallbackName, "Imported URL data");
    if (urlInput) urlInput.value = "";
    if (fileNameEl) fileNameEl.textContent = safeName;
    showPopup(`Layer "${safeName}" added successfully`, "success");
  } finally {
    hideLoading();
  }
}

// --- File Upload Handler (secure) ---
const fileUploadEl = document.getElementById("file-upload");
if (fileUploadEl) {
  fileUploadEl.addEventListener("change", async function(evt) {
    const files = Array.from(evt?.target?.files || []);
    for (const file of files) {
      try {
        await importFile(file);
      } catch (err) {
        console.error("File import error:", err);
        showPopup(String(err?.message || "Error loading file"), "error");
        const fileNameEl = document.getElementById("file-name");
        if (fileNameEl) fileNameEl.textContent = "Error: " + String(err?.message || "Error loading file");
      }
    }
    evt.target.value = "";
  });
}

const addGeojsonUrlEl = document.getElementById("add-geojson-url");
if (addGeojsonUrlEl) {
  addGeojsonUrlEl.addEventListener("click", async function() {
    const rawUrl = document.getElementById("geojson-url")?.value.trim() || "";
    try {
      await importUrl(rawUrl);
    } catch (err) {
      console.error("Data load error:", err);
      showPopup("Error loading data: " + String(err?.message || err), "error");
      const fileNameEl = document.getElementById("file-name");
      if (fileNameEl) fileNameEl.textContent = "Error: " + String(err?.message || err);
    }
  });
}

//Layer Selector, Activation, and Refresh
// --- Refresh the Layer dropdown securely ---
function refreshLayerSelector() {
  const wrap = 'layer-select-col';
  const sel = document.getElementById('layer-select');
  if (!sel) return;

  sel.textContent = "";
  const orderedNames = getOrderedLayerNames();

  const defaultOpt = document.createElement('option');
  defaultOpt.disabled = true;
  defaultOpt.selected = orderedNames.length === 0;
  defaultOpt.textContent = "Select layer…";
  sel.appendChild(defaultOpt);

  orderedNames.forEach(name => {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name;
    sel.appendChild(o);
  });

  if (orderedNames.length > 0) sel.value = orderedNames[0];
  Object.keys(overlayData).length ? showRow(wrap) : hideRow(wrap);
}

function updateContinentFilterButtonLabel() {
  const btn = document.getElementById('continent-filter-btn');
  if (!btn) return;
  const n = selectedContinentValues.size;
  btn.textContent = n === 0 ? "Select continent(s)" : (n === 1 ? Array.from(selectedContinentValues)[0] : `${n} continents selected`);
}

function updateCountryFilterButtonLabel() {
  const btn = document.getElementById('country-filter-btn');
  if (!btn) return;
  const n = selectedCountryValues.size;
  btn.textContent = n === 0 ? "Select country(ies)" : (n === 1 ? Array.from(selectedCountryValues)[0] : `${n} countries selected`);
}

function uncheckActiveLayerInControl() {
  const name = sanitizePlainText(currentLayerName || "");
  if (!name || !overlayData[name]) return;

  const group = overlayData[name].layerGroup;
  if (group && map && map.hasLayer(group)) {
    try { map.removeLayer(group); } catch (e) {}
  }

  const controlContainer = layersControl && layersControl.getContainer ? layersControl.getContainer() : null;
  if (!controlContainer) return;
  const labels = Array.from(controlContainer.querySelectorAll('label'));
  const label = labels.find(lbl => getLayerNameFromLabel(lbl) === name);
  if (!label) return;
  const cb = label.querySelector('input.leaflet-control-layers-selector');
  if (cb) cb.checked = false;
}

function checkActiveLayerInControl() {
  const name = sanitizePlainText(currentLayerName || "");
  if (!name || !overlayData[name]) return;

  const group = overlayData[name].layerGroup;
  if (group && map && !map.hasLayer(group)) {
    try { map.addLayer(group); } catch (e) {}
  }

  const controlContainer = layersControl && layersControl.getContainer ? layersControl.getContainer() : null;
  if (!controlContainer) return;
  const labels = Array.from(controlContainer.querySelectorAll('label'));
  const label = labels.find(lbl => getLayerNameFromLabel(lbl) === name);
  if (!label) return;
  const cb = label.querySelector('input.leaflet-control-layers-selector');
  if (cb) cb.checked = true;
}

function populateCountryFilterOptions(data) {
  const col = 'country-filter-col';
  const list = document.getElementById('country-filter-list');
  const btnAll = document.getElementById('btnCountryAll');
  const btnClear = document.getElementById('btnCountryClear');
  if (!list || !activeCountryField) return hideRow(col);

  // Cascaded behavior: no country list until at least one continent is selected.
  if (!activeContinentField || selectedContinentValues.size === 0) {
    list.textContent = "";
    selectedCountryValues = new Set();
    updateCountryFilterButtonLabel();
    if (btnAll) btnAll.disabled = true;
    if (btnClear) btnClear.disabled = true;
    return hideRow(col);
  }

  let vals = [];
  if (activeCountryField === "__rma_country" && worldCountriesByContinent) {
    const set = new Set();
    Array.from(selectedContinentValues).forEach(cont => {
      const matches = Array.from(worldCountriesByContinent.keys()).find(k => norm(k) === norm(cont));
      if (!matches) return;
      worldCountriesByContinent.get(matches).forEach(cn => set.add(cn));
    });
    vals = Array.from(set).sort((a, b) => a.localeCompare(b));
  } else {
    const byContinent = (Array.isArray(data?.features) ? data.features : []).filter(f =>
      Array.from(selectedContinentValues).some(v =>
        norm(v) === norm(f?.properties?.[activeContinentField])
      )
    );
    vals = uniqueValuesForKey(byContinent, activeCountryField);
  }
  // keep only selections still visible under current continent
  selectedCountryValues = new Set(
    Array.from(selectedCountryValues).filter(v => vals.some(x => norm(x) === norm(v)))
  );

  list.textContent = "";
  vals.forEach((v, i) => {
    const row = document.createElement('label');
    row.className = 'country-filter-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'country-filter-check';
    cb.value = v;
    cb.id = `country-filter-${i}`;
    cb.checked = Array.from(selectedCountryValues).some(x => norm(x) === norm(v));
    const txt = document.createElement('span');
    txt.textContent = v;
    row.append(cb, txt);
    list.appendChild(row);
  });

  if (btnAll) btnAll.disabled = vals.length === 0;
  if (btnClear) btnClear.disabled = vals.length === 0;
  updateCountryFilterButtonLabel();
  showRow(col);
}

async function populateFilterControls(data) {
  const contCol = 'continent-filter-col';
  const contSel = document.getElementById('continent-filter');
  const africaBtn = document.getElementById('btnAfricaOnly');
  const contBtnAll = document.getElementById('btnContinentAll');
  const contBtnClear = document.getElementById('btnContinentClear');
  if (!contSel) return;

  let fields = detectFilterFields(data);
  activeContinentField = fields.continentKey || ensureSyntheticContinentField(data);
  activeCountryField = fields.countryKey;
  try {
    const hasSpatial = await ensureSpatialCountryContinentFields(data);
    if (hasSpatial) {
      // Prefer schema-independent spatial fields when available so continent/country
      // options are consistent across CSV/GeoJSON/SHP and not limited by source schema.
      activeContinentField = "__rma_continent_spatial";
      activeCountryField = "__rma_country";
    } else if (!activeContinentField || !activeCountryField) {
      fields = detectFilterFields(data);
      activeContinentField = fields.continentKey || ensureSyntheticContinentField(data);
      activeCountryField = fields.countryKey;
    }
  } catch (e) {
    console.warn("Spatial country/continent inference unavailable:", e);
  }
  selectedContinentValues = new Set();
  selectedCountryValues = new Set();

  contSel.textContent = "";
  if (activeContinentField) {
    const vals = (activeContinentField === "__rma_continent_spatial" && worldCountriesByContinent)
      ? Array.from(worldCountriesByContinent.keys()).sort((a, b) => a.localeCompare(b))
      : uniqueValuesForKey(data?.features || [], activeContinentField);
    vals.forEach(v => {
      const row = document.createElement('label');
      row.className = 'country-filter-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'country-filter-check';
      cb.value = v;
      cb.checked = false;
      const txt = document.createElement('span');
      txt.textContent = continentLabel(v) || v;
      row.append(cb, txt);
      contSel.appendChild(row);
    });
    if (vals.length) {
      selectedContinentValues = new Set(vals);
      Array.from(contSel.querySelectorAll('input[type="checkbox"]')).forEach(o => {
        o.checked = true;
      });
    }
    updateContinentFilterButtonLabel();
    showRow(contCol);
    if (africaBtn) africaBtn.style.display = '';
    if (contBtnAll) contBtnAll.style.display = '';
    if (contBtnClear) contBtnClear.style.display = '';
  } else {
    updateContinentFilterButtonLabel();
    hideRow(contCol);
    if (africaBtn) africaBtn.style.display = 'none';
    if (contBtnAll) contBtnAll.style.display = 'none';
    if (contBtnClear) contBtnClear.style.display = 'none';
  }

  populateCountryFilterOptions(data);
}

function renderDefaultFilteredLayer() {
  if (!currentLayerName || !geojsonData) return;
  const filtered = getFilteredGeojson(geojsonData);

  if (layerGroup && typeof layerGroup.clearLayers === 'function') {
    layerGroup.clearLayers();
  } else {
    layerGroup = L.featureGroup().addTo(map);
  }

  geojsonLayer = L.geoJSON(filtered, {
    style: defaultStyle,
    pointToLayer: defaultPoint,
    onEachFeature: bindFeaturePopup
  }).addTo(layerGroup);

  const block = document.getElementById('legend-' + sanitizeId(currentLayerName));
  if (block) block.remove();
}

// --- Activate a layer securely ---
async function setActiveLayer(name) {
  currentLayerName = name;
  const targetLayerName = name;
  const obj = overlayData[name];
  if (!obj) {
    console.warn("Invalid layer activation:", name);
    return;
  }

  geojsonData = obj.geojson;
  layerGroup  = obj.layerGroup;
  currentAttribute = null;

  if (geojsonData && geojsonData.type === "FeatureCollection") {
    await populateFilterControls(geojsonData);
    if (currentLayerName !== targetLayerName) return;
    populateAttributeList(geojsonData);
    updatePointSizeControl();
    updateLineWidthControl();
    updateClassificationOptions();
    // Do not force classification; apply only if attribute already selected
    if (currentAttribute) applyClassification();
    else renderDefaultFilteredLayer();
  }

  const sel = document.getElementById('layer-select');
  if (sel) sel.value = name;
}
//Attribute Population, Controls, and Classification Options
// --- Populate attribute dropdown ---
function populateAttributeList(data) {
  const wrap = 'attribute-select-col';
  const sel = document.getElementById('attribute-select');
  if (!sel) return;

  sel.textContent = "";

  const defaultOpt = document.createElement('option');
  defaultOpt.disabled = true;
  defaultOpt.selected = true;
  defaultOpt.textContent = "Select attribute";
  sel.appendChild(defaultOpt);

  if (!data || !Array.isArray(data.features) || !data.features.length) {
    return hideRow(wrap);
  }

  const props = data.features[0].properties || {};
  Object.keys(props).forEach(k => {
    const o = document.createElement('option');
    o.value = String(k).replace(/[^\w\-]/g, "_");
    o.textContent = k;
    sel.appendChild(o);
  });

  showRow(wrap);
}

// --- Point & Line size controls visibility ---
function updatePointSizeControl() {
  const wrap = 'point-size-col';
  if (!geojsonData || !Array.isArray(geojsonData.features)) return hideRow(wrap);

  const hasPoint = geojsonData.features.some(f => f.geometry && /Point/.test(f.geometry.type));
  hasPoint ? showRow(wrap) : hideRow(wrap);
}

function updateLineWidthControl() {
  const wrap = 'line-width-col';
  if (!geojsonData || !Array.isArray(geojsonData.features)) return hideRow(wrap);

  const hasLine = geojsonData.features.some(f => f.geometry && /LineString/.test(f.geometry.type));
  hasLine ? showRow(wrap) : hideRow(wrap);
}

// --- Classification options ---
function updateClassificationOptions() {
  const typeWrap = 'classification-type-col';
  const numWrap = 'num-classes-col';
  const sel = document.getElementById('classification-type');
  if (!sel) return;

  if (!geojsonData || !Array.isArray(geojsonData.features) || !geojsonData.features.length) {
    hideRow(typeWrap);
    hideRow(numWrap);
    return;
  }

  const sample = geojsonData.features[0].properties?.[currentAttribute];
  showRow(typeWrap);

  sel.textContent = "";

  if (!isNaN(Number(sample))) {
    ["equal", "jenks", "quantile"].forEach(type => {
      const opt = document.createElement('option');
      opt.value = type;
      opt.textContent = type === "equal" ? "Equal Interval"
                      : type === "jenks" ? "Natural Breaks"
                      : "Quantile";
      sel.appendChild(opt);
    });
    showRow(numWrap);
  } else {
    const opt = document.createElement('option');
    opt.value = "unique";
    opt.textContent = "Unique";
    sel.appendChild(opt);
    hideRow(numWrap);
  }
}
//Classification Application (fixed to respect line-width before/after classification)
function applyClassification() {
  if (!currentLayerName || !geojsonData || !Array.isArray(geojsonData.features)) return;

  // Ensure geojsonLayer default style is set
  if (geojsonLayer && typeof geojsonLayer.setStyle === 'function') {
    try { geojsonLayer.setStyle(defaultStyle); } catch (e) {}
  }

  const sel = document.getElementById('classification-type');
  if (!sel) return;
  const method = sel.value;

  if (!currentAttribute) {
    console.warn("No attribute selected for classification");
    // Even if no attribute, still refresh styles so line-width changes apply
    refreshStyles();
    return;
  }

  const filteredGeojson = getFilteredGeojson(geojsonData);
  const vals = filteredGeojson.features
    .map(f => f.properties?.[currentAttribute])
    .filter(v => v != null);

  if (!vals.length) {
    console.warn("No valid values found for classification");
    refreshStyles();
    return;
  }

  // Clear previous rendered layers in the layerGroup
  if (layerGroup && typeof layerGroup.clearLayers === 'function') {
    layerGroup.clearLayers();
  } else {
    layerGroup = L.featureGroup().addTo(map);
  }

  // --- Categorical classification ---
  if (method === 'unique') {
    const uniques = [...new Set(vals)];
    const cols = (categoricalUserColors && categoricalUserColors.length === uniques.length)
      ? categoricalUserColors.slice()
      : generateColorPalette(uniques.length);
    categoricalUserColors = cols.slice();

    L.geoJSON(filteredGeojson, {
      style: f => {
        const idx = uniques.indexOf(f.properties?.[currentAttribute]);
        const col = cols[idx] || '#ccc';
        const t = f.geometry?.type || "";
        if (/LineString/.test(t)) return { color: col, weight: getLineWidth() };
        if (/Polygon/.test(t)) return { weight: 0, fillColor: col, fillOpacity: 0.6 };
        return { color: '#000', weight: 1, fillColor: col, fillOpacity: 0.6 };
      },
      pointToLayer: (f, latlng) => {
        const idx = uniques.indexOf(f.properties?.[currentAttribute]);
        const col = cols[idx] || '#ccc';
        return L.circleMarker(latlng, {
          radius: getPointRadius(),
          fillColor: col,
          color: '#000',
          weight: 1,
          fillOpacity: 0.6,

        });
      },
      onEachFeature: bindFeaturePopup
        }).addTo(layerGroup);

    if (overlayData[currentLayerName]) {
      overlayData[currentLayerName].vals = uniques;
      overlayData[currentLayerName].cols = cols;
      overlayData[currentLayerName].isNumeric = false;
    }

    updateLegend(currentLayerName, uniques, cols, false, filteredGeojson);
    updateClassificationTableCategorical(uniques, cols);
  }

  // --- Numeric classification ---
  else {
    const numEl = document.getElementById('num-classes');
    const requestedN = numEl ? (+numEl.value || 5) : 5;
    const n = Math.min(10, Math.max(2, requestedN));
    if (numEl && Number(numEl.value) !== n) numEl.value = String(n);

    let breaks;
    try {
      const gs = new geostats(vals);
      breaks = method === 'equal' ? gs.getClassEqInterval(n)
        : method === 'jenks' ? gs.getClassJenks(n)
        : gs.getClassQuantile(n);
    } catch (err) {
      console.error("Geostats error:", err);
      return;
    }

    breaks = breaks.map(b => Number(formatNumber(b)));

    const classCount = Math.max(1, breaks.length - 1);
    // 10-step sequential palette for numeric classes
    const defaultCols = [
      "#fff5f0", "#fee0d2", "#fcbba1", "#fc9272", "#fb6a4a",
      "#ef3b2c", "#cb181d", "#a50f15", "#7f0000", "#4d0000"
    ];
    const baseCols = defaultCols.length >= classCount
      ? defaultCols.slice(0, classCount)
      : generateColorPalette(classCount);
    const userCols = Array.isArray(numericUserColors)
      ? numericUserColors.slice(0, classCount)
      : [];
    const cols = Array.from({ length: classCount }, (_, i) => userCols[i] || baseCols[i] || '#ccc');
    numericUserColors = cols.slice();

    function colorForVal(val) {
      for (let i = 0; i < breaks.length - 1; i++) {
        if (val >= breaks[i] && val <= breaks[i + 1]) return cols[i];
      }
      return '#ccc';
    }

    L.geoJSON(filteredGeojson, {
      style: f => {
        const col = colorForVal(f.properties?.[currentAttribute]);
        const t = f.geometry?.type || "";
        if (/LineString/.test(t)) return { color: col, weight: getLineWidth() };
        if (/Polygon/.test(t)) return { weight: 0, fillColor: col, fillOpacity: 0.6 };
        return { color: '#000', weight: 1, fillColor: col, fillOpacity: 0.6 };
      },
      pointToLayer: (f, latlng) => {
        const col = colorForVal(f.properties?.[currentAttribute]);
        return L.circleMarker(latlng, {
          radius: getPointRadius(),
          fillColor: col,
          color: '#000',
          weight: 1,
          fillOpacity: 0.6,
        });
      },
    onEachFeature: bindFeaturePopup
    }).addTo(layerGroup);

    if (overlayData[currentLayerName]) {
      overlayData[currentLayerName].vals = breaks;
      overlayData[currentLayerName].cols = cols;
      overlayData[currentLayerName].isNumeric = true;
    }

    updateLegend(currentLayerName, breaks, cols, true, filteredGeojson);
    updateClassificationTableNumeric(breaks, cols);
  }

  const tbl = document.getElementById('table-container');
  if (tbl) tbl.style.display = 'block';
  applyLayerStackOrder();
}
//Classification Tables and Helpers
function updateClassificationTableNumeric(brks, cols) {
  const thead = document.querySelector('#table-container thead');
  const tbody = document.getElementById('classification-table');
  if (!thead || !tbody) return;

  thead.textContent = "";
  tbody.textContent = "";

  const headerRow = document.createElement('tr');
  ["Class", "Range", "Color"].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);

  brks.slice(0, -1).forEach((_, i) => {
    const tr = document.createElement('tr');

    const tdC = document.createElement('td');
    tdC.textContent = 'Class ' + (i + 1);

    const tdR = document.createElement('td');
    tdR.contentEditable = true;
    tdR.textContent = `${formatNumber(brks[i])} - ${formatNumber(brks[i + 1])}`;
    tdR.addEventListener('blur', () => {
      const rangeText = tdR.textContent.replace(/[–—]/g, '-').trim();
      const parts = rangeText.split('-').map(p => parseFloat(p.trim()));
      if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) {
        tdR.textContent = `${formatNumber(brks[i])} - ${formatNumber(brks[i + 1])}`;
        console.warn("Invalid range reset:", rangeText);
      } else {
        updateCustomBreaks();
      }
    });

    const tdCol = document.createElement('td');
    const inputCol = document.createElement('input');
    inputCol.type = 'color';
    inputCol.value = /^#[0-9A-Fa-f]{6}$/.test(cols[i]) ? cols[i] : "#ccc";
    inputCol.setAttribute("aria-label", `Color for class ${i+1}`);
    inputCol.addEventListener('change', () => {
      cols[i] = inputCol.value;
      numericUserColors = cols.slice();
      applyClassification();
    });
    tdCol.append(inputCol);

    tr.append(tdC, tdR, tdCol);
    tbody.append(tr);
  });
}

function updateClassificationTableCategorical(uniques, cols) {
  const thead = document.querySelector('#table-container thead');
  const tbody = document.getElementById('classification-table');
  if (!thead || !tbody) return;

  thead.textContent = "";
  tbody.textContent = "";

  const headerRow = document.createElement('tr');
  ["Category", "Color"].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);

  uniques.forEach((u, i) => {
    const tr = document.createElement('tr');

    const tdC = document.createElement('td');
    tdC.textContent = u;

    const tdCol = document.createElement('td');
    const inputCol = document.createElement('input');
    inputCol.type = 'color';
    inputCol.value = /^#[0-9A-Fa-f]{6}$/.test(cols[i]) ? cols[i] : "#ccc";
    inputCol.setAttribute("aria-label", `Color for category ${u}`);
    inputCol.addEventListener('change', () => {
      cols[i] = inputCol.value;
      categoricalUserColors = cols.slice();
      applyClassification();
    });
    tdCol.append(inputCol);

    tr.append(tdC, tdCol);
    tbody.append(tr);
  });
}

function updateCustomBreaks() {
  const rows = document.querySelectorAll('#classification-table tr');
  const newBreaks = [];
  const newColors = [];

  rows.forEach((row, i) => {
    if (!row.cells[1]) return;
    const rangeText = row.cells[1].textContent.replace(/[–—]/g, '-').trim();
    const parts = rangeText.split('-').map(p => parseFloat(p.trim()));
    if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return;
    newBreaks.push(parts[0]);
    const colorInput = row.querySelector('input[type="color"]');
    newColors.push(colorInput ? colorInput.value : '#ccc');
  });

  const lastCell = document.querySelector('#classification-table tr:last-child td:nth-child(2)');
  if (lastCell) {
    const lastRange = lastCell.textContent.replace(/[–—]/g, '-').trim();
    const parts = lastRange.split('-').map(p => parseFloat(p.trim()));
    if (parts.length === 2 && !isNaN(parts[1])) newBreaks.push(parts[1]);
  }

  if (newBreaks.length >= 2) {
    if (overlayData[currentLayerName]) {
      overlayData[currentLayerName].vals = newBreaks;
      overlayData[currentLayerName].cols = newColors;
      overlayData[currentLayerName].isNumeric = true;
    }
    applyClassification();
  }
}
//UI Event Wiring (live updates before/after classification)
// Wire up control inputs so changes apply before and after classification
(function wireControls() {
  const pointEl = document.getElementById('point-size');
  if (pointEl) {
    pointEl.addEventListener('input', () => {
      if (currentAttribute) applyClassification();
      else renderDefaultFilteredLayer();
    });
  }

  const lineEl = document.getElementById('line-width');
  if (lineEl) {
    lineEl.addEventListener('input', () => {
      if (currentAttribute) applyClassification();
      else renderDefaultFilteredLayer();
    });
  }

  // When user selects an attribute, update state and classification options
  const attrSel = document.getElementById('attribute-select');
  if (attrSel) {
    attrSel.addEventListener('change', () => {
      const selected = attrSel.value;
      if (geojsonData && geojsonData.features && geojsonData.features.length) {
        const props = geojsonData.features[0].properties || {};
        const originalKey = Object.keys(props).find(k => String(k).replace(/[^\w\-]/g, "_") === selected);
        currentAttribute = originalKey || selected;
      } else {
        currentAttribute = selected;
      }
      updateClassificationOptions();
      applyClassification();
    });
  }

  // Classification type or number of classes changes
  const classType = document.getElementById('classification-type');
  if (classType) {
    classType.addEventListener('change', () => {
      applyClassification();
    });
  }
  const numClasses = document.getElementById('num-classes');
  if (numClasses) {
    numClasses.addEventListener('input', () => {
      applyClassification();
    });
  }

  // Layer selector change
  const layerSel = document.getElementById('layer-select');
  if (layerSel) {
    layerSel.addEventListener('change', () => {
      setActiveLayer(layerSel.value);
    });
  }

  const contSel = document.getElementById('continent-filter');
  const btnContinentAll = document.getElementById('btnContinentAll');
  const btnContinentClear = document.getElementById('btnContinentClear');
  const countryList = document.getElementById('country-filter-list');
  const btnCountryAll = document.getElementById('btnCountryAll');
  const btnCountryClear = document.getElementById('btnCountryClear');
  const africaBtn = document.getElementById('btnAfricaOnly');
  if (contSel) {
    contSel.addEventListener('change', () => {
      selectedContinentValues = new Set(
        Array.from(contSel.querySelectorAll('input[type="checkbox"]:checked')).map(o => o.value).filter(Boolean)
      );
      updateContinentFilterButtonLabel();
      selectedCountryValues = new Set();
      populateCountryFilterOptions(geojsonData);
      if (currentAttribute) applyClassification();
      else renderDefaultFilteredLayer();
    });
  }
  if (btnContinentAll) {
    btnContinentAll.addEventListener('click', () => {
      if (!contSel) return;
      const checks = Array.from(contSel.querySelectorAll('input[type="checkbox"]'));
      checks.forEach(o => { o.checked = true; });
      selectedContinentValues = new Set(checks.map(o => o.value));
      updateContinentFilterButtonLabel();
      selectedCountryValues = new Set();
      populateCountryFilterOptions(geojsonData);
      checkActiveLayerInControl();
      if (currentAttribute) applyClassification();
      else renderDefaultFilteredLayer();
    });
  }
  if (btnContinentClear) {
    btnContinentClear.addEventListener('click', () => {
      if (!contSel) return;
      Array.from(contSel.querySelectorAll('input[type="checkbox"]')).forEach(o => { o.checked = false; });
      selectedContinentValues = new Set();
      updateContinentFilterButtonLabel();
      selectedCountryValues = new Set();
      populateCountryFilterOptions(geojsonData);
      uncheckActiveLayerInControl();
      if (currentAttribute) applyClassification();
      else renderDefaultFilteredLayer();
    });
  }
  if (countryList) {
    countryList.addEventListener('change', (e) => {
      const t = e.target;
      if (!t || t.tagName !== 'INPUT' || t.type !== 'checkbox') return;
      if (t.checked) selectedCountryValues.add(t.value);
      else selectedCountryValues.delete(t.value);
      updateCountryFilterButtonLabel();
      if (currentAttribute) applyClassification();
      else renderDefaultFilteredLayer();
    });
  }
  if (btnCountryAll) {
    btnCountryAll.addEventListener('click', () => {
      const checks = Array.from(document.querySelectorAll('#country-filter-list input[type="checkbox"]'));
      selectedCountryValues = new Set(checks.map(c => c.value));
      checks.forEach(c => { c.checked = true; });
      updateCountryFilterButtonLabel();
      checkActiveLayerInControl();
      if (currentAttribute) applyClassification();
      else renderDefaultFilteredLayer();
    });
  }
  if (btnCountryClear) {
    btnCountryClear.addEventListener('click', () => {
      const checks = Array.from(document.querySelectorAll('#country-filter-list input[type="checkbox"]'));
      checks.forEach(c => { c.checked = false; });
      selectedCountryValues = new Set();
      updateCountryFilterButtonLabel();
      uncheckActiveLayerInControl();
      if (currentAttribute) applyClassification();
      else renderDefaultFilteredLayer();
    });
  }
  if (africaBtn) {
    africaBtn.addEventListener('click', () => {
      const cont = document.getElementById('continent-filter');
      if (!cont || !activeContinentField) {
        showPopup("Continent field not found in this layer.", "error");
        return;
      }
      const africaOpt = Array.from(cont.querySelectorAll('input[type="checkbox"]')).find(o => isAfricaContinentValue(o.value));
      if (!africaOpt) {
        showPopup("No 'Africa' value found in continent field.", "error");
        return;
      }
      Array.from(cont.querySelectorAll('input[type="checkbox"]')).forEach(o => {
        o.checked = norm(o.value) === norm(africaOpt.value);
      });
      selectedContinentValues = new Set([africaOpt.value]);
      updateContinentFilterButtonLabel();
      selectedCountryValues = new Set();
      populateCountryFilterOptions(geojsonData);
      checkActiveLayerInControl();
      if (currentAttribute) applyClassification();
      else renderDefaultFilteredLayer();
    });
  }
})();
//Popup Helper, Sidebar Toggles, and Page Load UI
// --- Popup helper ---
function showPopup(msg, type = "error") {
  let popup = document.getElementById("popup-message");
  if (!popup) {
    popup = document.createElement("div");
    popup.id = "popup-message";
    popup.className = "popup-message";
    document.body.appendChild(popup);
  }

  popup.classList.remove('popup-error', 'popup-success');
  popup.classList.add(type === 'error' ? 'popup-error' : 'popup-success');
  popup.textContent = msg;
  popup.style.display = 'block';

  setTimeout(() => { popup.style.display = 'none'; }, 6000);
}

// --- Sidebar toggle helpers (buttons cached) ---
const btnClassTable = document.getElementById('btnToggleClassTable');
function toggleClassTable() {
  const wrap = document.getElementById('classification-wrapper');
  if (!wrap || !btnClassTable) return;
  const hidden = window.getComputedStyle(wrap).display === 'none';
  wrap.style.display = hidden ? 'block' : 'none';
  btnClassTable.classList.toggle('active', hidden);
}

// Keep initial viewport consistent on full reloads.
if ('scrollRestoration' in window.history) {
  window.history.scrollRestoration = 'manual';
}

function resetInitialScrollPositions() {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  ['sidebar', 'right-sidebar', 'classification-wrapper'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.scrollTop = 0;
  });
}

// On page load show panels
window.addEventListener('DOMContentLoaded', () => {
  const tbl  = document.getElementById('table-container');
  const wrap = document.getElementById('classification-wrapper');

  if (wrap && btnClassTable) {
    wrap.style.display = 'block';
    btnClassTable.classList.add('active');
  }

  resetInitialScrollPositions();
});

window.addEventListener('load', resetInitialScrollPositions);

        // --- Secure Export Helper ---
    function compositeExportElement(cb) {
    leafletImage(map, (err, mapCanvas) => {
      if (err) {
        console.error("Leaflet image export failed:", err);
        return;
      }
      if (!mapCanvas) {
        console.warn("No map canvas returned");
        return;
      }

      const mapEl = document.getElementById('map');
      const holderEl = document.getElementById('map-container');
      const cssW = mapEl ? mapEl.clientWidth : mapCanvas.width;
      const cssH = holderEl
        ? Math.min(holderEl.clientHeight || mapCanvas.height, mapEl ? mapEl.clientHeight : mapCanvas.height)
        : (mapEl ? mapEl.clientHeight : mapCanvas.height);
      const rawScaleX = cssW > 0 ? (mapCanvas.width / cssW) : 1;
      const rawScaleY = (mapEl && mapEl.clientHeight > 0) ? (mapCanvas.height / mapEl.clientHeight) : rawScaleX;
      const expectedW = Math.round(cssW * rawScaleX);
      const expectedH = Math.round(cssH * rawScaleY);
      const cropW = Math.max(1, Math.min(expectedW, mapCanvas.width));
      const cropH = Math.max(1, Math.min(expectedH, mapCanvas.height));

      const cropped = document.createElement('canvas');
      cropped.width = cropW;
      cropped.height = cropH;
      const cctx = cropped.getContext('2d');
      cctx.drawImage(mapCanvas, 0, 0, cropW, cropH, 0, 0, cropW, cropH);

      const W = cropW;
      const H = cropH;

      const wrapper = document.createElement('div');
      wrapper.className = 'export-wrapper';
      wrapper.style.width = W + 'px';
      document.body.appendChild(wrapper);

      // Title (safe insertion)
      const titleEl = document.getElementById('map-title');
      if (titleEl) {
        const t = document.createElement('h1');
        t.className = 'export-title';
        t.textContent = titleEl.textContent || "Map Export"; // safe fallback
        // enforce a reasonable export title size to avoid oversized fonts
        t.style.fontSize = '20px';
        t.style.fontWeight = '600';
        t.style.margin = '0 0 8px 0';
        wrapper.appendChild(t);
      }

      // Map image container
      const mapWrapper = document.createElement('div');
      mapWrapper.className = 'export-map-wrapper';
      mapWrapper.style.width = W + 'px';
      mapWrapper.style.height = H + 'px';
      wrapper.appendChild(mapWrapper);

      // Add export-specific styles to normalize title/disclaimer for canvas export
      const styleEl = document.createElement('style');
      styleEl.type = 'text/css';
      styleEl.textContent = `
        .export-title{font-size:20px !important;font-weight:600;margin:0 0 8px 0;line-height:1}
        .export-map-wrapper .export-disclaimer-clone{font-size:10px !important;background:rgba(255,255,255,0.95) !important;padding:6px !important;word-break:break-word !important;display:block !important;width:fit-content !important;text-align:left !important;max-height:calc(1.25em * 6) !important;overflow:hidden !important;white-space:normal !important;line-height:1.25 !important}
        .export-img{width:100%;height:auto;display:block}
      `;
      wrapper.appendChild(styleEl);

      const img = document.createElement('img');
      img.className = 'export-img';
      img.src = cropped.toDataURL("image/png"); // explicit MIME type
      img.alt = "Exported map image";             // accessibility
      mapWrapper.appendChild(img);

      function cloneMapOverlayToExport(selector, className) {
        const source = document.querySelector(selector);
        if (!source || !mapEl) return;
        const mapRect = mapEl.getBoundingClientRect();
        const srcRect = source.getBoundingClientRect();
        if (!srcRect || srcRect.width <= 0 || srcRect.height <= 0) return;

        const clone = source.cloneNode(true);
        if (className) clone.classList.add(className);

        const relLeftCss = srcRect.left - mapRect.left;
        const relTopCss = srcRect.top - mapRect.top;
        const exportLeft = Math.max(0, Math.round(relLeftCss * rawScaleX));
        const exportTop = Math.max(0, Math.round(relTopCss * rawScaleY));
        const exportWidth = Math.max(1, Math.round(srcRect.width * rawScaleX));
        const exportHeight = Math.max(1, Math.round(srcRect.height * rawScaleY));

        clone.style.position = 'absolute';
        clone.style.left = exportLeft + 'px';
        clone.style.top = exportTop + 'px';
        clone.style.right = 'auto';
        clone.style.bottom = 'auto';
        clone.style.width = exportWidth + 'px';
        clone.style.height = exportHeight + 'px';
        clone.style.margin = '0';
        clone.style.transform = 'none';
        clone.style.cursor = 'default';
        clone.style.pointerEvents = 'none';
        mapWrapper.appendChild(clone);
      }

      // Disclaimer inside map (cloned safely)
      const disclaimer = document.querySelector('#disclaimer');
      if (disclaimer) {
        const clone = disclaimer.cloneNode(true);
        clone.className = 'export-disclaimer-clone';
        // Preserve user-dragged disclaimer position in exports.
        const mapRect = mapEl ? mapEl.getBoundingClientRect() : null;
        const discRect = disclaimer.getBoundingClientRect();
        const relLeftCss = mapRect ? (discRect.left - mapRect.left) : 10;
        const relTopCss = mapRect ? (discRect.top - mapRect.top) : 10;
        const exportLeft = Math.max(0, Math.round(relLeftCss * rawScaleX));
        const exportTop = Math.max(0, Math.round(relTopCss * rawScaleY) - 10);
        const exportWidth = Math.max(130, Math.round(discRect.width * rawScaleX * 1.08));
        clone.style.left = exportLeft + 'px';
        clone.style.top = exportTop + 'px';
        clone.style.right = 'auto';
        clone.style.bottom = 'auto';
        clone.style.width = 'fit-content';
        clone.style.maxWidth = exportWidth + 'px';
        clone.style.maxHeight = 'none';
        clone.style.overflow = 'visible';
        clone.style.whiteSpace = 'normal';
        clone.style.lineHeight = '1.25';
        clone.style.fontSize = '10px';
        clone.style.padding = '6px';
        mapWrapper.appendChild(clone);
      }

      // Export map overlays: north arrow + scale label
      cloneMapOverlayToExport('.leaflet-control-north-arrow', 'export-north-arrow-clone');
      cloneMapOverlayToExport('.leaflet-control-exact-scale', 'export-scale-clone');

      // Legend stacked below (cloned safely)
      const legend = document.querySelector('#legend-items');
      if (legend) {
        const clone = legend.cloneNode(true);
        clone.className = 'export-legend-clone';
        wrapper.appendChild(clone);
      }

      const runCb = () => {
        try {
          cb(wrapper);
        } catch (err) {
          console.error("Export callback failed:", err);
        }
      };

      if (img.decode) {
        img.decode().then(runCb).catch(runCb);
      } else if (img.complete) {
        runCb();
      } else {
        img.onload = runCb;
        img.onerror = runCb;
      }
    });
    }

    // --- Helper: show/hide loading message with spinner ---
    function showLoading(msg = "Exporting, please wait...") {
    let loader = document.getElementById("export-loader");
    if (!loader) {
    loader = document.createElement('div');
    loader.id = 'export-loader';
    loader.className = 'export-loader';

    const spinner = document.createElement('div');
    spinner.className = 'export-spinner';

    const text = document.createElement('div');
    text.textContent = msg;

    loader.appendChild(spinner);
    loader.appendChild(text);
    document.body.appendChild(loader);
    } else {
    loader.querySelector("div:last-child").textContent = msg;
    loader.style.display = "flex";
    }
    }

    function hideLoading() {
    const loader = document.getElementById("export-loader");
    if (loader) loader.style.display = "none";
    }
    function exportMap() {
      showLoading("Exporting map as PNG...");
      compositeExportElement(wrapper => {
        const canvasScale = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1));
        html2canvas(wrapper, {
          scale: canvasScale,
          useCORS: true,
          backgroundColor: "#ffffff",
          width: wrapper.scrollWidth,
          height: wrapper.scrollHeight,
          windowWidth: wrapper.scrollWidth,
          windowHeight: wrapper.scrollHeight
        })
          .then(canvas => {
            const a = document.createElement('a');
            a.href = canvas.toDataURL('image/png');
            a.download = 'map.png';
            a.rel = 'noopener';
            a.click();
            document.body.removeChild(wrapper);
            hideLoading();
          })
          .catch(err => {
            console.error("PNG export failed:", err);
            document.body.removeChild(wrapper);
            hideLoading();
          });
      });
    }

      function exportPDF() {
        showLoading("Exporting map as PDF...");
        compositeExportElement(wrapper => {
            const canvasScale = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1));
            html2canvas(wrapper, {
              scale: canvasScale,
              useCORS: true,
              backgroundColor: "#ffffff",
              width: wrapper.scrollWidth,
              height: wrapper.scrollHeight,
              windowWidth: wrapper.scrollWidth,
              windowHeight: wrapper.scrollHeight
            })
            .then(canvas => {
              const imgData = canvas.toDataURL('image/png');
              const orientation = canvas.width >= canvas.height ? 'landscape' : 'portrait';
              const pdf = new jspdf.jsPDF({
                orientation,
                unit: 'px',
                format: [canvas.width, canvas.height]
              });
              pdf.addImage(imgData, 'PNG', 0, 0, canvas.width, canvas.height);
              pdf.save('map.pdf');
              document.body.removeChild(wrapper);
              hideLoading();
            })
            .catch(err => {
              console.error("PDF export failed:", err);
              document.body.removeChild(wrapper);
              hideLoading();
            });
        });
      }

  //Start of Export SVG
  // Security / limits (tune as needed)
//const MAX_FEATURES = 5000;
//const MAX_VERTICES = 100000;
const MAX_TEXT_LENGTH = 2000;

// Helper: safe text extraction and truncation
function safeText(node) {
  if (!node) return "";
  return String(node.textContent || "").slice(0, MAX_TEXT_LENGTH);
}

// Helper: test whether canvas is exportable (toDataURL won't throw)
function tryCanvasToDataURL(canvas) {
  try {
    return canvas.toDataURL("image/png");
  } catch (e) {
    console.warn("Canvas toDataURL failed (tainted?):", e);
    return null;
  }
}

// Assumes MAX_FEATURES, MAX_VERTICES, MAX_TEXT_LENGTH, safeText, tryCanvasToDataURL, getPointRadius, getLineWidth, defaultStyle, sanitizeName, showLoading, hideLoading, showPopup, exportMap, overlayData, geojsonData, currentLayerName, map are defined elsewhere.
function exportSVG() {
  showLoading("Exporting map as SVG...");

  const sourceData = geojsonData || (overlayData[currentLayerName] && overlayData[currentLayerName].geojson);
  const data = getFilteredGeojson(sourceData);
  if (!data || !Array.isArray(data.features) || !data.features.length) {
    showPopup("No vector data available for SVG export. Falling back to PNG.", "error");
    hideLoading();
    return exportMap();
  }
  if (data.features.length > MAX_FEATURES) {
    showPopup("Dataset too large for client export", "error");
    hideLoading();
    return;
  }

  // Vertex guard
  let totalVertices = 0;
  (function countVertices(features) {
    features.forEach(f => {
      const g = f.geometry;
      if (!g) return;
      const walk = coords => {
        if (!coords) return;
        if (typeof coords[0] === "number") totalVertices++;
        else coords.forEach(c => walk(c));
      };
      if (g.type === "Point") totalVertices++;
      else walk(g.coordinates);
    });
  })(data.features);
  if (totalVertices > MAX_VERTICES) {
    showPopup("Dataset too complex for client export. Try simplifying the geometry.", "error");
    hideLoading();
    return;
  }

  const titleEl = document.getElementById('map-title');
  const legendEl = document.getElementById('legend-items');
  const disclaimerEl = document.getElementById('disclaimer');
  const northArrowEl = document.querySelector('.leaflet-control-north-arrow');
  const scaleBarEl = document.querySelector('.leaflet-control-exact-scale');
  const mapEl = document.getElementById('map');
  if (!mapEl) {
    console.error("Map element not found");
    hideLoading();
    return;
  }

  leafletImage(map, (err, mapCanvas) => {
    if (err || !mapCanvas) {
      showPopup("Raster capture failed (possible CORS). Exporting PNG instead.", "error");
      hideLoading();
      return exportMap();
    }

    // detect tainted canvas
    const canvasDataUrlCheck = tryCanvasToDataURL(mapCanvas);
    if (!canvasDataUrlCheck) {
      showPopup("Export blocked by cross-origin tiles. Enable CORS or use PNG fallback.", "error");
      hideLoading();
      return exportMap();
    }

    try {
      const svgNS = "http://www.w3.org/2000/svg";
      const XLINK = "http://www.w3.org/1999/xlink";

      // authoritative canvas pixels from leafletImage
      const canvasPixelWidth  = mapCanvas.width;
      const canvasPixelHeight = mapCanvas.height;

      // container CSS size and scale factor
      const holderEl = document.getElementById('map-container');
      const containerWidth  = mapEl.clientWidth || canvasPixelWidth;
      const containerHeight = holderEl
        ? Math.min(holderEl.clientHeight || canvasPixelHeight, mapEl.clientHeight || canvasPixelHeight)
        : (mapEl.clientHeight || canvasPixelHeight);
      // clamp scale to avoid excessively large exported font sizes when
      // device or canvas ratios are large. Keep within [1,2] for stability.
      const rawScaleX = containerWidth > 0 ? (canvasPixelWidth / containerWidth) : 1;
      const rawScaleY = containerHeight > 0 ? (canvasPixelHeight / containerHeight) : rawScaleX;
      const scale = Math.min(Math.max(rawScaleX, 1), 2);

      // title/legend heights (CSS -> canvas px)
      const marginCss = 10;
      const titleHeightCss = titleEl ? (titleEl.getBoundingClientRect().height + marginCss) : 0;
      const legendHeightCss = legendEl ? (legendEl.getBoundingClientRect().height + marginCss) : 0;
      const titleHeightPx  = Math.round(titleHeightCss * scale);
      const marginPx = Math.round(marginCss * scale);

      const overlay = overlayData[currentLayerName] || {};
      const legendRows = (overlay.vals && overlay.cols)
        ? (overlay.isNumeric ? Math.max(0, overlay.vals.length - 1) : overlay.vals.length)
        : 0;
      const legendBoxSize = Math.max(8, Math.round(12 * scale));
      const legendRowGap = Math.round(6 * scale);
      const legendHeaderGap = Math.round(18 * scale);
      const computedLegendHeightPx = legendRows
        ? (marginPx + legendHeaderGap + (legendRows * (legendBoxSize + legendRowGap)))
        : 0;
      const legendHeightPx = Math.max(Math.round(legendHeightCss * scale), computedLegendHeightPx);

      // expected canvas pixels for visible map area
      const expectedCanvasW = Math.round(containerWidth * rawScaleX);
      const expectedCanvasH = Math.round(containerHeight * rawScaleY);

      // LEFT-ALIGNED CROP: use cropX = 0 to avoid centered empty right area
      const cropW = Math.min(expectedCanvasW, canvasPixelWidth);
      const cropH = Math.min(expectedCanvasH, canvasPixelHeight);
      const cropX = 0; // left-align crop
      const cropY = 0; // top-align crop

      // Debug logging to help tune if needed
      console.info("SVG export debug:",
        { canvasPixelWidth, canvasPixelHeight, containerWidth, containerHeight, scale,
          expectedCanvasW, expectedCanvasH, cropW, cropH, cropX, cropY, titleHeightPx, legendHeightPx });

      // draw cropped region to offscreen canvas
      const cropped = document.createElement('canvas');
      cropped.width = cropW;
      cropped.height = cropH;
      const cctx = cropped.getContext('2d');
      cctx.drawImage(mapCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

      const usedCanvasWidth  = cropW;
      const usedCanvasHeight = cropH;

      const totalWidthPx  = usedCanvasWidth;
      const totalHeightPx = titleHeightPx + usedCanvasHeight + legendHeightPx + (marginPx * 2);

      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("xmlns", svgNS);
      svg.setAttribute("xmlns:xlink", XLINK);
      svg.setAttribute("width", String(totalWidthPx));
      svg.setAttribute("height", String(totalHeightPx));
      svg.setAttribute("style", "display:block;margin:0 auto;");
      svg.setAttribute("viewBox", `0 0 ${totalWidthPx} ${totalHeightPx}`);
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

      // background
      const bg = document.createElementNS(svgNS, "rect");
      bg.setAttribute("x", "0");
      bg.setAttribute("y", "0");
      bg.setAttribute("width", String(totalWidthPx));
      bg.setAttribute("height", String(totalHeightPx));
      bg.setAttribute("fill", "#ffffff");
      svg.appendChild(bg);

      // title (clamped font size for consistency)
      const safeTitle = safeText(titleEl);
      if (safeTitle) {
        const title = document.createElementNS(svgNS, "text");
        title.setAttribute("x", String(totalWidthPx / 2));
        title.setAttribute("y", String(Math.max(Math.round(18 * scale), titleHeightPx - Math.round(marginPx / 2))));
        title.setAttribute("text-anchor", "middle");
        title.setAttribute("font-family", "Segoe UI, sans-serif");
        // clamp font size between 12px and 24px to avoid oversized headings
        const fs = Math.round(Math.max(12, Math.min(24, 18 * scale)));
        title.setAttribute("font-size", String(fs));
        title.setAttribute("font-weight", "600");
        title.textContent = safeTitle;
        svg.appendChild(title);
      }

      // embed cropped image
      const imgDataUrl = cropped.toDataURL("image/png");
      const img = document.createElementNS(svgNS, "image");
      img.setAttributeNS(XLINK, "xlink:href", imgDataUrl);
      img.setAttribute("x", "0");
      img.setAttribute("y", String(titleHeightPx));
      img.setAttribute("width", String(usedCanvasWidth));
      img.setAttribute("height", String(usedCanvasHeight));
      svg.appendChild(img);

      // project coords into cropped canvas pixel space (subtract crop offsets)
      function projectCoordToCanvas(coord) {
        const latlng = L.latLng(coord[1], coord[0]);
        const layerPoint = map.latLngToLayerPoint(latlng);
        const containerPoint = map.layerPointToContainerPoint(layerPoint); // CSS px
        const x = (containerPoint.x * scale) - cropX;
        const y = (containerPoint.y * scale) - cropY + titleHeightPx;
        return [x, y];
      }

      // style helper
      function styleForFeature(f) {
        const ds = defaultStyle(f);
        const style = {
          fill: ds.fillColor || "none",
          stroke: ds.color || "#000",
          strokeWidth: ds.weight != null ? ds.weight : getLineWidth(),
          fillOpacity: ds.fillOpacity != null ? ds.fillOpacity : 0.6
        };
        if (overlay.vals && overlay.cols && currentAttribute) {
          if (overlay.isNumeric && Array.isArray(overlay.vals) && overlay.vals.length > 1) {
            const v = Number(f.properties?.[currentAttribute]);
            for (let i = 0; i < overlay.vals.length - 1; i++) {
              if (v >= overlay.vals[i] && v <= overlay.vals[i + 1]) {
                style.fill = overlay.cols[i] || style.fill;
                break;
              }
            }
          } else if (!overlay.isNumeric) {
            const idx = (overlay.vals || []).indexOf(f.properties?.[currentAttribute]);
            if (idx >= 0) style.fill = overlay.cols[idx] || style.fill;
          }
        }
        return style;
      }

      // draw features
      data.features.forEach(feature => {
        const geom = feature.geometry;
        if (!geom) return;
        const style = styleForFeature(feature);

        if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
          const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
          polys.forEach(polygon => {
            polygon.forEach((ring, rIdx) => {
              const path = document.createElementNS(svgNS, "path");
              const d = ring.map((coord, i) => {
                const [x, y] = projectCoordToCanvas(coord);
                return (i === 0 ? "M" : "L") + x + " " + y;
              }).join(" ") + " Z";
              path.setAttribute("d", d);
              path.setAttribute("fill", rIdx === 0 ? (style.fill || "none") : "#ffffff");
              path.setAttribute("stroke", style.stroke || "#000");
              path.setAttribute("stroke-width", String(Math.max(0.5, style.strokeWidth * scale)));
              path.setAttribute("fill-opacity", String(style.fillOpacity));
              svg.appendChild(path);
            });
          });
        } else if (geom.type === "LineString" || geom.type === "MultiLineString") {
          const lines = geom.type === "LineString" ? [geom.coordinates] : geom.coordinates;
          lines.forEach(line => {
            const path = document.createElementNS(svgNS, "path");
            const d = line.map((coord, i) => {
              const [x, y] = projectCoordToCanvas(coord);
              return (i === 0 ? "M" : "L") + x + " " + y;
            }).join(" ");
            path.setAttribute("d", d);
            path.setAttribute("fill", "none");
            path.setAttribute("stroke", style.stroke || "#000");
            path.setAttribute("stroke-width", String(Math.max(0.5, style.strokeWidth * scale)));
            svg.appendChild(path);
          });
        } else if (geom.type === "Point" || geom.type === "MultiPoint") {
          const pts = geom.type === "Point" ? [geom.coordinates] : geom.coordinates;
          pts.forEach(coord => {
            const [x, y] = projectCoordToCanvas(coord);
            const circle = document.createElementNS(svgNS, "circle");
            const r = Math.max(1, Math.round(getPointRadius() * scale));
            circle.setAttribute("cx", String(x));
            circle.setAttribute("cy", String(y));
            circle.setAttribute("r", String(r));
            circle.setAttribute("fill", style.fill || "#ccc");
            circle.setAttribute("stroke", style.stroke || "#000");
            circle.setAttribute("stroke-width", String(Math.max(0.5, style.strokeWidth * scale)));
            svg.appendChild(circle);
          });
        }
      });

      // disclaimer rendered as pure SVG to avoid foreignObject inconsistencies
      const safeDisclaimer = safeText(disclaimerEl);
      if (safeDisclaimer) {
        const discRect = disclaimerEl ? disclaimerEl.getBoundingClientRect() : null;
        const mapRect = mapEl ? mapEl.getBoundingClientRect() : null;
        const discX = discRect && mapRect
          ? Math.max(0, Math.round((discRect.left - mapRect.left) * rawScaleX) - cropX)
          : marginPx;
        const desiredWidth = discRect ? Math.round(discRect.width * rawScaleX * 1.18) : Math.round(230 * scale);
        let discWidth = Math.max(
          Math.round(120 * scale),
          Math.min(desiredWidth, Math.max(120, usedCanvasWidth - discX - marginPx))
        );
        const fontSizeDisc = Math.max(8, Math.round(10 * scale));
        const lineHeightDisc = Math.round(fontSizeDisc * 1.25);
        const padding = Math.max(4, Math.round(5 * scale));
        const maxLines = 6;
        const avgCharWidth = Math.max(5, Math.round(fontSizeDisc * 0.5));
        const maxCharsPerLine = Math.max(16, Math.floor((discWidth - (padding * 2)) / avgCharWidth));

        const words = safeDisclaimer.split(/\s+/).filter(Boolean);
        const lines = [];
        let line = "";
        for (let i = 0; i < words.length; i++) {
          const candidate = line ? (line + " " + words[i]) : words[i];
          if (candidate.length > maxCharsPerLine && line) {
            lines.push(line);
            line = words[i];
            if (lines.length >= maxLines) break;
          } else {
            line = candidate;
          }
        }
        if (lines.length < maxLines && line) lines.push(line);
        const truncated = lines.length >= maxLines && words.join(" ").length > lines.join(" ").length;
        if (truncated && lines.length) {
          lines[lines.length - 1] = lines[lines.length - 1].replace(/[.,;:!? ]+$/, "") + "...";
        }

        // Tighten SVG disclaimer box width using measured rendered text width.
        const mCanvas = document.createElement('canvas');
        const mCtx = mCanvas.getContext('2d');
        if (mCtx) mCtx.font = `${fontSizeDisc}px Segoe UI, sans-serif`;
        const measuredTextWidth = lines.reduce((m, ln) => {
          const w = mCtx ? Math.ceil(mCtx.measureText(ln).width) : Math.round(ln.length * avgCharWidth);
          return Math.max(m, w);
        }, 0);
        const tightWidth = Math.max(Math.round(120 * scale), measuredTextWidth + (padding * 2));
        discWidth = Math.min(discWidth, tightWidth);

        const discHeight = (padding * 2) + (lines.length * lineHeightDisc);
        const discY = discRect && mapRect
          ? titleHeightPx + Math.max(0, Math.round((discRect.top - mapRect.top) * rawScaleY) - cropY - 10)
          : (titleHeightPx + usedCanvasHeight - discHeight - marginPx);

        const discBg = document.createElementNS(svgNS, "rect");
        discBg.setAttribute("x", String(discX));
        discBg.setAttribute("y", String(discY));
        discBg.setAttribute("width", String(discWidth));
        discBg.setAttribute("height", String(discHeight));
        discBg.setAttribute("fill", "#ffffff");
        discBg.setAttribute("fill-opacity", "0.95");
        svg.appendChild(discBg);

        const discText = document.createElementNS(svgNS, "text");
        discText.setAttribute("x", String(discX + padding));
        discText.setAttribute("y", String(discY + padding + fontSizeDisc));
        discText.setAttribute("font-size", String(fontSizeDisc));
        discText.setAttribute("font-family", "Segoe UI, sans-serif");
        discText.setAttribute("fill", "#000");
        discText.setAttribute("text-anchor", "start");

        lines.forEach((ln, idx) => {
          const tspan = document.createElementNS(svgNS, "tspan");
          tspan.setAttribute("x", String(discX + padding));
          tspan.setAttribute("dy", idx === 0 ? "0" : String(lineHeightDisc));
          tspan.textContent = ln;
          discText.appendChild(tspan);
        });

        svg.appendChild(discText);
      }

      // north arrow (render from live control position)
      if (northArrowEl && mapEl) {
        const naRect = northArrowEl.getBoundingClientRect();
        const mapRect = mapEl.getBoundingClientRect();
        const naW = Math.max(1, Math.round(naRect.width * rawScaleX));
        const naH = Math.max(1, Math.round(naRect.height * rawScaleY));
        const naX = Math.max(0, Math.round((naRect.left - mapRect.left) * rawScaleX) - cropX);
        const naY = titleHeightPx + Math.max(0, Math.round((naRect.top - mapRect.top) * rawScaleY) - cropY);

        const naBg = document.createElementNS(svgNS, "rect");
        naBg.setAttribute("x", String(naX));
        naBg.setAttribute("y", String(naY));
        naBg.setAttribute("width", String(naW));
        naBg.setAttribute("height", String(naH));
        naBg.setAttribute("rx", String(Math.max(2, Math.round(3 * scale))));
        naBg.setAttribute("fill", "#ffffff");
        naBg.setAttribute("stroke", "#cfd6e4");
        svg.appendChild(naBg);

        const naText = document.createElementNS(svgNS, "text");
        naText.setAttribute("x", String(naX + Math.round(naW / 2)));
        naText.setAttribute("y", String(naY + Math.max(10, Math.round(12 * scale))));
        naText.setAttribute("text-anchor", "middle");
        naText.setAttribute("font-size", String(Math.max(9, Math.round(12 * scale))));
        naText.setAttribute("font-family", "Segoe UI, sans-serif");
        naText.setAttribute("font-weight", "700");
        naText.setAttribute("fill", "#1e3a8a");
        naText.textContent = "N";
        svg.appendChild(naText);

        const triW = Math.max(8, Math.round(12 * scale));
        const triH = Math.max(8, Math.round(12 * scale));
        const triCX = naX + Math.round(naW / 2);
        const triTop = naY + Math.max(14, Math.round(18 * scale));
        const tri = document.createElementNS(svgNS, "path");
        tri.setAttribute(
          "d",
          `M ${triCX} ${triTop} L ${triCX - Math.round(triW / 2)} ${triTop + triH} L ${triCX + Math.round(triW / 2)} ${triTop + triH} Z`
        );
        tri.setAttribute("fill", "#1e3a8a");
        svg.appendChild(tri);
      }

      // scale bar label (render from live control position/text)
      if (scaleBarEl && mapEl) {
        const sbRect = scaleBarEl.getBoundingClientRect();
        const mapRect = mapEl.getBoundingClientRect();
        const sbW = Math.max(1, Math.round(sbRect.width * rawScaleX));
        const sbH = Math.max(1, Math.round(sbRect.height * rawScaleY));
        const sbX = Math.max(0, Math.round((sbRect.left - mapRect.left) * rawScaleX) - cropX);
        const sbY = titleHeightPx + Math.max(0, Math.round((sbRect.top - mapRect.top) * rawScaleY) - cropY);
        const sbTextRaw = scaleBarEl.querySelector('.exact-scale-label')?.textContent || "Scale: --";
        const sbText = String(sbTextRaw).slice(0, MAX_TEXT_LENGTH);

        const sbBg = document.createElementNS(svgNS, "rect");
        sbBg.setAttribute("x", String(sbX));
        sbBg.setAttribute("y", String(sbY));
        sbBg.setAttribute("width", String(sbW));
        sbBg.setAttribute("height", String(sbH));
        sbBg.setAttribute("rx", String(Math.max(2, Math.round(3 * scale))));
        sbBg.setAttribute("fill", "#ffffff");
        sbBg.setAttribute("stroke", "#cfd6e4");
        svg.appendChild(sbBg);

        const sbTextEl = document.createElementNS(svgNS, "text");
        sbTextEl.setAttribute("x", String(sbX + Math.round(sbW / 2)));
        sbTextEl.setAttribute("y", String(sbY + Math.round(sbH / 2) + Math.round(3 * scale)));
        sbTextEl.setAttribute("text-anchor", "middle");
        sbTextEl.setAttribute("font-size", String(Math.max(8, Math.round(8 * scale))));
        sbTextEl.setAttribute("font-family", "Segoe UI, sans-serif");
        sbTextEl.setAttribute("font-weight", "400");
        sbTextEl.setAttribute("fill", "#102a43");
        sbTextEl.textContent = sbText;
        svg.appendChild(sbTextEl);
      }

            // legend below map (render from current legend DOM so all layers/symbol types are included)
      if (legendEl && legendEl.children && legendEl.children.length) {
        const legendGroup = document.createElementNS(svgNS, "g");
        const legendX = marginPx;
        let yOff = titleHeightPx + usedCanvasHeight + marginPx;
        const symSize = Math.max(8, Math.round(12 * scale));
        const fontSize = Math.max(10, Math.round(12 * scale));
        const rowGap = Math.max(3, Math.round(5 * scale));
        const blockGap = Math.max(6, Math.round(8 * scale));

        const blocks = Array.from(legendEl.querySelectorAll('.legend-block'));
        blocks.forEach(block => {
          const blockHeader = block.querySelector('.legend-header');
          if (blockHeader) {
            const h = document.createElementNS(svgNS, "text");
            h.setAttribute("x", String(legendX));
            h.setAttribute("y", String(yOff + fontSize));
            h.setAttribute("font-size", String(fontSize));
            h.setAttribute("font-weight", "600");
            h.textContent = safeText(blockHeader) || "Legend";
            legendGroup.appendChild(h);
            yOff += Math.round(fontSize + rowGap + 2);
          }

          const rows = Array.from(block.querySelectorAll('.legend-row'));
          rows.forEach(row => {
            const symEl = row.querySelector('.legend-sym');
            const lblEl = row.querySelector('span');
            const fillColor = (symEl && symEl.style && symEl.style.backgroundColor) || '#ccc';

            if (symEl && symEl.classList.contains('legend-sym-line')) {
              const line = document.createElementNS(svgNS, "line");
              line.setAttribute("x1", String(legendX));
              line.setAttribute("y1", String(yOff + Math.round(symSize / 2)));
              line.setAttribute("x2", String(legendX + symSize));
              line.setAttribute("y2", String(yOff + Math.round(symSize / 2)));
              line.setAttribute("stroke", fillColor);
              line.setAttribute("stroke-width", String(Math.max(2, Math.round(2 * scale))));
              legendGroup.appendChild(line);
            } else if (symEl && symEl.classList.contains('legend-sym-point')) {
              const c = document.createElementNS(svgNS, "circle");
              c.setAttribute("cx", String(legendX + Math.round(symSize / 2)));
              c.setAttribute("cy", String(yOff + Math.round(symSize / 2)));
              c.setAttribute("r", String(Math.max(3, Math.round(symSize / 3))));
              c.setAttribute("fill", fillColor);
              c.setAttribute("stroke", "#333");
              c.setAttribute("stroke-width", "1");
              legendGroup.appendChild(c);
            } else {
              const rect = document.createElementNS(svgNS, "rect");
              rect.setAttribute("x", String(legendX));
              rect.setAttribute("y", String(yOff));
              rect.setAttribute("width", String(symSize));
              rect.setAttribute("height", String(symSize));
              rect.setAttribute("fill", fillColor);
              rect.setAttribute("stroke", "#333");
              legendGroup.appendChild(rect);
            }

            const t = document.createElementNS(svgNS, "text");
            t.setAttribute("x", String(legendX + symSize + Math.round(6 * scale)));
            t.setAttribute("y", String(yOff + symSize - Math.round(2 * scale)));
            t.setAttribute("font-size", String(fontSize));
            t.textContent = safeText(lblEl);
            legendGroup.appendChild(t);

            yOff += symSize + rowGap;
          });

          yOff += blockGap;
        });

        svg.appendChild(legendGroup);
      }
// serialize and download
      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(svg);
      const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = (currentLayerName ? sanitizeName(currentLayerName) : "map") + ".svg";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();

      setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch (e) {}
        a.remove();
      }, 1000);

      hideLoading();
    } catch (ex) {
      console.error("SVG export failed:", ex);
      showPopup("SVG export failed. Falling back to PNG.", "error");
      hideLoading();
      exportMap();
    }
  });
}


//end of export SVG

//Small Helpers (color palette) and DOMContentLoaded UI wiring
// --- Simple color palette generator (used when categorical) ---
function generateColorPalette(n) {
  const base = ["#1f77b4","#ff7f0e","#2ca02c","#d62728","#9467bd","#8c564b","#e377c2","#7f7f7f","#bcbd22","#17becf"];
  if (n <= base.length) return base.slice(0, n);
  const out = [];
  for (let i = 0; i < n; i++) out.push(base[i % base.length]);
  return out;
}

// --- DOMContentLoaded: small UI wiring for file/url preview and errors ---
document.addEventListener("DOMContentLoaded", () => {
  const fileInput = document.getElementById("file-upload");
  const fileNameDisplay = document.getElementById("file-name");
  const urlInput = document.getElementById("geojson-url");
  const addButton = document.getElementById("add-geojson-url");
  const mapTitle = document.getElementById("map-title");

  if (mapTitle) {
    mapTitle.setAttribute("contenteditable", "true");
    mapTitle.setAttribute("role", "textbox");
    mapTitle.setAttribute("aria-label", "Map title");
    mapTitle.spellcheck = false;
    mapTitle.textContent = sanitizePlainText(mapTitle.textContent, "Custom Map Title");
    mapTitle.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData)?.getData("text") || "";
      insertTextAtCaret(mapTitle, text);
    });
    mapTitle.addEventListener("blur", () => {
      mapTitle.textContent = sanitizePlainText(mapTitle.textContent, "Custom Map Title");
    });
  }

  // Wire export and UI buttons (avoid inline onclick handlers)
  const btnExportImage = document.getElementById('btnExportImage');
  if (btnExportImage) btnExportImage.addEventListener('click', () => { try { exportMap(); } catch(e){console.error(e);} });

  const btnExportPDF = document.getElementById('btnExportPDF');
  if (btnExportPDF) btnExportPDF.addEventListener('click', () => { try { exportPDF(); } catch(e){console.error(e);} });

  const btnExportSVG = document.getElementById('btnExportSVG');
  if (btnExportSVG) btnExportSVG.addEventListener('click', () => { try { exportSVG(); } catch(e){console.error(e);} });

  const btnToggle = document.getElementById('btnToggleClassTable');
  if (btnToggle) btnToggle.addEventListener('click', () => { try { toggleClassTable(); } catch(e){console.error(e);} });

  if (!fileInput || !fileNameDisplay || !addButton || !urlInput) {
    console.warn("Some expected import UI elements are missing.");
  }
});


