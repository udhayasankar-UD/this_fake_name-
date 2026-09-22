import * as THREE from './vendor/three/three.module.js';
import { GLTFLoader } from './vendor/addons/loaders/GLTFLoader.js';
import { OrbitControls } from './vendor/addons/controls/OrbitControls.js';

/* ---------- device tier ---------- */

const tier = (() => {
  const cores = navigator.hardwareConcurrency || 2;
  const mem = navigator.deviceMemory || 2;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  if (cores <= 4 || mem <= 2) return 'low';
  if (coarse || cores <= 6 || mem <= 4) return 'mid';
  return 'high';
})();

const cfg = {
  low: { fps: 24, dpr: 1, engineModel: 'models/engine_low.glb', aa: false },
  mid: { fps: 30, dpr: 1.4, engineModel: 'models/engine_low.glb', aa: false },
  high: { fps: 60, dpr: 1.8, engineModel: 'models/engine.glb', aa: true }
}[tier];

document.getElementById('tier-note').textContent =
  tier === 'high' ? 'Full detail' : tier === 'mid' ? 'Balanced detail' : 'Reduced detail';

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- colours (match stylesheet) ---------- */

const COLOR = {
  nominal: new THREE.Color('#5B7F6B'),
  caution: new THREE.Color('#B5863F'),
  fault: new THREE.Color('#A85248'),
  unknown: new THREE.Color('#7E8696'),
  neutral: new THREE.Color('#BFBCB5')
};

/* ---------- scene ---------- */

const canvas = document.getElementById('viewport');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: cfg.aa, alpha: true, powerPreference: 'low-power' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, cfg.dpr));
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);

scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b6ae, 2.1));
const key = new THREE.DirectionalLight(0xffffff, 1.5);
key.position.set(4, 7, 5);
scene.add(key);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = !reduceMotion;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = 2;
controls.maxDistance = 60;
controls.addEventListener('change', () => { needsRender = true; });

let needsRender = true;
let aircraft = null, engine = null, engineLoading = null;
let view = 'aircraft';
let selected = null;

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== w * renderer.getPixelRatio() || canvas.height !== h * renderer.getPixelRatio()) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    needsRender = true;
  }
}
window.addEventListener('resize', () => { resize(); });

/* render loop: on demand, frame-capped, paused when hidden */
let last = 0;
const interval = 1000 / cfg.fps;
function loop(t) {
  requestAnimationFrame(loop);
  if (document.hidden) return;
  if (t - last < interval) return;
  last = t;
  resize();
  if (controls.enableDamping) controls.update();
  stepExplode();
  if (needsRender || controls.enableDamping) {
    renderer.render(scene, camera);
    positionCallouts();
    needsRender = false;
  }
}
requestAnimationFrame(loop);

/* ---------- model loading ---------- */

const loader = new GLTFLoader();

function frame(object, pad = 1.5) {
  const box = new THREE.Box3().setFromObject(object);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const dist = Math.max(size.x, size.y, size.z) * pad;
  controls.target.copy(center);
  camera.position.set(center.x + dist * 0.6, center.y + dist * 0.85, center.z + dist * 0.8);
  controls.minDistance = dist * 0.25;
  controls.maxDistance = dist * 3;
  camera.near = dist / 100;
  camera.far = dist * 12;
  camera.updateProjectionMatrix();
  controls.update();
  needsRender = true;
}

function baseMaterial(mesh) {
  if (!mesh.userData.baseColor) {
    mesh.userData.baseColor = mesh.material.color ? mesh.material.color.clone() : COLOR.neutral.clone();
  }
  return mesh.userData.baseColor;
}

function tintPart(root, name, status) {
  const node = root.getObjectByName(name);
  if (!node) return;
  node.traverse(o => {
    if (!o.isMesh) return;
    if (!o.userData.matClone) { o.material = o.material.clone(); o.userData.matClone = true; }
    const base = baseMaterial(o);
    if (status && COLOR[status]) {
      o.material.color.copy(base).lerp(COLOR[status], 0.72);
      o.material.emissive = COLOR[status].clone().multiplyScalar(0.06);
    } else {
      o.material.color.copy(base);
      if (o.material.emissive) o.material.emissive.setRGB(0, 0, 0);
    }
  });
  needsRender = true;
}

const loading = document.getElementById('loading');
function setLoading(text) {
  if (text) { loading.textContent = text; loading.classList.remove('done'); }
  else { loading.classList.add('done'); }
}

loader.load('models/tapas.glb', gltf => {
  aircraft = gltf.scene;
  aircraft.traverse(o => { if (o.isMesh) baseMaterial(o); });
  scene.add(aircraft);
  frame(aircraft, 1.15);
  setLoading(null);
  paint();
}, undefined, err => {
  setLoading('Could not load aircraft model. Serve this folder over http (see readme).');
  console.error(err);
});

function loadEngine() {
  if (engine) return Promise.resolve(engine);
  if (engineLoading) return engineLoading;
  setLoading('Loading engine…');
  engineLoading = new Promise((resolve, reject) => {
    loader.load(cfg.engineModel, gltf => {
      engine = gltf.scene;
      engine.visible = false;
      engine.traverse(o => { if (o.isMesh) baseMaterial(o); });
      scene.add(engine);
      setLoading(null);
      resolve(engine);
    }, undefined, reject);
  });
  return engineLoading;
}

/* ---------- live state from the backend ---------- */

