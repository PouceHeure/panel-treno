#!/usr/bin/env python3
"""Evaluates the delay models on a collector export and writes data/model-report.json.

    python3 scripts/evaluate.py path/to/export.json

The evaluation is chronological: the models are fitted (and the intervals measured) on the earlier days, and
scored on the last day only, which no calibration ever saw. The pairs it scores are (last real departure of a
train, real arrival at a stop 1..8 stops later), the situation in which the app predicts.

The recovery model is not re-implemented from memory: its constants are read from js/modules/model.js, so the
report always scores what the app really runs.
"""
import json
import math
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
MODEL_JS = ROOT / 'js' / 'modules' / 'model.js'
REPORT = ROOT / 'data' / 'model-report.json'
ROME = ZoneInfo('Europe/Rome')
MAX_AHEAD = 8
MIN_TRAINS_PER_DAY = 20 # a day with fewer trains is a fragment of a day, not a day
HORIZONS = (1, 2, 3, 4, 6)
# days of data a model needs before it is worth comparing (a rule of thumb, not a guarantee)
NEEDS = {'tables': 7, 'trees': 14}


def recovery_constants(text):
    """RECOVERY = { rho: 0.5, cap: 4.4, tau: 25, offset: -0.75 } in model.js."""
    match = re.search(r'const RECOVERY = \{([^}]*)\}', text)
    if not match:
        raise ValueError('RECOVERY not found in model.js')
    return {k: float(v) for k, v in re.findall(r'(\w+):\s*(-?[\d.]+)', match.group(1))}


def day_of(departure_ms):
    return datetime.fromtimestamp(departure_ms / 1000, ROME).strftime('%Y-%m-%d')


def build_pairs(trains):
    """One row per (real departure at stop i, real arrival at stop j > i): the day, how many stops ahead, the
    delay at departure r0 and the scheduled minutes h between the two, and the real delay at arrival."""
    rows = []
    for train in trains:
        stops = train['stops']
        day = day_of(train['departure_ms'])
        for i in range(len(stops) - 1):
            a = stops[i]
            if not (a.get('real_dep') and a.get('sched_dep')):
                continue
            r0 = max((a['real_dep'] - a['sched_dep']) / 60, 0.0)
            for j in range(i + 1, min(len(stops), i + 1 + MAX_AHEAD)):
                b = stops[j]
                if not (b.get('real_arr') and b.get('sched_arr')):
                    continue
                rows.append({
                    'day': day, 'train': train['id'], 'k': j - i, 'r0': r0,
                    'h': (b['sched_arr'] - a['sched_dep']) / 60,
                    'y': (b['real_arr'] - b['sched_arr']) / 60,
                })
    return rows


def predict_raw(row, _constants):
    return row['r0']


def predict_rules(row, c):
    """The same formula as delayAt() in model.js."""
    late = max(row['r0'], 0.0)
    recovered = min(late * c['rho'], c['cap'] * (1 - math.exp(-max(row['h'], 0) / c['tau'])))
    return max(-0.5, late - recovered + c['offset'])


MODELS = {'raw': predict_raw, 'rules-v2': predict_rules}


