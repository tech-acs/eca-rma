// --- Globals & Utilities ---
const MAX_SIZE = 1024 * 1024 * 1024; // 1 GB limit used in handlers
const MAX_FEATURES = 1000000;// adjust to device expectations
const MAX_VERTICES = 10000000; // total coordinate points across all features
const MAX_REMOTE_IMPORT_BYTES = 512 * 1024 * 1024; // 512 MB cap for URL imports
const REMOTE_IMPORT_TIMEOUT_MS = 300000; // 300s timeout for URL imports
const SCALE_BAR_OFFSET_X_PX = 43;
const SCALE_BAR_OFFSET_Y_PX = 7;
const MAX_ZIP_ENTRIES = 50;
const MAX_ZIP_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024; // 1 GB expanded cap
const MAX_ZIP_EXPANSION_RATIO = 100; // expanded/compressed ratio
const ALLOWED_SHAPEFILE_ZIP_EXTENSIONS = new Set([
  ".shp",
  ".shx",
  ".dbf",
  ".prj",
  ".cpg",
  ".sbn",
  ".sbx",
  ".qix",
  ".aih",
  ".ain",
  ".atx",
  ".xml"
]);
const EXPORT_SIDE_CROP_RATIO = 0.06;
const EXPORT_SIDE_CROP_EXTRA_PX = 10;
const EDGE_EXPORT_SIDE_CROP_MAX_RATIO = 0.16;
const EDGE_EXPORT_FIXED_SIDE_CROP_PX = 40;
const CHROME_EXPORT_FIXED_SIDE_CROP_PX = 40;
const EDGE_EXPORT_MAX_PANE_OFFSET_PX = 48;
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
const UN_COUNTRIES_LOCAL_URL = "./UN_reference_countries_UNSD.json"; // local UN/M49-style reference table
const UN_COUNTRIES_REMOTE_URL = "https://unstats.un.org/unsd/methodology/m49/overview"; // UN M49 overview
const WORLD_BOUNDARY_REMOTE_URL = "https://cdn.jsdelivr.net/gh/johan/world.geo.json@master/countries.geo.json";
const WORLD_COUNTRIES_REMOTE_URL = "https://cdn.jsdelivr.net/npm/world-countries@5.1.0/dist/countries.json";
const MIN_REFERENCE_COUNTRY_COUNT = 150;
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
    document.documentElement.setAttribute("data-ui-hidden", "1");
  } catch (e) {}
  throw new Error("Framed execution is blocked.");
}
// --- Helpers ---
let dynamicSheet = null;
let dynamicStyleSeq = 0;

function initDynamicSheet() {
  if (dynamicSheet) return dynamicSheet;
  const sheets = Array.from(document.styleSheets || []);
  dynamicSheet = sheets.find(s => {
    try {
      return s && s.href && /dynamic\.css/i.test(s.href);
    } catch (e) {
      return false;
    }
  }) || null;
  if (!dynamicSheet) {
    // Fallback: no dynamic sheet available
    console.warn("dynamic.css not found; dynamic styles will be limited.");
  }
  return dynamicSheet;
}

function ensureDynamicRuleId(el) {
  if (!el) return "";
  if (el.dataset && el.dataset.dynId) return el.dataset.dynId;
  const id = "dyn-" + (++dynamicStyleSeq);
  el.dataset.dynId = id;
  return id;
}

function upsertDynamicRule(el, declarations) {
  const sheet = initDynamicSheet();
  if (!sheet || !declarations) return;
  const id = ensureDynamicRuleId(el);
  const selector = `[data-dyn-id="${id}"]`;
  const cssText = `${selector}{${declarations}}`;
  try {
    if (sheet.cssRules && sheet.cssRules.length) {
      for (let i = sheet.cssRules.length - 1; i >= 0; i--) {
        const rule = sheet.cssRules[i];
        if (rule && rule.selectorText === selector) {
          sheet.deleteRule(i);
          break;
        }
      }
    }
    const idx = sheet.cssRules ? sheet.cssRules.length : 0;
    sheet.insertRule(cssText, idx);
  } catch (e) {
    console.warn("Failed to update dynamic CSS rule:", e);
  }
}

function setDynamicStyle(el, styleObj) {
  if (!el || !styleObj) return;
  const parts = [];
  Object.keys(styleObj).forEach(k => {
    const v = styleObj[k];
    if (v == null || v === "") return;
    parts.push(`${k}:${v}`);
  });
  if (parts.length) upsertDynamicRule(el, parts.join(";"));
}

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
  const ext = getDataExtension(parsed.pathname);
  if (ext && ![".csv", ".geojson", ".json"].includes(ext)) {
    throw new Error("Only .csv, .geojson, or .json URLs are allowed when an extension is provided.");
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
    return {
      text,
      contentType: response.headers.get("Content-Type") || "",
      finalUrl: response.url || url
    };
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
    el.classList.add("force-show");
    el.classList.remove("force-hide");
    el.style.setProperty("display", "block", "important");
    setDynamicStyle(el, { display: "block" });
  } else {
    console.warn(`showRow: element not found: ${id}`);
  }
}

function hideRow(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove("force-show");
    el.classList.add("force-hide");
    el.style.setProperty("display", "none", "important");
    setDynamicStyle(el, { display: "none" });
  } else {
    console.warn(`hideRow: element not found: ${id}`);
  }
}

function formatNumber(val, decimals = 2) {
  const num = Number(val);
  if (isNaN(num)) return "NaN";
  return num.toFixed(decimals);
}

function roundToOneDecimal(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return NaN;
  const rounded = Math.round(num * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function formatLegendClassValue(val) {
  const num = Number(val);
  if (!Number.isFinite(num)) return String(val);
  const rounded = roundToOneDecimal(num);
  const nearestInt = Math.round(rounded);
  if (Math.abs(rounded - nearestInt) < 1e-9) return String(nearestInt);
  return rounded.toFixed(1);
}

function categoryKey(val) {
  return `${typeof val}::${String(val)}`;
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

function assertFinalImportUrlAllowed(finalUrl) {
  let parsed;
  try {
    parsed = new URL(finalUrl);
  } catch (e) {
    throw new Error("Remote import resolved to an invalid URL.");
  }
  const host = normalizeHostname(parsed.hostname);
  if (parsed.protocol !== "https:") {
    throw new Error("Remote redirect resolved to a non-HTTPS URL.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Remote redirect URL credentials are not allowed.");
  }
  if (parsed.port && parsed.port !== "443") {
    throw new Error("Remote redirect resolved to a blocked port.");
  }
  if (isBlockedPrivateImportHost(host)) {
    throw new Error("Remote redirect resolved to a private/internal host.");
  }
  if (ENFORCE_IMPORT_HOST_ALLOWLIST && !ALLOWED_IMPORT_HOSTS.has(host)) {
    throw new Error("Remote redirect host is not allowed by security policy.");
  }
  return parsed;
}

function detectContentType(contentType) {
  const ct = String(contentType || "").toLowerCase().split(";")[0].trim();
  return ct;
}

function isAllowedRemoteContentType(ext, contentType) {
  const ct = detectContentType(contentType);
  const JSON_TYPES = new Set([
    "application/json",
    "application/geo+json",
    "application/vnd.geo+json",
    "text/json"
  ]);
  const CSV_TYPES = new Set([
    "text/csv",
    "application/csv",
    "application/vnd.ms-excel"
  ]);
  if (!ct) return false;
  if (!ext) return CSV_TYPES.has(ct) || JSON_TYPES.has(ct);
  if (ext === ".csv") return CSV_TYPES.has(ct);
  return JSON_TYPES.has(ct);
}

function isLikelyCsvPayload(text) {
  const raw = String(text || "").trim();
  if (!raw) return false;
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return false;
  const header = String(lines[0] || "").toLowerCase();
  const hasDelimiter = /,|;|\t/.test(header);
  const hasLatField = /(latitude|lat)\b/.test(header);
  const hasLonField = /(longitude|lon|lng)\b/.test(header);
  return hasDelimiter && hasLatField && hasLonField;
}

function resolveRemoteImportExtension(initialExt, finalUrl, contentType) {
  const firstChoice = String(initialExt || "").toLowerCase();
  if (firstChoice === ".csv" || firstChoice === ".geojson" || firstChoice === ".json") {
    return firstChoice;
  }

  const finalExt = getDataExtension(finalUrl || "");
  if (finalExt === ".csv" || finalExt === ".geojson" || finalExt === ".json") {
    return finalExt;
  }

  const ct = detectContentType(contentType);
  if (ct === "text/csv" || ct === "application/csv" || ct === "application/vnd.ms-excel") {
    return ".csv";
  }
  if (ct === "application/json" || ct === "application/geo+json" || ct === "application/vnd.geo+json" || ct === "text/json") {
    return ".json";
  }
  return "";
}

function getUint16LE(view, offset) {
  if (offset + 2 > view.byteLength) return null;
  return view.getUint16(offset, true);
}

function getUint32LE(view, offset) {
  if (offset + 4 > view.byteLength) return null;
  return view.getUint32(offset, true);
}

function decodeZipEntryName(view, startOffset, byteLen) {
  if (!byteLen || startOffset + byteLen > view.byteLength) return "";
  const bytes = new Uint8Array(view.buffer, view.byteOffset + startOffset, byteLen);
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch (e) {
    let fallback = "";
    for (let i = 0; i < bytes.length; i++) {
      fallback += String.fromCharCode(bytes[i]);
    }
    return fallback;
  }
}

function assertShapefileZipEntryAllowed(rawEntryName) {
  const entryName = String(rawEntryName || "").replace(/\\/g, "/").trim();
  if (!entryName || entryName.endsWith("/")) return;
  if (entryName.startsWith("/") || entryName.includes("../") || entryName.includes("..\\")) {
    throw new Error("ZIP contains an unsafe file path.");
  }

  const lowerName = entryName.toLowerCase();
  const dotIndex = lowerName.lastIndexOf(".");
  const ext = dotIndex >= 0 ? lowerName.slice(dotIndex) : "";
  if (!ALLOWED_SHAPEFILE_ZIP_EXTENSIONS.has(ext)) {
    throw new Error("ZIP uploads must contain only shapefile components.");
  }
}

function inspectZipSafety(arrayBuffer, compressedSizeBytes) {
  const view = new DataView(arrayBuffer);
  const EOCD_SIGNATURE = 0x06054b50;
  const CD_SIGNATURE = 0x02014b50;
  const maxCommentLen = 0xffff;
  const minEocd = 22;
  if (view.byteLength < minEocd) {
    throw new Error("ZIP file is too small or invalid.");
  }

  let eocdOffset = -1;
  const start = Math.max(0, view.byteLength - minEocd - maxCommentLen);
  for (let i = view.byteLength - minEocd; i >= start; i--) {
    if (getUint32LE(view, i) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("ZIP central directory not found.");
  }

  const totalEntries = getUint16LE(view, eocdOffset + 10);
  const cdSize = getUint32LE(view, eocdOffset + 12);
  const cdOffset = getUint32LE(view, eocdOffset + 16);
  if (totalEntries === null || cdSize === null || cdOffset === null) {
    throw new Error("ZIP metadata is incomplete.");
  }
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported for security reasons.");
  }
  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw new Error(`ZIP has too many entries (${totalEntries}; max ${MAX_ZIP_ENTRIES}).`);
  }
  if (cdOffset + cdSize > view.byteLength) {
    throw new Error("ZIP central directory exceeds file bounds.");
  }

  let cursor = cdOffset;
  let parsedEntries = 0;
  let totalUncompressed = 0;
  let hasShpFile = false;
  while (parsedEntries < totalEntries) {
    if (cursor + 46 > view.byteLength) {
      throw new Error("ZIP central directory entry is truncated.");
    }
    const sig = getUint32LE(view, cursor);
    if (sig !== CD_SIGNATURE) {
      throw new Error("Invalid ZIP central directory entry signature.");
    }
    const uncompressedSize = getUint32LE(view, cursor + 24);
    const fileNameLen = getUint16LE(view, cursor + 28);
    const extraLen = getUint16LE(view, cursor + 30);
    const commentLen = getUint16LE(view, cursor + 32);
    const fileNameOffset = cursor + 46;
    if (uncompressedSize === null || fileNameLen === null || extraLen === null || commentLen === null) {
      throw new Error("ZIP entry metadata is incomplete.");
    }
    if (uncompressedSize === 0xffffffff) {
      throw new Error("ZIP64 entry sizes are not supported for security reasons.");
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES) {
      const maxMb = Math.round(MAX_ZIP_UNCOMPRESSED_BYTES / (1024 * 1024));
      throw new Error(`ZIP expands too large (max ${maxMb} MB).`);
    }
    const nextCursor = cursor + 46 + fileNameLen + extraLen + commentLen;
    if (nextCursor > view.byteLength) {
      throw new Error("ZIP central directory entry exceeds file bounds.");
    }
    const entryName = decodeZipEntryName(view, fileNameOffset, fileNameLen);
    assertShapefileZipEntryAllowed(entryName);
    if (/\.shp$/i.test(entryName)) {
      hasShpFile = true;
    }
    cursor = nextCursor;
    parsedEntries++;
  }

  if (!hasShpFile) {
    throw new Error("ZIP must include a .shp file.");
  }

  const compressed = Math.max(1, Number(compressedSizeBytes) || 1);
  const expansionRatio = totalUncompressed / compressed;
  if (expansionRatio > MAX_ZIP_EXPANSION_RATIO) {
    throw new Error(`ZIP expansion ratio is too high (${expansionRatio.toFixed(1)}x).`);
  }
}

async function fetchTextWithFallback(localUrl, remoteUrl, label) {
  if (!localUrl && remoteUrl) {
    const fetched = await fetchWithLimits(remoteUrl);
    return String(fetched?.text || "");
  }
  try {
    const fetched = await fetchWithLimits(localUrl);
    return String(fetched?.text || "");
  } catch (localErr) {
    if (!remoteUrl) {
      throw localErr;
    }
    const fetched = await fetchWithLimits(remoteUrl);
    return String(fetched?.text || "");
  }
}

function firstNonEmptyValue(obj, keys) {
  if (!obj || typeof obj !== "object" || !Array.isArray(keys)) return "";
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]];
    const clean = sanitizePlainText(v == null ? "" : v);
    if (clean) return clean;
  }
  return "";
}

function asArrayValue(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    return v.split(/[;,|]/).map(x => sanitizePlainText(x)).filter(Boolean);
  }
  return [];
}

function normalizeReferenceRows(raw) {
  const rows = Array.isArray(raw) ? raw : (Array.isArray(raw?.data) ? raw.data : []);
  return rows.map(row => {
    const country = firstNonEmptyValue(row, [
      "country",
      "country_name",
      "country_or_area",
      "Country or Area",
      "name",
      "name_common",
      "common_name"
    ]);
    const official = firstNonEmptyValue(row, [
      "official_name",
      "country_official_name",
      "UNTERM English Formal",
      "UNTERM English Short"
    ]);
    const region = firstNonEmptyValue(row, [
      "continent",
      "region",
      "region_name",
      "Region Name"
    ]);
    const subregion = firstNonEmptyValue(row, [
      "subregion",
      "sub_region",
      "subregion_name",
      "Sub-region Name"
    ]);
    const iso2 = firstNonEmptyValue(row, ["iso2", "iso_alpha2", "ISO-alpha2 Code"]);
    const iso3 = firstNonEmptyValue(row, ["iso3", "iso_alpha3", "ISO-alpha3 Code"]);
    const m49 = firstNonEmptyValue(row, ["m49", "M49 Code", "Country code"]);
    const continent = region ? normalizeContinentFromMeta(region, subregion) : "";
    const aliases = asArrayValue(row.alt_spellings || row.altSpellings || row.aliases || row.synonyms);
    if (country) aliases.push(country);
    if (official) aliases.push(official);

    return {
      country: sanitizePlainText(country),
      officialName: sanitizePlainText(official),
      continent: sanitizePlainText(continent),
      iso2: sanitizePlainText(iso2),
      iso3: sanitizePlainText(iso3),
      m49: sanitizePlainText(m49),
      aliases: Array.from(new Set(aliases.filter(Boolean)))
    };
  }).filter(x => x.country && x.continent);
}

function normalizeWorldCountriesRows(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  return rows.map(c => {
    const continent = normalizeContinentFromMeta(c?.region, c?.subregion);
    const country = sanitizePlainText(c?.name?.common || "");
    const officialName = sanitizePlainText(c?.name?.official || "");
    const aliases = [];
    if (country) aliases.push(country);
    if (officialName) aliases.push(officialName);
    (Array.isArray(c?.altSpellings) ? c.altSpellings : []).forEach(a => aliases.push(sanitizePlainText(a)));
    return {
      country,
      officialName,
      continent,
      iso2: sanitizePlainText(c?.cca2 || ""),
      iso3: sanitizePlainText(c?.cca3 || ""),
      m49: sanitizePlainText(c?.ccn3 || ""),
      aliases: Array.from(new Set(aliases.filter(Boolean)))
    };
  }).filter(x => x.country && x.continent);
}

function parseM49OverviewHtmlRows(htmlText) {
  if (!htmlText || typeof htmlText !== "string") return [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlText, "text/html");
  const tables = Array.from(doc.querySelectorAll("table"));
  for (let t = 0; t < tables.length; t++) {
    const rows = Array.from(tables[t].querySelectorAll("tr"));
    if (!rows.length) continue;
    let headerRowIndex = -1;
    let idxCountry = -1;
    let idxRegion = -1;
    let idxSubregion = -1;
    let idxM49 = -1;
    let idxIso2 = -1;
    let idxIso3 = -1;

    for (let i = 0; i < rows.length; i++) {
      const headerCells = Array.from(rows[i].querySelectorAll("th,td")).map(c =>
        sanitizePlainText((c.textContent || "").toLowerCase())
      );
      const cCountry = headerCells.findIndex(h => h === "country or area");
      const cRegion = headerCells.findIndex(h => h === "region name");
      if (cCountry >= 0 && cRegion >= 0) {
        headerRowIndex = i;
        idxCountry = cCountry;
        idxRegion = cRegion;
        idxSubregion = headerCells.findIndex(h => h === "sub-region name");
        idxM49 = headerCells.findIndex(h => h === "m49 code");
        idxIso2 = headerCells.findIndex(h => h === "iso-alpha2 code");
        idxIso3 = headerCells.findIndex(h => h === "iso-alpha3 code");
        break;
      }
    }
    if (headerRowIndex < 0) continue;

    const parsed = [];
    for (let i = headerRowIndex + 1; i < rows.length; i++) {
      const cells = Array.from(rows[i].querySelectorAll("td")).map(c => sanitizePlainText(c.textContent || ""));
      if (!cells.length) continue;
      const country = sanitizePlainText(cells[idxCountry] || "");
      const region = sanitizePlainText(cells[idxRegion] || "");
      const subregion = idxSubregion >= 0 ? sanitizePlainText(cells[idxSubregion] || "") : "";
      const iso2 = idxIso2 >= 0 ? sanitizePlainText(cells[idxIso2] || "") : "";
      const iso3 = idxIso3 >= 0 ? sanitizePlainText(cells[idxIso3] || "") : "";
      const m49 = idxM49 >= 0 ? sanitizePlainText(cells[idxM49] || "") : "";
      // Keep only country/area rows (region and world rows usually have blank ISO codes).
      if (!country || !region || !iso3) continue;
      if (norm(country) === "country or area") continue;
      parsed.push({
        country,
        officialName: "",
        continent: normalizeContinentFromMeta(region, subregion),
        iso2,
        iso3,
        m49,
        aliases: [country]
      });
    }
    if (parsed.length >= MIN_REFERENCE_COUNTRY_COUNT) {
      const deduped = new Map();
      parsed.forEach(r => {
        const key = sanitizePlainText(r.iso3 || r.m49 || r.country).toUpperCase();
        if (!key) return;
        if (!deduped.has(key)) deduped.set(key, r);
      });
      return Array.from(deduped.values());
    }
  }
  return [];
}

