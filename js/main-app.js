// =======================
// Constants
// =======================
const APP_VERSION = '2.0.0'
const REFRESH_REQUEST_INTERVAL = 30 * 1000 // ms
const CLOCK_INTERVAL = 10 * 1000 // ms
const TRAIN_MODE_KEY = 'ALL'
const GROUP_MODES = ['platform', 'destination', 'category', 'train']
const GROUP_ITEM_LIMIT = { platform: 3, destination: 3, category: 3, train: 20 }
const VIEWS = ['board', 'nerd']
const LOCALE = 'en-GB'
const LATE_THRESHOLD = 5 // min: from this delay a train counts as late in the nerd stats
const TIMELINE_MINUTES = 60
const HORIZON_MINUTES = 180 // window of the density / scatter / busiest-platform panels
const SLOT_MINUTES = 15
const NERD_TABLE_LIMIT = 25

const LABELS = {
  serviceOFF: 'No departures',
  noMatch: 'No match for this filter',
  connecting: 'Connecting…',
  loadError: 'Could not load departures',
  retry: 'Retry',
  search: 'Search station',
  update: 'Updated',
  platform: 'Platform',
  platformUnknown: 'No platform yet',
  atPlatform: 'at platform',
  now: 'now',
  filter: 'Filter',
  filterPlaceholder: 'Filter…',
  filterHint: 'Separate several values with a comma, | or "or" (e.g. torino, milano)',
  nextDepartures: 'Next departures',
  destinationUnknown: 'Unknown destination',
  categoryUnknown: 'Other',
  groupByPlatform: 'By platform',
  groupByDestination: 'By destination',
  groupByCategory: 'By train type',
  groupByTrain: 'By next departures',
  viewNerd: 'nerd mode',
  viewBoard: 'board'
}
const GROUP_LABEL_KEYS = {
  platform: 'groupByPlatform',
  destination: 'groupByDestination',
  category: 'groupByCategory',
  train: 'groupByTrain'
}
const GROUP_ICONS = {
  platform: 'bi-signpost-2',
  destination: 'bi-signpost-split',
  category: 'bi-train-front',
  train: 'bi-list-ul'
}

// Train type families (used for the nerd breakdown)
const CATEGORY_FAMILIES = [
  { name: 'regional', codes: ['REG', 'R', 'RV'], color: '#8a8f9c' },
  { name: 'intercity', codes: ['IC', 'ICN'], color: '#4aa3ff' },
  { name: 'freccia', codes: ['FR', 'FA', 'FB', 'ES'], color: '#e5484d' },
  { name: 'eurocity', codes: ['EC', 'EN'], color: '#6f7cff' }
]
const OTHER_FAMILY = { name: 'other', color: '#6b6757' }

// =======================
// State
// =======================
let stationID = 'S01700' // Default station: Milano Centrale
let stationName = null
let lastUpdateData = null
let groupByMode = 'platform'
let groupFilterText = ''
let viewMode = 'board'

// =======================
// Helpers
// =======================
const label = key => LABELS[key]
const $ = id => document.getElementById(id)

function el(tag, classes = [], text) {
  const node = document.createElement(tag)
  const names = classes.filter(Boolean)
  if (names.length) node.classList.add(...names)
  if (text !== undefined) node.textContent = text
  return node
}
function icon(name) {
  return el('i', ['bi', name])
}
const SVG_NS = 'http://www.w3.org/2000/svg'
function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag)
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v))
  if (text !== undefined) node.textContent = text
  return node
}

function getParam(name) {
  return new URLSearchParams(window.location.search).get(name)
}

// Keep the view state in the URL (no reload) so a view can be bookmarked or shared.
function syncStateToURL() {
  const params = new URLSearchParams(window.location.search)
  params.set('groupby', groupByMode)
  if (groupFilterText) params.set('groupfilter', groupFilterText)
  else params.delete('groupfilter')
  if (viewMode === 'nerd') params.set('view', 'nerd')
  else params.delete('view')
  window.history.replaceState(null, '', `${window.location.pathname}?${params}${window.location.hash}`)
}