function resolveBackend() {
  const params = new URLSearchParams(window.location.search);
  const qb = params.get('backend');
  if (qb) return qb.replace(/\/+$/, '');

  // Local development: always default to local backend
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return (location.port === '8000' || location.port === '') ? '' : 'http://localhost:8000';
  }

  // Deployed environment (e.g. Vercel): use configured Render backend URL
  if (window.SHADOWTWIN_BACKEND_URL && typeof window.SHADOWTWIN_BACKEND_URL === 'string') {
    const trimmed = window.SHADOWTWIN_BACKEND_URL.trim().replace(/\/+$/, '');
    if (trimmed) return trimmed;
  }

  return '';
}

const API = resolveBackend();
const WS = (API ? API.replace(/^http/, 'ws') : location.origin.replace(/^http/, 'ws')) + '/ws';

const CHANNELS = [
  ['rpm', 'Engine speed', 'rpm', 0],
  ['cht_c', 'Cyl. head temp', '\u00b0C', 0],
  ['egt_c', 'Exhaust temp', '\u00b0C', 0],
  ['oil_press_bar', 'Oil pressure', 'bar', 2],
  ['oil_temp_c', 'Oil temp', '\u00b0C', 0],
  ['boost_bar', 'Boost', 'bar', 2],
  ['fuel_rate_lph', 'Fuel flow', 'L/h', 1],
  ['vibration_mms', 'Vibration', 'mm/s', 2]
];

const PART_KEYS = ['injector_1', 'injector_2', 'injector_3', 'injector_4', 'common_rail',
  'turbocharger', 'intake', 'exhaust', 'cylinder_head', 'cooling', 'lubrication',
  'controller', 'crankcase'];

const PART_LABEL = {
  injector_1: 'Injector 1', injector_2: 'Injector 2', injector_3: 'Injector 3',
  injector_4: 'Injector 4', common_rail: 'Common rail', turbocharger: 'Turbocharger',
  intake: 'Intake', exhaust: 'Exhaust', cylinder_head: 'Cylinder head',
  cooling: 'Cooling', lubrication: 'Lubrication', controller: 'Controller',
  crankcase: 'Crankcase'
};

/* backend status -> ui status */
const MAP = {
  nominal: 'nominal',
  caution: 'caution',
  fault: 'fault',
  anomaly_unclassified: 'caution',
  not_evaluated: 'unknown'
};

/* Physical range per channel — mirrors trust.py LIMITS. Used only for bar
   display; detection thresholds live in the backend and are not replicated. */
const CHANNEL_RANGE = {
  rpm: [0, 4000],
  cht_c: [-40, 400],
  egt_c: [-40, 1300],
  oil_temp_c: [-40, 200],
  oil_press_bar: [0, 12],
  boost_bar: [0.3, 4.5],
  fuel_rate_lph: [0, 80],
  vibration_mms: [0, 60],
};

/* Prior noise sigma per channel — mirrors detect.py _PRIOR_SIGMA. Used only
   for bar colour heuristics in the readout display, not for detection. */
const CHANNEL_SIGMA = {
  rpm: 6.0, cht_c: 1.1, egt_c: 5.0, oil_temp_c: 0.6,
  oil_press_bar: 0.05, boost_bar: 0.02, fuel_rate_lph: 0.35, vibration_mms: 0.10,
};

const STATE_TEXT = {
  nominal: ['Nominal', 'OK'],
  caution: ['Watch', 'Watch'],
  fault: ['Fault', 'Fault'],
  unknown: ['Not evaluated', 'Unsure']
};

/* ---- Change 3: auto-open on fault (fault only, never caution) ---- */
let lastAutoNav = null;

/* ---- Change 5: health trend sparkline ---- */
const healthHistory = { port: [], starboard: [] };
const HEALTH_HIST_MAX = 60;

/* ---- Change 4: simplified finding cards — fault action map ---- */
const FAULT_ACTION = {
  injector_underflow:     'Check injector 3 delivery and common rail pressure',
  cooling_degradation:    'Monitor CHT \u2014 reduce power if above 220\u00b0C',
  lubrication_loss:       'Check oil level and pressure sensor \u2014 land if persistent',
  turbo_underperformance: 'Monitor boost \u2014 reduce altitude demand',
  combustion_instability: 'Reduce throttle \u2014 inspect fuel system post-flight',
  ring_blowby:            'Reduce power \u2014 inspect cylinder sealing post-flight',
  anomaly_unclassified:   'Unclassified anomaly \u2014 monitor all channels',
};

let live = null;
let connected = false;
let wsConnectedAt = null;

function uiStatus(side) {
  if (!live || !live.engines || !live.engines[side]) return 'unknown';
  return MAP[live.engines[side].status] || 'unknown';
}

function connect() {
  let sock;
  try { sock = new WebSocket(WS); } catch (e) { setTimeout(connect, 2000); return; }
  sock.onopen = () => {
    connected = true;
    if (!wsConnectedAt) wsConnectedAt = Date.now();
    document.getElementById('hint').textContent = 'Drag to rotate';
  };
  sock.onmessage = ev => {
    try { live = JSON.parse(ev.data); } catch (e) { return; }
    paint();
  };
  sock.onclose = () => {
    connected = false;
    document.getElementById('hint').textContent = 'Backend not connected';
    setTimeout(connect, 2000);
  };
  sock.onerror = () => { try { sock.close(); } catch (e) { } };
}

