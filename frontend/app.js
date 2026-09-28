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
    handOverToLive();
  };
  sock.onmessage = ev => {
    try { live = JSON.parse(ev.data); } catch (e) { return; }
    filterClearingTelemetry();
    paint();
  };
  sock.onclose = () => {
    connected = false;
    if (!demoTimer) document.getElementById('hint').textContent = 'Backend not connected';
    setTimeout(connect, 2000);
  };
  sock.onerror = () => { try { sock.close(); } catch (e) { } };
}

/* ---------- cold-start handling ----------
   The backend runs on free hosting that sleeps when idle; the first request
   after a sleep can take minutes. Two things keep the page useful meanwhile:
   1. a wake-up ping to /health the moment the page loads, and
   2. if the backend is not connected after DEMO_AFTER_MS, replay frames that
      were recorded from the real backend (demo-data.json) so every panel and
      the Simulate buttons work. The badge and banner say plainly that this is a
      recording. When the live socket connects, the page switches to it. */

const DEMO_AFTER_MS = 3500;
const PAGE_START = Date.now();
let backendAwake = false;
let demoData = null;
let demoTimer = null;
let demo = null;            // { name, idx } while replaying
let lastSim = 'clear';      // last Simulate button pressed, re-applied on hand-over

/* Cooldown state when clearing faults to prevent lingering rolling-window residuals from flashing transient part faults */
let isClearing = false;
let clearStartTime = 0;
let nominalStreak = 0;

function filterClearingTelemetry() {
  if (!live || !live.engines) return;
  if (!isClearing) return;

  const now = performance.now();
  const elapsed = (now - clearStartTime) / 1000;

  const pRawSt = live.engines.port?.status;
  const sRawSt = live.engines.starboard?.status;
  const isRawNominal = (pRawSt === 'nominal' || pRawSt === 'not_evaluated') &&
                       (sRawSt === 'nominal' || sRawSt === 'not_evaluated');

  if (isRawNominal) {
    nominalStreak++;
  } else {
    nominalStreak = 0;
  }

  // Only exit clearing mode if backend has been stably nominal for at least 3 seconds (30 frames)
  // AND at least 10 seconds have elapsed (allowing the 12s residual window to drain),
  // OR after a hard timeout of 25 seconds.
  if ((elapsed >= 10 && nominalStreak >= 25) || elapsed >= 25) {
    isClearing = false;
    return;
  }

  // Intermediate state: residual rolling window is decaying. Suppress transient classification spikes:
  for (const s of ['port', 'starboard']) {
    const eng = live.engines[s];
    if (eng && eng.status !== 'nominal') {
      eng.status = 'nominal';
      eng.confidence = 1.0;
      eng.fault = null;
      eng.parts = {};
      eng.headline = 'Nominal (Restoring)';
      eng.detail = 'Fault cleared \u2014 stabilizing baseline telemetry.';
      if (eng.severity != null && eng.severity > 0) eng.severity = 0;
    } else if (eng) {
      eng.parts = {};
      eng.fault = null;
      if (eng.severity != null && eng.severity > 0) eng.severity = 0;
    }
  }
  if (live.mission) {
    live.mission.status = 'nominal';
    live.mission.detail = 'Sortie margins nominal. Propulsion healthy.';
  }
  if (engine) {
    for (const id of PART_KEYS) tintPart(engine, id, null);
  }
}

async function pingBackend() {
  for (let i = 0; i < 150 && !connected; i++) {
    let ctl = null, to = null;
    try {
      ctl = new AbortController();
      to = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch((API || '') + '/health', { cache: 'no-store', signal: ctl.signal });
      if (r.ok) { backendAwake = true; updateWakeBanner(); return; }
    } catch (e) { /* still asleep or waking */ }
    finally { if (to) clearTimeout(to); }
    await new Promise(res => setTimeout(res, 2000));
  }
}

function updateWakeBanner() {
  const el = document.getElementById('wake-banner');
  if (!el) return;
  if (connected || !demoTimer) { el.classList.add('hidden'); return; }
  const s = Math.round((Date.now() - PAGE_START) / 1000);
  el.querySelector('.wake-text').textContent = backendAwake
    ? 'Live backend is up, connecting… showing a recording until it is ready.'
    : 'Waking the live backend (free hosting sleeps when idle, this can take a few minutes). '
      + 'Showing a recording of its real output; live data takes over automatically.';
  el.querySelector('.wake-time').textContent = s + ' s';
  el.classList.remove('hidden');
}

async function startDemo() {
  if (connected || demoTimer) return;
  if (!demoData) {
    try { demoData = await (await fetch('demo-data.json')).json(); } catch (e) { return; }
  }
  if (connected || demoTimer || !demoData) return;
  demo = { name: 'clear', idx: 0 };
  demoTimer = setInterval(demoTick, demoData.interval_ms || 400);
  demoTick();
  updateWakeBanner();
  document.getElementById('hint').textContent = 'Drag to rotate';
}

function demoTick() {
  if (connected || !demo || !demoData) return;
  const sc = demoData.scenarios[demo.name];
  if (!sc) return;
  live = Object.assign({}, sc.frames[demo.idx], { ts: Date.now() / 1000 });
  demo.idx += 1;
  if (demo.idx >= sc.frames.length) demo.idx = sc.loop_from || 0;
  filterClearingTelemetry();
  paint();
}

function handOverToLive() {
  if (!demoTimer) return;
  clearInterval(demoTimer);
  demoTimer = null;
  demo = null;
  live = null;
  updateWakeBanner();
  // keep whatever scenario the viewer picked while they were on the recording
  if (lastSim !== 'clear') runSim(lastSim);
}

