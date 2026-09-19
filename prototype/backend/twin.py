"""The twin: one per engine, plus cross-engine correlation across the pair.

Order of operations per tick, and the order matters:

  1. decode CAN                 - telemetry arrives as frames, not dicts
  2. physics twin steps         - what a healthy engine would read, here, now
  3. residual = measured - expected
  4. trust gateway              - is the *sensor* believable?
  5. detect and classify        - only on channels that survived step 4
  6. confidence gate            - refuse to score when the basis is too thin
  7. RUL                        - project the health index, with an interval
  8. correlate across engines   - shared cause, or two independent faults?
"""

import time
import numpy as np
import pickle
import os
from mvem import MeanValueEngineModel, Health
from trust import TrustGateway
from detect import (Detector, ResidualWindow, RUL, FEATURES,
                    FAULT_PARTS, FAULT_TEXT)

MODEL_PATH = os.path.join(os.path.dirname(__file__), 'models.pkl')

# how much of the sensor set has to be trustworthy before health is scored at all
MIN_COVERAGE = 0.80
# classifier probability below which we name no specific fault
MIN_NAME_CONF = 0.45


class EngineTwin:
    def __init__(self, side: str, detector: Detector, dt=0.1, time_scale=1.0):
        self.side = side
        self.dt = dt
        self.time_scale = time_scale
        self.det = detector
        self.model = MeanValueEngineModel()
        self.model.reset()
        self.trust = TrustGateway(dt=dt)
        self.window = ResidualWindow(size=120)
        self.rul = RUL(tbo_hours=1200.0)
        self.hours = float(np.random.default_rng(abs(hash(side)) % 2**31).uniform(120, 460))
        self.health_ema = 1.0
        self.last = None

    def _resync(self, measured):
        """Pull the twin's slow states back toward measurement while healthy.

        The thermal and manifold states are integrators. Once a real fault heats the
        head, the twin and the engine diverge, and nothing in an open-loop model
        brings them back together - the twin keeps reporting a residual long after
        the fault is gone. This is the observer correction that closes that loop.

        It runs ONLY when the detector says nominal. Correcting during a fault would
        quietly absorb the fault into the model and erase the very signal being
        looked for. The gain is deliberately small: it removes drift over tens of
        seconds without being able to track a developing fault.
        """
        g = 0.02
        st = self.model.state
        if measured.get('cht_c') is not None:
            st.T_cht += g * (measured['cht_c'] - st.T_cht)
        if measured.get('oil_temp_c') is not None:
            st.T_oil += g * (measured['oil_temp_c'] - st.T_oil)
        if measured.get('egt_c') is not None:
            st.T_egt += g * (measured['egt_c'] - st.T_egt)
        if measured.get('p_man_kpa') is not None:
            st.p_man += g * (measured['p_man_kpa'] - st.p_man)

    def step(self, measured: dict, throttle: float, altitude_m: float, oat_c: float):
        # 2. what should a healthy engine be doing at this operating point
        expected = self.model.step(
            self.dt, throttle, altitude_m, oat_c, None,
            rpm_command=measured.get('rpm'))

        # 3. residuals
        residual = {}
        for f in FEATURES:
            if measured.get(f) is not None and expected.get(f) is not None:
                residual[f] = measured[f] - expected[f]
        self.window.push(residual)
        sigma = self.window.sigma()

        # 4. can we believe the sensors
        self.trust.check_envelope(altitude_m, oat_c, measured.get('rpm', 0) or 0)
        trust = self.trust.evaluate(measured, expected, sigma)
        tsum = TrustGateway.summarise(trust)

        result = {
            'side': self.side,
            'measured': {k: _r(v) for k, v in measured.items() if not isinstance(v, list)},
            'expected': {k: _r(expected.get(k)) for k in FEATURES},
            'residual': {k: _r(v) for k, v in residual.items()},
            'trust': trust,
            'trust_summary': tsum,
            'hours_run': round(self.hours, 1),
            'parts': {},
            'evidence': [],
            'instrumentation': _instrumentation(trust),
        }

        # 6. confidence gate, part one: not enough trustworthy sensors
        if tsum['coverage'] < MIN_COVERAGE:
            result.update(
                status='not_evaluated',
                confidence=None,
                headline='Engine health not evaluated',
                detail=_gate_reason(tsum, self.trust),
                rul=None)
            self.last = result
            return result

        # 6b. gate part two: not enough history yet
        if not self.window.ready() or not self.det.trained:
            result.update(
                status='not_evaluated', confidence=None,
                headline='Engine health not evaluated',
                detail='Collecting baseline, not enough history to judge yet.',
                rul=None)
            self.last = result
            return result

        # 5. detect and classify
        x = self.window.feature_vector()
        anomalous, severity = self.det.anomaly(x)
        label, prob, proba_all = self.det.classify(x)

        # health index and RUL
        self.health_ema = 0.995 * self.health_ema + 0.005 * (1.0 - severity)
        self.hours += (self.dt / 3600.0) * self.time_scale
        self.rul.push(self.hours, self.health_ema)
        rul = self.rul.estimate()

        if not anomalous or label == 'healthy':
            self._resync(measured)
            result.update(
                status='nominal', confidence=round(1.0 - severity, 3),
                headline='Nominal',
                detail='Measurements track the physics model across all trusted channels.',
                severity=severity, rul=rul)
            self.last = result
            return result

        # anomalous, but is it nameable?
        if prob < MIN_NAME_CONF:
            result.update(
                status='anomaly_unclassified',
                confidence=round(prob, 3),
                headline='Anomaly detected, cause not identified',
                detail=('Behaviour is outside the healthy envelope but does not match a '
                        'known fault signature closely enough to name one.'),
                severity=severity, rul=rul,
                evidence=self.det.contributions(x))
            self.last = result
            return result

        parts = dict(FAULT_PARTS.get(label, {}))
        # injector faults: point at the cylinder whose timing residual is worst
        if 'injector' in parts:
            idx = _worst_injector(measured)
            parts[f'injector_{idx}'] = parts.pop('injector')

        result.update(
            status='fault' if severity > 0.45 else 'caution',
            confidence=round(prob, 3),
            headline=FAULT_TEXT.get(label, label),
            detail=_detail_for(label, self.det.contributions(x)),
            fault=label, severity=severity, rul=rul,
            parts=parts,
            evidence=self.det.contributions(x),
            probabilities=proba_all)
        self.last = result
        return result