async function inject(side, fault, severity) {
  try {
    await fetch((API || '') + '/api/inject', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ side, fault, severity: severity || 0.8 })
    });
  } catch (e) { /* backend offline; the ws handler already says so */ }
}

/* ---------- exploded view ---------- */

/* Short, plain problem text per part. Long enough to be useful at a glance,
   short enough to sit on the model without covering it. */
const PART_NOTE = {
  injector_underflow: { injector: 'low delivery', common_rail: 'pressure suspect' },
  cooling_degradation: { cooling: 'losing effectiveness', cylinder_head: 'running hot' },
  lubrication_loss: { lubrication: 'pressure below model', crankcase: 'check' },
  turbo_underperformance: { turbocharger: 'boost short of command', intake: 'charge low' },
  combustion_instability: { intake: 'unstable burn', exhaust: 'temperature spread' },
  ring_blowby: { crankcase: 'blow-by', cylinder_head: 'seal loss' }
};

function noteFor(fault, partId) {
  const m = PART_NOTE[fault];
  if (!m) return '';
  if (m[partId]) return m[partId];
  if (partId.startsWith('injector_') && m.injector) return m.injector;
  return '';
}

/* One entry per part currently pushed out of the assembly. */
const exploded = new Map();   // partId -> {node, base, dir, t, target, status, note}
let explodeSpan = 1.0;
let animating = false;

function partBase(node) {
  if (!node.userData.basePos) node.userData.basePos = node.position.clone();
  return node.userData.basePos;
}

/* Direction to push a part: away from the engine axis, so parts separate
   outward rather than piling up on each other. */
function explodeDir(node, centre) {
  const box = new THREE.Box3().setFromObject(node);
  const c = box.getCenter(new THREE.Vector3());
  const d = c.sub(centre);
  if (d.lengthSq() < 1e-8) return new THREE.Vector3(0, 1, 0);
  d.y = Math.abs(d.y) + explodeSpan * 0.12;   // bias upward so labels clear the body
  return d.normalize();
}

function setExploded(flags, fault) {
  if (!engine) return;
  const box = new THREE.Box3().setFromObject(engine);
  const centre = box.getCenter(new THREE.Vector3());
  explodeSpan = box.getSize(new THREE.Vector3()).length();

  const wanted = new Set(Object.keys(flags || {}));

  // retire parts that are no longer flagged
  for (const [id, e] of exploded) {
    if (!wanted.has(id)) { e.target = 0; }
  }
  // add or refresh flagged parts
  for (const id of wanted) {
    const node = engine.getObjectByName(id);
    if (!node) continue;
    const existing = exploded.get(id);
    if (existing) {
      existing.target = 1;
      existing.status = flags[id];
      existing.note = noteFor(fault, id);
      continue;
    }
    exploded.set(id, {
      node,
      base: partBase(node).clone(),
      dir: explodeDir(node, centre),
      t: 0, target: 1,
      status: flags[id],
      note: noteFor(fault, id)
    });
  }
  animating = true;
  needsRender = true;
  syncCallouts();
}

function clearExploded() {
  for (const [, e] of exploded) e.target = 0;
  animating = true;
  needsRender = true;
  syncCallouts();
}

/* Ease positions toward their target. Called from the render loop. */
function stepExplode() {
  if (!animating) return;
  let moving = false;
  const step = reduceMotion ? 1.0 : 0.12;
  for (const [id, e] of [...exploded]) {
    const d = e.target - e.t;
    if (Math.abs(d) < 0.002) {
      e.t = e.target;
      if (e.target === 0) { e.node.position.copy(e.base); exploded.delete(id); }
    } else {
      e.t += d * step;
      moving = true;
    }
    if (exploded.has(id)) {
      const k = e.t * explodeSpan * 0.16;
      e.node.position.copy(e.base).addScaledVector(e.dir, k);
    }
  }
  animating = moving;
  needsRender = true;
  if (!moving) syncCallouts();
}

/* --- callout labels, positioned by projecting the part into screen space --- */

const labelBox = document.getElementById('labels');
const calloutEls = new Map();
const _v = new THREE.Vector3();

function syncCallouts() {
  for (const [id, el] of [...calloutEls]) {
    if (!exploded.has(id)) { el.remove(); calloutEls.delete(id); }
  }
  for (const [id, e] of exploded) {
    if (e.target === 0) continue;
    let el = calloutEls.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'callout';
      el.innerHTML = `<span class="cname"></span><span class="cnote"></span>`;
      labelBox.appendChild(el);
      calloutEls.set(id, el);
    }
    // Only touch what actually changed. Rewriting className here would strip the
    // 'shown' class on every telemetry update and restart the fade, so the label
    // would never finish appearing.
    const want = e.status === 'fault' ? 'fault' : 'caution';
    el.classList.toggle('fault', want === 'fault');
    el.classList.toggle('caution', want === 'caution');
    const nameEl = el.querySelector('.cname');
    const noteEl = el.querySelector('.cnote');
    const name = PART_LABEL[id] || id;
    const note = e.note ? '\u2014\u00a0' + e.note : '';
    if (nameEl.textContent !== name) nameEl.textContent = name;
    if (noteEl.textContent !== note) noteEl.textContent = note;
  }
  positionCallouts();
}

