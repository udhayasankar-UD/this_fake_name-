# AGENTS.md — shadow-twin project context for AI coding agents

Read this fully before changing anything. It encodes decisions that took real
debugging to arrive at; several "obvious improvements" here are regressions.

---

## 1. What this is

A digital twin for the **twin aero-diesel powerplant of a MALE UAV** (DRDO SIH
problem statement 26054). It ingests engine telemetry over CAN, predicts what a
healthy engine should be reading at the current operating point using a physics
model, and drives anomaly detection, fault classification, remaining useful life
and cross-engine correlation off the difference between the two.

**Target platform:** TAPAS-BH-201 (Rustom-II), a genuine twin wing-mounted engine
aircraft. The reference engine is a 2.2 L 4-cylinder turbocharged common-rail
aero-diesel with a reduction gearbox — the class that powers this platform's real
lineage (Austro AE300 → indigenous VRDE-JAYEM 180 hp). The 3d model is a
*representative* model of that engine class, **not** a CAD reproduction of any
named production engine. Do not claim otherwise in code comments, UI text or docs.

### The governing design principle

> **The system states how sure it is, and refuses to score health when the basis is
> too thin, rather than showing a confident green.**

Every change must preserve this. Concretely:

- A health call carries a confidence number, or explicitly reports
  `not_evaluated` with a reason.
- A sensor problem is **never** reported as an engine problem, and vice versa.
- Validation output includes the severity levels where detection **fails**.
- No metric is presented as field-validated. Faults are seeded, not observed.

If a requested change would make the system sound more confident than its evidence
supports, say so before implementing it.

---

## 2. Repository map

```
frontend/               # Deployed to Vercel (static web app)
  index.html            dashboard shell. NO inline <script>, NO inline style=
  app.js                three.js viewer, websocket & REST client, exploded view, callouts
  config.js             backend endpoint configuration (window.SHADOWTWIN_BACKEND_URL)
  styles.css            design system + all styling
  vercel.json           Vercel config: pinned CSP (Render domain only) + model caching
  vendor/               three.js r160 vendored (runs with zero internet)
    three/three.module.js
    addons/loaders/GLTFLoader.js
    addons/controls/OrbitControls.js
    addons/utils/BufferGeometryUtils.js
  models/
    tapas.glb           airframe, 3 objects, 14,874 tris, 0.5 MB
    engine.glb          engine, 14 objects, 30,831 tris, 5.1 MB  (high tier)
    engine_low.glb      engine, 14 objects, 14,763 tris, 4.4 MB  (low/mid tier)
backend/                # Deployed to Render (FastAPI web service)
  mvem.py               mean value engine model (the physics core)
  dbc/engine.dbc        8 CAN messages, J1939 PGNs
  can_bus.py            CAN encode/decode, socketcan or python-can virtual
  trust.py              sensor trust gateway
  detect.py             anomaly detection, fault classifier, RUL
  twin.py               per-engine orchestration, confidence gate, correlation
  server.py             simulated ECUs, FastAPI, websocket, CORS, static hosting
  train.py              generates training data from physics, fits detectors
  evaluate.py           severity sweep — reports where detection breaks
  models.pkl            trained detector (regenerate with train.py)
  requirements.txt      pinned scikit-learn==1.8.0
  render.yaml           Render deployment configuration
server.py               Root convenience proxy (subprocess chdir into backend)
main.py                 Root convenience entrypoint
vercel.json             Root Vercel deployment redirect (outputDirectory: frontend)
render.yaml             Root Render deployment blueprint (rootDir: backend)
```

Run backend locally: `cd backend && pip install -r requirements.txt && python train.py && python server.py`
→ http://localhost:8000

Or from repo root: `python server.py`
Open frontend directly at http://localhost:8000 (backend serves frontend when present locally).

Real bus instead of simulated ECUs: `SHADOWTWIN_CAN=vcan0 python server.py`.
Nothing downstream of the decoder changes.

---

## 3. Pipeline — order matters

```
simulated ECU (server.py)
   ↓ encodes real 8-byte CAN frames against dbc/engine.dbc
CAN bus (can_bus.py)           socketcan if available, python-can virtual otherwise
   ↓ decode
mean value engine model (mvem.py)     "what should a healthy engine read here?"
   ↓
residual = measured − expected
   ↓
sensor trust gateway (trust.py)       range, frozen, rate, corroboration, envelope
   ↓ (only trusted channels continue)
detection (detect.py)                 robust z ∪ isolation forest, then classifier
   ↓
confidence gate (twin.py)             refuse to score if basis too thin
   ↓
RUL + cross-engine correlation (twin.py)
   ↓
websocket → dashboard (app.js)
```

