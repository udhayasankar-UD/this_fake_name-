"""Sensor trust gateway.

Every channel is scored before it is allowed to influence engine health. The
point is to separate "this sensor is wrong" from "this engine is sick", because
treating the first as the second is how a monitoring system loses its operator.

Five checks, cheapest first:
  1. range        - physically impossible value
  2. frozen       - unnaturally constant, the signature of a dead channel
  3. rate         - changed faster than the physical system can move
  4. corroborate  - disagrees with channels it is physically coupled to
  5. envelope     - operating point outside where the twin is calibrated

A channel that fails 1-3 is quarantined outright. A channel that fails only 4 is
marked suspect: it still might be the engine, so the decision is pushed to the
correlation stage rather than silently dropped.
"""

from collections import deque, defaultdict

# physical limits and maximum plausible rate of change per second
LIMITS = {
    'rpm':           dict(lo=0,     hi=4000,  max_rate=900.0),
    'cht_c':         dict(lo=-40,   hi=400,   max_rate=60.0),
    'egt_c':         dict(lo=-40,   hi=1300,  max_rate=400.0),
    'oil_temp_c':    dict(lo=-40,   hi=200,   max_rate=40.0),
    'oil_press_bar': dict(lo=0.0,   hi=12.0,  max_rate=4.0),
    'boost_bar':     dict(lo=0.3,   hi=4.5,   max_rate=3.0),
    'fuel_rate_lph': dict(lo=0.0,   hi=80.0,  max_rate=40.0),
    'vibration_mms': dict(lo=0.0,   hi=60.0,  max_rate=30.0),
    'rail_bar':      dict(lo=0.0,   hi=2200,  max_rate=1500.0),
}

# channels that should move together. If A moves well outside its expected band
# while every partner sits nominal, A is more likely to be a bad sensor.
COUPLED = {
    'cht_c':         ['egt_c', 'oil_temp_c', 'fuel_rate_lph'],
    'egt_c':         ['cht_c', 'fuel_rate_lph', 'boost_bar'],
    'oil_temp_c':    ['cht_c', 'rpm', 'oil_press_bar'],
    'oil_press_bar': ['rpm', 'oil_temp_c'],
    'boost_bar':     ['rpm', 'fuel_rate_lph', 'egt_c'],
    'vibration_mms': ['rpm', 'egt_c', 'cht_c'],
}

# A rate check on raw samples compares two noisy readings, so at 10 Hz a couple of
# sigma of sensor noise looks like an impossible slew. Compare a short median
# instead: it rejects single-sample spikes while still catching a genuine step.
RATE_MEDIAN = 5

FROZEN_WINDOW = 25      # samples

# A channel arriving over CAN is quantised by the DBC scale factor, so successive
# samples are often bit-identical even on a perfectly healthy sensor. Testing for
# equality between consecutive samples therefore reports quantisation as a dead
# channel. The honest test is whether the channel produces ANY distinct value
# across the window - a live sensor dithers across at least two codes, a stuck one
# repeats exactly one.
FROZEN_MIN_DISTINCT = 2
CORROBORATE_SIGMA = 3.0


class ChannelTrust:
    __slots__ = ('name', 'hist', 'last', 'frozen_for', 'status', 'reason', 'score')

    def __init__(self, name):
        self.name = name
        self.hist = deque(maxlen=FROZEN_WINDOW)
        self.last = None
        self.frozen_for = 0
        self.status = 'trusted'
        self.reason = None
        self.score = 1.0