function positionCallouts() {
  if (!calloutEls.size) return;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  for (const [id, el] of calloutEls) {
    const e = exploded.get(id);
    if (!e) continue;
    const box = new THREE.Box3().setFromObject(e.node);
    box.getCenter(_v);
    _v.project(camera);
    const x = (_v.x * 0.5 + 0.5) * w;
    const y = (-_v.y * 0.5 + 0.5) * h;
    const visible = _v.z < 1 && e.t > 0.25;
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.classList.toggle('shown', visible);
  }
}

/* ---------- info bar tab switching ---------- */

/* Switch between Findings and Readings tabs in the floating infobar.
   Called explicitly — never driven by a high-frequency update path. */
function setInfoTab(name) {
  const panels = { findings: 'panel-findings', readings: 'panel-readings' };
  const tabs = { findings: 'stab-findings', readings: 'stab-readings' };
  for (const [n, panelId] of Object.entries(panels)) {
    document.getElementById(panelId).classList.toggle('hidden', n !== name);
  }
  for (const [n, tabId] of Object.entries(tabs)) {
    const el = document.getElementById(tabId);
    el.classList.toggle('active', n === name);
    el.setAttribute('aria-selected', String(n === name));
  }
}

/* ---------- live badge, status rings, RUL strips, confidence bars ---------- */

/* Static colour-change only. No animation, no @keyframes. */
function updateLiveBadge() {
  const el = document.getElementById('live-badge');
  if (!el) return;
  if (!connected) {
    el.className = 'live-badge offline';
    el.textContent = '\u25cf Offline';
    return;
  }
  if (!live) return;
  const age = Date.now() / 1000 - live.ts;
  const stale = age > 2;
  el.className = 'live-badge ' + (stale ? 'stale' : 'live');
  el.textContent = '\u25cf ' + (stale
    ? 'Stale \u2014 ' + age.toFixed(0) + '\u202fs'
    : 'Live \u2014 ' + age.toFixed(1) + '\u202fs ago');
}

/* Toggle CSS classes on the SVG ring. Never rewrites className wholesale to
   avoid the Bug 7 pattern (stripping 'shown' mid-transition on a hot path). */
function updateRing(side, st) {
  const el = document.getElementById('ring-' + side);
  if (!el) return;
  for (const c of ['nominal', 'caution', 'fault', 'unknown'])
    el.classList.toggle(c, c === st);
}

/* RUL strip. null rul -> explicit "not yet projected" text, never a bar.
   Track is scaled to run + p90 so p90 lands at the right edge, p10 sits
   inside the remaining zone as a bracket line. */
function renderRulStrip(r) {
  if (!r || !r.rul) {
    return '<div class="rul-null">Not yet projected \u2014 collecting baseline</div>';
  }
  const rul = r.rul;
  if (rul.at_limit) {
    return '<div class="rul-null">At degradation limit \u2014 inspect before next sortie</div>';
  }
  const run = r.hours_run || 0;
  const total = run + Math.max(rul.hours || 0, rul.p90 || rul.hours || 0);  // scale to p90 so bracket lands at edge
  if (total < 1) return '<div class="rul-null">Not yet projected</div>';
  const consumedPct = Math.min(95, run / total * 100).toFixed(1);

  if (rul.tbo_limited) {
    return `<div class="rul-strip">
    <div class="rul-label">Remaining useful life</div>
    <div class="rul-track"
         data-consumed="${consumedPct}">
      <div class="rul-consumed"></div>
      <div class="rul-remaining"></div>
    </div>
    <div class="rul-meta">
      <span>${run.toFixed(0)}\u202fh run</span>
      <span>${rul.hours}\u202fh rem. \u2014 TBO-limited \u2014 no degradation trend detected</span>
    </div>
  </div>`;
  }

  const p10Pct = Math.min(99, (run + rul.p10) / total * 100).toFixed(1);
  const p90Pct = Math.min(99.5, (run + rul.p90) / total * 100).toFixed(1);
  return `<div class="rul-strip">
    <div class="rul-label">Remaining useful life</div>
    <div class="rul-track"
         data-consumed="${consumedPct}"
         data-p10="${p10Pct}"
         data-p90="${p90Pct}">
      <div class="rul-consumed"></div>
      <div class="rul-remaining"></div>
      <div class="rul-bracket"></div>
      <div class="rul-bracket"></div>
    </div>
    <div class="rul-meta">
      <span>${run.toFixed(0)}\u202fh run</span>
      <span>${rul.hours}\u202fh rem. (P10\u00a0${rul.p10}\u00b7P90\u00a0${rul.p90})</span>
    </div>
  </div>`;
}

/* Confidence bar. confidence === null means "not evaluated" -- a different
   claim from 0% confidence. Render them differently: null gets italic text,
   a real number gets a filled bar. */
function renderConfBar(confidence, st) {
  if (confidence === null || confidence === undefined) {
    return '<div class="conf-null">Not evaluated</div>';
  }
  const pct = Math.round(confidence * 100);
  const cls = st === 'fault' ? 'fault' : st === 'caution' ? 'caution' : 'nominal';
  return `<div class="conf-bar-wrap">
    <div class="conf-bar" data-conf="${pct}">
      <div class="conf-bar-fill ${cls}"></div>
    </div>
    <span class="conf-pct">${pct}%</span>
  </div>`;
}

/* Range bar for a single readout channel. Returns empty string if the channel
   has no entry in CHANNEL_RANGE or the measured value is null.
   Colour reflects trust status first, then residual z-score magnitude. */
