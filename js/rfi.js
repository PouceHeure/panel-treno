// Official RFI station board (the one shown in the station), grouped by platform.
// RFI serves an HTML page with no CORS headers: it goes through the same relays as ViaggiaTreno.
const REFRESH_INTERVAL = 30 * 1000 // ms
const LOCALE = 'en-GB'

const $ = id => document.getElementById(id)
const params = new URLSearchParams(window.location.search)
const stationID = params.get('stationID') || ''
const stationName = params.get('stationName') || ''
let arrivals = params.get('arrivals') === '1'
let placeId = null
let lastRows = null
let lastSuccess = null
const expanded = new Set()

function el(tag, classes = [], text) {
  const node = document.createElement(tag)
  node.classList.add(...classes.filter(Boolean))
  if (text !== undefined) node.textContent = text
  return node
}
const icon = name => el('i', ['bi', name])

function syncUrl() {
  const p = new URLSearchParams({ stationID })
  if (stationName) p.set('stationName', stationName)
  if (arrivals) p.set('arrivals', '1')
  history.replaceState(null, '', `?${p}`)
}

function updateClock() {
  const chars = new Date().toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' }).split('')
  $('currentTime').replaceChildren(
    ...chars.map(ch => (ch === ':' ? el('span', ['clock-colon'], ':') : el('span', ['clock-digit'], ch)))
  )
}

function syncHeaderSpacerHeight() {
  $('headerSpacer').style.height = `${document.querySelector('.app-header').offsetHeight}px`
}

function renderMessage(iconName, text, detail) {
  const box = el('div', ['state-box'])
  box.append(icon(iconName), el('p', [], text))
  if (detail) box.append(el('p', ['state-detail'], detail))
  $('rfiBoard').replaceChildren(box)
}

// ---- display ----
function minutesUntil(time) {
  const [h, m] = time.split(':').map(Number)
  if (Number.isNaN(h)) return null
  const now = new Date()
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m)
  let diff = Math.round((target - now) / 60000)
  if (diff < -720) diff += 1440
  return diff
}

function countdown(row) {
  if (row.departing) return arrivals ? 'arriving' : 'now'
  const diff = minutesUntil(row.time)
  if (diff === null) return ''
  if (diff <= 0) return 'now'
  return diff < 60 ? `${diff} min` : `${Math.floor(diff / 60)}h${String(diff % 60).padStart(2, '0')}`
}

function addMinutes(time, delay) {
  const [h, m] = time.split(':').map(Number)
  const total = (h * 60 + m + delay) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function rfiRow(row) {
  const key = `${row.number}-${row.time}`
  const open = expanded.has(key)
  const node = el('div', ['flap-row', row.departing ? 'is-at-platform' : '', row.stops ? 'is-clickable' : '', open ? 'is-expanded' : ''])
  if (row.stops) {
    node.setAttribute('role', 'button')
    node.setAttribute('tabindex', '0')
    node.setAttribute('aria-expanded', String(open))
    const toggle = () => { open ? expanded.delete(key) : expanded.add(key); renderBoard() }
    node.addEventListener('click', toggle)
    node.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } })
  }

  const tile = el('span', ['platform-tile', row.departing ? 'is-at-platform' : 'is-not-here'], row.platform || '–')
  if (row.platform.length > 2) tile.classList.add('is-long')
  const sched = el('span', ['flap-time'], row.time)
  const real = el('span', ['flap-realcell'])
  if (row.delay > 0) {
    real.append(el('span', ['flap-time', 'is-late'], addMinutes(row.time, row.delay)), el('span', ['delay-chip', 'is-late'], `+${row.delay} min`))
  } else {
    real.append(el('span', ['flap-time', 'flap-none'], row.time))
  }
  const dest = el('span', ['flap-dest'])
  dest.append(el('span', ['flap-dest-name'], row.place || '—'))
  const meta = el('span', ['flap-meta'], `${row.category} ${row.number}`.trim())
  if (row.operator) meta.append(` · ${row.operator.toLowerCase()}`)
  dest.append(meta)
  const count = el('span', ['flap-countdown'], countdown(row))
  if (row.departing) count.classList.add('is-at-platform')
  node.append(tile, sched, real, dest, count)
  return node
}

function comparePlatforms(a, b) {
  if (!a && !b) return 0
  if (!a) return 1
  if (!b) return -1
  const na = parseInt(a, 10)
  const nb = parseInt(b, 10)
  if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb
  return a.localeCompare(b, 'en', { numeric: true })
}