/* One place for the Simulate buttons: live backend when connected, else the recording. */
async function runSim(kind) {
  lastSim = kind;
  if (kind === 'clear') {
    isClearing = true;
    clearStartTime = performance.now();
    nominalStreak = 0;
    clearExploded(true);
    if (engine) {
      for (const id of PART_KEYS) tintPart(engine, id, null);
    }
    if (live && live.engines) {
      for (const s of ['port', 'starboard']) {
        if (live.engines[s]) {
          live.engines[s].parts = {};
          live.engines[s].status = 'nominal';
          live.engines[s].fault = null;
          live.engines[s].confidence = 1.0;
          live.engines[s].headline = 'Nominal';
          live.engines[s].severity = 0;
        }
      }
    }
    paint();
    if (connected) await inject('both', null);
    return;
  }

  isClearing = false;
  nominalStreak = 0;
  if (!connected) {
    if (demo && demoData && demoData.scenarios[kind]) demo = { name: kind, idx: 0 };
    return;
  }

  if (appMode === 'single') {
    if (kind === 'injector') { await inject('both', null); await inject('port', 'injector_underflow', 0.8); return; }
    if (kind === 'sensor') { await inject('both', null); await inject('port', 'sensor_stuck'); return; }
    if (kind === 'systemic') { await inject('both', null); await inject('port', 'turbo_underperformance', 0.75); return; }
  } else {
    if (kind === 'injector') { await inject('both', null); await inject('port', 'injector_underflow', 0.8); return; }
    if (kind === 'sensor') { await inject('both', null); await inject('starboard', 'sensor_stuck'); return; }
    if (kind === 'systemic') { await inject('both', 'turbo_underperformance', 0.75); return; }
  }
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
  if (isClearing) {
    clearExploded(true);
    return;
  }
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

function clearExploded(instant = false) {
  if (instant) {
    for (const [id, e] of exploded) {
      e.target = 0;
      e.t = 0;
      e.node.position.copy(e.base);
    }
    exploded.clear();
    animating = false;
  } else {
    for (const [, e] of exploded) e.target = 0;
    animating = true;
  }
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
  const elTop = document.getElementById('live-badge-top');
  function syncEl(target) {
    if (!target) return;
    if (!connected) {
      if (demoTimer) {
        target.className = 'live-badge demo';
        target.textContent = '\u25cf Recorded demo';
        return;
      }
      target.className = 'live-badge offline';
      target.textContent = '\u25cf Offline';
      return;
    }
    if (!live) return;
    const age = Date.now() / 1000 - live.ts;
    const stale = age > 2;
    target.className = 'live-badge ' + (stale ? 'stale' : 'live');
    target.textContent = '\u25cf ' + (stale
      ? 'Stale \u2014 ' + age.toFixed(0) + '\u202fs'
      : 'Live \u2014 ' + age.toFixed(1) + '\u202fs ago');
  }
  syncEl(el);
  syncEl(elTop);
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

  // Single-Engine UAV: pair margin is single powerplant margin, engine-out is N/A
  if (appMode === 'single') {
    const portR = live?.engines?.port;
    const sH = (portR && portR.rul && portR.rul.hours) ? portR.rul.hours : m?.pair_margin_hours;
    if (sH != null && sH > 0) {
      pairEl.textContent = '+' + Math.round(sH) + '\u202fh';
      const cls = sH > 2 ? 'nominal' : 'caution';
      for (const c of ['nominal', 'caution', 'fault', 'unknown'])
        pairEl.classList.toggle(c, c === cls);
    } else {
      pairEl.textContent = '\u2014';
      for (const c of ['nominal', 'caution', 'fault', 'unknown'])
        pairEl.classList.toggle(c, c === 'unknown');
    }
    outEl.textContent = 'N/A';
    for (const c of ['nominal', 'caution', 'fault', 'unknown'])
      outEl.classList.toggle(c, c === 'unknown');
    return;
  }

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

/* ---- Squadron Fleet Card 1 (TAPAS-01) live sync ---- */
function updateFleetCard1() {
  if (!live) return;
  const m = live.mission;
  const statusEl   = document.getElementById('fleet-card1-status');
  const rowStatusEl = document.getElementById('fleet-row-status');
  const pairEl     = document.getElementById('fleet-card1-pair');
  const rowPairEl  = document.getElementById('fleet-row-pair');
  const outEl      = document.getElementById('fleet-card1-out');
  const rowOutEl   = document.getElementById('fleet-row-out');
  const engPortEl  = document.getElementById('fleet-card1-eng-port');
  const engStbdEl  = document.getElementById('fleet-card1-eng-starboard');
  const rowStbdEl  = document.getElementById('fleet-row-eng-starboard');
  const rulPortEl  = document.getElementById('fleet-card1-rul-port');
  const rulStbdEl  = document.getElementById('fleet-card1-rul-starboard');

  const stPort = uiStatus('port');
  const stStbd = uiStatus('starboard');
  const portR  = live.engines && live.engines.port;
  const stbdR  = live.engines && live.engines.starboard;

  // Status call
  const overallSt = (stPort === 'fault' || stStbd === 'fault') ? 'fault'
                  : (stPort === 'caution' || stStbd === 'caution') ? 'caution'
                  : (stPort === 'nominal' && stStbd === 'nominal') ? 'nominal' : 'unknown';
  const label = overallSt === 'nominal' ? 'GO' : overallSt === 'caution' ? 'CAUTION' : overallSt === 'fault' ? 'NO-GO' : 'EVALUATING';

  if (statusEl) {
    statusEl.textContent = label;
    statusEl.className = 'pill ' + overallSt;
  }
  if (rowStatusEl) {
    rowStatusEl.textContent = label;
    rowStatusEl.className = 'pill ' + overallSt;
  }

  // Margins
  const pairH = m?.pair_margin_hours;
  const pairTxt = (pairH != null && pairH > 0) ? '+' + Math.round(pairH) + '\u202fh' : '\u2014';
  if (pairEl) pairEl.textContent = pairTxt;
  if (rowPairEl) rowPairEl.textContent = pairTxt;

  const outH = m?.engine_out_margin_hours;
  const outTxt = (outH != null && outH > 0) ? '+' + Math.round(outH) + '\u202fh' : '\u2014';
  if (outEl) outEl.textContent = outTxt;
  if (rowOutEl) rowOutEl.textContent = outTxt;

  // Port Engine
  if (engPortEl) {
    const portHealth = portR && portR.severity != null ? Math.round((1 - portR.severity) * 100) : 99;
    engPortEl.textContent = (stPort === 'nominal' ? 'Nominal' : stPort === 'caution' ? 'Caution' : 'Fault') + ' \u00b7 ' + portHealth + '%';
    engPortEl.className = 'fleet-eng-state ' + stPort;
  }
  if (rulPortEl) {
    rulPortEl.textContent = (portR && portR.rul && portR.rul.hours) ? 'RUL: +' + Math.round(portR.rul.hours) + 'h' : 'RUL: +923h';
  }

  // Starboard Engine
  if (engStbdEl) {
    const stbdHealth = stbdR && stbdR.severity != null ? Math.round((1 - stbdR.severity) * 100) : 99;
    engStbdEl.textContent = (stStbd === 'nominal' ? 'Nominal' : stStbd === 'caution' ? 'Caution' : 'Fault') + ' \u00b7 ' + stbdHealth + '%';
    engStbdEl.className = 'fleet-eng-state ' + stStbd;
  }
  if (rowStbdEl) {
    const stbdHealth = stbdR && stbdR.severity != null ? Math.round((1 - stbdR.severity) * 100) : 99;
    rowStbdEl.textContent = (stStbd === 'nominal' ? '\u25cf Nominal' : stStbd === 'caution' ? '\u25b2 Caution' : '\u25a0 Fault') + ' (' + stbdHealth + '%)';
    rowStbdEl.className = 'dot-text ' + stStbd;
  }
  if (rulStbdEl) {
    rulStbdEl.textContent = (stbdR && stbdR.rul && stbdR.rul.hours) ? 'RUL: +' + Math.round(stbdR.rul.hours) + 'h' : 'RUL: +923h';
  }

  // Card 2: RUSTOM-01 (Single-Engine Tactical UAV)
  const c2StatusEl = document.getElementById('fleet-card2-status');
  const c2EngEl    = document.getElementById('fleet-card2-eng');
  const c2RulEl    = document.getElementById('fleet-card2-rul');
  const c2MarginEl = document.getElementById('fleet-card2-margin');
  const r2StatusEl = document.getElementById('fleet-row-single-status');
  const r2EngEl    = document.getElementById('fleet-row-single-eng');
  const r2MarginEl = document.getElementById('fleet-row-single-margin');

  const sEngSt = stPort;
  const sLabel = sEngSt === 'nominal' ? 'GO' : sEngSt === 'caution' ? 'CAUTION' : sEngSt === 'fault' ? 'NO-GO' : 'EVALUATING';
  if (c2StatusEl) {
    c2StatusEl.textContent = sLabel;
    c2StatusEl.className = 'pill ' + sEngSt;
  }
  if (r2StatusEl) {
    r2StatusEl.textContent = sLabel;
    r2StatusEl.className = 'pill ' + sEngSt;
  }
  if (c2EngEl) {
    const pHealth = portR && portR.severity != null ? Math.round((1 - portR.severity) * 100) : 99;
    c2EngEl.textContent = (sEngSt === 'nominal' ? 'Nominal' : sEngSt === 'caution' ? 'Caution' : 'Fault') + ' \u00b7 ' + pHealth + '%';
    c2EngEl.className = 'fleet-eng-state ' + sEngSt;
  }
  if (r2EngEl) {
    const pHealth = portR && portR.severity != null ? Math.round((1 - portR.severity) * 100) : 99;
    r2EngEl.textContent = (sEngSt === 'nominal' ? '\u25cf Nominal' : sEngSt === 'caution' ? '\u25b2 Caution' : '\u25a0 Fault') + ' (' + pHealth + '%)';
    r2EngEl.className = 'dot-text ' + sEngSt;
  }
  const sRulH = (portR && portR.rul && portR.rul.hours) ? Math.round(portR.rul.hours) : 890;
  if (c2RulEl) c2RulEl.textContent = 'RUL: +' + sRulH + 'h \u00b7 Standalone Twin';
  if (c2MarginEl) c2MarginEl.textContent = '+' + sRulH + 'h';
  if (r2MarginEl) r2MarginEl.textContent = '+' + sRulH + 'h';
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
    const sides = appMode === 'single' ? ['port'] : ['port', 'starboard'];
    for (const side of sides) {
      const r = live.engines && live.engines[side];
      if (!r) continue;
      const st = uiStatus(side);
      const name = appMode === 'single' ? 'RUSTOM-01 Powerplant' : (side === 'port' ? 'Port (Left)' : 'Starboard (Right)');

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
    if (appMode !== 'single') {
      const c = live.correlation;
      if (c && c.kind === 'shared_cause') {
        items.push(`<div class="finding caution">
          <div class="t">${c.headline}</div>
          <div class="d">${c.detail}</div>
          <div class="conf">Residual similarity ${c.similarity}</div></div>`);
      }
    }
    box.innerHTML = items.length
      ? items.join('')
      : '<p class="empty">Waiting for data\u2026</p>';
  }

  // Change 1 + 6: mission banner and margin
  updateMissionBanner();
  updateMissionMargin();
  updateFleetCard1();

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
    if (isClearing) {
      for (const id of PART_KEYS) tintPart(engine, id, null);
      clearExploded(true);
    } else {
      for (const id of PART_KEYS) tintPart(engine, id, flags[id] || null);
      setExploded(flags, r.fault);
    }
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
  // notify tour if the click-engine step is waiting
  if (typeof tourOnEngineOpen === 'function') tourOnEngineOpen();
}

function backToAircraft() {
  if (appMode === 'single') return;
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
canvas.addEventListener('pointermove', e => {
  if (view !== 'aircraft' || !aircraft) {
    if (canvas.style.cursor) canvas.style.cursor = '';
    return;
  }
  const r = canvas.getBoundingClientRect();
  ptr.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ptr.y = -((e.clientY - r.top) / r.height) * 2 + 1;
  ray.setFromCamera(ptr, camera);
  const hits = ray.intersectObject(aircraft, true);
  let isNacelle = false;
  if (hits.length) {
    let n = hits[0].object;
    while (n && !/^engine_(port|starboard)$/.test(n.name)) n = n.parent;
    if (n) isNacelle = true;
  }
  canvas.style.cursor = isNacelle ? 'pointer' : '';
});
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
  btn.onclick = () => runSim(btn.dataset.sim);
});

document.getElementById('parts').addEventListener('click', e => {
  const b = e.target.closest('[data-part]');
  if (!b || !engine) return;
  const node = engine.getObjectByName(b.dataset.part);
  if (node) frame(node, 2.6);
});


/* ---------- spotlight guide ---------- */

/* ---------- view switcher: twin vs single vs fleet ---------- */

let appMode = 'twin'; // 'twin' | 'single' | 'fleet'

const btnViewTwin     = document.getElementById('btn-view-twin');
const btnViewSingle   = document.getElementById('btn-view-single');
const btnViewFleet    = document.getElementById('btn-view-fleet');
const viewTwin        = document.getElementById('view-twin');
const viewFleet       = document.getElementById('view-fleet');

function showTwinView() {
  appMode = 'twin';
  if (btnViewTwin) {
    btnViewTwin.classList.add('active');
    btnViewTwin.setAttribute('aria-selected', 'true');
  }
  if (btnViewSingle) {
    btnViewSingle.classList.remove('active');
    btnViewSingle.setAttribute('aria-selected', 'false');
  }
  if (btnViewFleet) {
    btnViewFleet.classList.remove('active');
    btnViewFleet.setAttribute('aria-selected', 'false');
  }
  if (viewTwin) viewTwin.classList.remove('hidden');
  if (viewFleet) viewFleet.classList.add('hidden');

  // Restore Starboard entry and restore Port label
  const entryStbd = document.getElementById('entry-starboard');
  if (entryStbd) entryStbd.classList.remove('hidden');
  const namePort = document.getElementById('name-port');
  if (namePort) namePort.textContent = 'Port (Left)';
  const hEngines = document.getElementById('sec-engines-heading');
  if (hEngines) hEngines.textContent = 'Engines';
  const lPair = document.getElementById('margin-pair-label');
  if (lPair) lPair.textContent = 'hours pair margin';
  const lOut = document.getElementById('margin-out-label');
  if (lOut) lOut.textContent = 'engine-out margin';

  // Restore simulate buttons for twin
  const bInj = document.getElementById('sim-btn-injector');
  if (bInj) bInj.textContent = 'Injector fault, port (left)';
  const bSen = document.getElementById('sim-btn-sensor');
  if (bSen) bSen.textContent = 'Sensor fault, starboard (right)';
  const bSys = document.getElementById('sim-btn-systemic');
  if (bSys) bSys.textContent = 'Both engines drift';

  backToAircraft();
  needsRender = true;
  if (typeof resize === 'function') resize();
}

async function showSingleView() {
  appMode = 'single';
  if (btnViewSingle) {
    btnViewSingle.classList.add('active');
    btnViewSingle.setAttribute('aria-selected', 'true');
  }
  if (btnViewTwin) {
    btnViewTwin.classList.remove('active');
    btnViewTwin.setAttribute('aria-selected', 'false');
  }
  if (btnViewFleet) {
    btnViewFleet.classList.remove('active');
    btnViewFleet.setAttribute('aria-selected', 'false');
  }
  if (viewTwin) viewTwin.classList.remove('hidden');
  if (viewFleet) viewFleet.classList.add('hidden');

  // Hide starboard engine and update port label to Primary Engine
  const entryStbd = document.getElementById('entry-starboard');
  if (entryStbd) entryStbd.classList.add('hidden');
  const namePort = document.getElementById('name-port');
  if (namePort) namePort.textContent = 'Primary Engine (2.2L Aero-Diesel)';
  const hEngines = document.getElementById('sec-engines-heading');
  if (hEngines) hEngines.textContent = 'Propulsion Unit';
  const lPair = document.getElementById('margin-pair-label');
  if (lPair) lPair.textContent = 'Sortie margin';
  const lOut = document.getElementById('margin-out-label');
  if (lOut) lOut.textContent = 'Engine-out (N/A)';

  // Update simulate buttons for single engine
  const bInj = document.getElementById('sim-btn-injector');
  if (bInj) bInj.textContent = 'Injector fault (Single Engine)';
  const bSen = document.getElementById('sim-btn-sensor');
  if (bSen) bSen.textContent = 'Sensor fault (Single Engine)';
  const bSys = document.getElementById('sim-btn-systemic');
  if (bSys) bSys.textContent = 'Turbo / boost drift';

  selected = 'port';
  view = 'engine';
  document.getElementById('card-port').setAttribute('aria-current', 'true');
  const cardStbd = document.getElementById('card-starboard');
  if (cardStbd) cardStbd.setAttribute('aria-current', 'false');

  await loadEngine();
  if (aircraft) aircraft.visible = false;
  if (engine) {
    engine.visible = true;
    frame(engine, 1.25);
  }

  document.getElementById('stage-title').textContent = 'RUSTOM-01 \u00b7 Single-Engine UAV';
  document.getElementById('stage-sub').textContent = '2.2L Aero-Diesel Powerplant (Direct Engine Twin)';
  document.getElementById('side-title').textContent = 'RUSTOM-01 Propulsion';
  document.getElementById('side-sub').textContent = 'Single 2.2L Aero-Diesel \u00b7 Live CAN Stream';
  
  // Single-engine UAV has no aircraft view to return to; hide the back button
  document.getElementById('btn-back').classList.add('hidden');
  document.getElementById('stab-readings').classList.remove('hidden');
  setInfoTab('readings');
  document.getElementById('sec-parts').classList.remove('hidden');

  needsRender = true;
  if (typeof resize === 'function') resize();
  paintDetail();
  paint();
}

function showFleetView() {
  appMode = 'fleet';
  if (btnViewFleet) {
    btnViewFleet.classList.add('active');
    btnViewFleet.setAttribute('aria-selected', 'true');
  }
  if (btnViewTwin) {
    btnViewTwin.classList.remove('active');
    btnViewTwin.setAttribute('aria-selected', 'false');
  }
  if (btnViewSingle) {
    btnViewSingle.classList.remove('active');
    btnViewSingle.setAttribute('aria-selected', 'false');
  }
  if (viewFleet) viewFleet.classList.remove('hidden');
  if (viewTwin) viewTwin.classList.add('hidden');
  needsRender = false;
  updateFleetCard1();
}

if (btnViewTwin)   btnViewTwin.onclick = showTwinView;
if (btnViewSingle) btnViewSingle.onclick = showSingleView;
if (btnViewFleet)  btnViewFleet.onclick = showFleetView;

const btnFleetOpenTwin = document.getElementById('btn-fleet-open-twin');
if (btnFleetOpenTwin) btnFleetOpenTwin.onclick = showTwinView;
const btnFleetOpenSingle = document.getElementById('btn-fleet-open-single');
if (btnFleetOpenSingle) btnFleetOpenSingle.onclick = showSingleView;

const btnFleetTableTwin = document.getElementById('btn-fleet-table-twin');
if (btnFleetTableTwin) btnFleetTableTwin.onclick = showTwinView;
const btnFleetTableSingle = document.getElementById('btn-fleet-table-single');
if (btnFleetTableSingle) btnFleetTableSingle.onclick = showSingleView;

/* ---------- spotlight guide ---------- */

const TOUR_KEY = 'shadowtwin_tour_seen_v6';

/* ---- Aircraft-view steps ---- */
const AIRCRAFT_STEPS = [
  {
    targetId: null,
    place: 'center',
    eyebrow: 'AeroTwin \u2014 Quick Guide',
    title: 'Digital Twin for Twin-Engine MALE UAVs',
    body: 'This system runs a real-time physics model side-by-side with incoming CAN telemetry, ' +
          'detecting propulsion anomalies and predicting remaining useful life before faults become critical. ' +
          'Let\u2019s walk through the key features.',
    showDontShow: false,
    type: 'normal',
    view: 'twin'
  },
  {
    targetId: 'viewport',
    place: 'right',
    eyebrow: 'Aircraft Step 1 of 9 \u2014 3D Airframe',
    title: 'TAPAS-BH-201 3D Airframe',
    body: '<strong>Drag</strong> to orbit, <strong>scroll</strong> to zoom. ' +
          'The twin wing-mounted nacelles house the 2.2\u202fL turbo-diesel aero powerplants.',
    showDontShow: false,
    type: 'normal',
    view: 'twin'
  },
  {
    targetId: 'mission-banner',
    place: 'left',
    eyebrow: 'Aircraft Step 2 of 9 \u2014 Go / No-Go Banner',
    title: 'Mission readiness at a glance',
    body: 'Combines health across both engines into a single operational call: ' +
          '<strong>GO</strong>, <strong>CAUTION</strong>, or <strong>NO-GO</strong>. ' +
          'If it says GO, the aircraft is safe to fly. CAUTION warns of emerging drift, and NO-GO marks critical degradation.',
    showDontShow: false,
    type: 'normal',
    view: 'twin'
  },
  {
    targetId: 'sec-engines',
    place: 'left',
    eyebrow: 'Aircraft Step 3 of 9 \u2014 Engine Status',
    title: 'Port & Starboard engines',
    body: 'Each card shows live status (<strong>Nominal / Caution / Fault</strong>), ' +
          'health sparkline trend, and remaining useful life. You can monitor whether one or both engines are degrading.',
    showDontShow: false,
    type: 'normal',
    view: 'twin'
  },
  {
    targetId: 'sec-margin',
    place: 'left',
    eyebrow: 'Aircraft Step 4 of 9 \u2014 Mission Margin',
    title: 'Sortie endurance margins',
    body: '<strong>Hours pair margin</strong> shows how many flight hours both engines together can sustain before hitting limits. ' +
          '<strong>Engine-out margin</strong> shows endurance if one engine failed.',
    showDontShow: false,
    type: 'normal',
    view: 'twin'
  },
  {
    targetId: 'sec-simulate',
    place: 'left',
    eyebrow: 'Aircraft Step 5 of 9 \u2014 Simulate',
    title: 'Live fault injection',
    body: 'Test how the twin responds. Inject an <strong>Injector fault</strong>, <strong>Sensor fault</strong>, or ' +
          '<strong>Both engines drift</strong> to see live detection and mission margins update. <strong>Clear</strong> resets to nominal.',
    showDontShow: false,
    type: 'normal',
    view: 'twin'
  },
  {
    targetId: 'btn-view-single',
    place: 'below',
    eyebrow: 'Aircraft Step 6 of 9 \u2014 Single-Engine UAV',
    title: 'Single-Engine Tactical UAV',
    body: 'Switch to a standalone single-engine tactical UAV (Rustom-1 / Archer class) to inspect the 2.2L aero-diesel powerplant directly without requiring the aircraft airframe.',
    showDontShow: false,
    type: 'normal',
    view: 'twin'
  },
  {
    targetId: 'btn-view-fleet',
    place: 'below',
    eyebrow: 'Aircraft Step 7 of 9 \u2014 Fleet Navigation',
    title: 'Multi-UAV fleet switching',
    body: 'Use this top switcher to toggle between the <strong>Twin-Engine TAPAS-01</strong>, <strong>Single-Engine RUSTOM-01</strong>, and the <strong>Squadron Fleet Command</strong> dashboard.',
    showDontShow: false,
    type: 'normal',
    view: 'twin'
  },
  {
    targetId: 'fleet-card-1',
    place: 'right',
    eyebrow: 'Aircraft Step 8 of 9 \u2014 Squadron Fleet Command',
    title: 'Monitor 4 UAVs in a single dashboard',
    body: 'The twin scales across the entire squadron. Here you can monitor all 4 MALE and tactical UAVs simultaneously \u2014 tracking propulsion health, operational readiness (GO / CAUTION / NO-GO), and sortie margins in real time. TAPAS-03 is flagged for Starboard EGT drift.',
    showDontShow: false,
    type: 'normal',
    view: 'fleet'
  },
  {
    targetId: 'viewport',
    place: 'right',
    eyebrow: 'Aircraft Step 9 of 9 \u2014 Engine Inspection',
    title: 'Click an engine nacelle to fly inside',
    body: 'Back on lead aircraft TAPAS-01: the pulsing rings mark the engine nacelles. <strong>Click either engine nacelle</strong> ' +
          '(or click an engine card on the right) to fly inside and inspect the engine internals!',
    showDontShow: false,
    type: 'click-engine',
    view: 'twin'
  }
];

/* ---- Single-engine-view steps (shown when tour is opened in Single-engine view) ---- */
const SINGLE_STEPS = [
  {
    targetId: null,
    place: 'center',
    eyebrow: 'RUSTOM-01 \u2014 Single-Engine UAV',
    title: 'Standalone Engine Digital Twin',
    body: 'This platform monitors a single-engine tactical UAV powerplant directly in 3D without requiring the aircraft airframe. All CAN telemetry and physics models connect to the primary 2.2L aero-diesel unit.',
    showDontShow: false,
    type: 'normal',
    view: 'single'
  },
  {
    targetId: 'card-port',
    place: 'left',
    eyebrow: 'Single-Engine Step 1 of 4 \u2014 Propulsion Health',
    title: 'Primary engine status',
    body: 'Real-time propulsion health index, RUL projection strip, and confidence metrics for the single powerplant.',
    showDontShow: false,
    type: 'normal',
    view: 'single'
  },
  {
    targetId: 'panel-readings',
    place: 'right',
    eyebrow: 'Single-Engine Step 2 of 4 \u2014 Telemetry vs Physics',
    title: 'Mean Value Engine Model',
    body: 'Compares real-time sensor measurements against expected physics at the current operating point to detect early drift.',
    showDontShow: false,
    type: 'normal',
    view: 'single'
  },
  {
    targetId: 'sec-parts',
    place: 'left',
    eyebrow: 'Single-Engine Step 3 of 4 \u2014 Internal Diagnostics',
    title: 'Flagged components',
    body: 'When degradation occurs, affected components highlight in brick-red or amber and pop out in 3D exploded view with diagnostic callouts.',
    showDontShow: false,
    type: 'normal',
    view: 'single'
  },
  {
    targetId: 'btn-view-twin',
    place: 'below',
    eyebrow: 'Single-Engine Step 4 of 4 \u2014 Switch to Twin Airframe',
    title: 'Switch between UAV classes',
    body: 'Click <strong>TAPAS-01 Twin-Engine UAV</strong> at any time to switch to the twin wing-mounted airframe.',
    showDontShow: true,
    type: 'normal',
    view: 'single'
  }
];

/* ---- Engine-view steps (shown after openEngine() during tour) ---- */
const ENGINE_STEPS = [
  {
    targetId: null,
    place: 'center',
    eyebrow: 'Engine view',
    title: 'You\u2019re inside the engine',
    body: 'The 3D model now shows the engine internals. Flagged components are tinted ' +
          '\u2014 red for fault, amber for caution. Eight steps walk through every panel on the right.',
    showDontShow: false,
    type: 'normal'
  },
  {
    targetId: 'mission-banner',
    place: 'left',
    eyebrow: 'Engine step 1 of 8 \u2014 Go / No-Go',
    title: 'Mission status at a glance',
    body: 'This banner gives the single most important answer: <strong>GO</strong>, ' +
          '<strong>CAUTION</strong>, or <strong>NO-GO</strong>. It combines the health ' +
          'of both engines and the remaining mission margin into one call. ' +
          'If it says GO, the aircraft is safe to continue. CAUTION means watch closely. ' +
          'NO-GO means at least one engine has reached a fault threshold.',
    showDontShow: false,
    type: 'normal'
  },
  {
    targetId: 'sec-engines',
    place: 'left',
    eyebrow: 'Engine step 2 of 8 \u2014 Engine cards',
    title: 'Port & Starboard engine status',
    body: 'Each card shows the per-engine health state, remaining-useful-life strip, ' +
          'and a confidence pill. <strong>Nominal</strong> means the twin sees no drift. ' +
          '<strong>Caution</strong> means a trend is forming. <strong>Fault</strong> means ' +
          'a classified fault has been detected above the confidence threshold.',
    showDontShow: false,
    type: 'normal'
  },
  {
    targetId: 'panel-findings',
    place: 'right',
    eyebrow: 'Engine step 3 of 8 \u2014 Findings',
    title: 'What\u2019s wrong and why',
    body: '<strong>Findings</strong> names the fault in plain language, which component ' +
          'is affected, and the confidence level. Sensor faults are listed separately ' +
          'so they are never confused with engine problems.',
    showDontShow: false,
    type: 'normal'
  },
  {
    targetId: 'panel-readings',
    place: 'right',
    eyebrow: 'Engine step 4 of 8 \u2014 Readings',
    title: 'Sensor vs physics model',
    body: 'Every sensor channel shows its <strong>measured value</strong> alongside what ' +
          'the physics model expected. The delta tells you exactly how far the engine has ' +
          'drifted from healthy behaviour at the current operating point.',
    showDontShow: false,
    type: 'normal'
  },
  {
    targetId: 'sec-parts',
    place: 'left',
    eyebrow: 'Engine step 5 of 8 \u2014 Components',
    title: 'Flagged components',
    body: 'Click any component here to zoom the 3D view onto it. <strong>Fault</strong> ' +
          'parts highlight in brick-red; <strong>Caution</strong> parts in amber. ' +
          'When the engine is healthy all components stay neutral grey.',
    showDontShow: false,
    type: 'normal'
  },
  {
    targetId: 'sec-margin',
    place: 'left',
    eyebrow: 'Engine step 6 of 8 \u2014 Mission margin',
    title: 'How long can the aircraft keep flying?',
    body: '<strong>Hours pair margin</strong> \u2014 how many flight hours both engines ' +
          'together can sustain before hitting a degradation limit. ' +
          '<strong>Engine-out margin</strong> \u2014 the same calculation assuming one ' +
          'engine is already lost. Both update live as the twin runs.',
    showDontShow: false,
    type: 'normal'
  },
  {
    targetId: 'sec-extra-wrap',
    place: 'left',
    eyebrow: 'Engine step 7 of 8 \u2014 Projection',
    title: 'Remaining useful life & trend',
    body: '<strong>Projection</strong> shows the remaining-useful-life estimate with a ' +
          'P10\u2013P90 confidence band, driven by the degradation rate the twin is ' +
          'currently tracking. This is a model-based indicator, not a field-validated ' +
          'number. Treat it as a relative trend, not a hard maintenance limit.',
    showDontShow: false,
    type: 'normal'
  },
  {
    targetId: 'sec-simulate',
    place: 'left',
    eyebrow: 'Engine step 8 of 8 \u2014 Simulate',
    title: 'Inject a fault to try it out',
    body: 'Pick <strong>Injector fault</strong>, <strong>Sensor fault</strong>, or ' +
          '<strong>Both engines drift</strong> and watch detection, findings and mission ' +
          'margin update within a few seconds. <strong>Clear</strong> resets everything ' +
          'back to nominal.',
    showDontShow: true,
    type: 'normal'
  }
];

/* ---- Fleet-view steps (shown when tour is opened in Fleet view) ---- */
const FLEET_STEPS = [
  {
    targetId: null,
    place: 'center',
    eyebrow: 'Fleet Command \u2014 Quick Guide',
    title: 'Squadron Propulsion Fleet Command',
    body: 'This dashboard provides fleet-level health monitoring and predictive maintenance ' +
          'across multiple MALE UAVs, directly fulfilling the DRDO SIH 26054 multi-aircraft requirement.',
    showDontShow: false,
    type: 'normal',
    view: 'fleet'
  },
  {
    targetId: 'fleet-card-1',
    place: 'right',
    eyebrow: 'Fleet Step 1 of 4 \u2014 Live Digital Twin',
    title: 'TAPAS-01 (Bravo-01) Live Link',
    body: 'This airframe is currently connected to the live CAN bus telemetry feed. ' +
          'Click <strong>Inspect Live Digital Twin \u2192</strong> (or the top tab) to open the full 3D interactive model and physics analytics.',
    showDontShow: false,
    type: 'normal',
    view: 'fleet'
  },
  {
    targetId: 'fleet-card-3',
    place: 'left',
    eyebrow: 'Fleet Step 2 of 4 \u2014 Fleet Caution Alert',
    title: 'Automated fleet-wide anomaly tracking',
    body: 'When any aircraft in the squadron begins to degrade, it is immediately flagged with root-cause advisories ' +
          '(such as TAPAS-03\u2019s Starboard EGT drift and injector variance) before flight safety is compromised.',
    showDontShow: false,
    type: 'normal',
    view: 'fleet'
  },
  {
    targetId: 'fleet-card-4',
    place: 'left',
    eyebrow: 'Fleet Step 3 of 4 \u2014 Depot Maintenance',
    title: 'Scheduled service tracking',
    body: 'Tracks airframes in hangared depot maintenance at ATR Chitradurga, including run hours and periodic inspection clearance.',
    showDontShow: false,
    type: 'normal',
    view: 'fleet'
  },
  {
    targetId: 'btn-view-twin',
    place: 'below',
    eyebrow: 'Fleet Step 4 of 4 \u2014 Deep Engine Inspection',
    title: 'Return to 3D Digital Twin',
    body: 'Click <strong>TAPAS-01 Live Twin</strong> at any time to return to the interactive 3D airframe, physics residual charts, and component-level diagnostics.',
    showDontShow: true,
    type: 'normal',
    view: 'fleet'
  }
];

/* ---- State ---- */
const tourScrim      = document.getElementById('tour-overlay');
const tourTooltip    = document.getElementById('tour-tooltip');
const tourDots       = document.getElementById('tour-dots');
const tourNext       = document.getElementById('tour-next');
const tourBack       = document.getElementById('tour-back');
const tourSkip       = document.getElementById('tour-skip');
const tourDontShow   = document.getElementById('tour-dontshow-final');
const tourDontWrap   = document.getElementById('tour-dontshow-wrap');
const nacelleOverlay = document.getElementById('tour-nacelle-pulse');

let tourActive    = false;
let tourPhase     = 'aircraft';   // 'aircraft' | 'engine' | 'fleet'
let tourIdx       = 0;
let nacelleRafId  = null;

function currentSteps() {
  if (tourPhase === 'fleet') return FLEET_STEPS;
  if (tourPhase === 'single') return SINGLE_STEPS;
  return tourPhase === 'engine' ? ENGINE_STEPS : AIRCRAFT_STEPS;
}

/* Build dots — always re-built when phase changes */
function buildDots() {
  tourDots.innerHTML = '';
  currentSteps().forEach((_, i) => {
    const d = document.createElement('span');
    d.className = 'dot';
    tourDots.appendChild(d);
  });
}

const PAD = 8;

/* Project a 3D nacelle world position to CSS screen coordinates */
function nacelleScreenPos(side) {
  if (!aircraft) return null;
  const node = aircraft.getObjectByName('engine_' + side);
  if (!node) return null;
  const vec = new THREE.Vector3();
  node.getWorldPosition(vec);
  vec.project(camera);
  const r = canvas.getBoundingClientRect();
  return {
    x: r.left + ((vec.x + 1) / 2) * r.width,
    y: r.top  + ((-vec.y + 1) / 2) * r.height
  };
}

/* Animate nacelle rings tracking the 3D objects */
function tickNacelleOverlay() {
  const pos = nacelleScreenPos('port') || nacelleScreenPos('starboard');
  if (pos) {
    nacelleOverlay.style.left = pos.x + 'px';
    nacelleOverlay.style.top  = pos.y + 'px';
  }
  nacelleRafId = requestAnimationFrame(tickNacelleOverlay);
}

function showNacelleOverlay() {
  nacelleOverlay.classList.remove('hidden');
  if (!nacelleRafId) nacelleRafId = requestAnimationFrame(tickNacelleOverlay);
}

function hideNacelleOverlay() {
  nacelleOverlay.classList.add('hidden');
  if (nacelleRafId) { cancelAnimationFrame(nacelleRafId); nacelleRafId = null; }
}

function positionTour() {
  const steps = currentSteps();
  const step  = steps[tourIdx];
  if (!step) return;

  /* Switch view if step specifies one */
  if (step.view === 'fleet' && typeof showFleetView === 'function') {
    showFleetView();
  } else if (step.view === 'single' && typeof showSingleView === 'function') {
    showSingleView();
  } else if (step.view === 'twin' && typeof showTwinView === 'function') {
    showTwinView();
  }

  /* text */
  document.getElementById('tour-eyebrow').textContent   = step.eyebrow;
  document.getElementById('tour-tip-title').textContent = step.title;
  document.getElementById('tour-tip-body').innerHTML    = step.body;
  tourDontWrap.classList.toggle('hidden', !step.showDontShow);

  /* button states */
  const isLast      = tourIdx === steps.length - 1;
  const isFirst     = tourIdx === 0 && (tourPhase === 'aircraft' || tourPhase === 'fleet' || tourPhase === 'single');
  const clickEngine = step.type === 'click-engine';
  tourNext.textContent = isLast ? 'Finish' : 'Next \u2192';
  tourNext.classList.toggle('hidden', clickEngine);
  tourBack.classList.toggle('hidden', isFirst);

  /* dots */
  buildDots();
  Array.from(tourDots.children).forEach((d, i) => d.classList.toggle('active', i === tourIdx));

  /* nacelle pulse */
  if (clickEngine) { showNacelleOverlay(); } else { hideNacelleOverlay(); }

  /* placement arrow */
  tourTooltip.className = 'tour-tooltip place-' + step.place;

  if (!step.targetId) {
    /* full-dim, centered tooltip */
    tourScrim.style.position      = 'fixed';
    tourScrim.style.top           = '0';
    tourScrim.style.left          = '0';
    tourScrim.style.width         = '100vw';
    tourScrim.style.height        = '100vh';
    tourScrim.style.borderRadius  = '0';
    tourScrim.style.boxShadow     = 'none';
    tourScrim.style.background    = 'rgba(42,46,51,0.50)';
    tourScrim.style.pointerEvents = 'auto';
    tourTooltip.style.top         = '50%';
    tourTooltip.style.left        = '50%';
    tourTooltip.style.transform   = 'translate(-50%,-50%)';
    return;
  }

  tourScrim.style.background = '';
  tourScrim.style.transform  = '';

  /* Activate required tab if highlighting findings or readings */
  if (step.targetId === 'panel-readings') {
    setInfoTab('readings');
  } else if (step.targetId === 'panel-findings') {
    setInfoTab('findings');
  }

  const target = document.getElementById(step.targetId);
  if (!target) return;

  /* Ensure target is visible before scrolling and measuring */
  if (step.targetId === 'sec-extra-wrap') {
    target.classList.remove('hidden');
    const extraEl = document.getElementById('sec-extra');
    if (!extraEl.innerHTML || !extraEl.textContent.trim()) {
      extraEl.innerHTML = '<div class="finding unknown"><div class="t">Remaining useful life & degradation projection</div><div class="d">Shows live P10\u2013P90 confidence band and degradation rate when a fault is detected or simulated.</div></div>';
    }
  } else if (step.targetId === 'sec-parts') {
    target.classList.remove('hidden');
  } else if (target.classList.contains('hidden')) {
    target.classList.remove('hidden');
  }

  /* Scroll target into view with centering so it's fully visible in sidebar or container */
  if (step.targetId !== 'btn-view-fleet' && step.targetId !== 'btn-view-twin' && step.targetId !== 'btn-view-single') {
    target.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'nearest' });
  }

  const r   = target.getBoundingClientRect();
  const vw  = window.innerWidth;
  const vh  = window.innerHeight;
  const tipW = tourTooltip.offsetWidth || 300;
  const tipH = tourTooltip.offsetHeight || 220;

  const sx = Math.max(0, r.left - PAD);
  const sy = Math.max(0, r.top  - PAD);
  const sw = Math.min(vw - sx, r.width  + PAD * 2);
  const sh = Math.min(vh - sy, r.height + PAD * 2);

  tourScrim.style.position      = 'fixed';
  tourScrim.style.top           = sy + 'px';
  tourScrim.style.left          = sx + 'px';
  tourScrim.style.width         = sw + 'px';
  tourScrim.style.height        = sh + 'px';
  tourScrim.style.borderRadius  = '6px';
  tourScrim.style.boxShadow     = '0 0 0 9999px rgba(42,46,51,0.55)';
  tourScrim.style.pointerEvents = 'none';

  const GAP = 16;
  let tx, ty;
  if (step.place === 'left') {
    tx = Math.max(12, sx - tipW - GAP);
    ty = Math.min(vh - tipH - 12, Math.max(12, sy));
  } else if (step.place === 'right') {
    tx = Math.min(vw - tipW - 12, sx + sw + GAP);
    ty = Math.min(vh - tipH - 12, Math.max(12, sy));
  } else if (step.place === 'below') {
    tx = Math.min(vw - tipW - 12, Math.max(12, sx));
    ty = Math.min(vh - tipH - 12, sy + sh + GAP);
  } else {
    tx = Math.min(vw - tipW - 12, Math.max(12, sx));
    ty = Math.max(12, sy - tipH - GAP);
  }
  tourTooltip.style.transform = '';
  tourTooltip.style.left = tx + 'px';
  tourTooltip.style.top  = ty + 'px';
}