function rangeBar(k, v, exp, trustStatus, res) {
  const range = CHANNEL_RANGE[k];
  if (!range || v == null) return '';
  const [lo, hi] = range;
  const span = hi - lo;
  if (span <= 0) return '';

  const fillPct = Math.max(2, Math.min(98, (v - lo) / span * 100));
  const expPct = exp != null ? Math.max(1, Math.min(99, (exp - lo) / span * 100)) : null;

  let cls = 'nominal';
  if (trustStatus === 'quarantined') {
    cls = 'unknown';
  } else if (trustStatus === 'suspect') {
    cls = 'caution';
  } else if (res != null && CHANNEL_SIGMA[k]) {
    const z = Math.abs(res) / CHANNEL_SIGMA[k];
    if (z > 6) cls = 'fault';
    else if (z > 3) cls = 'caution';
  }

  const expAttr = expPct != null ? ` data-expected="${expPct.toFixed(1)}"` : '';
  const markerHtml = expPct != null ? '<div class="readout-bar-marker"></div>' : '';
  return `<div class="readout-bar" data-fill="${fillPct.toFixed(1)}"${expAttr}>
    <div class="readout-bar-fill ${cls}"></div>${markerHtml}</div>`;
}

/* Single post-paint sweep to set bar widths from data- attributes.
   Called once after paint() and once after paintDetail(), rather than inside
   the innerHTML-building loops where it would run on a per-element basis and
   could interleave with ongoing transitions. */
function applyBarWidths() {
  document.querySelectorAll('.conf-bar[data-conf]').forEach(el => {
    const fill = el.querySelector('.conf-bar-fill');
    if (fill) fill.style.width = el.dataset.conf + '%';
  });
  document.querySelectorAll('.rul-track[data-consumed]').forEach(el => {
    const consumed = parseFloat(el.dataset.consumed);
    const p10 = parseFloat(el.dataset.p10);
    const p90 = parseFloat(el.dataset.p90);
    const c = el.querySelector('.rul-consumed');
    const rem = el.querySelector('.rul-remaining');
    const brackets = el.querySelectorAll('.rul-bracket');
    if (c) c.style.width = consumed + '%';
    if (rem) rem.style.width = (100 - consumed).toFixed(1) + '%';
    if (brackets[0]) brackets[0].style.left = p10 + '%';
    if (brackets[1]) brackets[1].style.left = p90 + '%';
  });
  document.querySelectorAll('.readout-bar[data-fill]').forEach(el => {
    const fill = el.querySelector('.readout-bar-fill');
    const marker = el.querySelector('.readout-bar-marker');
    if (fill) fill.style.width = el.dataset.fill + '%';
    if (marker && el.dataset.expected) marker.style.left = el.dataset.expected + '%';
  });
}

/* ---- Change 1: mission status banner ---- */
function updateMissionBanner() {
  const el = document.getElementById('mission-banner');
  const statusEl = document.getElementById('banner-status');
  const reasonEl = document.getElementById('banner-reason');
  if (!el || !statusEl || !reasonEl) return;

  let cls = 'unknown';
  let label = 'EVALUATING';
  let reason = 'Connecting to ground service\u2026';

  if (live && live.engines) {
    const port = live.engines.port;
    const star = live.engines.starboard;
    const pst = port ? port.status : 'not_evaluated';
    const sst = star ? star.status : 'not_evaluated';

    if (pst === 'fault' || sst === 'fault') {
      cls = 'fault';
      label = 'NO-GO';
      const faultEng = pst === 'fault' ? port : star;
      const side = pst === 'fault' ? 'Port' : 'Starboard';
      reason = side + ' \u2014 ' + (faultEng.headline || 'Fault detected');
    } else if (pst === 'caution' || pst === 'anomaly_unclassified' ||
               sst === 'caution' || sst === 'anomaly_unclassified') {
      cls = 'caution';
      label = 'CAUTION';
      const cautionEng = (pst === 'caution' || pst === 'anomaly_unclassified') ? port : star;
      const side = (pst === 'caution' || pst === 'anomaly_unclassified') ? 'Port' : 'Starboard';
      reason = side + ' \u2014 ' + (cautionEng.headline || 'Anomaly detected');
    } else if (pst === 'not_evaluated' || sst === 'not_evaluated') {
      cls = 'unknown';
      label = 'EVALUATING';
      reason = 'Collecting baseline \u2014 ready in ~35\u202fs';
    } else {
      // both nominal — check confidence
      const pconf = port ? port.confidence : null;
      const sconf = star ? star.confidence : null;
      if (pconf !== null && sconf !== null && pconf >= 0.8 && sconf >= 0.8) {
        cls = 'nominal';
        label = 'GO';
        reason = 'Both engines nominal';
      } else if (pconf !== null && sconf !== null) {
        cls = 'caution';
        label = 'CAUTION';
        reason = 'Confidence below threshold';
      } else {
        cls = 'unknown';
        label = 'EVALUATING';
        reason = 'Collecting baseline';
      }
    }

    // append shared cause if correlation exists
    const c = live.correlation;
    if (c && c.kind === 'shared_cause') {
      reason += ' \u2014 shared cause suspected';
    }
  }

  for (const c of ['nominal', 'caution', 'fault', 'unknown'])
    el.classList.toggle(c, c === cls);
  statusEl.textContent = label;
  reasonEl.textContent = reason;
}