class TrustGateway:
    def __init__(self, dt=0.1):
        self.dt = dt
        self.ch = defaultdict(lambda: None)
        self.envelope_ok = True
        self.envelope_reason = None

    def _channel(self, name):
        if self.ch[name] is None:
            self.ch[name] = ChannelTrust(name)
        return self.ch[name]

    def check_envelope(self, altitude_m, oat_c, rpm):
        """Is the operating point inside the region the twin was calibrated for?"""
        problems = []
        if altitude_m > 9500:
            problems.append('altitude above calibrated ceiling')
        if oat_c < -45 or oat_c > 55:
            problems.append('ambient temperature outside calibrated range')
        if rpm < 500:
            problems.append('engine below calibrated speed range')
        self.envelope_ok = not problems
        self.envelope_reason = '; '.join(problems) if problems else None
        return self.envelope_ok

    def evaluate(self, measured: dict, expected: dict, residual_sigma: dict):
        """Score every channel. Returns {channel: {status, reason, score}}."""
        out = {}

        # --- checks 1-3, per channel independently
        for name, value in measured.items():
            if name not in LIMITS:
                continue
            c = self._channel(name)
            lim = LIMITS[name]
            status, reason = 'trusted', None

            if value is None or value != value:            # None or NaN
                status, reason = 'quarantined', 'no data'
            elif not (lim['lo'] <= value <= lim['hi']):
                status, reason = 'quarantined', 'outside physical range'
            else:
                if len(c.hist) >= RATE_MEDIAN:
                    recent = sorted(list(c.hist)[-RATE_MEDIAN:])
                    med = recent[len(recent) // 2]
                    rate = abs(value - med) / (self.dt * (RATE_MEDIAN / 2.0))
                    if rate > lim['max_rate']:
                        status, reason = 'quarantined', 'changed faster than physically possible'
                if len(c.hist) >= FROZEN_WINDOW:
                    distinct = len(set(round(v, 9) for v in c.hist))
                    if distinct < FROZEN_MIN_DISTINCT:
                        status, reason = 'quarantined', (
                            f'single unchanging value for '
                            f'{len(c.hist) * self.dt:.0f} s')

            c.hist.append(value)
            c.last = value
            c.status, c.reason = status, reason
            out[name] = dict(status=status, reason=reason, score=0.0 if status != 'trusted' else 1.0)

        # --- check 4: corroboration
        # Count how many channels are off the model at all. A sensor fault moves one
        # channel; an engine fault moves several. If more than one channel has
        # drifted, this is the engine talking and no channel gets called a liar.
        deviating = 0
        for n2 in expected:
            if n2 in measured and n2 in residual_sigma and measured[n2] is not None:
                if abs(measured[n2] - expected[n2]) / max(residual_sigma[n2], 1e-6) >= CORROBORATE_SIGMA:
                    deviating += 1

        for name, partners in COUPLED.items():
            if deviating > 1:
                break
            if name not in out or out[name]['status'] != 'trusted':
                continue
            if name not in expected or name not in residual_sigma:
                continue
            sig = max(residual_sigma[name], 1e-6)
            z = abs(measured[name] - expected[name]) / sig
            if z < CORROBORATE_SIGMA:
                continue
            partner_z = []
            for p in partners:
                if p in expected and p in residual_sigma and p in measured:
                    ps = max(residual_sigma[p], 1e-6)
                    partner_z.append(abs(measured[p] - expected[p]) / ps)
            if partner_z and max(partner_z) < 1.5:
                out[name] = dict(
                    status='suspect',
                    reason='disagrees with the model while coupled channels stay nominal',
                    score=0.35)

        # --- check 5: envelope, applies to everything at once
        if not self.envelope_ok:
            for name in out:
                if out[name]['status'] == 'trusted':
                    out[name] = dict(status='suspect',
                                     reason=f'outside calibrated envelope ({self.envelope_reason})',
                                     score=0.5)
        return out

    @staticmethod
    def summarise(trust: dict):
        q = [k for k, v in trust.items() if v['status'] == 'quarantined']
        s = [k for k, v in trust.items() if v['status'] == 'suspect']
        n = max(1, len(trust))
        coverage = 1.0 - (len(q) + 0.5 * len(s)) / n
        return dict(quarantined=q, suspect=s, coverage=round(coverage, 3))
