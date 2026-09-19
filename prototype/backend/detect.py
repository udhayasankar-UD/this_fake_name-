"""Detection, classification and remaining useful life.

Inputs are residuals, not raw sensor values. A residual is
    measured - what the physics model says a healthy engine would read here
so the operating point (throttle, altitude, temperature) has already been
divided out. That is the whole reason a physics core sits in front of the ML:
without it, a model has to learn every operating condition as well as every
fault, and it never sees enough data to do both.

Three stages:
  IsolationForest   unsupervised, trained only on healthy residuals. Answers
                    "is this normal?" without ever being shown a fault.
  GradientBoosting  supervised over labelled fault signatures. Answers
                    "which fault does this look like?"
  RUL               fits a degradation trend to a health index and projects it
                    to a limit, with a bootstrap interval rather than a point
                    estimate.
"""

import numpy as np
from collections import deque
from sklearn.ensemble import IsolationForest, GradientBoostingClassifier
from sklearn.preprocessing import StandardScaler

FEATURES = ['rpm', 'cht_c', 'egt_c', 'oil_temp_c', 'oil_press_bar',
            'boost_bar', 'fuel_rate_lph', 'vibration_mms']

FAULT_LABELS = [
    'healthy',
    'injector_underflow',
    'cooling_degradation',
    'lubrication_loss',
    'turbo_underperformance',
    'combustion_instability',
    'ring_blowby',
]

# which engine component each fault implicates, for the 3d view
FAULT_PARTS = {
    'injector_underflow':     {'injector': 'fault', 'common_rail': 'caution'},
    'cooling_degradation':    {'cooling': 'fault', 'cylinder_head': 'caution'},
    'lubrication_loss':       {'lubrication': 'fault', 'crankcase': 'caution'},
    'turbo_underperformance': {'turbocharger': 'fault', 'intake': 'caution'},
    'combustion_instability': {'intake': 'fault', 'exhaust': 'caution'},
    'ring_blowby':            {'crankcase': 'fault', 'cylinder_head': 'caution'},
}

FAULT_TEXT = {
    'injector_underflow':     'Injector delivery shortfall',
    'cooling_degradation':    'Cooling system losing effectiveness',
    'lubrication_loss':       'Oil pressure below modelled value',
    'turbo_underperformance': 'Turbocharger not making commanded boost',
    'combustion_instability': 'Combustion running outside expected band',
    'ring_blowby':            'Cylinder sealing degraded',
}


class ResidualWindow:
    """Rolling residual statistics. Feeds both the detectors and the trust gateway."""

    def __init__(self, size=120):
        self.size = size
        self.buf = {f: deque(maxlen=size) for f in FEATURES}

    def push(self, residual: dict):
        for f in FEATURES:
            if f in residual:
                self.buf[f].append(residual[f])

    def sigma(self):
        out = {}
        for f in FEATURES:
            b = self.buf[f]
            out[f] = float(np.std(b)) if len(b) > 8 else _PRIOR_SIGMA[f]
            if out[f] < _PRIOR_SIGMA[f] * 0.2:
                out[f] = _PRIOR_SIGMA[f] * 0.2
        return out

    def feature_vector(self):
        """Mean, spread and slope of each residual over the window."""
        v = []
        for f in FEATURES:
            b = list(self.buf[f])
            if len(b) < 10:
                v += [0.0, 0.0, 0.0]
                continue
            a = np.asarray(b, dtype=float)
            t = np.arange(len(a), dtype=float)
            slope = float(np.polyfit(t, a, 1)[0]) if len(a) > 4 else 0.0
            v += [float(a.mean()), float(a.std()), slope]
        return np.asarray(v, dtype=float)

    def ready(self):
        return len(self.buf[FEATURES[0]]) >= 30


# rough measurement noise, used before the window has filled
_PRIOR_SIGMA = {
    'rpm': 6.0, 'cht_c': 1.1, 'egt_c': 5.0, 'oil_temp_c': 0.6,
    'oil_press_bar': 0.05, 'boost_bar': 0.02, 'fuel_rate_lph': 0.35,
    'vibration_mms': 0.10,
}