function formatTime(date, withSeconds = false) {
  return date.toLocaleTimeString(LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds && { second: '2-digit' })
  })
}
function formatEpochHHMM(epochMs) {
  return epochMs ? formatTime(new Date(epochMs)) : null
}
function delayOf(train) {
  return typeof train.ritardo === 'number' ? train.ritardo : 0
}
function realDepartureMs(train) {
  return train.orarioPartenza ? train.orarioPartenza + delayOf(train) * 60000 : null
}
function scheduledLabel(train) {
  return train.compOrarioPartenza || formatEpochHHMM(train.orarioPartenza) || '—'
}
function realLabel(train) {
  return delayOf(train) !== 0 ? formatEpochHHMM(realDepartureMs(train)) : null
}
function trainLabel(train) {
  return `${(train.categoria || '').trim()} ${train.numeroTreno}`.trim()
}

// Minutes until the real departure, as a short label ("now", "9 min", "1h05").
function countdownLabel(train, now = Date.now()) {
  if (trainPresence(train, now) === 'at-platform') return label('now')
  const real = realDepartureMs(train)
  if (!real) return ''
  const minutes = Math.max(0, Math.ceil((real - now) / 60000))
  if (minutes === 0) return label('now')
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
}

// Some stations report platforms as roman numerals ("III", "IV"…): show arabic numbers.
const ROMAN_VALUES = { M: 1000, CM: 900, D: 500, CD: 400, C: 100, XC: 90, L: 50, XL: 40, X: 10, IX: 9, V: 5, IV: 4, I: 1 }
function romanToArabic(str) {
  const s = str.toUpperCase()
  const keys = Object.keys(ROMAN_VALUES)
  let i = 0
  let result = 0
  while (i < s.length) {
    const pair = keys.find(k => k.length === 2 && s.startsWith(k, i))
    if (pair) {
      result += ROMAN_VALUES[pair]
      i += 2
    } else {
      const single = ROMAN_VALUES[s[i]]
      if (!single) return null
      result += single
      i += 1
    }
  }
  return result
}
function normalizePlatformLabel(raw) {
  if (!raw) return null
  const trimmed = raw.trim()
  const match = trimmed.match(/^([MDCLXVI]+)(.*)$/i)
  const arabic = match && romanToArabic(match[1])
  return arabic ? `${arabic}${match[2]}`.trim() : trimmed
}
function platformOf(train) {
  return normalizePlatformLabel(train.binarioEffettivoPartenzaDescrizione || train.binarioProgrammatoPartenzaDescrizione)
}
function comparePlatforms(a, b) {
  const na = parseInt(a, 10)
  const nb = parseInt(b, 10)
  if (isNaN(na) && isNaN(nb)) return a.localeCompare(b)
  if (isNaN(na)) return 1
  if (isNaN(nb)) return -1
  return na - nb || a.localeCompare(b)
}

// 'at-platform' when the API says the train is in the station, otherwise null.
// The API keeps inStazione=true after a train has left, so a train whose real
// departure time is already past is never reported as present. Nothing else is
// claimed: the API does not say how close a running train is.
function trainPresence(train, now = Date.now()) {
  const real = realDepartureMs(train)
  if (real && real < now) return null
  return train.inStazione ? 'at-platform' : null
}

function delayClass(delay) {
  if (delay >= LATE_THRESHOLD) return 'is-late'
  if (delay > 0) return 'is-slight'
  return 'is-ok'
}

// =======================
// Data selection (shared by both views)
// =======================
// The API still lists trains that already left: keep only those not yet gone.
function upcomingTrains(trainData, now = Date.now()) {
  return trainData
    .filter(t => !t.nonPartito || t.orarioPartenza)
    .filter(t => {
      const real = realDepartureMs(t)
      return !real || real >= now - 60000
    })
    .sort((a, b) => (realDepartureMs(a) || 0) - (realDepartureMs(b) || 0))
}

// "torino, milano" / "torino | milano" / "torino or milano" -> match any of the terms.
function parseFilterTerms(text) {
  return text.split(/\s*(?:,|\||\bor\b)\s*/i).map(t => t.trim()).filter(Boolean)
}
function matchesAnyTerm(haystack, terms) {
  const h = haystack.toLowerCase()
  return terms.some(term => h.includes(term))
}
function trainMatchesFilter(train, terms) {
  return matchesAnyTerm(`${train.categoria || ''} ${train.numeroTreno || ''} ${train.destinazione || ''}`, terms)
}

