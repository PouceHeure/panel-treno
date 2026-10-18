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

test('predicted times never go back in time, even when the corrections of two stretches disagree', () => {
  M.setCorrectionsForTests({ pairs: { 'A>B': 6, 'A>C': -1 }, stations: {} })
  const t0 = Date.UTC(2026, 9, 17, 8, 0)
  const mk = (id, min) => ({ id, arrivo_teorico: t0 + min * 60000, partenza_teorica: t0 + (min + 1) * 60000 })
  const list = [mk('A', 0), mk('B', 5), mk('C', 8)]
  list[0].partenzaReale = list[0].partenza_teorica
  const out = M.withTimesMode('tables', () => M.predictStopTimes(list, 0, 0, { nowMs: t0 }))
  assert.ok(out.get(2).arrMs > out.get(1).depMs)
})

test('a train past its usual time in a station is taken as gone before the data says so', () => {
  const t0 = Date.UTC(2026, 9, 17, 8, 0)
  const min = m => t0 + m * 60000
  const mk = (id, a, d) => ({ id, arrivo_teorico: min(a), partenza_teorica: min(d) })
  const list = [mk('A', 0, 1), mk('B', 10, 11), mk('C', 20, 21)]
  list[0].arrivoReale = min(2) // arrived 2 min late, no departure announced
  const at = nowMin => M.withTimesMode('model', () => M.predictStopTimes(list, 2, 0, { inStation: true, nowMs: min(nowMin) }))
  assert.ok(!at(3).assumedLeft, 'a minute after arriving it is still in the station')
  const gone = at(8)
  assert.ok(gone.assumedLeft)
  assert.ok(gone.leaveMs < min(8), 'its departure is put in the past, not 30 s from now')
  assert.ok(gone.get(1).arrMs > gone.leaveMs)
})

test('an arrival that comes before the departure from the stop before is not kept as a measurement', () => {
  const t0 = Date.UTC(2026, 9, 17, 8, 0)
  const min = m => t0 + m * 60000
  const stop = (a, d) => ({ arrivo_teorico: min(a), partenza_teorica: min(d) })
  const list = [stop(0, 1), stop(3, 4), stop(6, 7)]
  list[0].partenzaReale = min(16)
  list[1].arrivoReale = min(18)
  list[1].partenzaReale = min(19)
  list[2].arrivoReale = min(6) // only the schedule: the train left the stop before at 19
  list[2].partenzaReale = min(24)
  M.repairStopTimes(list)
  assert.equal(list[1].arrivoEstimated, undefined, 'a plausible arrival stays')
  assert.ok(list[2].arrivoEstimated)
  assert.ok(list[2].arrivoReale >= min(19) + 60000 && list[2].arrivoReale <= list[2].partenzaReale)
})

test('a stop with a real departure and no real arrival gets an estimated arrival, after the departure before', () => {
  const t0 = Date.UTC(2026, 9, 17, 8, 0)
  const min = m => t0 + m * 60000
  const stop = (a, d) => ({ arrivo_teorico: min(a), partenza_teorica: min(d) })
  const list = [stop(0, 1), stop(3, 4)]
  list[0].partenzaReale = min(20)
  list[1].partenzaReale = min(21) // no arrival in the feed
  M.repairStopTimes(list)
  assert.ok(list[1].arrivoEstimated)
  assert.ok(list[1].arrivoReale >= min(20) + 60000 && list[1].arrivoReale <= min(21))
})

test('the train is moved along on the predicted times while the data lags, and the data corrects it', () => {
  const t0 = Date.UTC(2026, 9, 17, 8, 0)
  const min = m => t0 + m * 60000
  const mk = (id, a, d) => ({ id, arrivo_teorico: min(a), partenza_teorica: min(d), actualFermataType: 0 })
  const list = [mk('A', 0, 1), mk('B', 10, 11), mk('C', 20, 21), mk('D', 30, 31)]
  list[0].actualFermataType = 1
  list[0].partenzaReale = min(1) // left on time, nothing since
  const at = nowMin => M.withTimesMode('model', () => M.inferProgress(list, 0, { nowMs: min(nowMin) }))
  assert.equal(at(5).steps, 0, 'still on its way')
  const there = at(12)
  assert.equal(there.steps, 1, 'past its predicted arrival: at B')
  assert.equal(there.stops[1].actualFermataType, 1)
  assert.ok(there.stops[1].arrivoEstimated)
  const gone = at(16)
  assert.ok(gone.stops[1].departureEstimated, 'and past its usual time there: gone')
  assert.equal(list[1].actualFermataType, 0, 'the data itself is not changed')
  assert.equal(M.withTimesMode('model', () => M.inferProgress(list, 0, { nowMs: min(500) })).steps, 4, 'no more than four steps on a guess')
})

test('one estimate for every reader: estimating twice changes nothing, and the times come from that estimate', () => {
  const t0 = Date.UTC(2026, 9, 17, 8, 0)
  const min = m => t0 + m * 60000
  const mk = (id, a, d) => ({ id, arrivo_teorico: min(a), partenza_teorica: min(d), actualFermataType: 0 })
  const list = [mk('A', 0, 1), mk('B', 10, 11), mk('C', 20, 21)]
  list[0].actualFermataType = 1
  list[0].partenzaReale = min(1)
  const d = { fermate: list, ritardo: 0, numeroTreno: 1 }
  const now = min(13) // past the predicted arrival at B
  M.withTimesMode('model', () => {
    const e = M.trainEstimate(d, now)
    assert.equal(e.fermate[1].actualFermataType, 1, 'taken as arrived at B')
    assert.equal(M.trainEstimate(e, now), e, 'an estimate is not estimated again')
    assert.equal(d.fermate[1].actualFermataType, 0, 'the data itself is untouched')
    assert.deepEqual([...M.predictTrain(d, now).keys()], [...M.predictTrain(e, now).keys()])
    assert.equal(M.predictTrain(d, now).get(2).arrMs, M.predictTrain(e, now).get(2).arrMs)
  })
})
