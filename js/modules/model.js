// The prediction model shared by every view: where a train will be, and when, from what is known now.
//
// Three ways to show the times ahead (the footer switch, or ?times=raw|model|tables):
//
// "raw" keeps the announced delay unchanged on every following stop (scheduled time + delay).
//
// "model" (the recovery rules) predicts each stop directly from the last real datum (the real departure, or the
// real arrival when the train is in a station) and the scheduled time between that datum and the stop. A
// prediction never depends on the prediction made for the stop before it:
// 1. delay at a stop = last real delay - what trains typically recover, + a small offset: they recover about
//    half of their delay, up to ~4.4 min, the more the longer the way (saturating with a 25 min time constant);
// 2. a train stays about 1.7 + 0.8 x the scheduled stop (regional), so its departure is later than the timetable.
//
// "tables" (the default) is the rules plus the usual error of each pair of stations (last known stop -> stop
// ahead): some stretches are always slower or faster than the rules say. The table, data/segment-corrections.json,
// is built from past days by scripts/evaluate.py, which also scores it on days it has not seen.
//
// Measured on four whole days (1 284 trains, 80 000 pairs), each day scored with a table built from the other days,
// the mean error over the next 1 to 6 stops is 3.7 min for "raw", 3.2 for "model" and 2.7 for "tables"; "tables"
// wins on every one of the four days. The recovery constants were checked on the same data and left as they are:
// refitting them on other days does not lower the error.
//
// The kinematics (speed profile between two stations, from their distance) do not predict arrivals any better
// than that; they give the shape of the movement between two stations (position and speed).
const TIMES_KEY = 'panelTreno.times'
const TIMES_MODES = ['raw', 'model', 'tables']
const DEFAULT_TIMES_MODE = 'tables'

const KINEMATICS = {
  reg: { kmh: 105, acc: 0.22 }, // regional trains
  long: { kmh: 100, acc: 0.2 } // intercity, high speed and the others (few samples)
}
// delay at a stop = max(-0.5, r0 - min(RHO x r0, CAP x (1 - exp(-H / TAU))) + OFFSET), r0 = last real delay, H = scheduled min since
const RECOVERY = { rho: 0.5, cap: 4.4, tau: 25, offset: -0.75 }
const DWELL = { reg: [1.7, 0.8], long: [1.0, 1.0] } // expected stop (min) = a + b x scheduled stop
const DWELL_SPREAD = { reg: [-0.5, 0.5], long: [-0.5, 1.0] } // 25 % / 75 % of the difference, in min

let timesMode = (() => {
  if (typeof window === 'undefined') return DEFAULT_TIMES_MODE
  const fromUrl = new URLSearchParams(window.location.search).get('times')
  if (TIMES_MODES.includes(fromUrl)) return fromUrl
  try {
    const stored = localStorage.getItem(TIMES_KEY)
    return TIMES_MODES.includes(stored) ? stored : DEFAULT_TIMES_MODE
  } catch { return DEFAULT_TIMES_MODE }
})()

const modelOn = () => timesMode !== 'raw'
const tablesOn = () => timesMode === 'tables'

function setTimesMode(mode) {
  timesMode = TIMES_MODES.includes(mode) ? mode : DEFAULT_TIMES_MODE
  try { localStorage.setItem(TIMES_KEY, timesMode) } catch { /* storage is optional */ }
  const url = new URLSearchParams(window.location.search)
  if (timesMode === DEFAULT_TIMES_MODE) url.delete('times')
  else url.set('times', timesMode)
  window.history.replaceState(null, '', `${window.location.pathname}?${url}${window.location.hash}`)
  loadCorrections()
}

// The corrections of the "tables" model: { pairs: { 'A>B': min }, stations: { 'B': min } }.
const LEFT_GRACE_MS = 30000 // a train past its usual time in a station by this much is taken as gone, whatever the data says yet
const MIN_RUN_MS = 60000 // the shortest run between two stops the prediction allows
const MIN_TABLES_DELAY = -1 // min: a train is not predicted more than a minute early
let corrections = null
let correctionsLoading = false

function loadCorrections() {
  if (corrections || correctionsLoading || typeof fetch === 'undefined' || typeof window === 'undefined') return
  correctionsLoading = true
  fetch('data/segment-corrections.json', { cache: 'no-cache' })
    .then(r => (r.ok ? r.json() : null))
    .then(table => {
      if (!table || !table.pairs) return
      corrections = table
      window.dispatchEvent(new Event('treno-corrections')) // the pages show their times again
    })
    .catch(() => { /* without the table, "tables" behaves as "model" */ })
    .finally(() => { correctionsLoading = false })
}