// =======================
// Grouping (board view)
// =======================
function getGroupKey(train, mode) {
  if (mode === 'destination') return train.destinazione || label('destinationUnknown')
  if (mode === 'category') return (train.categoria || '').trim() || label('categoryUnknown')
  if (mode === 'train') return TRAIN_MODE_KEY
  return platformOf(train) || label('platformUnknown')
}
function groupHeaderLabel(mode, key) {
  if (mode === 'platform') return key === label('platformUnknown') ? key : `${label('platform')} ${key}`
  if (mode === 'train') return label('nextDepartures')
  return key
}
function sortGroupKeys(mode, keys) {
  if (mode === 'train') return keys
  if (mode !== 'platform') return keys.sort((a, b) => a.localeCompare(b))
  return keys.sort(comparePlatforms)
}

// Returns [{ key, trains }] ready to render (grouped, sorted, filtered, limited).
function buildGroups(trainData) {
  const filterTerms = parseFilterTerms(groupFilterText)
  const groups = new Map()
  upcomingTrains(trainData).forEach(train => {
    if (groupByMode === 'train' && filterTerms.length && !trainMatchesFilter(train, filterTerms)) return
    const key = getGroupKey(train, groupByMode)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(train)
  })

  let keys = sortGroupKeys(groupByMode, Array.from(groups.keys()))
  if (filterTerms.length && groupByMode !== 'train') {
    keys = keys.filter(key => matchesAnyTerm(key, filterTerms))
  }
  const limit = GROUP_ITEM_LIMIT[groupByMode] ?? 3
  return keys.map(key => ({ key, trains: groups.get(key).slice(0, limit) }))
}

// =======================
// Board view
// =======================
function renderMessage(iconName, text, withRetry = false) {
  const box = el('div', ['state-box'])
  box.append(icon(iconName), el('p', [], text))
  if (withRetry) {
    const btn = el('button', ['btn-retry'], 'Retry')
    btn.type = 'button'
    btn.addEventListener('click', () => {
      renderMessage('bi-hourglass-split', label('connecting'))
      fetchAndDisplay()
    })
    box.append(btn)
  }
  $('trainInfo').replaceChildren(box)
}

function boardRow(train, now) {
  const delay = delayOf(train)
  const presence = trainPresence(train, now) || 'not-here'
  const platform = platformOf(train)
  const real = realLabel(train)

  const row = el('div', ['flap-row', `is-${presence}`])

  const tile = el('span', ['platform-tile', `is-${presence}`], platform || '–')
  tile.title = platform ? `${label('platform')} ${platform}` : label('platformUnknown')
  if (platform && platform.length > 2) tile.classList.add('is-long')

  const sched = el('span', ['flap-time'], scheduledLabel(train))
  const realEl = el('span', ['flap-realcell'])
  if (real) {
    const tone = delay > 0 ? 'is-late' : 'is-early'
    realEl.append(
      el('span', ['flap-time', tone], real),
      el('span', ['delay-chip', tone], delay > 0 ? `+${delay} min` : `${delay} min`)
    )
  } else {
    realEl.append(el('span', ['flap-time', 'flap-none'], '--'))
  }

  const dest = el('span', ['flap-dest'])
  dest.append(el('span', ['flap-dest-name'], train.destinazione || '—'))
  const meta = el('span', ['flap-meta'], trainLabel(train))
  if (presence === 'at-platform') {
    meta.append(' · ', el('span', ['is-at-platform'], label('atPlatform')))
  }
  dest.append(meta)

  const countdown = el('span', ['flap-countdown'], countdownLabel(train, now))
  if (presence === 'at-platform') countdown.classList.add('is-at-platform')
  row.append(tile, sched, realEl, dest, countdown)
  return row
}

function boardSection(group, now) {
  const section = el('section', ['flap-card'])
  const title = el('header', ['flap-title'])
  title.append(icon(GROUP_ICONS[groupByMode]), el('span', [], groupHeaderLabel(groupByMode, group.key)))
  const cols = el('div', ['flap-row', 'flap-cols'])
  ;['plt', 'sched', 'real', 'to', 'in'].forEach(name => cols.append(el('span', [], name)))
  section.append(title, cols)
  group.trains.forEach(train => section.append(boardRow(train, now)))
  return section
}