/* ---- Change 2: baseline progress ---- */
function updateBaseline(side) {
  const rulEl = document.getElementById('rul-' + side);
  if (!rulEl) return;
  const r = live && live.engines && live.engines[side];
  if (!r || r.status !== 'not_evaluated' || !wsConnectedAt) {
    // remove baseline progress if present but no longer needed
    const existing = rulEl.querySelector('.baseline-progress');
    if (existing) existing.remove();
    return;
  }
  let bp = rulEl.querySelector('.baseline-progress');
  if (!bp) {
    bp = document.createElement('div');
    bp.className = 'baseline-progress';
    bp.innerHTML = '<div class="baseline-bar"><div class="baseline-fill"></div></div>'
      + '<span class="baseline-label">Ready in ~<span class="baseline-eta">40</span>\u202fs</span>';
    rulEl.appendChild(bp);
  }
  const elapsed = (Date.now() - wsConnectedAt) / 1000;
  const pct = Math.min(100, elapsed / 40 * 100);
  const eta = Math.max(0, Math.round(40 - elapsed));
  const fill = bp.querySelector('.baseline-fill');
  const etaEl = bp.querySelector('.baseline-eta');
  if (fill) fill.style.width = pct + '%';
  if (etaEl) etaEl.textContent = eta;
}

/* ---- Change 5: sparkline renderer ---- */
function renderSparkline(data) {
  if (!data || data.length < 5) return '';
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 0.01;
  const w = 80;
  const h = 20;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 2) - 1;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');

  let cls = 'nominal';
  if (data.some(v => v < 0.4)) cls = 'fault';
  else if (data.some(v => v < 0.7)) cls = 'caution';

  return '<svg class="sparkline ' + cls + '" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">'
    + '<polyline points="' + points + '" fill="none" stroke="currentColor" stroke-width="1.5" />'
    + '</svg>';
}

/* ---- Change 6: mission margin ---- */
function updateMissionMargin() {
  const pairEl = document.getElementById('margin-pair-val');
  const outEl = document.getElementById('margin-out-val');
  if (!pairEl || !outEl) return;

  const m = live?.mission;

  // pair margin
  const pairH = m?.pair_margin_hours;
  if (pairH != null && pairH > 0) {
    pairEl.textContent = '+' + Math.round(pairH) + '\u202fh';
    const cls = pairH > 2 ? 'nominal' : 'caution';
    for (const c of ['nominal', 'caution', 'fault', 'unknown'])
      pairEl.classList.toggle(c, c === cls);
  } else if (pairH != null && pairH <= 0) {
    pairEl.textContent = '\u2014';
    for (const c of ['nominal', 'caution', 'fault', 'unknown'])
      pairEl.classList.toggle(c, c === 'fault');
  } else {
    pairEl.textContent = '\u2014';
    for (const c of ['nominal', 'caution', 'fault', 'unknown'])
      pairEl.classList.toggle(c, c === 'unknown');
  }

  // engine-out margin
  const outH = m?.engine_out_margin_hours;
  if (outH != null && outH > 0) {
    outEl.textContent = '+' + Math.round(outH) + '\u202fh';
    const cls = outH > 2 ? 'nominal' : 'caution';
    for (const c of ['nominal', 'caution', 'fault', 'unknown'])
      outEl.classList.toggle(c, c === cls);
  } else if (outH != null && outH <= 0) {
    outEl.textContent = '\u2014';
    for (const c of ['nominal', 'caution', 'fault', 'unknown'])
      outEl.classList.toggle(c, c === 'fault');
  } else {
    outEl.textContent = '\u2014';
    for (const c of ['nominal', 'caution', 'fault', 'unknown'])
      outEl.classList.toggle(c, c === 'unknown');
  }
}

/* ---------- painting ---------- */

