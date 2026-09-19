"""Honest evaluation.

A single accuracy number on strong faults is close to meaningless - any detector
finds a 90% blocked injector. What matters is where it stops working. This sweeps
fault severity from barely-there to severe and reports detection rate and
classification accuracy at each level, plus the false positive rate on healthy
engines run over the same randomised profiles.

Run:  python3 evaluate.py
"""

import numpy as np
import pickle
import os
from train import run_segment
from detect import FAULT_LABELS

MODEL_PATH = os.path.join(os.path.dirname(__file__), 'models.pkl')
SEVERITIES = [0.10, 0.20, 0.35, 0.50, 0.75, 1.00]
REPEATS = 6


def main():
    det = pickle.load(open(MODEL_PATH, 'rb'))
    rng = np.random.default_rng(101)

    # ---- false positives on healthy
    fp = n = 0
    for _ in range(REPEATS * 6):
        v = run_segment('healthy', 0.0)
        if not v:
            continue
        x = v[rng.integers(0, len(v))]
        anom, _ = det.anomaly(x)
        fp += int(anom); n += 1
    print(f'healthy engines: {fp}/{n} flagged as anomalous '
          f'({100.0*fp/max(1,n):.1f}% false positive rate)\n')

    print(f'{"severity":>9} | {"detected":>9} | {"classified":>11} | notes')
    print('-' * 58)

    for sev in SEVERITIES:
        det_hit = cls_hit = total = 0
        for fault in FAULT_LABELS[1:]:
            for _ in range(REPEATS):
                v = run_segment(fault, sev)
                if not v:
                    continue
                x = v[rng.integers(0, len(v))]
                anom, _s = det.anomaly(x)
                pred, conf, _ = det.classify(x)
                det_hit += int(anom)
                cls_hit += int(pred == fault)
                total += 1
        dr = 100.0 * det_hit / max(1, total)
        cr = 100.0 * cls_hit / max(1, total)
        note = ('below useful threshold' if dr < 50 else
                'partial' if dr < 90 else 'reliable')
        print(f'{sev:9.2f} | {dr:8.1f}% | {cr:10.1f}% | {note}')

    # ---- per fault, at a realistic early-warning severity
    print(f'\nper fault at severity 0.35 (early degradation):')
    for fault in FAULT_LABELS[1:]:
        d = c = t = 0
        for _ in range(REPEATS * 2):
            v = run_segment(fault, 0.35)
            if not v:
                continue
            x = v[rng.integers(0, len(v))]
            anom, _ = det.anomaly(x)
            pred, _cf, _ = det.classify(x)
            d += int(anom); c += int(pred == fault); t += 1
        print(f'  {fault:24s} detected {100.0*d/max(1,t):5.1f}%  '
              f'correctly named {100.0*c/max(1,t):5.1f}%')

    print('\nCaveat: faults here are seeded into the physics model, not observed on')
    print('real hardware. This measures separation of fault signatures from')
    print('operating-point variation. It is not a field validation.')


if __name__ == '__main__':
    main()