def _instrumentation(trust: dict):
    """Sensor problems are always reported, even when the engine itself is fine.

    A dead channel that never surfaces is worse than a false alarm: the operator
    believes they are being watched on a channel that stopped reporting. These are
    deliberately kept separate from engine findings so the two are never confused.
    """
    out = []
    for ch, v in trust.items():
        if v['status'] == 'trusted':
            continue
        out.append(dict(
            channel=ch,
            pretty=_pretty(ch),
            status=v['status'],
            reason=v['reason'],
            headline=('%s not trusted' % _pretty(ch)).capitalize(),
            detail=('%s: %s. Reported as an instrumentation problem, not an engine '
                    'problem - other channels stayed consistent with the model.'
                    % (_pretty(ch).capitalize(), v['reason'])),
        ))
    return out



def _r(v, n=3):
    try:
        return round(float(v), n)
    except (TypeError, ValueError):
        return None


def _worst_injector(measured):
    t = measured.get('inj_timing')
    if not t or any(v is None for v in t):
        return 1
    a = np.asarray(t, dtype=float)
    return int(np.argmax(np.abs(a - np.median(a)))) + 1


def _gate_reason(tsum, gateway):
    if not gateway.envelope_ok:
        return (f'Operating point is outside the region the model is calibrated for '
                f'({gateway.envelope_reason}). Health is not scored here rather than '
                f'guessed.')
    bad = tsum['quarantined'] + tsum['suspect']
    names = ', '.join(_pretty(b) for b in bad[:3]) or 'several channels'
    return (f'Too few trustworthy channels to judge engine health ({names}). '
            f'Reported as an instrumentation problem, not an engine problem.')


def _detail_for(label, contributions):
    if not contributions:
        return FAULT_TEXT.get(label, label)
    drivers = ', '.join(f"{_pretty(c['feature'])} ({c['z']:.0f}\u03c3)" for c in contributions[:2])
    return f'Driven mainly by {drivers} against the modelled value.'


_PRETTY = {
    'rpm': 'engine speed', 'cht_c': 'cylinder head temp', 'egt_c': 'exhaust temp',
    'oil_temp_c': 'oil temp', 'oil_press_bar': 'oil pressure', 'boost_bar': 'boost',
    'fuel_rate_lph': 'fuel flow', 'vibration_mms': 'vibration',
}


def _pretty(s):
    for k, v in _PRETTY.items():
        if s.startswith(k):
            return s.replace(k, v, 1)
    return s


# --------------------------------------------------------------- correlation

