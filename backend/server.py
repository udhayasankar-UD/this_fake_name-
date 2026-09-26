"""Ground station service.

Runs two engine twins in lockstep with a simulated pair of ECUs, moves the
telemetry over real CAN frames, and streams results to the dashboard over a
WebSocket.

The ECU simulation is the only fake part, and it is deliberately walled off: it
produces CAN frames and nothing else. Everything downstream - decode, physics,
trust, detection, RUL, correlation - is the same code that would run against a
real bus. Point EngineBus at a socketcan channel and the simulator drops out.

Run:  python3 server.py
"""

import asyncio
import json
import math
import os
import random
import time

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse
import uvicorn

from mvem import MeanValueEngineModel, Health
from can_bus import EngineBus
from twin import EngineTwin, correlate, mission_margin, load_detector

DT = 0.1
STREAM_HZ = 5
# Degradation happens over hundreds of flight hours. To make trends observable in a
# demo that runs for minutes, flight time advances faster than wall clock. This
# affects the RUL time axis only - never the physics, which steps at real DT.
TIME_SCALE = float(os.environ.get('SHADOWTWIN_TIME_SCALE', '120'))
SOCKETCAN_CHANNEL = os.environ.get('SHADOWTWIN_CAN')   # e.g. "vcan0"

app = FastAPI(title='shadow-twin ground service')

# CORS: '*' is intentional for the initial Render deploy.
# Once the Vercel frontend URL is confirmed, tighten to:
# allow_origins=['https://shadow-twin.vercel.app']
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'],
                   allow_headers=['*'])

# The dashboard is fully self-contained: no external scripts, styles, fonts or
# images, and it talks only to this origin. Declaring that explicitly means the
# page states what it needs instead of relying on a permissive default.
CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self'; "
    "img-src 'self' data: blob:; "
    "connect-src 'self' ws: wss:; "
    "worker-src 'self' blob:; "
    "object-src 'none'; "
    "base-uri 'none'; "
    "frame-ancestors 'self'"
)


@app.middleware('http')
async def security_headers(request, call_next):
    response = await call_next(request)
    response.headers['Content-Security-Policy'] = CSP
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


# ----------------------------------------------------------------- ECU sim

class SimulatedECU:
    """Stands in for a real engine + ECU. Produces telemetry; the rest of the
    system only ever sees the CAN frames it encodes."""

    def __init__(self, side, seed=0):
        self.side = side
        self.engine = MeanValueEngineModel()
        self.engine.reset()
        self.health = Health()
        self.rng = random.Random(seed)
        self.noise = {'rpm': 5.0, 'cht_c': 0.9, 'egt_c': 4.5, 'oil_temp_c': 0.5,
                      'oil_press_bar': 0.04, 'p_man_kpa': 1.5,
                      'fuel_rate_lph': 0.3, 'vibration_mms': 0.09,
                      'T_man_c': 0.4, 'rail_bar': 3.0}
        self.stuck = {}          # channel -> frozen value, simulates a dead sensor
        self.injected = None

    def inject(self, kind, severity=0.7):
        self.health = Health()
        self.stuck = {}
        self.injected = kind
        if kind is None:
            return
        if kind == 'injector_underflow':
            self.health.injector_flow = [1.0, 1.0, 1.0 - 0.45 * severity, 1.0]
        elif kind == 'cooling_degradation':
            self.health.cooling_effectiveness = 1.0 - 0.45 * severity
        elif kind == 'lubrication_loss':
            self.health.oil_pump_effectiveness = 1.0 - 0.40 * severity
        elif kind == 'turbo_underperformance':
            self.health.turbo_efficiency = 1.0 - 0.30 * severity
        elif kind == 'ring_blowby':
            self.health.ring_seal = 1.0 - 0.22 * severity
            self.health.bearing_wear = 0.16 * severity
        elif kind == 'sensor_stuck':
            self.stuck['cht_c'] = None       # captured on first sample

    def step(self, throttle, altitude_m, oat_c):
        t = self.engine.step(DT, throttle, altitude_m, oat_c, self.health)
        out = dict(t)
        for k, s in self.noise.items():
            if k in out:
                out[k] += self.rng.gauss(0, s)
        # boost is derived from the manifold pressure that actually goes on the bus
        out['boost_bar'] = out['p_man_kpa'] / 100.0

        for ch in self.stuck:
            if self.stuck[ch] is None:
                self.stuck[ch] = out.get(ch, 0.0)
            out[ch] = self.stuck[ch]

        base = -8.5
        spread = [(f - 1.0) * 6.0 for f in self.health.injector_flow]
        for i in range(4):
            out[f'inj{i+1}_deg'] = base + spread[i] + self.rng.gauss(0, 0.05)
        out['torque_pct'] = max(-125, min(125, t['power_kw'] / 1.34))
        out['demand_pct'] = out['torque_pct']
        out['alt_volts'] = 28.2 + self.rng.gauss(0, 0.06)
        out['alt_amps'] = 42.0 + self.rng.gauss(0, 1.2)
        return out