function renderBoard(trainData) {
  const groups = buildGroups(trainData)
  if (groups.length === 0) {
    const noData = upcomingTrains(trainData).length === 0
    renderMessage(noData ? 'bi-moon-stars' : 'bi-funnel', label(noData ? 'serviceOFF' : 'noMatch'))
    return
  }
  const now = Date.now()
  const grid = el('div', ['card-grid', groupByMode === 'train' ? 'is-single' : 'is-multi'])
  groups.forEach(group => grid.append(boardSection(group, now)))
  const legend = el('p', ['board-legend'], '-- : on time, or no live data yet')
  $('trainInfo').replaceChildren(grid, legend)
}

// =======================
// Nerd view
// =======================
function median(sorted) {
  if (!sorted.length) return 0
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function nerdStats(trains, now) {
  const delays = trains.map(t => Math.max(0, delayOf(t)))
  const onTime = delays.filter(d => d < LATE_THRESHOLD).length
  const worst = trains.reduce((best, t) => (!best || delayOf(t) > delayOf(best) ? t : best), null)
  const presences = trains.map(t => trainPresence(t, now))
  const platforms = new Set(trains.map(platformOf).filter(Boolean))
  return {
    total: trains.length,
    onTimePct: trains.length ? Math.round((onTime / trains.length) * 100) : 0,
    onTime,
    avgDelay: delays.length ? delays.reduce((a, b) => a + b, 0) / delays.length : 0,
    medianDelay: median([...delays].sort((a, b) => a - b)),
    worst: worst && delayOf(worst) > 0 ? worst : null,
    atPlatform: presences.filter(p => p === 'at-platform').length,
    platformsInUse: platforms.size
  }
}

function statTile(name, value, sub, valueClass = '') {
  const tile = el('div', ['stat-tile'])
  tile.append(el('div', ['stat-name'], name), el('div', ['stat-value', valueClass], value), el('div', ['stat-sub'], sub))
  return tile
}

function nerdStatTiles(stats) {
  const grid = el('div', ['stat-grid'])
  grid.append(
    statTile('on time', `${stats.onTimePct}%`, `${stats.onTime} / ${stats.total} · under ${LATE_THRESHOLD} min`, 'is-ok'),
    statTile('avg delay', `+${stats.avgDelay.toFixed(1)}m`, `median +${stats.medianDelay}m`, 'is-slight'),
    statTile(
      'worst',
      stats.worst ? `+${delayOf(stats.worst)}m` : '0m',
      stats.worst ? `${stats.worst.numeroTreno} · ${(stats.worst.destinazione || '').toLowerCase()}` : 'no delay',
      stats.worst ? 'is-late' : 'is-ok'
    ),
    statTile('at platform', String(stats.atPlatform), `of ${stats.total} upcoming`, 'is-here'),
    statTile('platforms', String(stats.platformsInUse), 'in use')
  )
  return grid
}

// Swimlane: one lane per platform, hollow dot = scheduled, filled dot = real time.
function nerdTimeline(trains, now) {
  const windowEnd = now + TIMELINE_MINUTES * 60000
  const inWindow = trains.filter(t => {
    const real = realDepartureMs(t)
    return real && real <= windowEnd && real >= now - 60000
  })
  const lanes = Array.from(new Set(inWindow.map(t => platformOf(t) || '–'))).sort(comparePlatforms)

  const panel = el('div', ['nerd-panel'])
  const head = el('div', ['nerd-panel-head'])
  head.append(el('span', [], 'platform x time'), el('span', ['nerd-dim'], '○ scheduled   ● real'))
  panel.append(head)
  if (!lanes.length) {
    panel.append(el('p', ['nerd-dim'], 'nothing in the next hour'))
    return panel
  }

  const LEFT = 78
  const RIGHT = 14
  const LANE_H = 22
  const TOP = 18
  const WIDTH = 640
  const plotW = WIDTH - LEFT - RIGHT
  const height = TOP + lanes.length * LANE_H + 22
  const span = TIMELINE_MINUTES * 60000
  const xOf = ms => LEFT + (Math.min(Math.max(ms - now, 0), span) / span) * plotW

  const svg = svgEl('svg', { viewBox: `0 0 ${WIDTH} ${height}`, role: 'img', class: 'timeline-svg' })
  svg.append(svgEl('title', {}, 'Platform timeline'))
  ;[0, 15, 30, 45, 60].forEach(minute => {
    const x = LEFT + (minute / TIMELINE_MINUTES) * plotW
    svg.append(svgEl('line', { x1: x, y1: TOP - 4, x2: x, y2: height - 20, class: minute === 0 ? 'tl-now' : 'tl-grid' }))
    svg.append(svgEl('text', { x, y: height - 6, class: 'tl-label', 'text-anchor': minute === 0 ? 'start' : 'middle' }, minute === 0 ? 'now' : formatTime(new Date(now + minute * 60000))))
  })
  lanes.forEach((lane, i) => {
    svg.append(svgEl('text', { x: 4, y: TOP + i * LANE_H + 14, class: 'tl-label' }, `plt ${lane}`))
  })
  inWindow.forEach(t => {
    const y = TOP + lanes.indexOf(platformOf(t) || '–') * LANE_H + 10
    const real = realDepartureMs(t)
    const sched = t.orarioPartenza
    const cls = delayClass(delayOf(t))
    if (delayOf(t) !== 0) svg.append(svgEl('line', { x1: xOf(sched), y1: y, x2: xOf(real), y2: y, class: `tl-link ${cls}` }))
    const tip = `${t.numeroTreno} ${t.destinazione || ''} · plt ${platformOf(t) || '–'} · ${scheduledLabel(t)} → ${formatEpochHHMM(real)}`
    const hollow = svgEl('circle', { cx: xOf(sched), cy: y, r: 4.5, class: 'tl-hollow' })
    const filled = svgEl('circle', { cx: xOf(real), cy: y, r: 4.5, class: `tl-dot ${cls}` })
    ;[hollow, filled].forEach(node => node.append(svgEl('title', {}, tip)))
    svg.append(hollow, filled)
  })
  panel.append(svg)
  return panel
}

// Trains whose real departure falls in [now - 1 min, now + HORIZON_MINUTES].
function trainsInHorizon(trains, now) {
  const end = now + HORIZON_MINUTES * 60000
  return trains.filter(t => {
    const real = realDepartureMs(t)
    return real && real >= now - 60000 && real <= end
  })
}

function svgChart(height, titleText) {
  const svg = svgEl('svg', { viewBox: `0 0 640 ${height}`, role: 'img', class: 'timeline-svg' })
  svg.append(svgEl('title', {}, titleText))
  return svg
}

// Delay (y) against scheduled time (x): do delays build up over the evening?
function nerdScatter(trains, now) {
  const points = trainsInHorizon(trains, now)
    .filter(t => t.orarioPartenza)
    .map(t => ({ train: t, x: t.orarioPartenza, delay: Math.max(0, delayOf(t)) }))
    .sort((a, b) => a.x - b.x)

  const panel = el('div', ['nerd-panel'])
  const head = el('div', ['nerd-panel-head'])
  head.append(el('span', [], 'delay vs scheduled time'))
  panel.append(head)
  if (!points.length) {
    panel.append(el('p', ['nerd-dim'], 'nothing in the next 3 hours'))
    return panel
  }

  const LEFT = 40
  const RIGHT = 12
  const TOP = 12
  const H = 150
  const plotH = H - TOP - 24
  const plotW = 640 - LEFT - RIGHT
  const span = HORIZON_MINUTES * 60000
  const maxDelay = Math.max(20, ...points.map(p => p.delay))
  const yMax = Math.ceil(maxDelay / 20) * 20 // multiple of 20 so the middle tick is a round number
  const xOf = ms => LEFT + (Math.min(Math.max(ms - now, 0), span) / span) * plotW
  const yOf = d => TOP + plotH - (Math.min(d, yMax) / yMax) * plotH

  const svg = svgChart(H, 'Delay versus scheduled time')
  for (let v = 0; v <= yMax; v += yMax / 2) {
    svg.append(svgEl('line', { x1: LEFT, y1: yOf(v), x2: 640 - RIGHT, y2: yOf(v), class: 'tl-grid' }))
    svg.append(svgEl('text', { x: 4, y: yOf(v) + 4, class: 'tl-label' }, `+${Math.round(v)}`))
  }
  ;[0, 60, 120, 180].forEach(minute => {
    svg.append(svgEl('text', {
      x: LEFT + (minute / HORIZON_MINUTES) * plotW,
      y: H - 6,
      class: 'tl-label',
      'text-anchor': minute === 0 ? 'start' : minute === HORIZON_MINUTES ? 'end' : 'middle'
    }, formatTime(new Date(now + minute * 60000))))
  })

  points.forEach(p => {
    const dot = svgEl('circle', { cx: xOf(p.x), cy: yOf(p.delay), r: 4, class: `tl-dot ${delayClass(p.delay)}` })
    dot.append(svgEl('title', {}, `${trainLabel(p.train)} ${p.train.destinazione || ''} · ${scheduledLabel(p.train)} · +${p.delay} min`))
    svg.append(dot)
  })
  panel.append(svg)
  return panel
}

// Departures per 15-minute slot over the horizon: when does the station get busy?
function nerdDepartureSlots(trains, now) {
  const slots = Array.from({ length: HORIZON_MINUTES / SLOT_MINUTES }, () => 0)
  trainsInHorizon(trains, now).forEach(t => {
    const index = Math.floor((realDepartureMs(t) - now) / (SLOT_MINUTES * 60000))
    if (index >= 0 && index < slots.length) slots[index] += 1
  })
  const max = Math.max(...slots)

  const panel = el('div', ['nerd-panel'])
  const head = el('div', ['nerd-panel-head'])
  const busiest = max > 0 ? slots.indexOf(max) : -1
  head.append(
    el('span', [], `departures per ${SLOT_MINUTES} min, next 3h`),
    el('span', ['nerd-dim'], busiest >= 0 ? `busiest: ${formatTime(new Date(now + busiest * SLOT_MINUTES * 60000))} (${max})` : '')
  )
  panel.append(head)
  if (max === 0) {
    panel.append(el('p', ['nerd-dim'], 'nothing in the next 3 hours'))
    return panel
  }

  const H = 118
  const barArea = 64
  const slotW = 640 / slots.length
  const svg = svgChart(H, 'Departures per time slot')
  slots.forEach((count, i) => {
    const h = (count / max) * barArea
    const bar = svgEl('rect', { x: i * slotW + 4, y: 22 + barArea - h, width: slotW - 8, height: Math.max(h, count ? 2 : 0), class: i === busiest ? 'slot-bar is-peak' : 'slot-bar' })
    bar.append(svgEl('title', {}, `${formatTime(new Date(now + i * SLOT_MINUTES * 60000))}: ${count} departures`))
    svg.append(bar)
    if (count) svg.append(svgEl('text', { x: i * slotW + slotW / 2, y: 18 + barArea - h, class: 'tl-label', 'text-anchor': 'middle' }, String(count)))
  })
  ;[0, 3, 6, 9].forEach(i => {
    svg.append(svgEl('text', { x: i * slotW + 4, y: H - 8, class: 'tl-label' }, formatTime(new Date(now + i * SLOT_MINUTES * 60000))))
  })
  panel.append(svg)
  return panel
}

function nerdBusiestPlatforms(trains, now) {
  const counts = new Map()
  trainsInHorizon(trains, now).forEach(t => {
    const platform = platformOf(t)
    if (platform) counts.set(platform, (counts.get(platform) || 0) + 1)
  })
  const rows = Array.from(counts, ([name, count]) => ({ name: `plt ${name}`, count, color: 'var(--here)' }))
    .sort((a, b) => b.count - a.count || comparePlatforms(a.name.slice(4), b.name.slice(4)))
    .slice(0, 8)
  return nerdPanel('busiest platforms, next 3h', rows.length ? barRows(rows) : el('p', ['nerd-dim'], 'no platform announced'))
}

function barRows(rows) {
  const max = Math.max(1, ...rows.map(r => r.count))
  const box = el('div', ['bar-rows'])
  rows.forEach(r => {
    const line = el('div', ['bar-row'])
    const track = el('div', ['bar-track'])
    const fill = el('div', ['bar-fill'])
    fill.style.width = `${(r.count / max) * 100}%`
    fill.style.background = r.color
    track.append(fill)
    line.append(el('span', ['bar-name'], r.name), track, el('span', ['bar-count'], String(r.count)))
    box.append(line)
  })
  return box
}

function nerdPanel(title, content) {
  const panel = el('div', ['nerd-panel'])
  panel.append(el('div', ['nerd-panel-head'], title), content)
  return panel
}

function nerdBreakdowns(trains, now) {
  const buckets = [
    { name: '0', test: d => d <= 0, color: 'var(--ok)' },
    { name: '1-2', test: d => d >= 1 && d <= 2, color: 'var(--slight)' },
    { name: '3-5', test: d => d >= 3 && d <= 5, color: 'var(--slight)' },
    { name: '6-15', test: d => d >= 6 && d <= 15, color: 'var(--late)' },
    { name: '15+', test: d => d > 15, color: 'var(--late)' }
  ].map(b => ({ ...b, count: trains.filter(t => b.test(delayOf(t))).length }))

  const destCounts = new Map()
  trains.forEach(t => {
    const name = (t.destinazione || label('destinationUnknown')).toLowerCase()
    destCounts.set(name, (destCounts.get(name) || 0) + 1)
  })
  const topDest = Array.from(destCounts, ([name, count]) => ({ name, count, color: 'var(--here)' }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 5)

  const families = [...CATEGORY_FAMILIES, OTHER_FAMILY].map(f => ({
    ...f,
    count: trains.filter(t => {
      const code = (t.categoria || '').trim().toUpperCase()
      return f === OTHER_FAMILY
        ? !CATEGORY_FAMILIES.some(x => x.codes.includes(code))
        : f.codes.includes(code)
    }).length
  })).filter(f => f.count > 0)

  const grid = el('div', ['nerd-panels'])
  grid.append(
    nerdPanel('delay distribution (min)', barRows(buckets)),
    nerdPanel('top destinations', barRows(topDest)),
    nerdPanel('by train type', barRows(families)),
    nerdBusiestPlatforms(trains, now)
  )
  return grid
}

function nerdTable(trains, now) {
  const table = el('div', ['nerd-table'])
  const head = el('div', ['nerd-trow', 'nerd-thead'])
  ;['plt', 'train', 'dest', 'sched', 'real', 'delta'].forEach(name => head.append(el('span', [], name)))
  table.append(head)
  trains.slice(0, NERD_TABLE_LIMIT).forEach(t => {
    const delay = delayOf(t)
    const presence = trainPresence(t, now)
    const real = realLabel(t)
    const row = el('div', ['nerd-trow'])
    row.append(
      el('span', [presence ? `is-${presence}` : 'nerd-dim'], platformOf(t) || '–'),
      el('span', [], trainLabel(t)),
      el('span', ['nerd-dest'], (t.destinazione || '—').toLowerCase()),
      el('span', [], scheduledLabel(t)),
      el('span', [real ? delayClass(delay) : 'nerd-dim'], real || '--'),
      el('span', [delayClass(delay)], delay > 0 ? `+${delay}` : String(delay))
    )
    table.append(row)
  })
  return table
}

function renderNerd(trainData) {
  const now = Date.now()
  const terms = parseFilterTerms(groupFilterText)
  const all = upcomingTrains(trainData, now)
  const trains = all.filter(t => !terms.length || trainMatchesFilter(t, terms))
  if (!trains.length) {
    renderMessage(all.length ? 'bi-funnel' : 'bi-moon-stars', label(all.length ? 'noMatch' : 'serviceOFF'))
    return
  }
  const wrap = el('div', ['nerd-wrap'])
  const prompt = el('p', ['nerd-prompt'], `$ treno --station ${(stationName || stationID).replace(/\s+/g, '_').toUpperCase()} --view nerd`)
  wrap.append(
    prompt,
    nerdStatTiles(nerdStats(trains, now)),
    nerdTimeline(trains, now),
    nerdScatter(trains, now),
    nerdDepartureSlots(trains, now),
    nerdBreakdowns(trains, now),
    nerdTable(trains, now)
  )
  $('trainInfo').replaceChildren(wrap)
}

// =======================
// Page chrome
// =======================
function render(trainData) {
  if (viewMode === 'nerd') renderNerd(trainData)
  else renderBoard(trainData)
}
function rerender() {
  if (lastUpdateData) render(lastUpdateData)
}

function updateClock() {
  const chars = formatTime(new Date()).split('')
  $('currentTime').replaceChildren(
    ...chars.map(ch => (ch === ':' ? el('span', ['clock-colon'], ':') : el('span', ['clock-digit'], ch)))
  )
}

function updateHeader() {
  updateClock()
  $('stationTitle').textContent = stationName || label('connecting')
  document.title = stationName ? `Train: ${stationName}` : 'Panel Treno'
  syncHeaderSpacerHeight()
}

// The header is fixed: keep the spacer under it exactly as tall as the header
// (its height varies with font size and station name wrapping).
function syncHeaderSpacerHeight() {
  $('headerSpacer').style.height = `${document.querySelector('.app-header').offsetHeight}px`
}

function setLiveStatus(ok, date) {
  $('liveDot').classList.toggle('is-offline', !ok)
  if (date) $('updateDate').textContent = `${label('update')} ${formatTime(date, true)}`
}

function applyView() {
  const nerd = viewMode === 'nerd'
  document.body.classList.toggle('view-nerd', nerd)
  $('viewToggleLabel').textContent = label(nerd ? 'viewBoard' : 'viewNerd')
  $('viewToggle').querySelector('i').className = `bi ${nerd ? 'bi-grid-3x2-gap' : 'bi-terminal'}`
  syncHeaderSpacerHeight()
}

// =======================
// Data
// =======================
async function fetchAndDisplay() {
  const url = `http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/partenze/${stationID}/${encodeURIComponent(nowAsViaggiaTrenoDate())}`
  try {
    const data = await fetchViaProxy(url)
    if (Array.isArray(data) && data.length > 0) {
      lastUpdateData = data
      setLiveStatus(true, new Date())
    }
    if (lastUpdateData) render(lastUpdateData)
    else renderMessage('bi-moon-stars', label('serviceOFF'))
  } catch (err) {
    console.error('Error fetching data:', err)
    setLiveStatus(false)
    if (!lastUpdateData) renderMessage('bi-wifi-off', label('loadError'), true)
  }
}

// =======================
// Controls
// =======================
function initGroupBySelect() {
  const select = $('groupBySelect')
  GROUP_MODES.forEach(mode => {
    const opt = el('option', [], label(GROUP_LABEL_KEYS[mode]))
    opt.value = mode
    opt.selected = mode === groupByMode
    select.append(opt)
  })
  select.addEventListener('change', () => {
    groupByMode = select.value
    groupFilterText = ''
    $('groupFilterInput').value = ''
    $('filterWrap').classList.remove('expanded')
    syncStateToURL()
    rerender()
  })
}

function initFilter() {
  const wrap = $('filterWrap')
  const input = $('groupFilterInput')
  const toggle = $('filterToggle')
  input.placeholder = label('filterPlaceholder')
  input.title = label('filterHint')
  toggle.setAttribute('aria-label', label('filter'))

  const initial = getParam('groupfilter')
  if (initial) {
    input.value = initial
    groupFilterText = initial.toLowerCase()
    wrap.classList.add('expanded')
  }

  toggle.addEventListener('click', () => {
    const expanding = !wrap.classList.contains('expanded')
    wrap.classList.toggle('expanded', expanding)
    if (expanding) input.focus()
  })
  input.addEventListener('blur', () => {
    if (!input.value) wrap.classList.remove('expanded')
  })
  input.addEventListener('input', () => {
    groupFilterText = input.value.trim().toLowerCase()
    syncStateToURL()
    rerender()
  })
}

function initViewToggle() {
  $('viewToggle').addEventListener('click', () => {
    viewMode = viewMode === 'nerd' ? 'board' : 'nerd'
    applyView()
    syncStateToURL()
    rerender()
  })
}

// =======================
// Init
// =======================
window.addEventListener('pageshow', e => { if (e.persisted) window.location.reload() })
window.addEventListener('resize', syncHeaderSpacerHeight)

document.addEventListener('DOMContentLoaded', () => {
  stationID = getParam('stationID') || stationID
  stationName = getParam('stationName') || stationName

  if ((getParam('hidebar') || '').toLowerCase() === 'true') {
    $('searchLegendContainer').style.display = 'none'
  }

  const paramGroupBy = (getParam('groupby') || '').toLowerCase()
  if (GROUP_MODES.includes(paramGroupBy)) groupByMode = paramGroupBy
  const paramView = (getParam('view') || '').toLowerCase()
  if (VIEWS.includes(paramView)) viewMode = paramView

  const searchLink = $('text-search')
  searchLink.title = label('search')
  searchLink.setAttribute('aria-label', label('search'))
  initGroupBySelect()
  initFilter()
  initViewToggle()
  applyView()
  syncStateToURL()

  $('versionNumber').textContent = APP_VERSION
  renderMessage('bi-hourglass-split', label('connecting'))
  updateHeader()
  fetchAndDisplay()

  setInterval(fetchAndDisplay, REFRESH_REQUEST_INTERVAL)
  setInterval(() => { updateHeader(); rerender() }, CLOCK_INTERVAL)
})
