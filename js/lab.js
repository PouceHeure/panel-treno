// Lab: the data collected, the models and how each one scored on a day it never saw.
const $ = id => document.getElementById(id)

function node(tag, className, text) {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

const minutes = v => (v === null || v === undefined ? '–' : `${v.toFixed(1)} min`)
const percent = v => `${Math.round(v * 100)} %`

function sectionHead(text) {
  const head = node('div', 'recent-head')
  head.append(node('span', '', text))
  return head
}

function tile(name, value, sub) {
  const t = node('div', 'lab-tile')
  t.append(node('div', 'lab-tile-name', name), node('div', 'lab-tile-value', value), node('div', 'lab-tile-sub', sub))
  return t
}

function renderData(report) {
  const box = $('labData')
  if (!report) return box.replaceChildren(node('p', 'result-hint', 'No report yet. Run scripts/evaluate.py on an export to produce data/model-report.json.'))
  const d = report.data
  const grid = node('div', 'lab-tiles')
  grid.append(
    tile('trains', String(d.trains), `${d.stops} stops`),
    tile('days', String(daysAvailable(report)), Object.keys(d.days).length > daysAvailable(report) ? 'one more is a fragment' : 'with enough trains'),
    tile('real arrivals', percent(d.real_arrival_share), `departures ${percent(d.real_departure_share)}`)
  )
  box.replaceChildren(grid)
}

function modelCard(model, report, active) {
  const status = modelStatus(model, report, active)
  const card = node('div', `lab-model is-${status.replace(' ', '-')}`)
  const top = node('div', 'lab-model-top')
  top.append(node('strong', '', model.label), node('span', 'lab-chip', status))
  card.append(top, node('p', 'lab-model-sum', model.summary))
  const score = report && report.models && report.models[model.id]
  if (score) {
    const better = beatsBaseline(model, report)
    const lines = [`Error ${minutes(score.mae_1_to_6)} over the next 1 to 6 stops`, `half the time under ${minutes(score.median_abs)}, 9 times in 10 under ${minutes(score.p90_abs)}`]
    if (better && report.gain_vs_raw) lines.push(`${percent(report.gain_vs_raw)} better than the baseline`)
    if (model.role === 'baseline') lines.push('what the other models must beat')
    lines.forEach(l => card.append(node('p', 'lab-model-stat', l)))
  } else if (!model.mode) {
    const have = report && report.readiness && report.readiness[model.id] ? report.readiness[model.id].have_days : 0
    const bar = node('div', 'lab-bar')
    const fill = node('div', 'lab-bar-fill')
    fill.style.width = `${Math.min(100, Math.round((have / model.needsDays) * 100))}%`
    bar.append(fill)
    card.append(bar, node('p', 'lab-model-stat', `${have} of ${model.needsDays} days of data`))
  }
  if (status === 'available') {
    const use = node('button', 'route-open', 'Use this model')
    use.type = 'button'
    use.addEventListener('click', () => { setTimesMode(model.mode); renderAll() })
    card.append(use)
  }
  return card
}

function renderModels(report) {
  const list = node('div', 'lab-models')
  list.append(...MODEL_REGISTRY.map(m => modelCard(m, report, timesMode)))
  $('labModels').replaceChildren(sectionHead('Models'), list)
}

function renderInterval(report) {
  const box = $('labInterval')
  const table = report && report.interval_90
  if (!table || !Object.keys(table).length) return box.replaceChildren()
  const rows = ['1', '3', '6'].filter(k => table[k]).map(k => {
    const r = table[k]
    const row = node('div', 'lab-interval')
    const sign = v => (v > 0 ? `+${v}` : String(v))
    row.append(node('span', '', k === '1' ? 'next stop' : `${k} stops ahead`), node('strong', '', `${sign(r.lo)} to ${sign(r.hi)} min`), node('small', '', `around the estimate · covered ${percent(r.coverage_on_test)}`))
    return row
  })
  box.replaceChildren(sectionHead('How far off an estimate can be'), ...rows)
}

function renderDevice() {
  const s = predictionStats()
  const box = $('labDevice')
  const body = s.checked
    ? node('p', 'lab-model-stat', `${s.checked} predictions checked against real arrivals. Mean error: raw ${minutes(s.rawMae)}, recovery rules ${minutes(s.modelMae)}.`)
    : node('p', 'lab-model-stat', 'Nothing checked yet. Open a train and its arrivals are compared with what each model expected.')
  box.replaceChildren(sectionHead('On this device'), body)
}

function renderFoot(report) {
  $('labFoot').textContent = report
    ? `Scored on ${report.split.test_day || 'no day yet'}, a day the models were not fitted on. Data exported ${report.source_exported_at.slice(0, 10)}, evaluated ${report.generated_at.slice(0, 10)}.`
    : ''
}

let currentReport = null
function renderAll() {
  renderData(currentReport)
  renderModels(currentReport)
  renderInterval(currentReport)
  renderDevice()
  renderFoot(currentReport)
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const r = await fetch('data/model-report.json')
    currentReport = r.ok ? await r.json() : null
  } catch { currentReport = null }
  renderAll()
})