async function loadCountryReferenceRows() {
  let fromUN = [];
  try {
    if (UN_COUNTRIES_LOCAL_URL) {
      const unLocalRaw = await fetchJsonWithFallback(
        UN_COUNTRIES_LOCAL_URL,
        null,
        "UN country reference metadata"
      );
      fromUN = normalizeReferenceRows(unLocalRaw);
      if (fromUN.length >= MIN_REFERENCE_COUNTRY_COUNT) {
        console.info(`Using local UN reference table: ${fromUN.length} countries.`);
        return fromUN;
      }
      if (fromUN.length > 0) {
        console.warn(`UN local reference has only ${fromUN.length} entries; expected >= ${MIN_REFERENCE_COUNTRY_COUNT}. Trying UN M49 URL.`);
      }
    }
  } catch (e) {
    console.warn("UN local reference unavailable; trying UN M49 URL.", e);
  }

  try {
    if (UN_COUNTRIES_REMOTE_URL) {
      const unOverviewHtml = await fetchTextWithFallback(
        null,
        UN_COUNTRIES_REMOTE_URL,
        "UN M49 overview"
      );
      fromUN = parseM49OverviewHtmlRows(unOverviewHtml);
      if (fromUN.length >= MIN_REFERENCE_COUNTRY_COUNT) {
        console.info(`Using UN M49 overview table: ${fromUN.length} countries.`);
        return fromUN;
      }
      if (fromUN.length > 0) {
        console.warn(`UN M49 overview parse yielded ${fromUN.length} entries; expected >= ${MIN_REFERENCE_COUNTRY_COUNT}. Falling back.`);
      }
    }
  } catch (e) {
    console.warn("UN M49 overview unavailable; falling back to default metadata.", e);
  }

  const fallbackRaw = await fetchJsonWithFallback(
    WORLD_COUNTRIES_LOCAL_URL,
    WORLD_COUNTRIES_REMOTE_URL,
    "world country metadata"
  );
  const fallback = normalizeWorldCountriesRows(fallbackRaw);
  if (!fallback.length) throw new Error("World country metadata payload is invalid.");
  console.warn(`Falling back to default country metadata: ${fallback.length} countries.`);
  return fallback;
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
    const [boundaryGeojson, metaRows] = await Promise.all([
      fetchJsonWithFallback(WORLD_BOUNDARY_LOCAL_URL, WORLD_BOUNDARY_REMOTE_URL, "world boundaries"),
      loadCountryReferenceRows()
    ]);
    if (!Array.isArray(boundaryGeojson?.features)) {
      throw new Error("World boundaries payload is invalid.");
    }

    const continentByCountryNorm = new Map();
    const canonicalByCountryNorm = new Map();
    const countriesByContinentMeta = new Map();
    (Array.isArray(metaRows) ? metaRows : []).forEach(c => {
      const region = sanitizePlainText(c?.continent || "");
      if (!region) return;
      const preferred = sanitizePlainText(c?.officialName || c?.country || "");
      const add = (nm, canonical = preferred) => {
        const k = normalizeCountryName(nm);
        if (!k) return;
        continentByCountryNorm.set(k, region);
        if (canonical) canonicalByCountryNorm.set(k, canonical);
      };
      const addToContinent = (nm) => {
        const clean = sanitizePlainText(nm || "");
        if (!clean) return;
        if (!countriesByContinentMeta.has(region)) countriesByContinentMeta.set(region, new Set());
        countriesByContinentMeta.get(region).add(clean);
      };
      add(c?.country);
      add(c?.officialName || c?.country);
      (Array.isArray(c?.aliases) ? c.aliases : []).forEach(alias => add(alias, preferred));
      addToContinent(preferred || c?.country);
    });

    const feats = Array.isArray(boundaryGeojson?.features) ? boundaryGeojson.features : [];
    worldBoundaryIndex = feats.map(f => {
      const country = sanitizePlainText(f?.properties?.name || "");
      const key = normalizeCountryName(country);
      const canonicalCountry = sanitizePlainText(canonicalByCountryNorm.get(key) || country);
      const continent = continentByCountryNorm.get(key) || guessContinentFromCountryName(country);
      return {
        country: canonicalCountry,
        continent,
        bbox: bboxFromCoordinates(f?.geometry?.coordinates),
        geometry: f?.geometry || null
      };
    }).filter(x => x.country && x.bbox && x.geometry && x.continent);

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
    div.className = "popup-prewrap";
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
const mapRenderer = L.canvas({
  padding: 0.5,
  // Increase hit tolerance so feature popups remain clickable at lower zoom.
  tolerance: 18
});

const map = L.map('map', {
  preferCanvas: true,
  renderer: mapRenderer,
  attributionControl: true,
  zoomAnimation: false,
  fadeAnimation: false,
  markerZoomAnimation: false,
  zoomSnap: 0.1,
  zoomDelta: 0.1
});

// Deterministic startup/home view centered on Africa.
// Keep north/south unchanged, while widening east/west default framing.
const INITIAL_HOME_CENTER = [0, 17];
const INITIAL_HOME_ZOOM = 3;
const INITIAL_HOME_BOUNDS = L.latLngBounds([[-34.85, -25.5], [37.35, 58.5]]);
const MAP_NAV_BOUNDS = L.latLngBounds([[-85, -180], [85, 180]]);
const SIDEBAR_WIDTH_PX = 250;
const MAP_OVERLAP_PX = 80;
const MAP_SIDE_VISIBLE_INSET_PX = MAP_OVERLAP_PX;
const DISCLAIMER_LEFT_VISIBLE_INSET_PX = 50;
const HOME_VERTICAL_PADDING_PX = 10;
const EDGE_HOME_VERTICAL_PADDING_EXTRA_PX = 8;
const IMPORT_EXTENT_MAX_ZOOM = 7;
const IMPORT_EXTENT_HOME_COVERAGE_RATIO = 0.9;
// Keep horizontal trim disabled so east/west view is not tightened.
const HORIZONTAL_TRIM_RATIO = 0;
const MAX_HOME_VIEW_RETRIES = 6;
const MAX_BOUNDS_RETRIES = 10;
let homeViewRetryCount = 0;
let maxBoundsRetryCount = 0;
let maxBoundsDeferredHooked = false;

function trimBoundsHorizontally(bounds, ratio = HORIZONTAL_TRIM_RATIO) {
  if (!bounds || typeof bounds.getSouthWest !== "function" || typeof bounds.getNorthEast !== "function") {
    return bounds;
  }
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();
  const spanLng = ne.lng - sw.lng;
  if (!(spanLng > 0) || !(ratio > 0)) return bounds;
  const maxTrim = Math.max(0, (spanLng / 2) - 1e-6);
  const trim = Math.min(spanLng * ratio, maxTrim);
  return L.latLngBounds([sw.lat, sw.lng + trim], [ne.lat, ne.lng - trim]);
}

function hasUsableMapViewport() {
  if (!map || typeof map.getSize !== "function" || typeof map.getContainer !== "function") return false;
  try {
    const sz = map.getSize();
    const container = map.getContainer();
    const w = Number(sz && sz.x);
    const h = Number(sz && sz.y);
    const cw = Number(container && container.clientWidth);
    const ch = Number(container && container.clientHeight);
    return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 &&
      Number.isFinite(cw) && Number.isFinite(ch) && cw > 0 && ch > 0;
  } catch (e) {
    return false;
  }
}

function safePanInsideBounds(bounds, options) {
  if (!map || typeof map.panInsideBounds !== "function" || !bounds) return;
  try {
    const c = map.getCenter();
    if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) return;
    map.panInsideBounds(bounds, options || { animate: false });
  } catch (e) {
    console.warn("panInsideBounds skipped due to unstable map center", e);
  }
}

function applyMaxBoundsSafely() {
  if (!map || typeof map.setMaxBounds !== "function") return;
  if (!hasUsableMapViewport()) {
    if (maxBoundsRetryCount < MAX_BOUNDS_RETRIES) {
      maxBoundsRetryCount += 1;
      setTimeout(() => {
        try { map.invalidateSize({ pan: false }); } catch (e) {}
        applyMaxBoundsSafely();
      }, 50);
    }
    return;
  }
  try {
    const c = map.getCenter();
    if (!c || !Number.isFinite(c.lat) || !Number.isFinite(c.lng)) {
      throw new Error("Map center is not finite");
    }
    map.setMaxBounds(MAP_NAV_BOUNDS);
    map.options.maxBoundsViscosity = 1.0;
    maxBoundsRetryCount = 0;
  } catch (e) {
    if (maxBoundsRetryCount < MAX_BOUNDS_RETRIES) {
      maxBoundsRetryCount += 1;
      setTimeout(() => {
        try { map.invalidateSize({ pan: false }); } catch (err) {}
        applyMaxBoundsSafely();
      }, 50);
    } else {
      if (!maxBoundsDeferredHooked) {
        maxBoundsDeferredHooked = true;
        try { map.once("load", applyMaxBoundsSafely); } catch (err) {}
        try { map.once("resize", applyMaxBoundsSafely); } catch (err) {}
        setTimeout(() => {
          maxBoundsRetryCount = 0;
          applyMaxBoundsSafely();
        }, 300);
      }
    }
  }
}

function applyHomeView() {
  const homePadY = HOME_VERTICAL_PADDING_PX + (isEdgeBrowser() ? EDGE_HOME_VERTICAL_PADDING_EXTRA_PX : 0);
  if (!hasUsableMapViewport()) {
    map.setView(INITIAL_HOME_CENTER, INITIAL_HOME_ZOOM, { animate: false });
    if (homeViewRetryCount < MAX_HOME_VIEW_RETRIES) {
      homeViewRetryCount += 1;
      setTimeout(() => {
        try { map.invalidateSize({ pan: false }); } catch (e) {}
        applyHomeView();
      }, 40);
    }
    return;
  }
  homeViewRetryCount = 0;
  if (INITIAL_HOME_BOUNDS && typeof map.fitBounds === "function") {
    map.fitBounds(trimBoundsHorizontally(INITIAL_HOME_BOUNDS), {
      animate: false,
      // Keep north/south stable, align east/west to visible map area.
      paddingTopLeft: [MAP_SIDE_VISIBLE_INSET_PX, homePadY],
      paddingBottomRight: [MAP_SIDE_VISIBLE_INSET_PX, homePadY]
    });
  } else {
    map.setView(INITIAL_HOME_CENTER, INITIAL_HOME_ZOOM, { animate: false });
  }
  map.panBy([0, 10], { animate: false });
  safePanInsideBounds(MAP_NAV_BOUNDS, { animate: false });
}

function syncLayoutWithHeaderHeight() {
  const header = document.querySelector('header.fixed-top');
  if (!header || !document.documentElement) return;
  const headerHeight = Math.max(0, Math.ceil(header.getBoundingClientRect().height));
  if (!headerHeight) return;
  setDynamicStyle(document.documentElement, { "--app-header-height": `${headerHeight}px` });
  applyMapHorizontalLayout();
  if (map && typeof map.invalidateSize === "function") {
    setTimeout(() => map.invalidateSize({ pan: false }), 0);
  }
}

function applyMapHorizontalLayout() {
  const mapContainer = document.getElementById('map-container');
  const mapEl = document.getElementById('map');
  if (mapContainer) {
    const sideMargin = Math.max(0, SIDEBAR_WIDTH_PX - MAP_OVERLAP_PX);
    setDynamicStyle(mapContainer, {
      "margin-left": `${sideMargin}px`,
      "margin-right": `${sideMargin}px`
    });
  }
  if (mapEl) {
    const leftCtl = mapEl.querySelector('.leaflet-left');
    const rightCtl = mapEl.querySelector('.leaflet-right');
    if (leftCtl) setDynamicStyle(leftCtl, { left: `${MAP_SIDE_VISIBLE_INSET_PX}px` });
    if (rightCtl) setDynamicStyle(rightCtl, { right: `${MAP_SIDE_VISIBLE_INSET_PX}px` });
  }
}

applyHomeView();
applyMaxBoundsSafely();

function goHomeView() {
  applyHomeView();
  resetAllMapUiPositions();
}

function isAfricaLikeLayerExtent(bounds) {
  if (!bounds || typeof bounds.isValid !== "function" || !bounds.isValid()) return false;
  if (!INITIAL_HOME_BOUNDS || typeof INITIAL_HOME_BOUNDS.isValid !== "function" || !INITIAL_HOME_BOUNDS.isValid()) return false;
  const bSw = bounds.getSouthWest();
  const bNe = bounds.getNorthEast();
  const hSw = INITIAL_HOME_BOUNDS.getSouthWest();
  const hNe = INITIAL_HOME_BOUNDS.getNorthEast();
  const bLatSpan = Math.max(0, bNe.lat - bSw.lat);
  const bLngSpan = Math.max(0, bNe.lng - bSw.lng);
  const hLatSpan = Math.max(0.0001, hNe.lat - hSw.lat);
  const hLngSpan = Math.max(0.0001, hNe.lng - hSw.lng);
  const latCoverage = bLatSpan / hLatSpan;
  const lngCoverage = bLngSpan / hLngSpan;
  const padded = bounds.pad(0.03);
  const containsHome = padded.contains(hSw) && padded.contains(hNe);
  return containsHome || (latCoverage >= IMPORT_EXTENT_HOME_COVERAGE_RATIO && lngCoverage >= IMPORT_EXTENT_HOME_COVERAGE_RATIO);
}

function fitToLayerExtent(layer, options = {}) {
  if (!layer || typeof layer.getBounds !== "function") return false;
  const bounds = layer.getBounds();
  if (!bounds || typeof bounds.isValid !== "function" || !bounds.isValid()) return false;
  const maxZoom = Number.isFinite(options.maxZoom) ? options.maxZoom : undefined;
  const shouldKeepHome = options.keepHomeWhenAfricaLike !== false;
  if (shouldKeepHome && isAfricaLikeLayerExtent(bounds)) {
    applyHomeView();
    return true;
  }

  const fitOptions = {
    animate: false,
    paddingTopLeft: [MAP_SIDE_VISIBLE_INSET_PX, 16],
    paddingBottomRight: [MAP_SIDE_VISIBLE_INSET_PX, 35]
  };
  if (Number.isFinite(maxZoom)) fitOptions.maxZoom = maxZoom;

  map.fitBounds(trimBoundsHorizontally(bounds), {
    ...fitOptions
  });
  map.panBy([0, 10], { animate: false });
  safePanInsideBounds(MAP_NAV_BOUNDS, { animate: false });
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
    // styles moved to CSS (CSP-safe)
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
  setDynamicStyle(homeContainer, { "margin-top": "8px" });
  zoomControl.parentNode.insertBefore(homeContainer, zoomControl.nextSibling);
}, 0);

const draggableMapControls = new Set();
const draggableControlInitialResolvers = new WeakMap();

function clampDraggableControl(el, mapEl) {
  const rect = mapEl.getBoundingClientRect();
  const maxLeft = Math.max(0, rect.width - el.offsetWidth);
  const maxTop = Math.max(0, rect.height - el.offsetHeight);
  const left = Math.max(0, Math.min(maxLeft, parseFloat(el.dataset.leftPx) || 0));
  const top = Math.max(0, Math.min(maxTop, parseFloat(el.dataset.topPx) || 0));
  el.dataset.leftPx = String(left);
  el.dataset.topPx = String(top);
  setDynamicStyle(el, { left: `${left}px`, top: `${top}px` });
  return { left, top, maxLeft, maxTop };
}

function updateDraggableControlNorm(el, mapEl) {
  const rect = mapEl.getBoundingClientRect();
  const maxLeft = Math.max(0, rect.width - el.offsetWidth);
  const maxTop = Math.max(0, rect.height - el.offsetHeight);
  const left = Math.max(0, Math.min(maxLeft, parseFloat(el.dataset.leftPx) || 0));
  const top = Math.max(0, Math.min(maxTop, parseFloat(el.dataset.topPx) || 0));
  el.dataset.normX = maxLeft > 0 ? String(left / maxLeft) : "0";
  el.dataset.normY = maxTop > 0 ? String(top / maxTop) : "0";
}

function applyDraggableControlNorm(el, mapEl) {
  const rect = mapEl.getBoundingClientRect();
  const maxLeft = Math.max(0, rect.width - el.offsetWidth);
  const maxTop = Math.max(0, rect.height - el.offsetHeight);
  const nx = Number(el.dataset.normX);
  const ny = Number(el.dataset.normY);
  const left = isFinite(nx) ? Math.max(0, Math.min(maxLeft, Math.round(nx * maxLeft))) : 0;
  const top = isFinite(ny) ? Math.max(0, Math.min(maxTop, Math.round(ny * maxTop))) : 0;
  el.dataset.leftPx = String(left);
  el.dataset.topPx = String(top);
  setDynamicStyle(el, { left: `${left}px`, top: `${top}px` });
}

function repositionDraggableControls() {
  const mapEl = map && typeof map.getContainer === "function" ? map.getContainer() : null;
  if (!mapEl) return;
  draggableMapControls.forEach((el) => {
    if (!el || !el.isConnected) return;
    const userMoved = el.dataset && el.dataset.userMoved === "1";
    if (!userMoved && draggableControlInitialResolvers.has(el)) {
      applyDraggableControlInitialPosition(el, mapEl, false);
      clampDraggableControl(el, mapEl);
      return;
    }
    if (el.dataset && (el.dataset.normX || el.dataset.normY)) {
      applyDraggableControlNorm(el, mapEl);
      clampDraggableControl(el, mapEl);
    } else {
      clampDraggableControl(el, mapEl);
      updateDraggableControlNorm(el, mapEl);
    }
  });
}

function applyDraggableControlInitialPosition(el, mapEl, refreshInit = true) {
  const resolver = draggableControlInitialResolvers.get(el);
  if (!resolver) return false;
  const pos = resolver(el, mapEl) || {};
  const initLeft = Math.max(0, Math.round(Number(pos.left) || 0));
  const initTop = Math.max(0, Math.round(Number(pos.top) || 0));
  el.dataset.leftPx = String(initLeft);
  el.dataset.topPx = String(initTop);
  setDynamicStyle(el, {
    left: `${initLeft}px`,
    top: `${initTop}px`,
    right: "auto",
    bottom: "auto"
  });
  if (refreshInit) {
    el.dataset.initLeft = String(initLeft);
    el.dataset.initTop = String(initTop);
  }
  updateDraggableControlNorm(el, mapEl);
  return true;
}