# ----------------------------------------------------------------- state

class Station:
    def __init__(self):
        self.bus = EngineBus(channel=SOCKETCAN_CHANNEL)
        self.det = load_detector()
        self.ecu = {'port': SimulatedECU('port', 1), 'starboard': SimulatedECU('starboard', 2)}
        self.twin = {'port': EngineTwin('port', self.det, DT, TIME_SCALE),
                     'starboard': EngineTwin('starboard', self.det, DT, TIME_SCALE)}
        self.throttle = 0.66
        self.altitude = 4200.0
        self.oat = 12.0
        self.mission_hours = 14.0
        self.t0 = time.time()
        self.latest = {}
        self.clients = set()
        self.frames_sent = 0
        self.frames_decoded = 0

    def set_condition(self, **kw):
        for k in ('throttle', 'altitude', 'oat', 'mission_hours'):
            if kw.get(k) is not None:
                setattr(self, k, float(kw[k]))

    async def run(self):
        while True:
            # gentle mission drift so the operating point is never static
            phase = (time.time() - self.t0) / 90.0
            thr = min(0.98, max(0.30, self.throttle + 0.03 * math.sin(phase)))
            alt = max(0.0, self.altitude + 60.0 * math.sin(phase / 2.3))

            # 1. ECUs produce telemetry and put it on the bus as real frames
            for side, ecu in self.ecu.items():
                t = ecu.step(thr, alt, self.oat)
                self.frames_sent += self.bus.publish(side, t)

            # 2. the twin only ever sees decoded frames
            decoded = self.bus.drain()
            results = {}
            for side, sig in decoded.items():
                if not sig:
                    continue
                self.frames_decoded += 1
                meas = EngineBus.to_telemetry(sig)
                results[side] = self.twin[side].step(meas, thr, alt, self.oat)

            if results:
                corr = correlate(results.get('port'), results.get('starboard'))
                margin = mission_margin(results.get('port'), results.get('starboard'),
                                        self.mission_hours)
                self.latest = {
                    'ts': round(time.time(), 2),
                    'condition': {'throttle': round(thr, 3), 'altitude_m': round(alt, 1),
                                  'oat_c': self.oat, 'mission_hours': self.mission_hours},
                    'engines': results,
                    'correlation': corr,
                    'mission': margin,
                    'bus': {'backend': self.bus.backend,
                            'frames_sent': self.frames_sent,
                            'decodes': self.frames_decoded},
                }
            await asyncio.sleep(DT)


station = Station()


@app.on_event('startup')
async def _startup():
    asyncio.create_task(station.run())


@app.api_route('/health', methods=['GET', 'HEAD'])
async def health():
    """Instant liveness probe. Used by the UptimeRobot keep-alive ping and by the
    frontend wake-up ping. Deliberately does no work."""
    return {'status': 'ok', 'ready': bool(station.latest)}


@app.get('/api/state')
async def state():
    return JSONResponse(station.latest or {'status': 'starting'})


@app.post('/api/inject')
async def inject(payload: dict):
    side = payload.get('side')
    kind = payload.get('fault')
    sev = float(payload.get('severity', 0.7))
    if side == 'both':
        for s in station.ecu:
            station.ecu[s].inject(kind, sev)
    elif side in station.ecu:
        station.ecu[side].inject(kind, sev)
    else:
        return JSONResponse({'error': 'unknown side'}, status_code=400)
    return {'ok': True, 'side': side, 'fault': kind, 'severity': sev}


@app.post('/api/condition')
async def condition(payload: dict):
    station.set_condition(**payload)
    return {'ok': True, 'condition': {
        'throttle': station.throttle, 'altitude': station.altitude,
        'oat': station.oat, 'mission_hours': station.mission_hours}}


@app.websocket('/ws')
async def ws(sock: WebSocket):
    await sock.accept()
    station.clients.add(sock)
    try:
        while True:
            if station.latest:
                await sock.send_text(json.dumps(station.latest))
            await asyncio.sleep(1.0 / STREAM_HZ)
    except WebSocketDisconnect:
        pass
    finally:
        station.clients.discard(sock)


_backend_dir = os.path.dirname(os.path.abspath(__file__))
_frontend_dir = os.path.join(os.path.dirname(_backend_dir), 'frontend')
if not os.path.isdir(_frontend_dir):
    _frontend_dir = os.path.join(_backend_dir, 'frontend')

if os.path.isdir(_frontend_dir):
    app.mount('/', StaticFiles(directory=_frontend_dir, html=True), name='ui')


if __name__ == '__main__':
    print(f'CAN backend: {station.bus.backend}')
    print(f'detector trained: {station.det.trained}')
    port = int(os.environ.get('PORT', 8000))
    uvicorn.run(app, host='0.0.0.0', port=port, log_level='warning')
