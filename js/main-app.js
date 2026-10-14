// =======================
// Constants
// =======================
const APP_VERSION = '2.0.0'
const REFRESH_REQUEST_INTERVAL = 20 * 1000 // ms
const TRACKING_REFRESH_INTERVAL = 8 * 1000 // ms: the Tracking views refresh faster, for one train only
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
  openTrain: 'Details',
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
let sourceMode = 'vt' // 'vt' = ViaggiaTreno alone, 'global' = merged with the RFI board, delays shown as an interval

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

// How far to trust a position: the older the last detection, the less the delay and "in station" can be believed.
const TRACK_TIERS = [
  { maxMin: 2, tier: 'good', text: 'reliable' },
  { maxMin: 10, tier: 'ok', text: 'less reliable' },
  { maxMin: 30, tier: 'poor', text: 'not great' },
  { maxMin: Infinity, tier: 'bad', text: 'unreliable' }
]
function trackReliability(lastSeenMs, now = Date.now()) {
  const minutes = (now - lastSeenMs) / 60000
  return TRACK_TIERS.find(t => minutes < t.maxMin)
}

// Predicted times (see js/modules/model.js) for the stops of a train detail still ahead.
function predOf(d, nowMs = Date.now()) {
  const stops = d.fermate || []
  const lastPassed = stops.reduce((last, f, i) => (f.actualFermataType === 1 ? i : last), -1)
  const here = stops[lastPassed]
  return predictStopTimes(stops, d.ritardo || 0, lastPassed, {
    inStation: !!here && !here.partenzaReale, distKm: i => segmentKm(stops, i), cls: trainClass(d), nowMs
  })
}

// Where a train is right now, read from the times recorded at its last stops:
// arrived and not left = in the station; left and not arrived at the next one = between the two.
function trainPosition(d, stops, lastPassed, delay, now = Date.now()) {
  if (d.provvedimento === 1 || d.nonPartito || d.arrivato || lastPassed < 0) return null
  const here = stops[lastPassed]
  const next = stops[lastPassed + 1]
  if (!here || !next) return null
  if (here.partenzaReale) {
    const eta = (predOf(d).get(lastPassed + 1) || {}).arrMs || (next.arrivo_teorico || next.programmata) + Math.max(delay, 0) * 60000
    const span = eta - here.partenzaReale
    const progress = span > 0 ? Math.min(0.97, Math.max(0, (now - here.partenzaReale) / span)) : null
    return { kind: 'between', from: here.stazione, to: next.stazione, since: here.partenzaReale, progress }
  }
  if (here.arrivoReale) return { kind: 'station', at: here.stazione, since: here.arrivoReale }
  return null
}

// The route: the stops from the current station to the terminus (the origin is deliberately left out).
function routeStopsFrom(detail) {
  const all = detail.fermate || []
  const hereIdx = all.findIndex(f => f.id === stationID)
  const start = Math.max(0, hereIdx)
  const cancelledIds = new Set((detail.fermateSoppresse || []).map(s => s.id))
  const pred = predOf(detail)

  const stopFrom = (f, { useDeparture, isHere = false, isEnd = false }, absIndex) => {
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
      cancelled: cancelledIds.has(f.id),
      // the model's delay for this stop (departure delay for the stop the board belongs to)
      predDelay: pred.get(absIndex) ? (useDeparture ? pred.get(absIndex).depDelay : pred.get(absIndex).arrDelay) : null
    }
  }

  const stops = []
  all.slice(start).forEach((f, i, list) => {
    const isHere = i === 0 && hereIdx >= 0
    stops.push(stopFrom(f, { useDeparture: isHere || (start === 0 && i === 0), isHere, isEnd: i === list.length - 1 }, start + i))
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
    routeCache.set(key, { status: 'ok', at: Date.now(), detail }) // the stops are derived at display time (the times mode can change)
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
  const shown = stop.predDelay !== null && stop.predDelay !== undefined ? stop.predDelay : delay
  if (!real && shown > 0 && stop.schedMs && !stop.passed) {
    real = `~${formatEpochHHMM(stop.schedMs + shown * 60000)}`
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
  // two ways in: the details page, or straight to the live Tracking view
  const actions = el('div', ['route-actions'])
  ;[['Details', 'bi-list-ul', trainPageUrl(train)], ['Tracking', 'bi-broadcast', `${trainPageUrl(train)}&track=1`]].forEach(([text, iconName, href]) => {
    const link = el('a', ['route-open'])
    link.href = href
    link.append(icon(iconName), text)
    link.addEventListener('click', e => e.stopPropagation())
    actions.append(link)
  })
  panel.append(actions)
  const entry = routeCache.get(trainKey(train))
  const age = entry && entry.at ? Date.now() - entry.at : Infinity
  const stale = !entry || (entry.status === 'ok' && age > ROUTE_REFRESH_MS) || (entry.status === 'error' && age > ROUTE_RETRY_MS)
  if (stale) loadRoute(train)

  if (entry && entry.status === 'ok') {
    const line = el('div', ['route-line'])
    routeStopsFrom(entry.detail).forEach(stop => line.append(routeStopEl(stop, delayOf(train))))
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

// Global view: both sources' delays for a train, shown as a small range bar on a shared axis.
const delayAxis = { lo: 0, hi: 5 }
const signedDelay = n => (n > 0 ? `+${n}` : String(n))

function sourceDelays(train) {
  if (sourceMode !== 'global' || typeof train.delayVt !== 'number' || typeof train.delayRfi !== 'number') return null
  return { vt: train.delayVt, rfi: train.delayRfi, min: Math.min(train.delayVt, train.delayRfi), max: Math.max(train.delayVt, train.delayRfi) }
}

function updateDelayAxis(trains) {
  const both = trains.map(sourceDelays).filter(Boolean)
  delayAxis.lo = Math.min(0, ...both.map(d => d.min))
  delayAxis.hi = Math.max(5, ...both.map(d => d.max))
}

function miniTrack(d) {
  // 6px of margin on each side so the end dots are not clipped
  const pos = v => `calc(6px + (100% - 12px) * ${(v - delayAxis.lo) / (delayAxis.hi - delayAxis.lo)})`
  const track = el('span', ['mini-track'])
  const zero = el('span', ['mini-zero'])
  zero.style.left = pos(0)
  track.append(zero)
  if (d.min !== d.max) {
    const range = el('span', ['mini-range', d.max >= LATE_THRESHOLD ? 'is-late' : 'is-slight'])
    range.style.left = pos(d.min)
    range.style.width = `calc(${pos(d.max)} - ${pos(d.min)})`
    track.append(range)
  }
  const dot = (cls, v, name) => {
    const node = el('span', ['mini-dot', cls])
    node.style.left = pos(v)
    node.title = `${name}: ${v ? signedDelay(v) + ' min' : 'no delay'}`
    return node
  }
  track.append(dot('is-rfi', d.rfi, 'RFI'), dot('is-vt', d.vt, 'Viaggia'))
  return track
}

function boardRow(train, now) {
  const delay = delayOf(train)
  const presence = trainPresence(train, now) || 'not-here'
  const platform = platformOf(train)
  const cancelled = isCancelled(train)
  const real = cancelled ? null : realLabel(train)

  const expanded = expandedTrains.has(trainKey(train))
  // a train only RFI lists has no ViaggiaTreno route to open
  const clickable = !train.rfiOnly
  const row = el('div', ['flap-row', `is-${presence}`, cancelled ? 'is-cancelled' : '', clickable ? 'is-clickable' : '', expanded && clickable ? 'is-expanded' : ''])
  if (clickable) {
    row.setAttribute('role', 'button')
    row.setAttribute('tabindex', '0')
    row.setAttribute('aria-expanded', String(expanded))
    row.addEventListener('click', () => toggleRoute(train))
    row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleRoute(train) } })
  }

  const tile = el('span', ['platform-tile', `is-${presence}`], platform || '–')
  tile.title = platform ? `${label('platform')} ${platform}${train.platformFromRfi ? ' (RFI)' : ''}` : label('platformUnknown')
  if (platform && platform.length > 2) tile.classList.add('is-long')
  if (cancelled) {
    // A red cross replaces the platform number so a cancelled train stands out at a glance.
    tile.classList.remove('is-long')
    tile.classList.add('is-cancelled')
    tile.replaceChildren(icon('bi-x-lg'))
    tile.title = label('cancelled')
  }

  const sched = el('span', ['flap-time'], scheduledLabel(train))
  const both = cancelled ? null : sourceDelays(train)
  const realEl = el('span', ['flap-realcell', both ? 'is-interval' : ''])
  if (both) {
    // both sources listed the train: the times they imply (a range when they differ) and a bar under them
    const at = d => formatEpochHHMM(train.orarioPartenza + d * 60000)
    const tone = both.max >= LATE_THRESHOLD ? 'is-late' : both.max > 0 ? 'is-slight' : 'flap-none'
    let text
    if (both.min === both.max) text = both.max ? `~${at(both.max)}` : scheduledLabel(train)
    else {
      text = `${at(both.min)}–${at(both.max)}`
    }
    const times = el('span', ['flap-time', tone], text)
    times.title = `Viaggia ${signedDelay(both.vt)} min · RFI ${signedDelay(both.rfi)} min`
    realEl.append(times, miniTrack(both))
  } else if (real) {
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
    const rel = trackReliability(train.ultimoRilev, now)
    const seen = el('span', [`track-${rel.tier}`], `${label('trackedAgo')} ${tracked} ago`)
    seen.title = `Last detection ${tracked} ago: ${rel.text}`
    meta.append(' · ', seen)
  }
  dest.append(meta)

  const countdown = el('span', ['flap-countdown'], countdownLabel(train, now))
  if (presence === 'at-platform') countdown.classList.add('is-at-platform')
  row.append(tile, sched, realEl, dest, countdown)
  return row
}

function boardSection(group, now) {
  const section = el('section', ['flap-card', sourceMode === 'global' ? 'is-global' : ''])
  const title = el('header', ['flap-title'])
  title.append(icon(GROUP_ICONS[groupByMode]), el('span', [], groupHeaderLabel(groupByMode, group.key)))
  const cols = el('div', ['flap-row', 'flap-cols'])
  ;['plt', 'sched', 'real', 'to', 'in'].forEach(name => cols.append(el('span', [], name)))
  section.append(title, cols)
  group.trains.forEach(train => {
    section.append(boardRow(train, now))
    if (!train.rfiOnly && expandedTrains.has(trainKey(train))) section.append(routePanel(train))
  })
  return section
}

// Colour key for "tracked X ago": the more recent the last detection, the more the row can be trusted.
function trackKey() {
  const row = el('p', ['bar-key'])
  const item = (tier, text) => {
    const node = el('span', ['bar-key-item'])
    node.append(el('span', [`key-dot`, `track-dot-${tier}`]), text)
    return node
  }
  row.append(el('span', ['bar-key-item', 'is-title'], 'last seen'), item('good', '< 2 min'), item('ok', '< 10'), item('poor', '< 30'), item('bad', '30+'))
  return row
}

function renderBoard(trainData) {
  updateDelayAxis(trainData)
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
  if (sourceMode === 'global') {
    // a colour key, so the bars read without a sentence
    const key = (mark, text) => {
      const item = el('span', ['bar-key-item'])
      item.append(mark, text)
      return item
    }
    const bar = el('p', ['bar-key'])
    bar.append(
      key(el('span', ['key-dot', 'is-vt']), 'Viaggia'),
      key(el('span', ['key-dot', 'is-rfi']), 'RFI'),
      key(el('span', ['key-line']), 'planned'),
      key(el('span', ['key-swatch', 'is-slight']), `< ${LATE_THRESHOLD} min`),
      key(el('span', ['key-swatch', 'is-late']), `${LATE_THRESHOLD} min+`)
    )
    return $('trainInfo').replaceChildren(grid, bar, trackKey(), legend)
  }
  $('trainInfo').replaceChildren(grid, trackKey(), legend)
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
  document.title = stationName ? `${stationName} · Panel Treno` : 'Panel Treno'
  syncHeaderSpacerHeight()
}

// The header is fixed: keep the spacer under it exactly as tall as the header
// (its height varies with font size and station name wrapping).
function syncHeaderSpacerHeight() {
  $('headerSpacer').style.height = `${document.querySelector('.app-header').offsetHeight}px`
}

// Footer status: "Connected" when the last request worked, "Request failed" with the reason otherwise.
let lastSuccessTime = null
// Last requests as a ROS-monitor style strip: green ok, yellow ok after a relay failed, red failed.
const REQUEST_LOG_KEY = 'panelTreno.requests'
const REQUEST_LOG_SIZE = 24

function loadRequestLog() {
  try {
    const list = JSON.parse(localStorage.getItem(REQUEST_LOG_KEY))
    return Array.isArray(list) ? list.slice(-REQUEST_LOG_SIZE) : []
  } catch { return [] }
}

function recordRequest(state, note) {
  const log = loadRequestLog()
  log.push({ state, at: Date.now(), note })
  try { localStorage.setItem(REQUEST_LOG_KEY, JSON.stringify(log.slice(-REQUEST_LOG_SIZE))) } catch {}
  renderRequestStrip(log.slice(-REQUEST_LOG_SIZE))
}

function renderRequestStrip(log = loadRequestLog()) {
  const strip = $('requestStrip')
  if (!strip) return
  const cells = Array.from({ length: REQUEST_LOG_SIZE }, (_, i) => {
    const entry = log[log.length - REQUEST_LOG_SIZE + i]
    const cell = el('span', ['req-cell', entry ? `is-${entry.state}` : ''])
    if (entry) cell.title = `${formatTime(new Date(entry.at), true)} · ${entry.note}`
    return cell
  })
  strip.replaceChildren(...cells)
}

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
  if (!ok) recordRequest('fail', describeProxyReport(report) || 'failed')
  else if (failedRelays.length) recordRequest('partial', `via ${report.via}, ${failedRelays.length} relay failed first`)
  else recordRequest('ok', `via ${report.via}`)
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
// RFI shows "18:55" for today: turn it into the timestamp ViaggiaTreno uses.
function rfiTimeMs(time) {
  const [h, m] = time.split(':').map(Number)
  if (Number.isNaN(h)) return null
  const now = new Date()
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).getTime()
  return at < now.getTime() - 12 * 3600000 ? at + 86400000 : at
}