function renderBoard() {
  if (!lastRows) return
  if (!lastRows.length) return renderMessage('bi-inbox', 'No trains announced right now.')
  const groups = new Map()
  lastRows.forEach(r => {
    if (!groups.has(r.platform)) groups.set(r.platform, [])
    groups.get(r.platform).push(r)
  })
  const sections = [...groups.keys()].sort(comparePlatforms).map(platform => {
    const section = el('section', ['flap-card'])
    const title = el('header', ['flap-title'])
    title.append(icon('bi-signpost-2'), el('span', [], platform ? `Platform ${platform}` : 'No platform yet'))
    const cols = el('div', ['flap-row', 'flap-cols'])
    ;['plt', 'sched', 'real', arrivals ? 'from' : 'to', 'in'].forEach(name => cols.append(el('span', [], name)))
    section.append(title, cols)
    groups.get(platform).forEach(r => {
      section.append(rfiRow(r))
      if (expanded.has(`${r.number}-${r.time}`) && r.stops) {
        section.append(el('p', ['rfi-stops'], `Stops at: ${r.stops}`))
      }
    })
    return section
  })
  const grid = el('div', ['card-grid', sections.length > 1 ? 'is-multi' : 'is-single'])
  grid.append(...sections)
  $('rfiBoard').replaceChildren(grid)
}

// ---- footer status ----
function setStatus(ok) {
  const report = lastProxyReport
  $('liveDot').classList.remove('is-pending')
  $('liveDot').classList.toggle('is-offline', !ok)
  const label = $('statusLabel')
  label.textContent = ok ? 'Connected' : 'Request failed'
  label.className = ok ? 'is-ok' : 'is-late'
  const time = d => d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  if (ok) {
    $('updateDate').textContent = ` · Updated ${time(lastSuccess)}`
    $('statusDetail').textContent = `via ${report.via}`
  } else {
    $('updateDate').textContent = lastSuccess ? ` · last data ${time(lastSuccess)}` : ''
    $('statusDetail').textContent = describeProxyReport(report) || 'unknown error'
  }
}

function applyDirection() {
  $('directionLabel').textContent = arrivals ? 'Departures' : 'Arrivals'
  $('directionToggle').querySelector('i').className = `bi ${arrivals ? 'bi-box-arrow-up-right' : 'bi-box-arrow-in-down-right'}`
  $('stationTitle').textContent = `${stationName || stationID} · ${arrivals ? 'arrivals' : 'departures'}`
  document.title = `${stationName || stationID} RFI ${arrivals ? 'arrivals' : 'departures'} · Panel Treno`
  if (placeId) $('officialLink').href = rfiMonitorUrl(placeId, arrivals)
  syncUrl()
}

let loading = 0
async function load() {
  const request = ++loading
  let rows
  try {
    rows = await fetchRfiRows(placeId, arrivals)
  } catch (err) {
    if (request !== loading) return
    console.error('Error fetching the RFI board:', err)
    setStatus(false)
    if (!lastRows) renderMessage('bi-wifi-off', 'Could not load the RFI board.', describeProxyReport(lastProxyReport) || err.message)
    return
  }
  if (request !== loading) return
  lastRows = rows
  lastSuccess = new Date()
  setStatus(true)
  renderBoard()
}

async function init() {
  $('homeLink').title = 'Home: search a station or a train'
  window.addEventListener('resize', syncHeaderSpacerHeight)
  new ResizeObserver(syncHeaderSpacerHeight).observe(document.querySelector('.app-header'))
  setInterval(updateClock, 1000)
  updateClock()
  $('statusLabel').textContent = 'Connecting…'

  $('directionToggle').addEventListener('click', () => {
    arrivals = !arrivals
    lastRows = null
    applyDirection()
    renderMessage('bi-hourglass-split', 'Connecting…')
    load()
  })

  const ids = await loadRfiIds()
  placeId = ids[stationID]
  if (placeId) initSourceSwitch('rfi', stationID, stationName)
  applyDirection()
  if (!placeId) {
    $('directionToggle').hidden = true
    $('officialLink').hidden = true
    $('statusLabel').textContent = ''
    return renderMessage('bi-question-circle', stationID ? 'RFI has no board for this station.' : 'No station given.')
  }
  renderMessage('bi-hourglass-split', 'Connecting…')
  load()
  setInterval(load, REFRESH_INTERVAL)
}

document.addEventListener('DOMContentLoaded', init)