// What the table says for a train whose last known stop is `fromId` and that is heading to `toId`, whatever the
// current mode: { value (min, the usual error of the rules), source: 'pair' | 'station' | 'none' }, or null while
// the table is not loaded.
function correctionInfo(fromId, toId) {
  if (!corrections) return null
  const pair = corrections.pairs[`${fromId}>${toId}`]
  if (pair !== undefined) return { value: pair, source: 'pair' }
  const station = corrections.stations[toId]
  return station !== undefined ? { value: station, source: 'station' } : { value: 0, source: 'none' }
}

// The correction the "tables" model adds (0 in the other modes): the pair when it was seen enough, else the stop alone.
// What the trains were seen to do at a station: { n, median, mean, source } of the arrival delay in minutes, for the
// trains going towards `nextId` when there are enough of them ('direction'), else for all of them ('station'); or null.
function stationDelay(id, nextId) {
  const delays = corrections && corrections.delays
  if (!delays) return null
  const pick = (row, source) => (row ? { n: row[0], median: row[1], mean: row[2], source } : null)
  return pick(delays.directions && delays.directions[`${id}>${nextId || ''}`], 'direction') || pick(delays.stations && delays.stations[id], 'station')
}
function correctionFor(fromId, toId) {
  if (!tablesOn()) return 0
  const info = correctionInfo(fromId, toId)
  return info ? info.value : 0
}

// 'reg' for regional trains, 'long' for the others; an unknown category is treated as regional.
function trainClass(d) {
  const cat = String((d && (d.categoria || d.compNumeroTreno || d.tipoTreno)) || '').trim().split(/\s+/)[0].toUpperCase()
  return !cat || /^(REG|RV|R|MET|RE)$/.test(cat) ? 'reg' : 'long'
}

// How much of a delay a train typically recovers on one segment (negative), at most half of its travel time.
function delayDrift(minutes, travelMin = Infinity) {
  if (!modelOn() || minutes <= 0.5) return 0
  return Math.max(-Math.min(minutes, 2.2 + 0.04 * minutes), -0.5 * travelMin)
}

// The delay with which a train announced `delay` late arrives one segment further.
function adjustedDelay(delay, travelMin = Infinity) {
  const d = Math.max(delay, 0)
  return Math.max(0, d + delayDrift(d, travelMin))
}

// The speed profile between two stations `distKm` apart: accelerate, cruise, brake (or accelerate then
// brake straight away when the stations are too close to reach the cruising speed).
function motionProfile(distKm, cls = 'reg') {
  const { kmh, acc } = KINEMATICS[cls] || KINEMATICS.reg
  const vMax = kmh / 3.6
  const dm = distKm * 1000
  const reaches = dm >= (vMax * vMax) / acc
  const peak = reaches ? vMax : Math.sqrt(acc * dm)
  const tAcc = peak / acc
  const dAcc = 0.5 * acc * tAcc * tAcc
  const tCruise = reaches ? (dm - 2 * dAcc) / peak : 0
  const total = 2 * tAcc + tCruise
  return {
    km: distKm, acc, peak, peakKmh: peak * 3.6, tAcc, tCruise, total, minutes: total / 60, cruises: reaches,
    meanKmh: total > 0 ? (dm / total) * 3.6 : 0,
    // position (m) and speed (m/s) after t seconds
    at(t) {
      const u = Math.min(Math.max(t, 0), total)
      if (u < tAcc) return { x: 0.5 * acc * u * u, v: acc * u }
      if (u <= tAcc + tCruise) return { x: dAcc + peak * (u - tAcc), v: peak }
      const r = total - u
      return { x: dm - 0.5 * acc * r * r, v: acc * r }
    },
    // the instant (s) at which the train is `fraction` of the way
    timeAt(fraction) {
      const x = Math.min(Math.max(fraction, 0), 1) * dm
      if (x < dAcc) return Math.sqrt((2 * x) / acc)
      if (x <= dm - dAcc) return tAcc + (x - dAcc) / peak
      return total - Math.sqrt((2 * (dm - x)) / acc)
    }
  }
}

// Expected time in a station (min) for a scheduled stop of `schedMin`, and the 25-75 % range around it.
function dwellExpected(schedMin, cls = 'reg') {
  const [a, b] = DWELL[cls] || DWELL.reg
  const [lo, hi] = DWELL_SPREAD[cls] || DWELL_SPREAD.reg
  const mid = a + b * Math.max(schedMin, 0)
  return { mid, lo: Math.max(0.3, mid + lo), hi: mid + hi }
}