// Mix: ViaggiaTreno trains, completed by the RFI board. RFI knows the platform shown in the station and
// whether the train is about to leave; trains only RFI lists (other operators) are added.
function mergeSources(trains, rfiRows) {
  const byNumber = new Map(rfiRows.map(r => [r.number, r]))
  const seen = new Set()
  const merged = trains.map(t => {
    const r = byNumber.get(String(t.numeroTreno))
    if (!r) return { ...t, delayVt: delayOf(t) }
    seen.add(r.number)
    const copy = { ...t, rfi: true, delayVt: delayOf(t), delayRfi: r.delay }
    if (r.platform) {
      copy.binarioEffettivoPartenzaDescrizione = r.platform
      copy.platformFromRfi = true
    }
    if (r.departing) copy.inStazione = true
    if (!delayOf(t) && r.delay > 0) copy.ritardo = r.delay
    return copy
  })
  rfiRows.filter(r => !seen.has(r.number)).forEach(r => {
    const ms = rfiTimeMs(r.time)
    if (!ms) return
    merged.push({
      numeroTreno: r.number, categoria: r.category, destinazione: r.place,
      orarioPartenza: ms, compOrarioPartenza: r.time, ritardo: r.delay, provvedimento: 0,
      binarioEffettivoPartenzaDescrizione: r.platform, platformFromRfi: true, inStazione: r.departing,
      rfi: true, rfiOnly: true, delayRfi: r.delay
    })
  })
  return merged
}

async function fetchRfiSide() {
  await rfiReady
  if (sourceMode === 'vt' || !rfiPlaceId) return null
  try {
    return await fetchRfiRows(rfiPlaceId, false)
  } catch (err) {
    console.error('Error fetching the RFI board:', err)
    return null
  }
}

