import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
import evaluate  # noqa: E402

CONSTANTS = {'rho': 0.5, 'cap': 4.4, 'tau': 25.0, 'offset': -0.75}
DAY = 86400


def train(tid, day_index, delay_min, n_stops=6):
    """A train late by delay_min at every stop, on the n-th day from a fixed Rome midnight."""
    base = 1791842400 + day_index * DAY  # 2026-10-13 00:00 Europe/Rome
    stops = []
    for i in range(n_stops):
        sched = base + 6 * 3600 + i * 300
        stops.append({'sched_arr': sched, 'sched_dep': sched + 60,
                      'real_arr': sched + delay_min * 60, 'real_dep': sched + 60 + delay_min * 60})
    return {'id': tid, 'departure_ms': base * 1000, 'category': 'REG', 'status': 'done', 'n_polls': 3, 'stops': stops}


class ConstantsTest(unittest.TestCase):
    def test_reads_the_constants_the_app_runs(self):
        text = (evaluate.MODEL_JS).read_text()
        c = evaluate.recovery_constants(text)
        self.assertEqual(set(c), {'rho', 'cap', 'tau', 'offset'})
        self.assertGreater(c['tau'], 1)


class PairsTest(unittest.TestCase):
    def test_pairs_need_a_real_departure_and_a_real_arrival(self):
        full = evaluate.build_pairs([train(1, 0, 3)])
        t = train(1, 0, 3)
        t['stops'][2]['real_arr'] = None  # that arrival was never observed
        partial = evaluate.build_pairs([t])
        self.assertEqual(len(full) - len(partial), 2)  # departures at stops 0 and 1 lose their pair with stop 2
        self.assertTrue(all(p['r0'] == 3 for p in partial))
        self.assertTrue(all(1 <= p['k'] <= evaluate.MAX_AHEAD for p in partial))

    def test_the_day_is_the_rome_day(self):
        self.assertEqual(evaluate.day_of(1791842400 * 1000), '2026-10-13')


class SplitTest(unittest.TestCase):
    def rows(self, per_day):
        trains = [train(100 * d + i, d, 2) for d, n in enumerate(per_day) for i in range(n)]
        return evaluate.build_pairs(trains)

    def test_the_test_day_is_the_last_one_and_never_in_the_calibration(self):
        calibration, test = evaluate.split_days(self.rows([25, 30, 40]))
        self.assertEqual(test, '2026-10-15')
        self.assertNotIn(test, calibration)
        self.assertEqual(len(calibration), 2)

    def test_a_fragment_of_a_day_is_not_a_day(self):
        calibration, test = evaluate.split_days(self.rows([1, 30, 40]))
        self.assertEqual(calibration, ['2026-10-14'])
        self.assertEqual(test, '2026-10-15')

    def test_one_day_is_not_enough_for_a_chronological_test(self):
        calibration, test = evaluate.split_days(self.rows([40]))
        self.assertIsNone(test)


class ModelsTest(unittest.TestCase):
    def test_raw_holds_the_delay(self):
        self.assertEqual(evaluate.predict_raw({'r0': 7.0, 'h': 30}, CONSTANTS), 7.0)

    def test_the_rules_recover_part_of_a_delay_but_never_go_below_minus_half_a_minute(self):
        self.assertAlmostEqual(evaluate.predict_rules({'r0': 0.0, 'h': 10}, CONSTANTS), -0.5)
        self.assertLess(evaluate.predict_rules({'r0': 10.0, 'h': 30}, CONSTANTS), 10.0)
        self.assertGreater(evaluate.predict_rules({'r0': 10.0, 'h': 30}, CONSTANTS), 0.0)

    def test_the_report_scores_on_the_last_day_only(self):
        # three days: a delay that recovers 2 minutes on day 1 and 2 (calibration), and holds on day 3 (test)
        trains = [train(i, 0, 4) for i in range(25)] + [train(100 + i, 1, 4) for i in range(25)] + [train(200 + i, 2, 4) for i in range(25)]
        report = evaluate.evaluate({'trains': trains, 'exported_at': 1791900000}, CONSTANTS)
        self.assertEqual(report['split']['test_day'], '2026-10-15')
        self.assertEqual(report['split']['calibration_days'], ['2026-10-13', '2026-10-14'])
        self.assertIn('raw', report['models'])
        self.assertIn('rules-v2', report['models'])
        self.assertIn('1', report['interval_90'])


if __name__ == '__main__':
    unittest.main()