class Detector:
    """Fused novelty detector.

    Two detectors vote, because neither is sufficient alone:

      robust z   median/MAD distance from the healthy residual distribution.
                 Extrapolates correctly and is directly explainable - you can
                 point at the channel that moved.
      isolation  IsolationForest over tanh-squashed features. Catches odd
                 *combinations* that no single channel would flag.

    The squash matters. IsolationForest splits on axis-aligned thresholds drawn
    from the training range, so a point far outside that range inherits the path
    length of the nearest boundary leaf and can score as perfectly normal. Passing
    features through tanh(z/4) bounds them into the trained range, so "far away"
    stays far away.
    """

    def __init__(self):
        self.scaler = StandardScaler()
        self.iforest = None
        self.clf = None
        self.med = None
        self.mad = None
        self.z_threshold = None
        self.trained = False

    # ---------------------------------------------------------- helpers

    def _robust(self, X):
        med = np.median(X, axis=0)
        mad = np.median(np.abs(X - med), axis=0) * 1.4826
        mad = np.where(mad < 1e-9, 1.0, mad)
        return med, mad

    def _z(self, x):
        return (x - self.med) / self.mad

    def _novelty(self, z):
        """Mean of the three largest absolute z scores."""
        a = np.sort(np.abs(z))[::-1]
        return float(a[:3].mean())

    @staticmethod
    def _squash(z):
        return np.tanh(z / 4.0)

    # ---------------------------------------------------------- fit

    def fit(self, healthy_X, labelled_X, labels):
        self.med, self.mad = self._robust(healthy_X)
        zh = (healthy_X - self.med) / self.mad
        self.z_threshold = float(np.percentile(
            [self._novelty(r) for r in zh], 99.0))

        self.iforest = IsolationForest(
            n_estimators=200, max_samples=256, contamination=0.01,
            random_state=0).fit(self._squash(zh))

        self.scaler.fit(labelled_X)
        self.clf = GradientBoostingClassifier(
            n_estimators=120, max_depth=3, learning_rate=0.1,
            random_state=0).fit(self.scaler.transform(labelled_X), labels)
        self.trained = True
        return self

    # ---------------------------------------------------------- score

    def anomaly(self, x):
        """Returns (is_anomalous, severity 0..1)."""
        z = self._z(x)
        nov = self._novelty(z)
        by_z = nov > self.z_threshold
        by_forest = bool(self.iforest.predict(self._squash(z).reshape(1, -1))[0] == -1)
        severity = float(np.clip((nov - self.z_threshold) /
                                 max(self.z_threshold * 3.0, 1e-6), 0.0, 1.0))
        if by_z and by_forest:
            severity = min(1.0, severity + 0.12)
        return bool(by_z or by_forest), round(severity, 3)

    def classify(self, x):
        xs = self.scaler.transform(x.reshape(1, -1))
        proba = self.clf.predict_proba(xs)[0]
        idx = int(np.argmax(proba))
        return self.clf.classes_[idx], float(proba[idx]), dict(
            zip(self.clf.classes_, [round(float(p), 3) for p in proba]))

    def contributions(self, x, top=3):
        """Which residual features drove this call. Robust z magnitude weighted by
        the classifier's own feature importances, so it reflects both how far the
        channel moved and how much the model relies on it."""
        z = np.abs(self._z(x))
        w = z * (self.clf.feature_importances_ + 0.05)
        names = []
        for f in FEATURES:
            names += [f'{f} level', f'{f} spread', f'{f} trend']
        order = np.argsort(w)[::-1][:top]
        total = float(w.sum()) or 1.0
        return [dict(feature=names[i],
                     z=round(float(z[i]), 2),
                     weight=round(float(w[i] / total), 3))
                for i in order if w[i] > 0]


class RUL:
    """Projects a health index to its limit and reports an interval.

    Deliberately simple and interpretable: fit a linear degradation rate over the
    recent history, bootstrap the fit to get a spread, and convert to hours. With
    no run-to-failure data for this engine class, a calibrated interval from a
    transparent model is more defensible than a point estimate from a deep one.
    """

    def __init__(self, tbo_hours=1200.0, window=400):
        self.tbo = tbo_hours
        self.hist = deque(maxlen=window)

    def push(self, hours_run, health_index):
        self.hist.append((hours_run, health_index))

    def estimate(self, limit=0.55):
        if len(self.hist) < 60:
            return None
        a = np.asarray(self.hist, dtype=float)
        t, y = a[:, 0], a[:, 1]
        span = float(t.max() - t.min())
        # Too short a baseline makes the slope meaningless and the projection wild.
        # Saying nothing is better than saying something unfounded.
        if span < 0.25:
            return None
        # When health_ema is flat (std < 0.005), bootstrap fits would be pure noise.
        # Rather than returning None (which would wipe out RUL over time once the sliding
        # window fills), report the true state directly:
        # - If already at or below degradation limit: report at_limit.
        # - If above limit: report TBO-limited (no degradation trend detected).
        if float(np.std(y)) < 0.005:
            if y[-1] <= limit:
                return dict(
                    at_limit=True,
                    basis='health index at or past the degradation limit',
                )
            return dict(
                hours=round(float(max(0.0, self.tbo - t[-1])), 1),
                tbo_limited=True,
                basis='no degradation trend detected; limited by time before overhaul',
            )

        rng = np.random.default_rng(0)
        n = len(t)
        preds = []
        non_degrading_count = 0
        for _ in range(200):
            idx = rng.integers(0, n, n)
            try:
                m, c = np.polyfit(t[idx], y[idx], 1)
            except Exception:
                continue
            if m >= -1e-7:
                preds.append(self.tbo - t[-1])       # not degrading: TBO-limited
                non_degrading_count += 1
            else:
                preds.append(max(0.0, (limit - c) / m - t[-1]))
        if not preds:
            return None
        preds = np.clip(np.asarray(preds), 0.0, self.tbo)

        # Bug A: Guard 1 — at_limit check.
        # ORDER MATTERS: This check MUST run before the tbo_limited check below.
        # When an engine is genuinely at or past its degradation limit, noisy resamples
        # on a flat-bottomed post-failure signal can land on m >= 0 and take the
        # non-degrading branch. If tbo_limited (> 0.9) were checked first, it could falsely
        # report "TBO-limited, no degradation trend" on an engine at its limit — rendering
        # the most alarming condition as the most reassuring one.
        p90 = round(float(np.percentile(preds, 90)), 1)
        if p90 < 1.0:
            return dict(
                at_limit=True,
                basis='health index at or past the degradation limit',
            )

        # Bug B: Guard 2 — tbo_limited check.
        # If a clear majority of resamples (> 90%) took the non-degrading branch, do not
        # emit a zero-width P10-P90 interval. Report TBO-limited without P10/P90 fields.
        if (non_degrading_count / len(preds)) > 0.9:
            return dict(
                hours=round(float(max(0.0, self.tbo - t[-1])), 1),
                tbo_limited=True,
                basis='no degradation trend detected; limited by time before overhaul',
            )

        p10 = round(float(np.percentile(preds, 10)), 1)
        slope = float(np.polyfit(t, y, 1)[0])
        return dict(
            hours=round(float(np.median(preds)), 1),
            p10=p10,
            p90=p90,
            rate_per_hour=round(slope, 6),
            basis='linear degradation fit, 200-sample bootstrap',
        )