function makeControlDraggable(control, initial) {
  if (!control || typeof control.getContainer !== "function") return;
  const el = control.getContainer();
  const mapEl = map.getContainer();
  if (!el || !mapEl) return;

  // Move to map root so the control can be freely positioned.
  mapEl.appendChild(el);
  el.classList.add("draggable-map-control");
  el.setAttribute("contenteditable", "false");
  el.setAttribute("draggable", "false");
  const initialResolver = typeof initial === "function"
    ? initial
    : () => (initial || { left: 0, top: 0 });
  draggableControlInitialResolvers.set(el, initialResolver);
  applyDraggableControlInitialPosition(el, mapEl, true);
  draggableMapControls.add(el);

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
    el.dataset.leftPx = String(nextLeft);
    el.dataset.topPx = String(nextTop);
    setDynamicStyle(el, { left: `${nextLeft}px`, top: `${nextTop}px` });
  };

  const stopDrag = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("is-dragging");
    el.dataset.userMoved = "1";
    clampDraggableControl(el, mapEl);
    updateDraggableControlNorm(el, mapEl);
    if (map.dragging && map.dragging.enabled && !map.dragging.enabled()) {
      map.dragging.enable();
    }
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", stopDrag);
    window.removeEventListener("pointercancel", stopDrag);
  };

  el.addEventListener("pointerdown", (evt) => {
    if (!evt.isPrimary) return;
    if (evt.pointerType === "mouse" && evt.button !== 0) return;
    evt.preventDefault();
    dragging = true;
    el.classList.add("is-dragging");
    startX = evt.clientX;
    startY = evt.clientY;
    baseLeft = parseFloat(el.dataset.leftPx) || 0;
    baseTop = parseFloat(el.dataset.topPx) || 0;
    if (el.setPointerCapture) {
      try { el.setPointerCapture(evt.pointerId); } catch (err) {}
    }
    if (map.dragging && map.dragging.enabled && map.dragging.enabled()) {
      map.dragging.disable();
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
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
  const left = Math.max(
    MAP_SIDE_VISIBLE_INSET_PX,
    Math.round(mapW - MAP_SIDE_VISIBLE_INSET_PX - el.offsetWidth - marginPx)
  );
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
    setTimeout(() => this._update(), 0);
    return container;
  },
  onRemove: function(controlMap) {
    controlMap.off("zoom move resize", this._update, this);
  },
  _update: function() {
    if (!this._map || !this._value) return;
    const size = this._map.getSize();
    const sx = Number(size && size.x);
    const sy = Number(size && size.y);
    if (!Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0) {
      this._value.textContent = "--";
      return;
    }
    const y = Math.max(0, size.y - 24);
    const x = Math.max(0, Math.round((size.x - this.options.widthPx) / 2));
    const p1 = L.point(x, y);
    const p2 = L.point(x + this.options.widthPx, y);
    try {
      const ll1 = this._map.containerPointToLatLng(p1);
      const ll2 = this._map.containerPointToLatLng(p2);
      const meters = this._map.distance(ll1, ll2);
      this._value.textContent = formatScaleDistance(meters);
    } catch (e) {
      this._value.textContent = "--";
      logEdgeExportDebug("scaleControl.updateSkipped", {
        reason: "invalid-map-geometry",
        sizeX: sx,
        sizeY: sy
      });
    }
  }
});
const scaleControl = new ExactScaleControl({ widthPx: 160 });
map.addControl(scaleControl);

function placeScaleBarOnMapBottom(control) {
  if (!control || typeof control.getContainer !== "function") return;
  const el = control.getContainer();
  const mapEl = map && typeof map.getContainer === "function" ? map.getContainer() : null;
  if (!el || !mapEl) return;
  if (mapEl && el.parentElement !== mapEl) {
    mapEl.appendChild(el);
  }
  el.classList.remove("fixed-page-scale-control");
  el.classList.add("map-bottom-scale-control");
  const userMoved = el.dataset && el.dataset.userMoved === "1";
  if (userMoved) {
    clampDraggableControl(el, mapEl);
    updateDraggableControlNorm(el, mapEl);
    return;
  }
  applyDraggableControlInitialPosition(el, mapEl, true);
  clampDraggableControl(el, mapEl);
  updateDraggableControlNorm(el, mapEl);
}

function ensureScaleBarPinnedToMapBottom() {
  if (!scaleControl || typeof scaleControl.getContainer !== "function") return;
  const el = scaleControl.getContainer();
  const mapEl = map && typeof map.getContainer === "function" ? map.getContainer() : null;
  if (!el || !mapEl) return;
  if (mapEl && el.parentElement !== mapEl) {
    mapEl.appendChild(el);
  }
  el.classList.remove("fixed-page-scale-control");
  el.classList.add("map-bottom-scale-control");
  const userMoved = el.dataset && el.dataset.userMoved === "1";
  if (userMoved) {
    clampDraggableControl(el, mapEl);
    updateDraggableControlNorm(el, mapEl);
    return;
  }
  applyDraggableControlInitialPosition(el, mapEl, true);
  clampDraggableControl(el, mapEl);
  updateDraggableControlNorm(el, mapEl);
}

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
makeControlDraggable(scaleControl, (el, mapEl) => {
  const pos = getBottomCenterPosition(el, mapEl, SCALE_BAR_OFFSET_Y_PX, SCALE_BAR_OFFSET_X_PX);
  return { left: pos.left, top: pos.top };
});
placeScaleBarOnMapBottom(scaleControl);
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

  const left = 12 + DISCLAIMER_LEFT_VISIBLE_INSET_PX;
  const bottom = 30;
    const preferredFixedWidth = 252;
    const margin = 12;
    const maxAvailableWidth = mapRect
      ? Math.max(120, Math.round(mapRect.width - left - margin))
      : preferredFixedWidth;
    const getStableDisclaimerWidthPx = () => {
      const fixedWidth = Number(disc.dataset.fixedWidthPx);
      const renderedWidth = Math.round(disc.getBoundingClientRect().width || disc.offsetWidth || preferredFixedWidth);
      const fallbackWidth = Math.min(maxAvailableWidth, preferredFixedWidth);
      const candidate = Number.isFinite(fixedWidth) && fixedWidth > 0 ? fixedWidth : (renderedWidth || fallbackWidth);
      return Math.max(120, Math.min(maxAvailableWidth, Math.round(candidate)));
    };

    const desiredWidth = Math.min(maxAvailableWidth, preferredFixedWidth);
    const userMoved = !!disclaimerUserPos;
    const widthPx = userMoved ? getStableDisclaimerWidthPx() : desiredWidth;
    disc.dataset.fixedWidthPx = String(widthPx);

    disc.classList.add('clamp-5-lines');
    disc.style.setProperty('top', 'auto');
    disc.style.setProperty('left', left + 'px');
    disc.style.setProperty('right', 'auto');
    disc.style.setProperty('bottom', bottom + 'px');
    disc.style.setProperty('width', widthPx + 'px');
    disc.style.setProperty('max-width', widthPx + 'px');

    // Keep user-dragged position across resize/move while clamping to map bounds.
    if (disclaimerUserPos) {
      const mW = mapEl ? mapEl.clientWidth : 0;
      const mH = mapEl ? mapEl.clientHeight : 0;
      const dW = disc.offsetWidth || desiredWidth;
      const dH = disc.offsetHeight || 0;
      const marginClamp = 6;
      const minLeft = Math.max(marginClamp, DISCLAIMER_LEFT_VISIBLE_INSET_PX + marginClamp);
      const maxLeft = Math.max(minLeft, mW - MAP_SIDE_VISIBLE_INSET_PX - dW - marginClamp);
      const maxTop = Math.max(marginClamp, mH - dH - marginClamp);
      const leftPx = Math.min(maxLeft, Math.max(minLeft, disclaimerUserPos.left));
      const topPx = Math.min(maxTop, Math.max(marginClamp, disclaimerUserPos.top));
      disc.style.setProperty('top', topPx + 'px');
      disc.style.setProperty('left', leftPx + 'px');
      disc.style.setProperty('bottom', 'auto');
      disc.style.setProperty('width', widthPx + 'px');
      disc.style.setProperty('max-width', widthPx + 'px');
      disclaimerUserPos = { left: leftPx, top: topPx };
    }
  } catch (e) {
    console.warn('positionDisclaimer failed', e);
  }
}

function resetDisclaimerPosition() {
  disclaimerUserPos = null;
  positionDisclaimer();
}

function resetDraggableControlsToInitial() {
  const mapEl = map && typeof map.getContainer === "function" ? map.getContainer() : null;
  if (!mapEl) return;
  draggableMapControls.forEach((el) => {
    if (!el || !el.isConnected) return;
    const applied = applyDraggableControlInitialPosition(el, mapEl, true);
    if (!applied) {
      const initLeft = Number(el.dataset.initLeft);
      const initTop = Number(el.dataset.initTop);
      if (isFinite(initLeft) && isFinite(initTop)) {
        el.dataset.leftPx = String(initLeft);
        el.dataset.topPx = String(initTop);
        setDynamicStyle(el, { left: `${initLeft}px`, top: `${initTop}px` });
      } else {
        clampDraggableControl(el, mapEl);
      }
      updateDraggableControlNorm(el, mapEl);
    } else {
      clampDraggableControl(el, mapEl);
    }
    el.dataset.userMoved = "";
    el.dataset.normX = "";
    el.dataset.normY = "";
    updateDraggableControlNorm(el, mapEl);
  });
}

function resetAllMapUiPositions() {
  resetDisclaimerPosition();
  resetDraggableControlsToInitial();
}

function initDisclaimerDrag() {
  const disc = document.getElementById('disclaimer');
  const mapEl = map && typeof map.getContainer === 'function' ? map.getContainer() : null;
  if (!disc || !mapEl || disc.dataset.dragInit === '1') return;

  const resolveDisclaimerWidthPx = () => {
    const mapRect = mapEl.getBoundingClientRect();
    const leftInset = 12 + DISCLAIMER_LEFT_VISIBLE_INSET_PX;
    const margin = 12;
    const maxAvailableWidth = mapRect
      ? Math.max(120, Math.round(mapRect.width - leftInset - margin))
      : 252;
    const fixedWidth = Number(disc.dataset.fixedWidthPx);
    const renderedWidth = Math.round(disc.getBoundingClientRect().width || disc.offsetWidth || 252);
    const candidate = Number.isFinite(fixedWidth) && fixedWidth > 0 ? fixedWidth : renderedWidth;
    return Math.max(120, Math.min(maxAvailableWidth, Math.round(candidate || 252)));
  };

  disc.dataset.dragInit = '1';
  disc.setAttribute('contenteditable', 'false');
  disc.setAttribute('draggable', 'false');
  disc.style.pointerEvents = 'auto';

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let baseLeft = 0;
  let baseTop = 0;

  const clampAndApply = (left, top) => {
    const mW = mapEl.clientWidth || 0;
    const mH = mapEl.clientHeight || 0;
    const dW = disc.offsetWidth || 0;
    const dH = disc.offsetHeight || 0;
    const marginClamp = 6;
    const minLeft = Math.max(marginClamp, DISCLAIMER_LEFT_VISIBLE_INSET_PX + marginClamp);
    const maxLeft = Math.max(minLeft, mW - MAP_SIDE_VISIBLE_INSET_PX - dW - marginClamp);
    const maxTop = Math.max(marginClamp, mH - dH - marginClamp);
    const clampedLeft = Math.min(maxLeft, Math.max(minLeft, left));
    const clampedTop = Math.min(maxTop, Math.max(marginClamp, top));
    const fixedWidthPx = resolveDisclaimerWidthPx();

    disc.style.setProperty('top', clampedTop + 'px');
    disc.style.setProperty('left', clampedLeft + 'px');
    disc.style.setProperty('bottom', 'auto');
    disc.style.setProperty('width', fixedWidthPx + 'px');
    disc.style.setProperty('max-width', fixedWidthPx + 'px');
    disc.dataset.fixedWidthPx = String(fixedWidthPx);
    disclaimerUserPos = { left: clampedLeft, top: clampedTop };
  };

  const beginDrag = (clientX, clientY) => {
    const mapRect = mapEl.getBoundingClientRect();
    const discRect = disc.getBoundingClientRect();
    dragging = true;
    startX = clientX;
    startY = clientY;
    baseLeft = discRect.left - mapRect.left;
    baseTop = discRect.top - mapRect.top;
    disc.dataset.fixedWidthPx = String(resolveDisclaimerWidthPx());
    disc.classList.add('is-dragging');
    if (map.dragging && map.dragging.enabled && map.dragging.enabled()) map.dragging.disable();
    clampAndApply(baseLeft, baseTop);
  };

  const endDrag = () => {
    if (!dragging) return false;
    dragging = false;
    disc.classList.remove('is-dragging');
    if (map.dragging && map.dragging.enabled && !map.dragging.enabled()) map.dragging.enable();
    return true;
  };

  const onPointerMove = (e) => {
    if (!dragging) return;
    const nextLeft = baseLeft + (e.clientX - startX);
    const nextTop = baseTop + (e.clientY - startY);
    clampAndApply(nextLeft, nextTop);
    e.preventDefault();
  };

  const onPointerUp = (e) => {
    if (!endDrag()) return;
    if (disc.releasePointerCapture) {
      try { disc.releasePointerCapture(e.pointerId); } catch (err) {}
    }
  };

  const onPointerDown = (e) => {
    if (dragging) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    beginDrag(e.clientX, e.clientY);
    if (disc.setPointerCapture) {
      try { disc.setPointerCapture(e.pointerId); } catch (err) {}
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const onMouseMove = (e) => {
    if (!dragging) return;
    const nextLeft = baseLeft + (e.clientX - startX);
    const nextTop = baseTop + (e.clientY - startY);
    clampAndApply(nextLeft, nextTop);
    e.preventDefault();
  };

  const onMouseUp = () => {
    endDrag();
  };

  const onMouseDown = (e) => {
    if (dragging) return;
    if (e.button !== 0) return;
    beginDrag(e.clientX, e.clientY);
    e.preventDefault();
    e.stopPropagation();
  };

  const onTouchMove = (e) => {
    if (!dragging) return;
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    const nextLeft = baseLeft + (touch.clientX - startX);
    const nextTop = baseTop + (touch.clientY - startY);
    clampAndApply(nextLeft, nextTop);
    e.preventDefault();
  };

  const onTouchEnd = () => {
    endDrag();
  };

  const onTouchStart = (e) => {
    if (dragging) return;
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    beginDrag(touch.clientX, touch.clientY);
    e.preventDefault();
    e.stopPropagation();
  };

  disc.addEventListener('pointerdown', onPointerDown);
  disc.addEventListener('mousedown', onMouseDown);
  disc.addEventListener('touchstart', onTouchStart, false);

  // Hard fallback channel: direct handlers are more resilient on locked-down browsers.
  disc.onmousedown = onMouseDown;
  disc.ontouchstart = onTouchStart;

  // Keep listeners attached once to avoid race conditions when drag starts.
  window.addEventListener('pointermove', onPointerMove, false);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('touchmove', onTouchMove, false);
  window.addEventListener('touchend', onTouchEnd);
  window.addEventListener('touchcancel', onTouchEnd);

  // Capture-phase document listeners as final fallback if window listeners miss events.
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('touchmove', onTouchMove, true);
  document.addEventListener('touchend', onTouchEnd, true);
  document.addEventListener('touchcancel', onTouchEnd, true);

  // Ensure map drag state recovers if pointer events are interrupted.
  window.addEventListener('blur', () => {
    if (!dragging) return;
    endDrag();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && dragging) {
      endDrag();
    }
  });
}

function scheduleDisclaimerDragInit(maxAttempts = 10, delayMs = 180) {
  let attempts = 0;
  const tick = () => {
    attempts += 1;
    initDisclaimerDrag();
    const disc = document.getElementById('disclaimer');
    if (disc && disc.dataset.dragInit === '1') return;
    if (attempts < maxAttempts) {
      setTimeout(tick, delayMs);
    }
  };
  tick();
}

function runMapUiReflowPasses() {
  // Browser zoom updates element metrics asynchronously; run multiple passes.
  [20, 110, 240].forEach((delayMs) => {
    setTimeout(() => {
      syncLayoutWithHeaderHeight();
      // Reflow after Leaflet has processed the new container size.
      setTimeout(() => {
        if (map && typeof map.invalidateSize === "function") {
          map.invalidateSize({ pan: false });
        }
        if (scaleControl && typeof scaleControl._update === "function") {
          scaleControl._update();
        }
        ensureScaleBarPinnedToMapBottom();
        positionDisclaimer();
        repositionDraggableControls();
      }, 40);
    }, delayMs);
  });
}

let mapUiReflowRaf = 0;
function queueMapUiReflow() {
  if (mapUiReflowRaf) cancelAnimationFrame(mapUiReflowRaf);
  mapUiReflowRaf = requestAnimationFrame(() => {
    mapUiReflowRaf = 0;
    runMapUiReflowPasses();
  });
}

// run initially and on relevant events
window.addEventListener('load', () => {
  syncLayoutWithHeaderHeight();
  // Re-apply initial home once layout settles to avoid late layout shifts.
  setTimeout(applyHomeView, 50);
  setTimeout(syncLayoutWithHeaderHeight, 80);
  setTimeout(resetAllMapUiPositions, 300);
  setTimeout(scheduleDisclaimerDragInit, 350);
  setTimeout(repositionDraggableControls, 360);
  setTimeout(ensureScaleBarPinnedToMapBottom, 380);
  queueMapUiReflow();
});
window.addEventListener('resize', queueMapUiReflow);
window.addEventListener('orientationchange', queueMapUiReflow);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', queueMapUiReflow);
  window.visualViewport.addEventListener('scroll', queueMapUiReflow);
}
map.on && map.on('resize', queueMapUiReflow);
map.on && map.on('zoomend', queueMapUiReflow);
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
function getLegendSymbolKindFromGeometryType(geometryType) {
  const t = String(geometryType || "").toLowerCase();
  if (!t) return "polygon";
  if (t.includes("line")) return "line";
  if (t.includes("point")) return "point";
  if (t.includes("polygon")) return "polygon";
  if (t.includes("curve")) return "line";
  return "polygon";
}

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

  const detectLegendGeomType = () => {
    const features = Array.isArray(geojson?.features) ? geojson.features : [];
    for (let i = 0; i < features.length; i++) {
      const type = features[i]?.geometry?.type;
      if (typeof type === 'string' && type.trim()) return type;
    }
    const savedType = overlayData[layerName]?.legendGeomType;
    if (typeof savedType === 'string' && savedType.trim()) return savedType;
    return 'Polygon';
  };
  const geom = detectLegendGeomType();
  const symbolKind = getLegendSymbolKindFromGeometryType(geom);

  const makeRow = (label, color) => {
    const row = document.createElement('div');
    row.className = 'legend-row';

    const sym = document.createElement('div');
    sym.className = 'legend-sym';
    if (symbolKind === 'line') sym.classList.add('legend-sym-line');
    else if (symbolKind === 'point') sym.classList.add('legend-sym-point');
    else sym.classList.add('legend-sym-polygon');

    if (/^#[0-9A-Fa-f]{3,6}$/.test(color) || /^[a-zA-Z]+$/.test(color)) {
      if (symbolKind === 'line') {
        setDynamicStyle(sym, { "color": color, "background-color": "transparent" });
      } else {
        setDynamicStyle(sym, { "background-color": color, "color": "inherit" });
      }
    } else {
      setDynamicStyle(sym, { "background-color": "#ccc" });
      console.warn("Invalid color blocked:", color);
    }

    const lbl = document.createElement('span');
    lbl.textContent = label;

    row.append(sym, lbl);
    return row;
  };

  if (isNumeric) {
    for (let i = 0; i < vals.length - 1; i++) {
      block.appendChild(makeRow(`${formatLegendClassValue(vals[i])} – ${formatLegendClassValue(vals[i + 1])}`, cols[i]));
    }
  } else {
    const labels = Array.isArray(overlayData[layerName]?.legendLabels)
      ? overlayData[layerName].legendLabels
      : null;
    vals.forEach((v, i) => {
      const shown = sanitizePlainText(labels && labels[i] != null ? labels[i] : v, String(v));
      block.appendChild(makeRow(shown, cols[i]));
    });
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
  const activeLayerState = currentLayerName ? overlayData[currentLayerName] : null;
  const defaultColor = /^#[0-9A-Fa-f]{6}$/.test(activeLayerState?.defaultSymbolColor || "")
    ? activeLayerState.defaultSymbolColor
    : (/LineString/.test(t) ? '#007aff' : '#ccc');
  if (/Polygon/.test(t)) return { weight: 0, fillColor: defaultColor, fillOpacity: 0.6 };
  if (/LineString/.test(t)) return { color: defaultColor, weight: getLineWidth() };
  return { color: '#000', weight: 1, fillColor: defaultColor, fillOpacity: 0.6 };
}