**Why residuals rather than raw telemetry:** a model fed raw sensor values must
learn every operating condition *and* every fault, and never sees enough data for
both. High CHT means something completely different in a hot-day climb than in a
cold cruise. The physics model divides the operating point out first.

**The simulator is walled off behind the CAN encoder.** It produces frames and
nothing else. Never let simulator state reach the twin by any other path — that
boundary is what makes this portable to a real test cell.

---

## 4. Data contract (websocket `/ws`, and `GET /api/state`)

```jsonc
{
  "ts": 1789760000.0,
  "condition": { "throttle": 0.66, "altitude_m": 4200.0, "oat_c": 12.0,
                 "mission_hours": 14.0 },
  "engines": {
    "port": {
      "side": "port",
      "status": "nominal" | "caution" | "fault" | "anomaly_unclassified" | "not_evaluated",
      "confidence": 0.0-1.0 | null,        // null ONLY when not_evaluated
      "headline": "Injector delivery shortfall",
      "detail": "Driven mainly by vibration level (227σ), ...",
      "fault": "injector_underflow",        // absent when nominal
      "severity": 0.0-1.0,
      "measured":  { "rpm": 2118, "cht_c": 166.2, ... },
      "expected":  { "rpm": 2121, "cht_c": 165.1, ... },
      "residual":  { "rpm": -3.0, "cht_c": 1.1, ... },
      "trust":     { "cht_c": {"status":"trusted"|"suspect"|"quarantined",
                               "reason": str|null, "score": 0.0-1.0 }, ... },
      "trust_summary": { "quarantined": [], "suspect": [], "coverage": 1.0 },
      "instrumentation": [ { "channel","pretty","status","reason",
                             "headline","detail" } ],
      "parts": { "injector_3": "fault", "common_rail": "caution" },
      "evidence": [ { "feature": "vibration_mms level", "z": 227.0,
                      "weight": 0.61 } ],
      "probabilities": { "injector_underflow": 0.97, ... },
      "rul": { "hours": 782.0, "p10": 770.0, "p90": 795.0,
               "rate_per_hour": -0.0001, "basis": "..." } | null,
      "hours_run": 418.0
    },
    "starboard": { ... }
  },
  "correlation": { "kind": "shared_cause" | "independent",
                   "similarity": 0.93, "headline": "...", "detail": "...",
                   "same_fault": true } | null,
  "mission": { "status","hours_required","port","starboard",
               "pair_margin_hours","engine_out_margin_hours","detail",
               "confidence_basis" },
  "bus": { "backend": "virtual" | "socketcan:vcan0",
           "frames_sent": 5184, "decodes": 648 }
}
```

**Control endpoints**

- `POST /api/inject` `{ "side": "port"|"starboard"|"both", "fault": <label>|null, "severity": 0..1 }`
  Fault labels: `injector_underflow`, `cooling_degradation`, `lubrication_loss`,
  `turbo_underperformance`, `combustion_instability`, `ring_blowby`, `sensor_stuck`.
- `POST /api/condition` `{ "throttle","altitude","oat","mission_hours" }`

**Part ids in the glb (these are load-bearing — renaming breaks highlighting):**
`injector_1..4`, `common_rail`, `turbocharger`, `intake`, `exhaust`,
`cylinder_head`, `cooling`, `lubrication`, `controller`, `crankcase`,
`engine_body`. Airframe: `engine_port`, `engine_starboard`, `airframe`.

---

## 5. Hard constraints — violating these breaks the product

### 5.1 Content Security Policy
The server sends, and the page complies with, **no `unsafe-inline` anywhere**:
```
default-src 'self'; script-src 'self'; style-src 'self';
img-src 'self' data: blob:; connect-src 'self' ws: wss:;
worker-src 'self' blob:; object-src 'none'; base-uri 'none'
```
Therefore:
- **No inline `<script>`** in index.html. There is deliberately no importmap —
  ES modules resolve via relative paths into `vendor/`. The bare `'three'`
  specifiers inside the vendored addons were rewritten to
  `'../../three/three.module.js'`. Keep it that way.
- **No `style="..."` attributes**, in HTML markup or in `innerHTML` strings generated by JS. Use CSS classes.
  **Clarification:** Setting layout properties from JS (`element.style.width`, `element.style.left`, etc.) is a CSSOM write and is **not** blocked by `style-src 'self'`. CSP's `style-src` directive governs `style=""` attribute strings in HTML and `<style>` blocks; it does not govern CSSOM mutation. This project uses JS CSSOM writes (via `applyBarWidths()`) for dynamic bar widths. The prohibition above covers `style=""` in HTML source, `innerHTML` strings that include `style=`, and `setAttribute('style', …)` calls.