function openTour() {
  if (viewFleet && !viewFleet.classList.contains('hidden')) {
    tourPhase = 'fleet';
  } else if (appMode === 'single') {
    tourPhase = 'single';
  } else {
    showTwinView();
    tourPhase = 'aircraft';
  }
  tourIdx   = 0;
  tourActive = true;
  tourScrim.classList.remove('hidden');
  tourTooltip.classList.remove('hidden');
  positionTour();
}

function closeTour() {
  tourActive = false;
  hideNacelleOverlay();
  tourScrim.classList.add('hidden');
  tourTooltip.classList.add('hidden');
  if (tourPhase === 'aircraft' && appMode !== 'single') {
    showTwinView();
  }
  if (tourDontShow && tourDontShow.checked) {
    try { localStorage.setItem(TOUR_KEY, '1'); } catch (e) { /* private */ }
  }
}

/* Called by openEngine() when the tour is waiting for an engine click */
function tourOnEngineOpen() {
  if (!tourActive) return;
  const step = AIRCRAFT_STEPS[tourIdx];
  if (step && step.type === 'click-engine') {
    /* transition to engine-view tour */
    tourPhase = 'engine';
    tourIdx   = 0;
    positionTour();
  }
}

tourNext.onclick = () => {
  const steps = currentSteps();
  if ((tourPhase === 'fleet' || tourPhase === 'single') && tourIdx === steps.length - 1) {
    if (tourPhase === 'fleet') showTwinView();
    closeTour();
    return;
  }
  if (tourIdx < steps.length - 1) {
    tourIdx += 1;
    positionTour();
  } else {
    closeTour();
  }
};

