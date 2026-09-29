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
controls.addEventListener('start', () => {
  if (typeof onCameraMove === 'function') onCameraMove();
});
controls.addEventListener('change', () => {
  needsRender = true;
  if (typeof onCameraMove === 'function') onCameraMove();
});

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

/* camera animation state for fluid component and view transitions */
let camAnim = null; // { startPos, endPos, startTarget, endTarget, startTime, duration }

function animateCameraTo(targetPos, targetLookAt, duration = 380) {
  if (reduceMotion || duration <= 0) {
    camera.position.copy(targetPos);
    controls.target.copy(targetLookAt);
    controls.update();
    needsRender = true;
    return;
  }
  camAnim = {
    startPos: camera.position.clone(),
    endPos: targetPos.clone(),
    startTarget: controls.target.clone(),
    endTarget: targetLookAt.clone(),
    startTime: performance.now(),
    duration: duration
  };
  needsRender = true;
}

/* render loop: on demand, frame-capped, paused when hidden */
let last = 0;
const interval = 1000 / cfg.fps;
function loop(t) {
  requestAnimationFrame(loop);
  if (document.hidden) return;
  if (t - last < interval) return;
  last = t;
  resize();
  if (camAnim) {
    const now = performance.now();
    const progress = Math.min(1, (now - camAnim.startTime) / camAnim.duration);
    const ease = 0.5 - Math.cos(progress * Math.PI) / 2;
    camera.position.lerpVectors(camAnim.startPos, camAnim.endPos, ease);
    controls.target.lerpVectors(camAnim.startTarget, camAnim.endTarget, ease);
    controls.update();
    needsRender = true;
    if (progress >= 1) camAnim = null;
  } else if (controls.enableDamping) {
    controls.update();
  }
  stepExplode();
  if (needsRender || controls.enableDamping || camAnim) {
    renderer.render(scene, camera);
    positionCallouts();
    positionNacelleLabels();
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
  const isPartFocused = (root === engine && name === focusedPartId);
  node.traverse(o => {
    if (!o.isMesh) return;
    if (!o.userData.matClone) { o.material = o.material.clone(); o.userData.matClone = true; }
    const base = baseMaterial(o);
    if (status && COLOR[status]) {
      o.material.color.copy(base).lerp(COLOR[status], 0.72);
      o.material.emissive = COLOR[status].clone().multiplyScalar(0.06);
    } else if (isPartFocused) {
      o.material.color.copy(base).lerp(new THREE.Color(0.92, 0.78, 0.36), 0.55);
      if (o.material.emissive) o.material.emissive.setRGB(0.20, 0.16, 0.06);
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
  nacelleCenters = null;
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
  const frame = sc.frames[demo.idx];
  if (appMode === 'single' && demo.name === 'sensor') {
    const stbdCopy = JSON.parse(JSON.stringify((frame && frame.engines && frame.engines.starboard) || {}));
    stbdCopy.side = 'port';
    live = Object.assign({}, frame, {
      ts: Date.now() / 1000,
      engines: {
        port: stbdCopy,
        starboard: frame && frame.engines && frame.engines.starboard
      }
    });
  } else {
    live = Object.assign({}, frame, { ts: Date.now() / 1000 });
  }
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
  document.querySelectorAll('.sim-grid button').forEach(b => {
    b.classList.toggle('active', b.dataset.sim === kind && kind !== 'clear');
  });

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
    if (appMode !== 'single') {
      if (kind === 'sensor' && view === 'engine' && selected !== 'starboard') {
        openEngine('starboard');
      } else if (kind === 'injector' && view === 'engine' && selected !== 'port') {
        openEngine('port');
      }
    }
    demoTick();
    return;
  }

  if (appMode === 'single') {
    if (kind === 'injector') { await inject('both', null); await inject('port', 'injector_underflow', 0.8); return; }
    if (kind === 'sensor') { await inject('both', null); await inject('port', 'sensor_stuck'); return; }
    if (kind === 'systemic') { await inject('both', null); await inject('port', 'turbo_underperformance', 0.75); return; }
  } else {
    if (kind === 'injector') {
      if (view === 'engine' && selected !== 'port') openEngine('port');
      await inject('both', null);
      await inject('port', 'injector_underflow', 0.8);
      return;
    }
    if (kind === 'sensor') {
      if (view === 'engine' && selected !== 'starboard') openEngine('starboard');
      await inject('both', null);
      await inject('starboard', 'sensor_stuck');
      return;
    }
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
let focusCalloutEl = null;
let focusedPartId = null;
const _v = new THREE.Vector3();

function updateFocusCallout() {
  if (!focusedPartId || !engine) {
    if (focusCalloutEl) {
      focusCalloutEl.remove();
      focusCalloutEl = null;
    }
    return;
  }
  if (!focusCalloutEl) {
    focusCalloutEl = document.createElement('div');
    focusCalloutEl.className = 'callout focused';
    focusCalloutEl.innerHTML = `<span class="cname"></span><span class="cnote"></span>`;
    labelBox.appendChild(focusCalloutEl);
  }
  const cfg = PART_FOCUS_CONFIG[focusedPartId];
  const name = PART_LABEL[focusedPartId] || focusedPartId;
  const desc = cfg ? '\u2014\u00a0' + cfg.desc : '';
  const nameEl = focusCalloutEl.querySelector('.cname');
  const noteEl = focusCalloutEl.querySelector('.cnote');
  if (nameEl.textContent !== name) nameEl.textContent = name;
  if (noteEl.textContent !== desc) noteEl.textContent = desc;
  needsRender = true;
}

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
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (calloutEls.size) {
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
  if (focusCalloutEl && focusedPartId && engine) {
    const cfg = PART_FOCUS_CONFIG[focusedPartId];
    if (cfg && cfg.target) {
      _v.set(...cfg.target);
    } else {
      const node = engine.getObjectByName(focusedPartId);
      if (node) {
        const box = new THREE.Box3().setFromObject(node);
        box.getCenter(_v);
      }
    }
    _v.project(camera);
    const x = (_v.x * 0.5 + 0.5) * w;
    const y = (-_v.y * 0.5 + 0.5) * h;
    const visible = _v.z < 1 && x > 10 && x < (w - 10) && y > 10 && y < (h - 10);
    focusCalloutEl.style.left = x + 'px';
    focusCalloutEl.style.top = y + 'px';
    focusCalloutEl.classList.toggle('shown', visible);
  }
}

/* --- nacelle engine labels: subtle tags on the aircraft view --- */

let nacelleTagPort = null;
let nacelleTagStbd = null;
let nacelleLabelsVisible = true;
let nacelleRotTimeout = null;
let nacelleCenters = null;

function getNacelleCenters() {
  if (nacelleCenters) return nacelleCenters;
  if (!aircraft) return null;
  const pObj = aircraft.getObjectByName('engine_port');
  const sObj = aircraft.getObjectByName('engine_starboard');
  if (!pObj || !sObj) return null;
  const pBox = new THREE.Box3().setFromObject(pObj);
  const sBox = new THREE.Box3().setFromObject(sObj);
  const pVec = new THREE.Vector3();
  const sVec = new THREE.Vector3();
  pBox.getCenter(pVec);
  sBox.getCenter(sVec);
  nacelleCenters = { port: pVec, starboard: sVec };
  return nacelleCenters;
}

function createNacelleLabels() {
  if (nacelleTagPort) return;
  nacelleTagPort = document.createElement('div');
  nacelleTagPort.className = 'nacelle-label-tag';
  nacelleTagPort.innerHTML = '<span class="nacelle-tag-anchor"></span><span class="nacelle-tag-line"></span><span class="nacelle-tag-text">Engine Left <span class="tag-sub">Port</span></span>';
  labelBox.appendChild(nacelleTagPort);

  nacelleTagStbd = document.createElement('div');
  nacelleTagStbd.className = 'nacelle-label-tag';
  nacelleTagStbd.innerHTML = '<span class="nacelle-tag-anchor"></span><span class="nacelle-tag-line"></span><span class="nacelle-tag-text">Engine Right <span class="tag-sub">Starboard</span></span>';
  labelBox.appendChild(nacelleTagStbd);
}

function hideNacelleLabels() {
  nacelleLabelsVisible = false;
  if (nacelleTagPort) nacelleTagPort.classList.remove('shown');
  if (nacelleTagStbd) nacelleTagStbd.classList.remove('shown');
}

function onCameraMove() {
  if (view === 'aircraft' && appMode === 'twin') {
    hideNacelleLabels();
    if (nacelleRotTimeout) clearTimeout(nacelleRotTimeout);
    nacelleRotTimeout = setTimeout(() => {
      nacelleLabelsVisible = true;
      needsRender = true;
    }, 280);
  }
}

function positionNacelleLabels() {
  /* Only show on aircraft view in twin mode */
  if (view !== 'aircraft' || appMode !== 'twin' || !aircraft) {
    hideNacelleLabels();
    return;
  }
  createNacelleLabels();

  if (!nacelleLabelsVisible) return;

  const centers = getNacelleCenters();
  if (!centers) return;

  /* Position labels from 3D projection of nacelle nodes */
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const sides = [
    { center: centers.port, el: nacelleTagPort },
    { center: centers.starboard, el: nacelleTagStbd }
  ];
  for (const s of sides) {
    if (!s.el) continue;
    const vec = s.center.clone();
    vec.project(camera);
    const x = (vec.x * 0.5 + 0.5) * w;
    const y = (-vec.y * 0.5 + 0.5) * h;
    const onScreen = vec.z < 1 && x > 20 && x < (w - 20) && y > 20 && y < (h - 20);
    s.el.style.left = x + 'px';
    s.el.style.top = y + 'px';
    s.el.classList.toggle('shown', onScreen && nacelleLabelsVisible);
  }
}



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
    if (appMode === 'single') {
      const port = live.engines.port;
      const pst = port ? port.status : 'not_evaluated';
      if (pst === 'fault') {
        cls = 'fault';
        label = 'NO-GO \u00b7 ABORT SORTIE';
        reason = (port.headline || 'Single engine fault') + ' \u2014 zero redundancy (critical SPOF)';
      } else if (pst === 'caution' || pst === 'anomaly_unclassified') {
        cls = 'caution';
        label = 'CAUTION \u00b7 SPOF ALERT';
        reason = (port.headline || 'Telemetry anomaly') + ' \u2014 single powerplant (no engine-out margin)';
      } else if (pst === 'not_evaluated') {
        cls = 'unknown';
        label = 'EVALUATING';
        reason = 'Collecting baseline on primary engine';
      } else {
        const pconf = port ? port.confidence : null;
        if (pconf !== null && pconf >= 0.8) {
          cls = 'nominal';
          label = 'GO \u00b7 SINGLE PROPULSION';
          reason = 'Primary 2.2L aero-diesel nominal across all 9 channels';
        } else {
          cls = 'caution';
          label = 'CAUTION';
          reason = 'Confidence below threshold';
        }
      }
      for (const c of ['nominal', 'caution', 'fault', 'unknown'])
        el.classList.toggle(c, c === cls);
      statusEl.textContent = label;
      reasonEl.textContent = reason;
      return;
    }

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
    const isFoc = (id === focusedPartId) ? ' focused' : '';
    return `<button class="part${cls}${isFoc}" data-part="${id}">
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
  focusedPartId = null;
  updateFocusCallout();
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
  const hudInfo = document.getElementById('hud-platform-info');
  if (hudInfo && appMode !== 'single') hudInfo.textContent = 'ADE TAPAS-BH-201 \u00b7 ' + SIDE_NAME[side] + ' Nacelle Unit';
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
  focusedPartId = null;
  updateFocusCallout();
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
  const hudInfo = document.getElementById('hud-platform-info');
  if (hudInfo && appMode !== 'single') hudInfo.textContent = 'ADE TAPAS-BH-201 \u00b7 Wing-Mounted Twin Turbodiesels';
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

const PART_FOCUS_CONFIG = {
  injector_1: {
    target: [-0.345, 0.845, 0.162],
    camOffset: [0.0, 0.22, 0.28],
    desc: 'Bosch 1,800 bar Piezo Injector #1'
  },
  injector_2: {
    target: [-0.13, 0.845, 0.161],
    camOffset: [0.0, 0.22, 0.28],
    desc: 'Bosch 1,800 bar Piezo Injector #2'
  },
  injector_3: {
    target: [0.085, 0.845, 0.162],
    camOffset: [0.0, 0.22, 0.28],
    desc: 'Bosch 1,800 bar Piezo Injector #3'
  },
  injector_4: {
    target: [0.3, 0.845, 0.162],
    camOffset: [0.0, 0.22, 0.28],
    desc: 'Bosch 1,800 bar Piezo Injector #4'
  },
  common_rail: {
    target: [-0.112, 0.634, 0.28],
    camOffset: [-0.08, 0.24, 0.44],
    desc: '1,800 bar High-Pressure Accumulator Rail'
  },
  turbocharger: {
    target: [0.375, 0.897, 0.074],
    camOffset: [0.30, 0.20, 0.26],
    desc: 'Variable-Geometry Turbine (VGT) & Compressor'
  },
  intake: {
    target: [-0.118, 0.752, 0.508],
    camOffset: [-0.05, 0.22, 0.40],
    desc: 'Charge Air Intake Manifold & MAP Sensor'
  },
  exhaust: {
    target: [-0.027, 0.79, -0.243],
    camOffset: [-0.05, 0.24, -0.44],
    desc: 'Inconel Exhaust Runner Log to Turbine'
  },
  cylinder_head: {
    target: [-0.02, 0.76, 0.128],
    camOffset: [0.0, 0.38, 0.36],
    desc: '4-Valve Per Cylinder Crossflow Head'
  },
  cooling: {
    target: [0.283, 0.574, -0.19],
    camOffset: [0.28, 0.20, -0.30],
    desc: 'Liquid Cooling Rail, Jacket & Thermostat'
  },
  lubrication: {
    target: [-0.004, 0.379, -0.052],
    camOffset: [-0.22, 0.18, 0.40],
    desc: 'Dry-Sump Scavenge & Pressure Pump'
  },
  controller: {
    target: [-0.447, 0.301, 0.354],
    camOffset: [-0.28, 0.16, 0.18],
    desc: 'Engine ECU & CAN Sensor Signal Interface'
  },
  crankcase: {
    target: [0.11, 0.31, -0.033],
    camOffset: [0.32, 0.22, 0.42],
    desc: 'High-Strength Cast Crankcase & Girdle'
  },
  engine_body: {
    target: [0.139, 0.402, -0.009],
    camOffset: [0.40, 0.30, 0.60],
    desc: '2.2L Aero-Diesel Powerplant Core'
  }
};

function focusPart(partId) {
  if (!engine) return;
  const node = engine.getObjectByName(partId);
  if (!node) return;

  // Toggle off if clicking the already focused part
  if (focusedPartId === partId) {
    focusedPartId = null;
    updateFocusCallout();
    const r = live && live.engines && live.engines[selected];
    const flags = (r && r.parts) || {};
    for (const id of PART_KEYS) {
      tintPart(engine, id, flags[id] || null);
    }
    frame(engine, 1.25);
    paintDetail();
    return;
  }

  focusedPartId = partId;
  updateFocusCallout();

  const cfg = PART_FOCUS_CONFIG[partId];
  let targetCenter, camPos;

  if (cfg) {
    targetCenter = new THREE.Vector3(...cfg.target);
    camPos = targetCenter.clone().add(new THREE.Vector3(...cfg.camOffset));
  } else {
    const box = new THREE.Box3().setFromObject(node);
    targetCenter = box.getCenter(new THREE.Vector3());
    camPos = targetCenter.clone().add(new THREE.Vector3(0.3, 0.25, 0.45));
  }

  controls.minDistance = 0.15;
  controls.maxDistance = 4.0;
  camera.near = 0.02;
  camera.far = 20.0;
  camera.updateProjectionMatrix();

  animateCameraTo(camPos, targetCenter, 380);

  // Apply tint so the focused part lights up and stays lit
  const r = live && live.engines && live.engines[selected];
  const flags = (r && r.parts) || {};
  for (const id of PART_KEYS) {
    tintPart(engine, id, flags[id] || null);
  }

  // Update button class in UI
  document.querySelectorAll('#parts .part').forEach(btn => {
    btn.classList.toggle('focused', btn.dataset.part === partId);
  });

  needsRender = true;
}

document.getElementById('parts').addEventListener('click', e => {
  const b = e.target.closest('[data-part]');
  if (!b || !engine) return;
  focusPart(b.dataset.part);
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

  // Platform HUD for Twin Engine
  const topPlatform = document.getElementById('top-nav-platform');
  if (topPlatform) topPlatform.textContent = 'TAPAS-BH-201 MALE UAV (Twin-Engine)';
  const hudTag = document.getElementById('hud-platform-tag');
  if (hudTag) {
    hudTag.textContent = 'TWIN-PROPULSION MALE UAV';
    hudTag.className = 'hud-pill';
  }
  const hudInfo = document.getElementById('hud-platform-info');
  if (hudInfo) hudInfo.textContent = 'ADE TAPAS-BH-201 \u00b7 Wing-Mounted Twin Turbodiesels';
  const badgeBus = document.getElementById('badge-bus');
  if (badgeBus) {
    badgeBus.textContent = 'CAN: Dual-Node J1939';
    badgeBus.className = 'badge-item';
  }
  const badgeRedun = document.getElementById('badge-redun');
  if (badgeRedun) {
    badgeRedun.textContent = 'Asymmetric Engine-Out Active';
    badgeRedun.className = 'badge-item';
  }
  const archCard = document.getElementById('entry-architecture');
  if (archCard) archCard.classList.add('hidden');

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
  updateMissionBanner();
  updateMissionMargin();
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

  // Platform HUD for Single Engine
  const topPlatform = document.getElementById('top-nav-platform');
  if (topPlatform) topPlatform.textContent = 'RUSTOM-I Tactical UAV (Single-Engine)';
  const hudTag = document.getElementById('hud-platform-tag');
  if (hudTag) {
    hudTag.textContent = 'TACTICAL SINGLE-PROPULSION UAV';
    hudTag.className = 'hud-pill tactical';
  }
  const hudInfo = document.getElementById('hud-platform-info');
  if (hudInfo) hudInfo.textContent = 'ADE Rustom-I / Archer Class \u00b7 Fuselage Centerline 2.2L Turbodiesel';
  const badgeBus = document.getElementById('badge-bus');
  if (badgeBus) {
    badgeBus.textContent = 'CAN: Simplex J1939 (ECU-1)';
    badgeBus.className = 'badge-item';
  }
  const badgeRedun = document.getElementById('badge-redun');
  if (badgeRedun) {
    badgeRedun.textContent = 'SPOF: Zero Engine-Out Recovery';
    badgeRedun.className = 'badge-item alert';
  }
  const archCard = document.getElementById('entry-architecture');
  if (archCard) archCard.classList.remove('hidden');

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
  if (lOut) lOut.textContent = 'Engine-out (N/A \u2014 SPOF)';

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

  updateMissionBanner();
  updateMissionMargin();
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

  const topPlatform = document.getElementById('top-nav-platform');
  if (topPlatform) topPlatform.textContent = 'Squadron Propulsion Command (4 UAVs)';

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

const TOUR_KEY = 'shadowtwin_tour_seen_v10';

/* ---- Aircraft-view steps (Twin-engine MALE airframe) ---- */
const AIRCRAFT_STEPS = [
  {
    targetId: null,
    place: 'center',
    eyebrow: 'Shadow Twin — Guided Walkthrough',
    title: 'Digital Twin for Twin-Engine MALE UAVs',
    body: 'Welcome to Shadow Twin (DRDO SIH 26054). This system runs a real-time physics model side-by-side with incoming CAN bus telemetry to detect propulsion anomalies, isolate sensor faults, and predict remaining useful life before faults become critical.',
    showDontShow: false,
    type: 'normal',
    view: 'twin'
  },
  {
    targetId: 'viewport',
    place: 'stage-card',
    eyebrow: 'Aircraft Step 1 of 4 — 3D Airframe',
    title: 'TAPAS-BH-201 3D Airframe',
    body: '<strong>Drag</strong> to orbit, <strong>scroll</strong> to zoom. The twin wing-mounted nacelles house the 2.2\u202fL turbo-diesel aero powerplants. Each engine operates an independent CAN ECU with cross-engine AI correlation.',
    showDontShow: false,
    type: 'normal',
    view: 'twin'
  },
  {
    targetId: 'top-nav-switcher',
    place: 'below',
    eyebrow: 'Aircraft Step 2 of 4 — Multi-UAV Switching',
    title: 'Twin, Single & Squadron Fleet Command',
    body: 'Use this top switcher to toggle between <strong>TAPAS-01 Twin-Engine UAV</strong>, <strong>RUSTOM-01 Single-Engine Tactical UAV</strong>, and the <strong>Squadron Fleet Command</strong> monitoring 4 airframes simultaneously.',
    showDontShow: false,
    type: 'normal',
    view: 'twin'
  },
  {
    targetId: 'mission-banner',
    place: 'left',
    eyebrow: 'Aircraft Step 3 of 4 — Operational Readiness',
    title: 'Mission Go / Caution / No-Go & Margins',
    body: 'The <strong>GO / CAUTION / NO-GO</strong> banner combines propulsion health across both engines into a single operational call. Below it, <strong>Hours pair margin</strong> and <strong>Engine-out margin</strong> update in real time.',
    showDontShow: false,
    type: 'normal',
    view: 'twin'
  },
  {
    targetId: 'viewport',
    place: 'stage-card',
    eyebrow: 'Aircraft Step 4 of 4 — Deep Engine Inspection',
    title: 'Inspect Inside 3D Powerplant',
    body: 'Pulsing rings highlight the twin nacelles. <strong>Click either engine nacelle</strong> in 3D or click <strong>Inspect Engine →</strong> below to fly inside the 3D powerplant and inspect internal component diagnostics!',
    showDontShow: false,
    type: 'click-engine',
    view: 'twin'
  }
];

/* ---- Engine-view steps (Internal diagnostics & physics residuals) ---- */
const ENGINE_STEPS = [
  {
    targetId: 'viewport',
    place: 'stage-card',
    eyebrow: 'Engine Step 1 of 5 — 3D Internals',
    title: 'Inside the 2.2L Aero-Diesel Powerplant',
    body: 'You are now inside the 3D engine model. Flagged components highlight in <strong>brick-red for fault</strong> or <strong>amber for caution</strong>, and automatically pop out in 3D exploded view with diagnostic callouts.',
    showDontShow: false,
    type: 'normal'
  },
  {
    targetId: 'stage-infobar',
    place: 'right',
    eyebrow: 'Engine Step 2 of 5 — Telemetry vs Physics',
    title: 'Mean Value Engine Model (MVEM)',
    body: 'Every sensor channel displays its <strong>measured telemetry</strong> alongside what the healthy physics model expected at this operating point. The residual delta separates engine degradation from flight condition changes.',
    showDontShow: false,
    type: 'normal'
  },
  {
    targetId: 'stage-infobar',
    place: 'right',
    eyebrow: 'Engine Step 3 of 5 — AI Root Cause Isolation',
    title: 'Findings & Sensor Trust Gateway',
    body: 'The AI isolation forest and robust classifier name the fault in plain language with confidence percentages. The Sensor Trust Gateway strictly isolates faulty sensors so sensor issues are never confused with engine faults.',
    showDontShow: false,
    type: 'normal'
  },
  {
    targetId: 'sec-parts',
    place: 'left',
    eyebrow: 'Engine Step 4 of 5 — Component Diagnostics',
    title: 'Interactive 3D Component Focus',
    body: 'Click any component in this list \u2014 <strong>Turbocharger</strong>, <strong>Common Rail</strong>, <strong>Injectors</strong>, <strong>Exhaust</strong>, or <strong>Controller</strong> \u2014 to automatically pivot and zoom the 3D camera right onto that part with dedicated 3D pin callouts!',
    showDontShow: false,
    type: 'normal'
  },
  {
    targetId: 'sec-simulate',
    place: 'left',
    eyebrow: 'Engine Step 5 of 5 — Fault Injection',
    title: 'Simulate degradation & stress test',
    body: 'Click <strong>Injector fault</strong>, <strong>Sensor fault</strong>, or <strong>Both engines drift</strong> to see 3D components pop out and detection react in seconds. Click <strong>Next</strong> to inspect the single-engine tactical UAV!',
    showDontShow: false,
    type: 'normal'
  }
];

/* ---- Single-engine-view steps (Tactical single-engine standalone twin) ---- */
const SINGLE_STEPS = [
  {
    targetId: 'viewport',
    place: 'stage-card',
    eyebrow: 'Single-Engine Step 1 of 5 — Standalone Twin',
    title: 'RUSTOM-01 Tactical Powerplant Twin',
    body: 'This platform directly monitors a single-engine tactical UAV powerplant in 3D mounted on an engineering test stand. All CAN telemetry and physics models connect to this primary 2.2L aero-diesel unit without requiring the aircraft airframe.',
    showDontShow: false,
    type: 'normal',
    view: 'single'
  },
  {
    targetId: 'entry-architecture',
    place: 'left',
    eyebrow: 'Single-Engine Step 2 of 5 — Tactical Architecture',
    title: 'Tactical Propulsion Topology & Simplex CAN',
    body: '<strong>Critical SPOF Architecture:</strong> Unlike twin-engine UAVs with asymmetric engine-out margins, single-engine tactical UAVs have <strong>zero engine-out redundancy</strong>. Sensor channels stream over a Simplex J1939 CAN bus link (ECU-1 Node @ 0x18FF0101). Any unrecoverable telemetry divergence triggers an immediate abort protocol (forced glide or parachute recovery).',
    showDontShow: false,
    type: 'normal',
    view: 'single'
  },
  {
    targetId: 'stage-infobar',
    place: 'right',
    eyebrow: 'Single-Engine Step 3 of 5 — Telemetry & Physics',
    title: 'Simplex CAN Bus Ingestion & MVEM Delta',
    body: 'Incoming simplex CAN frames are continuously compared against the healthy Mean Value Engine Model to isolate sensor drift from real thermodynamic degradation.',
    showDontShow: false,
    type: 'normal',
    view: 'single'
  },
  {
    targetId: 'sec-parts',
    place: 'left',
    eyebrow: 'Single-Engine Step 4 of 5 — Component Diagnostics',
    title: 'Interactive 3D Component Diagnostics',
    body: 'Click any component in this list (Turbocharger, Common Rail, Injectors, Controller) to smoothly pivot the 3D camera and highlight internal components with diagnostic callout pins.',
    showDontShow: false,
    type: 'normal',
    view: 'single'
  },
  {
    targetId: 'btn-view-fleet',
    place: 'below',
    eyebrow: 'Single-Engine Step 5 of 5 — Fleet Command',
    title: 'Explore Squadron Fleet Command',
    body: 'Click <strong>Next</strong> to explore the Squadron Fleet Command dashboard, monitoring multiple twin and single-engine tactical UAVs across the fleet simultaneously.',
    showDontShow: false,
    type: 'normal',
    view: 'single'
  }
];

/* ---- Fleet-view steps (Squadron fleet command) ---- */
const FLEET_STEPS = [
  {
    targetId: null,
    place: 'center',
    eyebrow: 'Fleet Command Step 1 of 5 — Squadron Overview',
    title: 'Squadron Propulsion Fleet Command',
    body: 'This dashboard provides fleet-level health monitoring and predictive maintenance across multiple MALE & tactical UAVs, directly fulfilling the DRDO SIH 26054 multi-aircraft requirement.',
    showDontShow: false,
    type: 'normal',
    view: 'fleet'
  },
  {
    targetId: 'fleet-card-1',
    place: 'right',
    eyebrow: 'Fleet Command Step 2 of 5 — Twin-Engine UAVs',
    title: 'TAPAS-01 (Bravo-01) Live Digital Twin',
    body: 'Connected to the live dual-node CAN bus feed with real-time physics residuals and asymmetric engine-out margins.',
    showDontShow: false,
    type: 'normal',
    view: 'fleet'
  },
  {
    targetId: 'fleet-card-2',
    place: 'left',
    eyebrow: 'Fleet Command Step 3 of 5 — Single-Engine UAVs',
    title: 'Single-Engine Tactical UAV Differentiation',
    body: 'Single-engine airframes are clearly separated in their own dedicated section with SPOF safety protocols and a highlighted <strong>Inspect Single-Engine UAV →</strong> button to launch the standalone powerplant twin.',
    showDontShow: false,
    type: 'normal',
    view: 'fleet'
  },
  {
    targetId: 'fleet-card-3',
    place: 'left',
    eyebrow: 'Fleet Command Step 4 of 5 — Anomaly Tracking',
    title: 'Automated Fleet Anomaly Detection',
    body: 'When any aircraft in the squadron begins to degrade, it is immediately flagged with root-cause advisories (such as TAPAS-03’s Starboard EGT drift and injector variance) before flight safety is compromised.',
    showDontShow: false,
    type: 'normal',
    view: 'fleet'
  },
  {
    targetId: 'btn-view-twin',
    place: 'below',
    eyebrow: 'Fleet Command Step 5 of 5 — Tour Complete',
    title: 'Return to 3D Digital Twin',
    body: 'Click <strong>Finish</strong> or <strong>TAPAS-01 Live Twin</strong> to return to the interactive 3D airframe, physics residual charts, and component-level diagnostics.',
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
const nacelleOverlayPort = document.getElementById('tour-nacelle-pulse-port');
const nacelleOverlayStbd = document.getElementById('tour-nacelle-pulse-stbd');

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
  const centers = getNacelleCenters();
  if (!centers || !centers[side]) return null;
  const vec = centers[side].clone();
  vec.project(camera);
  const r = canvas.getBoundingClientRect();
  return {
    x: r.left + ((vec.x + 1) / 2) * r.width,
    y: r.top  + ((-vec.y + 1) / 2) * r.height
  };
}

/* Animate nacelle rings tracking the 3D objects */
function tickNacelleOverlay() {
  const posPort = nacelleScreenPos('port');
  if (posPort && nacelleOverlayPort) {
    nacelleOverlayPort.style.left = posPort.x + 'px';
    nacelleOverlayPort.style.top  = posPort.y + 'px';
  }
  const posStbd = nacelleScreenPos('starboard');
  if (posStbd && nacelleOverlayStbd) {
    nacelleOverlayStbd.style.left = posStbd.x + 'px';
    nacelleOverlayStbd.style.top  = posStbd.y + 'px';
  }
  nacelleRafId = requestAnimationFrame(tickNacelleOverlay);
}

function showNacelleOverlay() {
  if (nacelleOverlayPort) nacelleOverlayPort.classList.remove('hidden');
  if (nacelleOverlayStbd) nacelleOverlayStbd.classList.remove('hidden');
  if (!nacelleRafId) nacelleRafId = requestAnimationFrame(tickNacelleOverlay);
}

function hideNacelleOverlay() {
  if (nacelleOverlayPort) nacelleOverlayPort.classList.add('hidden');
  if (nacelleOverlayStbd) nacelleOverlayStbd.classList.add('hidden');
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

  /* button states across the unified 4-phase walkthrough */
  const isOverallFirst = (tourPhase === 'aircraft' && tourIdx === 0);
  const isOverallLast  = (tourPhase === 'fleet' && tourIdx === steps.length - 1);
  const clickEngine    = step.type === 'click-engine';

  if (clickEngine) {
    tourNext.textContent = 'Inspect Engine \u2192';
    tourNext.classList.remove('hidden');
  } else if (tourPhase === 'aircraft' && tourIdx === steps.length - 1) {
    tourNext.textContent = 'Next: Engine Internals \u2192';
    tourNext.classList.remove('hidden');
  } else if (tourPhase === 'engine' && tourIdx === steps.length - 1) {
    tourNext.textContent = 'Next: Single-Engine UAV \u2192';
    tourNext.classList.remove('hidden');
  } else if (tourPhase === 'single' && tourIdx === steps.length - 1) {
    tourNext.textContent = 'Next: Fleet Command \u2192';
    tourNext.classList.remove('hidden');
  } else if (isOverallLast) {
    tourNext.textContent = 'Finish';
    tourNext.classList.remove('hidden');
  } else {
    tourNext.textContent = 'Next \u2192';
    tourNext.classList.remove('hidden');
  }

  tourBack.classList.toggle('hidden', isOverallFirst);

  /* dots */
  buildDots();
  Array.from(tourDots.children).forEach((d, i) => d.classList.toggle('active', i === tourIdx));

  /* nacelle pulse */
  if (clickEngine) { showNacelleOverlay(); } else { hideNacelleOverlay(); }

  // 1. Center card (no target)
  if (!step.targetId) {
    tourScrim.style.position      = 'fixed';
    tourScrim.style.top           = '0';
    tourScrim.style.left          = '0';
    tourScrim.style.width         = '100vw';
    tourScrim.style.height        = '100vh';
    tourScrim.style.borderRadius  = '0';
    tourScrim.style.boxShadow     = 'none';
    tourScrim.style.background    = 'rgba(42,46,51,0.50)';
    tourScrim.style.pointerEvents = 'auto';
    tourTooltip.className         = 'tour-tooltip place-center';
    tourTooltip.style.top         = '50%';
    tourTooltip.style.left        = '50%';
    tourTooltip.style.transform   = 'translate(-50%,-50%)';
    return;
  }

  tourScrim.style.background = '';
  tourScrim.style.transform  = '';

  /* Activate required tab if highlighting findings or readings */
  if (step.targetId === 'panel-readings' || (step.targetId === 'stage-infobar' && step.title.includes('Mean Value')) || (step.targetId === 'stage-infobar' && step.title.includes('CAN Bus'))) {
    setInfoTab('readings');
  } else if (step.targetId === 'panel-findings' || (step.targetId === 'stage-infobar' && step.title.includes('Findings'))) {
    setInfoTab('findings');
  }

  const target = document.getElementById(step.targetId);
  if (!target) return;

  /* Ensure target is visible */
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

  /* Internal scrolling ONLY inside scroll containers (NEVER window) */
  const sideEl = document.querySelector('.side');
  if (sideEl && sideEl.contains(target)) {
    const sideRect = sideEl.getBoundingClientRect();
    const elemRect = target.getBoundingClientRect();
    if (elemRect.top < sideRect.top + 20 || elemRect.bottom > sideRect.bottom - 20) {
      const scrollOffset = (elemRect.top + elemRect.height / 2) - (sideRect.top + sideRect.height / 2);
      sideEl.scrollBy({ top: scrollOffset, behavior: 'auto' });
    }
  }
  const fleetEl = document.querySelector('.fleet-view');
  if (fleetEl && fleetEl.contains(target)) {
    const fleetRect = fleetEl.getBoundingClientRect();
    const elemRect = target.getBoundingClientRect();
    if (elemRect.top < fleetRect.top + 20 || elemRect.bottom > fleetRect.bottom - 20) {
      const scrollOffset = (elemRect.top + elemRect.height / 2) - (fleetRect.top + fleetRect.height / 2);
      fleetEl.scrollBy({ top: scrollOffset, behavior: 'auto' });
    }
  }

  const r    = target.getBoundingClientRect();
  const vw   = window.innerWidth;
  const vh   = window.innerHeight;
  const tipW = tourTooltip.offsetWidth || 320;
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

  tourTooltip.className = 'tour-tooltip place-' + step.place;

  const GAP = 14;
  let tx, ty, arrowPos;
  const targetCenterY = r.top + r.height / 2;
  const targetCenterX = r.left + r.width / 2;

  if (step.place === 'stage-card') {
    tx = r.left + 28;
    ty = r.top + 110;
    tourTooltip.style.setProperty('--arrow-pos', '0px');
  } else if (step.place === 'left') {
    tx = Math.max(12, sx - tipW - GAP);
    ty = Math.max(54, Math.min(vh - tipH - 16, targetCenterY - tipH / 2));
    arrowPos = Math.max(16, Math.min(tipH - 16, targetCenterY - ty));
    tourTooltip.style.setProperty('--arrow-pos', arrowPos + 'px');
  } else if (step.place === 'right') {
    tx = Math.min(vw - tipW - 12, sx + sw + GAP);
    ty = Math.max(54, Math.min(vh - tipH - 16, targetCenterY - tipH / 2));
    arrowPos = Math.max(16, Math.min(tipH - 16, targetCenterY - ty));
    tourTooltip.style.setProperty('--arrow-pos', arrowPos + 'px');
  } else if (step.place === 'below') {
    tx = Math.max(12, Math.min(vw - tipW - 12, targetCenterX - tipW / 2));
    ty = Math.min(vh - tipH - 16, sy + sh + GAP);
    arrowPos = Math.max(16, Math.min(tipW - 16, targetCenterX - tx));
    tourTooltip.style.setProperty('--arrow-pos', arrowPos + 'px');
  } else {
    // 'above'
    tx = Math.max(12, Math.min(vw - tipW - 12, targetCenterX - tipW / 2));
    ty = Math.max(54, sy - tipH - GAP);
    arrowPos = Math.max(16, Math.min(tipW - 16, targetCenterX - tx));
    tourTooltip.style.setProperty('--arrow-pos', arrowPos + 'px');
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
  const step  = steps[tourIdx];

  /* If on the click-engine step (Aircraft step 4) */
  if (step && step.type === 'click-engine') {
    openEngine('port');
    tourPhase = 'engine';
    tourIdx   = 0;
    positionTour();
    return;
  }

  /* Advance within current phase */
  if (tourIdx < steps.length - 1) {
    tourIdx += 1;
    positionTour();
    return;
  }

  /* Transition between phases at the end of each stage */
  if (tourPhase === 'aircraft') {
    openEngine('port');
    tourPhase = 'engine';
    tourIdx   = 0;
    positionTour();
  } else if (tourPhase === 'engine') {
    showSingleView();
    tourPhase = 'single';
    tourIdx   = 0;
    positionTour();
  } else if (tourPhase === 'single') {
    showFleetView();
    tourPhase = 'fleet';
    tourIdx   = 0;
    positionTour();
  } else if (tourPhase === 'fleet') {
    showTwinView();
    closeTour();
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
  /* At step 0 of a phase — navigate back to previous phase */
  if (tourPhase === 'fleet') {
    showSingleView();
    tourPhase = 'single';
    tourIdx   = SINGLE_STEPS.length - 1;
    positionTour();
  } else if (tourPhase === 'single') {
    showTwinView();
    openEngine('port');
    tourPhase = 'engine';
    tourIdx   = ENGINE_STEPS.length - 1;
    positionTour();
  } else if (tourPhase === 'engine') {
    backToAircraft();
    showTwinView();
    tourPhase = 'aircraft';
    tourIdx   = AIRCRAFT_STEPS.length - 1;
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

if (nacelleOverlayPort) {
  nacelleOverlayPort.addEventListener('click', (e) => {
    e.stopPropagation();
    openEngine('port');
  });
}
if (nacelleOverlayStbd) {
  nacelleOverlayStbd.addEventListener('click', (e) => {
    e.stopPropagation();
    openEngine('starboard');
  });
}

/* Clear older tour keys so test users get the new tour on enter */
['shadowtwin_tour_seen', 'shadowtwin_tour_seen_v2', 'shadowtwin_tour_seen_v3', 'shadowtwin_tour_seen_v4', 'shadowtwin_tour_seen_v5', 'shadowtwin_tour_seen_v6', 'shadowtwin_tour_seen_v7', 'shadowtwin_tour_seen_v8', 'shadowtwin_tour_seen_v9'].forEach(k => {
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
