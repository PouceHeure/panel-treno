const test = require('node:test')
const assert = require('node:assert')
const M = require('../js/modules/model.js')

const stops = [
  { id: 'A', programmata: 0, partenza_teorica: 0, arrivo_teorico: 0, actualFermataType: 1 },
  { id: 'B', programmata: 600000, arrivo_teorico: 600000, partenza_teorica: 660000 },
  { id: 'C', programmata: 1200000, arrivo_teorico: 1200000, partenza_teorica: 1200000 }
]
const delays = mode => M.withTimesMode(mode, () => [...M.predictStopTimes(stops, 5, 0, {}).values()].map(x => x.arrDelay))

test('raw holds the delay, the rules recover part of it', () => {
  M.setCorrectionsForTests(null)
  assert.deepStrictEqual(delays('raw'), [5, 5])
  const rules = delays('model')
  assert.ok(rules[0] < 5 && rules[1] < rules[0], `rules recover more as the way gets longer: ${rules}`)
})

test('the tables add the usual error of the pair, else of the station, else nothing', () => {
  M.setCorrectionsForTests({ pairs: { 'A>B': 1.5 }, stations: { C: -0.4 } })
  const rules = delays('model')
  const tables = delays('tables')
  assert.ok(Math.abs(tables[0] - (rules[0] + 1.5)) < 1e-9, 'a pair seen before')
  assert.ok(Math.abs(tables[1] - (rules[1] - 0.4)) < 1e-9, 'a station seen before, the pair was not')
  assert.deepStrictEqual(delays('raw'), [5, 5], 'raw ignores the table')
  assert.deepStrictEqual(delays('model'), rules, 'the rules ignore the table')
})

test('without a table, tables behaves as the rules; and a train is not predicted far too early', () => {
  M.setCorrectionsForTests(null)
  assert.deepStrictEqual(delays('tables'), delays('model'))
  M.setCorrectionsForTests({ pairs: { 'A>B': -9 }, stations: {} })
  assert.ok(delays('tables')[0] >= -1 - 1e-9, 'the floor is one minute early')
  M.setCorrectionsForTests(null)
})

test('stationDelay prefers the direction, falls back to the station, null when unknown', () => {
  M.setCorrectionsForTests({ pairs: {}, stations: {}, delays: { stations: { S1: [40, 1.5, 3.2] }, directions: { 'S1>S2': [12, 3, 4.1] } } })
  assert.deepEqual(M.stationDelay('S1', 'S2'), { n: 12, median: 3, mean: 4.1, source: 'direction' })
  assert.deepEqual(M.stationDelay('S1', 'S9'), { n: 40, median: 1.5, mean: 3.2, source: 'station' })
  assert.equal(M.stationDelay('S2', 'S1'), null)
})