function paint() {
  updateLiveBadge();

  for (const side of ['port', 'starboard']) {
    const st = uiStatus(side);
    const [stateText, pillText] = STATE_TEXT[st];
    updateRing(side, st);
    document.getElementById('state-' + side).textContent = stateText;
    const pill = document.getElementById('pill-' + side);
    pill.className = 'pill' + (st === 'nominal' ? '' : ' ' + st);
    pill.textContent = pillText;
    if (aircraft) tintPart(aircraft, 'engine_' + side, st === 'nominal' ? null : st);
    // RUL strip in the aircraft overview panel
    const rulEl = document.getElementById('rul-' + side);
    if (rulEl) {
      const r = live && live.engines && live.engines[side];
      rulEl.innerHTML = renderRulStrip(r);
    }

    // Change 2: baseline progress
    updateBaseline(side);

    // Change 5: sparkline — push to history and render
    if (live && live.engines && live.engines[side]) {
      const r = live.engines[side];
      if (r.status !== 'not_evaluated' && r.confidence !== null) {
        const h = 1 - (r.severity || 0);
        healthHistory[side].push(h);
        if (healthHistory[side].length > HEALTH_HIST_MAX)
          healthHistory[side].shift();
      }
    }
    const sparkEl = document.getElementById('spark-' + side);
    if (sparkEl) {
      sparkEl.innerHTML = renderSparkline(healthHistory[side]);
    }
  }

  // Change 3: auto-open engine on fault (fault only, never caution)
  if (live && live.engines) {
    const faultSide = ['port', 'starboard'].find(s =>
      live.engines[s] && live.engines[s].status === 'fault' && uiStatus(s) === 'fault');
    if (faultSide && faultSide !== lastAutoNav && view === 'aircraft') {
      lastAutoNav = faultSide;
      openEngine(faultSide);
    } else if (!faultSide) {
      lastAutoNav = null;
    }
  }

  // Change 7: stage-head subtitle update
  if (view === 'aircraft') {
    const hasFault = ['port', 'starboard'].some(s => uiStatus(s) === 'fault');
    document.getElementById('stage-sub').textContent = hasFault
      ? 'Tap the affected engine \u2014 fault detected'
      : 'Select an engine to inspect';
  }

  // Change 4: simplified finding cards for aircraft view
  const box = document.getElementById('findings');
  if (!live) {
    box.innerHTML = '<p class="empty">Waiting for the ground service\u2026</p>';
  } else {
    const items = [];
    for (const side of ['port', 'starboard']) {
      const r = live.engines && live.engines[side];
      if (!r) continue;
      const st = uiStatus(side);
      const name = side === 'port' ? 'Port (Left)' : 'Starboard (Right)';

      if (st === 'nominal') {
        items.push(`<div class="finding ok">
          <div class="t">${name} \u2014 Nominal</div>
          <div class="d">Measurements track the physics model across all trusted channels.</div>
          ${renderConfBar(r.confidence, 'nominal')}</div>`);
      } else if (st === 'fault' || st === 'caution') {
        // Change 4: simplified card — action text, no sigma values
        const severityWord = st === 'fault' ? 'Action required' : 'Monitor';
        const action = FAULT_ACTION[r.fault] || 'Inspect before next sortie';
        const confText = r.confidence !== null ? Math.round(r.confidence * 100) + '% confidence' : '';
        items.push(`<div class="finding ${st}">
          <div class="t">${name} \u2014 ${r.headline}</div>
          <div class="d">${severityWord} \u00b7 ${action}</div>
          ${confText ? '<div class="conf">' + confText + '</div>' : ''}
          ${renderConfBar(r.confidence, st)}</div>`);
      } else {
        items.push(`<div class="finding ${st}">
          <div class="t">${name} \u2014 ${r.headline || 'Not evaluated'}</div>
          <div class="d">${r.detail || ''}</div>
          ${renderConfBar(r.confidence, st)}</div>`);
      }
      for (const i of (r.instrumentation || [])) {
        items.push(`<div class="finding unknown">
          <div class="t">${name} \u2014 ${i.headline}</div>
          <div class="d">${i.detail}</div>
          <div class="conf">Sensor finding, engine health unaffected</div></div>`);
      }
    }
    const c = live.correlation;
    if (c && c.kind === 'shared_cause') {
      items.push(`<div class="finding caution">
        <div class="t">${c.headline}</div>
        <div class="d">${c.detail}</div>
        <div class="conf">Residual similarity ${c.similarity}</div></div>`);
    }
    box.innerHTML = items.length
      ? items.join('')
      : '<p class="empty">Waiting for data\u2026</p>';
  }

  // Change 1 + 6: mission banner and margin
  updateMissionBanner();
  updateMissionMargin();

  applyBarWidths();
  if (view === 'engine' && selected) paintDetail();
}

function paintDetail() {
  const r = live && live.engines && live.engines[selected];
  if (!r) return;

  const trust = r.trust || {};
  document.getElementById('readouts').innerHTML = CHANNELS.map(([k, label, unit, dp]) => {
    const v = r.measured ? r.measured[k] : null;
    const exp = r.expected ? r.expected[k] : null;
    const res = r.residual ? r.residual[k] : null;
    const t = trust[k];
    const bad = t && t.status !== 'trusted';
    const val = (v == null) ? '\u2014' : Number(v).toFixed(dp);
    const delta = (v != null && exp != null)
      ? (v - exp >= 0 ? '+' : '') + (v - exp).toFixed(dp) : null;
    const trustStatus = t ? t.status : 'trusted';
    return `<div class="readout${bad ? ' suspect' : ''}">
      <div class="k">${label}</div>
      <div class="v">${val} <span class="k">${unit}</span></div>
      ${bad ? `<div class="flag">${t.status === 'quarantined' ? 'not trusted' : 'suspect'}</div>`
        : (delta ? `<div class="flag model">model ${delta}</div>` : '')}
      ${rangeBar(k, v, exp, trustStatus, res)}
    </div>`;
  }).join('');

  const flags = r.parts || {};
  document.getElementById('parts').innerHTML = PART_KEYS.map(id => {
    const st = flags[id];
    const cls = st === 'fault' ? ' flagged' : st === 'caution' ? ' watch' : '';
    const note = st === 'fault' ? 'Flagged' : st === 'caution' ? 'Watch' : '';
    return `<button class="part${cls}" data-part="${id}">
      <span class="dot ${st || ''}"></span>
      <span class="pname">${PART_LABEL[id]}</span>
      <span class="note">${note}</span>
    </button>`;
  }).join('');

  // setExploded and tintPart operate on the 3D model only — they do not touch
  // the readouts or labels DOM. Bug 7 fix in syncCallouts is unaffected.
  if (engine) {
    for (const id of PART_KEYS) tintPart(engine, id, flags[id] || null);
    setExploded(flags, r.fault);
  }

  const extra = document.getElementById('sec-extra');
  const bits = [];
  if (r.rul) {
    if (r.rul.at_limit) {
      bits.push(`<div class="finding"><div class="t">Remaining useful life</div>
        <div class="d">At degradation limit \u2014 inspect before next sortie. ${r.hours_run} h run so far.</div>
        <div class="conf">${r.rul.basis}</div></div>`);
    } else if (r.rul.tbo_limited) {
      bits.push(`<div class="finding"><div class="t">Remaining useful life</div>
        <div class="d">${r.rul.hours}\u202fh rem. \u2014 no degradation trend detected. ${r.hours_run} h run so far.</div>
        <div class="conf">${r.rul.basis}</div></div>`);
    } else {
      bits.push(`<div class="finding"><div class="t">Remaining useful life</div>
        <div class="d">${r.rul.hours}\u202fh, P10 ${r.rul.p10}\u202fh to P90 ${r.rul.p90}\u202fh. ${r.hours_run} h run so far.</div>
        <div class="conf">${r.rul.basis}</div></div>`);
    }
  }
  if (r.evidence && r.evidence.length) {
    const ev = r.evidence.map(e => `${e.feature} (${e.z}\u03c3)`).join(', ');
    bits.push(`<div class="finding"><div class="t">What drove this</div>
      <div class="d">${ev}</div></div>`);
  }
  const m = live.mission;
  if (m && m.detail) {
    bits.push(`<div class="finding"><div class="t">Mission margin</div>
      <div class="d">${m.detail}</div>
      <div class="conf">${m.confidence_basis || ''}</div></div>`);
  }
  extra.innerHTML = bits.join('') || '<p class="empty">No projection yet.</p>';
  document.getElementById('sec-extra-wrap').classList.toggle('hidden', !bits.length);

  applyBarWidths();
}