// The delay (min) at a stop, from the last real delay `r0` (min) and the scheduled minutes `h` from that datum.
function delayAt(r0, h) {
  const late = Math.max(r0, 0)
  if (!modelOn()) return late
  const { rho, cap, tau, offset } = RECOVERY
  return Math.max(-0.5, late - Math.min(late * rho, cap * (1 - Math.exp(-Math.max(h, 0) / tau))) + offset)
}

// When a train whose last real datum is a delay of `r0` min, measured at the scheduled time `baseMs`, reaches
// a stop scheduled at `schedArrMs`.
function predictArrival(r0, baseMs, schedArrMs, correction = 0) {
  const delay = delayAt(r0, (schedArrMs - baseMs) / 60000)
  const corrected = correction && modelOn() ? Math.max(MIN_TABLES_DELAY, delay + correction) : delay
  return schedArrMs + corrected * 60000
}

// Predicted times for the stops after `lastPassed`: Map(stop index -> { arrDelay, depDelay, arrMs, depMs })
// (delays in min against the timetable), and `leaveMs`, when the train leaves `lastPassed`.
// opts: { inStation, cls, nowMs }. Each stop is predicted on its own, from the last real datum only.
function predictStopTimes(stops, delayNow, lastPassed, opts = {}) {
  const { inStation = false, cls = 'reg', nowMs = Date.now() } = opts
  const arr = f => f.arrivo_teorico || f.programmata
  const dep = f => f.partenza_teorica || f.programmata
  const out = new Map()
  const from = Math.max(lastPassed, 0)
  const here = stops[from]
  if (!here) return out
  const late = Math.max(delayNow, 0)

  // the last real datum: its delay (min) and the scheduled time it refers to
  let r0 = late
  let baseMs = dep(here)
  let depMs
  if (lastPassed >= 0 && here.partenzaReale) {
    r0 = Math.max((here.partenzaReale - dep(here)) / 60000, 0)
    depMs = here.partenzaReale
  } else if (inStation && here.arrivoReale) {
    r0 = Math.max((here.arrivoReale - arr(here)) / 60000, 0)
    baseMs = arr(here)
    const sched = Math.max(0, (dep(here) - arr(here)) / 60000)
    if (!modelOn()) depMs = dep(here) + late * 60000
    else {
      const dwell = dwellExpected(sched, cls)
      const expected = Math.max(dep(here), here.arrivoReale + dwell.mid * 60000)
      const latest = Math.max(dep(here), here.arrivoReale + dwell.hi * 60000)
      if (nowMs > latest + LEFT_GRACE_MS) {
        // The announced departure has not come in yet, but the train is past the time it is usually still in the station:
        // it has left. Waiting for the data to say so would keep it "in the station" and every prediction behind.
        // The real departure, when it arrives, replaces this estimate.
        depMs = expected
        r0 = Math.max((expected - dep(here)) / 60000, 0)
        baseMs = dep(here)
        out.assumedLeft = true
      } else depMs = Math.max(expected, nowMs + 30000)
    }
  } else depMs = dep(here) + late * 60000
  out.leaveMs = depMs

  let prevDepMs = depMs
  for (let i = from + 1; i < stops.length; i++) {
    let arrMs = predictArrival(r0, baseMs, arr(stops[i]), correctionFor(here.id, stops[i].id))
    // each stop is predicted on its own, so two corrections can disagree: a train still cannot arrive before it left the stop before
    if (modelOn()) arrMs = Math.max(arrMs, prevDepMs + MIN_RUN_MS)
    let nextDep = dep(stops[i]) + late * 60000
    if (modelOn()) nextDep = Math.max(dep(stops[i]), arrMs + dwellExpected((dep(stops[i]) - arr(stops[i])) / 60000, cls).mid * 60000)
    else nextDep = dep(stops[i]) + r0 * 60000
    out.set(i, { arrDelay: (arrMs - arr(stops[i])) / 60000, depDelay: (nextDep - dep(stops[i])) / 60000, arrMs, depMs: nextDep })
    prevDepMs = nextDep
  }
  return out
}

