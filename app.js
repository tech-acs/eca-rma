// --- Globals & Utilities ---
const MAX_SIZE = 100 * 1024 * 1024; // 100 MB local file limit
const MAX_FEATURES = 1000000;// adjust to device expectations
const MAX_VERTICES = 10000000; // total coordinate points across all features
const MAX_CSV_COLUMNS = 500;
const MAX_CSV_CELL_LENGTH = 10000;
const MAX_EDITABLE_TEXT_LENGTH = 250;
const MAX_REMOTE_IMPORT_BYTES = 50 * 1024 * 1024; // 50 MB cap for URL imports
const REMOTE_IMPORT_TIMEOUT_MS = 300000; // 300s timeout for URL imports
const SCALE_BAR_OFFSET_X_PX = 43;
const SCALE_BAR_OFFSET_Y_PX = 7;
const MAX_ZIP_ENTRIES = 50;
const MAX_ZIP_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 200 MB expanded cap
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
const EXPORT_MIN_SIDE_CROP_PX = 50;
const EDGE_EXPORT_SIDE_CROP_MAX_RATIO = 0.16;
const EDGE_EXPORT_FIXED_SIDE_CROP_PX = 40;
const CHROME_EXPORT_FIXED_SIDE_CROP_PX = 40;
const EXPORT_A4_WIDTH_PX = 2480;
const EXPORT_A4_HEIGHT_PX = 3508;
const EXPORT_HTML2CANVAS_SCALE = 2;
const EXPORT_CAPTURE_MAP_WIDTH_PX = 1600;
const EXPORT_CAPTURE_MAP_HEIGHT_PX = 1131;
const EXPORT_CAPTURE_SETTLE_MS = 180;
const EXPORT_CAPTURE_MIN_WIDTH_PX = 640;
const EXPORT_CAPTURE_MAX_WIDTH_PX = 4096;
const EXPORT_CAPTURE_MIN_HEIGHT_PX = 480;
const EXPORT_CAPTURE_MAX_HEIGHT_PX = 4096;
const OVERLAY_POLYGON_FILL_OPACITY = 0.35;
const OVERLAY_POINT_FILL_OPACITY = 0.55;
const EXPORT_CAPTURE_PRESETS = {
  "a4-balanced": {
    label: "A4 Balanced (fast)",
    width: 1600,
    height: 1131
  },
  "a4-detailed": {
    label: "A4 Detailed (high quality)",
    width: 2200,
    height: 1556
  },
  "screen-wide": {
    label: "Screen Wide 16:9",
    width: 1920,
    height: 1080
  },
  "custom": {
    label: "Custom size",
    width: EXPORT_CAPTURE_MAP_WIDTH_PX,
    height: EXPORT_CAPTURE_MAP_HEIGHT_PX
  }
};
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
const UN_COUNTRY_BOUNDARY_QUERY_URL = "https://geoservices.un.org/arcgis/rest/services/ClearMap_WebTopo/MapServer/109/query";
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
  const maxLength = Math.max(1, Number(targetEl.dataset?.maxTextLength) || MAX_EDITABLE_TEXT_LENGTH);
  const safeText = sanitizePlainText(text).slice(0, maxLength);
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

