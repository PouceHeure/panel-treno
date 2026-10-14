// The prediction model shared by every view: where a train will be, and when, from what is known now.
//
// "raw" keeps the announced delay unchanged on every following stop (scheduled time + delay).
// "model" combines three things, all calibrated on 535 trains / 8 300 segments collected over two days
// (Liguria and a few long-distance runs, mostly regional trains):
//
// 1. the timetable, corrected for the delay trains typically recover on a segment (median 0 min when on time,
//    -1 at +1..2 min, -2 at +2..4 min, -3 beyond +6 min);
// 2. a kinematic trip: the train accelerates, cruises and brakes between two stations, so the time needed
//    depends on their distance (trapezoid speed profile, about 105 km/h and 0.22 m/s^2 for regional trains);
// 3. a dwell model: a train stays about 1.7 + 0.8 x the scheduled stop, not the scheduled stop.
//
// The arrival is 25 % the kinematic trip and 75 % the corrected timetable. Measured against real arrival
// times, chained from a real departure, the mean error is 1.8 min at the next stop and 3.0 min three stops
// ahead, against 2.4 and 3.6 min for "raw" (the corrected timetable alone, with a flat +1 min per stop, was
// worse than raw beyond two stops). Calibrated and measured on the same two days: the gain on another day
// is probably a bit smaller (fitting on one day and testing on the other gave the same ranking).
const TIMES_KEY = 'panelTreno.times'

const KINEMATICS = {
  reg: { kmh: 105, acc: 0.22 }, // regional trains
  long: { kmh: 100, acc: 0.2 } // intercity, high speed and the others (few samples)
}
const KINEMATIC_WEIGHT = 0.25
const DWELL = { reg: [1.7, 0.8], long: [1.0, 1.0] } // expected stop (min) = a + b x scheduled stop
const DWELL_SPREAD = { reg: [-0.5, 0.5], long: [-0.5, 1.0] } // 25 % / 75 % of the difference, in min

let timesMode = (() => {
  const fromUrl = new URLSearchParams(window.location.search).get('times')
  if (fromUrl === 'raw' || fromUrl === 'model') return fromUrl
  try { return localStorage.getItem(TIMES_KEY) === 'raw' ? 'raw' : 'model' } catch { return 'model' }
})()

const modelOn = () => timesMode === 'model'

function setTimesMode(mode) {
  timesMode = mode === 'raw' ? 'raw' : 'model'
  try { localStorage.setItem(TIMES_KEY, timesMode) } catch { /* storage is optional */ }
  const url = new URLSearchParams(window.location.search)
  if (timesMode === 'raw') url.set('times', 'raw')
  else url.delete('times')
  window.history.replaceState(null, '', `${window.location.pathname}?${url}${window.location.hash}`)
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

// When a train that left at `depMs` arrives at the next stop (ms): the corrected timetable, pulled towards
// the kinematic trip when the distance is known.
function predictArrival(depMs, schedDepMs, schedArrMs, km, cls) {
  const lateMin = Math.max((depMs - schedDepMs) / 60000, 0)
  if (!modelOn()) return schedArrMs + lateMin * 60000
  const travel = Math.max(0.5, (schedArrMs - schedDepMs) / 60000)
  const timetable = schedArrMs + (lateMin + delayDrift(lateMin, travel)) * 60000
  const guess = Number.isFinite(km) && km > 0.05
    ? KINEMATIC_WEIGHT * (depMs + motionProfile(km, cls).minutes * 60000) + (1 - KINEMATIC_WEIGHT) * timetable
    : timetable
  return Math.max(guess, schedArrMs - 30000)
}

// Predicted times for the stops after `lastPassed`: Map(stop index -> { arrDelay, depDelay, arrMs, depMs })
// (delays in min against the timetable), and `leaveMs`, when the train leaves `lastPassed`.
// opts: { inStation, distKm(i) (km between stop i and i + 1, or null), cls, nowMs }
function predictStopTimes(stops, delayNow, lastPassed, opts = {}) {
  const { inStation = false, distKm = () => null, cls = 'reg', nowMs = Date.now() } = opts
  const arr = f => f.arrivo_teorico || f.programmata
  const dep = f => f.partenza_teorica || f.programmata
  const out = new Map()
  const from = Math.max(lastPassed, 0)
  const here = stops[from]
  if (!here) return out
  const late = Math.max(delayNow, 0)

  // when the train leaves the stop it is at (or has left)
  let depMs
  if (lastPassed >= 0 && here.partenzaReale) depMs = here.partenzaReale
  else if (!modelOn()) depMs = dep(here) + late * 60000
  else if (inStation && here.arrivoReale) {
    const sched = Math.max(0, (dep(here) - arr(here)) / 60000)
    depMs = Math.max(dep(here), here.arrivoReale + dwellExpected(sched, cls).mid * 60000)
    depMs = Math.max(depMs, nowMs + 30000) // it is still here: it leaves at any moment
  } else depMs = dep(here) + late * 60000
  out.leaveMs = depMs

  for (let i = from + 1; i < stops.length; i++) {
    const prev = stops[i - 1]
    const arrMs = predictArrival(depMs, dep(prev), arr(stops[i]), distKm(i - 1), cls)
    const isLast = i === stops.length - 1
    let nextDep = depMs
    if (!modelOn()) nextDep = dep(stops[i]) + late * 60000
    else if (!isLast) nextDep = Math.max(dep(stops[i]), arrMs + dwellExpected((dep(stops[i]) - arr(stops[i])) / 60000, cls).mid * 60000)
    out.set(i, { arrDelay: (arrMs - arr(stops[i])) / 60000, depDelay: (nextDep - dep(stops[i])) / 60000, arrMs, depMs: nextDep })
    depMs = nextDep
  }
  return out
}

// Runs `fn` as if the times mode were `mode`, to compare the two on the same train.
function withTimesMode(mode, fn) {
  const previous = timesMode
  timesMode = mode
  try { return fn() } finally { timesMode = previous }
}