- **No external origins.** No CDN, no Google Fonts. three.js is vendored so the
  whole thing runs offline — this matters for a defence demo on a network you
  don't control.
- **Split deployment (Vercel + Render):** When frontend is deployed to Vercel and backend to Render, `vercel.json` pins `connect-src 'self' https://shadow-twin.onrender.com wss://shadow-twin.onrender.com`. Wildcard `http:`/`https:` is prohibited. Backend CORS uses `allow_origins=['*']` intentionally for the initial Render deploy, and should be tightened to `['https://shadow-twin.vercel.app']` once the frontend domain is confirmed.

If a browser reports `default-src 'none'` blocking `styles.css`/`app.js`, that is
**not** from this server (`curl -I http://localhost:8000/` to confirm). It is a
browser extension, VS Code's Simple Browser/Live Preview webview, or a proxy.

### 5.2 Low-end device budget
Tier detected from `hardwareConcurrency`, `deviceMemory`, pointer type.

| | low | mid | high |
|---|---|---|---|
| frame cap | 24 fps | 30 fps | 60 fps |
| pixel ratio | 1.0 | 1.4 | 1.8 |
| engine model | `engine_low.glb` | `engine_low.glb` | `engine.glb` |
| antialiasing | off | off | on |

- Meshes are **pre-merged into 14 groups from 895** (airframe 3 from 197). Draw
  calls, not triangles, stall weak GPUs. Do not split parts back out.
- Engine model is **lazy-loaded** — not fetched until an engine is first opened.
  Aircraft view costs 0.5 MB.
- Rendering is **on demand** (`needsRender` flag) and stops when the tab is hidden.
- No shadow maps, no post-processing, two lights.
- **No Draco** — it needs a WASM decoder fetched at runtime, an extra failure point
  offline. Plain glTF loads with no decoder.
- `prefers-reduced-motion` disables damping and transitions.

### 5.3 Visual design
Calm instrument panel in daylight, **not** a dark neon cockpit. Warm off-white
paper (`--paper #F7F6F3`), soft charcoal ink, one system typeface. Muted status
colours: sage `--nominal #5B7F6B`, ochre `--caution #B5863F`, brick
`--fault #A85248`, slate `--unknown #7E8696`. Nothing glows or pulses. Motion only
answers a click. Copy is plain — "Not evaluated", never "ANOMALY DETECTED".

The `unknown` slate state is **not** decorative: it is the confidence gate made
visible. Never let it fall back to green.

### 5.4 Exploded view
Engine stays assembled while healthy. Only implicated parts lift out, each with a
short label (`Injector 3 — low delivery`). Nothing moves unless something is wrong.
Labels are HTML projected to screen space each frame — do not replace with 3d text
geometry, it costs far more on weak GPUs.

---

## 6. Bugs already found and fixed — do not reintroduce

These were found by testing, not by reading code. Each would have shipped silently.

1. **Isolation Forest scored severe faults as normal.** Fault feature vectors sat up
   to **423σ** from healthy and still returned a positive (inlier) score. Its trees
   split on thresholds drawn from the training range, so a point far outside
   inherits the path length of the nearest boundary leaf — it does not extrapolate.
   **Fix:** fused with a robust median/MAD z-score (which extrapolates correctly)
   and features squashed through `tanh(z/4)` before the forest.
   **Do not** remove the z-score detector and "simplify" back to a bare
   IsolationForest.

2. **CAN quantisation looked like a dead sensor.** Manifold pressure is carried at
   2 kPa/bit, so at steady cruise consecutive samples are bit-identical and an
   equality-based frozen check quarantined a healthy channel forever.
   **Fix:** the frozen check asks whether the channel produced **any distinct
   value** across the window, not whether consecutive samples differ.

3. **A real engine fault was blamed on a sensor.** The corroboration rule marks a
   channel suspect when it disagrees with the model while its partners stay
   nominal — which is also exactly what an injector fault looks like from the
   vibration channel.
   **Fix:** corroboration is skipped entirely when **more than one** channel has
   drifted. A sensor fault moves one channel; an engine fault moves several.

4. **The rate check tripped on sensor noise.** Comparing two consecutive noisy
   samples at 10 Hz makes 2σ of noise look like an impossible slew.
   **Fix:** compare against a 5-sample median, and rate limits include noise
   headroom.

5. **A stuck sensor was silently swallowed.** One bad channel out of nine did not
   drop coverage below the gate, so the system reported "nominal" and said nothing
   about the dead channel.
   **Fix:** `instrumentation[]` is always populated from the trust gateway,
   independent of coverage. Engine status and sensor status are separate outputs.