// ViaggiaTreno sometimes gives a stop a "real" arrival that is only its scheduled time (the train has not been seen there),
// next to a real departure from the stop before that is later: an arrival before the previous departure. That time is not
// a measurement (and a departure may come with no arrival at all): it is replaced by an estimate (flagged `arrivoEstimated`) from what is known around it.
function repairStopTimes(stops) {
  for (let i = 1; i < stops.length; i++) {
    const f = stops[i]
    const prevDep = stops[i - 1].partenzaReale
    const schedArr = f.arrivo_teorico || f.programmata
    const schedDep = f.partenza_teorica || f.programmata
    const dwell = Math.max(60000, (schedDep - schedArr) || 0)
    if (f.partenzaReale && !f.arrivoReale) {
      // a departure with no arrival (the feed does not always keep it): the arrival is worked back from the departure
      f.arrivoReale = Math.min(f.partenzaReale, Math.max((prevDep || 0) + 60000, f.partenzaReale - dwell))
      f.arrivoEstimated = true
      continue
    }
    if (!f.arrivoReale || !prevDep || f.arrivoReale >= prevDep) continue
    f.arrivoReale = f.partenzaReale ? Math.max(prevDep + 60000, f.partenzaReale - dwell) : prevDep + 60000
    f.arrivoEstimated = true
  }
  return stops
}

// The data of a train lags: the arrival at a stop, or the departure from it, is announced a minute or two after it happened.
// The page must not wait for that: from the last stop the data knows, the train is moved along on the predicted times, and
// the real data corrects it when it comes. Returns copies of the stops where the stops reached (and left) on the prediction
// alone carry their estimated times (flagged `arrivoEstimated` / `departureEstimated`, and as passed). At most MAX_INFERRED
// steps, and nothing before the train has left its first stop.
const ARRIVE_GRACE_MS = 30000 // a train past its predicted arrival by this much is taken as arrived
const MAX_INFERRED = 4
function inferProgress(stops, delayNow, opts = {}) {
  const { cls = 'reg', nowMs = Date.now() } = opts
  const list = stops.map(f => ({ ...f }))
  let last = list.reduce((l, f, i) => (f.actualFermataType === 1 ? i : l), -1)
  let steps = 0
  while (last >= 0 && last < list.length - 1 && steps < MAX_INFERRED) {
    const here = list[last]
    const inStation = !here.partenzaReale
    const pred = predictStopTimes(list, delayNow, last, { inStation: inStation && !!here.arrivoReale, cls, nowMs })
    if (inStation) {
      if (!here.arrivoReale) break // no arrival to build on: the data has to say it
      if (!pred.assumedLeft) break
      here.partenzaReale = pred.leaveMs
      here.departureEstimated = true
      steps++
      continue
    }
    const arrMs = (pred.get(last + 1) || {}).arrMs
    if (!arrMs || nowMs <= arrMs + ARRIVE_GRACE_MS) break
    const next = list[last + 1]
    next.actualFermataType = 1
    next.arrivoReale = arrMs
    next.arrivoEstimated = true
    last++
    steps++
  }
  return { stops: list, steps }
}

// THE one place where the data of a train becomes "the train as it is now" and where its times come from. Every page,
// card and chart reads a train through these two functions, so they all show the same stops, the same position and the same
// times. `trainEstimate` moves the data along on the predictions where it lags (see inferProgress), `predictTrain` gives the
// times of the stops ahead for that estimate. The result of the first is flagged (`estimated`) so that it is never moved
// along twice; it is a copy, the data itself is never changed.
const estimateCache = { src: null, key: 0, out: null }
function trainEstimate(d, nowMs = Date.now()) {
  if (!d || d.estimated) return d
  const key = Math.floor(nowMs / 2000)
  if (estimateCache.src === d && estimateCache.key === key) return estimateCache.out
  const { stops, steps } = inferProgress(d.fermate || [], d.ritardo || 0, { cls: trainClass(d), nowMs })
  estimateCache.src = d
  estimateCache.key = key
  estimateCache.out = { ...d, fermate: stops, estimated: true, inferredSteps: steps }
  return estimateCache.out
}

function predictTrain(d, nowMs = Date.now()) {
  const e = trainEstimate(d, nowMs)
  const stops = (e && e.fermate) || []
  const lastPassed = stops.reduce((last, f, i) => (f.actualFermataType === 1 ? i : last), -1)
  const here = stops[lastPassed]
  return predictStopTimes(stops, (e && e.ritardo) || 0, lastPassed, { inStation: !!here && !here.partenzaReale, cls: trainClass(e), nowMs })
}

// Runs `fn` as if the times mode were `mode`, to compare the two on the same train.
function withTimesMode(mode, fn) {
  const previous = timesMode
  timesMode = mode
  try { return fn() } finally { timesMode = previous }
}

loadCorrections()

if (typeof module !== 'undefined') {
  module.exports = {
    delayAt, predictArrival, predictStopTimes, repairStopTimes, inferProgress, trainEstimate, predictTrain, correctionFor, correctionInfo, stationDelay, withTimesMode, dwellExpected, motionProfile,
    setCorrectionsForTests: table => { corrections = table }
  }
}