def correlate(port: dict, starboard: dict):
    """Same signature on both engines points at a shared cause - fuel batch,
    ambient conditions, a calibration shift - rather than two engines
    independently developing the same fault on the same flight.

    A single-engine twin cannot produce this evidence at all.
    """
    if not port or not starboard:
        return None
    if port.get('status') in (None, 'not_evaluated') or starboard.get('status') in (None, 'not_evaluated'):
        return None

    pr, sr = port.get('residual', {}), starboard.get('residual', {})
    keys = [k for k in FEATURES if k in pr and k in sr]
    if len(keys) < 5:
        return None

    a = np.asarray([pr[k] for k in keys], dtype=float)
    b = np.asarray([sr[k] for k in keys], dtype=float)
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na < 1e-6 or nb < 1e-6:
        return None
    cos = float(np.dot(a, b) / (na * nb))

    both_off = (port.get('status') in ('fault', 'caution', 'anomaly_unclassified')
                and starboard.get('status') in ('fault', 'caution', 'anomaly_unclassified'))
    same_label = port.get('fault') and port.get('fault') == starboard.get('fault')

    if both_off and cos > 0.80:
        return dict(
            kind='shared_cause',
            similarity=round(cos, 3),
            headline='Matching deviation on both engines',
            detail=('Port and starboard residuals point the same way '
                    f'(similarity {cos:.2f}). A shared cause - fuel, ambient conditions '
                    'or a calibration shift - is more likely than the same fault '
                    'appearing independently on both engines.'),
            same_fault=bool(same_label))
    if both_off:
        return dict(
            kind='independent',
            similarity=round(cos, 3),
            headline='Both engines deviating, but differently',
            detail=('Both engines are outside nominal but their residuals do not align '
                    f'(similarity {cos:.2f}). Treat as two separate findings.'),
            same_fault=bool(same_label))
    return None


def mission_margin(port: dict, starboard: dict, hours_required: float):
    """Can the pair finish the sortie, and what is left if one quits.

    Reported separately for both-engine and single-engine cases, because on a twin
    those are different questions and only the second one decides whether the
    aircraft comes home.
    """
    def h(r):
        if not r or not r.get('rul'):
            return None
        return r['rul']

    ph, sh = h(port), h(starboard)
    if ph is None or sh is None:
        return dict(status='not_evaluated',
                    detail='Not enough basis to project mission margin yet.')

    # Bug A: at_limit check. If either engine is at or past its limit, do not do
    # arithmetic with a zero projection. Report not_evaluated with a plain sentence.
    p_at = ph.get('at_limit', False)
    s_at = sh.get('at_limit', False)
    if p_at and s_at:
        return dict(status='not_evaluated',
                    detail='Both engines are at their degradation limit.')
    if p_at:
        return dict(status='not_evaluated',
                    detail='Port engine is at its degradation limit.')
    if s_at:
        return dict(status='not_evaluated',
                    detail='Starboard engine is at its degradation limit.')

    # Conservative hours: each engine contributes either its degradation P10 or its
    # TBO-limited hours (when no degradation trend is detected).
    p_val = ph.get('p10') if ph.get('p10') is not None else ph.get('hours')
    s_val = sh.get('p10') if sh.get('p10') is not None else sh.get('hours')
    if p_val is None or s_val is None:
        return dict(status='not_evaluated',
                    detail='Not enough basis to project mission margin yet.')

    # Pair margin is min() across whichever field each engine contributes.
    # In the mixed case (e.g. one TBO-limited at 900 h, one degrading at P10 40 h),
    # min() ensures the healthy engine's high TBO cannot mask the degrading engine.
    pair_p10 = min(p_val, s_val)
    # Known limitation (§17): engine_out_margin_hours currently equals pair_p10.
    worst_single = min(p_val, s_val)
    ok_pair = pair_p10 >= hours_required
    ok_single = worst_single >= hours_required

    both_degrading = ph.get('p10') is not None and sh.get('p10') is not None
    label = 'pessimistic (P10) margin' if both_degrading else 'pessimistic margin'
    conf_basis = ('P10 of a bootstrapped degradation fit, not a point estimate'
                  if both_degrading else
                  'Conservative margin based on degradation fit / TBO limit')

    return dict(
        status='ok' if ok_pair else 'marginal',
        hours_required=hours_required,
        port=ph, starboard=sh,
        pair_margin_hours=round(pair_p10 - hours_required, 1),
        engine_out_margin_hours=round(worst_single - hours_required, 1),
        detail=(f'On both engines the {label} is '
                f'{pair_p10 - hours_required:+.1f} h against a {hours_required:.1f} h sortie. '
                f'If one engine is lost, the remaining margin is '
                f'{worst_single - hours_required:+.1f} h.'),
        confidence_basis=conf_basis)


def load_detector():
    if os.path.exists(MODEL_PATH):
        with open(MODEL_PATH, 'rb') as f:
            return pickle.load(f)
    d = Detector()
    d.trained = False
    return d
