// =======================
// Constants
// =======================
const APP_VERSION = '2.0.0'
const REFRESH_REQUEST_INTERVAL = 20 * 1000 // ms
const CLOCK_INTERVAL = 10 * 1000 // ms
const TRAIN_MODE_KEY = 'ALL'
const GROUP_MODES = ['platform', 'destination', 'category', 'train']
const GROUP_ITEM_LIMIT = { platform: 3, destination: 3, category: 3, train: 20 }
const VIEWS = ['board', 'nerd']
const LOCALE = 'en-GB'
const LATE_THRESHOLD = 5 // min: from this delay a train counts as late in the nerd stats
const TIMELINE_MINUTES = 60
const HORIZON_MINUTES = 180 // window of the density / scatter / busiest-platform panels
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
  cancelled: 'cancelled',
  trackedAgo: 'tracked',
  openTrain: 'Open train page',
  share: 'Share',
  linkCopied: 'Link copied',
  trainNotFound: 'Train not found',
  statusNotDeparted: 'Not departed yet',
  statusRunning: 'Running',
  statusArrived: 'Arrived',
  statusCancelled: 'Cancelled',
  statusDiverted: 'Diverted',
  routeLoading: 'Loading route…',
  routeError: 'Could not load the route',
  routeTitle: 'Route',
  estimateHint: 'Estimate: scheduled time + reported delay. Delays are rounded to the minute, so it can be off by about 1 min.',
  noDelayHint: 'No delay reported: same as the scheduled time',
  legend: '~ estimated real time (±1 min, delays are rounded) · dimmed time: no delay reported',
  connected: 'Connected',
  requestFailed: 'Request failed',
  filterHint: 'Separate several values with a comma, | or "or" (e.g. torino, milano)',
  nextDepartures: 'Next departures',
  destinationUnknown: 'Unknown destination',
  categoryUnknown: 'Other',
  groupByPlatform: 'By platform',
  groupByDestination: 'By destination',
  groupByCategory: 'By train type',
  groupByTrain: 'By next departures',
  viewNerd: 'nerdz',
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
let stationID = ''
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
// provvedimento 1 = "Treno cancellato" (checked against the andamentoTreno subTitle).
function isCancelled(train) {
  return train.provvedimento === 1
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
  if (isCancelled(train)) return ''
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
  // Only I, V and X: platform numbers are small, and letters like "C" or "D" are sector letters, not 100 or 500.
  const match = trimmed.match(/^([IVX]+)(\b.*)?$/i)
  const arabic = match && romanToArabic(match[1])
  const label = arabic && arabic <= 39 ? `${arabic}${match[2] || ''}`.trim() : trimmed
  // Some stations suffix a sector letter ("6 C" at Genova Sampierdarena): keep only the number.
  return label.replace(/^(\d+)\s*[A-Za-z]$/, '$1')
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
  if (isCancelled(train)) return null
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
// What the Retry button reloads: the departures board, or the train page.
let retryLoad = () => fetchAndDisplay()

function renderMessage(iconName, text, withRetry = false, detail = '') {
  const box = el('div', ['state-box'])
  box.append(icon(iconName), el('p', [], text))
  if (detail) box.append(el('p', ['state-detail'], detail))
  if (withRetry) {
    const btn = el('button', ['btn-retry'], 'Retry')
    btn.type = 'button'
    btn.addEventListener('click', () => {
      renderMessage('bi-hourglass-split', label('connecting'))
      retryLoad()
    })
    box.append(btn)
  }
  $('trainInfo').replaceChildren(box)
}

// =======================
// Tracking age + route (tap a train)
// =======================
const ROUTE_REFRESH_MS = 60 * 1000
const ROUTE_RETRY_MS = 30 * 1000
const routeCache = new Map() // key -> { status: 'ok' | 'error', at, stops | message, pending }
const expandedTrains = new Set()

function trainKey(train) {
  return `${train.numeroTreno}-${train.dataPartenzaTreno}`
}

// "12 s", "3 min", "1h05": how long ago the train was last seen by the tracking system.
function trackedAgeLabel(train, now = Date.now()) {
  if (!train.ultimoRilev || !train.circolante) return null
  const seconds = Math.max(0, Math.round((now - train.ultimoRilev) / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
}

// The route: the stops from the current station to the terminus (the origin is deliberately left out).
function routeStopsFrom(detail) {
  const all = detail.fermate || []
  const hereIdx = all.findIndex(f => f.id === stationID)
  const start = Math.max(0, hereIdx)
  const cancelledIds = new Set((detail.fermateSoppresse || []).map(s => s.id))

  const stopFrom = (f, { useDeparture, isHere = false, isEnd = false }) => {
    const schedMs = (useDeparture ? f.partenza_teorica : f.arrivo_teorico) || f.programmata
    const realMs = useDeparture ? f.partenzaReale : f.arrivoReale
    const platform = useDeparture
      ? f.binarioEffettivoPartenzaDescrizione || f.binarioProgrammatoPartenzaDescrizione
      : f.binarioEffettivoArrivoDescrizione || f.binarioProgrammatoArrivoDescrizione
    const diffMin = schedMs && realMs ? Math.round((realMs - schedMs) / 60000) : 0
    return {
      name: f.stazione,
      schedMs,
      sched: formatEpochHHMM(schedMs),
      real: realMs && diffMin !== 0 ? formatEpochHHMM(realMs) : null,
      diffMin,
      passed: f.actualFermataType === 1 && !isHere,
      platform: normalizePlatformLabel(platform),
      isHere,
      isEnd,
      cancelled: cancelledIds.has(f.id)
    }
  }

  const stops = []
  all.slice(start).forEach((f, i, list) => {
    const isHere = i === 0 && hereIdx >= 0
    stops.push(stopFrom(f, { useDeparture: isHere || (start === 0 && i === 0), isHere, isEnd: i === list.length - 1 }))
  })
  return stops
}

async function loadRoute(train) {
  const key = trainKey(train)
  const entry = routeCache.get(key) || {}
  if (entry.pending) return
  routeCache.set(key, { ...entry, pending: true })
  try {
    const url = `http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/andamentoTreno/${train.codOrigine}/${train.numeroTreno}/${train.dataPartenzaTreno}`
    const detail = await fetchViaProxy(url)
    routeCache.set(key, { status: 'ok', at: Date.now(), stops: routeStopsFrom(detail) })
  } catch (err) {
    routeCache.set(key, { ...entry, status: 'error', at: Date.now(), message: err.message, pending: false })
  }
  rerender()
}

function routeStopEl(stop, delay) {
  const kinds = [stop.isHere ? 'is-here' : '', stop.isEnd ? 'is-end' : '', stop.passed ? 'is-passed' : '', stop.cancelled ? 'is-cancelled' : '']
  const node = el('div', ['route-stop', ...kinds])

  // The delay at the current station carries over to the next stops: scheduled time + delay, marked "~".
  let real = stop.real
  let tone = stop.diffMin > 0 ? 'is-late' : 'is-early'
  if (!real && delay > 0 && stop.schedMs && !stop.passed) {
    real = `~${formatEpochHHMM(stop.schedMs + delay * 60000)}`
    tone = 'is-late'
  }
  const times = el('span', ['route-time'])
  times.append(el('span', [], stop.sched || '--'))
  if (real) times.append(el('span', [tone], real))
  node.append(
    times,
    el('span', ['route-dot']),
    el('span', ['route-name'], stop.name),
    el('span', ['route-plt'], stop.platform ? `${label('platform').toLowerCase()} ${stop.platform}` : '')
  )
  return node
}

// A metro-line diagram: horizontal on wide screens, vertical on phones (pure CSS).
function trainPageUrl(train) {
  const params = new URLSearchParams({ view: 'train', train: train.numeroTreno, from: train.codOrigine, date: train.dataPartenzaTreno })
  if (stationID) params.set('stationID', stationID)
  if (stationName) params.set('stationName', stationName)
  return `${window.location.pathname}?${params}`
}

function routePanel(train) {
  const panel = el('div', ['route-panel'])
  const open = el('a', ['route-open'])
  open.href = trainPageUrl(train)
  open.append(icon('bi-box-arrow-up-right'), label('openTrain'))
  open.addEventListener('click', e => e.stopPropagation())
  panel.append(open)
  const entry = routeCache.get(trainKey(train))
  const age = entry && entry.at ? Date.now() - entry.at : Infinity
  const stale = !entry || (entry.status === 'ok' && age > ROUTE_REFRESH_MS) || (entry.status === 'error' && age > ROUTE_RETRY_MS)
  if (stale) loadRoute(train)

  if (entry && entry.status === 'ok') {
    const line = el('div', ['route-line'])
    entry.stops.forEach(stop => line.append(routeStopEl(stop, delayOf(train))))
    panel.append(line)
  } else if (entry && entry.status === 'error') {
    panel.append(el('p', ['route-note', 'is-late'], `${label('routeError')}: ${entry.message}`))
  } else {
    panel.append(el('p', ['route-note'], label('routeLoading')))
  }
  return panel
}

function toggleRoute(train) {
  const key = trainKey(train)
  if (expandedTrains.has(key)) expandedTrains.delete(key)
  else expandedTrains.add(key)
  rerender()
}

function boardRow(train, now) {
  const delay = delayOf(train)
  const presence = trainPresence(train, now) || 'not-here'
  const platform = platformOf(train)
  const cancelled = isCancelled(train)
  const real = cancelled ? null : realLabel(train)

  const expanded = expandedTrains.has(trainKey(train))
  const row = el('div', ['flap-row', `is-${presence}`, cancelled ? 'is-cancelled' : '', 'is-clickable', expanded ? 'is-expanded' : ''])
  row.setAttribute('role', 'button')
  row.setAttribute('tabindex', '0')
  row.setAttribute('aria-expanded', String(expanded))
  row.addEventListener('click', () => toggleRoute(train))
  row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRoute(train) } })

  const tile = el('span', ['platform-tile', `is-${presence}`], platform || '–')
  tile.title = platform ? `${label('platform')} ${platform}` : label('platformUnknown')
  if (platform && platform.length > 2) tile.classList.add('is-long')
  if (cancelled) {
    // A red cross replaces the platform number so a cancelled train stands out at a glance.
    tile.classList.remove('is-long')
    tile.classList.add('is-cancelled')
    tile.replaceChildren(icon('bi-x-lg'))
    tile.title = label('cancelled')
  }

  const sched = el('span', ['flap-time'], scheduledLabel(train))
  const realEl = el('span', ['flap-realcell'])
  if (real) {
    const tone = delay > 0 ? 'is-late' : 'is-early'
    const estimate = el('span', ['flap-time', tone], `~${real}`)
    estimate.title = label('estimateHint')
    realEl.append(estimate, el('span', ['delay-chip', tone], delay > 0 ? `+${delay} min` : `${delay} min`))
  } else if (cancelled) {
    realEl.append(el('span', ['flap-time', 'flap-none'], '--'))
  } else {
    // No delay reported: the real time is the scheduled one, shown dimmed.
    const same = el('span', ['flap-time', 'flap-none'], scheduledLabel(train))
    same.title = label('noDelayHint')
    realEl.append(same)
  }

  const dest = el('span', ['flap-dest'])
  dest.append(el('span', ['flap-dest-name'], train.destinazione || '—'))
  const meta = el('span', ['flap-meta'], trainLabel(train))
  if (cancelled) {
    meta.append(' · ', el('span', ['is-late', 'cancel-flag'], label('cancelled')))
  } else if (presence === 'at-platform') {
    meta.append(' · ', el('span', ['is-at-platform'], label('atPlatform')))
  }
  const tracked = cancelled ? null : trackedAgeLabel(train, now)
  if (tracked) {
    const stale = (now - train.ultimoRilev) > 10 * 60000
    meta.append(' · ', el('span', [stale ? 'is-slight' : ''], `${label('trackedAgo')} ${tracked} ago`))
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
  group.trains.forEach(train => {
    section.append(boardRow(train, now))
    if (expandedTrains.has(trainKey(train))) section.append(routePanel(train))
  })
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
  const legend = el('p', ['board-legend'], label('legend'))
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
    platformsAnnounced: platforms.size
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
    statTile('platforms', String(stats.platformsAnnounced), 'announced')
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
  const WIDTH = chartWidth()
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

// SVG text scales with the viewBox: use the real width so labels stay readable on phones.
function chartWidth() {
  return Math.min(640, Math.max(300, $('trainInfo').clientWidth - 56))
}
function svgChart(height, titleText, width = chartWidth()) {
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', class: 'timeline-svg' })
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
  const W = chartWidth()
  const plotW = W - LEFT - RIGHT
  const span = HORIZON_MINUTES * 60000
  const maxDelay = Math.max(20, ...points.map(p => p.delay))
  const yMax = Math.ceil(maxDelay / 20) * 20 // multiple of 20 so the middle tick is a round number
  const xOf = ms => LEFT + (Math.min(Math.max(ms - now, 0), span) / span) * plotW
  const yOf = d => TOP + plotH - (Math.min(d, yMax) / yMax) * plotH

  const svg = svgChart(H, 'Delay versus scheduled time', W)
  for (let v = 0; v <= yMax; v += yMax / 2) {
    svg.append(svgEl('line', { x1: LEFT, y1: yOf(v), x2: W - RIGHT, y2: yOf(v), class: 'tl-grid' }))
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

// "next 1h35" / "next 40 min": the real span of the data, i.e. up to the furthest announced train.
function spanLabel(trains, now) {
  const last = Math.max(...trains.map(t => realDepartureMs(t) || 0))
  const minutes = Math.max(1, Math.ceil((last - now) / 60000))
  return minutes < 60 ? `next ${minutes} min` : `next ${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
}

// Trains announced per platform: how the upcoming departures are spread over the tracks.
function nerdPlatformDistribution(trains, now) {
  const counts = new Map()
  let withoutPlatform = 0
  trains.forEach(t => {
    const platform = platformOf(t)
    if (!platform) withoutPlatform += 1
    else counts.set(platform, (counts.get(platform) || 0) + 1)
  })
  const platforms = Array.from(counts.keys()).sort(comparePlatforms)

  const panel = el('div', ['nerd-panel'])
  const head = el('div', ['nerd-panel-head'])
  head.append(el('span', [], `trains announced per platform, ${spanLabel(trains, now)}`))
  panel.append(head)
  if (!platforms.length) {
    panel.append(el('p', ['nerd-dim'], 'no platform announced yet'))
    return panel
  }

  const max = Math.max(...counts.values())
  const peak = platforms.find(p => counts.get(p) === max)
  head.append(el('span', ['nerd-dim'], `busiest: plt ${peak} (${max})`))

  // "20 BIS" -> "20b", "2 EST" -> "2E": long labels would overlap on a phone.
  const shortLabel = p => p.replace(/\s*BIS/i, 'b').replace(/\s*EST/i, 'E')
  const W = chartWidth()
  const H = 118
  const barArea = 64
  const slotW = W / platforms.length
  const showEvery = slotW >= 20 ? 1 : 2 // platform labels only; every bar keeps its count
  const svg = svgChart(H, 'Trains announced per platform', W)
  platforms.forEach((platform, i) => {
    const count = counts.get(platform)
    const h = (count / max) * barArea
    const bar = svgEl('rect', {
      x: i * slotW + 2,
      y: 22 + barArea - h,
      width: Math.max(slotW - 4, 2),
      height: h,
      class: `slot-bar${platform === peak ? ' is-peak' : ''}`
    })
    bar.append(svgEl('title', {}, `plt ${platform}: ${count} train${count > 1 ? 's' : ''}`))
    svg.append(bar)
    svg.append(svgEl('text', { x: i * slotW + slotW / 2, y: 18 + barArea - h, class: 'tl-label', 'text-anchor': 'middle' }, String(count)))
    if (i % showEvery === 0) {
      svg.append(svgEl('text', { x: i * slotW + slotW / 2, y: H - 6, class: 'tl-label', 'text-anchor': 'middle' }, shortLabel(platform)))
    }
  })
  panel.append(svg)
  if (withoutPlatform) {
    panel.append(el('p', ['nerd-dim', 'nerd-note'], `${withoutPlatform} more train${withoutPlatform > 1 ? 's have' : ' has'} no platform yet`))
  }
  return panel
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

function nerdDelayDistribution(trains) {
  const buckets = [
    { name: '0', test: d => d <= 0, color: 'var(--ok)' },
    { name: '1-2', test: d => d >= 1 && d <= 2, color: 'var(--slight)' },
    { name: '3-5', test: d => d >= 3 && d <= 5, color: 'var(--slight)' },
    { name: '6-15', test: d => d >= 6 && d <= 15, color: 'var(--late)' },
    { name: '15+', test: d => d > 15, color: 'var(--late)' }
  ].map(b => ({ ...b, count: trains.filter(t => b.test(delayOf(t))).length }))
  return nerdPanel('delay distribution (min)', barRows(buckets))
}

function nerdBreakdowns(trains) {
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
    nerdPanel('top destinations', barRows(topDest)),
    nerdPanel('by train type', barRows(families))
  )
  return grid
}

// Histogram of the current delays (1-minute bins) with the normal curve fitted to them.
function nerdDelayGaussian(trains) {
  const delays = trains.map(delayOf)
  const n = delays.length
  const mean = delays.reduce((a, b) => a + b, 0) / n
  const sd = Math.sqrt(delays.reduce((a, d) => a + (d - mean) ** 2, 0) / n)
  const sigma = Math.max(sd, 0.5) // a perfectly punctual station would otherwise give an infinite spike

  const lo = Math.min(-3, Math.floor(mean - 3 * sigma))
  const hi = Math.max(8, Math.ceil(mean + 3 * sigma))
  const bins = Array.from({ length: hi - lo + 1 }, () => 0)
  delays.forEach(d => { bins[Math.min(Math.max(Math.round(d), lo), hi) - lo] += 1 }) // outliers pile up in the end bins
  const density = bins.map(c => c / n)
  const pdf = x => Math.exp(-((x - mean) ** 2) / (2 * sigma * sigma)) / (sigma * Math.sqrt(2 * Math.PI))
  const yMax = Math.max(...density, pdf(mean))

  const panel = el('div', ['nerd-panel'])
  const head = el('div', ['nerd-panel-head'])
  head.append(
    el('span', [], 'delay bell curve (normal fit)'),
    el('span', ['nerd-dim'], `mean ${mean >= 0 ? '+' : ''}${mean.toFixed(1)} min · σ ${sd.toFixed(1)}`)
  )
  panel.append(head)

  const LEFT = 8
  const RIGHT = 8
  const TOP = 10
  const H = 150
  const W = chartWidth()
  const plotW = W - LEFT - RIGHT
  const plotH = H - TOP - 26
  const xOf = v => LEFT + ((v - lo + 0.5) / (hi - lo + 1)) * plotW
  const yOf = d => TOP + plotH - (d / yMax) * plotH
  const svg = svgChart(H, 'Delay distribution with fitted normal curve', W)

  const binW = plotW / (hi - lo + 1)
  bins.forEach((count, i) => {
    if (!count) return
    const bar = svgEl('rect', { x: LEFT + i * binW + 1, y: yOf(density[i]), width: Math.max(binW - 2, 1), height: TOP + plotH - yOf(density[i]), class: 'slot-bar' })
    bar.append(svgEl('title', {}, `${lo + i} min: ${count} train${count > 1 ? 's' : ''}`))
    svg.append(bar)
  })

  const steps = 80
  const curve = Array.from({ length: steps + 1 }, (_, i) => {
    const v = lo - 0.5 + (i / steps) * (hi - lo + 1)
    return `${i === 0 ? 'M' : 'L'}${(LEFT + ((v - lo + 0.5) / (hi - lo + 1)) * plotW).toFixed(1)} ${yOf(pdf(v)).toFixed(1)}`
  }).join(' ')
  svg.append(svgEl('path', { d: curve, class: 'tl-avg' }))
  svg.append(svgEl('line', { x1: xOf(mean), y1: TOP, x2: xOf(mean), y2: TOP + plotH, class: 'tl-now' }))

  const tickStep = Math.max(1, Math.ceil((hi - lo) / 6 / 5) * 5)
  for (let v = Math.ceil(lo / tickStep) * tickStep; v <= hi; v += tickStep) {
    svg.append(svgEl('text', { x: xOf(v), y: H - 6, class: 'tl-label', 'text-anchor': 'middle' }, v > 0 ? `+${v}` : String(v)))
  }
  panel.append(svg)
  return panel
}

function nerdTable(trains, now) {
  const table = el('div', ['nerd-table'])
  const head = el('div', ['nerd-trow', 'nerd-thead'])
  ;['plt', 'train', 'dest', 'sched', 'real', 'delta'].forEach(name => head.append(el('span', [], name)))
  table.append(head)
  trains.slice(0, NERD_TABLE_LIMIT).forEach(t => {
    const delay = delayOf(t)
    const presence = trainPresence(t, now)
    const cancelled = isCancelled(t)
    const real = cancelled ? null : realLabel(t)
    const row = el('div', ['nerd-trow', cancelled ? 'is-cancelled' : ''])
    row.append(
      cancelled ? el('span', ['is-late'], '✕') : el('span', [presence ? `is-${presence}` : 'nerd-dim'], platformOf(t) || '–'),
      el('span', [], trainLabel(t)),
      el('span', ['nerd-dest'], (t.destinazione || '—').toLowerCase()),
      el('span', [], scheduledLabel(t)),
      el('span', [real ? delayClass(delay) : 'nerd-dim'], real ? `~${real}` : cancelled ? '--' : scheduledLabel(t)),
      cancelled ? el('span', ['is-late'], 'canc.') : el('span', [delayClass(delay)], delay > 0 ? `+${delay}` : String(delay))
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
  const running = trains.filter(t => !isCancelled(t)) // cancelled trains must not skew the stats
  wrap.append(
    prompt,
    nerdStatTiles(nerdStats(running, now)),
    nerdTimeline(running, now),
    nerdScatter(running, now),
    nerdDelayDistribution(running),
    nerdDelayGaussian(running),
    nerdPlatformDistribution(running, now),
    nerdBreakdowns(running),
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

// Footer status: "Connected" when the last request worked, "Request failed" with the reason otherwise.
let lastSuccessTime = null
function setRequestStatus(ok) {
  const report = lastProxyReport
  const failedRelays = report ? report.attempts.filter(a => !a.ok) : []
  const dot = $('liveDot')
  dot.classList.remove('is-pending')
  dot.classList.toggle('is-offline', !ok)

  const statusLabel = $('statusLabel')
  statusLabel.textContent = label(ok ? 'connected' : 'requestFailed')
  statusLabel.className = ok ? 'is-ok' : 'is-late'

  let when = ''
  let detail = ''
  if (ok) {
    when = ` · ${label('update')} ${formatTime(lastSuccessTime, true)}`
    detail = `via ${report.via}`
    if (failedRelays.length) detail += ` · ${failedRelays.length} relay${failedRelays.length > 1 ? 's' : ''} failed first`
  } else {
    when = lastSuccessTime ? ` · last data ${formatTime(lastSuccessTime, true)}` : ''
    detail = describeProxyReport(report) || 'unknown error'
  }
  $('updateDate').textContent = when
  $('statusDetail').textContent = detail
  $('footerStatus').title = report ? report.attempts.map(a => `${a.name}: ${a.detail}`).join('\n') : ''
}

function applyView() {
  const nerd = viewMode === 'nerd'
  document.body.classList.toggle('view-nerd', nerd)
  $('viewToggleLabel').textContent = label(nerd ? 'viewBoard' : 'viewNerd')
  $('viewToggle').setAttribute('aria-label', label(nerd ? 'viewBoard' : 'viewNerd'))
  $('viewToggle').querySelector('i').className = `bi ${nerd ? 'bi-grid-3x2-gap' : 'bi-terminal'}`
  syncHeaderSpacerHeight()
}

// =======================
// Data
// =======================
async function fetchAndDisplay() {
  const url = `http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/partenze/${stationID}/${encodeURIComponent(nowAsViaggiaTrenoDate())}`
  let data
  try {
    data = await fetchViaProxy(url)
  } catch (err) {
    console.error('Error fetching data:', err)
    setRequestStatus(false)
    if (!lastUpdateData) renderMessage('bi-wifi-off', label('loadError'), true, describeProxyReport(lastProxyReport))
    return
  }
  lastSuccessTime = new Date()
  setRequestStatus(true)
  if (Array.isArray(data) && data.length > 0) lastUpdateData = data
  if (lastUpdateData) render(lastUpdateData)
  else renderMessage('bi-moon-stars', label('serviceOFF'))
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
    $('filterClear').hidden = true
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

  const clear = $('filterClear')
  const refreshClear = () => { clear.hidden = !input.value }

  const initial = getParam('groupfilter')
  if (initial) {
    input.value = initial
    groupFilterText = initial.toLowerCase()
    wrap.classList.add('expanded')
  }
  refreshClear()

  // One tap wipes the filter and brings every train back.
  clear.addEventListener('click', () => {
    input.value = ''
    groupFilterText = ''
    refreshClear()
    wrap.classList.remove('expanded')
    input.blur()
    syncStateToURL()
    rerender()
  })

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
    refreshClear()
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
// Train page (view=train): everything about one train, shareable by link
// =======================
let trainRef = null // { number, from, date }
let trainDetail = null

function canonicalTrainUrl() {
  const params = new URLSearchParams({ view: 'train', train: trainRef.number, from: trainRef.from, date: trainRef.date })
  return `${window.location.origin}${window.location.pathname}?${params}`
}

function trainStatus(d) {
  if (d.provvedimento === 1) return { key: 'statusCancelled', tone: 'is-late' }
  if (d.arrivato) return { key: 'statusArrived', tone: 'is-ok' }
  if (d.nonPartito) return { key: 'statusNotDeparted', tone: 'is-muted' }
  if (d.provvedimento === 3) return { key: 'statusDiverted', tone: 'is-slight' }
  return { key: 'statusRunning', tone: 'is-here' }
}

function durationLabel(fromMs, toMs) {
  if (!fromMs || !toMs || toMs <= fromMs) return null
  const minutes = Math.round((toMs - fromMs) / 60000)
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
}

function chip(text, tone = '') {
  return el('span', ['tv-chip', tone], text)
}

// One time cell: the scheduled time, with the real (or estimated "~") time under it when it differs.
function tvTimeCell(schedMs, realMs, delayNow, passed) {
  const cell = el('span', ['tv-cell'])
  if (!schedMs) return cell
  cell.append(el('strong', [], formatEpochHHMM(schedMs)))
  const diff = realMs ? Math.round((realMs - schedMs) / 60000) : 0
  if (realMs && diff !== 0) {
    cell.append(el('span', [diff > 0 ? 'is-late' : 'is-early'], formatEpochHHMM(realMs)))
  } else if (!realMs && !passed && delayNow > 0) {
    cell.append(el('span', ['is-late'], `~${formatEpochHHMM(schedMs + delayNow * 60000)}`))
  }
  return cell
}

// "in 2h07", "in 12 min" until a moment in the future.
function untilLabel(ms, now = Date.now()) {
  const minutes = Math.round((ms - now) / 60000)
  if (minutes <= 0) return 'now'
  if (minutes < 60) return `in ${minutes} min`
  return `in ${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}`
}

function trainStopEl(f, index, stops, detail, lastPassedIndex) {
  const passed = f.actualFermataType === 1
  const delayNow = detail.ritardo || 0
  const cancelledIds = new Set((detail.fermateSoppresse || []).map(s => s.id))
  const isFirst = index === 0
  const isLast = index === stops.length - 1
  const kinds = [passed ? 'is-passed' : '', index === lastPassedIndex ? 'is-last-seen' : '', index === lastPassedIndex + 1 ? 'is-next' : '', isFirst ? 'is-start' : '', isLast ? 'is-end' : '', cancelledIds.has(f.id) ? 'is-cancelled' : '']
  const node = el('div', ['tv-stop', ...kinds])

  const arrSched = f.arrivo_teorico || f.programmata
  const depSched = f.partenza_teorica || f.programmata
  const arrCell = isFirst ? el('span', ['tv-cell']) : tvTimeCell(arrSched, f.arrivoReale, delayNow, passed)
  const depCell = isLast ? el('span', ['tv-cell']) : tvTimeCell(depSched, f.partenzaReale, delayNow, passed)

  const info = el('div', ['tv-info'])
  info.append(el('span', ['tv-name'], f.stazione))
  const meta = el('span', ['tv-meta'])
  const actualPlatform = normalizePlatformLabel(f.binarioEffettivoArrivoDescrizione || f.binarioEffettivoPartenzaDescrizione)
  const plannedPlatform = normalizePlatformLabel(f.binarioProgrammatoArrivoDescrizione || f.binarioProgrammatoPartenzaDescrizione)
  const platform = actualPlatform || plannedPlatform
  if (platform) meta.append(`${label('platform').toLowerCase()} ${platform}`)
  if (actualPlatform && plannedPlatform && actualPlatform !== plannedPlatform) {
    meta.append(el('span', ['is-slight'], ` (was ${plannedPlatform})`))
  }
  const dwell = arrSched && depSched && !isFirst && !isLast ? Math.round((depSched - arrSched) / 60000) : 0
  if (dwell > 0) meta.append(` · stops ${dwell} min`)
  const stopDelay = Math.max(f.ritardoArrivo || 0, f.ritardoPartenza || 0)
  if (passed && stopDelay > 0) meta.append(el('span', ['is-late'], ` · +${stopDelay} min`))
  if (index === lastPassedIndex) meta.append(el('span', ['is-here'], ' · last stop reached'))
  if (index === lastPassedIndex + 1 && !passed && !detail.arrivato) {
    const eta = (arrSched || 0) + delayNow * 60000
    if (eta) meta.append(el('span', ['is-here'], ` · next, ${untilLabel(eta)}`))
  }
  info.append(meta)

  node.append(el('span', ['tv-dot']), info, arrCell, depCell)
  return node
}

// Delay at each stop already reached: is the train gaining or recovering time?
// Many stops: one line instead of one bar each, with the peak and both ends labelled.
function delayLine(points, max) {
  const w = chartWidth()
  const h = 150
  const pad = { l: 8, r: 8, t: 22, b: 24 }
  const x = i => pad.l + (i / (points.length - 1)) * (w - pad.l - pad.r)
  const y = d => pad.t + (1 - Math.max(0, d) / max) * (h - pad.t - pad.b)
  const svg = svgChart(h, 'Delay at each stop reached', w)
  const base = y(0)
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.delay).toFixed(1)}`).join(' ')
  svg.append(svgEl('line', { x1: pad.l, x2: w - pad.r, y1: base, y2: base, class: 'tv-line-axis' }))
  svg.append(svgEl('path', { d: `${line} L${x(points.length - 1).toFixed(1)},${base} L${x(0).toFixed(1)},${base} Z`, class: 'tv-line-area' }))
  svg.append(svgEl('path', { d: line, class: 'tv-line-path' }))
  points.forEach((p, i) => {
    const dot = svgEl('circle', { cx: x(i), cy: y(p.delay), r: 3, class: `tv-line-dot ${delayClass(p.delay)}` })
    dot.append(svgEl('title', {}, `${p.name}: ${p.delay > 0 ? '+' : ''}${p.delay} min`))
    svg.append(dot)
  })
  const peak = points.reduce((best, p, i) => (p.delay > points[best].delay ? i : best), 0)
  const peakAnchor = x(peak) < 30 ? 'start' : x(peak) > w - 30 ? 'end' : 'middle'
  svg.append(svgEl('text', { x: x(peak), y: y(points[peak].delay) - 8, 'text-anchor': peakAnchor, class: 'tv-line-label' }, `+${points[peak].delay} min`))
  const last = points.length - 1
  if (last !== peak) svg.append(svgEl('text', { x: x(last), y: y(points[last].delay) - 8, 'text-anchor': 'end', class: 'tv-line-label' }, `${points[last].delay > 0 ? '+' : ''}${points[last].delay} min`))
  svg.append(svgEl('text', { x: pad.l, y: h - 6, 'text-anchor': 'start', class: 'tv-line-name' }, points[0].name.toLowerCase()))
  svg.append(svgEl('text', { x: w - pad.r, y: h - 6, 'text-anchor': 'end', class: 'tv-line-name' }, points[last].name.toLowerCase()))
  return svg
}

function delayEvolution(stops) {
  const points = stops
    .filter(f => f.actualFermataType === 1)
    .map(f => ({ name: f.stazione, delay: Math.max(f.ritardoArrivo || 0, f.ritardoPartenza || 0) }))
  if (points.length < 2) return null
  const max = Math.max(1, ...points.map(p => p.delay))
  const card = el('section', ['tv-card'])
  card.append(el('h3', ['tv-section'], 'Delay along the route'))
  const chart = delayLine(points, max)
  card.append(chart)
  const first = points[0].delay
  const last = points[points.length - 1].delay
  const change = last - first
  const trend = change >= 2 ? `Lost ${change} min since ${points[0].name.toLowerCase()}`
    : change <= -2 ? `Recovered ${-change} min since ${points[0].name.toLowerCase()}`
    : 'Delay is steady'
  card.append(el('p', ['tv-trend', change >= 2 ? 'is-late' : change <= -2 ? 'is-early' : ''], trend))
  return card
}

function renderTrainPage(d) {
  const root = el('div', ['tv-wrap'])
  const category = (d.categoria || d.categoriaDescrizione || '').trim()
  const status = trainStatus(d)
  const delay = d.ritardo || 0
  const now = Date.now()
  const stops = d.fermate || []
  const lastPassed = stops.reduce((last, f, i) => (f.actualFermataType === 1 ? i : last), -1)
  const arrivalSched = d.orarioArrivoZero || d.orarioArrivo
  const departSched = d.orarioPartenzaZero || d.orarioPartenza

  const summary = el('section', ['tv-card'])
  const head = el('div', ['tv-head'])
  head.append(el('span', ['train-badge'], `${category} ${d.numeroTreno}`.trim()))
  head.append(chip(label(status.key), status.tone))
  if (d.provvedimento !== 1 && delay !== 0) head.append(chip(delay > 0 ? `+${delay} min` : `${delay} min`, delay > 0 ? 'is-late' : 'is-early'))
  summary.append(head)

  const route = el('h2', ['tv-route'])
  route.append(el('span', [], d.origine || '—'), icon('bi-arrow-right'), el('span', [], d.destinazione || '—'))
  summary.append(route)

  // How far along the journey the train is (by stops reached).
  if (stops.length > 1 && d.provvedimento !== 1) {
    const reached = stops.filter(f => f.actualFermataType === 1).length
    const pct = d.arrivato ? 100 : Math.round((reached / stops.length) * 100)
    const progress = el('div', ['tv-progress'])
    const track = el('div', ['tv-progress-track'])
    const fill = el('div', ['tv-progress-fill'])
    fill.style.width = `${pct}%`
    track.append(fill)
    progress.append(track, el('span', ['tv-progress-label'], `${d.arrivato ? stops.length : reached} of ${stops.length} stops reached`))
    summary.append(progress)
  }

  const facts = el('dl', ['tv-facts'])
  const addFact = (name, value, tone = '') => {
    if (!value) return
    const wrap = el('div', ['tv-fact'])
    wrap.append(el('dt', [], name), el('dd', [tone], value))
    facts.append(wrap)
  }
  const eta = arrivalSched && delay > 0 && !d.arrivato ? ` → ~${formatEpochHHMM(arrivalSched + delay * 60000)}` : ''
  addFact('date', d.dataPartenzaTrenoAsDate)
  addFact('departs', formatEpochHHMM(departSched))
  addFact('arrives', arrivalSched ? `${formatEpochHHMM(arrivalSched)}${eta}` : null, eta ? 'is-late' : '')
  addFact('duration', durationLabel(departSched, arrivalSched))
  if (arrivalSched && !d.arrivato && d.provvedimento !== 1 && !d.nonPartito) addFact('arrival', untilLabel(arrivalSched + Math.max(delay, 0) * 60000, now))
  const next = stops[lastPassed + 1]
  if (next && !d.arrivato && !d.nonPartito && d.provvedimento !== 1) {
    const nextEta = (next.arrivo_teorico || next.programmata) + Math.max(delay, 0) * 60000
    addFact('next stop', `${next.stazione} · ${formatEpochHHMM(nextEta)} (${untilLabel(nextEta, now)})`)
  }
  if (d.oraUltimoRilevamento) {
    const age = trackedAgeLabel({ ultimoRilev: d.oraUltimoRilevamento, circolante: true })
    addFact('last seen', `${d.stazioneUltimoRilevamento || '—'} · ${formatEpochHHMM(d.oraUltimoRilevamento)}${age ? ` (${age} ago)` : ''}`)
  }
  addFact('data updated', lastSuccessTime ? formatTime(lastSuccessTime, true) : null)
  const coaches = Array.isArray(d.descOrientamento) ? d.descOrientamento[1] : null
  addFact('coaches', coaches)
  addFact('delay reason', d.motivoRitardoPrevalente)
  addFact('rolling stock', d.materiale_label)
  addFact('type', d.compTipologiaTreno)
  summary.append(facts)
  if (d.subTitle) summary.append(el('p', ['tv-banner', status.tone], d.subTitle))
  root.append(summary)

  const evolution = delayEvolution(stops)
  if (evolution) root.append(evolution)

  const routeCard = el('section', ['tv-card'])
  routeCard.append(el('h3', ['tv-section'], `Route · ${stops.length} stops`))
  const columns = el('div', ['tv-columns'])
  columns.append(el('span'), el('span', [], 'station'), el('span', ['tv-cell-head'], 'arr'), el('span', ['tv-cell-head'], 'dep'))
  routeCard.append(columns)
  const line = el('div', ['tv-line'])
  stops.forEach((f, i) => line.append(trainStopEl(f, i, stops, d, lastPassed)))
  routeCard.append(line)
  root.append(routeCard)

  $('trainInfo').replaceChildren(root)
  document.title = `Train: ${category} ${d.numeroTreno}`.trim()
  $('stationTitle').textContent = `${category} ${d.numeroTreno}`.trim()
}

async function loadTrainPage() {
  const url = `http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/andamentoTreno/${trainRef.from}/${trainRef.number}/${trainRef.date}`
  let data
  try {
    data = await fetchViaProxy(url)
  } catch (err) {
    console.error('Error fetching train:', err)
    setRequestStatus(false)
    if (!trainDetail) renderMessage('bi-wifi-off', label('loadError'), true, describeProxyReport(lastProxyReport))
    return
  }
  lastSuccessTime = new Date()
  setRequestStatus(true)
  if (!data || !Array.isArray(data.fermate) || !data.fermate.length) {
    if (!trainDetail) renderMessage('bi-question-circle', label('trainNotFound'), false, 'This train has no data (it may be too old or the link is wrong).')
    return
  }
  trainDetail = data
  renderTrainPage(data)
  const category = (data.categoria || data.categoriaDescrizione || '').trim()
  rememberRecent(trainRecent(trainRef.number, trainRef.from, trainRef.date, `${`${category} ${data.numeroTreno}`.trim()} · ${data.destinazione || ''}`))
}

async function shareTrain() {
  const url = canonicalTrainUrl()
  const title = document.title
  const button = $('trainShare')
  const labelEl = $('trainShareLabel')
  if (navigator.share) {
    try { await navigator.share({ title, text: title, url }) } catch { /* the user closed the share sheet */ }
    return
  }
  try {
    await navigator.clipboard.writeText(url)
    labelEl.textContent = label('linkCopied')
    button.classList.add('is-done')
    setTimeout(() => { labelEl.textContent = label('share'); button.classList.remove('is-done') }, 2000)
  } catch {
    window.prompt('Copy this link', url)
  }
}

function initTrainPage() {
  document.body.classList.add('view-train')
  const params = new URLSearchParams(window.location.search)
  trainRef = { number: params.get('train'), from: params.get('from'), date: params.get('date') }

  const back = $('trainBack')
  back.hidden = false
  const boardId = params.get('stationID')
  if (boardId) {
    const stationParams = new URLSearchParams({ stationID: boardId })
    if (params.get('stationName')) stationParams.set('stationName', params.get('stationName'))
    back.href = `index.html?${stationParams}`
    $('trainBackLabel').textContent = params.get('stationName') || 'Board'
  } else {
    // no station to go back to: the Home icon is enough
    back.hidden = true
  }
  $('text-search').title = label('search')
  $('text-search').setAttribute('aria-label', label('search'))
  $('trainShare').hidden = false
  $('trainShare').addEventListener('click', shareTrain)
  $('trainShareLabel').textContent = label('share')
  retryLoad = loadTrainPage

  $('stationTitle').textContent = trainRef.number ? `Train ${trainRef.number}` : label('trainNotFound')
  $('versionNumber').textContent = APP_VERSION
  syncHeaderSpacerHeight()
  if (!trainRef.number || !trainRef.from || !trainRef.date) {
    renderMessage('bi-question-circle', label('trainNotFound'), false, 'The link is incomplete.')
    return
  }
  $('statusLabel').textContent = label('connecting')
  renderMessage('bi-hourglass-split', label('connecting'))
  loadTrainPage()
  setInterval(loadTrainPage, REFRESH_REQUEST_INTERVAL)
  setInterval(updateClock, CLOCK_INTERVAL)
  updateClock()
}

// =======================
// Init
// =======================
window.addEventListener('pageshow', e => { if (e.persisted) window.location.reload() })
window.addEventListener('resize', syncHeaderSpacerHeight)

document.addEventListener('DOMContentLoaded', () => {
  if ((getParam('view') || '').toLowerCase() === 'train') {
    initTrainPage()
    return
  }
  // The search page is the home of the site: without a station there is nothing to show here.
  if (!getParam('stationID')) {
    window.location.replace('search.html')
    return
  }
  stationID = getParam('stationID')
  stationName = getParam('stationName') || stationName
  if (stationName) rememberRecent(stationRecent(stationID, stationName)) // a bare id has no readable label

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
  $('statusLabel').textContent = label('connecting')
  renderMessage('bi-hourglass-split', label('connecting'))
  updateHeader()
  fetchAndDisplay()

  setInterval(fetchAndDisplay, REFRESH_REQUEST_INTERVAL)
  setInterval(() => { updateHeader(); rerender() }, CLOCK_INTERVAL)
})
