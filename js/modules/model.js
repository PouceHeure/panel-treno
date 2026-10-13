// The prediction model shared by every view: how a late train's times are projected onto the stops ahead.
//
// "raw" keeps the announced delay unchanged on every following stop (scheduled time + delay).
// "model" corrects it with what trains were seen doing in 240 trains / 3 700 segments collected over a day
// (Liguria, mostly regional trains):
// - the announced delay overstates the arrival delay: the median change between a departure and the next
//   arrival is about -2 min once the train is late (0 when it is on time), spread about 1.5 min;
// - a train stays in a station about 1 min longer than the timetable says.
// On those data the next-arrival error goes from 3.2 to 2.4 min on average (calibrated and measured on the
// same day, so the real gain on other days is probably smaller).
const TIMES_KEY = 'panelTreno.times'

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

// How much of a delay a train typically recovers on one segment (negative), at most half of its travel time.
function delayDrift(minutes, travelMin = Infinity) {
  if (!modelOn() || minutes <= 0.5) return 0
  return Math.max(-Math.min(minutes, 2.2 + 0.04 * minutes), -0.5 * travelMin)
}
const dwellExtraMin = () => (modelOn() ? 1 : 0)

// The delay with which a train announced `delay` late arrives one segment further.
function adjustedDelay(delay, travelMin = Infinity) {
  const d = Math.max(delay, 0)
  return Math.max(0, d + delayDrift(d, travelMin))
}

// Predicted times for the stops after `lastPassed`: Map(stop index -> { arrDelay, depDelay, arrMs, depMs }),
// and `leaveMs`, when the train leaves `lastPassed` (to be used when it is still in that station).
function predictStopTimes(stops, delayNow, lastPassed, inStation) {
  const arr = f => f.arrivo_teorico || f.programmata
  const dep = f => f.partenza_teorica || f.programmata
  const out = new Map()
  const from = Math.max(lastPassed, 0)
  let depDelay = Math.max(delayNow, 0) + (inStation ? dwellExtraMin() : 0)
  out.leaveMs = stops[from] ? dep(stops[from]) + depDelay * 60000 : null
  for (let i = from + 1; i < stops.length; i++) {
    const travel = Math.max(0.5, (arr(stops[i]) - dep(stops[i - 1])) / 60000)
    const arrDelay = Math.max(0, depDelay + delayDrift(depDelay, travel))
    depDelay = arrDelay + (i < stops.length - 1 ? dwellExtraMin() : 0)
    out.set(i, { arrDelay, depDelay, arrMs: arr(stops[i]) + arrDelay * 60000, depMs: dep(stops[i]) + depDelay * 60000 })
  }
  return out
}
