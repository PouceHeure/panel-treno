import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))
import evaluate  # noqa: E402

CONSTANTS = {'rho': 0.5, 'cap': 4.4, 'tau': 25.0, 'offset': -0.75}
DAY = 86400


def train(tid, day_index, delay_min, n_stops=6, offsets=None):
    """A train late by delay_min at every stop (offsets: extra minutes at given stop indexes), on the n-th day from a fixed Rome midnight."""
    base = 1791842400 + day_index * DAY  # 2026-10-13 00:00 Europe/Rome
    stops = []
    for i in range(n_stops):
        sched = base + 6 * 3600 + i * 300
        extra = (offsets or {}).get(i, 0)  # minutes this stop is later than the rest
        stops.append({'station': f'S{i}', 'sched_arr': sched, 'sched_dep': sched + 60,
                      'real_arr': sched + (delay_min + extra) * 60, 'real_dep': sched + 60 + (delay_min + extra) * 60})
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
        self.assertIn('recalibration', report)
        self.assertEqual(report['recalibration']['fitted_on'], ['2026-10-13', '2026-10-14'])

    def test_a_recalibration_never_does_worse_than_its_start_on_the_calibration_days(self):
        rows = evaluate.build_pairs([train(i, 0, 4) for i in range(25)] + [train(100 + i, 1, 6) for i in range(25)])
        fitted = evaluate.fit_constants(rows, CONSTANTS)
        mae = lambda c: sum(abs(evaluate.predict_rules(r, c) - r['y']) for r in rows if r['k'] <= 6)
        self.assertLessEqual(mae(fitted), mae(CONSTANTS) + 1e-6)


class TablesTest(unittest.TestCase):
    def rows(self, n=10, **kw):
        return evaluate.build_pairs([train(i, 0, 4, **kw) for i in range(n)])

    def test_a_pair_seen_enough_gets_a_shrunk_median_and_the_station_is_the_fallback(self):
        rows = self.rows(offsets={3: 3})  # stop S3 is always 3 min later than the rules say
        table = evaluate.build_corrections(rows, CONSTANTS)
        self.assertIn('S0>S3', table['pairs'])
        seen = len([r for r in rows if r['from'] == 'S0' and r['to'] == 'S3'])
        raw = statistics_median([r['y'] - evaluate.predict_rules(r, CONSTANTS) for r in rows if r['from'] == 'S0' and r['to'] == 'S3'])
        self.assertAlmostEqual(table['pairs']['S0>S3'], round(raw * seen / (seen + evaluate.SHRINK), 2))
        self.assertLess(abs(table['pairs']['S0>S3']), abs(raw))  # shrunk towards 0
        # a pair never seen falls back to the station, then to nothing
        row = {'from': 'S9', 'to': 'S3'}
        self.assertEqual(evaluate.correction_for(row, table), table['stations']['S3'])
        self.assertEqual(evaluate.correction_for({'from': 'S9', 'to': 'S99'}, table), 0.0)
        self.assertEqual(evaluate.correction_for({'from': 'S0', 'to': 'S3'}, table), table['pairs']['S0>S3'])

    def test_what_was_seen_too_few_times_is_not_corrected(self):
        rows = self.rows(n=evaluate.MIN_SEEN - 1, offsets={3: 3})
        table = evaluate.build_corrections(rows, CONSTANTS)
        self.assertEqual(table['pairs'], {})  # each pair was seen once per train
        # a station is seen once per stop that preceded it: it can be enough even with few trains
        self.assertTrue(all(n >= evaluate.MIN_SEEN for n in [len([r for r in rows if r['to'] == st]) for st in table['stations']]))

    def test_the_tables_never_predict_more_than_a_minute_early(self):
        table = {'pairs': {'S0>S1': -9.0}, 'stations': {}}
        predict = evaluate.tables_predictor(table)
        self.assertGreaterEqual(predict({'from': 'S0', 'to': 'S1', 'r0': 0.0, 'h': 5}, CONSTANTS), evaluate.TABLES_FLOOR)


class WholeDaysTest(unittest.TestCase):
    def test_a_morning_export_is_not_a_test_day(self):
        trains = [train(i, 0, 3) for i in range(60)] + [train(100 + i, 1, 3) for i in range(60)] + [train(200 + i, 2, 3) for i in range(12)]
        calibration, test = evaluate.split_days(evaluate.build_pairs(trains))
        self.assertEqual(calibration, ['2026-10-13'])
        self.assertEqual(test, '2026-10-14')  # the 12 trains of the last day are a fragment

    def test_the_tables_are_scored_with_a_table_that_has_not_seen_the_test_day(self):
        # stop S3 is 4 min late only on the last day: a table that had seen it would learn it, one that has not cannot
        trains = [train(i, 0, 3) for i in range(25)] + [train(100 + i, 1, 3) for i in range(25)] + [train(200 + i, 2, 3, offsets={3: 4}) for i in range(25)]
        report = evaluate.evaluate({'trains': trains, 'exported_at': 1791900000}, CONSTANTS)
        self.assertEqual(report['split']['test_day'], '2026-10-15')
        cheating = evaluate.score([r for r in evaluate.build_pairs(trains) if r['day'] == '2026-10-15'],
                                  evaluate.tables_predictor(evaluate.build_corrections(evaluate.build_pairs(trains), CONSTANTS)), CONSTANTS)['mae_1_to_6']
        self.assertGreater(report['models']['tables']['mae_1_to_6'], cheating)
        self.assertEqual([d['day'] for d in report['per_day']], ['2026-10-13', '2026-10-14', '2026-10-15'])
        self.assertIn('tables_vs_rules', report['gains'])


def statistics_median(values):
    import statistics
    return statistics.median(values)


if __name__ == '__main__':
    unittest.main()