function defaultPoint(feature, latlng) {
  const size = getPointRadius();
  const activeLayerState = currentLayerName ? overlayData[currentLayerName] : null;
  const defaultColor = /^#[0-9A-Fa-f]{6}$/.test(activeLayerState?.defaultSymbolColor || "")
    ? activeLayerState.defaultSymbolColor
    : '#ccc';
  return L.circleMarker(latlng, {
    radius: size,
    fillColor: defaultColor,
    color: '#000',
    weight: 1,
    fillOpacity: 0.6,
    interactive: true,
    bubblingMouseEvents: false
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
  const raw = String(nameOrPath || "").split(/[?#]/)[0];
  const lastSlash = raw.lastIndexOf("/");
  const segment = lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw;
  const dot = segment.lastIndexOf(".");
  if (dot <= 0 || dot === segment.length - 1) return "";
  return segment.slice(dot).toLowerCase();
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
    interactive: true,
    bubblingMouseEvents: false,
    style: defaultStyle,
    pointToLayer: defaultPoint,
    onEachFeature: bindFeaturePopup
  }).addTo(fg);
  layerGroup = fg;
  // Smart import viewport: fit to new layer with safe padding unless extent is Africa-wide.
  setTimeout(() => {
    fitToLayerExtent(fg, {
      maxZoom: IMPORT_EXTENT_MAX_ZOOM,
      keepHomeWhenAfricaLike: true
    });
  }, 0);

  overlayData[safeName] = { layerGroup: fg, geojson: geojson };
  layersControl.addOverlay(fg, safeName);
  trackLayerOrder(safeName);
  reorderLayersControlUI();
  applyLayerStackOrder();
  refreshLayerSelector();
  await setActiveLayer(safeName);
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
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try {
    let geojson;
    if (ext === ".zip") {
      const bytes = await readFileAsArrayBuffer(file);
      inspectZipSafety(bytes, file.size);
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
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try {
    const { parsed, ext: requestedExt } = validateImportUrl(rawUrl);
    const fetched = await fetchWithLimits(parsed.href);
    const finalParsed = assertFinalImportUrlAllowed(fetched.finalUrl);
    const ext = resolveRemoteImportExtension(requestedExt, finalParsed?.pathname || fetched.finalUrl || "", fetched.contentType);
    if (!ext) {
      throw new Error("Could not determine URL import type. Use a .csv/.geojson URL or a correct JSON/CSV content type.");
    }
    const hasAllowedContentType = isAllowedRemoteContentType(ext, fetched.contentType);
    const csvPayloadFallbackAllowed = ext === ".csv" && isLikelyCsvPayload(fetched.text || "");
    if (!hasAllowedContentType && !csvPayloadFallbackAllowed) {
      throw new Error(`Remote content type is not allowed for ${ext} import.`);
    }
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
    // Start with no continent selected so country options appear only
    // after an explicit continent selection.
    selectedContinentValues = new Set();
    updateContinentFilterButtonLabel();
    showRow(contCol);
    if (africaBtn) setDynamicStyle(africaBtn, { display: "" });
    if (contBtnAll) setDynamicStyle(contBtnAll, { display: "" });
    if (contBtnClear) setDynamicStyle(contBtnClear, { display: "" });
  } else {
    updateContinentFilterButtonLabel();
    hideRow(contCol);
    if (africaBtn) setDynamicStyle(africaBtn, { display: "none" });
    if (contBtnAll) setDynamicStyle(contBtnAll, { display: "none" });
    if (contBtnClear) setDynamicStyle(contBtnClear, { display: "none" });
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
    interactive: true,
    bubblingMouseEvents: false,
    style: defaultStyle,
    pointToLayer: defaultPoint,
    onEachFeature: bindFeaturePopup
  }).addTo(layerGroup);

  const geomType = filtered?.features?.[0]?.geometry?.type || geojsonData?.features?.[0]?.geometry?.type || "Polygon";
  const state = overlayData[currentLayerName] || null;
  const defaultLegendColor = /^#[0-9A-Fa-f]{6}$/.test(state?.defaultSymbolColor || "")
    ? state.defaultSymbolColor
    : (/LineString/.test(geomType) ? "#007aff" : "#ccc");
  const defaultLegendLabel = sanitizePlainText(state?.defaultSymbolLabel || "Features", "Features");

  if (overlayData[currentLayerName]) {
    overlayData[currentLayerName].vals = [defaultLegendLabel];
    overlayData[currentLayerName].cols = [defaultLegendColor];
    overlayData[currentLayerName].isNumeric = false;
    overlayData[currentLayerName].legendLabels = [defaultLegendLabel];
    overlayData[currentLayerName].legendGeomType = geomType;
    overlayData[currentLayerName].defaultSymbolColor = defaultLegendColor;
    overlayData[currentLayerName].defaultSymbolLabel = defaultLegendLabel;
  }

  updateLegend(currentLayerName, [defaultLegendLabel], [defaultLegendColor], false, filtered);
  updateClassificationTableDefaultSymbol(defaultLegendLabel, defaultLegendColor);
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

  try {
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
  } catch (e) {
    console.error("Layer activation UI failed; applying safe fallback.", e);
    try {
      populateAttributeList(geojsonData || { type: "FeatureCollection", features: [] });
      updatePointSizeControl();
      updateLineWidthControl();
      updateClassificationOptions();
      renderDefaultFilteredLayer();
    } catch (inner) {
      console.error("Layer activation fallback also failed.", inner);
    }
  }

  const sel = document.getElementById('layer-select');
  if (sel) {
    sel.value = name;
    showRow('layer-select-col');
  }
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
    const sourceUniques = [...new Set(vals)];
    const state = overlayData[currentLayerName] || null;
    const priorVals = Array.isArray(state?.vals) ? state.vals.slice() : null;
    const priorCols = Array.isArray(state?.cols) ? state.cols.slice() : null;
    const sourceKeys = new Set(sourceUniques.map(categoryKey));
    const priorKeys = priorVals ? new Set(priorVals.map(categoryKey)) : null;
    const canReusePriorOrder = !!(
      priorVals &&
      priorVals.length === sourceUniques.length &&
      priorKeys &&
      priorKeys.size === sourceKeys.size &&
      Array.from(sourceKeys).every((k) => priorKeys.has(k))
    );
    const uniques = canReusePriorOrder ? priorVals.slice() : sourceUniques.slice();
    let cols;
    if (priorVals && priorCols && priorVals.length === priorCols.length) {
      const colorByKey = new Map();
      priorVals.forEach((v, idx) => {
        const col = priorCols[idx];
        if (/^#[0-9A-Fa-f]{6}$/.test(col)) colorByKey.set(categoryKey(v), col);
      });
      const fallback = generateColorPalette(uniques.length);
      cols = uniques.map((u, i) => {
        const mapped = colorByKey.get(categoryKey(u));
        if (mapped) return mapped;
        if (categoricalUserColors && /^#[0-9A-Fa-f]{6}$/.test(categoricalUserColors[i])) return categoricalUserColors[i];
        return fallback[i] || '#ccc';
      });
    } else {
      cols = (categoricalUserColors && categoricalUserColors.length === uniques.length)
        ? categoricalUserColors.slice()
        : generateColorPalette(uniques.length);
    }
    categoricalUserColors = cols.slice();

    L.geoJSON(filteredGeojson, {
      interactive: true,
      bubblingMouseEvents: false,
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
          interactive: true,
          bubblingMouseEvents: false
        });
      },
      onEachFeature: bindFeaturePopup
        }).addTo(layerGroup);

    if (overlayData[currentLayerName]) {
      overlayData[currentLayerName].vals = uniques;
      overlayData[currentLayerName].cols = cols;
      overlayData[currentLayerName].isNumeric = false;
      overlayData[currentLayerName].legendGeomType = filteredGeojson?.features?.[0]?.geometry?.type || overlayData[currentLayerName].legendGeomType || 'Polygon';
      if (
        !Array.isArray(overlayData[currentLayerName].legendLabels) ||
        overlayData[currentLayerName].legendLabels.length !== uniques.length
      ) {
        overlayData[currentLayerName].legendLabels = uniques.map((u) => sanitizePlainText(u, "Category"));
      }
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
    const numericVals = vals.map(v => Number(v)).filter(v => Number.isFinite(v));
    const sourceIsIntegerOnly = numericVals.length > 0 && numericVals.every(v => Math.abs(v - Math.round(v)) < 1e-9);

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

    breaks = breaks.map((b) => {
      const num = Number(b);
      if (!Number.isFinite(num)) return num;
      return sourceIsIntegerOnly ? Math.round(num) : roundToOneDecimal(num);
    });

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
      interactive: true,
      bubblingMouseEvents: false,
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
          interactive: true,
          bubblingMouseEvents: false
        });
      },
    onEachFeature: bindFeaturePopup
    }).addTo(layerGroup);

    if (overlayData[currentLayerName]) {
      overlayData[currentLayerName].vals = breaks;
      overlayData[currentLayerName].cols = cols;
      overlayData[currentLayerName].isNumeric = true;
      overlayData[currentLayerName].legendGeomType = filteredGeojson?.features?.[0]?.geometry?.type || overlayData[currentLayerName].legendGeomType || 'Polygon';
    }

    updateLegend(currentLayerName, breaks, cols, true, filteredGeojson);
    updateClassificationTableNumeric(breaks, cols);
  }

  const tbl = document.getElementById('table-container');
  if (tbl) setDynamicStyle(tbl, { display: "block" });
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
    // Numeric class ranges are read-only to prevent accidental/unsafe edits.
    tdR.contentEditable = 'false';
    tdR.textContent = `${formatLegendClassValue(brks[i])} - ${formatLegendClassValue(brks[i + 1])}`;

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

function updateClassificationTableDefaultSymbol(label, color) {
  const thead = document.querySelector('#table-container thead');
  const tbody = document.getElementById('classification-table');
  const tbl = document.getElementById('table-container');
  if (!thead || !tbody || !currentLayerName) return;

  thead.textContent = "";
  tbody.textContent = "";

  const headerRow = document.createElement('tr');
  ["Symbol", "Label", "Color"].forEach((title) => {
    const th = document.createElement('th');
    th.textContent = title;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);

  const row = document.createElement('tr');

  const tdSym = document.createElement('td');
  const sym = document.createElement('div');
  sym.className = 'legend-sym';
  const geomType = overlayData[currentLayerName]?.legendGeomType || geojsonData?.features?.[0]?.geometry?.type || 'Polygon';
  const symbolKind = getLegendSymbolKindFromGeometryType(geomType);
  if (symbolKind === 'line') sym.classList.add('legend-sym-line');
  else if (symbolKind === 'point') sym.classList.add('legend-sym-point');
  else sym.classList.add('legend-sym-polygon');
  if (symbolKind === 'line') {
    setDynamicStyle(sym, {
      "color": /^#[0-9A-Fa-f]{6}$/.test(color) ? color : '#ccc',
      "background-color": "transparent"
    });
  } else {
    setDynamicStyle(sym, { "background-color": /^#[0-9A-Fa-f]{6}$/.test(color) ? color : '#ccc' });
  }
  tdSym.appendChild(sym);

  const tdLabel = document.createElement('td');
  tdLabel.contentEditable = 'true';
  tdLabel.setAttribute('role', 'textbox');
  tdLabel.setAttribute('aria-label', 'Legend label');
  tdLabel.spellcheck = false;
  tdLabel.textContent = sanitizePlainText(label, 'Features');
  tdLabel.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
    insertTextAtCaret(tdLabel, text);
  });
  tdLabel.addEventListener('blur', () => {
    const next = sanitizePlainText(tdLabel.textContent, 'Features');
    tdLabel.textContent = next;
    const state = overlayData[currentLayerName];
    if (!state) return;
    state.defaultSymbolLabel = next;
    state.legendLabels = [next];
    state.vals = [next];
    updateLegend(currentLayerName, state.vals, state.cols || [color], false, state.geojson);
  });

  const tdColor = document.createElement('td');
  const inputCol = document.createElement('input');
  inputCol.type = 'color';
  inputCol.value = /^#[0-9A-Fa-f]{6}$/.test(color) ? color : '#cccccc';
  inputCol.setAttribute('aria-label', 'Legend color');
  inputCol.addEventListener('change', () => {
    const nextColor = inputCol.value;
    const state = overlayData[currentLayerName];
    if (!state) return;
    state.defaultSymbolColor = nextColor;
    state.cols = [nextColor];
    renderDefaultFilteredLayer();
  });
  tdColor.appendChild(inputCol);

  row.append(tdSym, tdLabel, tdColor);
  tbody.appendChild(row);
  if (tbl) setDynamicStyle(tbl, { display: "block" });
}

function updateClassificationTableCategorical(uniques, cols) {
  const thead = document.querySelector('#table-container thead');
  const tbody = document.getElementById('classification-table');
  if (!thead || !tbody) return;

  thead.textContent = "";
  tbody.textContent = "";

  const headerRow = document.createElement('tr');
  ["Category", "Color", "Order"].forEach(label => {
    const th = document.createElement('th');
    th.textContent = label;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);

  uniques.forEach((u, i) => {
    const tr = document.createElement('tr');

    const tdC = document.createElement('td');
    // Categorical labels are editable, but sanitized to plain text.
    const layerState = overlayData[currentLayerName] || null;
    const existingLabel = Array.isArray(layerState?.legendLabels) ? layerState.legendLabels[i] : null;
    const defaultLabel = sanitizePlainText(existingLabel != null ? existingLabel : u, "Category");
    tdC.contentEditable = 'true';
    tdC.setAttribute('role', 'textbox');
    tdC.setAttribute('aria-label', `Category label ${i + 1}`);
    tdC.spellcheck = false;
    tdC.textContent = defaultLabel;
    tdC.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData)?.getData('text') || '';
      insertTextAtCaret(tdC, text);
    });
    tdC.addEventListener('blur', () => {
      const next = sanitizePlainText(tdC.textContent, defaultLabel);
      tdC.textContent = next;
      if (layerState) {
        if (!Array.isArray(layerState.legendLabels)) {
          layerState.legendLabels = uniques.map((val) => sanitizePlainText(val, "Category"));
        }
        layerState.legendLabels[i] = next;
        updateLegend(currentLayerName, layerState.vals || uniques, layerState.cols || cols, false, layerState.geojson);
      }
    });

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

    const tdAct = document.createElement('td');
    const btnUp = document.createElement('button');
    btnUp.type = 'button';
    btnUp.className = 'layer-reorder-btn';
    btnUp.textContent = '↑';
    btnUp.setAttribute('aria-label', `Move category ${i + 1} up`);
    btnUp.disabled = i === 0;
    btnUp.addEventListener('click', () => {
      reorderCategoricalClasses(i, i - 1);
    });

    const btnDown = document.createElement('button');
    btnDown.type = 'button';
    btnDown.className = 'layer-reorder-btn';
    btnDown.textContent = '↓';
    btnDown.setAttribute('aria-label', `Move category ${i + 1} down`);
    btnDown.disabled = i === uniques.length - 1;
    btnDown.addEventListener('click', () => {
      reorderCategoricalClasses(i, i + 1);
    });

    tdAct.append(btnUp, btnDown);

    tr.append(tdC, tdCol, tdAct);
    tbody.append(tr);
  });
}

function reorderCategoricalClasses(fromIdx, toIdx) {
  const state = overlayData[currentLayerName] || null;
  if (!state || !Array.isArray(state.vals) || !Array.isArray(state.cols)) return;
  const len = state.vals.length;
  if (!Number.isInteger(fromIdx) || !Number.isInteger(toIdx)) return;
  if (fromIdx < 0 || toIdx < 0 || fromIdx >= len || toIdx >= len || fromIdx === toIdx) return;

  const move = (arr) => {
    if (!Array.isArray(arr) || arr.length !== len) return arr;
    const copy = arr.slice();
    const [item] = copy.splice(fromIdx, 1);
    copy.splice(toIdx, 0, item);
    return copy;
  };

  state.vals = move(state.vals);
  state.cols = move(state.cols);
  if (Array.isArray(state.legendLabels) && state.legendLabels.length === len) {
    state.legendLabels = move(state.legendLabels);
  }
  categoricalUserColors = Array.isArray(state.cols) ? state.cols.slice() : null;
  applyClassification();
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
    newBreaks.push(roundToOneDecimal(parts[0]));
    const colorInput = row.querySelector('input[type="color"]');
    newColors.push(colorInput ? colorInput.value : '#ccc');
  });

  const lastCell = document.querySelector('#classification-table tr:last-child td:nth-child(2)');
  if (lastCell) {
    const lastRange = lastCell.textContent.replace(/[–—]/g, '-').trim();
    const parts = lastRange.split('-').map(p => parseFloat(p.trim()));
    if (parts.length === 2 && !isNaN(parts[1])) newBreaks.push(roundToOneDecimal(parts[1]));
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
      applyHomeView();
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
  setDynamicStyle(popup, { display: "block" });

  setTimeout(() => { setDynamicStyle(popup, { display: "none" }); }, 6000);
}