async function fetchAndDisplay() {
  const url = `http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/partenze/${stationID}/${encodeURIComponent(nowAsViaggiaTrenoDate())}`
  let data
  let rfiRows = null
  try {
    // the two sources are asked one after the other: the relay is rate limited
    data = await fetchViaProxy(url)
    rfiRows = await fetchRfiSide()
  } catch (err) {
    console.error('Error fetching data:', err)
    setRequestStatus(false)
    if (!lastUpdateData) renderMessage('bi-wifi-off', label('loadError'), true, describeProxyReport(lastProxyReport))
    return
  }
  lastSuccessTime = new Date()
  setRequestStatus(true)
  if (sourceMode !== 'vt') {
    const viaggia = $('statusDetail').textContent
    $('statusDetail').textContent = `${viaggia} · RFI ${rfiRows ? 'merged' : 'unavailable, Viaggia only'}`
    if (rfiRows && Array.isArray(data)) data = mergeSources(data, rfiRows)
  }
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

function trainStopEl(f, index, stops, detail, lastPassedIndex, pred) {
  const passed = f.actualFermataType === 1
  const delayNow = detail.ritardo || 0
  const cancelledIds = new Set((detail.fermateSoppresse || []).map(s => s.id))
  const isFirst = index === 0
  const isLast = index === stops.length - 1
  const kinds = [passed ? 'is-passed' : '', index === lastPassedIndex ? 'is-last-seen' : '', index === lastPassedIndex + 1 ? 'is-next' : '', isFirst ? 'is-start' : '', isLast ? 'is-end' : '', cancelledIds.has(f.id) ? 'is-cancelled' : '']
  const node = el('div', ['tv-stop', ...kinds])

  const arrSched = f.arrivo_teorico || f.programmata
  const depSched = f.partenza_teorica || f.programmata
  const guess = pred && pred.get(index)
  const arrCell = isFirst ? el('span', ['tv-cell']) : tvTimeCell(arrSched, f.arrivoReale, guess ? guess.arrDelay : delayNow, passed)
  const depCell = isLast ? el('span', ['tv-cell']) : tvTimeCell(depSched, f.partenzaReale, guess ? guess.depDelay : delayNow, passed)

  const info = el('div', ['tv-info'])
  const stationLink = el('a', ['tv-name'], f.stazione)
  if (f.id) {
    stationLink.href = `index.html?${new URLSearchParams({ stationID: f.id, stationName: f.stazione })}`
    stationLink.title = `Departures at ${f.stazione}`
  }
  info.append(stationLink)
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

function passEl(det) {
  const row = el('div', ['tv-pass'])
  row.append(el('span', ['tv-pass-dot']), el('span', ['tv-pass-text'], `passed ${det.name.toLowerCase()} · ${formatEpochHHMM(det.t)} · no stop`))
  return row
}

function betweenEl(position, next, delay, now) {
  const row = el('div', ['tv-between'])
  const eta = (predOf(trainDetail).get(trainDetail.fermate.indexOf(next)) || {}).arrMs || (next.arrivo_teorico || next.programmata) + Math.max(delay, 0) * 60000
  const train = el('span', ['tv-between-train'])
  train.append(icon('bi-train-front-fill'))
  train.style.top = `calc((100% - 24px) * ${position.progress === null ? 0.5 : position.progress})`
  const text = el('div', ['tv-between-text'])
  text.append(el('strong', [], 'Between stations'), el('span', [], `left ${Math.max(0, Math.round((now - position.since) / 60000))} min ago · ${untilLabel(eta, now) === 'now' ? 'arriving' : `reaches ${next.stazione.toLowerCase()} ${untilLabel(eta, now)}`}`))
  row.append(train, text)
  return row
}

function positionEl(position, now, lastSeenMs, here, next, delay) {
  const box = el('div', ['tv-position'])
  const rel = lastSeenMs ? trackReliability(lastSeenMs, now) : null
  box.title = `Read from the times recorded at the last stops${rel ? `; last detection: ${rel.text}` : ''}`
  const ago = ms => {
    const m = Math.max(0, Math.round((now - ms) / 60000))
    return m < 1 ? '<1 min' : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
  }
  if (position.kind === 'station') {
    const line = el('p', ['tv-position-text'])
    line.append(icon('bi-geo-alt-fill'), el('strong', [], ' In station '), `${position.at} · arrived ${ago(position.since)} ago`)
    box.append(line)
  } else {
    const line = el('p', ['tv-position-text'])
    line.append(icon('bi-arrow-right-circle-fill'), el('strong', [], ' Between stations '), `· left ${position.from} ${ago(position.since)} ago`)
    box.append(line)
    const bar = el('div', ['tv-position-bar'])
    const pct = position.progress === null ? 50 : Math.round(position.progress * 100)
    const dot = el('span', ['tv-position-dot'])
    dot.style.left = `${pct}%`
    bar.append(dot)
    const ends = el('div', ['tv-position-ends'])
    ends.append(el('span', [], position.from.toLowerCase()), el('span', [], position.to.toLowerCase()))
    box.append(bar, ends)
  }
  // how long until the next stop (or until the train leaves, when it is in a station)
  const when = position.kind === 'station'
    ? { name: 'departs', ms: predOf(trainDetail).leaveMs || (here.partenza_teorica || here.programmata) + Math.max(delay, 0) * 60000 }
    : { name: `reaches ${next.stazione.toLowerCase()}`, ms: (predOf(trainDetail).get(trainDetail.fermate.indexOf(next)) || {}).arrMs || (next.arrivo_teorico || next.programmata) + Math.max(delay, 0) * 60000 }
  const left = untilLabel(when.ms, now)
  const eta = el('p', ['tv-position-eta'])
  eta.append(icon('bi-stopwatch'), el('strong', [], ` ${left === 'now' ? 'due now' : left}`), ` · ${when.name} ~${formatEpochHHMM(when.ms)}`)
  box.append(eta)
  return box
}

// =======================
// Tracking data log (feeds the nerd view)
// =======================
// ticks: the model's position every few seconds; fetches: what each data refresh changed.
const trackHist = { key: null, ticks: [], fetches: [], detections: [] }

// ---- station coordinates (data/stations.json, built by scripts/build-stations.py) ----
let stationBook = null // code -> [lat, lon, name]
let stationNames = null // NAME -> code
let stationsReady = Promise.resolve()
function loadStations() {
  if (stationBook) return
  stationsReady = fetch('data/stations.json')
    .then(r => r.json())
    .then(book => {
      stationBook = book
      stationNames = new Map(Object.entries(book).map(([id, v]) => [v[2], id]))
    })
    .catch(() => { /* without coordinates the filter falls back to the timetable alone */ })
}

const toRad = deg => (deg * Math.PI) / 180
function haversineKm(a, b) {
  const dLat = toRad(b[0] - a[0])
  const dLon = toRad(b[1] - a[1])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}
const stationPoint = id => (stationBook && stationBook[id] ? [stationBook[id][0], stationBook[id][1]] : null)

// Where a station lies between two consecutive stops of the train: [segment index + fraction, off-line km].
function projectOnRoute(stops, point) {
  if (!point) return null
  let best = null
  for (let i = 0; i < stops.length - 1; i++) {
    const A = stationPoint(stops[i].id)
    const B = stationPoint(stops[i + 1].id)
    if (!A || !B) continue
    const k = Math.cos(toRad((A[0] + B[0]) / 2)) // longitude shrinks with latitude
    const bx = (B[1] - A[1]) * k
    const by = B[0] - A[0]
    const px = (point[1] - A[1]) * k
    const py = point[0] - A[0]
    const len2 = bx * bx + by * by
    if (!len2) continue
    const t = (px * bx + py * by) / len2
    if (t <= 0.02 || t >= 0.98) continue
    const off = haversineKm(point, [A[0] + by * t, A[1] + (bx * t) / k])
    if (!best || off < best.off) best = { s: i + t, off }
  }
  return best
}

// Length of the segment from stop i to stop i+1, in km (null without coordinates).
function segmentKm(stops, i) {
  const A = stops[i] && stationPoint(stops[i].id)
  const B = stops[i + 1] && stationPoint(stops[i + 1].id)
  return A && B ? haversineKm(A, B) : null
}
let nerdTrack = false
let trackWin = '10' // minutes shown by the position plot: '5', '10', '30' or 'all'
let trackAxis = 'min' // vertical axis of the plot: 'min' (scheduled travel time) or 'km' (distance)
const TRACK_TICK_MS = 5000
const NOW_FRAC = 0.7 // where "now" is, as a share of the plot width, in every nerd chart
const TRACK_KEEP = 360

function trackCoord(d, model) {
  const stops = d.fermate || []
  if (model.kind === 'arrived') return stops.length - 1
  if (!model.here) return null
  const i = stops.indexOf(model.here)
  return i + (model.kind === 'between' ? model.p : 0)
}

function loadTrackHist() {
  trackHist.key = `panelTreno.track.${trainRef.number}-${trainRef.date}`
  trackHist.fetches = []
  trackHist.detections = []
  try {
    const saved = JSON.parse(localStorage.getItem(trackHist.key))
    if (Array.isArray(saved)) trackHist.fetches = saved.slice(-TRACK_KEEP) // older format: the fetches only
    else if (saved) {
      trackHist.fetches = (saved.f || []).slice(-TRACK_KEEP)
      trackHist.detections = saved.d || []
    }
  } catch { /* nothing saved */ }
  trackHist.ticks = []
}

function saveTrackHist() {
  try {
    localStorage.setItem(trackHist.key, JSON.stringify({ f: trackHist.fetches.slice(-TRACK_KEEP), d: trackHist.detections.slice(-200) }))
  } catch { /* storage is optional */ }
}

// The API only keeps the LAST detection of a train. Detection points are often stations it goes through
// without stopping: log each one as it appears, so the passage is not lost at the next refresh.
function recordDetection(data) {
  if (!data.oraUltimoRilevamento || !data.stazioneUltimoRilevamento || !stationNames) return
  const name = data.stazioneUltimoRilevamento.trim().toUpperCase()
  if (trackHist.detections.some(x => x.t === data.oraUltimoRilevamento)) return
  const id = stationNames.get(name)
  if (!id) return
  const stops = data.fermate || []
  if (stops.some(f => f.id === id)) return // a listed stop has its own real times
  const point = stationPoint(id)
  const proj = point && projectOnRoute(stops, point)
  if (!proj || proj.off > 8) return // not on this train's line
  trackHist.detections.push({ t: data.oraUltimoRilevamento, name, id, s: proj.s })
  trackHist.detections.sort((a, b) => a.t - b.t)
  saveTrackHist()
}

function recordTick() {
  if (!trainDetail || !trackHist.key) return
  const now = Date.now()
  const s = trackCoord(trainDetail, trackingModel(trainDetail, now))
  if (s === null) return
  trackHist.ticks.push({ t: now, s })
  if (trackHist.ticks.length > TRACK_KEEP * 2) trackHist.ticks.shift() // about an hour of samples
  if (trackingMode && nerdTrack) renderTrackNerd(trainDetail)
}

// A data refresh arrived: how far was the old estimate from the new one?
function recordFetch(prev, data) {
  const now = Date.now()
  const last = trackHist.fetches[trackHist.fetches.length - 1]
  if (last && now - last.t < 8000) return // a page reload right after a refresh is not a new data point
  const sBefore = prev ? trackCoord(prev, trackingModel(prev, now)) : null
  const age = data.oraUltimoRilevamento ? Math.max(0, (now - data.oraUltimoRilevamento) / 60000) : 3
  const entry = { t: now, s: null, sBefore, delay: data.ritardo || 0, age }
  trackHist.fetches.push(entry) // first, so that the filter already counts this measurement
  const s = trackCoord(data, trackingModel(data, now))
  if (s === null) { trackHist.fetches.pop(); return }
  entry.s = s
  trackHist.ticks.push({ t: now, s })
  saveTrackHist()
}

// up to two lines of at most `n` characters, cut on word boundaries (an ellipsis only when it still does not fit)
function wrapLabel(name, n = 16) {
  const words = name.toLowerCase().split(/\s+/)
  const lines = ['']
  words.forEach(w => {
    const cur = lines[lines.length - 1]
    if (!cur) lines[lines.length - 1] = w
    else if ((cur + ' ' + w).length <= n) lines[lines.length - 1] = `${cur} ${w}`
    else lines.push(w)
  })
  if (lines.length > 2) {
    const rest = lines.slice(1).join(' ')
    lines.length = 1
    lines.push(rest.length > n ? `${rest.slice(0, n - 1)}…` : rest)
  }
  return lines.map(l => (l.length > n ? `${l.slice(0, n - 1)}…` : l))
}


// Stations on the vertical axis, clock time on the horizontal one.
function nerdTrackChart(d) {
  const stops = d.fermate || []
  const now = Date.now()
  const model = trackingModel(d, now)
  const sNow = trackCoord(d, model)
  // what really happened (arrival and departure times at each stop) and where the train was at any instant
  const real = []
  stops.forEach((st, i) => {
    if (st.arrivoReale) real.push({ t: st.arrivoReale, s: i, kind: 'arr', f: st })
    if (st.partenzaReale) real.push({ t: st.partenzaReale, s: i, kind: 'dep', f: st })
  })
  trackHist.detections.forEach(x => real.push({ t: x.t, s: x.s, kind: 'det', f: { stazione: x.name } }))
  real.sort((x, y) => x.t - y.t)
  const histPts = trackHist.ticks.concat(trackHist.fetches.map(x => ({ t: x.t, s: x.s }))).sort((x, y) => x.t - y.t)
  const posAt = t => {
    if (real.length && t <= real[0].t) return real[0].s
    for (let i = 1; i < real.length; i++) {
      if (t <= real[i].t) return real[i - 1].s + ((t - real[i - 1].t) / Math.max(1, real[i].t - real[i - 1].t)) * (real[i].s - real[i - 1].s)
    }
    const before = histPts.filter(x => x.t <= t)
    return before.length ? before[before.length - 1].s : sNow
  }
  const panel = el('div', ['nerd-panel'])
  const head = el('div', ['nerd-panel-head'])
  const winSwitch = el('div', ['tk-zoom', 'is-small'])
  ;[['5', '5 min'], ['10', '10 min'], ['30', '30 min'], ['all', 'All']].forEach(([key, text]) => {
    const b = el('button', ['tk-zoom-btn', trackWin === key ? 'is-active' : ''], text)
    b.type = 'button'
    b.addEventListener('click', () => { trackWin = key; renderTrackNerd(trainDetail) })
    winSwitch.append(b)
  })
  const axisSwitch = el('div', ['tk-zoom', 'is-small'])
  ;[['min', 'min'], ['km', 'km']].forEach(([key, text]) => {
    const b = el('button', ['tk-zoom-btn', trackAxis === key ? 'is-active' : ''], text)
    b.type = 'button'
    b.title = key === 'km' ? 'Stations spaced by distance' : 'Stations spaced by scheduled travel time'
    b.addEventListener('click', () => { trackAxis = key; renderTrackNerd(trainDetail) })
    axisSwitch.append(b)
  })
  head.append(el('span', [], 'position vs time'), axisSwitch, winSwitch)
  panel.append(head)
  if (sNow === null) {
    panel.append(el('p', ['nerd-dim'], 'no position to plot yet'))
    return panel
  }
  const winMs = trackWin === 'all' ? null : Number(trackWin) * 60000
  const winStart = winMs ? now - winMs * NOW_FRAC : 0
  const samples = trackHist.ticks.concat(trackHist.fetches.map(f => ({ t: f.t, s: f.s }))).filter(x => !winMs || (x.t >= winStart - winMs && x.t <= winStart + 2 * winMs))
  const all = samples.map(x => x.s).concat([sNow])
  let lo
  let hi
  if (winMs) {
    // zoomed: the stations around the train, a few minutes either side of now
    const here = Math.min(stops.length - 1, Math.max(0, Math.floor(sNow)))
    const pad = trackWin === '30' ? 1 : 0
    lo = Math.max(0, here - 1 - pad)
    hi = Math.min(stops.length - 1, here + 2 + pad)
  } else {
    lo = Math.max(0, Math.floor(Math.min(...all)) - 1)
    hi = Math.min(stops.length - 1, Math.ceil(Math.max(...all)) + 2)
    while (hi - lo < 4 && (lo > 0 || hi < stops.length - 1)) { if (hi < stops.length - 1) hi++; if (hi - lo < 4 && lo > 0) lo-- }
    if (hi - lo > 13) lo = hi - 13
  }
  while (hi - lo < 2 && (lo > 0 || hi < stops.length - 1)) { if (hi < stops.length - 1) hi++; else lo-- }
  const rows = stops.slice(lo, hi + 1)
  // predicted passing times: the filter's arrival at the next stop, then the timetable's gaps after it
  const hereStop = stops.indexOf(model.here)
  const nextS = hereStop >= 0 ? stops[hereStop + 1] : null
  let nextArrival = model.eta
  if (model.kind === 'between' && model.kal && Number.isFinite(model.kal.minToGo)) {
    nextArrival = Math.min(now + 3 * 3600000, now + model.kal.minToGo * 60000)
  }
  const modelPred = predOf(d)
  const modelAt = i => (modelPred.get(i) || {}).arrMs
  const predAt = i => (nextS && i > hereStop && nextArrival && modelAt(i) && modelAt(hereStop + 1) ? nextArrival + modelAt(i) - modelAt(hereStop + 1) : null)
  const extra = Math.max(d.ritardo || 0, 0) * 60000
  const arrOf = f => f.arrivo_teorico || f.programmata
  const depOf = f => f.partenza_teorica || f.programmata

  // the window follows the log: from the first sample to a little after the next stop (at least 20 minutes)
  const firstT = samples.length ? Math.min(...samples.map(x => x.t)) : now
  const nextStop = stops[Math.min(stops.length - 1, Math.floor(sNow) + 1)]
  const tMin = winMs ? winStart : firstT - 2 * 60000
  const tMax = winMs ? winStart + winMs : Math.max(now + 3 * 60000, arrOf(nextStop) + extra + 2 * 60000, tMin + 20 * 60000)
  const LEFT = 150
  const RIGHT = 12
  const TOP = 14
  // the vertical axis follows the scheduled travel time between stations (dwell times left out), or the distance
  const cum = [0]
  // only the stops on screen need coordinates; the others are spaced by time
  const kmOk = stops.every((st, i) => i <= lo || i > hi || segmentKm(stops, i - 1) !== null)
  const useKm = trackAxis === 'km' && kmOk
  stops.forEach((st, i) => {
    if (!i) return
    const minutes = Math.max(0.5, (arrOf(st) - depOf(stops[i - 1])) / 60000)
    const km = segmentKm(stops, i - 1)
    cum[i] = cum[i - 1] + (useKm && km !== null ? Math.max(0.2, km) : minutes)
  })
  const minAt = v => {
    const c = Math.min(Math.max(v, 0), stops.length - 1)
    const i = Math.floor(c)
    const j = Math.min(stops.length - 1, i + 1)
    return cum[i] + (c - i) * (cum[j] - cum[i])
  }
  const totalMin = Math.max(1, minAt(hi) - minAt(lo))
  let minGap = Infinity
  for (let i = lo; i < hi; i++) minGap = Math.min(minGap, cum[i + 1] - cum[i])
  const pxPerMin = Math.min(380 / totalMin, Math.max(24 / Math.max(minGap, 0.5), (winMs ? 190 : 150) / totalMin))
  const plotH = pxPerMin * totalMin
  const yAt = v => TOP + pxPerMin * (minAt(v) - minAt(lo))
  const H = TOP + plotH + 26
  const W = chartWidth()
  const plotW = W - LEFT - RIGHT
  const xOf = ms => LEFT + ((ms - tMin) / (tMax - tMin)) * plotW
  const yOf = v => yAt(Math.min(Math.max(v, lo), hi))

  const svg = svgChart(H, 'Estimated and corrected train position against time', W)
  let lastLabelY = -Infinity
  rows.forEach((f, i) => {
    const y = yAt(lo + i)
    svg.append(svgEl('line', { x1: LEFT, y1: y, x2: W - RIGHT, y2: y, class: 'tl-grid' }))
    // the scale of the vertical axis: distance or scheduled time since the first stop shown
    svg.append(svgEl('text', { x: W - RIGHT, y: y - 3, class: 'tk-axis-scale', 'text-anchor': 'end' }, useKm ? `${(cum[lo + i] - cum[lo]).toFixed(1)} km` : `${Math.round(cum[lo + i] - cum[lo])} min`))
    if (y - lastLabelY < 22) return // too close to the previous name: the line stays, the label is skipped
    lastLabelY = y
    // station names wrap on two lines instead of being cut: "genova piazza / principe"
    const lines = wrapLabel(f.stazione, 15)
    const label = svgEl('text', { x: 4, y: lines.length > 1 ? y - 1 : y + 4, class: 'tl-label' })
    lines.forEach((line, k) => label.append(svgEl('tspan', { x: 4, dy: k ? 11 : 0 }, line)))
    label.append(svgEl('title', {}, f.stazione))
    svg.append(label)
    const due = predAt(lo + i)
    if (due) {
      const when = svgEl('text', { x: LEFT - 6, y: y + 4, 'text-anchor': 'end', class: 'tk-plot-when' }, `~${formatEpochHHMM(due)}`)
      when.append(svgEl('title', {}, `Predicted at ${formatTime(new Date(due), true)}`))
      svg.append(when)
    }
  })
  const span = tMax - tMin
  // the smallest round step that keeps the clock labels about 44px apart
  const step = ([1, 2, 5, 10, 15, 30, 60, 120].find(m => (m * 60000 / span) * plotW >= 44) || 120) * 60000
  for (let t = Math.ceil(tMin / step) * step; t < tMax; t += step) {
    svg.append(svgEl('line', { x1: xOf(t), y1: TOP, x2: xOf(t), y2: TOP + plotH, class: 'tl-vgrid' }))
    svg.append(svgEl('text', { x: xOf(t), y: H - 8, class: 'tl-label', 'text-anchor': 'middle' }, formatTime(new Date(t))))
  }
  if (now >= tMin && now <= tMax) svg.append(svgEl('line', { x1: xOf(now), y1: TOP, x2: xOf(now), y2: TOP + plotH, class: 'tl-now' }))

  const clipId = `tkclip${Math.round(now)}`
  const defs = svgEl('defs')
  const clip = svgEl('clipPath', { id: clipId })
  clip.append(svgEl('rect', { x: LEFT, y: TOP - 8, width: plotW, height: plotH + 16 }))
  defs.append(clip)
  svg.append(defs)
  const plot = svgEl('g', { 'clip-path': `url(#${clipId})` })
  svg.append(plot)
  const path = (pts, cls) => plot.append(svgEl('polyline', { points: pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '), class: cls }))
  // timetable alone
  path(rows.flatMap((f, i) => [[xOf(arrOf(f)), yAt(lo + i)], [xOf(depOf(f)), yAt(lo + i)]]), 'tk-plot-sched')
  // what the current delay predicts for the stops ahead
  const idxHere = stops.indexOf(model.here)
  const ahead = rows.map((f, i) => ({ f, i, idx: lo + i })).filter(r => r.idx > idxHere)
  path([[xOf(now), yOf(sNow)]].concat(ahead.flatMap(r => { const at = predAt(lo + r.i) || arrOf(r.f) + extra; const dwell = depOf(r.f) - arrOf(r.f); return [[xOf(at), yAt(lo + r.i)], [xOf(at + dwell), yAt(lo + r.i)]] })), 'tk-plot-pred')
  // the filter replayed with everything known now (late detections and real times applied where they belong,
  // and the past revised by the smoother), against what was believed at the time
  let revised = null
  if (model.kind === 'between' && model.kal) {
    const hereI = stops.indexOf(model.here)
    const yBand = v => yAt(hereI + Math.min(1, Math.max(0, v)))
    const run = kalmanRun(d, model.here, model.next, model.since, now, 5000)
    revised = run.samples.map(x => ({ t: x.t, s: hereI + x.p }))
    const pts = run.samples.concat(kalmanForecast(run, now, Math.max(model.eta, now) + 60000))
    const upper = pts.map(x => [xOf(x.t), yBand(x.p + 2 * x.sigma)])
    const lower = pts.map(x => [xOf(x.t), yBand(x.p - 2 * x.sigma)]).reverse()
    const poly = svgEl('polygon', { points: upper.concat(lower).map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '), class: 'tk-plot-band' })
    poly.append(svgEl('title', {}, 'Kalman smoother: +-2 sigma around the revised position'))
    plot.append(poly)
  }
  // estimated position over time
  const sortT = (a, b) => a.t - b.t
  if (revised) {
    const t0 = model.since
    path(samples.filter(x => x.t < t0).concat(revised).sort(sortT).map(x => [xOf(x.t), yOf(x.s)]), 'tk-plot-est')
    path(samples.filter(x => x.t >= t0).concat([{ t: now, s: sNow }]).sort(sortT).map(x => [xOf(x.t), yOf(x.s)]), 'tk-plot-belief')
  } else {
    path(samples.concat([{ t: now, s: sNow }]).sort(sortT).map(x => [xOf(x.t), yOf(x.s)]), 'tk-plot-est')
  }
  // corrections: each data refresh moved the estimate from sBefore to s
  trackHist.fetches.forEach(f => {
    if (f.sBefore !== null && Math.abs(f.s - f.sBefore) > 0.02) {
      plot.append(svgEl('line', { x1: xOf(f.t), y1: yOf(f.sBefore), x2: xOf(f.t), y2: yOf(f.s), class: 'tk-plot-fix' }))
    }
    const dot = svgEl('circle', { cx: xOf(f.t), cy: yOf(f.s), r: 3, class: 'tk-plot-fetch' })
    dot.append(svgEl('title', {}, `${formatTime(new Date(f.t), true)} · delay ${f.delay > 0 ? '+' : ''}${f.delay} min${f.sBefore !== null ? ` · moved ${(f.s - f.sBefore >= 0 ? '+' : '')}${((f.s - f.sBefore) * 100).toFixed(0)}% of a segment` : ''}`))
    plot.append(dot)
  })
  // what really happened, rebuilt from the recorded times: arrival and departure at each stop,
  // joined by straight lines (linear in time between two stops)
  const yRaw = yAt
  if (real.length > 1) path(real.map(r => [xOf(r.t), yRaw(r.s)]), 'tk-plot-real')
  real.forEach(r => {
    if (r.s < lo - 0.5 || r.s > hi + 0.5) return
    if (r.kind === 'det') {
      // a station the train went through without stopping
      const x = xOf(r.t)
      const y = yRaw(r.s)
      const mark = svgEl('path', { d: `M${x},${y - 5} L${x + 5},${y} L${x},${y + 5} L${x - 5},${y} Z`, class: 'tk-plot-det' })
      mark.append(svgEl('title', {}, `${r.f.stazione.toLowerCase()}: passed ${formatEpochHHMM(r.t)} without stopping`))
      plot.append(mark)
      return
    }
    const dot = svgEl('circle', { cx: xOf(r.t), cy: yRaw(r.s), r: r.kind === 'dep' ? 4.5 : 3.5, class: `tl-dot is-ok ${r.kind === 'arr' ? 'is-arrival' : ''}` })
    dot.append(svgEl('title', {}, `${r.f.stazione}: ${r.kind === 'arr' ? 'arrived' : 'left'} ${formatEpochHHMM(r.t)}`))
    plot.append(dot)
  })
  const estPts = (revised ? samples.filter(x => x.t < model.since).concat(revised) : samples.concat([{ t: now, s: sNow }])).sort(sortT)
  trackView = { tMin, tMax, LEFT, RIGHT, W, winMs, now, est: estPts, cursors: [], readouts: [] }
  // hover (or touch) the plot to read the estimated position at that instant
  const readout = el('p', ['tk-readout', 'nerd-dim'], winMs ? 'touch or hover the plot to read the position at that time' : '')
  const cursor = svgEl('line', { y1: TOP, y2: TOP + plotH, class: 'tk-cursor' })
  cursor.style.display = 'none'
  svg.append(cursor)
  trackView.cursors.push(cursor)
  const describe = v => {
    const i = Math.min(stops.length - 1, Math.floor(v))
    const frac = v - i
    if (frac < 0.03 || i >= stops.length - 1) return `at ${stops[i].stazione.toLowerCase()}`
    return `between ${stops[i].stazione.toLowerCase()} and ${stops[i + 1].stazione.toLowerCase()} · ${Math.round(frac * 100)}%`
  }
  const showAt = clientX => {
    const rect = svg.getBoundingClientRect()
    const x = (clientX - rect.left) * (W / rect.width)
    if (x < LEFT || x > W - RIGHT) return
    const t = tMin + ((x - LEFT) / plotW) * (tMax - tMin)
    syncCursors(x)
    readout.textContent = `${formatTime(new Date(t), true)} · ${t > now ? 'in the future' : describe(posAt(t))}`
  }
  if (winMs) {
    svg.addEventListener('pointerdown', e => showAt(e.clientX))
    svg.addEventListener('pointermove', e => showAt(e.clientX))
    svg.addEventListener('pointerleave', () => syncCursors(null))
  }
  panel.append(readout, svg)
  const legend = el('p', ['nerd-dim', 'tk-plot-legend'])
  const item = (cls, text) => { const k = el('span', ['tk-plot-key']); k.append(el('span', [cls]), text); return k }
  legend.append(item('k-est', 'revised estimate'), item('k-belief', 'believed then'), item('k-band', '±2σ'), item('k-pred', 'predicted'), item('k-sched', 'timetable'), item('k-fix', 'correction'), item('k-real', 'real times'), item('k-det', 'passed, no stop'))
  panel.append(legend)
  return panel
}

// The cursor of every chart that shares the time axis moves together.
let trackView = null
function syncCursors(x) {
  if (!trackView) return
  trackView.cursors.forEach(c => {
    if (x === null) { c.style.display = 'none'; return }
    c.setAttribute('x1', x)
    c.setAttribute('x2', x)
    c.style.display = ''
  })
}

// The delay over time on the same time axis as the position chart: the delay the estimate implies (a
// continuous curve: it shrinks as the train makes up time), the forecast, and what ViaggiaTreno reported.
function nerdTrackDelay(d) {
  const panel = el('div', ['nerd-panel'])
  const head = el('div', ['nerd-panel-head'])
  head.append(el('span', [], 'delay vs time'), el('span', [], 'minutes'))
  panel.append(head)
  if (!trackView) {
    panel.append(el('p', ['nerd-dim'], 'no position yet'))
    return panel
  }
  const { tMin, tMax, LEFT, RIGHT, W, winMs, now } = trackView
  const stops = d.fermate || []
  const schedAt = v => {
    const i = Math.min(stops.length - 1, Math.floor(v))
    const a = stops[i].partenza_teorica || stops[i].programmata
    if (i >= stops.length - 1) return stops[i].arrivo_teorico || stops[i].programmata
    const b = stops[i + 1].arrivo_teorico || stops[i + 1].programmata
    return a + (v - i) * (b - a)
  }
  // implied delay, only where the train is between two stops (in a station the position says nothing)
  const implied = trackView.est
    .filter(x => { const f = x.s - Math.floor(x.s); return f > 0.02 && f < 0.98 && x.t <= now })
    .map(x => ({ t: x.t, v: (x.t - schedAt(x.s)) / 60000 }))
  const reported = trackHist.fetches.map(x => ({ t: x.t, v: x.delay }))
  // forecast from the model: the delay at each stop ahead
  const pred = predOf(d, now)
  const ahead = []
  pred.forEach(x => { ahead.push({ t: x.arrMs, v: x.arrDelay }, { t: x.depMs, v: x.depDelay }) })
  const lastImplied = implied[implied.length - 1] || reported[reported.length - 1]
  const forecast = (lastImplied ? [{ t: now, v: lastImplied.v }] : []).concat(ahead.filter(x => x.t > now && x.t <= tMax + 60000))
  const all = implied.concat(reported, forecast).filter(x => x.t >= tMin - 60000 && x.t <= tMax + 60000)
  if (all.length < 2) {
    panel.append(el('p', ['nerd-dim'], 'needs two refreshes (about 16 s) to draw a curve'))
    return panel
  }
  const TOP = 12
  const H = 150
  const plotH = H - TOP - 24
  const plotW = W - LEFT - RIGHT
  const yMax = Math.max(3, Math.ceil(Math.max(...all.map(x => x.v)) / 2) * 2)
  const yMin = Math.min(0, Math.floor(Math.min(...all.map(x => x.v)) / 2) * 2)
  const xOf = ms => LEFT + ((ms - tMin) / (tMax - tMin)) * plotW
  const yOf = v => TOP + plotH - ((v - yMin) / (yMax - yMin)) * plotH
  const svg = svgChart(H, 'Delay against time: implied by the estimate, forecast, and as reported', W)
  ;[yMin, 0, yMax].filter((v, i, a) => a.indexOf(v) === i).forEach(v => {
    svg.append(svgEl('line', { x1: LEFT, y1: yOf(v), x2: W - RIGHT, y2: yOf(v), class: 'tl-grid' }))
    svg.append(svgEl('text', { x: LEFT - 6, y: yOf(v) + 4, class: 'tl-label', 'text-anchor': 'end' }, `${v > 0 ? '+' : ''}${v} min`))
  })
  const clipId = 'kdclip'
  const defs = svgEl('defs', {})
  const clip = svgEl('clipPath', { id: clipId })
  clip.append(svgEl('rect', { x: LEFT, y: TOP - 4, width: plotW, height: plotH + 8 }))
  defs.append(clip)
  svg.append(defs)
  const plot = svgEl('g', { 'clip-path': `url(#${clipId})` })
  const line = (pts, cls) => plot.append(svgEl('polyline', { points: pts.map(x => `${xOf(x.t).toFixed(1)},${yOf(x.v).toFixed(1)}`).join(' '), class: cls }))
  // what ViaggiaTreno reported: it holds until the next refresh
  const steps = []
  reported.forEach((p, i) => { if (i) steps.push({ t: p.t, v: reported[i - 1].v }); steps.push(p) })
  if (steps.length) { steps.push({ t: now, v: steps[steps.length - 1].v }); line(steps, 'tk-plot-belief') }
  if (implied.length > 1) line(implied, 'tk-plot-est')
  if (forecast.length > 1) line(forecast, 'tk-plot-pred')
  plot.append(svgEl('line', { x1: xOf(now), x2: xOf(now), y1: TOP, y2: TOP + plotH, class: 'tl-now' }))
  svg.append(plot)
  ;[tMin, tMax].forEach((t, i) => svg.append(svgEl('text', { x: i ? W - RIGHT : LEFT, y: H - 6, class: 'tl-label', 'text-anchor': i ? 'end' : 'start' }, formatTime(new Date(t)))))
  const cursor = svgEl('line', { y1: TOP, y2: TOP + plotH, class: 'tk-cursor' })
  cursor.style.display = 'none'
  svg.append(cursor)
  trackView.cursors.push(cursor)
  const readout = el('p', ['tk-readout', 'nerd-dim'], winMs ? 'hover to read the delay; the cursor follows the position chart' : '')
  const valueAt = t => {
    const pts = (t > now ? forecast : implied.length > 1 ? implied : reported)
    if (!pts.length) return null
    let best = pts[0]
    pts.forEach(p => { if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p })
    return best.v
  }
  const showAt = clientX => {
    const rect = svg.getBoundingClientRect()
    const x = (clientX - rect.left) * (W / rect.width)
    if (x < LEFT || x > W - RIGHT) return
    const t = tMin + ((x - LEFT) / plotW) * (tMax - tMin)
    syncCursors(x)
    const v = valueAt(t)
    readout.textContent = `${formatTime(new Date(t), true)} · ${t > now ? 'forecast ' : ''}${v === null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(1)} min`}`
  }
  if (winMs) {
    svg.addEventListener('pointerdown', e => showAt(e.clientX))
    svg.addEventListener('pointermove', e => showAt(e.clientX))
    svg.addEventListener('pointerleave', () => syncCursors(null))
  }
  panel.append(readout, svg)
  const legend = el('p', ['nerd-dim', 'tk-plot-legend'])
  const item = (cls, text) => { const k = el('span', ['tk-plot-key']); k.append(el('span', [cls]), text); return k }
  legend.append(item('k-est', 'implied by the estimate'), item('k-pred', 'forecast'), item('k-belief', 'reported'))
  panel.append(legend)
  return panel
}

// "kinematics": what the model derives from the distance between two stations, shown for the segment the
// train is in (speed profile, position, speed now) or for the stop it is at (time in station).
function kinematics(d, cur, now) {
  const stops = d.fermate || []
  const cls = trainClass(d)
  if (cur.kind === 'between') {
    const hereI = stops.indexOf(cur.here)
    const km = segmentKm(stops, hereI)
    if (!km) return { kind: 'between', km: null }
    const prof = motionProfile(km, cls)
    const total = Math.max(60, (cur.eta - cur.since) / 1000) // s the train is expected to take
    const dilation = total / prof.total // > 1: slower than the profile, on the whole
    const speedAt = f => (prof.at(prof.timeAt(f)).v / dilation) * 3.6
    const sigma = cur.kal && Number.isFinite(cur.kal.sigma) ? cur.kal.sigma : 0
    const lo = speedAt(Math.max(0, cur.p - sigma))
    const hi = speedAt(Math.min(1, cur.p + sigma))
    const schedMin = (cur.next.arrivo_teorico || cur.next.programmata) - (cur.here.partenza_teorica || cur.here.programmata)
    return {
      kind: 'between', km, prof, dilation, speedAt, now: speedAt(cur.p), lo: Math.min(lo, hi), hi: Math.max(lo, hi),
      peak: prof.peakKmh / dilation, mean: (km / total) * 3600, remainingKm: km * (1 - cur.p),
      tripMin: total / 60, schedMin: schedMin / 60000, kinMin: prof.minutes
    }
  }
  if ((cur.kind === 'station' || cur.kind === 'waiting') && cur.here) {
    const arrMs = cur.here.arrivoReale
    const sched = Math.max(0, ((cur.here.partenza_teorica || cur.here.programmata) - (cur.here.arrivo_teorico || cur.here.programmata)) / 60000)
    const exp = dwellExpected(sched, cls)
    const elapsed = arrMs ? Math.max(0, (now - arrMs) / 1000) : null
    const nextKm = segmentKm(stops, stops.indexOf(cur.here))
    return {
      kind: 'station', sched, exp, elapsed, leaveMs: cur.target, nextKm,
      nextProfile: nextKm ? motionProfile(nextKm, cls) : null, atOrigin: !arrMs
    }
  }
  return { kind: cur.kind }
}

function nerdTrackKin(d, cur, now) {
  dwellCursors = []
  const k = kinematics(d, cur, now)
  const panel = el('div', ['nerd-panel'])
  const head = el('div', ['nerd-panel-head'])
  const stops = d.fermate || []
  const cls = trainClass(d)
  head.append(el('span', [], k.kind === 'station' ? 'time in station' : 'on the segment: now vs timetable'), el('span', [], k.kind === 'between' && k.km ? `${k.km.toFixed(1)} km` : ''))
  panel.append(head)
  const VW = chartWidth()
  const LEFT = 150
  const RIGHT = 12
  const TOP = 12
  const H = 150
  // A 1D train: the marker stays in place, the axis (the stops) slides under it. It says whether the train
  // is in a station, and when the stops start and end.
  const drawDwell = g => {
    const SPAN = 10 * 60000
    const BEFORE = NOW_FRAC * SPAN // "now" sits at the same place in every chart of the page
    const Hs = 74
    const svg = svgChart(Hs + 34, 'The train as a marker on a time axis that slides: stops come towards it', VW)
    const plotW = VW - LEFT - RIGHT
    const bar = 24
    const bg = svgEl('g', {})
    svg.append(svgEl('rect', { x: LEFT, y: TOP + 14, width: plotW, height: bar, class: 'tk-dwell-track' }), bg)
    const markX = LEFT + (BEFORE / SPAN) * plotW
    const mark = svgEl('line', { x1: markX, x2: markX, y1: TOP + 4, y2: TOP + 14 + bar + 8, class: 'tk-dwell-cursor' })
    const dot = svgEl('circle', { cx: markX, cy: TOP + 4, r: 4, class: 'tk-dwell-cursor-dot' })
    const state = svgEl('text', { x: markX, y: TOP - 2, class: 'tk-dwell-state', 'text-anchor': 'middle' }, '')
    svg.append(mark, dot, state)
    const paint = nowMs => {
      const t0 = nowMs - BEFORE
      const xOf = t => LEFT + ((t - t0) / SPAN) * plotW
      const kids = []
      // a tick every minute, labelled with the clock
      for (let t = Math.ceil(t0 / 60000) * 60000; t <= t0 + SPAN; t += 60000) {
        kids.push(svgEl('line', { x1: xOf(t), x2: xOf(t), y1: TOP + 14 + bar, y2: TOP + 14 + bar + 4, class: 'tl-grid' }))
        kids.push(svgEl('text', { x: xOf(t), y: TOP + 14 + bar + 16, class: 'tl-label', 'text-anchor': 'middle' }, formatEpochHHMM(t)))
      }
      let here = false
      g.blocks.forEach(b => {
        const x1 = Math.max(LEFT, xOf(b.arr))
        const x2 = Math.min(LEFT + plotW, xOf(Math.max(b.dep, b.arr + 20000)))
        if (nowMs >= b.arr && nowMs <= Math.max(b.dep, b.arr + 20000) && b.kind !== 'past') here = true
        if (x2 > LEFT && x1 < LEFT + plotW) {
          const cls = b.kind === 'past' ? 'tk-dwell-block is-past' : 'tk-dwell-block'
          kids.push(svgEl('rect', { x: x1, y: TOP + 14, width: Math.max(2, x2 - x1), height: bar, class: cls }))
          if (b.lo) {
            const rx1 = Math.max(LEFT, xOf(b.lo))
            const rx2 = Math.min(LEFT + plotW, xOf(b.hi))
            if (rx2 > rx1) kids.push(svgEl('rect', { x: rx1, y: TOP + 14, width: rx2 - rx1, height: bar, class: 'tk-dwell-range' }))
          }
          if (b.sched && xOf(b.sched) >= LEFT && xOf(b.sched) <= LEFT + plotW) kids.push(svgEl('line', { x1: xOf(b.sched), x2: xOf(b.sched), y1: TOP + 14 + bar - 2, y2: TOP + 14 + bar + 6, class: 'tk-plot-pred' }))
          const label = svgEl('text', { x: Math.min(Math.max((x1 + x2) / 2, LEFT + 30), LEFT + plotW - 30), y: TOP + 14 + bar + 30, class: 'tl-label', 'text-anchor': 'middle' }, b.name.length > 24 ? `${b.name.slice(0, 23)}…` : b.name)
          kids.push(label)
        } else if (b.kind === 'next' && x1 >= LEFT + plotW) {
          kids.push(svgEl('text', { x: LEFT + plotW - 4, y: TOP + 14 + bar / 2 + 4, class: 'tl-label', 'text-anchor': 'end' }, `${b.name} in ${clockLeft(b.arr, nowMs)} →`))
        }
      })
      bg.replaceChildren(...kids)
      state.textContent = here ? 'IN STATION' : 'BETWEEN STATIONS'
      state.setAttribute('class', here ? 'tk-dwell-state is-here' : 'tk-dwell-state')
    }
    paint(now)
    dwellCursors.push(paint)
    panel.append(svg)
    const left = g.leaveMs ? (g.leaveMs - now) / 1000 : null
    const text = [
      g.upcoming ? `next stop, ${g.name}: not there yet` : g.atOrigin ? 'at its origin: departs on the timetable plus the announced delay' : `in station ${Math.floor(g.elapsed / 60)} min ${String(Math.floor(g.elapsed % 60)).padStart(2, '0')} s`,
      `stop expected ${g.exp.mid.toFixed(1)} min (typically ${g.exp.lo.toFixed(1)}–${g.exp.hi.toFixed(1)}) for ${g.sched.toFixed(1)} scheduled`,
      left === null ? '' : left > 0 ? `leaves in ~${clockLeft(g.leaveMs, now)}` : 'should be leaving now',
      g.nextProfile ? `next: ${g.nextKm.toFixed(1)} km, ${g.nextProfile.cruises ? `cruise ${Math.round(g.nextProfile.peakKmh)} km/h` : `peak ${Math.round(g.nextProfile.peakKmh)} km/h`} (~${g.nextProfile.minutes.toFixed(1)} min)` : ''
    ].filter(Boolean).join(' · ')
    panel.append(el('p', ['nerd-dim', 'tk-kin-note'], text))
  }
  if (k.kind === 'between' && k.km) {
    // the segment as a 1D rail: the train stays at "now" (same place as in the other charts), the rail slides
    const plotW1 = VW - LEFT - RIGHT
    const xNow = LEFT + NOW_FRAC * plotW1
    const posKm = k.km * cur.p
    const xOfKm = km => xNow + ((km - posKm) / winKm) * plotW1
    const sch = Math.max(60000, (cur.next.arrivo_teorico || cur.next.programmata) - (cur.here.partenza_teorica || cur.here.programmata))
    const uSched = Math.min(1, Math.max(0, (now - (cur.here.partenza_teorica || cur.here.programmata)) / sch))
    const fracOf = u => k.prof.at(u * k.prof.total).x / (k.km * 1000)
    const phaseOf = f => k.prof.timeAt(f) / k.prof.total
    const pSched = fracOf(uSched)
    const gapKm = (pSched - cur.p) * k.km
    // the window holds both trains: the real one stays at "now", the timetable one is ahead (30 % of the width) or behind (70 %)
    const winKm = Math.max(1.5, gapKm >= 0 ? gapKm / 0.2 : -gapKm / 0.6)
    // the delay the position implies: now minus the instant the timetable has the train there
    const schedAtPos = (cur.here.partenza_teorica || cur.here.programmata) + phaseOf(cur.p) * sch
    const gapMin = (now - schedAtPos) / 60000
    const Hl = 126
    const svg = svgChart(Hl, 'The train on the segment, now and as the timetable has it', VW)
    const yLine = 50
    const clampX = x => Math.min(LEFT + plotW1, Math.max(LEFT, x))
    svg.append(svgEl('line', { x1: clampX(xOfKm(0)), x2: clampX(xOfKm(k.km)), y1: yLine, y2: yLine, class: 'tk-1d-rail' }))
    const step = winKm > 12 ? 5 : winKm > 5 ? 2 : 1
    for (let km = Math.ceil((posKm - 0.7 * winKm) / step) * step; km <= posKm + 0.3 * winKm; km += step) {
      if (km < 0 || km > k.km) continue
      svg.append(svgEl('line', { x1: xOfKm(km), x2: xOfKm(km), y1: yLine - 4, y2: yLine + 4, class: 'tl-grid' }))
      svg.append(svgEl('text', { x: xOfKm(km), y: yLine + 20, class: 'tl-label', 'text-anchor': 'middle' }, `${km} km`))
    }
    // the two stations: where they are when in view, otherwise an arrow with the distance
    const endLabel = (km, name, right) => {
      const x = xOfKm(km)
      if (x >= LEFT && x <= LEFT + plotW1) {
        svg.append(svgEl('line', { x1: x, x2: x, y1: yLine - 12, y2: yLine + 12, class: 'tk-1d-station' }))
        svg.append(svgEl('text', { x, y: yLine + 52, class: 'tl-label', 'text-anchor': 'middle' }, name.slice(0, 26)))
      }
    }
    endLabel(0, cur.here.stazione.toLowerCase(), false)
    endLabel(k.km, cur.next.stazione.toLowerCase(), true)
    // +-2 sigma around the estimate
    const sg = cur.kal && Number.isFinite(cur.kal.sigma) ? cur.kal.sigma : 0
    svg.append(svgEl('rect', { x: clampX(xOfKm(posKm - 2 * sg * k.km)), y: yLine - 9, width: Math.max(2, clampX(xOfKm(posKm + 2 * sg * k.km)) - clampX(xOfKm(posKm - 2 * sg * k.km))), height: 18, rx: 4, class: 'tk-kin-sigma' }))
    // the real detections inside the segment
    trackHist.detections.filter(m => m.s > stops.indexOf(cur.here) && m.s < stops.indexOf(cur.here) + 1).forEach(m => {
      const x = xOfKm((m.s - stops.indexOf(cur.here)) * k.km)
      if (x >= LEFT && x <= LEFT + plotW1) svg.append(svgEl('path', { d: `M${x},${yLine + 7} l-4,7 h8 z`, class: 'tk-1d-det' }))
    })
    // the timetable ghost, and the gap between the two
    const xSched = xOfKm(pSched * k.km)
    const gapY = yLine - 20
    if (Math.abs(xSched - xNow) > 12) {
      svg.append(svgEl('line', { x1: xNow, x2: xSched, y1: gapY, y2: gapY, class: 'tk-1d-gap' }))
      ;[xNow, xSched].forEach(x => svg.append(svgEl('line', { x1: x, x2: x, y1: gapY - 4, y2: gapY + 4, class: 'tk-1d-gap' })))
      svg.append(svgEl('text', { x: (xNow + xSched) / 2, y: gapY - 6, class: 'tl-label', 'text-anchor': 'middle' }, `${Math.abs(gapKm).toFixed(1)} km · ${Math.abs(gapMin).toFixed(1)} min`))
    }
    svg.append(svgEl('circle', { cx: xSched, cy: yLine, r: 7, class: 'tk-1d-sched' }))
    svg.append(svgEl('text', { x: xSched, y: yLine + 36, class: 'tl-label', 'text-anchor': 'middle' }, 'timetable'))
    svg.append(svgEl('circle', { cx: xNow, cy: yLine, r: 7, class: 'tk-kin-dot' }))
    svg.append(svgEl('text', { x: xNow, y: yLine + 36 + (Math.abs(xNow - xSched) < 70 ? 12 : 0), class: 'tk-dwell-state is-here', 'text-anchor': 'middle' }, 'NOW'))
    const verdict = Math.abs(gapMin) < 0.5 ? 'on time' : gapMin > 0 ? `${gapMin.toFixed(1)} min late · ${Math.abs(gapKm).toFixed(2)} km behind the timetable` : `${(-gapMin).toFixed(1)} min early · ${Math.abs(gapKm).toFixed(2)} km ahead of the timetable`
    svg.append(svgEl('text', { x: LEFT, y: Hl - 4, class: 'tl-label' }, verdict))
    panel.append(svg)
    panel.append(el('p', ['nerd-dim', 'tk-kin-note'], [
      `${cur.here.stazione.toLowerCase()} → ${cur.next.stazione.toLowerCase()}`,
      `${k.prof.cruises ? `cruising at ${Math.round(k.peak)} km/h after ${Math.round(k.prof.tAcc)} s` : `too short to cruise: peaks at ${Math.round(k.peak)} km/h`}`,
      `now ~${Math.round(k.now)} km/h (${Math.round(k.lo)}–${Math.round(k.hi)}) · ${k.remainingKm.toFixed(1)} km to go`,
      `trip ${k.tripMin.toFixed(1)} min: timetable ${k.schedMin.toFixed(1)}, kinematic ${k.kinMin.toFixed(1)}`
    ].join(' · ')))
    // the stops around the train, on the sliding axis
    const nextIdx = stops.indexOf(cur.next)
    if (nextIdx < stops.length - 1) {
      const pred = predOf(d, now)
      const np = pred.get(nextIdx)
      const sched = Math.max(0, ((cur.next.partenza_teorica || cur.next.programmata) - (cur.next.arrivo_teorico || cur.next.programmata)) / 60000)
      const exp = dwellExpected(sched, cls)
      const blocks = [{ name: cur.here.stazione.toLowerCase(), kind: 'past', arr: cur.here.arrivoReale || cur.since, dep: cur.since }]
      blocks.push({ name: cur.next.stazione.toLowerCase(), kind: 'next', arr: cur.eta, dep: np ? np.depMs : cur.eta + exp.mid * 60000, lo: cur.eta + exp.lo * 60000, hi: cur.eta + exp.hi * 60000, sched: cur.next.partenza_teorica || cur.next.programmata })
      const sub = el('div', ['nerd-panel-head', 'tk-kin-sub'])
      sub.append(el('span', [], 'time in station · the train stays, the axis moves'))
      panel.append(sub)
      drawDwell({ sched, exp, elapsed: null, leaveMs: np ? np.depMs : null, upcoming: true, name: cur.next.stazione.toLowerCase(), nextKm: null, nextProfile: null, blocks })
    }
  } else if (k.kind === 'station') {
    const hereIdx = stops.indexOf(cur.here)
    const pred = predOf(d, now)
    const arr = cur.here.arrivoReale || (cur.target - k.exp.mid * 60000)
    const blocks = [{ name: cur.here.stazione.toLowerCase(), kind: 'here', arr, dep: cur.target, lo: arr + k.exp.lo * 60000, hi: arr + k.exp.hi * 60000, sched: cur.here.partenza_teorica || cur.here.programmata }]
    const np = pred.get(hereIdx + 1)
    const nextStop = stops[hereIdx + 1]
    if (np && nextStop && hereIdx + 1 < stops.length - 1) {
      const sched = Math.max(0, ((nextStop.partenza_teorica || nextStop.programmata) - (nextStop.arrivo_teorico || nextStop.programmata)) / 60000)
      const exp = dwellExpected(sched, cls)
      blocks.push({ name: nextStop.stazione.toLowerCase(), kind: 'next', arr: np.arrMs, dep: np.depMs, lo: np.arrMs + exp.lo * 60000, hi: np.arrMs + exp.hi * 60000, sched: nextStop.partenza_teorica || nextStop.programmata })
    } else if (np && nextStop) blocks.push({ name: nextStop.stazione.toLowerCase(), kind: 'next', arr: np.arrMs, dep: np.arrMs })
    drawDwell(Object.assign({ blocks }, k))
  } else {
    panel.append(el('p', ['nerd-dim'], 'nothing to estimate: the train is not running'))
  }

  return panel
}

// Live dashboard at the top of the nerd view: refreshed every second from the model, without redrawing the page.
function dashboardTiles(d, now) {
  const cur = trackingModel(d, now)
  const k = kinematics(d, cur, now)
  const tiles = []
  if (cur.kind === 'between' && k.km) {
    const t = k.prof.timeAt(cur.p)
    const phase = t < k.prof.tAcc ? 'accelerating' : t <= k.prof.tAcc + k.prof.tCruise ? 'cruising' : 'braking'
    tiles.push(
      { name: 'speed now', value: `${Math.round(k.now)}`, unit: 'km/h', sub: `${Math.round(k.lo)}–${Math.round(k.hi)} · peak ${Math.round(k.peak)}`, bar: k.now / Math.max(1, k.peak) },
      { name: 'phase', value: phase, sub: `${k.prof.cruises ? `cruise after ${Math.round(k.prof.tAcc)} s` : 'short hop, no cruise'}` },
      { name: 'progress', value: `${(k.km * cur.p).toFixed(1)}`, unit: `/ ${k.km.toFixed(1)} km`, sub: `${Math.round(cur.p * 100)} % · ${k.remainingKm.toFixed(1)} km to go`, bar: cur.p },
      { name: `next · ${cur.next.stazione.toLowerCase()}`, value: clockLeft(cur.eta, now), sub: `${formatEpochHHMM(cur.eta)} · ±${cur.kal && cur.kal.sigmaMin !== null ? cur.kal.sigmaMin.toFixed(1) : '?'} min` }
    )
  } else if (k.kind === 'station') {
    const left = k.leaveMs ? (k.leaveMs - now) / 1000 : null
    tiles.push(
      { name: 'in station', value: k.elapsed === null ? '–' : `${Math.floor(k.elapsed / 60)}:${String(Math.floor(k.elapsed % 60)).padStart(2, '0')}`, sub: `expected ${k.exp.mid.toFixed(1)} min · timetable ${k.sched.toFixed(1)}`, bar: k.elapsed === null ? 0 : k.elapsed / 60 / Math.max(0.5, k.exp.mid) },
      { name: 'leaves', value: left === null ? '–' : left > 0 ? clockLeft(k.leaveMs, now) : 'now', sub: k.leaveMs ? formatEpochHHMM(k.leaveMs) : '' },
      { name: 'next segment', value: k.nextKm ? k.nextKm.toFixed(1) : '–', unit: 'km', sub: k.nextProfile ? `~${k.nextProfile.minutes.toFixed(1)} min · peak ${Math.round(k.nextProfile.peakKmh)} km/h` : 'needs the station coordinates' }
    )
  } else {
    tiles.push({ name: 'status', value: cur.kind, sub: '' })
  }
  tiles.push({ name: 'delay', value: `${(d.ritardo || 0) > 0 ? '+' : ''}${d.ritardo || 0}`, unit: 'min', sub: `model ${modelOn() ? 'on' : 'off (raw)'}` })
  return tiles
}

let dashboardEls = null
let dwellCursors = [] // moves the cursors of the time-in-station gauges
function nerdDashboard(d) {
  const box = el('div', ['kin-dash'])
  dashboardEls = { box, tiles: [] }
  updateDashboard(d)
  return box
}

function updateDashboard(d) {
  if (!dashboardEls || !dashboardEls.box.isConnected) return
  dwellCursors.forEach(fn => fn(Date.now()))
  const tiles = dashboardTiles(d, Date.now())
  const { box } = dashboardEls
  if (box.children.length !== tiles.length) {
    box.replaceChildren(...tiles.map(() => {
      const t = el('div', ['kin-tile'])
      t.append(el('div', ['stat-name']), el('div', ['kin-value']), el('div', ['kin-bar']), el('div', ['stat-sub']))
      return t
    }))
  }
  tiles.forEach((t, i) => {
    const node = box.children[i]
    node.children[0].textContent = t.name
    node.children[1].replaceChildren(document.createTextNode(t.value), ...(t.unit ? [el('small', [], ` ${t.unit}`)] : []))
    node.children[2].hidden = t.bar === undefined
    node.children[2].style.setProperty('--fill', `${Math.round(Math.min(1, Math.max(0, t.bar || 0)) * 100)}%`)
    node.children[3].textContent = t.sub
  })
}

function kinTile(d, cur, now) {
  const k = kinematics(d, cur, now)
  if (k.kind === 'between' && k.km) return statTile('speed now', `~${Math.round(k.now)}`, `km/h · mean ${Math.round(k.mean)} · peak ${Math.round(k.peak)}`)
  if (k.kind === 'station') {
    const left = k.leaveMs ? Math.round((k.leaveMs - now) / 1000) : null
    return statTile('in station', k.elapsed === null ? '–' : `${Math.floor(k.elapsed / 60)}:${String(Math.floor(k.elapsed % 60)).padStart(2, '0')}`, left === null ? '' : left > 0 ? `leaves in ~${Math.max(1, Math.round(left / 6) / 10)} min · expected ${k.exp.mid.toFixed(1)}` : `expected ${k.exp.mid.toFixed(1)} min · leaving now`)
  }
  return statTile('speed', '–', cur.kind === 'between' ? 'needs the station coordinates' : '')
}

// Delay at each stop ahead, three ways: the timetable (no delay), "raw" (the announced delay held) and "model".
function nerdTrackBars(d, cur, now) {
  const panel = el('div', ['nerd-panel'])
  const head = el('div', ['nerd-panel-head'])
  head.append(el('span', [], 'delay by stop · timetable / raw / model'), el('span', [], 'minutes'))
  panel.append(head)
  const stops = d.fermate || []
  const first = stops.reduce((last, f, i) => (f.actualFermataType === 1 ? i : last), -1) + 1
  const idx = []
  for (let i = Math.max(first, 1); i < stops.length && idx.length < 8; i++) idx.push(i)
  if (!idx.length || cur.kind === 'arrived' || cur.kind === 'cancelled') {
    panel.append(el('p', ['nerd-dim'], 'no stop ahead'))
    return panel
  }
  const raw = withTimesMode('raw', () => predOf(d, now))
  const mod = withTimesMode('model', () => predOf(d, now))
  const rows = idx.map(i => ({ name: stops[i].stazione.toLowerCase(), raw: (raw.get(i) || {}).arrDelay, model: (mod.get(i) || {}).arrDelay }))
  const vals = rows.flatMap(r => [r.raw, r.model]).filter(Number.isFinite)
  const W = chartWidth()
  const LEFT = 150
  const RIGHT = 40
  const TOP = 8
  const group = 34
  const H = TOP + rows.length * group + 22
  const lo = Math.min(0, Math.floor(Math.min(...vals)))
  const hi = Math.max(3, Math.ceil(Math.max(...vals)))
  const xOf = v => LEFT + ((v - lo) / (hi - lo)) * (W - LEFT - RIGHT)
  const svg = svgChart(H, 'Predicted delay at each stop ahead: timetable, raw and model', W)
  const step = hi - lo > 20 ? 10 : hi - lo > 8 ? 5 : 2
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    svg.append(svgEl('line', { x1: xOf(v), x2: xOf(v), y1: TOP, y2: H - 18, class: 'tl-vgrid' }))
    svg.append(svgEl('text', { x: xOf(v), y: H - 4, class: 'tl-label', 'text-anchor': 'middle' }, `${v > 0 ? '+' : ''}${v}`))
  }
  rows.forEach((r, i) => {
    const y = TOP + i * group
    svg.append(svgEl('text', { x: LEFT - 8, y: y + 17, class: 'tl-label', 'text-anchor': 'end' }, r.name.length > 20 ? `${r.name.slice(0, 19)}…` : r.name))
    ;[['timetable', 0, 'tk-bar-sched'], ['raw', r.raw, 'tk-bar-raw'], ['model', r.model, 'tk-bar-model']].forEach(([label, v, cls], k) => {
      if (!Number.isFinite(v)) return
      const x0 = xOf(0)
      const x1 = xOf(v)
      const bar = svgEl('rect', { x: Math.min(x0, x1), y: y + 3 + k * 9, width: Math.max(2, Math.abs(x1 - x0)), height: 7, rx: 1.5, class: cls })
      bar.append(svgEl('title', {}, `${label}: ${v > 0 ? '+' : ''}${v.toFixed(1)} min`))
      svg.append(bar)
      if (label !== 'timetable') svg.append(svgEl('text', { x: Math.max(x0, x1) + 4, y: y + 10 + k * 9, class: 'tk-axis-scale' }, `${v > 0 ? '+' : ''}${v.toFixed(1)}`))
    })
  })
  svg.append(svgEl('line', { x1: xOf(0), x2: xOf(0), y1: TOP, y2: H - 18, class: 'tl-grid' }))
  panel.append(svg)
  const legend = el('p', ['nerd-dim', 'tk-plot-legend'])
  const item = (cls, text) => { const k = el('span', ['tk-plot-key']); k.append(el('span', [cls]), text); return k }
  legend.append(item('k-bar-sched', 'timetable'), item('k-bar-raw', 'raw (announced delay held)'), item('k-bar-model', 'model'))
  panel.append(legend)
  return panel
}

function renderTrackNerd(d) {
  const now = Date.now()
  const wrap = el('div', ['nerd-wrap'])
  const category = (d.categoria || d.categoriaDescrizione || '').trim()
  wrap.append(trackModeBar(), el('p', ['nerd-prompt'], `$ treno --track ${`${category} ${d.numeroTreno}`.trim().replace(/\s+/g, '_')} --plot position,delay`))

  const fixes = trackHist.fetches.filter(f => f.sBefore !== null).map(f => Math.abs(f.s - f.sBefore))
  const meanFix = fixes.length ? fixes.reduce((a, b) => a + b, 0) / fixes.length : 0
  const maxFix = fixes.length ? Math.max(...fixes) : 0
  const rel = d.oraUltimoRilevamento ? trackReliability(d.oraUltimoRilevamento, now) : null
  const cur = trackingModel(d, now)
  const unc = cur.kind === 'between' && cur.kal && cur.kal.sigmaMin !== null ? cur.kal.sigmaMin.toFixed(1) : null
  const grid = el('div', ['stat-grid'])
  grid.append(
    statTile('refreshes', String(trackHist.fetches.length), `${trackHist.ticks.length} position samples`),
    statTile('uncertainty', unc ? `±${unc}m` : '–', unc ? `1σ on the next arrival · ${cur.kal.sigmaKm.toFixed(2)} km` : 'in a station'),
    statTile('last detection', rel ? rel.text : '–', d.oraUltimoRilevamento ? `${Math.max(0, Math.round((now - d.oraUltimoRilevamento) / 60000))} min ago` : '')
  )
  wrap.append(nerdDashboard(d), grid, nerdTrackKin(d, cur, now), nerdTrackBars(d, cur, now), nerdTrackChart(d), nerdTrackDelay(d))
  $('trainInfo').replaceChildren(wrap)
}

// Live | Nerd, at the top of the Tracking view.
function trackModeBar() {
  const bar = el('div', ['tk-modes'])
  ;[[false, 'Live'], [true, 'Nerd']].forEach(([nerd, text]) => {
    const b = el('button', ['tk-mode', nerdTrack === nerd ? 'is-active' : ''], text)
    b.type = 'button'
    b.addEventListener('click', () => setNerdTrack(nerd))
    bar.append(b)
  })
  return bar
}

async function setNerdTrack(on) {
  nerdTrack = on
  const url = new URLSearchParams(window.location.search)
  if (on) url.set('nerd', '1')
  else url.delete('nerd')
  window.history.replaceState(null, '', `${window.location.pathname}?${url}`)
  if (trainDetail) renderTrainPage(trainDetail)
}

// =======================
// Kalman filter for the position along the current segment
// =======================
// State: p (fraction of the segment covered, 0..1) and r (fraction per minute); with the station coordinates
// the segment length gives km and km/h, and detections at stations the train only passes become measurements.
// The timetable gives the prior speed; every refresh gives a position implied by the announced arrival
// time (noise grows with the age of the last detection); the real departure time pins p = 0 at its
// real instant, even when it is only learnt later. Everything is replayed from the departure, so a
// late-arriving measurement is applied where it belongs.
// Dead reckoning from the last real data. Nothing here depends on an earlier prediction: the position is the
// speed profile between the two stations (accelerate, cruise, brake, see js/modules/model.js), started from the
// real departure and, when a train went through a station without stopping, re-timed so that it passes
// through that real detection. The doubt only grows with the time since the nearest real datum, and drops
// when a new one arrives. The announced delays are predictions, not data: they are not used here.
const KALMAN = {
  etaSigmaMin: 1.8, // spread of the arrival time (robust spread of the model, ~1.5 min, a bit more for the heavy tails)
  floorMin: 0.3, // timing doubt right on a real datum
  detectionKm: 0.4, // a detection point is known to about 400 m
  departureKm: 0.1
}
const KALMAN_MINUTE = 60000

function kalmanRun(d, here, next, t0, now, stepMs = 0) {
  const stops = d.fermate || []
  const hereI = stops.indexOf(here)
  const schedArr = next.arrivo_teorico || next.programmata
  const schedDep = here.partenza_teorica || here.programmata
  const schedMin = Math.max(1, (schedArr - schedDep) / KALMAN_MINUTE)
  const realKm = segmentKm(stops, hereI)
  const L = realKm || schedMin // without coordinates: 1 pseudo-km per minute
  const cls = trainClass(d)
  const prof = realKm ? motionProfile(realKm, cls) : null
  const fracAt = u => (prof ? prof.at(Math.min(1, Math.max(0, u)) * prof.total).x / (realKm * 1000) : Math.min(1, Math.max(0, u)))
  const phaseOf = f => (prof ? prof.timeAt(f) / prof.total : f)

  // the real data inside the segment: the departure and the stations passed without stopping
  const anchors = [{ t: t0, x: 0, sigmaKm: KALMAN.departureKm }]
  trackHist.detections.filter(m => m.t > t0 && m.s > hereI && m.s < hereI + 1).sort((a, b) => a.t - b.t)
    .forEach(m => anchors.push({ t: m.t, x: (m.s - hereI) * L, sigmaKm: KALMAN.detectionKm }))
  const etaPrior = predictArrival(t0, schedDep, schedArr, realKm, cls)

  // the trip duration, given the anchors known at `until`: the model's arrival, or the one that makes the
  // train pass through the latest detection
  const tripMs = until => {
    const known = anchors.filter(a => a.t <= until && a.t > t0)
    const last = known[known.length - 1]
    if (last) {
      const u = phaseOf(Math.min(0.98, Math.max(0.02, last.x / L)))
      if (u > 0.02) return Math.max(60000, (last.t - t0) / u)
    }
    return Math.max(60000, etaPrior - t0)
  }
  const meanKmMin = ms => L / Math.max(1, ms / KALMAN_MINUTE)
  const sigmaEnd = Math.hypot(KALMAN.etaSigmaMin, 0.09 * schedMin)
  // position and doubt at an instant; `causal`: only the data known by then
  const at = (t, causal = false, tripFor = causal ? t : now) => {
    const trip = tripMs(tripFor)
    const p = Math.min(0.98, fracAt((t - t0) / trip))
    const pool = causal ? anchors.filter(a => a.t <= t) : anchors
    const near = pool.reduce((best, a) => (Math.abs(a.t - t) < Math.abs(best.t - t) ? a : best), pool[0])
    const ageMin = Math.abs(t - near.t) / KALMAN_MINUTE
    const sigmaMin = Math.hypot(KALMAN.floorMin, (sigmaEnd - KALMAN.floorMin) * Math.sqrt(ageMin / (trip / KALMAN_MINUTE)))
    const sigmaKm = Math.hypot(near.sigmaKm, meanKmMin(trip) * sigmaMin)
    return { p, sigmaKm, sigma: sigmaKm / L, sigmaMin, trip }
  }

  const samples = []
  if (stepMs) {
    const times = new Set([t0, now])
    anchors.forEach(a => { if (a.t <= now) times.add(a.t) })
    for (let g = t0 + stepMs; g < now; g += stepMs) times.add(g)
    ;[...times].sort((x, y) => x - y).forEach(t => {
      const r = at(t)
      samples.push({ t, p: r.p, sigma: r.sigma, pf: at(t, true).p })
    })
  }
  const r = at(now)
  const dt = 5000
  const v = Math.max(0, (at(now + dt).p - r.p) * L / (dt / KALMAN_MINUTE)) // km/min, slope of the profile
  const arrivalMs = t0 + r.trip
  return {
    p: r.p, x: r.p * L, v, L, km: realKm, sigma: r.sigma, sigmaKm: r.sigmaKm, at,
    sigmaMin: r.sigmaKm / Math.max(1e-3, meanKmMin(r.trip)), // the same doubt, as a time
    minToGo: Math.max(0, (arrivalMs - now) / KALMAN_MINUTE),
    speedKmh: realKm ? v * 60 : null, samples, tseg: schedMin
  }
}

// Where the estimate expects the train until `untilMs`, and how unsure it is (no new datum).
function kalmanForecast(state, fromMs, untilMs, stepMs = 15000) {
  const out = []
  for (let t = fromMs; t <= untilMs + stepMs; t += stepMs) {
    const r = state.at(t)
    out.push({ t, p: Math.min(1, r.p), sigma: r.sigma })
  }
  return out
}

// =======================
// Tracking view: a live position, timetable-driven and corrected by the data
// =======================
let trackingMode = false
const trainRefreshMs = () => (trackingMode ? TRACKING_REFRESH_INTERVAL : REFRESH_REQUEST_INTERVAL)
let trackZoom = 'normal' // 'close' = 2 stops each side, spaced by travel time; 'normal' = a window; 'all' = every stop
let trainFetchedAt = 0
const live = { raf: 0, data: null, segKey: null, shown: 0, lastTs: 0, els: null, correction: null }

function stopTracking() {
  cancelAnimationFrame(live.raf)
  live.raf = 0
  live.els = null
}

// What the timetable and the last detections say about the train at time `now`.
function trackingModel(d, now) {
  const stops = d.fermate || []
  const delay = d.ritardo || 0
  const lastPassed = stops.reduce((last, f, i) => (f.actualFermataType === 1 ? i : last), -1)
  const extra = Math.max(delay, 0) * 60000
  const sched = (f, which) => (which === 'arr' ? f.arrivo_teorico || f.programmata : f.partenza_teorica || f.programmata)
  if (d.provvedimento === 1) return { kind: 'cancelled' }
  if (d.arrivato || lastPassed >= stops.length - 1) return { kind: 'arrived', last: stops[stops.length - 1] }
  const here = stops[Math.max(lastPassed, 0)]
  const next = stops[Math.max(lastPassed, 0) + 1]
  const pred = predOf(d, now)
  const nextIdx = Math.max(lastPassed, 0) + 1
  const eta = (pred.get(nextIdx) || {}).arrMs || sched(next, 'arr') + extra
  if (lastPassed < 0 || d.nonPartito) {
    return { kind: 'waiting', here, next, segKey: 'wait', p: 0, ghost: 0, target: pred.leaveMs || sched(here, 'dep') + extra, eta }
  }
  if (!here.partenzaReale) {
    // arrived and not left yet (or no departure time recorded): in the station
    return { kind: 'station', here, next, segKey: `s${lastPassed}`, p: 0, ghost: 0, target: pred.leaveMs || sched(here, 'dep') + extra, eta }
  }
  const t0 = here.partenzaReale
  const span = eta - t0
  const linear = span > 0 ? Math.min(0.97, Math.max(0, (now - t0) / span)) : 0
  const kal = kalmanRun(d, here, next, t0, now)
  const p = Number.isFinite(kal.p) ? Math.min(0.97, kal.p) : linear
  const schedSpan = sched(next, 'arr') - sched(here, 'dep')
  const ghost = schedSpan > 0 ? Math.min(1, Math.max(0, (now - sched(here, 'dep')) / schedSpan)) : 0
  return { kind: 'between', here, next, segKey: `b${lastPassed}`, p, sigma: kal.sigma, kal, km: kal.km, speedKmh: kal.speedKmh, ghost, target: eta, eta, since: t0 }
}

// "18 min 04 s", "1 h 14 min": a countdown that cannot be mistaken for a clock time
function clockLeft(ms, now) {
  const total = Math.max(0, Math.round((ms - now) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const sec = String(total % 60).padStart(2, '0')
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min ${sec} s`
}

function renderTracking(d) {
  const root = el('div', ['tv-wrap'])
  const category = (d.categoria || d.categoriaDescrizione || '').trim()
  const status = trainStatus(d)
  const delay = d.ritardo || 0
  const model = trackingModel(d, Date.now())
  live.data = d
  setTrainTitle(d)
  root.append(trackModeBar())

  const head = el('section', ['tv-card'])
  const top = el('div', ['tv-head'])
  top.append(el('span', ['train-badge'], `${category} ${d.numeroTreno}`.trim()), chip(label(status.key), status.tone))
  if (d.provvedimento !== 1 && delay !== 0) top.append(chip(delay > 0 ? `+${delay} min` : `${delay} min`, delay > 0 ? 'is-late' : 'is-early'))
  head.append(top)
  const route = el('h2', ['tv-route'])
  route.append(el('span', [], d.origine || '—'), icon('bi-arrow-right'), el('span', [], d.destinazione || '—'))
  head.append(route)
  root.append(head)

  if (model.kind === 'cancelled' || model.kind === 'arrived') {
    const done = el('section', ['tv-card', 'tk-card'])
    done.append(el('p', ['tk-state'], model.kind === 'cancelled' ? 'This train is cancelled.' : `Arrived at ${model.last.stazione}.`))
    root.append(done)
    $('trainInfo').replaceChildren(root)
    stopTracking()
    return
  }

  const card = el('section', ['tv-card', 'tk-card'])
  const els = {}
  els.state = el('p', ['tk-state'])
  const nextLine = el('div', ['tk-next'])
  els.label = el('span', ['tk-label'])
  els.name = el('span', ['tk-name'])
  els.eta = el('span', ['tk-eta'])
  nextLine.append(els.label, els.name, els.eta)
  els.count = el('div', ['tk-count'])

  els.motion = el('p', ['tk-motion'])
  els.trust = el('p', ['tk-trust'])
  els.sync = el('p', ['tk-sync'])
  card.append(els.state, nextLine, els.count, els.motion, els.trust, els.sync)
  root.append(card)

  // the line: a window of stops around the train (or all of them), the train sliding along it
  const stops = d.fermate || []
  const trackPred = predOf(d)
  const hereIdx = stops.indexOf(model.here)
  const from = trackZoom === 'all' ? 0 : Math.max(0, hereIdx - 2)
  const to = trackZoom === 'all' ? stops.length : Math.min(stops.length, hereIdx + (trackZoom === 'close' ? 3 : 8))
  const listCard = el('section', ['tv-card'])
  const listHead = el('div', ['tk-list-head'])
  listHead.append(el('h3', ['tv-section'], `Stops · ${stops.length}`))
  const zoom = el('div', ['tk-zoom'])
  zoom.setAttribute('role', 'group')
  zoom.setAttribute('aria-label', 'Zoom')
  ;[['close', 'Close'], ['normal', 'Normal'], ['all', 'All']].forEach(([key, text]) => {
    const b = el('button', ['tk-zoom-btn', trackZoom === key ? 'is-active' : ''], text)
    b.type = 'button'
    b.addEventListener('click', () => { trackZoom = key; renderTracking(d) })
    zoom.append(b)
  })
  listHead.append(zoom)
  listCard.append(listHead)
  // total scheduled minutes covered by the visible window (to scale the spacing)
  let windowMinutes = 0
  for (let i = from; i < to - 1; i++) {
    windowMinutes += ((stops[i + 1].arrivo_teorico || stops[i + 1].programmata) - (stops[i].partenza_teorica || stops[i].programmata)) / 60000
  }
  const line = el('div', ['tk-line'])
  els.rows = []
  stops.slice(from, to).forEach((f, k) => {
    const i = from + k
    const passed = f.actualFermataType === 1
    const at = (trackPred.get(i) || {}).arrMs || (f.arrivo_teorico || f.programmata) + Math.max(delay, 0) * 60000
    const row = el('div', ['tk-row', passed ? 'is-passed' : '', i === hereIdx + 1 ? 'is-next' : '', i === stops.length - 1 ? 'is-end' : ''])
    const cell = el('span', ['tk-up-count'])
    row.append(el('span', ['tk-row-dot']), el('span', ['tk-up-name'], f.stazione), el('span', ['tk-up-time'], formatEpochHHMM(passed ? (f.arrivoReale || f.partenzaReale || at) : at)), cell)
    row.dataset.at = String(at)
    row.dataset.passed = passed ? '1' : ''
    if (trackZoom === 'close' && stops[i + 1]) {
      // zoomed in: the gap between two stops follows the scheduled travel time, the whole line fitting about a screen
      const minutes = ((stops[i + 1].arrivo_teorico || stops[i + 1].programmata) - (f.partenza_teorica || f.programmata)) / 60000
      const px = Math.min(12, Math.max(1.5, 520 / Math.max(1, windowMinutes)))
      row.style.minHeight = `${Math.max(60, Math.round(minutes * px))}px`
    }
    line.append(row)
    els.rows.push({ f, i, row, cell })
  })
  els.hereIdx = hereIdx
  els.ghost = el('span', ['tk-ghost'])
  els.ghost.title = 'Where the timetable alone would put the train'
  els.dot = el('span', ['tk-dot'])
  els.dot.title = 'Estimated position, corrected by the latest data'
  line.append(els.ghost, els.dot)
  listCard.append(line)
  root.append(listCard)

  const legend = el('p', ['tk-legend'])
  const key = (cls, text) => { const k = el('span', ['tk-key']); k.append(el('span', [cls]), text); return k }
  legend.append(key('tk-key-dot', 'live estimate'), key('tk-key-ghost', 'timetable only'))
  root.append(legend)

  $('trainInfo').replaceChildren(root)
  live.els = els

  // servo: when the data moves the target, the dot slides to it instead of jumping
  if (live.segKey !== model.segKey) {
    live.segKey = model.segKey
    live.shown = 0
  } else if (live.lastFetch !== trainFetchedAt) {
    const jump = model.p - live.shown
    live.correction = { pct: Math.round(jump * 100), at: Date.now() }
  }
  live.lastFetch = trainFetchedAt
  cancelAnimationFrame(live.raf)
  live.lastTs = 0
  live.raf = requestAnimationFrame(tickTracking)
}

function tickTracking(ts) {
  const els = live.els
  if (!els || !live.data) return
  const now = Date.now()
  const d = live.data
  const model = trackingModel(d, now)
  if (model.kind !== 'between' && model.kind !== 'station' && model.kind !== 'waiting') return
  const dt = live.lastTs ? (ts - live.lastTs) / 1000 : 0
  live.lastTs = ts
  live.shown += (model.p - live.shown) * (1 - Math.exp(-dt / 2.5))

  // markers on the line: from the dot of the last stop to the dot of the next one
  const hereRow = els.rows.find(r => r.i === els.hereIdx)
  const nextRow = els.rows.find(r => r.i === els.hereIdx + 1)
  if (hereRow && nextRow) {
    const y = r => r.row.offsetTop + 11
    const place = (node, frac) => { node.style.top = `${y(hereRow) + frac * (y(nextRow) - y(hereRow))}px` }
    place(els.dot, live.shown)
    place(els.ghost, model.ghost)
  }
  els.label.textContent = 'Next stop'
  els.name.textContent = model.next.stazione
  els.eta.textContent = `~${formatEpochHHMM(model.eta)}`

  const ago = ms => {
    const m = Math.max(0, Math.round((now - ms) / 60000))
    return m < 1 ? 'less than a minute' : `${m} min`
  }
  let countdown
  if (model.kind === 'between') {
    countdown = model.eta - now
    els.state.textContent = `Between ${model.here.stazione.toLowerCase()} and ${model.next.stazione.toLowerCase()} · left ${ago(model.since)} ago`
    els.count.dataset.caption = 'to the next stop'
  } else if (model.kind === 'station') {
    countdown = model.target - now
    els.state.textContent = `In ${model.here.stazione.toLowerCase()}, leaves around ${formatEpochHHMM(model.target)}`
    els.count.dataset.caption = countdown > 0 ? 'before it leaves' : 'should be leaving'
  } else {
    countdown = model.target - now
    els.state.textContent = `Not departed yet from ${model.here.stazione.toLowerCase()}`
    els.count.dataset.caption = 'before departure'
  }
  if (model.kind === 'between' && model.km) {
    const toGo = (1 - Math.min(model.p, 0.97)) * model.km
    els.motion.textContent = `${toGo.toFixed(1)} km to ${model.next.stazione.toLowerCase()} of ${model.km.toFixed(1)} · about ${Math.round(model.speedKmh)} km/h`
  } else {
    els.motion.textContent = ''
  }
  els.count.textContent = countdown > 0 ? clockLeft(model.kind === 'between' ? model.eta : model.target, now) : 'due now'
  els.count.classList.toggle('is-late', countdown <= 0)
  if (model.kind === 'between') els.name.classList.toggle('is-overdue', countdown <= 0)

  if (d.oraUltimoRilevamento) {
    const rel = trackReliability(d.oraUltimoRilevamento, now)
    els.trust.textContent = `Position ${rel.text} · last detection ${ago(d.oraUltimoRilevamento)} ago at ${d.stazioneUltimoRilevamento || '—'}`
    els.trust.className = `tk-trust track-${rel.tier}`
  }
  const age = Math.round((now - trainFetchedAt) / 1000)
  const nextIn = Math.max(0, Math.round(trainRefreshMs() / 1000 - age))
  const c = live.correction
  els.sync.textContent = `Data refreshed ${age} s ago · next in ${nextIn} s${c && now - c.at < 15000 && Math.abs(c.pct) >= 2 ? ` · re-synced ${c.pct > 0 ? '+' : ''}${c.pct}% of the segment` : ''}`

  els.rows.forEach(({ row, cell }) => {
    if (row.dataset.passed) return
    const left = untilLabel(Number(row.dataset.at), now)
    cell.textContent = left === 'now' ? 'due' : left.replace(/^in /, '')
  })
  live.raf = requestAnimationFrame(tickTracking)
}

function setTrainTitle(d) {
  const category = (d.categoria || d.categoriaDescrizione || '').trim()
  document.title = `${category || 'Train'} ${d.numeroTreno} · Panel Treno`
  $('stationTitle').textContent = `${category || 'Train'} ${d.numeroTreno}`.trim()
}

function renderTrainPage(d) {
  document.body.classList.toggle('view-nerd', trackingMode && nerdTrack)
  if (trackingMode && nerdTrack) {
    stopTracking()
    setTrainTitle(d)
    return renderTrackNerd(d)
  }
  if (trackingMode) return renderTracking(d)
  stopTracking()
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

  const position = trainPosition(d, stops, lastPassed, delay, now)
  if (position) summary.append(positionEl(position, now, d.oraUltimoRilevamento, stops[lastPassed], stops[lastPassed + 1], delay))

  const facts = el('dl', ['tv-facts'])
  const addFact = (name, value, tone = '') => {
    if (!value) return
    const wrap = el('div', ['tv-fact'])
    wrap.append(el('dt', [], name), el('dd', [tone], value))
    facts.append(wrap)
  }
  const pred = predOf(d)
  const finalPred = pred.get(stops.length - 1)
  const finalMs = finalPred ? finalPred.arrMs : arrivalSched
  const eta = arrivalSched && delay > 0 && !d.arrivato && Math.round((finalMs - arrivalSched) / 60000) > 0 ? ` → ~${formatEpochHHMM(finalMs)}` : ''
  addFact('date', d.dataPartenzaTrenoAsDate)
  addFact('departs', formatEpochHHMM(departSched))
  addFact('arrives', arrivalSched ? `${formatEpochHHMM(arrivalSched)}${eta}` : null, eta ? 'is-late' : '')
  addFact('duration', durationLabel(departSched, arrivalSched))
  if (arrivalSched && !d.arrivato && d.provvedimento !== 1 && !d.nonPartito) addFact('arrival', untilLabel(finalMs, now))
  const next = stops[lastPassed + 1]
  if (next && !d.arrivato && !d.nonPartito && d.provvedimento !== 1) {
    const nextEta = (pred.get(lastPassed + 1) || {}).arrMs || (next.arrivo_teorico || next.programmata) + Math.max(delay, 0) * 60000
    addFact('next stop', `${next.stazione} · ${formatEpochHHMM(nextEta)} (${untilLabel(nextEta, now)})`)
  }
  if (d.oraUltimoRilevamento) {
    const age = trackedAgeLabel({ ultimoRilev: d.oraUltimoRilevamento, circolante: true })
    const rel = trackReliability(d.oraUltimoRilevamento, now)
    addFact('last seen', `${d.stazioneUltimoRilevamento || '—'} · ${formatEpochHHMM(d.oraUltimoRilevamento)}${age ? ` (${age} ago · ${rel.text})` : ''}`, d.arrivato ? '' : `track-${rel.tier}`)
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
  stops.forEach((f, i) => {
    line.append(trainStopEl(f, i, stops, d, lastPassed, pred))
    // stations the train went through without stopping (from the detections logged while this page was open)
    trackHist.detections.filter(x => Math.floor(x.s) === i).forEach(x => line.append(passEl(x)))
    // the train is between this stop and the next: say so on the line itself
    if (position && position.kind === 'between' && i === lastPassed) line.append(betweenEl(position, stops[i + 1], delay, now))
  })
  routeCard.append(line)
  root.append(routeCard)

  $('trainInfo').replaceChildren(root)
  setTrainTitle(d)
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
  await stationsReady
  const previous = trainDetail
  trainDetail = data
  trainFetchedAt = Date.now()
  recordDetection(data)
  recordFetch(previous, data)
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

// The official RFI board exists for most stations: when this one has an id, show the Mix / Viaggia / RFI switch.
let rfiPlaceId = null
let rfiReady = Promise.resolve()
function initSources() {
  rfiReady = loadRfiIds().then(ids => {
    rfiPlaceId = ids[stationID] || null
    if (!rfiPlaceId) {
      sourceMode = 'vt'
      return
    }
    initSourceSwitch(sourceMode, stationID, stationName)
    syncHeaderSpacerHeight()
  })
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
  $('text-search').title = 'Home: search a station or a train'
  $('text-search').setAttribute('aria-label', 'Home')
  $('trainShare').hidden = false
  $('trainShare').addEventListener('click', shareTrain)
  trackingMode = params.get('track') === '1'
  nerdTrack = params.get('nerd') === '1'
  loadStations()
  loadTrackHist()
  setInterval(recordTick, TRACK_TICK_MS)
  setInterval(() => { if (nerdTrack && trainDetail) updateDashboard(trainDetail) }, 1000)
  const trackBtn = $('trackToggle')
  trackBtn.hidden = false
  const applyTrackToggle = () => {
    $('trackToggleLabel').textContent = trackingMode ? 'Details' : 'Tracking'
    trackBtn.querySelector('i').className = `bi ${trackingMode ? 'bi-list-ul' : 'bi-broadcast'}`
    const url = new URLSearchParams(window.location.search)
    if (trackingMode) url.set('track', '1')
    else url.delete('track')
    window.history.replaceState(null, '', `${window.location.pathname}?${url}`)
  }
  applyTrackToggle()
  trackBtn.addEventListener('click', () => {
    trackingMode = !trackingMode
    applyTrackToggle()
    if (!trackingMode) document.body.classList.remove('view-nerd')
    if (trainDetail) renderTrainPage(trainDetail)
  })
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
  // each refresh is awaited before the next is scheduled, so a slow relay never stacks requests
  const loop = () => setTimeout(async () => { await loadTrainPage(); loop() }, trainRefreshMs())
  loop()
  setInterval(updateClock, CLOCK_INTERVAL)
  updateClock()
}

// =======================
// Init
// =======================
window.addEventListener('pageshow', e => { if (e.persisted) window.location.reload() })
window.addEventListener('resize', syncHeaderSpacerHeight)
// the header can change height by itself (title or labels wrapping once the data is loaded)
new ResizeObserver(syncHeaderSpacerHeight).observe(document.querySelector('.app-header'))

// raw / model: whether times ahead use the announced delay as it is, or the corrected model
function initTimesSwitch() {
  const box = document.getElementById('timesSwitch')
  if (!box) return
  const paint = () => box.querySelectorAll('button').forEach(b => b.classList.toggle('is-active', b.dataset.mode === timesMode))
  box.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    setTimesMode(b.dataset.mode)
    paint()
    if (trainDetail) renderTrainPage(trainDetail)
    else rerender()
  }))
  paint()
}

document.addEventListener('DOMContentLoaded', () => {
  loadStations() // distances feed the prediction model on every page
  initTimesSwitch()
  renderRequestStrip()
  if ((getParam('view') || '').toLowerCase() === 'train') {
    initTrainPage()
    return
  }
  // The search page is the home of the site: without a station there is nothing to show here.
  if (!getParam('stationID')) {
    window.location.replace('home.html')
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
  // "mix" and "compare" were the two halves of Global before they were merged into one view
  if (['global', 'mix', 'compare'].includes((getParam('source') || '').toLowerCase())) sourceMode = 'global'

  initSources()
  const searchLink = $('text-search')
  searchLink.title = 'Home: search a station or a train'
  searchLink.setAttribute('aria-label', 'Home')
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
