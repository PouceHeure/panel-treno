// =======================
// Constants
// =======================
const APP_VERSION = '1.1.0'
const REFRESH_REQUEST_INTERVAL = 30 * 1000 // ms
const CLOCK_INTERVAL = 10 * 1000 // ms
const TRAIN_MODE_KEY = 'ALL'
const GROUP_MODES = ['platform', 'destination', 'category', 'train']
const GROUP_ITEM_LIMIT = { platform: 3, destination: 3, category: 3, train: 20 }
const LOCALE = 'en-GB'

const LABELS = {
  serviceOFF: 'No departures',
  noMatch: 'No match for this filter',
  connecting: 'Connecting…',
  loadError: 'Could not load departures',
  retry: 'Retry',
  search: 'Search station',
  update: 'Updated',
  platform: 'Platform',
  platformUnknown: 'Platform not announced yet',
  onTime: 'On time',
  early: 'early',
  filter: 'Filter',
  filterPlaceholder: 'Filter…',
  filterHint: 'Separate several values with a comma, | or "or" (e.g. torino, milano)',
  nextDepartures: 'Next departures',
  destinationUnknown: 'Unknown destination',
  categoryUnknown: 'Other',
  groupByPlatform: 'By platform',
  groupByDestination: 'By destination',
  groupByCategory: 'By train type',
  groupByTrain: 'By next departures'
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

// Train category colors (Trenitalia-ish palette)
const CATEGORY_COLORS = {
  FR: '#c8102e', FA: '#c8102e', FB: '#c8102e', ES: '#c8102e',
  EC: '#2a62b5', EN: '#2a62b5',
  IC: '#1f7bd1', ICN: '#1f7bd1',
  RV: '#2e9e6a',
  REG: '#5b657a', R: '#5b657a'
}
const DEFAULT_CATEGORY_COLOR = '#5b657a'

// =======================
// State
// =======================
let stationID = 'S01700' // Default station: Milano Centrale
let stationName = null
let lastUpdateData = null
let groupByMode = 'platform'
let groupFilterText = ''

// =======================
// Helpers
// =======================
const label = key => LABELS[key]

function el(tag, classes = [], text) {
  const node = document.createElement(tag)
  if (classes.length) node.classList.add(...classes)
  if (text !== undefined) node.textContent = text
  return node
}
function icon(name) {
  return el('i', ['bi', name])
}
function $(id) {
  return document.getElementById(id)
}

function getParam(name) {
  return new URLSearchParams(window.location.search).get(name)
}

// Keep groupby/groupfilter in the URL (no reload) so a view can be bookmarked or shared.
function syncStateToURL() {
  const params = new URLSearchParams(window.location.search)
  params.set('groupby', groupByMode)
  if (groupFilterText) params.set('groupfilter', groupFilterText)
  else params.delete('groupfilter')
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
function realDepartureTime(train) {
  return train.orarioPartenza ? formatEpochHHMM(train.orarioPartenza + delayOf(train) * 60000) : null
}

function colorForCategory(cat) {
  return CATEGORY_COLORS[(cat || '').trim().toUpperCase()] || DEFAULT_CATEGORY_COLOR
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
  const live = train.binarioEffettivoPartenzaDescrizione
  const planned = train.binarioProgrammatoPartenzaDescrizione
  return { label: normalizePlatformLabel(live || planned), isLive: Boolean(live) }
}

// =======================
// Grouping & filtering
// =======================
function getGroupKey(train, mode) {
  if (mode === 'destination') return train.destinazione || label('destinationUnknown')
  if (mode === 'category') return (train.categoria || '').trim() || label('categoryUnknown')
  if (mode === 'train') return TRAIN_MODE_KEY
  return platformOf(train).label || label('platformUnknown')
}
function groupHeaderLabel(mode, key) {
  if (mode === 'platform') return key === label('platformUnknown') ? key : `${label('platform')} ${key}`
  if (mode === 'train') return label('nextDepartures')
  return key
}
function sortGroupKeys(mode, keys) {
  if (mode === 'train') return keys
  if (mode !== 'platform') return keys.sort((a, b) => a.localeCompare(b))
  return keys.sort((a, b) => {
    const na = parseInt(a, 10)
    const nb = parseInt(b, 10)
    if (isNaN(na) && isNaN(nb)) return a.localeCompare(b)
    if (isNaN(na)) return 1
    if (isNaN(nb)) return -1
    return na - nb
  })
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

// Returns [{ key, trains }] ready to render (grouped, sorted, filtered, limited).
function buildGroups(trainData) {
  const departures = trainData
    .filter(t => !t.nonPartito || t.orarioPartenza)
    .sort((a, b) => (a.orarioPartenza || 0) - (b.orarioPartenza || 0))

  const filterTerms = parseFilterTerms(groupFilterText)
  const groups = new Map()
  departures.forEach(train => {
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
// Rendering
// =======================
function renderMessage(iconName, text, withRetry = false) {
  const container = $('trainInfo')
  container.replaceChildren()
  const box = el('div', ['state-box'])
  box.append(icon(iconName), el('p', [], text))
  if (withRetry) {
    const btn = el('button', ['btn-retry'], label('retry'))
    btn.type = 'button'
    btn.addEventListener('click', () => {
      renderMessage('bi-hourglass-split', label('connecting'))
      fetchAndDisplay()
    })
    box.append(btn)
  }
  container.append(box)
}

function renderTrainRow(train) {
  const delay = delayOf(train)
  const scheduled = train.compOrarioPartenza || formatEpochHHMM(train.orarioPartenza) || '—'
  const real = delay !== 0 ? realDepartureTime(train) : null
  const platform = platformOf(train)

  const row = el('div', ['train-row'])
  row.style.setProperty('--cat-color', colorForCategory(train.categoria))

  const platformTile = el('div', ['platform-tile', platform.isLive ? 'is-live' : 'is-planned'], platform.label || '–')
  platformTile.title = platform.label ? `${label('platform')} ${platform.label}` : label('platformUnknown')

  const topRow = el('div', ['train-top'])
  const trainBadge = el('span', ['train-badge'])
  trainBadge.append(icon('bi-train-front'), `${(train.categoria || '').trim()} ${train.numeroTreno}`.trim())
  topRow.append(trainBadge, el('span', ['train-dest'], train.destinazione || '—'))

  const timeRow = el('div', ['train-times'])
  timeRow.append(el('span', ['time-scheduled'], scheduled))

  if (real) {
    const late = delay > 0
    const live = el('span', ['time-live', late ? 'is-late' : 'is-early'])
    live.append(icon('bi-arrow-right-short'), el('strong', [], real))
    const delayText = late ? `+${delay} min` : `${Math.abs(delay)} min ${label('early')}`
    timeRow.append(live, el('span', ['delay-pill', late ? 'is-late' : 'is-early'], delayText))
  } else {
    const ok = el('span', ['delay-pill', 'is-ontime'])
    ok.append(icon('bi-check2-circle'), label('onTime'))
    timeRow.append(ok)
  }

  const details = el('div', ['train-details'])
  details.append(topRow, timeRow)
  row.append(platformTile, details)
  return row
}

function renderGroupCard(group) {
  const card = el('article', ['train-card'])

  const header = el('header', ['train-card-header'])
  header.append(
    icon(GROUP_ICONS[groupByMode]),
    el('span', ['train-card-title'], groupHeaderLabel(groupByMode, group.key))
  )
  card.append(header)

  const list = el('div', ['train-list'])
  group.trains.forEach(train => list.append(renderTrainRow(train)))
  card.append(list)
  return card
}

function displayTrainSchedule(trainData) {
  const groups = buildGroups(trainData)
  if (groups.length === 0) {
    const noData = !trainData.length
    renderMessage(noData ? 'bi-moon-stars' : 'bi-funnel', label(noData ? 'serviceOFF' : 'noMatch'))
    return
  }

  const grid = el('div', ['card-grid', groupByMode === 'train' ? 'is-single' : 'is-multi'])
  groups.forEach(group => grid.append(renderGroupCard(group)))
  $('trainInfo').replaceChildren(grid)
}

function updateHeader() {
  $('currentTime').textContent = formatTime(new Date())
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
    if (lastUpdateData) displayTrainSchedule(lastUpdateData)
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
function rerender() {
  if (lastUpdateData) displayTrainSchedule(lastUpdateData)
}

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

  const searchLink = $('text-search')
  searchLink.title = label('search')
  searchLink.setAttribute('aria-label', label('search'))
  initGroupBySelect()
  initFilter()
  syncStateToURL()

  $('versionNumber').textContent = APP_VERSION
  renderMessage('bi-hourglass-split', label('connecting'))
  updateHeader()
  fetchAndDisplay()

  setInterval(fetchAndDisplay, REFRESH_REQUEST_INTERVAL)
  setInterval(updateHeader, CLOCK_INTERVAL)
})
