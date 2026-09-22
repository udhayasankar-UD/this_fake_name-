# shadow-twin — Project Document

**DRDO SIH Problem Statement 26054 · Twin aero-diesel health monitoring for MALE UAV**

> Version: post-UI/UX redesign (September 2026)  
> Status: functional prototype with simulated ECUs  
> Platform: TAPAS-BH-201 (Rustom-II)

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Governing Design Principle](#2-governing-design-principle)
3. [System Overview](#3-system-overview)
4. [Repository Structure](#4-repository-structure)
5. [Processing Pipeline](#5-processing-pipeline)
6. [Physics Core — MVEM](#6-physics-core--mvem)
7. [CAN Bus Layer](#7-can-bus-layer)
8. [Sensor Trust Gateway](#8-sensor-trust-gateway)
9. [Detection and Classification](#9-detection-and-classification)
10. [Remaining Useful Life](#10-remaining-useful-life)
11. [Cross-Engine Correlation](#11-cross-engine-correlation)
12. [Ground Service API](#12-ground-service-api)
13. [Dashboard — UI Architecture](#13-dashboard--ui-architecture)
14. [Design System](#14-design-system)
15. [Performance Budget](#15-performance-budget)
16. [Verified Behaviour](#16-verified-behaviour)
17. [Known Limitations](#17-known-limitations)
18. [Bugs Found and Fixed](#18-bugs-found-and-fixed)
19. [Future Work](#19-future-work)
20. [Running the System](#20-running-the-system)

---

## 1. Problem Statement

The TAPAS-BH-201 (Rustom-II) is a Medium Altitude Long Endurance (MALE) UAV with two wing-mounted aero-diesel engines. The reference engine class is a 2.2 L, 4-cylinder, turbocharged, common-rail direct injection aero-diesel with a reduction gearbox driving the propeller — the class represented by the Austro AE300 and the indigenous VRDE-JAYEM 180 hp unit.

Unlike a manned aircraft, the crew cannot directly observe, smell, or hear an engine in distress. Ground telemetry is the only observation channel, and in a multi-hour sortie the ground operator must make go/no-go and land/continue decisions in near real-time.

**The challenge:** a raw telemetry stream of 8 engine channels is hard to interpret across operating conditions. A CHT of 220 °C is normal in a sea-level climb and alarming in a high-altitude cruise. A system that alarms on threshold crossings will alarm constantly in normal flight and miss anomalies that develop slowly across an operating point change.

**The solution:** a physics model runs in lockstep, predicting what a healthy engine _should_ read at the current operating point. Only the _residual_ (measured − expected) is fed to anomaly detection. This normalises out operating-point variation before any ML sees the data.

---

## 2. Governing Design Principle

> **The system states how sure it is, and refuses to score health when the basis is too thin, rather than showing a confident green.**

Every output carries either a confidence number or an explicit `not_evaluated` status with a reason. The confidence gate deliberately refuses to assign a health score when sensor coverage is below 80%, when the residual window has not filled, or when the health signal is too flat to distinguish a trend from noise.

A sensor problem is **never** reported as an engine problem. They are separate output channels.

---

## 3. System Overview

```
Twin-engine UAV in flight
        │
        │ CAN bus (J1939 PGNs, 8-byte frames, 10 Hz per engine)
        ▼
  ┌─────────────────┐      ┌─────────────────┐
  │ Port ECU (sim)  │      │ Stbd ECU (sim)  │   ← walled off at CAN encoder
  └─────────────────┘      └─────────────────┘
        │  CAN frames             │  CAN frames
        ▼                         ▼
  ┌──────────────── EngineBus ──────────────────┐
  │  decode via engine.dbc (cantools)           │
  └─────────────────────────────────────────────┘
        │                         │
  ┌─────▼────────┐         ┌──────▼───────┐
  │ Port Twin    │         │ Stbd Twin    │
  │              │         │              │
  │ MVEM step    │         │ MVEM step    │   ← physics model, always real dt
  │ residuals    │         │ residuals    │
  │ trust gw     │         │ trust gw     │
  │ detect       │         │ detect       │
  │ conf gate    │         │ conf gate    │
  │ RUL          │         │ RUL          │
  └──────┬───────┘         └──────┬───────┘
         └──────────┬─────────────┘
                    │ correlate()
                    │ mission_margin()
                    ▼
             FastAPI + WebSocket
                    │
                    ▼
          Dashboard (three.js + HTML)
```

The key boundary: the simulated ECUs produce CAN frames and nothing else. Everything downstream — decode, physics, trust, detection, RUL, correlation — is identical to what would run against a real CAN bus. Replacing the simulator with a real bus requires one environment variable: `SHADOWTWIN_CAN=vcan0`.

---

## 4. Repository Structure

```
frontend/
├── index.html              Dashboard shell. No inline <script>, no style="" attributes.
├── app.js                  Three.js viewer, WebSocket client, exploded view, callouts, tab switching.
├── styles.css              Full design system: tokens, layout, components.
├── vendor/                 Three.js r160 — fully vendored, runs with zero internet.
│   ├── three/three.module.js
│   ├── addons/loaders/GLTFLoader.js
│   ├── addons/controls/OrbitControls.js
│   └── addons/utils/BufferGeometryUtils.js
├── models/
│   ├── tapas.glb           Airframe. 3 mesh objects, 14,874 triangles, 0.5 MB.
│   ├── engine.glb          Full-detail engine. 14 objects, 30,831 triangles, 5.1 MB.
│   └── engine_low.glb      Low-detail engine. 14 objects, 14,763 triangles, 4.4 MB.
└── backend/
    ├── mvem.py             Mean value engine model (the physics core).
    ├── can_bus.py          CAN encode/decode; socketcan or python-can virtual bus.
    ├── trust.py            Sensor trust gateway — 5 checks.
    ├── detect.py           IsolationForest ∪ robust z anomaly detector; GBM classifier; RUL.
    ├── twin.py             Per-engine orchestration, confidence gate, correlation, mission margin.
    ├── server.py           Simulated ECUs, FastAPI service, WebSocket broadcast.
    ├── train.py            Generates healthy + fault training data from the physics model.
    ├── evaluate.py         Severity sweep — reports the detection failure envelope.
    ├── dbc/engine.dbc      8 CAN message definitions, J1939 PGNs.
    ├── models.pkl          Serialised detector (regenerate with train.py after physics changes).
    └── requirements.txt    fastapi, uvicorn, numpy, scikit-learn, python-can, cantools
```

---

## 5. Processing Pipeline

The pipeline runs at 10 Hz per engine (`DT = 0.1 s`). The WebSocket broadcasts at 5 Hz (`STREAM_HZ = 5`). Each tick:

| Step | Module | What happens |
|------|--------|--------------|
| 1 | `can_bus.py` | Raw 8-byte CAN frames decoded using `engine.dbc` via cantools. J1939 PGNs map to measurement channels. |
| 2 | `mvem.py` | Physics twin steps at real `dt`. Outputs `expected` dict: what a healthy engine should read. |
| 3 | `twin.py` | `residual = measured − expected` for each channel. |
| 4 | `trust.py` | Five checks on each channel (range, frozen, rate, corroboration, envelope). Channels are `trusted`, `suspect`, or `quarantined`. |
| 5 | `detect.py` | Only trusted channels are fed to the anomaly detector. `ResidualWindow` accumulates a 120-sample rolling buffer. |
| 6 | `twin.py` | Confidence gate: health is scored only when ≥ 80% of channels are trusted and the window has filled. Otherwise status = `not_evaluated`. |
| 7 | `detect.py` | `RUL.estimate()` projects the health index to its limit with a 200-sample bootstrap interval. Returns `None` when the basis is too thin. |
| 8 | `twin.py` | `correlate()` compares port and starboard residual vectors. `mission_margin()` estimates remaining flight hours. |

**Why residuals rather than raw telemetry:** a model trained on raw values must learn every operating condition and every fault simultaneously, and no dataset is large enough for both. Residuals are operating-point-agnostic: a +50 °C CHT residual means the same thing whether the engine is climbing at sea level or cruising at 9,000 m.

---

## 6. Physics Core — MVEM

**File:** [`mvem.py`](file:///d:/shadow-twin/backend/mvem.py)

The physics model is a **mean-value engine model**: quantities are averaged over a combustion cycle rather than resolved crank-angle by crank-angle. This is the standard formulation for real-time digital twins — fast enough to run in lockstep with live telemetry, physically grounded enough to capture the operating-point dependencies that matter for residual computation.

### Engine specification

| Parameter | Value |
|-----------|-------|
| Displacement | 2.2 L inline-4 |
| Max power | 134 kW (~180 hp) |
| Rated RPM | 2700 rpm |
| Idle RPM | 900 rpm |
| Compression ratio | 16.5:1 |
| Turbo boost max | 320 kPa absolute |
| Smoke limiter λ | 1.28 (min air/fuel ratio) |

### States integrated over time

| State | Description | Units |
|-------|-------------|-------|
| `p_man` | Intake manifold (boost) pressure | kPa |
| `T_cht` | Cylinder head metal temperature | °C |
| `T_egt` | Exhaust gas temperature | °C |
| `T_oil` | Oil temperature | °C |

Everything else (fuel rate, power, oil pressure) is algebraic from these states and the operating point (throttle, altitude, OAT).

### ISA atmosphere

Altitude-pressure-temperature computed from ISA troposphere equations, capped at 11,000 m. This drives the density correction for volumetric efficiency, turbo boost headroom, and oil cooling.

### Physics sanity table

The model is validated against these steady-state operating points. Any physics change that breaks these trends is wrong.

| Condition | Power | CHT | EGT | Oil press |
|-----------|-------|-----|-----|-----------|
| Sea level, full throttle | 138 hp | 230 °C | 704 °C | 3.80 bar |
| 4,500 m, cruise | 80 hp | 160 °C | 690 °C | 3.90 bar |
| 9,000 m, full throttle | 89 hp | 199 °C | 770 °C | 4.34 bar |

Note: power falls with altitude (less air mass), EGT rises as cooling air thins, oil pressure rises as oil runs cooler. The smoke limiter holds λ ≥ 1.28 throughout.

### Observer correction (`_resync`)

The thermal states (`T_cht`, `T_oil`, `T_egt`) and manifold pressure (`p_man`) are integrators. After a fault is cleared, the twin and engine diverge and residuals persist for tens of seconds. A gated observer (gain = 0.02) pulls the twin's slow states back toward measurement — **only while the detector says nominal**. Correcting during a fault would absorb the fault into the model and erase the signal.

---

## 7. CAN Bus Layer

**File:** [`can_bus.py`](file:///d:/shadow-twin/backend/can_bus.py) · **DBC:** [`dbc/engine.dbc`](file:///d:/shadow-twin/backend/dbc/engine.dbc)

Eight J1939 CAN messages carry engine telemetry at 10 Hz. The DBC file defines the encoding; `cantools` handles the decode. The `EngineBus` class transparently uses either:
- **socketcan** — if `SHADOWTWIN_CAN` environment variable is set (real or virtual CAN interface)
- **python-can virtual bus** — otherwise (in-process simulation)

The simulated ECU calls the encode path; the twin calls the decode path. This is the only point where the simulator and the twin communicate. There is no other shared state.

### CAN quantisation note

Manifold pressure is transmitted at 2 kPa/bit. At steady cruise, consecutive samples are often bit-identical even on a healthy sensor. The frozen-channel detector accounts for this: it tests whether the channel produced **any** distinct value across a 25-sample window, not whether consecutive samples differ.

---

## 8. Sensor Trust Gateway

**File:** [`trust.py`](file:///d:/shadow-twin/backend/trust.py)

Each channel is scored independently before it can influence engine health. The five checks run in order, cheapest first. A channel that fails checks 1–3 is **quarantined** and excluded from detection. A channel that fails only check 4 is marked **suspect** and still reported, but the engine-vs-sensor ambiguity is flagged.

| Check | Description | Output on fail |
|-------|-------------|----------------|
| 1. Range | Value outside physical limits (e.g. CHT > 400 °C) | Quarantined |
| 2. Frozen | No distinct value across 25-sample window | Quarantined |
| 3. Rate | Changed faster than the physical system can move (5-sample median comparison) | Quarantined |
| 4. Corroborate | Disagrees with physically coupled channels while partners stay nominal | Suspect |
| 5. Envelope | Operating point outside calibration range | Suspect |

### Physical limits and rate limits

| Channel | Low | High | Max rate/s |
|---------|-----|------|------------|
| RPM | 0 | 4,000 | 900 rpm/s |
| CHT | −40 °C | 400 °C | 60 °C/s |
| EGT | −40 °C | 1,300 °C | 400 °C/s |
| Oil temp | −40 °C | 200 °C | 40 °C/s |
| Oil pressure | 0 | 12 bar | 4 bar/s |
| Boost | 0.3 | 4.5 bar | 3 bar/s |
| Fuel flow | 0 | 80 L/h | 40 L/h per s |
| Vibration | 0 | 60 mm/s | 30 mm/s per s |

### Corroboration rule

A channel is only marked suspect for disagreeing with its coupled partners **when only one channel has drifted**. If multiple channels disagree simultaneously, that is the signature of an engine fault (which moves several channels), not a sensor fault (which moves one). Corroboration is skipped in multi-channel divergence to prevent an engine fault from being mis-classified as a sensor problem.

### Coverage gate

Health is only scored when ≥ 80% of channels are `trusted`. If a sensor fault quarantines enough channels to drop below this threshold, the system reports `not_evaluated` rather than a health score derived from an inadequate basis.

---

## 9. Detection and Classification

**File:** [`detect.py`](file:///d:/shadow-twin/backend/detect.py)

### Feature engineering

The `ResidualWindow` accumulates a 120-sample rolling buffer (12 real seconds) of residuals. It computes a 24-dimensional feature vector: for each of the 8 channels, the mean, standard deviation, and linear slope of the residual over the window.

### Anomaly detection — fused detector

Two detectors vote because neither is sufficient alone:

**Robust z-score:**
- Fits a robust median/MAD distribution over the training set of healthy residuals.
- Scores a new sample as `|z| = |x − median| / MAD`.
- Takes the mean of the three largest absolute z-scores as the novelty score.
- Threshold is the 99th percentile of healthy-data novelty scores.
- Extrapolates correctly outside the training range.

**Isolation Forest:**
- Trained on healthy residuals after `tanh(z/4)` squashing.
- The tanh squash is essential: without it, a point far outside the training range inherits the path length of the nearest boundary leaf and scores as normal. After squashing, all out-of-range points map to near ±1 and the forest correctly identifies them as outliers.
- Contamination = 0.01, 200 estimators.

An engine is flagged anomalous if **either** detector triggers. When both trigger, the severity is boosted by +0.12.

### Fault classification — GBM

A `GradientBoostingClassifier` (120 estimators, depth 3, lr 0.1) is trained on labelled feature vectors, one label per seeded fault type. Predicts fault probabilities across 7 classes.

### Fault labels

| Label | Description |
|-------|-------------|
| `injector_underflow` | Injector delivery shortfall |
| `cooling_degradation` | Cooling system losing effectiveness |
| `lubrication_loss` | Oil pressure below modelled value |
| `turbo_underperformance` | Turbocharger not making commanded boost |
| `combustion_instability` | Combustion running outside expected band |
| `ring_blowby` | Cylinder sealing degraded |
| `sensor_stuck` | Sensor frozen (trust gateway catches this first) |

### Evidence reporting

`Detector.contributions()` computes per-feature importance as `|z| × feature_importance`. The top-3 contributing channels are reported in `evidence[]` in the websocket payload, giving operators a human-interpretable explanation.

### Training (`train.py`)

Training data is generated entirely from the physics model. `train.py` simulates healthy engine segments across a range of flight profiles (altitude, throttle sweeps) and seeded-fault segments at 5 severity levels. This means the detector's healthy distribution is physics-grounded rather than fitted to arbitrary measurements.

---

## 10. Remaining Useful Life

**Class `RUL` in** [`detect.py`](file:///d:/shadow-twin/backend/detect.py)

### Method

1. Maintain a rolling 400-sample history of `(hours_run, health_ema)`.
2. Fit a linear degradation trend via polyfit.
3. Bootstrap 200 times (resample with replacement) to get a slope distribution.
4. For each bootstrap slope: if slope ≥ 0, engine is not degrading → TBO-limited projection. Otherwise, solve for when the line reaches `limit = 0.55`.
5. Return median (point estimate), P10 (pessimistic), P90 (optimistic).

### Guards — returning `None`

The function returns `None` (shown in the UI as "Not yet projected — collecting baseline") in three situations:

| Guard | Condition | Reason |
|-------|-----------|--------|
| Minimum samples | `len(hist) < 60` | Not enough history |
| Minimum span | `span < 0.25 h` | Baseline too short |
| Flat signal | `std(y) < 0.005` | Cannot distinguish trend from healthy EMA noise |

The third guard prevents a flat healthy signal from generating a misleading near-zero P10 via a noisy bootstrap fit. A flat health index means there is no meaningful trend to project, regardless of how much time has elapsed.

### Time scale

`SHADOWTWIN_TIME_SCALE = 120` (default). Flight hours advance 120× faster than wall clock so degradation trends are visible in a demo. This affects the RUL time axis only. The physics model always steps at real `dt`.

---

## 11. Cross-Engine Correlation

**Function `correlate()` in** [`twin.py`](file:///d:/shadow-twin/backend/twin.py)

The residual vectors from port and starboard engines are compared by cosine similarity. A high similarity score (> 0.85) with residuals pointing the same direction suggests a shared cause (common fuel contamination, weather ingestion, airframe resonance). Low similarity suggests two independent faults.

### Mission margin

`mission_margin()` takes both engines' RUL P10 (pessimistic projection) and the planned sortie duration. It computes:
- **Pair margin**: `min(port_p10, stbd_p10) − hours_required`
- **Engine-out margin**: same calculation — currently equal to pair margin (known limitation: engine-out load is higher, which would reduce effective RUL further, but this requires a modelling change rather than a one-line fix)

If either engine's RUL is `None`, the mission margin reports "Not enough basis to project" rather than a negative number.

---

## 12. Ground Service API

**File:** [`server.py`](file:///d:/shadow-twin/backend/server.py)

### WebSocket — `ws://localhost:8000/ws`

Broadcasts at 5 Hz. Complete state each message:

```jsonc
{
  "ts": 1789760000.0,
  "condition": {
    "throttle": 0.66,
    "altitude_m": 4200.0,
    "oat_c": 12.0,
    "mission_hours": 14.0
  },
  "engines": {
    "port": {
      "side": "port",
      "status": "nominal" | "caution" | "fault" | "anomaly_unclassified" | "not_evaluated",
      "confidence": 0.0–1.0 | null,     // null ONLY when not_evaluated
      "headline": "Injector delivery shortfall",
      "detail": "Driven mainly by vibration level (227σ)...",
      "fault": "injector_underflow",    // absent when nominal
      "severity": 0.0–1.0,
      "measured":  { "rpm": 2118, "cht_c": 166.2, ... },
      "expected":  { "rpm": 2121, "cht_c": 165.1, ... },
      "residual":  { "rpm": -3.0, "cht_c": 1.1, ... },
      "trust":     { "cht_c": { "status": "trusted"|"suspect"|"quarantined",
                                "reason": string|null, "score": 0.0–1.0 }, ... },
      "trust_summary": { "quarantined": [], "suspect": [], "coverage": 1.0 },
      "instrumentation": [ { "channel", "pretty", "status", "reason",
                             "headline", "detail" } ],
      "parts":     { "injector_3": "fault", "common_rail": "caution" },
      "evidence":  [ { "feature": "vibration_mms level", "z": 227.0, "weight": 0.61 } ],
      "probabilities": { "injector_underflow": 0.97, ... },
      "rul": { "hours": 782.0, "p10": 770.0, "p90": 795.0,
               "rate_per_hour": -0.0001, "basis": "linear degradation fit, 200-sample bootstrap" } | null,
      "hours_run": 418.0
    },
    "starboard": { ... }
  },
  "correlation": {
    "kind": "shared_cause" | "independent",
    "similarity": 0.93,
    "headline": "...", "detail": "...", "same_fault": true
  } | null,
  "mission": {
    "status", "hours_required", "port", "starboard",
    "pair_margin_hours", "engine_out_margin_hours",
    "detail", "confidence_basis"
  },
  "bus": { "backend": "virtual" | "socketcan:vcan0",
           "frames_sent": 5184, "decodes": 648 }
}
```

### REST endpoints

| Method | Path | Body | Purpose |
|--------|------|------|---------|
| `GET` | `/api/state` | — | Latest state snapshot (same schema as WebSocket) |
| `POST` | `/api/inject` | `{ "side": "port"\|"starboard"\|"both", "fault": label\|null, "severity": 0–1 }` | Inject or clear a fault |
| `POST` | `/api/condition` | `{ "throttle", "altitude", "oat", "mission_hours" }` | Set flight condition |

### Fault labels for injection

`injector_underflow` · `cooling_degradation` · `lubrication_loss` · `turbo_underperformance` · `combustion_instability` · `ring_blowby` · `sensor_stuck`

### Content Security Policy

Every HTTP response carries:
```
default-src 'self'; script-src 'self'; style-src 'self';
img-src 'self' data: blob:; connect-src 'self' ws: wss:;
worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'
```

No external origins. No CDN. The dashboard runs completely offline — required for a defence demo on a network you do not control.

---

## 13. Dashboard — UI Architecture

**Files:** [`index.html`](file:///d:/shadow-twin/frontend/index.html) · [`app.js`](file:///d:/shadow-twin/frontend/app.js) · [`styles.css`](file:///d:/shadow-twin/frontend/styles.css)

### Layout

```
┌────────────────────────────────────────┬──────────────────────┐
│  3D Viewport (Three.js canvas)         │  Right sidebar       │
│                                        │  ─────────────────── │
│  [Aircraft / Engine model fills here]  │  Propulsion status   │
│                                        │  Live badge          │
│  ┌──────────────────────────────┐      │  ─────────────────── │
│  │ Findings │ Readings (tabs)   │      │  Engines             │
│  │                              │      │  Port card + RUL     │
│  │  Port — Injector shortfall   │      │  Stbd card + RUL     │
│  │  ████████████████ 97%        │      │  ─────────────────── │
│  └──────────────────────────────┘      │  Projection          │
│                                        │  Components (2-col)  │
│  [Back to aircraft]     [Drag rotate]  │  ─────────────────── │
│                                        │  Simulate            │
└────────────────────────────────────────┴──────────────────────┘
```

Everything fits in a single 1920×928 viewport. No scrolling anywhere.

### View states

**Aircraft view** (default):
- `tapas.glb` is rendered. Engines are tinted by health status (sage, ochre, or brick).
- Click an engine nacelle on the model or the engine card in the sidebar to enter engine view.
- Floating infobar shows **Findings** tab only. Readings tab is hidden.

**Engine view** (after clicking a card):
- `engine.glb` or `engine_low.glb` (tier-dependent) is lazy-loaded on first access.
- Implicated parts lift out of the assembly (exploded view). Labels project to screen space.
- Floating infobar auto-switches to **Readings** tab, showing sensor grid with range bars.
- Sidebar shows Projection, Components (2-column grid), and Simulate.

### Key JS functions

| Function | Purpose |
|----------|---------|
| `updateLiveBadge()` | Static colour-change (sage/ochre/slate). No animation, no @keyframes. |
| `updateRing(side, st)` | Toggle CSS classes on SVG status ring. Never rewrites className wholesale. |
| `renderRulStrip(r)` | Returns HTML for the RUL bar. Returns "Not yet projected" text (never a zero-length bar) when `r.rul` is null. |
| `renderConfBar(confidence, st)` | Returns confidence bar HTML. `null` confidence → italic "Not evaluated" text, not a 0% bar. These are different claims. |
| `rangeBar(k, v, exp, trustStatus, res)` | Per-channel range bar. Fill colour from trust status first, then residual z-score. |
| `applyBarWidths()` | Post-paint CSSOM sweep. Sets `.style.width` from `data-` attributes. Called once per `paint()` and `paintDetail()`. |
| `setInfoTab(name)` | Switches Findings/Readings tab in the floating infobar. |
| `setExploded(flags, fault)` | Lifts flagged parts out of the assembly with direction vectors from the engine bounding box. |
| `syncCallouts()` | Creates/updates HTML callout labels. Toggles classes rather than rewriting className — critical for Bug 7 avoidance. |
| `positionCallouts()` | Projects part centroids through the camera to screen space. Called from the render loop. |

### CSP compliance

- No inline `<script>` in `index.html`.
- No `style=""` attributes in HTML markup or `innerHTML` strings.
- JS CSSOM writes (`element.style.width`, `element.style.left`) are **not** blocked by `style-src 'self'`. CSP's `style-src` governs `style=""` attribute strings and `<style>` blocks; it does not govern CSSOM mutation. All dynamic bar widths use this mechanism via `applyBarWidths()`.
- No importmap — ES modules resolve via relative paths into `vendor/`. The bare `'three'` specifiers in vendored addons are rewritten to `'../../three/three.module.js'`.
- No external origins.

---

## 14. Design System

**File:** [`styles.css`](file:///d:/shadow-twin/frontend/styles.css)

The aesthetic is a **calm instrument panel in daylight** — not a dark neon cockpit. Warm off-white paper, soft charcoal ink, muted status colours. Nothing glows or pulses. Motion only answers a click.

### Colour tokens

| Token | Value | Use |
|-------|-------|-----|
| `--paper` | `#F7F6F3` | Page background |
| `--panel` | `#FFFFFF` | Card / sidebar background |
| `--ink` | `#2A2E33` | Primary text |
| `--ink-soft` | `#6B7178` | Secondary text |
| `--ink-faint` | `#9AA0A6` | Tertiary / label text |
| `--line` | `#E4E2DD` | Borders |
| `--nominal` | `#5B7F6B` | Sage — nominal health |
| `--caution` | `#B5863F` | Ochre — caution / watch |
| `--fault` | `#A85248` | Brick — confirmed fault |
| `--unknown` | `#7E8696` | Slate — not evaluated |
| `--rul-consumed` | `#C3CEBC` | Lighter sage — hours spent |
| `--rul-remaining` | `#5B7F6B` | Sage — hours remaining |
| `--rul-caution` | `#B5863F` | Ochre — RUL in caution zone |
| `--rul-fault` | `#A85248` | Brick — RUL in fault zone |

### Status ring

SVG `<circle>` coloured via CSS class only, never `style=""`. Dashed stroke = `not_evaluated` (the confidence gate made visible, not a decorative element).

### `unknown` (slate) is load-bearing

The slate `not_evaluated` state is the confidence gate made visible. It is never allowed to fall back to green without a genuine health score. `0%` confidence and `null` confidence are deliberately rendered differently.

---

## 15. Performance Budget

### Device tiers

Tier is detected from `hardwareConcurrency`, `deviceMemory`, and pointer type at startup.

| | Low | Mid | High |
|--|-----|-----|------|
| Frame cap | 24 fps | 30 fps | 60 fps |
| Pixel ratio | 1.0 | 1.4 | 1.8 |
| Engine model | `engine_low.glb` | `engine_low.glb` | `engine.glb` |
| Antialiasing | Off | Off | On |

### Mesh budget

Engine meshes are pre-merged into 14 named groups from the original 895 objects. Airframe: 3 groups from 197. **Draw calls — not triangles — stall weak GPUs.** Splitting parts back out would raise draw calls by ~60×.

| Model | Objects | Triangles | Size |
|-------|---------|-----------|------|
| `tapas.glb` (airframe) | 3 | 14,874 | 0.5 MB |
| `engine.glb` (high) | 14 | 30,831 | 5.1 MB |
| `engine_low.glb` (low/mid) | 14 | 14,763 | 4.4 MB |

### Rendering strategy

- **On demand**: `needsRender` flag. The renderer only fires when something has changed.
- **Paused when hidden**: `document.hidden` check in the RAF loop.
- No shadow maps. No post-processing. Two lights (hemisphere + directional).
- No Draco compression — it requires a WASM decoder fetched at runtime, an extra failure point offline.
- Engine model is **lazy-loaded** on first engine view. Aircraft view costs only 0.5 MB.
- `prefers-reduced-motion` disables damping and all CSS transitions.

### Layout budget (no-scroll target)

At 1920×920 viewport, every element must fit without triggering a scrollbar. Section paddings are compact (10px 16px), components list uses a 2-column grid, RUL strips are minimal-height. The right sidebar is `overflow: hidden` — if content overflows the 920px, it is clipped rather than scroll-revealed.

---

## 16. Verified Behaviour

### Detection performance (`evaluate.py`, held-out segments, randomised flight profiles)

| Fault severity | Detected | Correctly named |
|----------------|----------|-----------------|
| 0.10 | 22% | 6% |
| 0.20 | 53% | 31% |
| 0.35 | 100% | 92% |
| 0.50 | 100% | 94% |
| 0.75 | 100% | 100% |

**False positives on healthy engines: 0 / 36**

The low-severity rows are present on purpose. A detector with no stated failure point has not been tested.

### Physics sanity

| Condition | Power | CHT | EGT | Oil pressure |
|-----------|-------|-----|-----|--------------|
| Sea level, full | 138 hp | 230 °C | 704 °C | 3.80 bar |
| 4,500 m, cruise | 80 hp | 160 °C | 690 °C | 3.90 bar |
| 9,000 m, full | 89 hp | 199 °C | 770 °C | 4.34 bar |

### UI verification (11-step checklist)

| Step | Check |
|------|-------|
| 1 | No CSP errors in DevTools console |
| 2 | Nominal: both rings sage, RUL shows "Not yet projected" text (never a zero bar), live badge sage |
| 3 | Wait ≥ 25 s after fault injection before asserting detection failure |
| 4 | Injector fault, port: brick ring, ≥ 97% confidence bar |
| 5 | Mission margin: pair/engine-out shown, neither negative; "Not enough basis" when RUL null |
| 6 | Sensor fault, starboard: slate dashed ring, "Not evaluated" confidence (no bar) |
| 7 | Exploded view: callout labels visible for 10+ s without opacity oscillation (Bug 7 check) |
| 8 | Clear faults: all rings return sage |
| 9 | Server kill: badge turns slate within 2 s |
| 10 | prefers-reduced-motion: instant colour changes, no transitions |
| 11 | Mobile < 900 px: no horizontal overflow |

---

## 17. Known Limitations

These are stated plainly. None is papered over.

| Limitation | Detail |
|------------|--------|
| **ECUs are simulated** | Walled off behind the CAN encoder, but the engine on the far side of the bus is a model, not hardware. |
| **Faults are seeded, not observed** | No public run-to-failure dataset exists for this engine class. Evaluation measures separation of fault signatures from operating-point variation — not field validation. |
| **Physics core is MVEM only** | The physics-informed heat-balance loss term for CHT/EGT is designed but unimplemented. This is the main planned gap. |
| **RUL runs on accelerated clock** | `TIME_SCALE = 120` by default. Flight hours advance 120× faster than wall time so trends are visible in a demo. The physics always steps at real `dt`. |
| **Engine-out margin equals pair margin** | `worst_single` uses `min(p10, s10)`, the same as `pair_p10`. Engine-out effective RUL should be lower (surviving engine carries higher load), but computing this requires a modelling change, not a one-line swap. |
| **No PINN heat-balance term** | A lumped-thermal-mass consistency penalty for CHT/EGT rate of change is designed but not implemented. |

---

## 18. Bugs Found and Fixed

Each of these passed code review and failed a test. Do not reintroduce them.

### Bug 1 — Isolation Forest scored severe faults as normal
Fault feature vectors sat up to 423σ from healthy and still returned a positive (inlier) score. Trees split on thresholds from the training range; a point far outside inherits the path length of the nearest boundary leaf.  
**Fix:** fused with robust z-score, features squashed through `tanh(z/4)`.

### Bug 2 — CAN quantisation looked like a dead sensor
Manifold pressure at 2 kPa/bit produces bit-identical samples at steady cruise. An equality-based frozen check quarantined a healthy channel.  
**Fix:** frozen check tests whether the channel produced **any** distinct value across the window.

### Bug 3 — Engine fault blamed on a sensor
The corroboration rule marks a channel suspect when it disagrees with the model while partners stay nominal — which is exactly what an injector fault also looks like from the vibration channel.  
**Fix:** corroboration is skipped when more than one channel has drifted.

### Bug 4 — Rate check tripped on sensor noise
Two consecutive noisy samples at 10 Hz made 2σ of noise look like an impossible slew.  
**Fix:** compare against a 5-sample median; rate limits include noise headroom.

### Bug 5 — Stuck sensor silently swallowed
One bad channel out of nine did not drop coverage below the gate, so the system reported "nominal" with nothing about the dead channel.  
**Fix:** `instrumentation[]` is always populated from the trust gateway, independent of coverage.

### Bug 6 — Twin never recovered from a fault (open-loop drift)
After a fault was cleared, thermal and manifold states kept diverging — phantom residuals persisted 22 s after clearing.  
**Fix:** `EngineTwin._resync()`, a gated observer (gain 0.02) that corrects slow states **only while the detector says nominal**.

### Bug 7 — Callout labels invisible despite existing in the DOM
`syncCallouts` rewrote `className` on every 5 Hz update, stripping the `shown` class and restarting the 260 ms fade before it could finish.  
**Fix:** only touch what changed; never rewrite `className` wholesale on a high-frequency update path.

### Bug 8 — RUL P10 near zero on healthy engines
A flat `health_ema` produced bootstrap fits that were pure noise; the 10th percentile landed near zero, causing mission margin to show a negative number.  
**Fix:** `RUL.estimate()` returns `None` when `std(y) < 0.005`.

---

## 19. Future Work

In priority order:

1. **PINN heat-balance term** — A lightweight lumped-thermal-mass consistency penalty bounding CHT/EGT rate of change by heat generation minus rejection. Deliberately not a full Fourier conduction PDE — sensors give point temperatures, not a spatial field.

2. **Alert triage layer** — Deduplicate correlated findings, severity-rank them, suppress recurring known-benign noise, emit a single prioritised advisory.

3. **Mission-aware go/no-go** — Run the twin forward against a specific planned sortie, reporting both-engine and engine-out margins with forward simulation rather than trend projection.

4. **Edge deployment** — Quantise the detector to INT8/ONNX, benchmark on Jetson Orin or Raspberry Pi class hardware.

5. **Secure telemetry** — Signed/authenticated CAN frames so a spoofed feed cannot fool the twin.

6. **Engine-out RUL correction** — Model the higher load on the surviving engine when one fails. Reduces effective RUL compared to the current conservative `min()` figure.

---

## 20. Running the System

### Prerequisites

```
Python ≥ 3.10
```

```bash
cd backend
pip install -r requirements.txt
```

### Start

```bash
python train.py          # generates models.pkl (~5 seconds)
python server.py         # starts on http://localhost:8000
```

Open `http://localhost:8000` in any modern browser.

Wait **~40 seconds** before interpreting health scores. The residual window (`size=120` at 10 Hz = 12 seconds), the confidence gate, and the RUL baseline guard all need time to fill.

### Real CAN bus

```bash
SHADOWTWIN_CAN=vcan0 python server.py
```

The simulated ECUs drop out. Everything else is identical.

### Retrain after physics changes

Any change to `mvem.py`, the detection features in `detect.py`, or the noise models invalidates `models.pkl`. Run `python train.py` again before restarting the server.

### Kill stale server

```bash
# Windows
taskkill /f /im python.exe
```

Port 8000 is not released promptly after Ctrl+C. Kill the process explicitly before restarting.

### Demo paths to exercise

| Demo | Steps |
|------|-------|
| **Injector fault, port** | Click "Injector fault, port" → wait 25 s → observe brick port ring, confidence bar, exploded injector |
| **Sensor fault, starboard** | Click "Sensor fault, starboard" → observe slate dashed ring, "Not evaluated" (no bar), "Sensor finding, engine health unaffected" label |
| **Both engines drift** | Click "Both engines drift" → observe shared-cause correlation card |
| **Clear** | Click "Clear" → all rings return sage within ~20 s (observer resync time) |

---

*Document generated from the live codebase. Accuracy of performance figures is limited to what evaluate.py has measured on seeded faults — not field-validated data.*
