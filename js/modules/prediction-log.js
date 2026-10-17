// The app checks its own predictions: whenever a train is on screen, it keeps what each model expected for the
// stops ahead, and when the real arrival shows up, the difference. Everything stays in this browser.
// Needs js/modules/model.js (the models) when run in a page.
const PENDING_KEY = 'panelTreno.predictions'
const RESULTS_KEY = 'panelTreno.predictionResults'
const RESULTS_MAX = 300
const WATCH_AHEAD = 3 // stops ahead of the train whose prediction is kept

function readStore(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key))
    return v ?? fallback
  } catch { return fallback }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable: the log is a convenience */ }
}

// Pure: the pending predictions of one train against its stops; returns the results that can be closed now.
function resolvePredictions(pending, stops, trainKey) {
  const closed = []
  Object.keys(pending).forEach(key => {
    if (!key.startsWith(`${trainKey}#`)) return
    const index = Number(key.split('#')[1])
    const real = stops[index] && stops[index].arrivoReale
    if (!real) return
    const p = pending[key]
    closed.push({ key, train: trainKey, stop: index, k: p.k, at: p.at, rawErrMin: (p.raw - real) / 60000, modelErrMin: (p.model - real) / 60000, tablesErrMin: p.tables === undefined ? null : (p.tables - real) / 60000 })
    delete pending[key]
  })
  return closed
}

// Keeps the latest prediction of both models for the next stops, and closes those whose arrival is now real.
function logPredictions(detail, nowMs = Date.now()) {
  const stops = (detail && detail.fermate) || []
  if (!stops.length || !detail.numeroTreno || detail.provvedimento === 1) return
  const trainKey = `${detail.numeroTreno}-${detail.dataPartenzaTreno || detail.dataPartenza || ''}`
  const pending = readStore(PENDING_KEY, {})
  const closed = resolvePredictions(pending, stops, trainKey)
  const lastPassed = stops.reduce((last, f, i) => (f.actualFermataType === 1 ? i : last), -1)
  const here = stops[Math.max(lastPassed, 0)]
  const opts = { inStation: lastPassed >= 0 && !here.partenzaReale, cls: trainClass(detail), nowMs }
  const raw = withTimesMode('raw', () => predictStopTimes(stops, detail.ritardo || 0, lastPassed, opts))
  const model = withTimesMode('model', () => predictStopTimes(stops, detail.ritardo || 0, lastPassed, opts))
  const tables = withTimesMode('tables', () => predictStopTimes(stops, detail.ritardo || 0, lastPassed, opts))
  for (let k = 1; k <= WATCH_AHEAD; k++) {
    const i = Math.max(lastPassed, 0) + k
    if (i >= stops.length || stops[i].arrivoReale) continue
    if (raw.get(i) && model.get(i)) pending[`${trainKey}#${i}`] = { k, at: nowMs, raw: raw.get(i).arrMs, model: model.get(i).arrMs, tables: tables.get(i) && tables.get(i).arrMs }
  }
  // old predictions of trains that never reported an arrival do not stay forever
  Object.keys(pending).forEach(key => { if (nowMs - pending[key].at > 6 * 3600000) delete pending[key] })
  writeStore(PENDING_KEY, pending)
  if (closed.length) writeStore(RESULTS_KEY, readStore(RESULTS_KEY, []).concat(closed).slice(-RESULTS_MAX))
}

// What this device measured: how many predictions were checked, and the mean error of each model.
function predictionStats() {
  const results = readStore(RESULTS_KEY, [])
  const mean = values => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null)
  return {
    checked: results.length,
    rawMae: mean(results.map(r => Math.abs(r.rawErrMin))),
    modelMae: mean(results.map(r => Math.abs(r.modelErrMin))),
    tablesMae: mean(results.filter(r => r.tablesErrMin !== null && r.tablesErrMin !== undefined).map(r => Math.abs(r.tablesErrMin)))
  }
}

if (typeof module !== 'undefined') {
  module.exports = { resolvePredictions, predictionStats }
}