tourBack.onclick = () => {
  if (tourIdx > 0) {
    tourIdx -= 1;
    positionTour();
    return;
  }
  /* at first engine step — go back to aircraft tour at the click-engine step */
  if (tourPhase === 'engine') {
    backToAircraft();
    showTwinView();
    tourPhase = 'aircraft';
    /* find the click-engine step index */
    tourIdx = AIRCRAFT_STEPS.findIndex(s => s.type === 'click-engine');
    if (tourIdx < 0) tourIdx = AIRCRAFT_STEPS.length - 1;
    positionTour();
  }
};

const btnHelpTop = document.getElementById('btn-help-top');
if (btnHelpTop) {
  btnHelpTop.onclick = openTour;
}

tourSkip.onclick = closeTour;
document.getElementById('btn-help').onclick = () => {
  showTwinView();
  openTour();
};
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && tourActive) closeTour();
  if (e.key === 'ArrowRight' && tourActive) tourNext.click();
  if (e.key === 'ArrowLeft'  && tourActive) tourBack.click();
});
window.addEventListener('resize', () => { if (tourActive) positionTour(); });

if (nacelleOverlay) {
  nacelleOverlay.addEventListener('click', (e) => {
    e.stopPropagation();
    openEngine('port');
  });
}

/* Clear older tour keys so test users get the new tour on enter */
['shadowtwin_tour_seen', 'shadowtwin_tour_seen_v2', 'shadowtwin_tour_seen_v3', 'shadowtwin_tour_seen_v4', 'shadowtwin_tour_seen_v5'].forEach(k => {
  try { localStorage.removeItem(k); } catch (e) { /* private */ }
});

let tourSeen = false;
try { tourSeen = localStorage.getItem(TOUR_KEY) === '1'; } catch (e) { /* private */ }
if (!tourSeen) {
  setTimeout(openTour, 200);
}

paint();
connect();
pingBackend();
setTimeout(startDemo, DEMO_AFTER_MS);
setInterval(updateWakeBanner, 1000);