def percentile(sorted_values, q):
    if not sorted_values:
        return None
    pos = (len(sorted_values) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


def split_days(rows):
    """(calibration days, test day): the test day is the last day with enough trains, and needs earlier days."""
    trains_per_day = defaultdict(set)
    for r in rows:
        trains_per_day[r['day']].add(r['train'])
    usable = sorted(d for d, ids in trains_per_day.items() if len(ids) >= MIN_TRAINS_PER_DAY)
    if len(usable) < 2:
        return usable, None
    return usable[:-1], usable[-1]


def score(rows, predict, constants):
    out = {}
    for h in HORIZONS:
        errs = [abs(predict(r, constants) - r['y']) for r in rows if r['k'] == h]
        if errs:
            out[str(h)] = round(statistics.fmean(errs), 3)
    window = [r for r in rows if r['k'] <= 6]
    errs = [predict(r, constants) - r['y'] for r in window]
    absolute = sorted(abs(e) for e in errs)
    return {
        'mae_by_horizon': out,
        'mae_1_to_6': round(statistics.fmean(abs(e) for e in errs), 3) if errs else None,
        'median_abs': round(statistics.median(absolute), 3) if absolute else None,
        'p90_abs': round(percentile(absolute, 0.9), 3) if absolute else None,
        'bias': round(statistics.fmean(errs), 3) if errs else None,
        'pairs': len(window),
    }


def intervals(calibration_rows, test_rows, predict, constants):
    """90 % intervals (5th to 95th percentile of the real minus predicted delay), measured on the calibration
    days only, and the share of the test day they cover."""
    table = {}
    for k in range(1, MAX_AHEAD + 1):
        residuals = sorted(r['y'] - predict(r, constants) for r in calibration_rows if r['k'] == k)
        if len(residuals) < 50:
            continue
        lo, hi = percentile(residuals, 0.05), percentile(residuals, 0.95)
        covered = [lo <= r['y'] - predict(r, constants) <= hi for r in test_rows if r['k'] == k]
        table[str(k)] = {
            'lo': round(lo, 2), 'hi': round(hi, 2), 'n': len(residuals),
            'coverage_on_test': round(sum(covered) / len(covered), 3) if covered else None,
        }
    return table


def data_summary(trains):
    stops = [s for t in trains for s in t['stops']]
    days = Counter(day_of(t['departure_ms']) for t in trains)
    return {
        'trains': len(trains),
        'days': dict(sorted(days.items())),
        'stops': len(stops),
        'real_arrival_share': round(sum(1 for s in stops if s.get('real_arr')) / len(stops), 3) if stops else 0,
        'real_departure_share': round(sum(1 for s in stops if s.get('real_dep')) / len(stops), 3) if stops else 0,
        'categories': dict(Counter(t.get('category') for t in trains).most_common(8)),
        'status': dict(Counter(t.get('status') for t in trains)),
        'polls_per_train': round(statistics.fmean(t.get('n_polls', 0) for t in trains), 1) if trains else 0,
    }


def fit_constants(rows, start):
    """Coordinate search of the recovery constants on the calibration rows (1 to 6 stops ahead), by mean absolute
    error. Plain and deterministic: it only tells whether a recalibration would beat the shipped constants."""
    window = [r for r in rows if r['k'] <= 6]
    if not window:
        return dict(start)

    def error(c):
        return statistics.fmean(abs(predict_rules(r, c) - r['y']) for r in window)

    best = dict(start)
    best_error = error(best)
    steps = {'rho': 0.05, 'cap': 0.5, 'tau': 5.0, 'offset': 0.1}
    for _ in range(6):
        improved = False
        for name, step in steps.items():
            for direction in (-1, 1):
                trial = dict(best)
                trial[name] = best[name] + direction * step
                if trial['rho'] <= 0 or trial['rho'] > 1 or trial['cap'] <= 0 or trial['tau'] <= 1:
                    continue
                e = error(trial)
                if e < best_error - 1e-9:
                    best, best_error, improved = trial, e, True
        if not improved:
            steps = {k: v / 2 for k, v in steps.items()}
    return {k: round(v, 3) for k, v in best.items()}


def evaluate(export, constants):
    trains = export['trains']
    rows = build_pairs(trains)
    calibration_days, test_day = split_days(rows)
    calibration = [r for r in rows if r['day'] in calibration_days]
    test = [r for r in rows if r['day'] == test_day] if test_day else []
    usable_days = len(calibration_days) + (1 if test_day else 0)
    report = {
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'source_exported_at': datetime.fromtimestamp(export.get('exported_at', 0), timezone.utc).isoformat(timespec='seconds'),
        'data': data_summary(trains),
        'split': {'calibration_days': calibration_days, 'test_day': test_day, 'pairs': {'calibration': len(calibration), 'test': len(test)}},
        'recovery_constants': constants,
        'models': {},
        'interval_90': {},
        'readiness': {name: {'needs_days': n, 'have_days': usable_days} for name, n in NEEDS.items()},
    }
    if test:
        for name, predict in MODELS.items():
            report['models'][name] = score(test, predict, constants)
        base = report['models']['raw']['mae_1_to_6']
        best = report['models']['rules-v2']['mae_1_to_6']
        report['gain_vs_raw'] = round(1 - best / base, 3) if base else None
        report['interval_90'] = intervals(calibration, test, predict_rules, constants)
        fitted = fit_constants(calibration, constants)
        report['recalibration'] = {
            'fitted_on': calibration_days,
            'constants': fitted,
            'test_mae_1_to_6': score(test, predict_rules, fitted)['mae_1_to_6'],
            'shipped_test_mae_1_to_6': report['models']['rules-v2']['mae_1_to_6'],
        }
    return report


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    export = json.loads(Path(argv[1]).read_text())
    report = evaluate(export, recovery_constants(MODEL_JS.read_text()))
    REPORT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    print(f"{report['data']['trains']} trains, days {list(report['data']['days'])}")
    if report['split']['test_day']:
        print(f"calibration {report['split']['calibration_days']}  ->  test {report['split']['test_day']}")
        for name, m in report['models'].items():
            print(f"  {name:10s} MAE 1-6 {m['mae_1_to_6']} min  median {m['median_abs']}  p90 {m['p90_abs']}  bias {m['bias']}")
        print(f"  gain vs raw: {report.get('gain_vs_raw')}")
        rc = report['recalibration']
        print(f"  recalibrating on {rc['fitted_on']} would give {rc['test_mae_1_to_6']} min on the test day (shipped constants: {rc['shipped_test_mae_1_to_6']})")
    else:
        print('not enough days for a chronological test (needs at least 2 days with enough trains)')
    print(f'written {REPORT.relative_to(ROOT)}')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