6. **The twin never recovered from a fault (open-loop drift).** Thermal and
   manifold states are integrators. When a real fault heats the head, twin and
   engine diverge and nothing brings them back — it kept reporting a 46σ phantom
   residual 22 s after the fault was cleared.
   **Fix:** `EngineTwin._resync()`, a gated observer with gain 0.02 that pulls the
   twin's slow states toward measurement **only while the detector says nominal**.
   Correcting during a fault would absorb the fault into the model and erase the
   signal. Recovery is now ~20 s against a 12 s residual window.
   **Never** make this correction unconditional.

7. **Callout labels were invisible despite existing in the DOM.** `syncCallouts`
   rewrote `className` on every 5 Hz update, stripping the `shown` class and
   restarting the 260 ms fade before it could finish, so opacity oscillated near 0.
   **Fix:** only touch what changed; never rewrite `className` wholesale on a
   high-frequency update path.

---

## 7. Measured behaviour — keep these honest

`evaluate.py`, held-out segments, randomised flight profiles:

| Fault severity | Detected | Correctly named |
|---|---|---|
| 0.10 | 22% | 6% |
| 0.20 | 53% | 31% |
| 0.35 | 100% | 92% |
| 0.50 | 100% | 94% |
| 0.75 | 100% | 100% |

False positives on healthy engines: **0 / 36**.

The low-severity rows are in the table **on purpose**. A detector with no stated
failure point has not been tested. Do not delete them, and do not "improve" the
numbers by evaluating only on strong faults.

Physics sanity (`mvem.py`):

| Condition | Power | CHT | EGT | Oil press |
|---|---|---|---|---|
| Sea level, full | 138 hp | 230 °C | 704 °C | 3.80 bar |
| 4500 m, cruise | 80 hp | 160 °C | 690 °C | 3.90 bar |
| 9000 m, full | 89 hp | 199 °C | 770 °C | 4.34 bar |

Power falls with altitude, EGT rises as cooling air thins, oil pressure rises as
oil runs cooler, smoke limiter holds λ at 1.28. If a physics change breaks these
trends, the change is wrong.

---

## 8. What is deliberately not real yet

State these plainly; never paper over them.

- **The ECUs are simulated.** Walled off behind the CAN encoder, but the engine on
  the far side of the bus is a model, not hardware.
- **Faults are seeded, not observed.** No public run-to-failure dataset exists for
  this engine class. Evaluation measures separation of fault signatures from
  operating-point variation. **It is not a field validation.**
- **The physics core is MVEM only.** The physics-informed (PINN) heat-balance loss
  term for CHT/EGT is designed but unimplemented. This is the main planned gap.
- **RUL runs on an accelerated clock** (`SHADOWTWIN_TIME_SCALE`, default 120) so
  trends are visible in a demo lasting minutes. It affects the RUL time axis only,
  never the physics, which always steps at real `dt`.

---

## 9. Planned work, in priority order

1. **PINN heat-balance term.** A lightweight lumped-thermal-mass consistency
   penalty bounding CHT/EGT rate of change by heat generation minus rejection.
   Deliberately **not** a full Fourier conduction PDE — sensors give point
   temperatures, not a spatial field, so a full PDE adds complexity without
   physical grounding.
2. **Alert triage layer** — deduplicate correlated findings, severity-rank them,
   suppress recurring known-benign noise, and emit a single prioritised advisory
   instead of a raw finding stream.
3. **Mission-aware go/no-go** — run the twin forward against a specific planned
   sortie, reporting both-engine and engine-out margins. Partially present in
   `mission_margin()`; needs forward simulation rather than trend projection.
4. **Edge deployment** — quantise the detector to INT8/ONNX, benchmark on Jetson
   Orin or Raspberry Pi class hardware.
5. **Secure telemetry** — signed/authenticated CAN frames so a spoofed feed cannot
   fool the twin.

---

## 10. How to work on this

- **Test, don't assume.** Every bug in section 6 passed code review and failed a
  test. After a change, run `evaluate.py`, and exercise the three demo paths:
  injector fault, stuck sensor, both-engines drift.
- **Run the server detached** (`setsid nohup python3 server.py &`) and allow ~40 s
  before querying — the residual window must fill before health is scored.
- **Retrain after touching `mvem.py`, `detect.py` features, or noise models.**
  `models.pkl` encodes the healthy distribution; a physics change invalidates it.
- **Kill stale servers before restarting** (`pkill -9 -f "python3 server.py"`),
  port 8000 is not released promptly.
- **Preserve the honesty constraints in section 1.** If a change would overstate
  confidence, hide a failure mode, or blur the sensor/engine distinction, raise it
  rather than implementing it silently.