function secureEditablePlainText(targetEl, fallback, onCommit) {
  if (!targetEl) return;
  targetEl.dataset.maxTextLength = String(MAX_EDITABLE_TEXT_LENGTH);

  const normalize = () => {
    const next = sanitizePlainText(targetEl.textContent, fallback).slice(0, MAX_EDITABLE_TEXT_LENGTH);
    if (targetEl.textContent !== next || targetEl.querySelector('*')) {
      targetEl.textContent = next;
    }
    return next;
  };

  targetEl.addEventListener('beforeinput', (event) => {
    const inputType = String(event.inputType || '');
    const allowedInsertTypes = new Set(['insertText', 'insertCompositionText']);
    if (inputType.startsWith('insert') && !allowedInsertTypes.has(inputType)) {
      event.preventDefault();
    }
    if (inputType.startsWith('format')) {
      event.preventDefault();
    }
  });
  targetEl.addEventListener('paste', (event) => {
    event.preventDefault();
    const text = (event.clipboardData || window.clipboardData)?.getData('text') || '';
    insertTextAtCaret(targetEl, text);
    normalize();
  });
  targetEl.addEventListener('drop', (event) => event.preventDefault());
  targetEl.addEventListener('input', normalize);
  targetEl.addEventListener('blur', () => {
    const next = normalize();
    if (typeof onCommit === 'function') onCommit(next);
  });

  new MutationObserver(normalize).observe(targetEl, {
    childList: true,
    characterData: true,
    subtree: true
  });
  normalize();
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

function getRingAverageCoordinate(ring) {
  if (!Array.isArray(ring) || !ring.length) return null;
  let totalX = 0;
  let totalY = 0;
  let count = 0;
  ring.forEach(coord => {
    if (!Array.isArray(coord) || coord.length < 2) return;
    const x = Number(coord[0]);
    const y = Number(coord[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    totalX += x;
    totalY += y;
    count++;
  });
  return count ? [totalX / count, totalY / count] : null;
}

function getFeatureSampleCoords(feature) {
  const g = feature?.geometry;
  if (!g || !g.type || !g.coordinates) return [];
  if (g.type === "Point") return [g.coordinates];
  if (g.type === "MultiPoint" && g.coordinates[0]) return [g.coordinates[0]];
  if (g.type === "LineString" && g.coordinates[0]) return [g.coordinates[0]];
  if (g.type === "MultiLineString" && g.coordinates[0] && g.coordinates[0][0]) return [g.coordinates[0][0]];

  const outerRings = g.type === "Polygon"
    ? [g.coordinates[0]]
    : g.type === "MultiPolygon"
      ? g.coordinates.map(polygon => polygon?.[0]).filter(Boolean)
      : [];
  const samples = outerRings.map(getRingAverageCoordinate).filter(Boolean);
  const bbox = bboxFromCoordinates(g.coordinates);
  if (bbox) samples.push([(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]);
  outerRings.forEach(ring => {
    if (ring?.[0]) samples.push(ring[0]);
  });
  return samples;
}

function getFeatureSampleCoord(feature) {
  return getFeatureSampleCoords(feature)[0] || null;
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
  const lower = raw.toLowerCase();
  if (lower.startsWith("{") || lower.startsWith("[") || lower.startsWith("<html") || lower.startsWith("<!doctype")) {
    return false;
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return false;
  const header = String(lines[0] || "").toLowerCase();
  const hasDelimiter = /,|;|\t/.test(header);
  const hasLatField = /(latitude|lat)\b/.test(header);
  const hasLonField = /(longitude|lon|lng|long)\b/.test(header);
  const headerCells = header.split(/[,;\t]/).map(value => value.trim());
  const hasIso3Field = !!getCsvIsoKey(headerCells);
  return hasDelimiter && ((hasLatField && hasLonField) || hasIso3Field);
}

function assertCsvPayloadLooksSafe(csvText, sourceLabel = "CSV") {
  const raw = String(csvText || "").trim();
  if (!raw) {
    throw new Error(`${sourceLabel} payload is empty.`);
  }

  const lower = raw.toLowerCase();
  if (lower.startsWith("{") || lower.startsWith("[") || lower.startsWith("<html") || lower.startsWith("<!doctype")) {
    throw new Error(`${sourceLabel} payload does not look like CSV.`);
  }

  const firstLine = String(raw.split(/\r?\n/, 1)[0] || "");
  if (!/,|;|\t/.test(firstLine)) {
    throw new Error(`${sourceLabel} header must include a comma, semicolon, or tab delimiter.`);
  }

  // Use Papa preview for lightweight structural validation before full parse.
  const preview = window.Papa.parse(raw, {
    header: false,
    skipEmptyLines: "greedy",
    preview: 1
  });
  if (Array.isArray(preview.errors) && preview.errors.length) {
    const firstErr = preview.errors[0];
    throw new Error(`${sourceLabel} parse error near row ${firstErr.row ?? "?"}.`);
  }

  const headerRow = Array.isArray(preview.data) ? preview.data[0] : null;
  const headerCells = Array.isArray(headerRow)
    ? headerRow.map(v => String(v == null ? "" : v).trim())
    : [];
  if (headerCells.length < 2) {
    throw new Error(`${sourceLabel} must contain at least 2 columns.`);
  }
  if (headerCells.length > MAX_CSV_COLUMNS) {
    throw new Error(`${sourceLabel} has too many columns (${headerCells.length}; max ${MAX_CSV_COLUMNS}).`);
  }

  const hasLatField = headerCells.some(v => /(latitude|lat)\b/i.test(v));
  const hasLonField = headerCells.some(v => /(longitude|lon|lng|long)\b/i.test(v));
  const hasIso3Field = !!getCsvIsoKey(headerCells);
  if (!((hasLatField && hasLonField) || hasIso3Field)) {
    throw new Error(`${sourceLabel} must have latitude/longitude columns or an ISO3 code column.`);
  }
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
    const metadataByCountry = new Map();
    const metadataByIso3 = new Map();
    (Array.isArray(metaRows) ? metaRows : []).forEach(row => {
      const names = [row?.country, row?.officialName, ...(Array.isArray(row?.aliases) ? row.aliases : [])];
      names.forEach(name => {
        const countryKey = normalizeCountryName(name || "");
        if (countryKey) metadataByCountry.set(countryKey, row);
      });
      const iso3 = normalizeIsoJoinValue(row?.iso3 || "");
      if (iso3) metadataByIso3.set(iso3, row);
    });
    worldBoundaryIndex = feats.map(f => {
      const boundaryIso3 = normalizeIsoJoinValue(
        f?.properties?.ISO3CD || f?.properties?.iso3 || f?.properties?.ISO_A3 || ""
      );
      const country = sanitizePlainText(
        f?.properties?.ROMNAM || f?.properties?.name || f?.properties?.NAME || f?.properties?.MAPLAB || ""
      );
      const key = normalizeCountryName(country);
      const metadata = metadataByIso3.get(boundaryIso3)
        || metadataByCountry.get(key) || {};
      const canonicalCountry = sanitizePlainText(
        metadata.officialName || metadata.country || canonicalByCountryNorm.get(key) || country
      );
      const canonicalKey = normalizeCountryName(canonicalCountry);
      const continent = metadata.continent
        || continentByCountryNorm.get(key)
        || continentByCountryNorm.get(canonicalKey)
        || guessContinentFromCountryName(country);
      return {
        country: canonicalCountry,
        continent,
        iso2: sanitizePlainText(metadata.iso2 || f?.properties?.ISO2CD || ""),
        iso3: sanitizePlainText(metadata.iso3 || boundaryIso3),
        m49: sanitizePlainText(metadata.m49 || ""),
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
    delete f.properties.__rma_country;
    delete f.properties.__rma_continent_spatial;
    const sampleCoords = getFeatureSampleCoords(f);
    let hit = null;
    for (const coord of sampleCoords) {
      if (!Array.isArray(coord) || coord.length < 2) continue;
      const x = Number(coord[0]);
      const y = Number(coord[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const candidates = boundaryIndex.filter(b =>
        x >= b.bbox[0] && x <= b.bbox[2] && y >= b.bbox[1] && y <= b.bbox[3]
      );
      hit = candidates.find(c => pointInGeometry([x, y], c.geometry));
      if (hit) break;
    }
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
const overlayRenderer = L.svg({ padding: 0.5 });

const map = L.map('map', {
  preferCanvas: true,
  renderer: mapRenderer,
  attributionControl: true,
  zoomAnimation: false,
  fadeAnimation: false,
  markerZoomAnimation: false,
  // The UN ArcGIS tile service exposes integer zoom levels only.
  zoomSnap: 1,
  zoomDelta: 1
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
const IMPORT_EXTENT_MAX_ZOOM = 5;
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
  if (baseLayer && map && !map.hasLayer(baseLayer)) {
    try { baseLayer.addTo(map); } catch (e) {}
  }
  ensureBaseLayerAtBack();
  if (baseLayer && typeof baseLayer.redraw === "function") {
    try { baseLayer.redraw(); } catch (e) {}
  }
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
const UNTopoLayer = L.TileLayer.extend({
  getTileUrl: function(coords) {
    const safeCoords = { ...coords, z: Math.floor(Number(coords.z) || 0) };
    return L.TileLayer.prototype.getTileUrl.call(this, safeCoords);
  }
});

const baseLayer = new UNTopoLayer(
  'https://geoservices.un.org/arcgis/rest/services/ClearMap_WebTopo/MapServer/tile/{z}/{y}/{x}',
  {
    attribution: '© United Nations',
    bounds: MAP_NAV_BOUNDS,
    maxNativeZoom: 5,
    maxZoom: 18,
    noWrap: true,
    tileSize: 256,
    keepBuffer: 2,
    updateWhenIdle: false
  }
).addTo(map);

let baseLayerTileErrors = 0;

function ensureBaseLayerAtBack() {
  if (!baseLayer || !map) return;
  try {
    if (!map.hasLayer(baseLayer)) baseLayer.addTo(map);
    baseLayer.setOpacity(1);
    if (typeof baseLayer.bringToBack === 'function') baseLayer.bringToBack();
    if (typeof baseLayer.setZIndex === 'function') baseLayer.setZIndex(1);
  } catch (e) {
    console.warn("Failed to keep UN Topo at back:", e);
  }
}

ensureBaseLayerAtBack();
baseLayer.on('tileerror', (event) => {
  baseLayerTileErrors++;
  if (baseLayerTileErrors <= 3) {
    console.warn("UN Topo tile failed to load:", event?.tile?.src || "unknown tile");
  }
});
baseLayer.on('load', () => {
  baseLayerTileErrors = 0;
});
map.on('layeradd', (e) => {
  if (e && e.layer === baseLayer) ensureBaseLayerAtBack();
});
map.on('layerremove', (e) => {
  if (!e || e.layer !== baseLayer) return;
  try {
    baseLayer.addTo(map);
    ensureBaseLayerAtBack();
    if (typeof baseLayer.redraw === 'function') baseLayer.redraw();
  } catch (err) {
    console.warn("Basemap auto-restore failed:", err);
  }
});
map.on('resize zoomend moveend', () => {
  setTimeout(() => {
    ensureBaseLayerAtBack();
    if (typeof baseLayer.redraw === 'function') baseLayer.redraw();
  }, 0);
});
setTimeout(() => {
  ensureBaseLayerAtBack();
  map.invalidateSize({ pan: false });
  if (typeof baseLayer.redraw === 'function') baseLayer.redraw();
}, 500);

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
        realignMapViewportAfterLayoutChange();
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

function realignMapViewportAfterLayoutChange() {
  if (!map || typeof map.invalidateSize !== 'function') return;

  let center = null;
  let zoom = null;
  try {
    center = typeof map.getCenter === 'function' ? map.getCenter() : null;
    zoom = typeof map.getZoom === 'function' ? map.getZoom() : null;
  } catch (err) {
    center = null;
    zoom = null;
  }

  try {
    map.invalidateSize({ pan: false, debounceMoveend: true });
  } catch (err) {}

  const hasStableView = center && Number.isFinite(center.lat) && Number.isFinite(center.lng) && Number.isFinite(zoom);
  if (hasStableView && typeof map.setView === 'function') {
    try {
      map.setView(center, zoom, { animate: false });
    } catch (err) {}
  }

  if (baseLayer && typeof baseLayer.redraw === 'function') {
    try { baseLayer.redraw(); } catch (err) {}
  }
}

function observeMapContainerResize() {
  if (typeof ResizeObserver !== 'function') return;
  const mapContainer = document.getElementById('map-container');
  const mapEl = map && typeof map.getContainer === 'function' ? map.getContainer() : null;
  if (!mapContainer || !mapEl) return;

  let frame = 0;
  const onResize = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      queueMapUiReflow();
      realignMapViewportAfterLayoutChange();
    });
  };

  const observer = new ResizeObserver(onResize);
  observer.observe(mapContainer);
  observer.observe(mapEl);
}

// run initially and on relevant events
window.addEventListener('load', () => {
  syncLayoutWithHeaderHeight();
  observeMapContainerResize();
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
  secureEditablePlainText(header, defaultLegendTitle, (next) => {
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
  if (/Polygon/.test(t)) return { color: 'transparent', weight: 0, fillColor: defaultColor, fillOpacity: OVERLAY_POLYGON_FILL_OPACITY };
  if (/LineString/.test(t)) return { color: defaultColor, weight: getLineWidth() };
  return { color: '#000', weight: 1, fillColor: defaultColor, fillOpacity: OVERLAY_POINT_FILL_OPACITY };
}

function defaultPoint(feature, latlng) {
  const size = getPointRadius();
  const activeLayerState = currentLayerName ? overlayData[currentLayerName] : null;
  const defaultColor = /^#[0-9A-Fa-f]{6}$/.test(activeLayerState?.defaultSymbolColor || "")
    ? activeLayerState.defaultSymbolColor
    : '#ccc';
  return L.circleMarker(latlng, {
    renderer: overlayRenderer,
    radius: size,
    fillColor: defaultColor,
    color: '#000',
    weight: 1,
    fillOpacity: OVERLAY_POINT_FILL_OPACITY,
    interactive: true,
    bubblingMouseEvents: false
  });
}

function openNearbyPointPopup(event) {
  if (!event?.containerPoint || !map) return;
  const hitRadiusPx = 18;
  let nearestPoint = null;
  let nearestDistanceSq = hitRadiusPx * hitRadiusPx;

  const inspectLayer = (layer) => {
    if (!layer) return;
    if (layer instanceof L.CircleMarker && typeof layer.getLatLng === 'function' && typeof layer.getPopup === 'function' && layer.getPopup()) {
      const point = map.latLngToContainerPoint(layer.getLatLng());
      const dx = point.x - event.containerPoint.x;
      const dy = point.y - event.containerPoint.y;
      const distanceSq = (dx * dx) + (dy * dy);
      if (distanceSq <= nearestDistanceSq) {
        nearestDistanceSq = distanceSq;
        nearestPoint = layer;
      }
      return;
    }
    if (typeof layer.eachLayer === 'function') layer.eachLayer(inspectLayer);
  };

  Object.values(overlayData).forEach((state) => {
    const group = state?.layerGroup;
    if (group && map.hasLayer(group)) inspectLayer(group);
  });

  if (nearestPoint) nearestPoint.openPopup(nearestPoint.getLatLng());
}

map.on('click', openNearbyPointPopup);

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

function getCsvIsoKey(keys) {
  const exact = (keys || []).find(key => [
    "iso3", "iso3code", "isoalpha3", "isoalpha3code", "iso3166alpha3",
    "countryiso3code"
  ].includes(normKey(key))) || null;
  if (exact) return exact;
  return (keys || []).find(key => {
    const normalized = normKey(key);
    return /^(?:iso3|iso3code|isoalpha3|isoalpha3code|iso3166alpha3|countryiso3code)$/.test(normalized);
  }) || null;
}

function getIsoCodeFamily(key) {
  const normalized = normKey(key);
  if (/m49/.test(normalized)) return "m49";
  if (/countrycode|iso.*3|alpha3/.test(normalized)) return "iso3";
  if (/iso.*2|alpha2/.test(normalized)) return "iso2";
  return "";
}

function normalizeIsoJoinValue(value) {
  return String(value == null ? "" : value).trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeCsvCountryCode(value, family) {
  const code = normalizeIsoJoinValue(value);
  return code;
}

function isUnsafeCsvPropertyKey(key) {
  const normalized = String(key || "").trim().toLowerCase();
  return normalized === "__proto__" || normalized === "prototype" || normalized === "constructor";
}

function buildSafeCsvProperties(row, keys) {
  const properties = Object.create(null);
  (keys || []).forEach(key => {
    if (isUnsafeCsvPropertyKey(key)) {
      throw new Error(`CSV contains a blocked column name: ${String(key)}`);
    }
    const value = row?.[key] == null ? "" : row[key];
    if (typeof value === "string" && value.length > MAX_CSV_CELL_LENGTH) {
      throw new Error(`CSV cell in column "${String(key)}" is too long.`);
    }
    properties[key] = value;
  });
  return properties;
}

function chooseCsvThematicKey(rows, keys, isoKey) {
  const candidates = (keys || []).filter(key => {
    if (key === isoKey) return false;
    return !/^(country|countryname|name|countrycode|iso|m49)/i.test(normKey(key));
  });
  const numeric = candidates.find(key => (rows || []).some(row => {
    const value = String(row?.[key] ?? "").trim();
    return value !== "" && Number.isFinite(Number(value));
  }));
  return numeric || candidates[0] || (keys || []).find(key => key !== isoKey) || "";
}

async function buildCountryPolygonsFromCsv(csvGeojson, csvInfo) {
  if (!csvGeojson || !csvInfo) return null;
  const referenceRows = await loadCountryReferenceRows();
  const requestedIso3 = Array.from(new Set(csvGeojson.features
    .map(feature => normalizeIsoJoinValue(feature?.properties?.[csvInfo.isoKey]))
    .filter(value => /^[A-Z]{3}$/.test(value))));
  if (!requestedIso3.length) return null;
  const where = `ISO3CD IN (${requestedIso3.map(value => `'${value}'`).join(",")})`;
  const query = new URL(UN_COUNTRY_BOUNDARY_QUERY_URL);
  query.searchParams.set("where", where);
  query.searchParams.set("outFields", "ISO3CD,ROMNAM,CONTCD");
  query.searchParams.set("returnGeometry", "true");
  query.searchParams.set("outSR", "4326");
  query.searchParams.set("f", "geojson");
  const boundaryPayload = await fetchJsonWithLimits(query.href, "UN country boundaries");
  const boundaryFeatures = Array.isArray(boundaryPayload?.features) ? boundaryPayload.features : [];
  const boundaries = boundaryFeatures.map(feature => ({
    country: sanitizePlainText(feature?.properties?.ROMNAM || feature?.properties?.ISO3CD || ""),
    iso3: normalizeIsoJoinValue(feature?.properties?.ISO3CD || ""),
    geometry: feature?.geometry || null
  })).filter(boundary => boundary.iso3 && boundary.geometry);
  const codeToCountry = new Map();
  (Array.isArray(referenceRows) ? referenceRows : []).forEach(row => {
    const code = normalizeIsoJoinValue(row?.iso3 || "");
    if (code) codeToCountry.set(code, normalizeCountryName(row.country || row.officialName || ""));
  });
  const valuesByCode = new Map();
  csvGeojson.features.forEach(feature => {
    const properties = feature?.properties || {};
    const code = normalizeCsvCountryCode(properties[csvInfo.isoKey], csvInfo.isoFamily);
    if (code) valuesByCode.set(code, properties);
  });

  const features = boundaries.map(boundary => {
    const boundaryCode = normalizeCsvCountryCode(boundary?.iso3 || "", "iso3");
    const boundaryCountry = normalizeCountryName(boundary?.country || "");
    let csvProperties = boundaryCode ? valuesByCode.get(boundaryCode) : null;
    if (!csvProperties && boundaryCountry) {
      for (const [code, country] of codeToCountry) {
        if (country === boundaryCountry && valuesByCode.has(code)) {
          csvProperties = valuesByCode.get(code);
          break;
        }
      }
    }
    if (!csvProperties) return null;
    const properties = Object.create(null);
    properties.country = boundary.country;
    properties.iso2 = boundary.iso2;
    properties.iso3 = boundary.iso3;
    properties.m49 = boundary.m49;
    Object.keys(csvProperties).forEach(key => {
      if (key !== csvInfo.isoKey) properties[key] = csvProperties[key];
    });
    return {
      type: "Feature",
      geometry: boundary.geometry,
      properties
    };
  }).filter(Boolean);

  if (!features.length) return null;
  return {
    type: "FeatureCollection",
    features,
    __rmaCsvImport: {
      valueKeys: csvInfo.valueKeys,
      preferredAttribute: csvInfo.preferredAttribute || ""
    }
  };
}

function mergeCsvIntoActiveLayer(csvGeojson, csvInfo) {
  if (!csvGeojson || !csvInfo || !currentLayerName || !overlayData[currentLayerName]) return null;
  const target = overlayData[currentLayerName].geojson;
  const targetFeatures = Array.isArray(target?.features) ? target.features : [];
  if (!targetFeatures.length) return null;

  const targetKeys = [];
  const seenTargetKeys = new Set();
  targetFeatures.forEach(feature => {
    Object.keys(feature?.properties || {}).forEach(key => {
      if (seenTargetKeys.has(key)) return;
      seenTargetKeys.add(key);
      targetKeys.push(key);
    });
  });
  const targetIsoKey = targetKeys.find(key => getIsoCodeFamily(key) === csvInfo.isoFamily)
    || getKeyByCandidatesFromFeatures(targetFeatures, [
      "ISO_A3", "ISO3", "ISO_ALPHA3", "ISO3_CODE", "ISO_ALPHA3_CODE", "COUNTRY_ISO3_CODE"
    ]);
  if (!targetIsoKey) return null;

  const valuesByIso = new Map();
  csvGeojson.features.forEach(feature => {
    const properties = feature?.properties || {};
    const iso = normalizeCsvCountryCode(properties[csvInfo.isoKey], csvInfo.isoFamily);
    if (iso) valuesByIso.set(iso, properties);
  });
  let matched = 0;
  targetFeatures.forEach(feature => {
    const iso = normalizeCsvCountryCode(feature?.properties?.[targetIsoKey], csvInfo.isoFamily);
    if (!iso || !valuesByIso.has(iso)) return;
    if (!feature.properties) feature.properties = {};
    const csvProperties = valuesByIso.get(iso) || {};
    Object.keys(csvProperties).forEach(key => {
      if (key !== csvInfo.isoKey) feature.properties[key] = csvProperties[key];
    });
    matched++;
  });

  if (!matched) return { matched: 0, valueKeys: csvInfo.valueKeys };
  overlayData[currentLayerName].geojson = target;
  return { matched, valueKeys: csvInfo.valueKeys };
}

function parseCsvToGeojson(csvText, sourceLabel = "CSV") {
  if (!window.Papa || typeof window.Papa.parse !== "function") {
    throw new Error("CSV parser is unavailable.");
  }
  assertCsvPayloadLooksSafe(csvText, sourceLabel);
  const parsed = window.Papa.parse(csvText, {
    header: true,
    skipEmptyLines: "greedy"
  });
  if (Array.isArray(parsed.errors) && parsed.errors.length) {
    const firstErr = parsed.errors[0];
    throw new Error(`${sourceLabel} parse error near row ${firstErr.row ?? "?"}.`);
  }
  const rows = Array.isArray(parsed.data) ? parsed.data : [];
  if (!rows.length) {
    throw new Error(`${sourceLabel} payload is empty.`);
  }
  if (rows.length > MAX_FEATURES) {
    throw new Error(`${sourceLabel} has too many rows (${rows.length}).`);
  }

  const keys = Object.keys(rows[0] || {});
  if (!keys.length || keys.length > MAX_CSV_COLUMNS) {
    throw new Error(`CSV must contain between 1 and ${MAX_CSV_COLUMNS} columns.`);
  }
  keys.forEach(key => {
    if (isUnsafeCsvPropertyKey(key)) {
      throw new Error(`CSV contains a blocked column name: ${String(key)}`);
    }
  });
  const latKey = keys.find(k => /lat/i.test(String(k)));
  const lonKey = keys.find(k => /lon|lng|long/i.test(String(k)));
  const isoKey = getCsvIsoKey(keys);
  const hasCoordinates = !!(latKey && lonKey);
  if (!hasCoordinates && !isoKey) {
    throw new Error("CSV must have latitude/longitude columns or an ISO3 code column.");
  }
  const isoFamily = isoKey ? getIsoCodeFamily(isoKey) : "";
  const resolvedIsoFamily = isoKey ? "iso3" : "";
  if (!hasCoordinates && isoKey) {
    const invalidIso3 = rows.some(row => {
      const value = normalizeIsoJoinValue(row?.[isoKey]);
      return !/^[A-Z]{3}$/.test(value);
    });
    if (invalidIso3) {
      throw new Error("CSV country values must be valid three-letter ISO3 codes.");
    }
  }

  const features = rows.map((r, rowIdx) => {
    if (!hasCoordinates && isoKey) {
      const iso = sanitizePlainText(r?.[isoKey]);
      if (!iso) return null;
      return {
        type: "Feature",
        geometry: null,
        properties: buildSafeCsvProperties(r, keys)
      };
    }
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
      properties: buildSafeCsvProperties(r, keys)
    };
  }).filter(f => f !== null);

  const geojson = { type: "FeatureCollection", features };
  if (!hasCoordinates && isoKey) {
    geojson.__rmaCsvImport = {
      isoKey,
      isoFamily: resolvedIsoFamily,
      valueKeys: keys.filter(key => key !== isoKey),
      preferredAttribute: chooseCsvThematicKey(rows, keys, isoKey)
    };
  }
  return geojson;
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
    renderer: overlayRenderer,
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

  overlayData[safeName] = {
    layerGroup: fg,
    geojson: geojson,
    preferredAttribute: geojson.__rmaCsvImport?.preferredAttribute || ""
  };
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

    if (ext === ".csv" && geojson.__rmaCsvImport) {
      const countryGeojson = await buildCountryPolygonsFromCsv(geojson, geojson.__rmaCsvImport);
      if (!countryGeojson) {
        throw new Error("No CSV ISO codes matched the global country reference.");
      }
      geojson = countryGeojson;
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
    const fallbackName = parsed.pathname.split("/").pop() || ("Layer_" + Date.now());
    let geojson = parseImportedData(ext, fetched.text || "", fetched.contentType || "");
    if (ext === ".csv" && geojson.__rmaCsvImport) {
      const countryGeojson = await buildCountryPolygonsFromCsv(geojson, geojson.__rmaCsvImport);
      if (!countryGeojson) {
        throw new Error("No CSV ISO codes matched the global country reference.");
      }
      geojson = countryGeojson;
    }

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
    renderer: overlayRenderer,
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
  currentAttribute = obj.preferredAttribute || null;

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

  const attributeKeys = [];
  const seenKeys = new Set();
  data.features.forEach(feature => {
    Object.keys(feature?.properties || {}).forEach(key => {
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      attributeKeys.push(key);
    });
  });
  attributeKeys.forEach(k => {
    const o = document.createElement('option');
    o.value = String(k).replace(/[^\w\-]/g, "_");
    o.textContent = k;
    if (currentAttribute && k === currentAttribute) o.selected = true;
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
      renderer: overlayRenderer,
      interactive: true,
      bubblingMouseEvents: false,
      style: f => {
        const idx = uniques.indexOf(f.properties?.[currentAttribute]);
        const col = cols[idx] || '#ccc';
        const t = f.geometry?.type || "";
        if (/LineString/.test(t)) return { color: col, weight: getLineWidth() };
        if (/Polygon/.test(t)) return { color: 'transparent', weight: 0, fillColor: col, fillOpacity: OVERLAY_POLYGON_FILL_OPACITY };
        return { color: '#000', weight: 1, fillColor: col, fillOpacity: OVERLAY_POINT_FILL_OPACITY };
      },
      pointToLayer: (f, latlng) => {
        const idx = uniques.indexOf(f.properties?.[currentAttribute]);
        const col = cols[idx] || '#ccc';
        return L.circleMarker(latlng, {
          renderer: overlayRenderer,
          radius: getPointRadius(),
          fillColor: col,
          color: '#000',
          weight: 1,
          fillOpacity: OVERLAY_POINT_FILL_OPACITY,
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
      renderer: overlayRenderer,
      interactive: true,
      bubblingMouseEvents: false,
      style: f => {
        const col = colorForVal(f.properties?.[currentAttribute]);
        const t = f.geometry?.type || "";
        if (/LineString/.test(t)) return { color: col, weight: getLineWidth() };
        if (/Polygon/.test(t)) return { color: 'transparent', weight: 0, fillColor: col, fillOpacity: OVERLAY_POLYGON_FILL_OPACITY };
        return { color: '#000', weight: 1, fillColor: col, fillOpacity: OVERLAY_POINT_FILL_OPACITY };
      },
      pointToLayer: (f, latlng) => {
        const col = colorForVal(f.properties?.[currentAttribute]);
        return L.circleMarker(latlng, {
          renderer: overlayRenderer,
          radius: getPointRadius(),
          fillColor: col,
          color: '#000',
          weight: 1,
          fillOpacity: OVERLAY_POINT_FILL_OPACITY,
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
  secureEditablePlainText(tdLabel, 'Features', (next) => {
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
    secureEditablePlainText(tdC, defaultLabel, (next) => {
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
    // Keep scale correction but avoid double-applying tile translation offsets.
    const tileAligned = alignMapCanvasToDisplayedTileTransform(mapCanvas, mapEl, { allowTranslation: false });
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
    return {
      // Fixed capture scale keeps export quality stable across screens and browser zoom.
      scale: EXPORT_HTML2CANVAS_SCALE,
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

    function computeContainRect(srcW, srcH, dstW, dstH) {
    const safeSrcW = Math.max(1, srcW | 0);
    const safeSrcH = Math.max(1, srcH | 0);
    const safeDstW = Math.max(1, dstW | 0);
    const safeDstH = Math.max(1, dstH | 0);
    const scale = Math.min(safeDstW / safeSrcW, safeDstH / safeSrcH);
    const drawW = Math.max(1, Math.round(safeSrcW * scale));
    const drawH = Math.max(1, Math.round(safeSrcH * scale));
    const x = Math.round((safeDstW - drawW) / 2);
    const y = Math.round((safeDstH - drawH) / 2);
    return { x, y, width: drawW, height: drawH };
    }

    function renderCanvasToFixedA4Portrait(sourceCanvas) {
    const out = document.createElement('canvas');
    out.width = EXPORT_A4_WIDTH_PX;
    out.height = EXPORT_A4_HEIGHT_PX;
    const ctx = out.getContext('2d');
    if (!ctx) return sourceCanvas;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    if (!sourceCanvas || !(sourceCanvas.width > 0) || !(sourceCanvas.height > 0)) {
      return out;
    }
    const rect = computeContainRect(sourceCanvas.width, sourceCanvas.height, out.width, out.height);
    ctx.drawImage(sourceCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height, rect.x, rect.y, rect.width, rect.height);
    return out;
    }

    function saveCanvasAsA4PortraitPdf(sourceCanvas, fileName) {
    const a4Canvas = renderCanvasToFixedA4Portrait(sourceCanvas);
    const imgData = a4Canvas.toDataURL('image/png');
    const pdf = new jspdf.jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4'
    });
    pdf.addImage(imgData, 'PNG', 0, 0, 210, 297);
    pdf.save(fileName || 'map.pdf');
    }

    function normalizeSvgToA4Portrait(svg, srcW, srcH) {
    if (!svg) return;
    const svgNS = 'http://www.w3.org/2000/svg';
    const sourceW = Math.max(1, Math.round(Number(srcW) || Number(svg.getAttribute('data-export-width')) || Number(svg.getAttribute('width')) || EXPORT_A4_WIDTH_PX));
    const sourceH = Math.max(1, Math.round(Number(srcH) || Number(svg.getAttribute('data-export-height')) || Number(svg.getAttribute('height')) || EXPORT_A4_HEIGHT_PX));
    const targetW = EXPORT_A4_WIDTH_PX;
    const targetH = EXPORT_A4_HEIGHT_PX;
    const fit = computeContainRect(sourceW, sourceH, targetW, targetH);

    const contentGroup = document.createElementNS(svgNS, 'g');
    while (svg.firstChild) contentGroup.appendChild(svg.firstChild);

    svg.setAttribute('width', String(targetW));
    svg.setAttribute('height', String(targetH));
    svg.setAttribute('viewBox', `0 0 ${targetW} ${targetH}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.removeAttribute('data-export-width');
    svg.removeAttribute('data-export-height');

    const bg = document.createElementNS(svgNS, 'rect');
    bg.setAttribute('x', '0');
    bg.setAttribute('y', '0');
    bg.setAttribute('width', String(targetW));
    bg.setAttribute('height', String(targetH));
    bg.setAttribute('fill', '#ffffff');
    svg.appendChild(bg);

    const scaleX = fit.width / sourceW;
    const scaleY = fit.height / sourceH;
    contentGroup.setAttribute('transform', `translate(${fit.x} ${fit.y}) scale(${scaleX} ${scaleY})`);
    svg.appendChild(contentGroup);
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
        const symmetricWhitespaceCrop = getSymmetricWhitespaceSideCropPx(sourceCanvas, baseCropW, cropH, 0.16);
        if (symmetricWhitespaceCrop > 0) return symmetricWhitespaceCrop;
    if (isFirefoxBrowser()) {
      return Math.max(
        0,
        Math.min(
          Math.floor(baseCropW * 0.2),
          Math.round(baseCropW * EXPORT_SIDE_CROP_RATIO) + EXPORT_SIDE_CROP_EXTRA_PX
        )
      );
    }
    // For Chromium/Edge, avoid fixed side crop so wide screens do not shift exports.
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

    function clampExportRatio(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
    }

    function measureExportTextWidth(text, font) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return Math.max(0, Math.round(String(text || '').length * 7));
    ctx.font = font;
    return Math.max(0, Math.ceil(ctx.measureText(String(text || '')).width));
    }

    function buildWrappedExportTextLayout(text, options = {}) {
    const content = String(text || '').trim();
    const fontSize = Math.max(1, Math.round(Number(options.fontSize) || 12));
    const fontStyle = String(options.fontStyle || '').trim();
    const fontWeight = String(options.fontWeight || '').trim();
    const fontFamily = String(options.fontFamily || 'Segoe UI, sans-serif');
    const maxWidth = Math.max(1, Math.round(Number(options.maxWidth) || 1));
    const padding = Math.max(0, Math.round(Number(options.padding) || 0));
    const lineHeight = Math.max(fontSize + 1, Math.round(Number(options.lineHeight) || Math.round(fontSize * 1.25)));
    const maxLines = Math.max(1, Math.round(Number(options.maxLines) || 5));
    const font = [fontStyle, fontWeight, `${fontSize}px`, fontFamily].filter(Boolean).join(' ');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let lines = [];
    if (ctx) {
      ctx.font = font;
      lines = wrapCanvasText(ctx, content, maxWidth);
    } else {
      const approxChars = Math.max(8, Math.floor(maxWidth / Math.max(5, Math.round(fontSize * 0.55))));
      lines = [];
      let line = '';
      content.split(/\s+/).filter(Boolean).forEach((word) => {
        const candidate = line ? `${line} ${word}` : word;
        if (candidate.length <= approxChars || !line) line = candidate;
        else {
          lines.push(line);
          line = word;
        }
      });
      if (line) lines.push(line);
    }
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      const last = lines.length - 1;
      lines[last] = lines[last].replace(/[\s.,;:!?-]*$/, '') + '...';
    }
    const measuredTextWidth = lines.reduce((max, line) => Math.max(max, measureExportTextWidth(line, font)), 0);
    return {
      lines,
      font,
      fontSize,
      fontFamily,
      fontWeight,
      fontStyle,
      padding,
      lineHeight,
      width: Math.max(1, Math.min(maxWidth + (padding * 2), measuredTextWidth + (padding * 2))),
      height: Math.max(1, (padding * 2) + (lines.length * lineHeight))
    };
    }

    function getExportHorizontalCropPlan(sourceCanvas, baseCropW, cropH, options = {}) {
    const safeBaseCropW = Math.max(1, Math.min(Math.round(baseCropW || 1), sourceCanvas?.width || Math.round(baseCropW || 1)));
    const safeCropH = Math.max(1, Math.min(Math.round(cropH || 1), sourceCanvas?.height || Math.round(cropH || 1)));
    const allowBrowserCrop = options.allowBrowserCrop !== false;
    const automaticSideCropPx = allowBrowserCrop
      ? getExportSideCropPxForBrowser(sourceCanvas, safeBaseCropW, safeCropH)
      : 0;
    const maxSafeSideCropPx = Math.max(0, Math.floor((safeBaseCropW - 1) / 2));
    const sideCropPx = Math.min(
      maxSafeSideCropPx,
      Math.max(EXPORT_MIN_SIDE_CROP_PX, automaticSideCropPx)
    );
    const cropX = Math.max(0, Math.min(sideCropPx, Math.max(0, (sourceCanvas?.width || safeBaseCropW) - 1)));
    const cropW = Math.max(1, Math.min(safeBaseCropW - (2 * sideCropPx), (sourceCanvas?.width || safeBaseCropW) - cropX));
    return { cropX, cropW, cropH: safeCropH, sideCropPx };
    }

    function computeExportMapGeometry(mapCanvas, mapEl, options = {}) {
    const forcedCssW = Number(options.cssWidth);
    const forcedCssH = Number(options.cssHeight);
    const mapSize = (map && typeof map.getSize === 'function') ? map.getSize() : null;
    const cssW = Number.isFinite(forcedCssW) && forcedCssW > 0
      ? forcedCssW
      : ((mapSize && mapSize.x > 0) ? mapSize.x : (mapEl ? mapEl.clientWidth : mapCanvas.width));
    const cssH = Number.isFinite(forcedCssH) && forcedCssH > 0
      ? forcedCssH
      : ((mapSize && mapSize.y > 0) ? mapSize.y : (mapEl ? mapEl.clientHeight : mapCanvas.height));
    const rawScaleX = cssW > 0 ? (mapCanvas.width / cssW) : 1;
    const rawScaleY = cssH > 0 ? (mapCanvas.height / cssH) : rawScaleX;
    const expectedW = Math.round(cssW * rawScaleX);
    const expectedH = Math.round(cssH * rawScaleY);
    const baseCropW = Math.max(1, Math.min(expectedW, mapCanvas.width));
    const cropH = Math.max(1, Math.min(expectedH, mapCanvas.height));
    const cropPlan = getExportHorizontalCropPlan(mapCanvas, baseCropW, cropH, options);
    const targetAspectRatio = Number(options.targetAspectRatio);
    const hasTargetAspect = Number.isFinite(targetAspectRatio) && targetAspectRatio > 0;
    let cropX = cropPlan.cropX;
    let cropY = 0;
    let outCropW = cropPlan.cropW;
    let outCropH = cropPlan.cropH;

    if (hasTargetAspect) {
      const currentAspect = outCropW / Math.max(1, outCropH);
      if (currentAspect > targetAspectRatio) {
        const desiredW = Math.max(1, Math.min(outCropW, Math.round(outCropH * targetAspectRatio)));
        const extraW = Math.max(0, outCropW - desiredW);
        cropX = cropX + Math.round(extraW / 2);
        outCropW = desiredW;
      } else if (currentAspect < targetAspectRatio) {
        const desiredH = Math.max(1, Math.min(outCropH, Math.round(outCropW / targetAspectRatio)));
        const extraH = Math.max(0, outCropH - desiredH);
        cropY = Math.round(extraH / 2);
        outCropH = desiredH;
      }
    }

    return {
      cssW,
      cssH,
      rawScaleX,
      rawScaleY,
      expectedW,
      expectedH,
      baseCropW,
      cropH: outCropH,
      cropX,
      cropY,
      cropW: outCropW,
      sideCropPx: cropPlan.sideCropPx
    };
    }

    function getElementExportNormalizedPosition(el, mapEl, fallbackResolver) {
    const mapW = Math.max(1, mapEl?.clientWidth || 1);
    const mapH = Math.max(1, mapEl?.clientHeight || 1);
    const rect = el?.getBoundingClientRect ? el.getBoundingClientRect() : null;
    const width = Math.max(1, Math.round(el?.offsetWidth || rect?.width || 1));
    const height = Math.max(1, Math.round(el?.offsetHeight || rect?.height || 1));
    const maxLeft = Math.max(0, mapW - width);
    const maxTop = Math.max(0, mapH - height);
    let normX = Number(el?.dataset?.normX);
    let normY = Number(el?.dataset?.normY);

    if (!Number.isFinite(normX) || !Number.isFinite(normY)) {
      let left = Number(el?.dataset?.leftPx);
      let top = Number(el?.dataset?.topPx);
      if ((!Number.isFinite(left) || !Number.isFinite(top)) && rect && mapEl?.getBoundingClientRect) {
        const mapRect = mapEl.getBoundingClientRect();
        left = rect.left - mapRect.left;
        top = rect.top - mapRect.top;
      }
      if ((!Number.isFinite(left) || !Number.isFinite(top)) && typeof fallbackResolver === 'function') {
        const pos = fallbackResolver(el, mapEl) || {};
        left = Number(pos.left);
        top = Number(pos.top);
      }
      normX = maxLeft > 0 && Number.isFinite(left) ? (left / maxLeft) : 0;
      normY = maxTop > 0 && Number.isFinite(top) ? (top / maxTop) : 0;
    }

    return {
      normX: clampExportRatio(normX),
      normY: clampExportRatio(normY)
    };
    }

    function getDisclaimerExportNormalizedPosition(mapEl, disclaimerEl) {
    const mapW = Math.max(1, mapEl?.clientWidth || 1);
    const mapH = Math.max(1, mapEl?.clientHeight || 1);
    const leftInset = 12 + DISCLAIMER_LEFT_VISIBLE_INSET_PX;
    const bottomInset = 30;
    const width = Math.max(120, Math.round(Number(disclaimerEl?.dataset?.fixedWidthPx) || disclaimerEl?.offsetWidth || 252));
    const height = Math.max(40, Math.round(disclaimerEl?.offsetHeight || 72));
    const maxLeft = Math.max(0, mapW - width);
    const maxTop = Math.max(0, mapH - height);
    const defaultLeft = Math.max(0, Math.min(maxLeft, leftInset));
    const defaultTop = Math.max(0, Math.min(maxTop, mapH - height - bottomInset));
    const left = disclaimerUserPos && Number.isFinite(disclaimerUserPos.left) ? disclaimerUserPos.left : defaultLeft;
    const top = disclaimerUserPos && Number.isFinite(disclaimerUserPos.top) ? disclaimerUserPos.top : defaultTop;
    return {
      normX: maxLeft > 0 ? clampExportRatio(left / maxLeft) : 0,
      normY: maxTop > 0 ? clampExportRatio(top / maxTop) : 1
    };
    }

    function resolveExportPositionFromNorm(normX, normY, boxW, boxH, exportMapW, exportMapH) {
    const maxLeft = Math.max(0, exportMapW - boxW);
    const maxTop = Math.max(0, exportMapH - boxH);
    return {
      x: Math.max(0, Math.min(maxLeft, Math.round(clampExportRatio(normX) * maxLeft))),
      y: Math.max(0, Math.min(maxTop, Math.round(clampExportRatio(normY) * maxTop)))
    };
    }

    function computeFixedExportOverlayLayout(exportMapW, exportMapH) {
    const mapEl = document.getElementById('map');
    const disclaimerEl = document.getElementById('disclaimer');
    const northArrowEl = document.querySelector('.leaflet-control-north-arrow');
    const scaleEl = document.querySelector('.leaflet-control-exact-scale, .map-bottom-scale-control');
    const scaleText = (document.querySelector('.leaflet-control-exact-scale .exact-scale-label')?.textContent
      || document.querySelector('.map-bottom-scale-control .exact-scale-label')?.textContent
      || '').trim();
    const disclaimerText = (disclaimerEl?.textContent || '').trim();

    const northW = Math.max(34, Math.min(56, Math.round(exportMapW * 0.05)));
    const northH = Math.max(44, Math.min(72, Math.round(northW * 1.35)));
    const northPos = {
      x: Math.max(12, exportMapW - northW - 24),
      y: 24
    };

    const scaleFontSize = Math.max(9, Math.min(13, Math.round(exportMapW * 0.008)));
    const scalePaddingX = Math.max(6, Math.round(scaleFontSize * 0.7));
    const scalePaddingY = Math.max(4, Math.round(scaleFontSize * 0.4));
    const scaleFont = `${scaleFontSize}px Segoe UI, sans-serif`;
    const scaleMeasuredW = measureExportTextWidth(scaleText || 'Scale: --', scaleFont);
    const scaleW = Math.max(90, Math.min(Math.round(exportMapW * 0.28), scaleMeasuredW + (scalePaddingX * 2)));
    const scaleH = Math.max(20, Math.round(scaleFontSize + (scalePaddingY * 2) + 2));
    const scalePos = {
      x: Math.max(0, Math.round((exportMapW - scaleW) / 2) + SCALE_BAR_OFFSET_X_PX),
      y: Math.max(0, exportMapH - SCALE_BAR_OFFSET_Y_PX - scaleH)
    };

    let disclaimer = null;
    if (disclaimerText) {
      const discFontSize = Math.max(10, Math.min(14, Math.round(exportMapW * 0.0085)));
      const discPadding = Math.max(6, Math.round(discFontSize * 0.55));
      const discMaxWidth = Math.max(160, Math.min(Math.round(exportMapW * 0.42), Math.round(exportMapW * 0.52)));
      const discLayout = buildWrappedExportTextLayout(disclaimerText, {
        fontSize: discFontSize,
        fontStyle: 'italic',
        fontFamily: 'Segoe UI, sans-serif',
        maxWidth: Math.max(120, discMaxWidth - (discPadding * 2)),
        padding: discPadding,
        lineHeight: Math.round(discFontSize * 1.25),
        maxLines: 5
      });
      const discPos = {
        x: Math.max(0, 12 + DISCLAIMER_LEFT_VISIBLE_INSET_PX),
        y: Math.max(0, exportMapH - 30 - discLayout.height)
      };
      disclaimer = {
        text: disclaimerText,
        lines: discLayout.lines,
        x: discPos.x,
        y: discPos.y,
        width: discLayout.width,
        height: discLayout.height,
        padding: discLayout.padding,
        fontSize: discLayout.fontSize,
        lineHeight: discLayout.lineHeight,
        fontFamily: discLayout.fontFamily,
        fontStyle: discLayout.fontStyle
      };
    }

    return {
      north: {
        x: northPos.x,
        y: northPos.y,
        width: northW,
        height: northH,
        fontSize: Math.max(11, Math.min(16, Math.round(northW * 0.36))),
        triangleW: Math.max(10, Math.round(northW * 0.36)),
        triangleH: Math.max(10, Math.round(northH * 0.24))
      },
      scale: {
        text: scaleText || 'Scale: --',
        x: scalePos.x,
        y: scalePos.y,
        width: scaleW,
        height: scaleH,
        fontSize: scaleFontSize,
        paddingX: scalePaddingX,
        paddingY: scalePaddingY
      },
      disclaimer
    };
    }

    function appendFixedExportOverlaysToElement(mapWrapper, exportMapW, exportMapH) {
    if (!mapWrapper) return;
    const layout = computeFixedExportOverlayLayout(exportMapW, exportMapH);

    if (layout.disclaimer && layout.disclaimer.lines.length) {
      const disc = document.createElement('div');
      disc.className = 'export-disclaimer-clone';
      disc.style.position = 'absolute';
      disc.style.left = `${layout.disclaimer.x}px`;
      disc.style.top = `${layout.disclaimer.y}px`;
      disc.style.width = `${layout.disclaimer.width}px`;
      disc.style.minHeight = `${layout.disclaimer.height}px`;
      disc.style.padding = `${layout.disclaimer.padding}px`;
      disc.style.boxSizing = 'border-box';
      disc.style.fontFamily = layout.disclaimer.fontFamily;
      disc.style.fontSize = `${layout.disclaimer.fontSize}px`;
      disc.style.fontStyle = layout.disclaimer.fontStyle;
      disc.style.lineHeight = `${layout.disclaimer.lineHeight}px`;
      disc.style.color = '#333333';
      disc.style.background = 'rgba(255,255,255,0.95)';
      disc.style.pointerEvents = 'none';
      disc.textContent = layout.disclaimer.lines.join(' ');
      mapWrapper.appendChild(disc);
    }

    if (layout.north) {
      const north = document.createElement('div');
      north.className = 'export-north-arrow-clone';
      north.style.position = 'absolute';
      north.style.left = `${layout.north.x}px`;
      north.style.top = `${layout.north.y}px`;
      north.style.width = `${layout.north.width}px`;
      north.style.height = `${layout.north.height}px`;
      north.style.background = '#ffffff';
      north.style.border = '1px solid #cfd6e4';
      north.style.borderRadius = '4px';
      north.style.display = 'flex';
      north.style.flexDirection = 'column';
      north.style.alignItems = 'center';
      north.style.justifyContent = 'center';
      north.style.boxSizing = 'border-box';
      north.style.pointerEvents = 'none';

      const letter = document.createElement('div');
      letter.className = 'north-arrow-symbol';
      letter.textContent = 'N';
      letter.style.fontSize = `${layout.north.fontSize}px`;
      letter.style.fontWeight = '700';
      letter.style.lineHeight = '1';
      letter.style.color = '#1e3a8a';
      north.appendChild(letter);

      const tri = document.createElement('div');
      tri.style.width = '0';
      tri.style.height = '0';
      tri.style.borderLeft = `${Math.max(4, Math.round(layout.north.triangleW / 2))}px solid transparent`;
      tri.style.borderRight = `${Math.max(4, Math.round(layout.north.triangleW / 2))}px solid transparent`;
      tri.style.borderBottom = `${layout.north.triangleH}px solid #1e3a8a`;
      tri.style.marginTop = `${Math.max(2, Math.round(layout.north.height * 0.05))}px`;
      north.appendChild(tri);
      mapWrapper.appendChild(north);
    }

    if (layout.scale) {
      const scale = document.createElement('div');
      scale.className = 'export-scale-clone';
      scale.style.position = 'absolute';
      scale.style.left = `${layout.scale.x}px`;
      scale.style.top = `${layout.scale.y}px`;
      scale.style.width = `${layout.scale.width}px`;
      scale.style.minHeight = `${layout.scale.height}px`;
      scale.style.background = '#ffffff';
      scale.style.border = '1px solid #cfd6e4';
      scale.style.borderRadius = '4px';
      scale.style.padding = `${layout.scale.paddingY}px ${layout.scale.paddingX}px`;
      scale.style.boxSizing = 'border-box';
      scale.style.fontSize = `${layout.scale.fontSize}px`;
      scale.style.lineHeight = '1.2';
      scale.style.fontWeight = '400';
      scale.style.color = '#102a43';
      scale.style.textAlign = 'center';
      scale.style.whiteSpace = 'nowrap';
      scale.style.pointerEvents = 'none';
      scale.textContent = layout.scale.text;
      mapWrapper.appendChild(scale);
    }
    }

    function drawFixedExportOverlaysToCanvas(ctx, mapOffsetX, mapOffsetY, exportMapW, exportMapH) {
    if (!ctx) return;
    const layout = computeFixedExportOverlayLayout(exportMapW, exportMapH);

    if (layout.north) {
      const northX = mapOffsetX + layout.north.x;
      const northY = mapOffsetY + layout.north.y;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#cfd6e4';
      ctx.lineWidth = 1;
      ctx.fillRect(northX, northY, layout.north.width, layout.north.height);
      ctx.strokeRect(northX, northY, layout.north.width, layout.north.height);
      ctx.fillStyle = '#1e3a8a';
      ctx.font = `700 ${layout.north.fontSize}px Segoe UI, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('N', northX + Math.round(layout.north.width / 2), northY + 4);
      const triCX = northX + Math.round(layout.north.width / 2);
      const triTop = northY + Math.max(18, Math.round(layout.north.height * 0.42));
      ctx.beginPath();
      ctx.moveTo(triCX, triTop);
      ctx.lineTo(triCX - Math.round(layout.north.triangleW / 2), triTop + layout.north.triangleH);
      ctx.lineTo(triCX + Math.round(layout.north.triangleW / 2), triTop + layout.north.triangleH);
      ctx.closePath();
      ctx.fill();
    }

    if (layout.disclaimer && layout.disclaimer.lines.length) {
      const discX = mapOffsetX + layout.disclaimer.x;
      const discY = mapOffsetY + layout.disclaimer.y;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillRect(discX, discY, layout.disclaimer.width, layout.disclaimer.height);
      ctx.fillStyle = '#333333';
      ctx.font = `${layout.disclaimer.fontStyle} ${layout.disclaimer.fontSize}px ${layout.disclaimer.fontFamily}`.trim();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      layout.disclaimer.lines.forEach((line, idx) => {
        ctx.fillText(
          line,
          discX + layout.disclaimer.padding,
          discY + layout.disclaimer.padding + (idx * layout.disclaimer.lineHeight)
        );
      });
    }

    if (layout.scale) {
      const scaleX = mapOffsetX + layout.scale.x;
      const scaleY = mapOffsetY + layout.scale.y;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillRect(scaleX, scaleY, layout.scale.width, layout.scale.height);
      ctx.strokeStyle = '#cfd6e4';
      ctx.lineWidth = 1;
      ctx.strokeRect(scaleX, scaleY, layout.scale.width, layout.scale.height);
      ctx.fillStyle = '#102a43';
      ctx.font = `${layout.scale.fontSize}px Segoe UI, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(layout.scale.text, scaleX + Math.round(layout.scale.width / 2), scaleY + Math.round(layout.scale.height / 2));
    }
    }

    function appendFixedExportOverlaysToSvg(svg, svgNS, mapOffsetX, mapOffsetY, exportMapW, exportMapH) {
    if (!svg || !svgNS) return;
    const layout = computeFixedExportOverlayLayout(exportMapW, exportMapH);

    if (layout.disclaimer && layout.disclaimer.lines.length) {
      const discX = mapOffsetX + layout.disclaimer.x;
      const discY = mapOffsetY + layout.disclaimer.y;
      const discBg = document.createElementNS(svgNS, 'rect');
      discBg.setAttribute('x', String(discX));
      discBg.setAttribute('y', String(discY));
      discBg.setAttribute('width', String(layout.disclaimer.width));
      discBg.setAttribute('height', String(layout.disclaimer.height));
      discBg.setAttribute('fill', '#ffffff');
      discBg.setAttribute('fill-opacity', '0.95');
      svg.appendChild(discBg);

      const discText = document.createElementNS(svgNS, 'text');
      discText.setAttribute('x', String(discX + layout.disclaimer.padding));
      discText.setAttribute('y', String(discY + layout.disclaimer.padding + layout.disclaimer.fontSize));
      discText.setAttribute('font-size', String(layout.disclaimer.fontSize));
      discText.setAttribute('font-family', layout.disclaimer.fontFamily);
      discText.setAttribute('font-style', layout.disclaimer.fontStyle);
      discText.setAttribute('fill', '#333333');
      discText.setAttribute('text-anchor', 'start');
      layout.disclaimer.lines.forEach((line, idx) => {
        const tspan = document.createElementNS(svgNS, 'tspan');
        tspan.setAttribute('x', String(discX + layout.disclaimer.padding));
        tspan.setAttribute('dy', idx === 0 ? '0' : String(layout.disclaimer.lineHeight));
        tspan.textContent = line;
        discText.appendChild(tspan);
      });
      svg.appendChild(discText);
    }

    if (layout.north) {
      const northX = mapOffsetX + layout.north.x;
      const northY = mapOffsetY + layout.north.y;
      const northBg = document.createElementNS(svgNS, 'rect');
      northBg.setAttribute('x', String(northX));
      northBg.setAttribute('y', String(northY));
      northBg.setAttribute('width', String(layout.north.width));
      northBg.setAttribute('height', String(layout.north.height));
      northBg.setAttribute('rx', '4');
      northBg.setAttribute('fill', '#ffffff');
      northBg.setAttribute('stroke', '#cfd6e4');
      svg.appendChild(northBg);

      const northText = document.createElementNS(svgNS, 'text');
      northText.setAttribute('x', String(northX + Math.round(layout.north.width / 2)));
      northText.setAttribute('y', String(northY + Math.max(12, Math.round(layout.north.fontSize * 1.1))));
      northText.setAttribute('text-anchor', 'middle');
      northText.setAttribute('font-size', String(layout.north.fontSize));
      northText.setAttribute('font-family', 'Segoe UI, sans-serif');
      northText.setAttribute('font-weight', '700');
      northText.setAttribute('fill', '#1e3a8a');
      northText.textContent = 'N';
      svg.appendChild(northText);

      const triCX = northX + Math.round(layout.north.width / 2);
      const triTop = northY + Math.max(18, Math.round(layout.north.height * 0.42));
      const tri = document.createElementNS(svgNS, 'path');
      tri.setAttribute(
        'd',
        `M ${triCX} ${triTop} L ${triCX - Math.round(layout.north.triangleW / 2)} ${triTop + layout.north.triangleH} L ${triCX + Math.round(layout.north.triangleW / 2)} ${triTop + layout.north.triangleH} Z`
      );
      tri.setAttribute('fill', '#1e3a8a');
      svg.appendChild(tri);
    }

    if (layout.scale) {
      const scaleX = mapOffsetX + layout.scale.x;
      const scaleY = mapOffsetY + layout.scale.y;
      const scaleBg = document.createElementNS(svgNS, 'rect');
      scaleBg.setAttribute('x', String(scaleX));
      scaleBg.setAttribute('y', String(scaleY));
      scaleBg.setAttribute('width', String(layout.scale.width));
      scaleBg.setAttribute('height', String(layout.scale.height));
      scaleBg.setAttribute('rx', '4');
      scaleBg.setAttribute('fill', '#ffffff');
      scaleBg.setAttribute('stroke', '#cfd6e4');
      svg.appendChild(scaleBg);

      const scaleText = document.createElementNS(svgNS, 'text');
      scaleText.setAttribute('x', String(scaleX + Math.round(layout.scale.width / 2)));
      scaleText.setAttribute('y', String(scaleY + Math.round(layout.scale.height / 2) + Math.round(layout.scale.fontSize * 0.33)));
      scaleText.setAttribute('text-anchor', 'middle');
      scaleText.setAttribute('font-size', String(layout.scale.fontSize));
      scaleText.setAttribute('font-family', 'Segoe UI, sans-serif');
      scaleText.setAttribute('fill', '#102a43');
      scaleText.textContent = layout.scale.text;
      svg.appendChild(scaleText);
    }
    }

    function layerHasRenderableExportContent(layer, seen = new Set()) {
    if (!layer || seen.has(layer) || layer === baseLayer) return false;
    seen.add(layer);

    const isTileLayer = typeof L.TileLayer === 'function' && layer instanceof L.TileLayer;
    const isImageOverlay = typeof L.ImageOverlay === 'function' && layer instanceof L.ImageOverlay;
    const isSvgOverlay = typeof L.SVGOverlay === 'function' && layer instanceof L.SVGOverlay;
    if (isTileLayer || isImageOverlay || isSvgOverlay) {
      return true;
    }

    if (typeof layer.getLayers === 'function') {
      const childLayers = layer.getLayers();
      if (Array.isArray(childLayers) && childLayers.length) {
        return childLayers.some((child) => layerHasRenderableExportContent(child, seen));
      }
    }

    if (typeof layer.getLatLng === 'function') return true;
    if (typeof layer.getLatLngs === 'function') {
      try {
        const latLngs = layer.getLatLngs();
        return Array.isArray(latLngs) && latLngs.length > 0;
      } catch (e) {
        return true;
      }
    }
    if (typeof layer.toGeoJSON === 'function') return true;
    return false;
    }

    function hasRenderableOverlayContentForExport() {
    if (!map || typeof map.eachLayer !== 'function') return true;
    let hasOverlayContent = false;
    map.eachLayer((layer) => {
      if (hasOverlayContent) return;
      if (!map.hasLayer(layer)) return;
      if (layerHasRenderableExportContent(layer)) hasOverlayContent = true;
    });
    return hasOverlayContent;
    }

    function setNodesTemporarilyHidden(nodes, hidden) {
    nodes.forEach((node) => {
      if (!node || !node.style) return;
      if (hidden) {
        node.dataset.exportPrevVisibility = node.style.visibility || '';
        node.dataset.exportPrevOpacity = node.style.opacity || '';
        node.style.setProperty('visibility', 'hidden', 'important');
        node.style.setProperty('opacity', '0', 'important');
      } else {
        const prevVisibility = node.dataset.exportPrevVisibility || '';
        const prevOpacity = node.dataset.exportPrevOpacity || '';
        if (prevVisibility) node.style.visibility = prevVisibility;
        else node.style.removeProperty('visibility');
        if (prevOpacity) node.style.opacity = prevOpacity;
        else node.style.removeProperty('opacity');
        delete node.dataset.exportPrevVisibility;
        delete node.dataset.exportPrevOpacity;
      }
    });
    }

    function captureDisplayedBasemapCanvas(mapEl) {
    const hiddenNodes = [];
    if (mapEl) {
      hiddenNodes.push(...Array.from(mapEl.querySelectorAll('.leaflet-control-container, .leaflet-popup-pane, .leaflet-tooltip-pane')));
    }
    const disclaimerEl = document.getElementById('disclaimer');
    if (disclaimerEl) hiddenNodes.push(disclaimerEl);

    setNodesTemporarilyHidden(hiddenNodes, true);
    return html2canvas(mapEl, buildHtml2CanvasOptions(mapEl))
      .then((canvas) => {
        if (!canvas || !(canvas.width > 0) || !(canvas.height > 0)) {
          throw new Error('Displayed map capture returned an empty canvas.');
        }
        canvas._exportCaptureSource = 'displayed';
        return canvas;
      })
      .finally(() => {
        setNodesTemporarilyHidden(hiddenNodes, false);
      });
    }

    function captureMapCanvasForExport(onSuccess, onError) {
    captureMapCanvasWithFixedViewport(onSuccess, onError);
    }

    function applyFixedExportViewport(mapEl, width, height) {
    const safeW = Math.max(320, Math.round(Number(width) || EXPORT_CAPTURE_MAP_WIDTH_PX));
    const safeH = Math.max(240, Math.round(Number(height) || EXPORT_CAPTURE_MAP_HEIGHT_PX));
    const prev = {
      width: mapEl.style.width,
      height: mapEl.style.height,
      minWidth: mapEl.style.minWidth,
      minHeight: mapEl.style.minHeight,
      maxWidth: mapEl.style.maxWidth,
      maxHeight: mapEl.style.maxHeight
    };
    mapEl.style.width = `${safeW}px`;
    mapEl.style.height = `${safeH}px`;
    mapEl.style.minWidth = `${safeW}px`;
    mapEl.style.minHeight = `${safeH}px`;
    mapEl.style.maxWidth = `${safeW}px`;
    mapEl.style.maxHeight = `${safeH}px`;
    return {
      width: safeW,
      height: safeH,
      restore: () => {
        mapEl.style.width = prev.width;
        mapEl.style.height = prev.height;
        mapEl.style.minWidth = prev.minWidth;
        mapEl.style.minHeight = prev.minHeight;
        mapEl.style.maxWidth = prev.maxWidth;
        mapEl.style.maxHeight = prev.maxHeight;
      }
    };
    }

    function scheduleLeafletCapture(mapRef, onDone) {
    setTimeout(() => {
      leafletImage(mapRef, (err, mapCanvas) => {
        onDone(err, mapCanvas);
      });
    }, EXPORT_CAPTURE_SETTLE_MS);
    }

    function captureMapCanvasWithFixedViewport(onSuccess, onError) {
    const mapEl = document.getElementById('map');
    if (!mapEl || !map || typeof leafletImage !== 'function') {
      if (typeof onError === 'function') onError(new Error('Map export is not ready.'));
      return;
    }

    const finalize = (err, mapCanvas) => {
      if (err || !mapCanvas) {
        if (typeof onError === 'function') onError(err || new Error('No map canvas returned'));
        return;
      }
      if (typeof onSuccess === 'function') onSuccess(mapCanvas);
    };

    scheduleLeafletCapture(map, (err, mapCanvas) => {
      if (err || !mapCanvas) {
        finalize(err, mapCanvas);
        return;
      }

      const overlaySvg = mapEl.querySelector('.leaflet-overlay-pane svg');
      if (!overlaySvg) {
        finalize(null, mapCanvas);
        return;
      }

      const clone = overlaySvg.cloneNode(true);
      const width = Math.max(1, mapCanvas.width);
      const height = Math.max(1, mapCanvas.height);
      clone.setAttribute('width', String(width));
      clone.setAttribute('height', String(height));
      clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
      clone.setAttribute('preserveAspectRatio', 'none');
      clone.style.transform = 'none';
      clone.style.position = 'absolute';
      clone.style.left = '0';
      clone.style.top = '0';
      clone.style.background = 'transparent';
      const serialized = new XMLSerializer().serializeToString(clone);
      const image = new Image();
      image.onload = () => {
        const overlayCanvas = document.createElement('canvas');
        overlayCanvas.width = mapCanvas.width;
        overlayCanvas.height = mapCanvas.height;
        const ctx = overlayCanvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(image, 0, 0, overlayCanvas.width, overlayCanvas.height);
          const mapCtx = mapCanvas.getContext('2d');
          if (mapCtx) mapCtx.drawImage(overlayCanvas, 0, 0);
          mapCanvas._exportIncludesOverlay = true;
        }
        finalize(null, mapCanvas);
      };
      image.onerror = () => finalize(null, mapCanvas);
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
    });
    }

    function getSelectedExportCapturePreset() {
    const selector = document.getElementById('export-capture-profile');
    const customWidthInput = document.getElementById('export-capture-width');
    const customHeightInput = document.getElementById('export-capture-height');
    const selectedKey = selector ? String(selector.value || '') : '';
    const fallbackKey = 'a4-balanced';
    if (selectedKey === 'custom') {
      const width = clampExportCaptureDimension(customWidthInput ? customWidthInput.value : EXPORT_CAPTURE_MAP_WIDTH_PX, EXPORT_CAPTURE_MAP_WIDTH_PX, EXPORT_CAPTURE_MIN_WIDTH_PX, EXPORT_CAPTURE_MAX_WIDTH_PX);
      const height = clampExportCaptureDimension(customHeightInput ? customHeightInput.value : EXPORT_CAPTURE_MAP_HEIGHT_PX, EXPORT_CAPTURE_MAP_HEIGHT_PX, EXPORT_CAPTURE_MIN_HEIGHT_PX, EXPORT_CAPTURE_MAX_HEIGHT_PX);
      if (customWidthInput) customWidthInput.value = String(width);
      if (customHeightInput) customHeightInput.value = String(height);
      return { profile: 'custom', width, height };
    }
    const preset = EXPORT_CAPTURE_PRESETS[selectedKey] || EXPORT_CAPTURE_PRESETS[fallbackKey];
    return {
      profile: EXPORT_CAPTURE_PRESETS[selectedKey] ? selectedKey : fallbackKey,
      width: Math.max(320, Math.round(Number(preset?.width) || EXPORT_CAPTURE_MAP_WIDTH_PX)),
      height: Math.max(240, Math.round(Number(preset?.height) || EXPORT_CAPTURE_MAP_HEIGHT_PX))
    };
    }

    function clampExportCaptureDimension(value, fallback, min, max) {
    const n = Math.round(Number(value));
    const safeFallback = Math.round(Number(fallback));
    const base = Number.isFinite(n) ? n : (Number.isFinite(safeFallback) ? safeFallback : min);
    return Math.max(min, Math.min(max, base));
    }

    function syncExportCaptureCustomInputsVisibility() {
    const selector = document.getElementById('export-capture-profile');
    const customWrap = document.getElementById('export-capture-custom');
    const customSelected = !!(selector && selector.value === 'custom');
    if (customWrap) {
      customWrap.classList.toggle('d-none', !customSelected);
    }
    }

    function compositeExportElement(cb) {
    captureMapCanvasForExport((mapCanvas) => {
      const usedDisplayedCapture = !!(mapCanvas && mapCanvas._exportCaptureSource === 'displayed');
      if (!usedDisplayedCapture) {
        const mapEl = document.getElementById('map');
        const debugInfo = getExportCorrectionDebug(mapCanvas, mapEl);
        const isEdge = isEdgeBrowser();
        const adjustedMapCanvas = mapCanvas._exportIncludesOverlay
          ? mapCanvas
          : isEdge
          // Edge: combine tile transform with map-pane drift correction.
          ? alignMapCanvasForEdgeDisplayedState(mapCanvas, mapEl)
          : alignMapCanvasToDisplayedTileTransform(
              alignMapCanvasForFractionalTileZoom(alignMapCanvasForEdge(mapCanvas, mapEl)),
              mapEl,
              { allowTranslation: false }
            );
        logEdgeExportDebug("pipeline.mode", {
          mode: isEdge ? "edge-tile-plus-pane" : "full"
        });
        showExportCorrectionDebugMessage(debugInfo);
        mapCanvas = adjustedMapCanvas;
      }

      const mapEl = document.getElementById('map');
      const exportGeometry = computeExportMapGeometry(mapCanvas, mapEl, {
        allowBrowserCrop: !usedDisplayedCapture
      });
      const cropX = exportGeometry.cropX;
      const cropW = exportGeometry.cropW;
      const cropH = exportGeometry.cropH;
      if (isEdgeBrowser()) {
        reportEdgeExportSpaceReduction("png/pdf", exportGeometry.sideCropPx, exportGeometry.baseCropW, cropW);
      }

      const cropped = document.createElement('canvas');
      cropped.width = cropW;
      cropped.height = cropH;
      const cctx = cropped.getContext('2d');
      cctx.drawImage(mapCanvas, cropX, 0, cropW, cropH, 0, 0, cropW, cropH);

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

      appendFixedExportOverlaysToElement(mapWrapper, W, H);

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
    }, (err) => {
      if (err) {
        console.error("Leaflet image export failed:", err);
        return;
      }
      console.warn("No map canvas returned");
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

    function buildDirectExportCanvas(formatLabel, cb, onError) {
      captureMapCanvasWithFixedViewport((mapCanvas) => {
        if (!mapCanvas) {
          if (typeof onError === "function") onError(new Error("Map canvas unavailable"));
          return;
        }

        const mapEl = document.getElementById('map');
        const debugInfo = getExportCorrectionDebug(mapCanvas, mapEl);
        const isEdge = isEdgeBrowser();
        const adjustedMapCanvas = mapCanvas._exportIncludesOverlay
          ? mapCanvas
          : isEdge
          ? alignMapCanvasForEdgeDisplayedState(mapCanvas, mapEl)
          : alignMapCanvasToDisplayedTileTransform(
              alignMapCanvasForFractionalTileZoom(alignMapCanvasForEdge(mapCanvas, mapEl)),
              mapEl,
              { allowTranslation: false }
            );
        logEdgeExportDebug("pipeline.mode", {
          mode: isEdge ? "edge-direct-canvas-tile-plus-pane" : "direct-canvas"
        });
        showExportCorrectionDebugMessage(debugInfo);

        const exportGeometry = computeExportMapGeometry(adjustedMapCanvas, mapEl, {
          // Use content-aware side trim to keep widescreen exports horizontally centered.
          allowBrowserCrop: !mapCanvas._exportIncludesOverlay,
          targetAspectRatio: mapCanvas._exportIncludesOverlay ? undefined : (() => {
            const p = getSelectedExportCapturePreset();
            return p.width / Math.max(1, p.height);
          })()
        });
        const cropX = exportGeometry.cropX;
        const cropY = exportGeometry.cropY || 0;
        const cropW = exportGeometry.cropW;
        const cropH = exportGeometry.cropH;
        if (isEdge) reportEdgeExportSpaceReduction(formatLabel || "png/pdf", exportGeometry.sideCropPx, exportGeometry.baseCropW, cropW);

        const cropped = document.createElement('canvas');
        cropped.width = cropW;
        cropped.height = cropH;
        const cctx = cropped.getContext('2d');
        if (!cctx) {
          if (typeof onError === "function") onError(new Error("Crop canvas context unavailable"));
          return;
        }
        cctx.drawImage(adjustedMapCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
        const recentered = recenterMapCanvasHorizontally(cropped, 0.12);
        const exportMapCanvas = recentered.canvas || cropped;
        const capturePreset = getSelectedExportCapturePreset();
        const normalizedMapCanvas = document.createElement('canvas');
        normalizedMapCanvas.width = capturePreset.width;
        normalizedMapCanvas.height = capturePreset.height;
        const nmctx = normalizedMapCanvas.getContext('2d');
        if (!nmctx) {
          if (typeof onError === "function") onError(new Error("Normalized canvas context unavailable"));
          return;
        }
        nmctx.fillStyle = '#ffffff';
        nmctx.fillRect(0, 0, normalizedMapCanvas.width, normalizedMapCanvas.height);
        const mapFit = computeContainRect(
          exportMapCanvas.width,
          exportMapCanvas.height,
          normalizedMapCanvas.width,
          normalizedMapCanvas.height
        );
        nmctx.drawImage(
          exportMapCanvas,
          0,
          0,
          exportMapCanvas.width,
          exportMapCanvas.height,
          mapFit.x,
          mapFit.y,
          mapFit.width,
          mapFit.height
        );

        const titleText = (document.getElementById('map-title')?.textContent || 'Map Export').trim();
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
        const outW = normalizedMapCanvas.width;
        const outH = titleH + normalizedMapCanvas.height + legendH;

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

        octx.drawImage(normalizedMapCanvas, 0, titleH);
        drawFixedExportOverlaysToCanvas(octx, 0, titleH, normalizedMapCanvas.width, normalizedMapCanvas.height);

        if (legendBlocks.length) {
          const legendWidth = legendBlocks.reduce((maxWidth, block) => {
            octx.font = '600 20px Segoe UI, sans-serif';
            let blockWidth = octx.measureText(String(block.title || 'Legend')).width;
            octx.font = '400 15px Segoe UI, sans-serif';
            block.rows.forEach((entry) => {
              blockWidth = Math.max(blockWidth, 30 + octx.measureText(String(entry.label || '')).width);
            });
            return Math.max(maxWidth, blockWidth);
          }, 0);
          const legendX = Math.max(6, Math.round((outW - legendWidth) / 2));
          let y = titleH + normalizedMapCanvas.height + legendTopPad;
          octx.textAlign = 'left';
          octx.textBaseline = 'top';

          legendBlocks.forEach((block, blockIdx) => {
            if (blockIdx > 0) y += legendBlockGap;

            octx.fillStyle = '#222222';
            octx.font = '600 20px Segoe UI, sans-serif';
            octx.fillText(String(block.title || 'Legend'), legendX, y);
            y += legendHeaderH;

            octx.font = '400 15px Segoe UI, sans-serif';
            block.rows.forEach((entry) => {
              const color = entry.color || '#cccccc';
              const symbolType = entry.symbolType || 'polygon';
              const symbolX = legendX;
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
              octx.fillText(String(entry.label || ''), legendX + 30, y - 2);
              y += legendRowH;
            });
          });
        }

        cb(out);
      }, onError);
    }

    function exportMap() {
      showLoading("Exporting map as PNG...");
      buildDirectExportCanvas(
        "png",
        (canvas) => {
          const fixedA4Canvas = renderCanvasToFixedA4Portrait(canvas);
          const a = document.createElement('a');
          a.href = fixedA4Canvas.toDataURL('image/png');
          a.download = 'map.png';
          a.target = '_self';
          a.rel = 'noopener';
          a.click();
          hideLoading();
        },
        (err) => {
          console.error("PNG export failed:", err);
          hideLoading();
        }
      );
    }

      function exportPDF() {
        showLoading("Exporting map as PDF...");
        buildDirectExportCanvas(
          "pdf",
          (canvas) => {
            saveCanvasAsA4PortraitPdf(canvas, 'map.pdf');
            hideLoading();
          },
          (err) => {
            console.error("PDF export failed:", err);
            hideLoading();
          }
        );
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

function recenterMapCanvasHorizontally(sourceCanvas, maxShiftRatio = 0.12) {
  if (!sourceCanvas || !(sourceCanvas.width > 0) || !(sourceCanvas.height > 0)) {
    return { canvas: sourceCanvas, shiftX: 0 };
  }
  const w = Math.max(1, sourceCanvas.width | 0);
  const h = Math.max(1, sourceCanvas.height | 0);
  const requestedShiftX = getHorizontalInkCenterShift(sourceCanvas);
  const maxShiftPx = Math.max(0, Math.floor(w * Math.max(0.02, Math.min(0.25, Number(maxShiftRatio) || 0.12))));
  const shiftX = Math.max(-maxShiftPx, Math.min(maxShiftPx, requestedShiftX | 0));
  if (Math.abs(shiftX) <= 1) return { canvas: sourceCanvas, shiftX: 0 };

  const recentered = document.createElement('canvas');
  recentered.width = w;
  recentered.height = h;
  const rctx = recentered.getContext('2d');
  if (!rctx) return { canvas: sourceCanvas, shiftX: 0 };
  rctx.fillStyle = '#ffffff';
  rctx.fillRect(0, 0, w, h);
  rctx.drawImage(sourceCanvas, shiftX, 0);
  return { canvas: recentered, shiftX };
}

function exportSVG() {
  showLoading("Exporting map as SVG...");

  const sourceData = geojsonData || (overlayData[currentLayerName] && overlayData[currentLayerName].geojson);
  const data = getFilteredGeojson(sourceData);
  if (!data || !Array.isArray(data.features) || !data.features.length) {
    showPopup("No vector layer is active. Exporting the basemap as PNG.", "success");
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
  const mapEl = document.getElementById('map');
  const disclaimerEl = document.getElementById('disclaimer');
  const northArrowEl = document.querySelector('.leaflet-control-north-arrow');
  const scaleBarEl = document.querySelector('.leaflet-control-exact-scale, .map-bottom-scale-control');
  if (!mapEl) {
    console.error("Map element not found");
    hideLoading();
    return;
  }

  captureMapCanvasWithFixedViewport((mapCanvas) => {
    if (!mapCanvas) {
      showPopup("SVG capture failed. Exporting the basemap as PNG.", "success");
      hideLoading();
      return exportMap();
    }

    // detect tainted canvas
    const canvasDataUrlCheck = tryCanvasToDataURL(mapCanvas);
    if (!canvasDataUrlCheck) {
      showPopup("SVG export was blocked by cross-origin tiles. Exporting PNG instead.", "success");
      hideLoading();
      return exportMap();
    }

    try {
      const svgNS = "http://www.w3.org/2000/svg";
      const XLINK = "http://www.w3.org/1999/xlink";

      // authoritative canvas pixels from leafletImage
      const debugInfo = getExportCorrectionDebug(mapCanvas, mapEl);
      const isEdge = isEdgeBrowser();
      const adjustedMapCanvas = mapCanvas._exportIncludesOverlay
        ? mapCanvas
        : isEdge
        // Edge: combine tile transform with map-pane drift correction.
        ? alignMapCanvasForEdgeDisplayedState(mapCanvas, mapEl)
        : alignMapCanvasToDisplayedTileTransform(
            alignMapCanvasForFractionalTileZoom(alignMapCanvasForEdge(mapCanvas, mapEl)),
            mapEl,
            { allowTranslation: false }
          );
      logEdgeExportDebug("pipeline.mode", {
        mode: isEdge ? "edge-tile-plus-pane" : "full"
      });
      showExportCorrectionDebugMessage(debugInfo);
      const canvasPixelWidth  = adjustedMapCanvas.width;
      const canvasPixelHeight = adjustedMapCanvas.height;

      const exportGeometry = computeExportMapGeometry(adjustedMapCanvas, mapEl, {
        // Use content-aware side trim to keep widescreen exports horizontally centered.
        allowBrowserCrop: !mapCanvas._exportIncludesOverlay,
        targetAspectRatio: (() => {
          if (mapCanvas._exportIncludesOverlay) return undefined;
          const p = getSelectedExportCapturePreset();
          return p.width / Math.max(1, p.height);
        })()
      });
      const rawScaleX = exportGeometry.rawScaleX;
      const rawScaleY = exportGeometry.rawScaleY;
      const cropW = exportGeometry.cropW;
      const cropH = exportGeometry.cropH;
      const cropX = exportGeometry.cropX;
      const cropY = exportGeometry.cropY || 0;
      if (isEdge) reportEdgeExportSpaceReduction("svg", exportGeometry.sideCropPx, exportGeometry.baseCropW, cropW);

      const titleFontPx = Math.max(18, Math.min(26, Math.round(cropW * 0.016)));
      const titleHeightPx = titleEl ? Math.max(36, titleFontPx + Math.round(cropW * 0.02)) : 0;
      const marginPx = Math.max(10, Math.min(18, Math.round(cropW * 0.008)));
      const legendBlocks = getExportLegendBlocks();
      const legendHeaderFontPx = Math.max(14, Math.min(20, Math.round(cropW * 0.011)));
      const legendRowFontPx = Math.max(12, Math.min(16, Math.round(cropW * 0.009)));
      const legendBoxSize = Math.max(12, Math.min(18, Math.round(cropW * 0.01)));
      const legendRowGap = Math.max(4, Math.min(8, Math.round(cropW * 0.004)));
      const legendBlockGap = Math.max(8, Math.min(12, Math.round(cropW * 0.006)));
      const legendHeaderGap = Math.max(18, legendHeaderFontPx + 4);
      const legendHeightPx = legendBlocks.length
        ? (marginPx + legendBlocks.reduce((sum, block, idx) => {
            const blockH = legendHeaderGap + (block.rows.length * (legendBoxSize + legendRowGap));
            return sum + blockH + (idx > 0 ? legendBlockGap : 0);
          }, 0))
        : 0;

      // Debug logging to help tune if needed
      console.info("SVG export debug:",
        { canvasPixelWidth, canvasPixelHeight, rawScaleX, rawScaleY,
          cropW, cropH, cropX, cropY, titleHeightPx, legendHeightPx });

      // draw cropped region to offscreen canvas
      const cropped = document.createElement('canvas');
      cropped.width = cropW;
      cropped.height = cropH;
      const cctx = cropped.getContext('2d');
      cctx.drawImage(adjustedMapCanvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
      const recentered = recenterMapCanvasHorizontally(cropped, 0.12);
      const exportCanvas = recentered.canvas || cropped;
      const rasterShiftX = Math.round(Number(recentered.shiftX) || 0);
      const extraTrimX = 0;
      const uiScale = 1;
      const capturePreset = getSelectedExportCapturePreset();
      const normalizedMapW = Math.max(1, capturePreset.width | 0);
      const normalizedMapH = Math.max(1, capturePreset.height | 0);
      const normalizedMapCanvas = document.createElement('canvas');
      normalizedMapCanvas.width = normalizedMapW;
      normalizedMapCanvas.height = normalizedMapH;
      const nmctx = normalizedMapCanvas.getContext('2d');
      if (!nmctx) throw new Error('Normalized SVG map canvas context unavailable');
      nmctx.fillStyle = '#ffffff';
      nmctx.fillRect(0, 0, normalizedMapW, normalizedMapH);
      const mapFit = computeContainRect(exportCanvas.width, exportCanvas.height, normalizedMapW, normalizedMapH);
      nmctx.drawImage(
        exportCanvas,
        0,
        0,
        exportCanvas.width,
        exportCanvas.height,
        mapFit.x,
        mapFit.y,
        mapFit.width,
        mapFit.height
      );

      const sourceCanvasWidth = Math.max(1, exportCanvas.width);
      const sourceCanvasHeight = Math.max(1, exportCanvas.height);
      const mapScaleX = normalizedMapW / sourceCanvasWidth;
      const mapScaleY = normalizedMapH / sourceCanvasHeight;
      const usedCanvasWidth  = normalizedMapW;
      const usedCanvasHeight = normalizedMapH;

      // Firefox can trim asymmetric side whitespace; center trimmed map content
      // in the original crop frame to match Chrome/Edge visual alignment.
      const totalWidthPx  = usedCanvasWidth;
      const totalHeightPx = titleHeightPx + usedCanvasHeight + legendHeightPx + (marginPx * 2);
      const alignedContentOffsetX = 0;

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
      const imgDataUrl = normalizedMapCanvas.toDataURL("image/png");
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
        const xSrc = (containerPoint.x * rawScaleX) - cropX - extraTrimX + rasterShiftX;
        const ySrc = (containerPoint.y * rawScaleY) - cropY;
        const x = (xSrc * mapScaleX) + alignedContentOffsetX;
        const y = (ySrc * mapScaleY) + titleHeightPx;
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
      const shouldDrawCurrentVectors = !mapCanvas._exportIncludesOverlay &&
        (!topVisibleName || topVisibleName === currentLayerName);

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
        const discX = alignedContentOffsetX + Math.round((Math.max(6, Math.round(8 * rawScaleX)) + rasterShiftX) * mapScaleX);
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
        const naW = Math.max(1, Math.round(naRect.width * rawScaleX * mapScaleX));
        const naH = Math.max(1, Math.round(naRect.height * rawScaleY * mapScaleY));
        const naX = Math.max(0, Math.round((((naRect.left - mapRect.left) * rawScaleX) - cropX - extraTrimX + rasterShiftX) * mapScaleX) + alignedContentOffsetX);
        let naY = titleHeightPx + Math.max(0, Math.round((((naRect.top - mapRect.top) * rawScaleY) - cropY) * mapScaleY));
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
        const sbW = Math.max(1, Math.round(sbRect.width * rawScaleX * mapScaleX));
        const sbH = Math.max(1, Math.round(sbRect.height * rawScaleY * mapScaleY));
        let sbX = Math.max(0, Math.round((((sbRect.left - mapRect.left) * rawScaleX) - cropX - extraTrimX + rasterShiftX) * mapScaleX) + alignedContentOffsetX);
        let sbY = titleHeightPx + Math.max(0, Math.round((((sbRect.top - mapRect.top) * rawScaleY) - cropY) * mapScaleY));
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
        const measureContext = document.createElement('canvas').getContext('2d');
        let legendWidth = 0;
        if (measureContext) {
          blocks.forEach((block) => {
            const header = safeText(block.querySelector('.legend-header')) || 'Legend';
            measureContext.font = `600 ${fontSize}px Segoe UI, sans-serif`;
            let blockWidth = measureContext.measureText(header).width;
            measureContext.font = `${fontSize}px Segoe UI, sans-serif`;
            Array.from(block.querySelectorAll('.legend-row')).forEach((row) => {
              blockWidth = Math.max(
                blockWidth,
                symSize + Math.round(6 * uiScale) + measureContext.measureText(safeText(row.querySelector('span'))).width
              );
            });
            legendWidth = Math.max(legendWidth, blockWidth);
          });
        }
        const legendX = alignedContentOffsetX + Math.max(marginPx, Math.round((usedCanvasWidth - legendWidth) / 2));
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
  // Normalize final SVG dimensions to fixed A4 portrait for cross-screen consistency.
  normalizeSvgToA4Portrait(svg, totalWidthPx, totalHeightPx);

// serialize and download
      const serializer = new XMLSerializer();
      const svgString = serializer.serializeToString(svg);
      const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = (currentLayerName ? sanitizeName(currentLayerName) : "map") + ".svg";
      a.target = '_self';
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
      showPopup("SVG export failed. Exporting PNG instead.", "success");
      hideLoading();
      return exportMap();
    }
  }, (err) => {
    showPopup("SVG capture failed. Exporting the basemap as PNG.", "success");
    console.error("SVG raster capture failed:", err);
    hideLoading();
    exportMap();
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
    secureEditablePlainText(mapTitle, "Custom Map Title");
  }

  // Wire export and UI buttons (avoid inline onclick handlers)
  const btnExportImage = document.getElementById('btnExportImage');
  if (btnExportImage) btnExportImage.addEventListener('click', () => { try { exportMap(); } catch(e){console.error(e);} });

  const btnExportPDF = document.getElementById('btnExportPDF');
  if (btnExportPDF) btnExportPDF.addEventListener('click', () => { try { exportPDF(); } catch(e){console.error(e);} });

  const btnExportSVG = document.getElementById('btnExportSVG');
  if (btnExportSVG) btnExportSVG.addEventListener('click', () => { try { exportSVG(); } catch(e){console.error(e);} });

  const exportProfileSelect = document.getElementById('export-capture-profile');
  const exportCaptureWidth = document.getElementById('export-capture-width');
  const exportCaptureHeight = document.getElementById('export-capture-height');
  if (exportProfileSelect) {
    const available = Object.keys(EXPORT_CAPTURE_PRESETS);
    exportProfileSelect.value = available.includes(exportProfileSelect.value) ? exportProfileSelect.value : 'a4-balanced';
    exportProfileSelect.addEventListener('change', () => syncExportCaptureCustomInputsVisibility());
  }
  if (exportCaptureWidth) {
    exportCaptureWidth.addEventListener('change', () => {
      exportCaptureWidth.value = String(clampExportCaptureDimension(exportCaptureWidth.value, EXPORT_CAPTURE_MAP_WIDTH_PX, EXPORT_CAPTURE_MIN_WIDTH_PX, EXPORT_CAPTURE_MAX_WIDTH_PX));
    });
  }
  if (exportCaptureHeight) {
    exportCaptureHeight.addEventListener('change', () => {
      exportCaptureHeight.value = String(clampExportCaptureDimension(exportCaptureHeight.value, EXPORT_CAPTURE_MAP_HEIGHT_PX, EXPORT_CAPTURE_MIN_HEIGHT_PX, EXPORT_CAPTURE_MAX_HEIGHT_PX));
    });
  }
  syncExportCaptureCustomInputsVisibility();

  const btnToggle = document.getElementById('btnToggleClassTable');
  if (btnToggle) btnToggle.addEventListener('click', () => { try { toggleClassTable(); } catch(e){console.error(e);} });

  if (!fileInput || !fileNameDisplay || !addButton || !urlInput) {
    console.warn("Some expected import UI elements are missing.");
  }
});