// --- Sidebar toggle helpers (buttons cached) ---
const btnClassTable = document.getElementById('btnToggleClassTable');
function toggleClassTable() {
  const wrap = document.getElementById('classification-wrapper');
  if (!wrap || !btnClassTable) return;
  const hidden = window.getComputedStyle(wrap).display === 'none';
  setDynamicStyle(wrap, { display: hidden ? "block" : "none" });
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
    setDynamicStyle(wrap, { display: "block" });
    btnClassTable.classList.add('active');
  }

  resetInitialScrollPositions();
});

window.addEventListener('load', resetInitialScrollPositions);

        // --- Secure Export Helper ---
    function isFirefoxBrowser() {
    try {
      return /firefox/i.test(navigator.userAgent || "");
    } catch (e) {
      return false;
    }
    }

    function isEdgeBrowser() {
    try {
      return /edg\//i.test(navigator.userAgent || "");
    } catch (e) {
      return false;
    }
    }

    function isChromeBrowser() {
    try {
      const ua = navigator.userAgent || "";
      return /(chrome|crios)\//i.test(ua) && !/edg\//i.test(ua) && !/opr\//i.test(ua);
    } catch (e) {
      return false;
    }
    }

    function logEdgeExportDebug(stage, payload) {
    // Execution-tracking debug logging removed intentionally.
    void stage;
    void payload;
    }

    function alignMapCanvasForEdge(mapCanvas, mapEl) {
    if (!mapCanvas || !mapEl || !isEdgeBrowser()) return mapCanvas;
    const paneEl = mapEl.querySelector('.leaflet-map-pane');
    if (!paneEl) return mapCanvas;
    const mapRect = mapEl.getBoundingClientRect();
    const paneRect = paneEl.getBoundingClientRect();
    const offsetX = Math.round(paneRect.left - mapRect.left);
    const offsetY = Math.round(paneRect.top - mapRect.top);
    const absMax = Math.max(Math.abs(offsetX), Math.abs(offsetY));
    logEdgeExportDebug("alignMapCanvasForEdge.offset", {
      offsetX,
      offsetY,
      absMax,
      maxAllowed: EDGE_EXPORT_MAX_PANE_OFFSET_PX
    });
    if (Math.abs(offsetX) <= 1 && Math.abs(offsetY) <= 1) return mapCanvas;
    if (absMax > EDGE_EXPORT_MAX_PANE_OFFSET_PX) {
      // Large pane offsets can be normal Leaflet map state, not export drift.
      logEdgeExportDebug("alignMapCanvasForEdge.skipLargeOffset", { offsetX, offsetY });
      return mapCanvas;
    }

    const aligned = document.createElement('canvas');
    aligned.width = mapCanvas.width;
    aligned.height = mapCanvas.height;
    const actx = aligned.getContext('2d');
    if (!actx) return mapCanvas;
    // Apply pane offset in the same direction as on-screen map pane translation.
    actx.drawImage(mapCanvas, offsetX, offsetY);
    return aligned;
    }

    function alignMapCanvasForFractionalTileZoom(mapCanvas) {
    if (!mapCanvas || !map || typeof map.getZoom !== 'function' || typeof map.getZoomScale !== 'function') {
      return mapCanvas;
    }
    let tileZoom = null;
    try {
      map.eachLayer((l) => {
        if (tileZoom != null) return;
        if (l instanceof L.TileLayer && typeof l._tileZoom === 'number') tileZoom = l._tileZoom;
      });
    } catch (e) {
      return mapCanvas;
    }
    if (tileZoom == null) return mapCanvas;
    const currentZoom = Number(map.getZoom());
    if (!Number.isFinite(currentZoom) || !Number.isFinite(tileZoom)) return mapCanvas;
    const dz = currentZoom - tileZoom;
    if (Math.abs(dz) < 1e-4) return mapCanvas;

    const scale = map.getZoomScale(currentZoom, tileZoom);
    if (!Number.isFinite(scale) || scale <= 0 || Math.abs(scale - 1) < 1e-4) return mapCanvas;

    const w = Math.max(1, mapCanvas.width | 0);
    const h = Math.max(1, mapCanvas.height | 0);
    const corrected = document.createElement('canvas');
    corrected.width = w;
    corrected.height = h;
    const cctx = corrected.getContext('2d');
    if (!cctx) return mapCanvas;
    const dstW = w * scale;
    const dstH = h * scale;
    const dstX = (w - dstW) / 2;
    const dstY = (h - dstH) / 2;
    cctx.clearRect(0, 0, w, h);
    cctx.drawImage(mapCanvas, 0, 0, w, h, dstX, dstY, dstW, dstH);
    return corrected;
    }

    function parse2DTransformMatrix(el) {
    if (!el) return { a: 1, d: 1, e: 0, f: 0 };
    let t = "";
    try {
      const cs = window.getComputedStyle(el);
      t = (cs && cs.transform) ? cs.transform : "";
    } catch (e) {}
    if (!t || t === "none") return { a: 1, d: 1, e: 0, f: 0 };
    try {
      if (typeof DOMMatrixReadOnly !== "undefined") {
        const m = new DOMMatrixReadOnly(t);
        return { a: m.a, d: m.d, e: m.e, f: m.f };
      }
    } catch (e) {}
    const m2 = t.match(/^matrix\(([^)]+)\)$/i);
    if (m2) {
      const p = m2[1].split(",").map(v => parseFloat(v.trim()));
      if (p.length === 6 && p.every(Number.isFinite)) return { a: p[0], d: p[3], e: p[4], f: p[5] };
    }
    const m3 = t.match(/^matrix3d\(([^)]+)\)$/i);
    if (m3) {
      const p = m3[1].split(",").map(v => parseFloat(v.trim()));
      if (p.length === 16 && p.every(Number.isFinite)) return { a: p[0], d: p[5], e: p[12], f: p[13] };
    }
    return { a: 1, d: 1, e: 0, f: 0 };
    }

    function compose2DTransform(parent, child) {
    const pa = Number.isFinite(parent?.a) ? parent.a : 1;
    const pd = Number.isFinite(parent?.d) ? parent.d : 1;
    const pe = Number.isFinite(parent?.e) ? parent.e : 0;
    const pf = Number.isFinite(parent?.f) ? parent.f : 0;
    const ca = Number.isFinite(child?.a) ? child.a : 1;
    const cd = Number.isFinite(child?.d) ? child.d : 1;
    const ce = Number.isFinite(child?.e) ? child.e : 0;
    const cf = Number.isFinite(child?.f) ? child.f : 0;
    return {
      a: pa * ca,
      d: pd * cd,
      e: pe + (pa * ce),
      f: pf + (pd * cf)
    };
    }

    function alignMapCanvasToDisplayedTileTransform(mapCanvas, mapEl, options = {}) {
    if (!mapCanvas || !mapEl) return mapCanvas;
    const tilePane = mapEl.querySelector('.leaflet-tile-pane');
    if (!tilePane) return mapCanvas;
    let level = tilePane.querySelector('.leaflet-tile-container');
    if (!level) {
      const levels = Array.from(tilePane.querySelectorAll('.leaflet-tile-container'));
      level = levels.find((el) => (el.offsetWidth > 0 && el.offsetHeight > 0)) || levels[0] || null;
    }

    const paneM = parse2DTransformMatrix(tilePane);
    const levelM = parse2DTransformMatrix(level);
    const combined = compose2DTransform(paneM, levelM);
    const sx = Number.isFinite(combined.a) ? combined.a : 1;
    const sy = Number.isFinite(combined.d) ? combined.d : 1;
    const allowTranslation = options && options.allowTranslation !== false;
    const tx = allowTranslation && Number.isFinite(combined.e) ? combined.e : 0;
    const ty = allowTranslation && Number.isFinite(combined.f) ? combined.f : 0;

    if (Math.abs(sx - 1) < 1e-4 && Math.abs(sy - 1) < 1e-4 && Math.abs(tx) < 0.5 && Math.abs(ty) < 0.5) {
      return mapCanvas;
    }

    logEdgeExportDebug("alignMapCanvasToDisplayedTileTransform.matrix", {
      sx, sy, tx, ty, allowTranslation
    });

    const out = document.createElement('canvas');
    out.width = mapCanvas.width;
    out.height = mapCanvas.height;
    const octx = out.getContext('2d');
    if (!octx) return mapCanvas;
    octx.clearRect(0, 0, out.width, out.height);
    octx.setTransform(sx, 0, 0, sy, tx, ty);
    octx.drawImage(mapCanvas, 0, 0);
    octx.setTransform(1, 0, 0, 1, 0, 0);
    return out;
    }

    function alignMapCanvasForEdgeDisplayedState(mapCanvas, mapEl) {
    if (!mapCanvas || !mapEl || !isEdgeBrowser()) return mapCanvas;
    // Edge can need both tile-level transform and a small map-pane translation.
    const tileAligned = alignMapCanvasToDisplayedTileTransform(mapCanvas, mapEl, { allowTranslation: true });
    const paneAligned = alignMapCanvasForEdge(tileAligned, mapEl);
    logEdgeExportDebug("alignMapCanvasForEdgeDisplayedState", {
      tileAlignedChanged: tileAligned !== mapCanvas,
      paneAlignedChanged: paneAligned !== tileAligned
    });
    return paneAligned;
    }

    function getExportCorrectionDebug(mapCanvas, mapEl) {
    const info = {
      edge: isEdgeBrowser(),
      paneOffsetX: 0,
      paneOffsetY: 0,
      zoom: null,
      tileZoom: null,
      zoomScale: 1
    };
    try {
      if (mapEl) {
        const paneEl = mapEl.querySelector('.leaflet-map-pane');
        if (paneEl) {
          const mapRect = mapEl.getBoundingClientRect();
          const paneRect = paneEl.getBoundingClientRect();
          info.paneOffsetX = Math.round(paneRect.left - mapRect.left);
          info.paneOffsetY = Math.round(paneRect.top - mapRect.top);
        }
      }
      if (map && typeof map.getZoom === 'function') info.zoom = Number(map.getZoom());
      if (map && typeof map.eachLayer === 'function') {
        map.eachLayer((l) => {
          if (info.tileZoom != null) return;
          if (l instanceof L.TileLayer && typeof l._tileZoom === 'number') info.tileZoom = l._tileZoom;
        });
      }
      if (map && typeof map.getZoomScale === 'function' && Number.isFinite(info.zoom) && Number.isFinite(info.tileZoom)) {
        info.zoomScale = map.getZoomScale(info.zoom, info.tileZoom);
      }
    } catch (e) {}
    info.canvasW = mapCanvas ? mapCanvas.width : null;
    info.canvasH = mapCanvas ? mapCanvas.height : null;
    return info;
    }

    function showExportCorrectionDebugMessage(debugInfo) {
    if (!debugInfo) return;
    try {
      logEdgeExportDebug("correction.debugInfo", debugInfo);
    } catch (e) {}
    }

    function buildHtml2CanvasOptions(wrapper) {
    const rect = wrapper.getBoundingClientRect();
    const exportWidth = Math.max(1, Math.ceil(rect.width || wrapper.scrollWidth || wrapper.offsetWidth));
    const exportHeight = Math.max(1, Math.ceil(rect.height || wrapper.scrollHeight || wrapper.offsetHeight));
    const isFirefox = isFirefoxBrowser();
    return {
      scale: isFirefox ? Math.min(1.25, Math.max(1, window.devicePixelRatio || 1)) : Math.min(1.5, Math.max(1, window.devicePixelRatio || 1)),
      useCORS: true,
      foreignObjectRendering: false,
      logging: false,
      backgroundColor: "#ffffff",
      width: exportWidth,
      height: exportHeight,
      windowWidth: exportWidth,
      windowHeight: exportHeight,
      scrollX: 0,
      scrollY: 0
    };
    }

    function getSymmetricWhitespaceSideCropPx(sourceCanvas, scanW, scanH, maxTrimRatio = 0.16) {
    if (!sourceCanvas || typeof sourceCanvas.getContext !== "function") return 0;
    const w = Math.max(1, Math.min(sourceCanvas.width | 0, scanW | 0));
    const h = Math.max(1, Math.min(sourceCanvas.height | 0, scanH | 0));
    if (w <= 2 || h <= 2) return 0;
    const maxTrimPx = Math.max(0, Math.floor(w * Math.max(0, Math.min(0.4, maxTrimRatio))));
    if (maxTrimPx <= 0) return 0;

    const ctx = sourceCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return 0;
    let imgData;
    try {
      imgData = ctx.getImageData(0, 0, w, h);
    } catch (e) {
      return 0;
    }
    const px = imgData.data;
    const nonBlankThreshold = Math.max(2, Math.floor(h * 0.003));

    function isMostlyBlankColumn(x) {
      let nonBlank = 0;
      for (let y = 0; y < h; y++) {
        const idx = ((y * w) + x) * 4;
        const r = px[idx];
        const g = px[idx + 1];
        const b = px[idx + 2];
        const a = px[idx + 3];
        // Transparent or near-white pixels count as blank export margin.
        const blank = (a <= 8) || (a >= 248 && r >= 248 && g >= 248 && b >= 248);
        if (!blank) {
          nonBlank++;
          if (nonBlank > nonBlankThreshold) return false;
        }
      }
      return true;
    }

    let leftBlank = 0;
    while (leftBlank < maxTrimPx && isMostlyBlankColumn(leftBlank)) leftBlank++;
    let rightBlank = 0;
    while (rightBlank < maxTrimPx && isMostlyBlankColumn(w - 1 - rightBlank)) rightBlank++;
    return Math.max(0, Math.min(leftBlank, rightBlank));
    }

    function getExportSideCropPxForBrowser(sourceCanvas, baseCropW, cropH) {
    if (isFirefoxBrowser()) {
      return Math.max(
        0,
        Math.min(
          Math.floor(baseCropW * 0.2),
          Math.round(baseCropW * EXPORT_SIDE_CROP_RATIO) + EXPORT_SIDE_CROP_EXTRA_PX
        )
      );
    }
    if (isEdgeBrowser()) {
      const maxAllowedPerSide = Math.max(0, Math.floor((Math.max(1, baseCropW) - 1) / 2));
      return Math.min(EDGE_EXPORT_FIXED_SIDE_CROP_PX, maxAllowedPerSide);
    }
    if (isChromeBrowser()) {
      const maxAllowedPerSide = Math.max(0, Math.floor((Math.max(1, baseCropW) - 1) / 2));
      return Math.min(CHROME_EXPORT_FIXED_SIDE_CROP_PX, maxAllowedPerSide);
    }
    return 0;
    }

    function reportEdgeExportSpaceReduction(formatLabel, sideCropPx, baseCropW, cropW) {
    if (!isEdgeBrowser()) return;
    const fmt = String(formatLabel || "export").toUpperCase();
    const reducedBy = Math.max(0, (baseCropW | 0) - (cropW | 0));
    logEdgeExportDebug("space-reduction", {
      format: fmt,
      sideCropPx,
      baseCropW,
      cropW,
      reducedBy
    });
    }

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
      const debugInfo = getExportCorrectionDebug(mapCanvas, mapEl);
      const isEdge = isEdgeBrowser();
      const adjustedMapCanvas = isEdge
        // Edge: combine tile transform with map-pane drift correction.
        ? alignMapCanvasForEdgeDisplayedState(mapCanvas, mapEl)
        : alignMapCanvasToDisplayedTileTransform(
            alignMapCanvasForFractionalTileZoom(alignMapCanvasForEdge(mapCanvas, mapEl)),
            mapEl,
            { allowTranslation: true }
          );
      logEdgeExportDebug("pipeline.mode", {
        mode: isEdge ? "edge-tile-plus-pane" : "full"
      });
      showExportCorrectionDebugMessage(debugInfo);
      const mapSize = (map && typeof map.getSize === 'function') ? map.getSize() : null;
      const cssW = (mapSize && mapSize.x > 0) ? mapSize.x : (mapEl ? mapEl.clientWidth : adjustedMapCanvas.width);
      const cssH = (mapSize && mapSize.y > 0) ? mapSize.y : (mapEl ? mapEl.clientHeight : adjustedMapCanvas.height);
      const rawScaleX = cssW > 0 ? (adjustedMapCanvas.width / cssW) : 1;
      const rawScaleY = cssH > 0 ? (adjustedMapCanvas.height / cssH) : rawScaleX;
      const expectedW = Math.round(cssW * rawScaleX);
      const expectedH = Math.round(cssH * rawScaleY);
      const baseCropW = Math.max(1, Math.min(expectedW, adjustedMapCanvas.width));
      const cropH = Math.max(1, Math.min(expectedH, adjustedMapCanvas.height));
      const sideCropPx = getExportSideCropPxForBrowser(adjustedMapCanvas, baseCropW, cropH);
      const cropX = Math.max(0, sideCropPx);
      const cropW = Math.max(1, baseCropW - (2 * sideCropPx));
      if (isEdge) reportEdgeExportSpaceReduction("png/pdf", sideCropPx, baseCropW, cropW);

      const cropped = document.createElement('canvas');
      cropped.width = cropW;
      cropped.height = cropH;
      const cctx = cropped.getContext('2d');
      cctx.drawImage(adjustedMapCanvas, cropX, 0, cropW, cropH, 0, 0, cropW, cropH);

      const W = cropW;
      const H = cropH;

      const wrapper = document.createElement('div');
      wrapper.className = 'export-wrapper';
      wrapper.style.width = W + 'px';
      if (isFirefoxBrowser()) {
        // Firefox: keep export node on-screen for reliable html2canvas capture.
        wrapper.style.transform = 'none';
        wrapper.style.position = 'fixed';
        wrapper.style.left = '0';
        wrapper.style.top = '0';
        wrapper.style.zIndex = '-1';
        wrapper.style.pointerEvents = 'none';
      }
      document.body.appendChild(wrapper);

      const titleEl = document.getElementById('map-title');
      if (titleEl) {
        const t = document.createElement('h1');
        t.className = 'export-title';
        t.textContent = titleEl.textContent || "Map Export";
        t.style.fontSize = '20px';
        t.style.fontWeight = '600';
        t.style.margin = '0 0 8px 0';
        t.style.textAlign = 'center';
        t.style.width = '100%';
        t.style.display = 'block';
        wrapper.appendChild(t);
      }

      const mapWrapper = document.createElement('div');
      mapWrapper.className = 'export-map-wrapper';
      mapWrapper.style.width = W + 'px';
      mapWrapper.style.height = H + 'px';
      mapWrapper.style.position = 'relative';
      mapWrapper.style.overflow = 'hidden';
      wrapper.appendChild(mapWrapper);

      const styleEl = document.createElement('style');
      styleEl.type = 'text/css';
      styleEl.textContent = `
        .export-title{font-size:20px !important;font-weight:600;margin:0 0 8px 0;line-height:1;text-align:center !important;display:block !important;width:100% !important}
        .export-map-wrapper .export-disclaimer-clone{font-size:10px !important;background:rgba(255,255,255,0.95) !important;padding:6px !important;word-break:break-word !important;display:inline-block !important;width:auto !important;text-align:left !important;max-height:calc(1.25em * 6) !important;overflow:hidden !important;white-space:normal !important;line-height:1.25 !important}
        .export-map-wrapper .export-north-arrow-clone{display:flex !important;align-items:center !important;justify-content:center !important;flex-direction:column !important}
        .export-map-wrapper .export-north-arrow-clone .north-arrow-symbol{display:block !important;width:100% !important;text-align:center !important;padding-top:0 !important;line-height:1 !important}
        .export-img{width:100%;height:auto;display:block}
      `;
      wrapper.appendChild(styleEl);

      const img = document.createElement('img');
      img.className = 'export-img';
      img.src = cropped.toDataURL("image/png");
      img.alt = "Exported map image";
      mapWrapper.appendChild(img);

      function copyVisualStyles(sourceNode, targetNode) {
        if (!sourceNode || !targetNode) return;
        const cs = window.getComputedStyle(sourceNode);
        const props = [
          'display', 'visibility', 'opacity',
          'background', 'backgroundColor', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat',
          'border', 'borderTop', 'borderRight', 'borderBottom', 'borderLeft', 'borderColor', 'borderStyle', 'borderWidth', 'borderRadius',
          'boxShadow', 'outline',
          'color', 'font', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign',
          'padding', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'
        ];
        props.forEach((prop) => {
          try { targetNode.style[prop] = cs[prop]; } catch (e) {}
        });
      }

      function copyVisualStylesRecursive(sourceNode, targetNode) {
        copyVisualStyles(sourceNode, targetNode);
        const sourceChildren = Array.from(sourceNode.children || []);
        const targetChildren = Array.from(targetNode.children || []);
        const len = Math.min(sourceChildren.length, targetChildren.length);
        for (let i = 0; i < len; i++) {
          copyVisualStylesRecursive(sourceChildren[i], targetChildren[i]);
        }
      }

      function cloneMapOverlayToExport(selector, className) {
        const source = document.querySelector(selector);
        if (!source || !mapEl) return;
        const mapRect = mapEl.getBoundingClientRect();
        const srcRect = source.getBoundingClientRect();
        if (!srcRect || srcRect.width <= 0 || srcRect.height <= 0) return;

        const clone = source.cloneNode(true);
        if (className) clone.classList.add(className);
        copyVisualStylesRecursive(source, clone);

        const relLeftCss = srcRect.left - mapRect.left;
        const relTopCss = srcRect.top - mapRect.top;
        const exportLeft = Math.max(0, Math.round(relLeftCss * rawScaleX) - cropX);
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
        if (
          source.classList &&
          (source.classList.contains('leaflet-control-exact-scale') || source.classList.contains('map-bottom-scale-control'))
        ) {
          const bottomCss = Math.max(0, mapRect.bottom - srcRect.bottom);
          const exportBottomRaw = Math.max(0, Math.round(bottomCss * rawScaleY));
          const exportBottom = Math.max(6, Math.min(exportBottomRaw, Math.max(6, H - exportHeight)));
          clone.style.top = 'auto';
          clone.style.bottom = exportBottom + 'px';
          clone.style.zIndex = '5';
        }
        if (
          source.classList &&
          source.classList.contains('leaflet-control-north-arrow')
        ) {
          // Inline centering guards against Firefox/html2canvas dropping selector-based alignment.
          clone.style.display = 'flex';
          clone.style.flexDirection = 'column';
          clone.style.alignItems = 'center';
          clone.style.justifyContent = 'center';
          const symbol = clone.querySelector('.north-arrow-symbol');
          if (symbol) {
            symbol.style.display = 'block';
            symbol.style.width = '100%';
            symbol.style.textAlign = 'center';
            symbol.style.paddingTop = '0';
            symbol.style.margin = '0';
            symbol.style.lineHeight = '1';
            symbol.style.position = 'relative';
            symbol.style.left = '0';
            symbol.style.right = '0';
          }
        }
        mapWrapper.appendChild(clone);
        // Final hard clamp inside map frame to prevent spill into legend section.
        if (source.classList && (source.classList.contains('leaflet-control-exact-scale') || source.classList.contains('map-bottom-scale-control'))) {
          const maxBottom = Math.max(0, H - (clone.offsetHeight || exportHeight));
          const currentBottom = Math.max(0, parseFloat(clone.style.bottom || "0") || 0);
          clone.style.bottom = Math.max(0, Math.min(maxBottom, currentBottom)) + 'px';
        }
      }

      // Export disclaimer exactly as currently displayed on map.
      cloneMapOverlayToExport('#disclaimer', 'export-disclaimer-clone');

      // Keep clone attempt for Chrome/Edge fidelity.
      cloneMapOverlayToExport('.leaflet-control-north-arrow', 'export-north-arrow-clone');
      cloneMapOverlayToExport('.leaflet-control-exact-scale, .map-bottom-scale-control', 'export-scale-clone');

      function findMapControlElement(selector) {
        const nodes = Array.from(document.querySelectorAll(selector));
        if (!nodes.length || !mapEl) return null;
        const mapRect = mapEl.getBoundingClientRect();
        return nodes.find((el) => {
          const r = el.getBoundingClientRect();
          return r && r.width > 0 && r.height > 0 &&
            r.right > mapRect.left && r.left < mapRect.right &&
            r.bottom > mapRect.top && r.top < mapRect.bottom;
        }) || nodes[0] || null;
      }

      function ensureNorthArrowFallback() {
        const src = findMapControlElement('.leaflet-control-north-arrow');
        if (!src || !mapEl) return;
        const existing = mapWrapper.querySelector('.export-north-arrow-clone');
        if (existing) return;
        const mapRect = mapEl.getBoundingClientRect();
        const srcRect = src.getBoundingClientRect();
        const left = Math.max(0, Math.round((srcRect.left - mapRect.left) * rawScaleX) - cropX);
        const top = Math.max(0, Math.round((srcRect.top - mapRect.top) * rawScaleY));
        const w = Math.max(20, Math.round(srcRect.width * rawScaleX));
        const h = Math.max(24, Math.round(srcRect.height * rawScaleY));

        const fallback = document.createElement('div');
        fallback.className = 'export-north-arrow-clone';
        fallback.style.position = 'absolute';
        fallback.style.left = left + 'px';
        fallback.style.top = top + 'px';
        fallback.style.width = w + 'px';
        fallback.style.height = h + 'px';
        fallback.style.background = '#ffffff';
        fallback.style.border = '1px solid #cfd6e4';
        fallback.style.borderRadius = '4px';
        fallback.style.display = 'flex';
        fallback.style.flexDirection = 'column';
        fallback.style.alignItems = 'center';
        fallback.style.justifyContent = 'center';
        fallback.style.boxSizing = 'border-box';
        fallback.style.pointerEvents = 'none';

        const letter = document.createElement('div');
        letter.textContent = 'N';
        letter.style.fontSize = Math.max(9, Math.round(h * 0.28)) + 'px';
        letter.style.fontWeight = '700';
        letter.style.lineHeight = '1';
        letter.style.color = '#1e3a8a';
        fallback.appendChild(letter);

        const tri = document.createElement('div');
        tri.style.width = '0';
        tri.style.height = '0';
        tri.style.borderLeft = Math.max(4, Math.round(w * 0.17)) + 'px solid transparent';
        tri.style.borderRight = Math.max(4, Math.round(w * 0.17)) + 'px solid transparent';
        tri.style.borderBottom = Math.max(8, Math.round(h * 0.28)) + 'px solid #1e3a8a';
        tri.style.marginTop = Math.max(1, Math.round(h * 0.05)) + 'px';
        fallback.appendChild(tri);
        mapWrapper.appendChild(fallback);
      }

      function ensureScaleBarFallback() {
        const src = findMapControlElement('.leaflet-control-exact-scale, .map-bottom-scale-control')
          || (scaleControl && typeof scaleControl.getContainer === "function" ? scaleControl.getContainer() : null);
        if (!mapEl) return;
        const existing = mapWrapper.querySelector('.export-scale-clone');
        if (existing) return;
        const mapRect = mapEl.getBoundingClientRect();
        const srcRect = src ? src.getBoundingClientRect() : null;
        const srcWidthCss = (srcRect && srcRect.width > 0) ? srcRect.width : (src ? (src.offsetWidth || 120) : 120);
        const srcHeightCss = (srcRect && srcRect.height > 0) ? srcRect.height : (src ? (src.offsetHeight || 24) : 24);
        let leftCss;
        let topCss;
        let bottomCss = null;
        if (src && src.dataset && src.dataset.leftPx && src.dataset.topPx) {
          leftCss = parseFloat(src.dataset.leftPx) || 0;
          topCss = parseFloat(src.dataset.topPx) || Math.max(0, mapRect.height - srcHeightCss - 8);
          bottomCss = Math.max(0, mapRect.height - (topCss + srcHeightCss));
        } else if (srcRect && srcRect.width > 0 && srcRect.height > 0) {
          leftCss = srcRect.left - mapRect.left;
          topCss = srcRect.top - mapRect.top;
          bottomCss = Math.max(0, mapRect.bottom - srcRect.bottom);
        } else {
          leftCss = Math.max(0, (mapRect.width - srcWidthCss) / 2);
          topCss = Math.max(0, mapRect.height - srcHeightCss - 8);
          bottomCss = Math.max(0, mapRect.height - (topCss + srcHeightCss));
        }
        const left = Math.max(0, Math.round(leftCss * rawScaleX) - cropX);
        const top = Math.max(0, Math.round(topCss * rawScaleY));
        const w = Math.max(70, Math.round(srcWidthCss * rawScaleX));
        const h = Math.max(20, Math.round(srcHeightCss * rawScaleY));
        const bottomRaw = Math.max(0, Math.round((bottomCss == null ? 8 : bottomCss) * rawScaleY));
        const bottom = Math.max(6, Math.min(bottomRaw, Math.max(6, H - h)));
        const labelText = src
          ? (src.querySelector('.exact-scale-label')?.textContent || src.textContent || 'Scale: --').trim()
          : 'Scale: --';

        const fallback = document.createElement('div');
        fallback.className = 'export-scale-clone';
        fallback.style.position = 'absolute';
        fallback.style.left = left + 'px';
        fallback.style.top = 'auto';
        fallback.style.bottom = bottom + 'px';
        fallback.style.width = w + 'px';
        fallback.style.minHeight = h + 'px';
        fallback.style.background = '#ffffff';
        fallback.style.border = '1px solid #cfd6e4';
        fallback.style.borderRadius = '4px';
        fallback.style.padding = '3px 6px';
        fallback.style.boxSizing = 'border-box';
        fallback.style.fontSize = Math.max(8, Math.round(h * 0.32)) + 'px';
        fallback.style.lineHeight = '1.2';
        fallback.style.fontWeight = '400';
        fallback.style.color = '#102a43';
        fallback.style.textAlign = 'center';
        fallback.style.pointerEvents = 'none';
        fallback.textContent = labelText;
        mapWrapper.appendChild(fallback);
      }

      ensureNorthArrowFallback();
      ensureScaleBarFallback();

      function ensureFirefoxGuaranteedOverlays() {
        // Keep Firefox behavior aligned with Chrome by relying on exact clones.
        if (!isFirefoxBrowser()) return;
        return;

        const existingDisc = mapWrapper.querySelector('.export-disclaimer-clone');
        if (!existingDisc) {
          const srcDisc = document.getElementById('disclaimer');
          const fallbackDisc = document.createElement('div');
          fallbackDisc.className = 'export-disclaimer-clone';
          fallbackDisc.style.position = 'absolute';
          fallbackDisc.style.left = '8px';
          fallbackDisc.style.bottom = '-2px';
          fallbackDisc.style.maxWidth = Math.max(140, Math.round(W * 0.45)) + 'px';
          fallbackDisc.style.background = 'rgba(255,255,255,0.95)';
          fallbackDisc.style.padding = '6px';
          fallbackDisc.style.fontSize = '10px';
          fallbackDisc.style.lineHeight = '1.25';
          fallbackDisc.style.color = '#000';
          fallbackDisc.style.textAlign = 'left';
          fallbackDisc.style.zIndex = '6';
          fallbackDisc.textContent = (srcDisc && srcDisc.textContent ? String(srcDisc.textContent).trim() : 'Disclaimer');
          mapWrapper.appendChild(fallbackDisc);
        }

        const existingNorth = mapWrapper.querySelector('.export-north-arrow-clone');
        if (!existingNorth) {
          const na = document.createElement('div');
          na.className = 'export-north-arrow-clone';
          na.style.position = 'absolute';
          na.style.right = '12px';
          na.style.top = '12px';
          na.style.width = '34px';
          na.style.height = '44px';
          na.style.background = '#fff';
          na.style.border = '1px solid #cfd6e4';
          na.style.borderRadius = '4px';
          na.style.display = 'flex';
          na.style.flexDirection = 'column';
          na.style.alignItems = 'center';
          na.style.justifyContent = 'center';
          na.style.boxSizing = 'border-box';
          na.style.zIndex = '6';
          const nText = document.createElement('div');
          nText.textContent = 'N';
          nText.style.fontSize = '12px';
          nText.style.fontWeight = '700';
          nText.style.color = '#1e3a8a';
          nText.style.lineHeight = '1';
          const tri = document.createElement('div');
          tri.style.width = '0';
          tri.style.height = '0';
          tri.style.borderLeft = '6px solid transparent';
          tri.style.borderRight = '6px solid transparent';
          tri.style.borderBottom = '12px solid #1e3a8a';
          tri.style.marginTop = '3px';
          na.appendChild(nText);
          na.appendChild(tri);
          mapWrapper.appendChild(na);
        }

        const existingScale = mapWrapper.querySelector('.export-scale-clone');
        if (!existingScale) {
          const srcScale = (scaleControl && typeof scaleControl.getContainer === "function")
            ? scaleControl.getContainer()
            : null;
          const scaleTxt = srcScale
            ? (srcScale.querySelector('.exact-scale-label')?.textContent || srcScale.textContent || 'Scale: --')
            : 'Scale: --';
          const sb = document.createElement('div');
          sb.className = 'export-scale-clone';
          sb.style.position = 'absolute';
          sb.style.left = Math.max(8, Math.round((W - 140) / 2)) + 'px';
          sb.style.bottom = '-2px';
          sb.style.width = '140px';
          sb.style.minHeight = '22px';
          sb.style.background = '#fff';
          sb.style.border = '1px solid #cfd6e4';
          sb.style.borderRadius = '4px';
          sb.style.padding = '3px 6px';
          sb.style.boxSizing = 'border-box';
          sb.style.fontSize = '8px';
          sb.style.lineHeight = '1.2';
          sb.style.fontWeight = '400';
          sb.style.color = '#102a43';
          sb.style.textAlign = 'center';
          sb.style.zIndex = '6';
          sb.textContent = String(scaleTxt || 'Scale: --').trim();
          mapWrapper.appendChild(sb);
        }
      }

      ensureFirefoxGuaranteedOverlays();

      const legend = document.querySelector('#legend-items');
      if (legend) {
        const clone = legend.cloneNode(true);
        clone.className = 'export-legend-clone';
        copyVisualStylesRecursive(legend, clone);
        clone.style.position = 'relative';
        clone.style.display = 'block';
        clone.style.clear = 'both';
        clone.style.zIndex = '4';
        clone.style.background = 'transparent';
        clone.style.border = '0';
        clone.style.boxShadow = 'none';
        clone.style.outline = 'none';
        clone.style.padding = '0';
        clone.style.marginTop = '10px';
        clone.style.borderRadius = '0';
        clone.style.overflow = 'visible';
        Array.from(clone.querySelectorAll('.legend-block')).forEach((block) => {
          block.style.borderTop = '0';
          block.style.border = '0';
          block.style.boxShadow = 'none';
          block.style.outline = 'none';
          block.style.background = 'transparent';
        });
        Array.from(clone.querySelectorAll('.legend-row')).forEach((row) => {
          row.style.display = 'flex';
          row.style.alignItems = 'center';
          row.style.minHeight = '18px';
        });
        const sourceSyms = Array.from(legend.querySelectorAll('.legend-sym'));
        const cloneSyms = Array.from(clone.querySelectorAll('.legend-sym'));
        cloneSyms.forEach((sym, idx) => {
          const src = sourceSyms[idx];
          if (!src) return;
          const cs = window.getComputedStyle(src);
          const fillColor = (cs && cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)')
            ? cs.backgroundColor
            : '#ccc';
          const borderValue = (cs && cs.border && cs.border !== '0px none rgb(0, 0, 0)')
            ? cs.border
            : '1px solid #333';
          sym.style.display = 'inline-block';
          sym.style.boxSizing = 'border-box';
          sym.style.width = '16px';
          sym.style.minWidth = '16px';
          sym.style.maxWidth = '16px';
          sym.style.height = '16px';
          sym.style.minHeight = '16px';
          sym.style.maxHeight = '16px';
          sym.style.marginRight = '8px';
          sym.style.flex = '0 0 16px';
          sym.style.backgroundColor = fillColor;
          sym.style.border = borderValue;
          if (sym.classList.contains('legend-sym-line')) {
            const lineColor = (cs && cs.borderTopColor && cs.borderTopColor !== 'rgba(0, 0, 0, 0)')
              ? cs.borderTopColor
              : fillColor;
            sym.style.border = '0';
            sym.style.background = 'transparent';
            sym.style.marginTop = '0';
            sym.style.height = '16px';
            sym.style.minHeight = '16px';
            sym.style.maxHeight = '16px';
            sym.style.display = 'inline-flex';
            sym.style.alignItems = 'center';
            sym.style.justifyContent = 'center';
            sym.style.transform = 'none';
            sym.style.color = lineColor;
            sym.style.borderTop = '0';
            sym.textContent = '';
            const lineStroke = document.createElement('span');
            lineStroke.style.display = 'block';
            lineStroke.style.width = '100%';
            lineStroke.style.borderTop = `3px solid ${lineColor}`;
            lineStroke.style.boxSizing = 'border-box';
            sym.appendChild(lineStroke);
          } else if (sym.classList.contains('legend-sym-point')) {
            sym.style.borderRadius = '50%';
            sym.style.transform = 'none';
            sym.style.borderTop = '0';
          } else {
            sym.style.transform = 'none';
            sym.style.borderTop = '0';
          }
        });
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
    }
    const label = loader.querySelector("div:last-child");
    if (label) label.textContent = msg;
    setDynamicStyle(loader, { display: "flex" });
    }

    function hideLoading() {
    const loader = document.getElementById("export-loader");
    if (loader) setDynamicStyle(loader, { display: "none" });
    }

    function wrapCanvasText(ctx, text, maxWidth) {
      const words = String(text || "").split(/\s+/).filter(Boolean);
      const lines = [];
      let line = "";
      for (let i = 0; i < words.length; i++) {
        const candidate = line ? (line + " " + words[i]) : words[i];
        if (ctx.measureText(candidate).width <= maxWidth || !line) {
          line = candidate;
        } else {
          lines.push(line);
          line = words[i];
        }
      }
      if (line) lines.push(line);
      return lines;
    }

    function getExportLegendBlocks() {
      const legendRoot = document.getElementById('legend-items');
      if (!legendRoot) return [];

      const isVisible = (el) => {
        if (!el) return false;
        const cs = window.getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0;
      };

      const blocks = Array.from(legendRoot.querySelectorAll('.legend-block'))
        .filter((block) => isVisible(block));

      return blocks.map((block) => {
        const headerEl = block.querySelector('.legend-header');
        const title = (headerEl?.textContent || '').trim() || 'Legend';
        const rows = Array.from(block.querySelectorAll('.legend-row')).map((row) => {
          const symEl = row.querySelector('.legend-sym');
          const labelEl = row.querySelector('span');
          const cs = symEl ? window.getComputedStyle(symEl) : null;
          const isLine = !!(symEl && symEl.classList.contains('legend-sym-line'));
          const isPoint = !!(symEl && symEl.classList.contains('legend-sym-point'));
          const color = isLine
            ? (cs?.borderTopColor || cs?.borderColor || '#cccccc')
            : (cs?.backgroundColor || '#cccccc');
          return {
            color,
            label: (labelEl?.textContent || '').trim(),
            symbolType: isLine ? 'line' : (isPoint ? 'point' : 'polygon')
          };
        }).filter((row) => row.label);

        return { title, rows };
      }).filter((block) => block.rows.length > 0);
    }

    function buildEdgeDirectExportCanvas(formatLabel, cb, onError) {
      leafletImage(map, (err, mapCanvas) => {
        if (err || !mapCanvas) {
          if (typeof onError === "function") onError(err || new Error("Map canvas unavailable"));
          return;
        }

        const mapEl = document.getElementById('map');
        const debugInfo = getExportCorrectionDebug(mapCanvas, mapEl);
        const adjustedMapCanvas = alignMapCanvasForEdgeDisplayedState(mapCanvas, mapEl);
        logEdgeExportDebug("pipeline.mode", { mode: "edge-direct-canvas-tile-plus-pane" });
        showExportCorrectionDebugMessage(debugInfo);

        const mapSize = (map && typeof map.getSize === 'function') ? map.getSize() : null;
        const cssW = (mapSize && mapSize.x > 0) ? mapSize.x : (mapEl ? mapEl.clientWidth : adjustedMapCanvas.width);
        const cssH = (mapSize && mapSize.y > 0) ? mapSize.y : (mapEl ? mapEl.clientHeight : adjustedMapCanvas.height);
        const rawScaleX = cssW > 0 ? (adjustedMapCanvas.width / cssW) : 1;
        const rawScaleY = cssH > 0 ? (adjustedMapCanvas.height / cssH) : rawScaleX;
        const expectedW = Math.round(cssW * rawScaleX);
        const expectedH = Math.round(cssH * rawScaleY);
        const baseCropW = Math.max(1, Math.min(expectedW, adjustedMapCanvas.width));
        const cropH = Math.max(1, Math.min(expectedH, adjustedMapCanvas.height));
        const sideCropPx = getExportSideCropPxForBrowser(adjustedMapCanvas, baseCropW, cropH);
        const cropX = Math.max(0, sideCropPx);
        const cropW = Math.max(1, baseCropW - (2 * sideCropPx));
        reportEdgeExportSpaceReduction(formatLabel || "png/pdf", sideCropPx, baseCropW, cropW);

        const cropped = document.createElement('canvas');
        cropped.width = cropW;
        cropped.height = cropH;
        const cctx = cropped.getContext('2d');
        if (!cctx) {
          if (typeof onError === "function") onError(new Error("Crop canvas context unavailable"));
          return;
        }
        cctx.drawImage(adjustedMapCanvas, cropX, 0, cropW, cropH, 0, 0, cropW, cropH);

        const titleText = (document.getElementById('map-title')?.textContent || 'Map Export').trim();
        const disclaimerText = (document.getElementById('disclaimer')?.textContent || '').trim();
        const disclaimerEl = document.getElementById('disclaimer');
        const scaleControlEl = document.querySelector('.leaflet-control-exact-scale, .map-bottom-scale-control');
        const northArrowEl = document.querySelector('.leaflet-control-north-arrow');
        const mapRect = mapEl ? mapEl.getBoundingClientRect() : null;
        const scaleText = (document.querySelector('.leaflet-control-exact-scale .exact-scale-label')?.textContent
          || document.querySelector('.map-bottom-scale-control .exact-scale-label')?.textContent
          || '').trim();
        const legendBlocks = getExportLegendBlocks();

        const titleH = 36;
        const legendHeaderH = 24;
        const legendRowH = 20;
        const legendBlockGap = 10;
        const legendTopPad = 8;
        const legendBottomPad = 8;
        const legendH = legendBlocks.length
          ? (legendTopPad + legendBottomPad + legendBlocks.reduce((sum, block, idx) => {
              const blockH = legendHeaderH + (block.rows.length * legendRowH);
              return sum + blockH + (idx > 0 ? legendBlockGap : 0);
            }, 0))
          : 0;
        const outW = cropW;
        const outH = titleH + cropH + legendH;

        const out = document.createElement('canvas');
        out.width = outW;
        out.height = outH;
        const octx = out.getContext('2d');
        if (!octx) {
          if (typeof onError === "function") onError(new Error("Export canvas context unavailable"));
          return;
        }

        octx.fillStyle = '#ffffff';
        octx.fillRect(0, 0, outW, outH);
        octx.fillStyle = '#222222';
        octx.font = '600 20px Segoe UI, sans-serif';
        octx.textAlign = 'center';
        octx.textBaseline = 'middle';
        octx.fillText(titleText, Math.round(outW / 2), Math.round(titleH / 2));

        octx.drawImage(cropped, 0, titleH);

        // Draw north arrow where it is currently placed on the live map.
        {
          const naRect = northArrowEl ? northArrowEl.getBoundingClientRect() : null;
          const naW = (naRect && naRect.width > 0) ? Math.max(22, Math.round(naRect.width * rawScaleX)) : 34;
          const naH = (naRect && naRect.height > 0) ? Math.max(28, Math.round(naRect.height * rawScaleY)) : 44;
          const naLeftCss = (naRect && mapRect) ? (naRect.left - mapRect.left) : (cssW - (naW / rawScaleX) - 12);
          const naTopCss = (naRect && mapRect) ? (naRect.top - mapRect.top) : 12;
          let naX = Math.round(naLeftCss * rawScaleX) - cropX;
          let naY = titleH + Math.round(naTopCss * rawScaleY);
          naX = Math.max(0, Math.min(outW - naW, naX));
          naY = Math.max(titleH, Math.min((titleH + cropH) - naH, naY));
          octx.fillStyle = '#ffffff';
          octx.strokeStyle = '#cfd6e4';
          octx.lineWidth = 1;
          octx.beginPath();
          octx.rect(naX, naY, naW, naH);
          octx.fill();
          octx.stroke();

          octx.fillStyle = '#1e3a8a';
          octx.font = '700 12px Segoe UI, sans-serif';
          octx.textAlign = 'center';
          octx.textBaseline = 'top';
          octx.fillText('N', naX + Math.round(naW / 2), naY + 4);

          const triTop = naY + 20;
          const triW = 12;
          const triH = 12;
          const triCX = naX + Math.round(naW / 2);
          octx.beginPath();
          octx.moveTo(triCX, triTop);
          octx.lineTo(triCX - Math.round(triW / 2), triTop + triH);
          octx.lineTo(triCX + Math.round(triW / 2), triTop + triH);
          octx.closePath();
          octx.fill();
        }

        if (disclaimerText) {
          const pad = 6;
          const lineH = 13;
          const maxLines = 5;
          const edgeDiscExpandLeftPx = 8;
          const edgeDiscExpandWidthPx = 28;
          const discRect = disclaimerEl ? disclaimerEl.getBoundingClientRect() : null;
          const sourceDiscW = (discRect && discRect.width > 0) ? Math.round(discRect.width * rawScaleX) : Math.round(outW * 0.46);
          const sourceDiscH = (discRect && discRect.height > 0) ? Math.round(discRect.height * rawScaleY) : Math.round(cropH * 0.15);
          const maxW = Math.max(130, Math.min(Math.round(outW * 0.56), sourceDiscW + edgeDiscExpandWidthPx));
          octx.font = 'italic 11px Segoe UI, sans-serif';
          octx.textAlign = 'left';
          octx.textBaseline = 'top';
          const wrapped = wrapCanvasText(octx, disclaimerText, maxW - (pad * 2));
          const truncated = wrapped.length > maxLines;
          const lines = wrapped.slice(0, maxLines);
          if (truncated && lines.length) {
            lines[lines.length - 1] = lines[lines.length - 1].replace(/[\s.,;:!?-]*$/, '') + '...';
          }
          let boxH = (maxLines * lineH) + (pad * 2);
          if (sourceDiscH > 0) {
            boxH = Math.max(boxH, Math.min(Math.round(cropH * 0.32), sourceDiscH));
          }
          const discLeftCss = (discRect && mapRect) ? (discRect.left - mapRect.left) : 8;
          const discTopCss = (discRect && mapRect) ? (discRect.top - mapRect.top) : (cssH - (boxH / rawScaleY) - 28);
          let x = Math.round(discLeftCss * rawScaleX) - cropX - edgeDiscExpandLeftPx;
          let y = titleH + Math.round(discTopCss * rawScaleY);
          x = Math.max(0, Math.min(outW - maxW, x));
          y = Math.max(titleH, Math.min((titleH + cropH) - boxH, y));
          octx.fillStyle = 'rgba(255,255,255,0.93)';
          octx.fillRect(x, y, maxW, boxH);
          octx.fillStyle = '#333333';
          const drawJustifiedLine = (ctx, line, startX, baselineY, maxTextW, isLast) => {
            const words = String(line || '').trim().split(/\s+/).filter(Boolean);
            if (isLast || words.length <= 1 || /\.\.\.$/.test(line)) {
              ctx.fillText(line, startX, baselineY);
              return;
            }
            const wordsWidth = words.reduce((sum, w) => sum + ctx.measureText(w).width, 0);
            const gaps = words.length - 1;
            const baseSpace = ctx.measureText(' ').width;
            const minNaturalWidth = wordsWidth + (baseSpace * gaps);
            if (minNaturalWidth >= maxTextW) {
              ctx.fillText(line, startX, baselineY);
              return;
            }
            const extraSpace = (maxTextW - minNaturalWidth) / gaps;
            let cursor = startX;
            for (let j = 0; j < words.length; j++) {
              const w = words[j];
              ctx.fillText(w, cursor, baselineY);
              cursor += ctx.measureText(w).width;
              if (j < gaps) cursor += baseSpace + extraSpace;
            }
          };
          for (let i = 0; i < lines.length; i++) {
            drawJustifiedLine(
              octx,
              lines[i],
              x + pad,
              y + pad + (i * lineH),
              maxW - (pad * 2),
              i === lines.length - 1
            );
          }
        }

        if (scaleText) {
          const sbRect = scaleControlEl ? scaleControlEl.getBoundingClientRect() : null;
          const sourceBoxW = (sbRect && sbRect.width > 0) ? Math.max(90, Math.round(sbRect.width * rawScaleX)) : 108;
          const boxH = (sbRect && sbRect.height > 0) ? Math.max(18, Math.round(sbRect.height * rawScaleY)) : 20;
          const scaleFontPx = Math.max(8, Math.round(8 * rawScaleY));
          octx.font = `${scaleFontPx}px Segoe UI, sans-serif`;
          const measuredW = Math.ceil(octx.measureText(scaleText).width) + 14;
          const boxW = Math.max(sourceBoxW, measuredW);
          const sbLeftCss = (sbRect && mapRect) ? (sbRect.left - mapRect.left) : ((cssW - (boxW / rawScaleX)) / 2);
          const sbTopCss = (sbRect && mapRect) ? (sbRect.top - mapRect.top) : (cssH - (boxH / rawScaleY) - 8);
          let x = Math.round(sbLeftCss * rawScaleX) - cropX;
          let y = titleH + Math.round(sbTopCss * rawScaleY) - 8;
          x = Math.max(0, Math.min(outW - boxW, x));
          y = Math.max(titleH, Math.min((titleH + cropH) - boxH, y));
          octx.fillStyle = 'rgba(255,255,255,0.95)';
          octx.fillRect(x, y, boxW, boxH);
          octx.strokeStyle = '#cfd6e4';
          octx.lineWidth = 1;
          octx.strokeRect(x, y, boxW, boxH);
          octx.fillStyle = '#102a43';
          octx.font = `${scaleFontPx}px Segoe UI, sans-serif`;
          octx.textAlign = 'center';
          octx.textBaseline = 'middle';
          octx.fillText(scaleText, x + Math.round(boxW / 2), y + Math.round(boxH / 2));
        }

        if (legendBlocks.length) {
          let y = titleH + cropH + legendTopPad;
          octx.textAlign = 'left';
          octx.textBaseline = 'top';

          legendBlocks.forEach((block, blockIdx) => {
            if (blockIdx > 0) y += legendBlockGap;

            octx.fillStyle = '#222222';
            octx.font = '600 20px Segoe UI, sans-serif';
            octx.fillText(String(block.title || 'Legend'), 6, y);
            y += legendHeaderH;

            octx.font = '400 15px Segoe UI, sans-serif';
            block.rows.forEach((entry) => {
              const color = entry.color || '#cccccc';
              const symbolType = entry.symbolType || 'polygon';
              const symbolX = 6;
              const symbolY = y;
              const symbolSize = 16;

              if (symbolType === 'line') {
                octx.strokeStyle = color;
                octx.lineWidth = 3;
                octx.beginPath();
                octx.moveTo(symbolX, symbolY + 8);
                octx.lineTo(symbolX + symbolSize, symbolY + 8);
                octx.stroke();
              } else if (symbolType === 'point') {
                octx.fillStyle = color;
                octx.beginPath();
                octx.arc(symbolX + 8, symbolY + 8, 7, 0, Math.PI * 2);
                octx.fill();
              } else {
                octx.fillStyle = color;
                octx.fillRect(symbolX, symbolY, symbolSize, symbolSize);
                octx.strokeStyle = '#333333';
                octx.lineWidth = 1;
                octx.strokeRect(symbolX, symbolY, symbolSize, symbolSize);
              }

              octx.fillStyle = '#333333';
              octx.fillText(String(entry.label || ''), 30, y - 2);
              y += legendRowH;
            });
          });
        }

        cb(out);
      });
    }

    function exportMap() {
      if (isEdgeBrowser()) {
        showLoading("Exporting map as PNG...");
        buildEdgeDirectExportCanvas(
          "png",
          (canvas) => {
            const a = document.createElement('a');
            a.href = canvas.toDataURL('image/png');
            a.download = 'map.png';
            a.rel = 'noopener';
            a.click();
            hideLoading();
          },
          (err) => {
            console.error("Edge PNG export failed:", err);
            hideLoading();
          }
        );
        return;
      }
      showLoading("Exporting map as PNG...");
      compositeExportElement(wrapper => {
        html2canvas(wrapper, buildHtml2CanvasOptions(wrapper))
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
        if (isEdgeBrowser()) {
          showLoading("Exporting map as PDF...");
          buildEdgeDirectExportCanvas(
            "pdf",
            (canvas) => {
              const imgData = canvas.toDataURL('image/png');
              const orientation = canvas.width >= canvas.height ? 'landscape' : 'portrait';
              const pdf = new jspdf.jsPDF({
                orientation,
                unit: 'px',
                format: [canvas.width, canvas.height]
              });
              pdf.addImage(imgData, 'PNG', 0, 0, canvas.width, canvas.height);
              pdf.save('map.pdf');
              hideLoading();
            },
            (err) => {
              console.error("Edge PDF export failed:", err);
              hideLoading();
            }
          );
          return;
        }
        showLoading("Exporting map as PDF...");
        compositeExportElement(wrapper => {
            html2canvas(wrapper, buildHtml2CanvasOptions(wrapper))
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

function trimHorizontalWhitespaceWithOffset(sourceCanvas, maxTrimRatio = 0.25) {
  if (!sourceCanvas || typeof sourceCanvas.getContext !== "function") {
    return { canvas: sourceCanvas, leftTrim: 0 };
  }
  const w = Math.max(1, sourceCanvas.width | 0);
  const h = Math.max(1, sourceCanvas.height | 0);
  const ctx = sourceCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { canvas: sourceCanvas, leftTrim: 0 };

  let imgData;
  try {
    imgData = ctx.getImageData(0, 0, w, h);
  } catch (e) {
    return { canvas: sourceCanvas, leftTrim: 0 };
  }
  const px = imgData.data;
  const maxTrimPx = Math.max(0, Math.floor(w * Math.max(0, Math.min(0.45, maxTrimRatio))));
  const nonBlankThreshold = Math.max(2, Math.floor(h * 0.002));

  function isMostlyBlankColumn(x) {
    let nonBlank = 0;
    for (let y = 0; y < h; y++) {
      const idx = ((y * w) + x) * 4;
      const r = px[idx];
      const g = px[idx + 1];
      const b = px[idx + 2];
      const a = px[idx + 3];
      // Count transparent and near-white pixels as blank export margin.
      const blank = (a <= 8) || (a >= 248 && r >= 248 && g >= 248 && b >= 248);
      if (!blank) {
        nonBlank++;
        if (nonBlank > nonBlankThreshold) return false;
      }
    }
    return true;
  }

  let left = 0;
  while (left < maxTrimPx && isMostlyBlankColumn(left)) left++;
  let right = w - 1;
  while (right >= (w - maxTrimPx) && isMostlyBlankColumn(right)) right--;
  const trimmedW = Math.max(1, right - left + 1);
  if (left === 0 && trimmedW === w) return { canvas: sourceCanvas, leftTrim: 0 };

  const trimmed = document.createElement("canvas");
  trimmed.width = trimmedW;
  trimmed.height = h;
  const tctx = trimmed.getContext("2d");
  if (!tctx) return { canvas: sourceCanvas, leftTrim: 0 };
  tctx.drawImage(sourceCanvas, left, 0, trimmedW, h, 0, 0, trimmedW, h);
  return { canvas: trimmed, leftTrim: left };
}

function getHorizontalInkCenterShift(sourceCanvas) {
  if (!sourceCanvas || typeof sourceCanvas.getContext !== "function") return 0;
  const w = Math.max(1, sourceCanvas.width | 0);
  const h = Math.max(1, sourceCanvas.height | 0);
  const ctx = sourceCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return 0;

  let imgData;
  try {
    imgData = ctx.getImageData(0, 0, w, h);
  } catch (e) {
    return 0;
  }
  const px = imgData.data;
  const nonBlankThreshold = Math.max(2, Math.floor(h * 0.002));

  function isMostlyBlankColumn(x) {
    let nonBlank = 0;
    for (let y = 0; y < h; y++) {
      const idx = ((y * w) + x) * 4;
      const r = px[idx];
      const g = px[idx + 1];
      const b = px[idx + 2];
      const a = px[idx + 3];
      const blank = (a <= 8) || (a >= 248 && r >= 248 && g >= 248 && b >= 248);
      if (!blank) {
        nonBlank++;
        if (nonBlank > nonBlankThreshold) return false;
      }
    }
    return true;
  }

  let left = 0;
  while (left < w && isMostlyBlankColumn(left)) left++;
  let right = w - 1;
  while (right >= 0 && isMostlyBlankColumn(right)) right--;
  if (left >= w || right < 0 || right <= left) return 0;

  const inkWidth = right - left + 1;
  const desiredLeft = (w - inkWidth) / 2;
  return Math.round(desiredLeft - left);
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
      const debugInfo = getExportCorrectionDebug(mapCanvas, mapEl);
      const isEdge = isEdgeBrowser();
      const adjustedMapCanvas = isEdge
        // Edge: combine tile transform with map-pane drift correction.
        ? alignMapCanvasForEdgeDisplayedState(mapCanvas, mapEl)
        : alignMapCanvasToDisplayedTileTransform(
            alignMapCanvasForFractionalTileZoom(alignMapCanvasForEdge(mapCanvas, mapEl)),
            mapEl,
            { allowTranslation: true }
          );
      logEdgeExportDebug("pipeline.mode", {
        mode: isEdge ? "edge-tile-plus-pane" : "full"
      });
      showExportCorrectionDebugMessage(debugInfo);
      const canvasPixelWidth  = adjustedMapCanvas.width;
      const canvasPixelHeight = adjustedMapCanvas.height;

      // container CSS size and scale factor
      const mapSize = (map && typeof map.getSize === 'function') ? map.getSize() : null;
      const containerWidth  = (mapSize && mapSize.x > 0) ? mapSize.x : (mapEl.clientWidth || canvasPixelWidth);
      const containerHeight = (mapSize && mapSize.y > 0) ? mapSize.y : (mapEl.clientHeight || canvasPixelHeight);
      // clamp scale to avoid excessively large exported font sizes when
      // device or canvas ratios are large. Keep within [1,2] for stability.
      const rawScaleX = containerWidth > 0 ? (canvasPixelWidth / containerWidth) : 1;
      const rawScaleY = containerHeight > 0 ? (canvasPixelHeight / containerHeight) : rawScaleX;
      const uiScale = Math.min(Math.max(rawScaleX, 1), 2);

      // title/legend heights (CSS -> canvas px)
      const marginCss = 10;
      const titleHeightCss = titleEl ? (titleEl.getBoundingClientRect().height + marginCss) : 0;
      const legendHeightCss = legendEl ? (legendEl.getBoundingClientRect().height + marginCss) : 0;
      const titleHeightPx  = Math.round(titleHeightCss * uiScale);
      const marginPx = Math.round(marginCss * uiScale);

      const overlay = overlayData[currentLayerName] || {};
      const legendRows = (overlay.vals && overlay.cols)
        ? (overlay.isNumeric ? Math.max(0, overlay.vals.length - 1) : overlay.vals.length)
        : 0;
      const legendBoxSize = Math.max(8, Math.round(12 * uiScale));
      const legendRowGap = Math.round(6 * uiScale);
      const legendHeaderGap = Math.round(18 * uiScale);
      const computedLegendHeightPx = legendRows
        ? (marginPx + legendHeaderGap + (legendRows * (legendBoxSize + legendRowGap)))
        : 0;
      const legendHeightPx = Math.max(Math.round(legendHeightCss * uiScale), computedLegendHeightPx);

      // expected canvas pixels for visible map area
      const expectedCanvasW = Math.round(containerWidth * rawScaleX);
      const expectedCanvasH = Math.round(containerHeight * rawScaleY);

      // LEFT-ALIGNED CROP: use cropX = 0 to avoid centered empty right area
      const baseCropW = Math.min(expectedCanvasW, canvasPixelWidth);
      const cropH = Math.min(expectedCanvasH, canvasPixelHeight);
      const sideCropPx = getExportSideCropPxForBrowser(adjustedMapCanvas, baseCropW, cropH);
      const cropW = Math.max(1, baseCropW - (2 * sideCropPx));
      const cropX = sideCropPx;
      const cropY = 0; // top-align crop
      if (isEdge) reportEdgeExportSpaceReduction("svg", sideCropPx, baseCropW, cropW);

      // Debug logging to help tune if needed
      console.info("SVG export debug:",
        { canvasPixelWidth, canvasPixelHeight, containerWidth, containerHeight, uiScale,
          expectedCanvasW, expectedCanvasH, cropW, cropH, cropX, cropY, titleHeightPx, legendHeightPx });

      // draw cropped region to offscreen canvas
      const cropped = document.createElement('canvas');
      cropped.width = cropW;
      cropped.height = cropH;
      const cctx = cropped.getContext('2d');
      cctx.drawImage(adjustedMapCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      const trimInfo = isFirefoxBrowser()
        ? trimHorizontalWhitespaceWithOffset(cropped, 0.4)
        : { canvas: cropped, leftTrim: 0 };
      const exportCanvas = trimInfo.canvas || cropped;
      const extraTrimX = Math.max(0, trimInfo.leftTrim || 0);

      const usedCanvasWidth  = Math.max(1, exportCanvas.width);
      const usedCanvasHeight = Math.max(1, exportCanvas.height);

      // Firefox can trim asymmetric side whitespace; center trimmed map content
      // in the original crop frame to match Chrome/Edge visual alignment.
      const totalWidthPx  = isFirefoxBrowser() ? Math.max(usedCanvasWidth, cropW) : usedCanvasWidth;
      const totalHeightPx = titleHeightPx + usedCanvasHeight + legendHeightPx + (marginPx * 2);
      const contentOffsetX = Math.max(0, Math.round((totalWidthPx - usedCanvasWidth) / 2));
      const firefoxInkCenterShiftX = isFirefoxBrowser() ? getHorizontalInkCenterShift(exportCanvas) : 0;
      const minContentOffsetX = 0;
      const maxContentOffsetX = Math.max(0, totalWidthPx - usedCanvasWidth);
      const alignedContentOffsetX = Math.max(
        minContentOffsetX,
        Math.min(maxContentOffsetX, contentOffsetX + firefoxInkCenterShiftX)
      );

      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("xmlns", svgNS);
      svg.setAttribute("xmlns:xlink", XLINK);
      const isFirefoxExport = isFirefoxBrowser();
      svg.setAttribute("width", isFirefoxExport ? "100%" : String(totalWidthPx));
      svg.setAttribute("height", isFirefoxExport ? "100%" : String(totalHeightPx));
      if (isFirefoxExport) {
        // Preserve authored dimensions for tools while letting Firefox center in viewport.
        svg.setAttribute("data-export-width", String(totalWidthPx));
        svg.setAttribute("data-export-height", String(totalHeightPx));
      }
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
        title.setAttribute("y", String(Math.max(Math.round(18 * uiScale), titleHeightPx - Math.round(marginPx / 2))));
        title.setAttribute("text-anchor", "middle");
        title.setAttribute("font-family", "Segoe UI, sans-serif");
        // clamp font size between 12px and 24px to avoid oversized headings
        const fs = Math.round(Math.max(12, Math.min(24, 18 * uiScale)));
        title.setAttribute("font-size", String(fs));
        title.setAttribute("font-weight", "600");
        title.textContent = safeTitle;
        svg.appendChild(title);
      }

      // embed cropped image
      const imgDataUrl = exportCanvas.toDataURL("image/png");
      const img = document.createElementNS(svgNS, "image");
      img.setAttributeNS(XLINK, "xlink:href", imgDataUrl);
      img.setAttribute("href", imgDataUrl);
      img.setAttribute("x", String(alignedContentOffsetX));
      img.setAttribute("y", String(titleHeightPx));
      img.setAttribute("width", String(usedCanvasWidth));
      img.setAttribute("height", String(usedCanvasHeight));
      svg.appendChild(img);

      // project coords into cropped canvas pixel space (subtract crop offsets)
      function projectCoordToCanvas(coord) {
        const latlng = L.latLng(coord[1], coord[0]);
        const layerPoint = map.latLngToLayerPoint(latlng);
        const containerPoint = map.layerPointToContainerPoint(layerPoint); // CSS px
        const x = (containerPoint.x * rawScaleX) - cropX - extraTrimX + alignedContentOffsetX;
        const y = (containerPoint.y * rawScaleY) - cropY + titleHeightPx;
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

      const visibleOrderedNames = getOrderedLayerNames().filter(name => {
        const group = overlayData[name] && overlayData[name].layerGroup;
        return !!(group && map && map.hasLayer(group));
      });
      const topVisibleName = visibleOrderedNames.length ? visibleOrderedNames[0] : null;
      // Keep SVG stacking aligned with layer list: only redraw current vectors when current is topmost.
      const shouldDrawCurrentVectors = !topVisibleName || topVisibleName === currentLayerName;

      // draw features
      if (shouldDrawCurrentVectors) {
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
                path.setAttribute("stroke-width", String(Math.max(0.5, style.strokeWidth * rawScaleX)));
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
              path.setAttribute("stroke-width", String(Math.max(0.5, style.strokeWidth * rawScaleX)));
              svg.appendChild(path);
            });
          } else if (geom.type === "Point" || geom.type === "MultiPoint") {
            const pts = geom.type === "Point" ? [geom.coordinates] : geom.coordinates;
            pts.forEach(coord => {
              const [x, y] = projectCoordToCanvas(coord);
              const circle = document.createElementNS(svgNS, "circle");
              const r = Math.max(1, Math.round(getPointRadius() * rawScaleX));
              circle.setAttribute("cx", String(x));
              circle.setAttribute("cy", String(y));
              circle.setAttribute("r", String(r));
              circle.setAttribute("fill", style.fill || "#ccc");
              circle.setAttribute("stroke", style.stroke || "#000");
              circle.setAttribute("stroke-width", String(Math.max(0.5, style.strokeWidth * rawScaleX)));
              svg.appendChild(circle);
            });
          }
        });
      }

      // disclaimer rendered as pure SVG to avoid foreignObject inconsistencies
      const safeDisclaimer = safeText(disclaimerEl);
      if (safeDisclaimer) {
        const discRect = disclaimerEl ? disclaimerEl.getBoundingClientRect() : null;
        const mapRect = mapEl ? mapEl.getBoundingClientRect() : null;
        const discX = alignedContentOffsetX + Math.max(6, Math.round(8 * rawScaleX));
        const desiredWidth = discRect ? Math.round(discRect.width * rawScaleX * 1.18) : Math.round(230 * uiScale);
        let discWidth = Math.max(
          Math.round(120 * uiScale),
          Math.min(desiredWidth, Math.max(120, usedCanvasWidth - discX - marginPx))
        );
        const fontSizeDisc = Math.max(8, Math.round(10 * uiScale));
        const lineHeightDisc = Math.round(fontSizeDisc * 1.25);
        const padding = Math.max(4, Math.round(5 * uiScale));
        const maxLines = 5;
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
        const tightWidth = Math.max(Math.round(120 * uiScale), measuredTextWidth + (padding * 2));
        discWidth = Math.min(discWidth, tightWidth);

        const discHeight = (padding * 2) + (lines.length * lineHeightDisc);
        let discY = discRect && mapRect
          ? (() => {
              const bottomCss = Math.max(0, mapRect.bottom - discRect.bottom);
              const bottomPx = Math.max(0, Math.round(bottomCss * rawScaleY));
              return Math.max(
                titleHeightPx,
                titleHeightPx + usedCanvasHeight - discHeight - bottomPx
              );
            })()
          : (titleHeightPx + usedCanvasHeight - discHeight - marginPx);
        const discYMin = titleHeightPx + 2;
        const discYMax = Math.max(discYMin, (titleHeightPx + usedCanvasHeight - discHeight - 2));
        discY = Math.max(discYMin, Math.min(discYMax, discY));

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
          const isLastLine = idx === lines.length - 1;
          const shouldJustify = !isLastLine && !/\.\.\.$/.test(ln) && /\s/.test(ln);
          if (shouldJustify) {
            tspan.setAttribute("textLength", String(Math.max(1, discWidth - (padding * 2))));
            tspan.setAttribute("lengthAdjust", "spacing");
          }
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
        const naX = Math.max(0, Math.round((naRect.left - mapRect.left) * rawScaleX) - cropX - extraTrimX + alignedContentOffsetX);
        let naY = titleHeightPx + Math.max(0, Math.round((naRect.top - mapRect.top) * rawScaleY) - cropY);
        const naYMin = titleHeightPx + 2;
        const naYMax = Math.max(naYMin, (titleHeightPx + usedCanvasHeight - naH - 2));
        naY = Math.max(naYMin, Math.min(naYMax, naY));

        const naBg = document.createElementNS(svgNS, "rect");
        naBg.setAttribute("x", String(naX));
        naBg.setAttribute("y", String(naY));
        naBg.setAttribute("width", String(naW));
        naBg.setAttribute("height", String(naH));
        naBg.setAttribute("rx", String(Math.max(2, Math.round(3 * uiScale))));
        naBg.setAttribute("fill", "#ffffff");
        naBg.setAttribute("stroke", "#cfd6e4");
        svg.appendChild(naBg);

        const naText = document.createElementNS(svgNS, "text");
        naText.setAttribute("x", String(naX + Math.round(naW / 2)));
        naText.setAttribute("y", String(naY + Math.max(10, Math.round(12 * uiScale))));
        naText.setAttribute("text-anchor", "middle");
        naText.setAttribute("font-size", String(Math.max(9, Math.round(12 * uiScale))));
        naText.setAttribute("font-family", "Segoe UI, sans-serif");
        naText.setAttribute("font-weight", "700");
        naText.setAttribute("fill", "#1e3a8a");
        naText.textContent = "N";
        svg.appendChild(naText);

        const triW = Math.max(8, Math.round(12 * uiScale));
        const triH = Math.max(8, Math.round(12 * uiScale));
        const triCX = naX + Math.round(naW / 2);
        const triTop = naY + Math.max(14, Math.round(18 * uiScale));
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
        let sbX = Math.max(0, Math.round((sbRect.left - mapRect.left) * rawScaleX) - cropX - extraTrimX + alignedContentOffsetX);
        let sbY = titleHeightPx + Math.max(0, Math.round((sbRect.top - mapRect.top) * rawScaleY) - cropY);
        sbY -= Math.max(2, Math.round(4 * uiScale));
        const sbTextRaw = scaleBarEl.querySelector('.exact-scale-label')?.textContent || "Scale: --";
        const sbText = String(sbTextRaw).slice(0, MAX_TEXT_LENGTH);
        const sbXMin = alignedContentOffsetX;
        const sbXMax = Math.max(sbXMin, alignedContentOffsetX + usedCanvasWidth - sbW - 2);
        sbX = Math.max(sbXMin, Math.min(sbXMax, sbX));
        const sbYMin = titleHeightPx + 2;
        const sbYMax = Math.max(sbYMin, (titleHeightPx + usedCanvasHeight - sbH - 2));
        sbY = Math.max(sbYMin, Math.min(sbYMax, sbY));

        const sbBg = document.createElementNS(svgNS, "rect");
        sbBg.setAttribute("x", String(sbX));
        sbBg.setAttribute("y", String(sbY));
        sbBg.setAttribute("width", String(sbW));
        sbBg.setAttribute("height", String(sbH));
        sbBg.setAttribute("rx", String(Math.max(2, Math.round(3 * uiScale))));
        sbBg.setAttribute("fill", "#ffffff");
        sbBg.setAttribute("stroke", "#cfd6e4");
        svg.appendChild(sbBg);

        const sbTextEl = document.createElementNS(svgNS, "text");
        sbTextEl.setAttribute("x", String(sbX + Math.round(sbW / 2)));
        sbTextEl.setAttribute("y", String(sbY + Math.round(sbH / 2) + Math.round(3 * uiScale)));
        sbTextEl.setAttribute("text-anchor", "middle");
        sbTextEl.setAttribute("font-size", String(Math.max(8, Math.round(8 * uiScale))));
        sbTextEl.setAttribute("font-family", "Segoe UI, sans-serif");
        sbTextEl.setAttribute("font-weight", "400");
        sbTextEl.setAttribute("fill", "#102a43");
        sbTextEl.textContent = sbText;
        svg.appendChild(sbTextEl);
      }

      // legend below map (follow visible layer-list order exactly; first item stays on top)
      if (legendEl && legendEl.children && legendEl.children.length) {
        reorderLegendBlocks();
        const legendGroup = document.createElementNS(svgNS, "g");
        const legendX = alignedContentOffsetX + marginPx;
        let yOff = titleHeightPx + usedCanvasHeight + marginPx;
        const symSize = Math.max(8, Math.round(12 * uiScale));
        const fontSize = Math.max(10, Math.round(12 * uiScale));
        const rowGap = Math.max(3, Math.round(5 * uiScale));
        const blockGap = Math.max(6, Math.round(8 * uiScale));

        const orderedVisibleLegendNames = getOrderedLayerNames().filter(name => {
          const block = document.getElementById('legend-' + sanitizeId(name));
          if (!block) return false;
          const group = overlayData[name] && overlayData[name].layerGroup;
          return !!(group && map && map.hasLayer(group));
        });
        const orderedBlocks = orderedVisibleLegendNames
          .map(name => document.getElementById('legend-' + sanitizeId(name)))
          .filter(Boolean);
        const seen = new Set(orderedBlocks.map(b => b.id));
        const remainingBlocks = Array.from(legendEl.querySelectorAll('.legend-block')).filter(b => !seen.has(b.id));
        const blocks = orderedBlocks.concat(remainingBlocks);
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
            const symCs = symEl ? window.getComputedStyle(symEl) : null;
            const fillColor = (symCs && symCs.backgroundColor && symCs.backgroundColor !== 'rgba(0, 0, 0, 0)')
              ? symCs.backgroundColor
              : ((symEl && symEl.style && symEl.style.backgroundColor) || '#ccc');
            const lineColor = (symCs && symCs.borderTopColor && symCs.borderTopColor !== 'rgba(0, 0, 0, 0)')
              ? symCs.borderTopColor
              : fillColor;

            if (symEl && symEl.classList.contains('legend-sym-line')) {
              const line = document.createElementNS(svgNS, "line");
              line.setAttribute("x1", String(legendX));
              line.setAttribute("y1", String(yOff + Math.round(symSize / 2)));
              line.setAttribute("x2", String(legendX + symSize));
              line.setAttribute("y2", String(yOff + Math.round(symSize / 2)));
              line.setAttribute("stroke", lineColor);
              line.setAttribute("stroke-width", String(Math.max(2, Math.round(2 * uiScale))));
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
            t.setAttribute("x", String(legendX + symSize + Math.round(6 * uiScale)));
            t.setAttribute("y", String(yOff + symSize - Math.round(2 * uiScale)));
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