const SIDE_NAME = { port: 'Port (Left)', starboard: 'Starboard (Right)' };

/* ---------- view switching ---------- */

async function openEngine(side) {
  selected = side;
  view = 'engine';
  document.getElementById('card-port').setAttribute('aria-current', String(side === 'port'));
  document.getElementById('card-starboard').setAttribute('aria-current', String(side === 'starboard'));

  await loadEngine();
  if (aircraft) aircraft.visible = false;
  engine.visible = true;
  frame(engine, 1.25);

  document.getElementById('stage-title').textContent = SIDE_NAME[side] + ' engine';
  document.getElementById('stage-sub').textContent = 'Flagged components are tinted';
  document.getElementById('side-title').textContent = SIDE_NAME[side] + ' engine';
  document.getElementById('side-sub').textContent = 'Live readings and components';
  document.getElementById('btn-back').classList.remove('hidden');
  // reveal the Readings tab and switch to it
  document.getElementById('stab-readings').classList.remove('hidden');
  setInfoTab('readings');
  document.getElementById('sec-parts').classList.remove('hidden');
  paintDetail();
}

function backToAircraft() {
  view = 'aircraft';
  selected = null;
  document.getElementById('card-port').setAttribute('aria-current', 'false');
  document.getElementById('card-starboard').setAttribute('aria-current', 'false');
  clearExploded();
  for (const [, el] of calloutEls) el.remove();
  calloutEls.clear();
  for (const [id, e] of exploded) { e.node.position.copy(e.base); }
  exploded.clear();
  if (engine) engine.visible = false;
  if (aircraft) { aircraft.visible = true; frame(aircraft, 1.15); }
  document.getElementById('stage-title').textContent = 'Aircraft';
  document.getElementById('stage-sub').textContent = 'Select an engine to inspect';
  document.getElementById('side-title').textContent = 'Propulsion status';
  document.getElementById('side-sub').textContent = 'Twin engine, live telemetry';
  document.getElementById('btn-back').classList.add('hidden');
  // hide the Readings tab and revert to Findings
  document.getElementById('stab-readings').classList.add('hidden');
  setInfoTab('findings');
  document.getElementById('sec-parts').classList.add('hidden');
  paint();
}

/* ---------- picking on the 3d view ---------- */

const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
let downAt = null;

canvas.addEventListener('pointerdown', e => { downAt = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerup', e => {
  if (!downAt) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 6 || view !== 'aircraft' || !aircraft) return;
  const r = canvas.getBoundingClientRect();
  ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ptr, camera);
  const hits = ray.intersectObject(aircraft, true);
  if (!hits.length) return;
  let n = hits[0].object;
  while (n && !/^engine_(port|starboard)$/.test(n.name)) n = n.parent;
  if (n) openEngine(n.name.replace('engine_', ''));
});

/* ---------- controls ---------- */

document.getElementById('card-port').onclick = () => openEngine('port');
document.getElementById('card-starboard').onclick = () => openEngine('starboard');
document.getElementById('btn-back').onclick = backToAircraft;
document.getElementById('stab-findings').onclick = () => setInfoTab('findings');
document.getElementById('stab-readings').onclick = () => setInfoTab('readings');

document.querySelectorAll('[data-sim]').forEach(btn => {
  btn.onclick = async () => {
    const kind = btn.dataset.sim;
    if (kind === 'clear') { await inject('both', null); return; }
    if (kind === 'injector') { await inject('both', null); await inject('port', 'injector_underflow', 0.8); return; }
    if (kind === 'sensor') { await inject('both', null); await inject('starboard', 'sensor_stuck'); return; }
    if (kind === 'systemic') { await inject('both', 'turbo_underperformance', 0.75); return; }
  };
});

document.getElementById('parts').addEventListener('click', e => {
  const b = e.target.closest('[data-part]');
  if (!b || !engine) return;
  const node = engine.getObjectByName(b.dataset.part);
  if (node) frame(node, 2.6);
});


paint();
connect();
