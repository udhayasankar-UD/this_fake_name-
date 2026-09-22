# shadow-twin — Aero engine digital twin

A digital twin for the twin aero-diesel powerplant of a MALE UAV (DRDO SIH problem statement 26054). Telemetry moves over real CAN frames, a mean value engine model predicts what a healthy engine should be reading at the current operating point, and the difference between the two drives anomaly detection, fault classification, remaining useful life and cross-engine correlation.

The design commitment: **the system states how sure it is, and refuses to score health when the basis is too thin, rather than showing a confident green.**

---

## Repository Structure

```
shadow-twin/
├── frontend/               # Static web app (Vercel deployment)
│   ├── index.html          # Dashboard shell
│   ├── app.js              # Three.js 3D viewer, WebSocket & REST client
│   ├── config.js           # Configurable backend endpoint (Render URL)
│   ├── styles.css          # Design system & styling
│   ├── vercel.json         # Pinned CSP, routing, cache headers
│   ├── models/             # 3D assets (tapas.glb, engine.glb, engine_low.glb)
│   └── vendor/             # Vendored Three.js r160 (runs offline)
│
├── backend/                # Python FastAPI web service (Render deployment)
│   ├── server.py           # Simulated ECUs, FastAPI, WebSocket /ws, REST APIs
│   ├── twin.py             # Engine twin orchestration, confidence gate, correlation
│   ├── mvem.py             # Mean value engine physics model
│   ├── can_bus.py          # CAN encode/decode (virtual or socketcan)
│   ├── detect.py           # Anomaly detection, fault classifier, RUL
│   ├── trust.py            # Sensor trust gateway
│   ├── train.py            # Generates training data from physics, fits detectors
│   ├── evaluate.py         # Severity sweep & validation
│   ├── models.pkl          # Trained detector artifact (scikit-learn 1.8.0)
│   ├── requirements.txt    # Python dependencies (scikit-learn==1.8.0)
│   ├── render.yaml         # Render blueprint
│   └── dbc/engine.dbc      # 8 J1939 CAN messages specification
│
├── vercel.json             # Root Vercel config (auto-targets frontend/)
├── render.yaml             # Root Render blueprint (rootDir: backend)
├── server.py               # Root convenience runner (subprocess chdir to backend)
├── main.py                 # Root convenience runner
├── requirements.txt        # Root dependencies mirror
└── AGENTS.md               # Project design rules and context
```

---

## Local Development (Single Command)

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Start server (runs backend and mounts frontend automatically)
python server.py
```

Open **http://localhost:8000** in your browser.

To run against a real bus instead of simulated ECUs:
```bash
sudo modprobe vcan && sudo ip link add dev vcan0 type vcan && sudo ip link set up vcan0
SHADOWTWIN_CAN=vcan0 python server.py
```

---

## Deployment

### 1. Backend on Render

1. Connect this repository to **Render**.
2. Render will automatically detect `render.yaml` (or create a **Web Service** manually):
   - **Root Directory:** `backend` (or leave blank if using root `render.yaml`)
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `uvicorn server:app --host 0.0.0.0 --port $PORT`
   - **Python Version:** `3.12.2` (configured in `.python-version`)
3. Note your service URL (e.g. `https://shadow-twin.onrender.com`).

> **Tip:** If Render caches an earlier scikit-learn build, select **Clear build cache & deploy** from the Render dashboard.

### 2. Frontend on Vercel

1. Connect this repository to **Vercel**.
2. Vercel automatically detects `vercel.json` and serves `frontend/`:
   - **Framework Preset:** Other
   - **Root Directory:** `./` (or `frontend`)
3. Set your backend URL in `frontend/config.js`:
   ```javascript
   window.SHADOWTWIN_BACKEND_URL = 'https://shadow-twin.onrender.com';
   ```
   Or pass it dynamically via the URL query parameter:
   ```
   https://shadow-twin.vercel.app?backend=https://shadow-twin.onrender.com
   ```
4. Once your Vercel URL is confirmed, tighten CORS in `backend/server.py` from `allow_origins=['*']` to `allow_origins=['https://your-app.vercel.app']`.

---

## Features

- **Mean Value Engine Model (MVEM):** Computes physically expected values for 8 CAN telemetry channels across varying throttle, altitude, and OAT conditions.
- **Sensor Trust Gateway:** Separates instrumentation failure from powerplant failure (range, frozen, rate, corroboration, envelope).
- **Residual-based ML Anomaly Detection:** Robust z-score fused with Isolation Forest, followed by gradient-boosted fault classification.
- **Cross-Engine Correlation:** Compares port and starboard residual vectors to distinguish independent engine faults from shared root causes (fuel contamination, intake icing).
- **Remaining Useful Life (RUL):** Drift rate estimation with p10/p90 uncertainty bounds. Configurable acceleration with `SHADOWTWIN_TIME_SCALE`.
- **Interactive 3D Digital Twin:** Built with Three.js (vendored offline, zero external CDN dependencies), featuring callout labels, dynamic exploded view on fault, and real-time telemetry streaming over WebSocket.

---

For architecture principles and honesty constraints, see [AGENTS.md](AGENTS.md).
