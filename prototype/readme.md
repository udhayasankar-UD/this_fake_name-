# Aero engine digital twin — working MVP

A digital twin for the twin aero-diesel powerplant of a MALE UAV. Telemetry moves
over real CAN frames, a mean value engine model predicts what a healthy engine
should be reading at the current operating point, and the difference between the
two drives anomaly detection, fault classification, remaining useful life and a
cross-engine correlation that single-engine prototypes cannot produce.

The design commitment: the system states how sure it is, and refuses to score
health when the basis is too thin, rather than showing a confident green.

## Run it

```
cd prototype/backend
pip install -r requirements.txt
python3 train.py        # ~2 min, generates data from the physics model and fits
python3 server.py       # API, websocket and dashboard
```

Open http://localhost:8000

To run against a real bus instead of the simulated ECUs:

```
sudo modprobe vcan && sudo ip link add dev vcan0 type vcan && sudo ip link set up vcan0
AEROTWIN_CAN=vcan0 python3 server.py
```

Nothing downstream of the decoder changes. The simulator only ever produces CAN
frames; it is not wired into the twin.

## What to try

| Button | What happens |
|---|---|
| Injector fault, port | Port goes red. Injector 3 is named and tinted on the 3d model, common rail put on watch, with the residuals that drove the call and their sigma. |
| Sensor fault, starboard | The cylinder head temp channel freezes. The engine stays **nominal** and a separate sensor finding is raised. A dead channel is an instrumentation problem, not an engine problem. |
| Both engines drift | Both engines flag the same fault. The system compares the two residual vectors and reports a shared cause rather than two independent faults. |

## Exploded view

The engine stays assembled while it is healthy. When a part is implicated, only that
part lifts out of the assembly along its own outward axis and carries a short label:
`Injector 3 — low delivery`, `Common rail — pressure suspect`. Clearing the fault
puts it back and removes the label.

Nothing moves unless something is wrong, so the view itself carries the finding. The
labels are HTML positioned by projecting the part's world position to screen space
each frame, which costs nothing on a weak GPU compared with 3d text geometry.

## Architecture

```
simulated ECU  ->  CAN frames (DBC encoded)  ->  decode
                                                  |
                             mean value engine model (expected)
                                                  |
                              residual = measured - expected
                                                  |
                                          trust gateway
                                    (range, frozen, rate,
                                 corroboration, envelope)
                                                  |
                              +-------------------+-------------------+
                              |                                       |
                   robust z + isolation forest            gradient boosted
                        (is this normal?)                fault classifier
                              |                                       |
                              +-------------------+-------------------+
                                                  |
                                          confidence gate
                                                  |
                                    RUL  +  cross-engine correlation
                                                  |
                                      websocket -> dashboard
```

| File | Role |
|---|---|
| `mvem.py` | Mean value engine model. ISA lapse, turbo with wastegate, volumetric efficiency, Chen-Flynn friction, lumped thermal states, smoke limiter. |
| `dbc/engine.dbc` | 8 CAN messages. Real J1939 PGNs where they exist: EEC1 61444, ET1 65262, EFL_P1 65263. |
| `can_bus.py` | Encode and decode. SocketCAN when available, python-can virtual otherwise. |
| `trust.py` | Sensor trust gateway. |
| `detect.py` | Anomaly detection, fault classification, RUL. |
| `twin.py` | Per-engine orchestration, confidence gate, correlation, mission margin. |
| `server.py` | Simulated ECUs, FastAPI, websocket, static hosting. |
| `train.py` | Generates training data from the physics model and fits the detectors. |
| `evaluate.py` | Severity sweep. Reports where the detector stops working. |

## Why residuals rather than raw telemetry

A model fed raw sensor values has to learn every operating condition *and* every
fault, and never sees enough data to do both — high cylinder head temp means
something completely different in a hot-day climb than in a cold cruise. The
physics model divides the operating point out first, so the detectors only ever
see "how far from healthy, here, now".

## Measured behaviour

From `evaluate.py`, on held-out segments with randomised flight profiles:

| Fault severity | Detected | Correctly named |
|---|---|---|
| 0.10 | 22% | 6% |
| 0.20 | 53% | 31% |
| 0.35 | 100% | 92% |
| 0.50 | 100% | 94% |
| 0.75 | 100% | 100% |

False positives on healthy engines: 0 of 36.

The model genuinely does not work below about 0.20 severity. That row is in the
table on purpose. A detector with no stated failure point has not been tested.

Physics sanity, from `mvem.py`:

| Condition | Power | CHT | EGT | Oil press |
|---|---|---|---|---|
| Sea level, full | 138 hp | 230 °C | 704 °C | 3.80 bar |
| 4500 m, cruise | 80 hp | 160 °C | 690 °C | 3.90 bar |
| 9000 m, full | 89 hp | 199 °C | 770 °C | 4.34 bar |

Power falls with altitude, EGT rises as cooling air thins, oil pressure rises as
the oil runs cooler. The smoke limiter holds lambda at 1.28 rather than letting the
engine run rich as air density falls.

## Three bugs worth knowing about

Found by testing, not by reading the code. Each would have shipped silently.

**Isolation Forest scored severe faults as normal.** Fault feature vectors sat up to
423 sigma from healthy and still returned a positive (inlier) score. Its trees split
on thresholds drawn from the training range, so a point far outside that range
inherits the path length of the nearest boundary leaf. Fixed by fusing it with a
robust median/MAD z-score, which extrapolates correctly, and squashing features
through `tanh(z/4)` so "far away" stays far away.

**CAN quantisation looked like a dead sensor.** Manifold pressure is carried at
2 kPa per bit, so at steady cruise consecutive samples are bit-identical and an
equality-based frozen check quarantined a healthy channel forever. The check now
asks whether the channel produced any distinct value across the window.

**A real engine fault was being blamed on a sensor.** The corroboration rule marks a
channel suspect when it disagrees with the model while its partners stay nominal —
which is also exactly what an injector fault looks like from the vibration channel.
Corroboration is now skipped when more than one channel has drifted, because a
sensor fault moves one channel and an engine fault moves several.

## Low-end devices

Device tier is detected from `hardwareConcurrency`, `deviceMemory` and pointer type.

| | low | mid | high |
|---|---|---|---|
| frame cap | 24 fps | 30 fps | 60 fps |
| pixel ratio | 1.0 | 1.4 | 1.8 |
| engine model | `engine_low.glb` | `engine_low.glb` | `engine.glb` |
| antialiasing | off | off | on |

- Meshes are pre-merged into 14 groups from 895, the airframe into 3 from 197.
  Draw calls, not triangles, are what stall weak GPUs.
- The 5 MB engine model is not fetched until an engine is first opened. The
  aircraft view costs 0.5 MB.
- Rendering is on demand and stops when the tab is hidden.
- No shadow maps, no post-processing, two lights.
- No Draco, so there is no WebAssembly decoder to fetch or fail.
- three.js is vendored into `vendor/`, so the whole thing runs with no internet.
- `prefers-reduced-motion` disables damping and transitions.

## Content Security Policy

The server sends a strict policy with no `unsafe-inline` anywhere:

```
default-src 'self'; script-src 'self'; style-src 'self';
img-src 'self' data: blob:; connect-src 'self' ws: wss:;
worker-src 'self' blob:; object-src 'none'; base-uri 'none'
```

The page complies with it rather than asking for exceptions: no inline scripts, no
inline style attributes, no importmap, no external origins. ES modules resolve
through relative paths into `vendor/`.

If the browser reports `default-src 'none'` blocking `styles.css` and `app.js`, that
policy is not coming from this server — check `curl -I http://localhost:8000/` to see
what is actually sent. `default-src 'none'` blocks every resource including
same-origin files, so nothing can run under it. It is normally injected by a browser
extension, by VS Code's Simple Browser or Live Preview webview, or by a port-forward
or corporate proxy. Open the page in an ordinary browser window to rule those out.

## What is not real yet

- **The ECUs are simulated.** Walled off behind the CAN encoder, but the engine on
  the other end of the bus is a model, not hardware.
- **Faults are seeded, not observed.** No public run-to-failure dataset exists for
  this engine class. The evaluation measures separation of fault signatures from
  operating-point variation. It is not a field validation and should not be
  presented as one.
- **The twin runs a gated observer.** The thermal and manifold states are
  integrators, so once a real fault heats the head the twin and the engine diverge
  and an open-loop model never reconverges - it keeps reporting a residual long
  after the fault has gone. A small correction pulls the twin's slow states back
  toward measurement, but only while the detector says nominal: correcting during a
  fault would absorb the fault into the model and erase the signal. Measured
  recovery after clearing a fault is about 20 s, against a 12 s residual window.

- **The physics core is MVEM only.** The physics-informed heat-balance loss term for
  CHT and EGT is designed but not implemented.
- **RUL runs on an accelerated clock** so trends are visible in a demo lasting
  minutes. `AEROTWIN_TIME_SCALE` controls it; it affects the RUL time axis only,
  never the physics, which always steps at real dt.
