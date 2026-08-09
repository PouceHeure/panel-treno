// =======================
// Global Constants
// =======================
const APP_VERSION = '1.0.0'
const REFRESH_REQUEST_INTERVAL = 30 * 1000 // ms
const REFRESH_DATE_INTERVAL = 10 * 1000 // ms (only if no data refresh)
const MAX_DEPARTURES_PER_PLATFORM = 3

// =======================
// Global State
// =======================
let stationID = 'S01700' // Default station: Milano Centrale
let stationName = null
let appState = ""
let lastUpdateData = null
let lastUpdateTime = null
let autoRefreshInterval = null
let groupByMode = 'platform'
let groupFilterText = ''

// =======================
// Labels (English only)
// =======================
const LABELS = {
  serviceOFF: 'No departures',
  legend: 'Legend',
  realTime: 'Real Time',
  scheduledTime: 'Scheduled Time',
  waitingConnection: 'Connecting',
  search: 'Search station',
  update: 'Updated',
  station: 'Station',
  departed: 'Departed',
  platform: 'Platform',
  platformUnknown: 'Platform N/A',
  onTime: 'On time',
  scheduled: 'Scheduled',
  real: 'Real',
  train: 'Train',
  groupByPlatform: 'By platform',
  groupByDestination: 'By destination',
  groupByCategory: 'By train type',
  groupByTrain: 'By next departures',
  nextDepartures: 'Next departures',
  destinationUnknown: 'Unknown destination',
  categoryUnknown: 'Unknown type',
  early: 'early',
  filterPlaceholder: 'Filter…'
}

// =======================
// Grouping modes
// =======================
const GROUP_MODES = ['platform', 'destination', 'category', 'train']
const GROUP_ITEM_LIMIT = { platform: 3, destination: 3, category: 3, train: 20 }
const TRAIN_MODE_KEY = 'ALL'
function groupLabelKey(mode) {
  return {
    platform: 'groupByPlatform',
    destination: 'groupByDestination',
    category: 'groupByCategory',
    train: 'groupByTrain'
  }[mode]
}
function getGroupKey(train, mode) {
  if (mode === 'destination') {
    return { key: train.destinazione || getLabel('destinationUnknown'), icon: 'bi-signpost', isRealTime: false }
  }
  if (mode === 'category') {
    const cat = (train.categoria || '').trim()
    return { key: cat || getLabel('categoryUnknown'), icon: 'bi-train-front', isRealTime: false }
  }
  if (mode === 'train') {
    // Ungrouped: a single chronological list of all upcoming trains.
    return { key: TRAIN_MODE_KEY, icon: 'bi-list-ul', isRealTime: false }
  }
  // platform (default)
  const rawPlatform = train.binarioEffettivoPartenzaDescrizione || train.binarioProgrammatoPartenzaDescrizione
  const isRealTime = Boolean(train.binarioEffettivoPartenzaDescrizione)
  return { key: normalizePlatformLabel(rawPlatform) || getLabel('platformUnknown'), icon: 'bi-signpost-2', isRealTime }
}
function groupHeaderLabel(mode, key) {
  if (mode === 'platform') return `${getLabel('platform')} ${key}`
  if (mode === 'train') return getLabel('nextDepartures')
  return key
}
function sortGroupKeys(mode, keys) {
  if (mode === 'platform') {
    return keys.sort((a, b) => {
      const na = parseInt(a, 10)
      const nb = parseInt(b, 10)
      if (isNaN(na) && isNaN(nb)) return a.localeCompare(b)
      if (isNaN(na)) return 1
      if (isNaN(nb)) return -1
      return na - nb
    })
  }
  if (mode === 'train') return keys
  return keys.sort((a, b) => a.localeCompare(b))
}

// Filter applied after aggregation.
// Grouped modes: match the group key text (destination/platform/category).
// Train mode: match against train number, category or destination directly.
function trainMatchesFilter(train, text) {
  const haystack = `${train.categoria || ''} ${train.numeroTreno || ''} ${train.destinazione || ''}`.toLowerCase()
  return haystack.includes(text)
}
function normalizeForCompare(s) {
  return (s || '').toString().toLowerCase()
}

// =======================
// Helpers
// =======================
function getLabel(key) {
  return LABELS[key]
}

// URL Param Helpers
function getStationIDFromURL() {
  return new URLSearchParams(window.location.search).get('stationID')
}
function getStationNameFromURL() {
  return new URLSearchParams(window.location.search).get('stationName')
}
function getHideBarFromURL() {
  return new URLSearchParams(window.location.search).get('hidebar')
}
function getGroupByFromURL() {
  return new URLSearchParams(window.location.search).get('groupby')
}
function getGroupFilterFromURL() {
  return new URLSearchParams(window.location.search).get('groupfilter')
}

// Keep the current groupby/groupfilter choices reflected in the URL (no reload),
// so the page can be copy-pasted/bookmarked with the same view.
function syncStateToURL() {
  const params = new URLSearchParams(window.location.search)
  params.set('groupby', groupByMode)
  if (groupFilterText) {
    params.set('groupfilter', groupFilterText)
  } else {
    params.delete('groupfilter')
  }
  const newURL = `${window.location.pathname}?${params.toString()}${window.location.hash}`
  window.history.replaceState(null, '', newURL)
}

// DOM Helpers
function clearContainer(el) {
  el.innerHTML = ''
}

// Date Helpers
function dateToStringHHMMSS(d) {
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// Category colors (Trenitalia-ish palette)
const CATEGORY_COLORS = {
  FR: '#c8102e',
  FA: '#c8102e',
  FB: '#c8102e',
  ES: '#c8102e',
  EC: '#003d7d',
  EN: '#003d7d',
  IC: '#0a5fa8',
  ICN: '#0a5fa8',
  RV: '#2e8b57',
  REG: '#5a5a5a',
  R: '#5a5a5a',
  default: '#444444'
}
function colorForCategory(cat) {
  return CATEGORY_COLORS[(cat || '').toUpperCase()] || CATEGORY_COLORS.default
}

// Roman numeral helpers (some stations report platforms as "III", "IV", ...)
const ROMAN_VALUES = { M: 1000, CM: 900, D: 500, CD: 400, C: 100, XC: 90, L: 50, XL: 40, X: 10, IX: 9, V: 5, IV: 4, I: 1 }
function romanToArabic(str) {
  let i = 0, result = 0
  const s = str.toUpperCase()
  const keys = Object.keys(ROMAN_VALUES)
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
function normalizePlatformLabel(label) {
  if (!label) return null
  const trimmed = label.trim()
  const match = trimmed.match(/^([MDCLXVI]+)(.*)$/i)
  if (match && match[1].length > 0) {
    const arabic = romanToArabic(match[1])
    if (arabic) return `${arabic}${match[2]}`.trim()
  }
  return trimmed
}

// Time helpers
function formatEpochHHMM(epochMs) {
  if (!epochMs) return null
  return new Date(epochMs).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}
function realDepartureTime(train) {
  const ritardo = typeof train.ritardo === 'number' ? train.ritardo : 0
  if (!train.orarioPartenza) return null
  return formatEpochHHMM(train.orarioPartenza + ritardo * 60000)
}

// =======================
// UI Updates
// =======================
function hideBar() {
  document.getElementById("searchLegendContainer").style.display = "none"
}

function initGroupBySelect() {
  const select = document.getElementById('groupBySelect')
  select.innerHTML = ''
  GROUP_MODES.forEach(mode => {
    const opt = document.createElement('option')
    opt.value = mode
    opt.textContent = getLabel(groupLabelKey(mode))
    if (mode === groupByMode) opt.selected = true
    select.appendChild(opt)
  })
  select.addEventListener('change', () => {
    groupByMode = select.value
    groupFilterText = ''
    const filterInput = document.getElementById('groupFilterInput')
    filterInput.value = ''
    filterInput.placeholder = getLabel('filterPlaceholder')
    syncStateToURL()
    if (lastUpdateData) displayTrainSchedule(lastUpdateData)
  })
}

function initFilterToggle() {
  const toggle = document.getElementById('filterToggle')
  const wrap = document.getElementById('filterWrap')
  const input = document.getElementById('groupFilterInput')

  toggle.addEventListener('click', () => {
    const expanding = !wrap.classList.contains('expanded')
    wrap.classList.toggle('expanded', expanding)
    if (expanding) input.focus()
  })
  input.addEventListener('blur', () => {
    if (!input.value) wrap.classList.remove('expanded')
  })
  if (input.value) wrap.classList.add('expanded')
}

function initGroupFilterInput() {
  const filterInput = document.getElementById('groupFilterInput')
  filterInput.placeholder = getLabel('filterPlaceholder')

  const paramGroupFilter = getGroupFilterFromURL()
  if (paramGroupFilter) {
    filterInput.value = paramGroupFilter
    groupFilterText = normalizeForCompare(paramGroupFilter)
  }

  filterInput.addEventListener('input', () => {
    groupFilterText = normalizeForCompare(filterInput.value.trim())
    syncStateToURL()
    if (lastUpdateData) displayTrainSchedule(lastUpdateData)
  })
}

function updateHeadText() {
  const legendContainer = document.getElementById('legend')
  legendContainer.innerHTML = `
    <span class="d-flex align-items-center gap-1">
      <i class="bi bi-broadcast-pin text-primary"></i> ${getLabel('realTime')}
    </span>
    <span class="d-flex align-items-center gap-1">
      <i class="bi bi-clock text-secondary"></i> ${getLabel('scheduledTime')}
    </span>
  `
  appState = getLabel('waitingConnection')
}

function updateDateRefresh(d) {
  document.getElementById('updateDate').textContent = `${getLabel('update')}: ${dateToStringHHMMSS(d)}`
}

function updateDateAndNameStation() {
  const currentTimeStr = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit'
  })

  let title, siteName
  if (stationName) {
    const stationWorld = getLabel('station')
    title = `${currentTimeStr} - ${stationWorld}: ${stationName}`
    siteName = `Train: ${stationName}`
  } else {
    title = `${currentTimeStr} - ${appState}`
    siteName = appState
  }

  document.getElementById('currentTime').textContent = title
  document.title = siteName

  syncHeaderSpacerHeight()
}

// Keep the spacer under the fixed header exactly as tall as the header itself,
// since its height varies with font size and station name length/wrapping.
function syncHeaderSpacerHeight() {
  const header = document.querySelector('.app-header')
  const spacer = document.querySelector('.app-header-spacer')
  if (!header || !spacer) return
  spacer.style.height = `${header.offsetHeight}px`
}

// =======================
// Auto Refresh
// =======================
function toggleAutoRefresh(isEnabled) {
  if (isEnabled) {
    if (!autoRefreshInterval) {
      autoRefreshInterval = setInterval(fetchAndDisplayTrainSchedule, REFRESH_REQUEST_INTERVAL)
    }
  } else {
    setInterval(updateDateAndNameStation, REFRESH_DATE_INTERVAL)
    clearInterval(autoRefreshInterval)
    autoRefreshInterval = null
  }
}

// =======================
// Data Fetching
// =======================
async function fetchAndDisplayTrainSchedule() {
  const url = `http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/partenze/${stationID}/${encodeURIComponent(nowAsViaggiaTrenoDate())}`

  try {
    const data = await fetchViaProxy(url)
    const now = new Date()
    const empty = !Array.isArray(data) || data.length === 0

    if (!empty) {
      updateDateRefresh(now)
      lastUpdateTime = now
      lastUpdateData = data
    } else if (lastUpdateData) {
      data = lastUpdateData
    }

    if (empty && !lastUpdateData) {
      clearContainer(document.getElementById('trainInfo'))
      appState = getLabel('serviceOFF')
    } else {
      displayTrainSchedule(data)
    }
  } catch (err) {
    console.error('Error fetching data:', err)
  }
  updateDateAndNameStation()
}

// =======================
// Rendering
// =======================
function displayTrainSchedule(trainData) {
  const container = document.getElementById('trainInfo')
  clearContainer(container)

  const departures = trainData
    .filter(t => !t.nonPartito || t.orarioPartenza)
    .sort((a, b) => (a.orarioPartenza || 0) - (b.orarioPartenza || 0))

  if (departures.length === 0) {
    const empty = document.createElement('div')
    empty.classList.add('text-muted', 'fst-italic', 'text-center', 'w-100')
    empty.textContent = getLabel('serviceOFF')
    container.appendChild(empty)
    return
  }

  // Group according to the selected mode
  const groups = new Map()
  departures.forEach(train => {
    const { key, icon, isRealTime } = getGroupKey(train, groupByMode)
    if (!groups.has(key)) groups.set(key, { icon, isRealTime, trains: [] })
    const group = groups.get(key)
    if (isRealTime) group.isRealTime = true
    group.trains.push(train)
  })

  let sortedKeys = sortGroupKeys(groupByMode, Array.from(groups.keys()))

  // Apply the post-aggregation filter
  if (groupFilterText) {
    if (groupByMode === 'train') {
      const group = groups.get(TRAIN_MODE_KEY)
      if (group) group.trains = group.trains.filter(t => trainMatchesFilter(t, groupFilterText))
    } else {
      sortedKeys = sortedKeys.filter(key => normalizeForCompare(key).includes(groupFilterText))
    }
  }

  if (sortedKeys.length === 0 || (groupByMode === 'train' && groups.get(TRAIN_MODE_KEY)?.trains.length === 0)) {
    const empty = document.createElement('div')
    empty.classList.add('text-muted', 'fst-italic', 'text-center', 'w-100')
    empty.textContent = getLabel('serviceOFF')
    container.appendChild(empty)
    return
  }

  const row = document.createElement('div')
  if (groupByMode === 'train') {
    row.classList.add('row', 'g-3', 'row-cols-1', 'justify-content-center')
  } else {
    row.classList.add('row', 'g-3', 'row-cols-1', 'row-cols-md-2', 'row-cols-xl-3', 'row-cols-xxl-4')
  }
  container.appendChild(row)

  sortedKeys.forEach(key => {
    const group = groups.get(key)
    const nextTrains = group.trains.slice(0, GROUP_ITEM_LIMIT[groupByMode] ?? 3)

    // Card
    const col = document.createElement('div')
    col.classList.add('col')
    row.appendChild(col)

    const card = document.createElement('div')
    card.classList.add('card', 'shadow', 'h-100', 'train-card', 'transition-soft')
    col.appendChild(card)

    // Header (group)
    const header = document.createElement('div')
    header.classList.add('card-header', 'text-white', 'train-card-header', 'd-flex', 'align-items-center')
    header.style.setProperty('--line-color', CATEGORY_COLORS.default)

    const headerWrap = document.createElement('div')
    headerWrap.classList.add('d-flex', 'align-items-center', 'justify-content-center', 'gap-2', 'w-100', 'train-card-header-title')

    const groupIcon = document.createElement('i')
    groupIcon.classList.add('bi', group.isRealTime ? 'bi-broadcast-pin' : group.icon)

    const groupLabel = document.createElement('span')
    groupLabel.classList.add('station-title', 'fw-bold', 'text-truncate')
    groupLabel.textContent = groupHeaderLabel(groupByMode, key)

    headerWrap.append(groupIcon, groupLabel)
    header.appendChild(headerWrap)
    card.appendChild(header)

    // Body: up to 3 next trains
    const body = document.createElement('div')
    body.classList.add('card-body', 'pt-3')
    card.appendChild(body)

    const list = document.createElement('div')
    list.classList.add('list-group', 'list-group-flush')

    nextTrains.forEach(train => {
      const ritardo = typeof train.ritardo === 'number' ? train.ritardo : 0
      const scheduled = train.compOrarioPartenza || formatEpochHHMM(train.orarioPartenza) || '—'
      const real = ritardo !== 0 ? realDepartureTime(train) : null

      const item = document.createElement('div')
      item.classList.add('list-group-item', 'py-2')

      const topRow = document.createElement('div')
      topRow.classList.add('d-flex', 'align-items-center', 'justify-content-between', 'gap-2')

      const trainBadge = document.createElement('span')
      trainBadge.classList.add('badge', 'rounded-pill', 'd-inline-flex', 'align-items-center', 'gap-1', 'text-white')
      trainBadge.style.backgroundColor = colorForCategory(train.categoria)
      const trainIcon = document.createElement('i')
      trainIcon.classList.add('bi', 'bi-train-front')
      const trainLabel = `${(train.categoria || '').trim()} ${train.numeroTreno}`.trim()
      trainBadge.append(trainIcon, document.createTextNode(trainLabel))

      const destination = document.createElement('span')
      destination.classList.add('fw-bold', 'text-truncate', 'flex-grow-1')
      destination.textContent = train.destinazione || '—'

      const rawPlatform = train.binarioEffettivoPartenzaDescrizione || train.binarioProgrammatoPartenzaDescrizione
      const platformIsRealTime = Boolean(train.binarioEffettivoPartenzaDescrizione)
      const platformLabel = normalizePlatformLabel(rawPlatform)

      const platformBadge = document.createElement('span')
      platformBadge.classList.add('badge', 'rounded-pill', 'd-inline-flex', 'align-items-center', 'gap-1', platformIsRealTime ? 'bg-primary' : 'bg-secondary', 'bg-opacity-75')
      const platformIcon = document.createElement('i')
      platformIcon.classList.add('bi', platformIsRealTime ? 'bi-broadcast-pin' : 'bi-signpost-2')
      platformBadge.append(platformIcon, document.createTextNode(platformLabel || getLabel('platformUnknown')))

      topRow.append(trainBadge, destination, platformBadge)

      const bottomRow = document.createElement('div')
      bottomRow.classList.add('d-flex', 'align-items-center', 'gap-2', 'mt-1', 'time-row')

      // Scheduled time: plain, always shown, struck through when a live time replaces it.
      const scheduledWrap = document.createElement('span')
      scheduledWrap.classList.add('time-scheduled')
      if (real) scheduledWrap.classList.add('time-scheduled-superseded')
      const scheduledIcon = document.createElement('i')
      scheduledIcon.classList.add('bi', 'bi-clock')
      scheduledWrap.append(scheduledIcon, document.createTextNode(scheduled))
      bottomRow.appendChild(scheduledWrap)

      // Real/live time (or on-time confirmation): compact colored badge.
      const liveBadge = document.createElement('span')
      liveBadge.classList.add('badge', 'rounded-pill', 'd-inline-flex', 'align-items-center', 'gap-1')
      const liveIcon = document.createElement('i')

      if (real) {
        liveBadge.classList.add(ritardo > 0 ? 'bg-danger' : 'bg-success')
        liveIcon.classList.add('bi', 'bi-broadcast-pin')
        const delayText = ritardo > 0 ? `+${ritardo}′` : `-${Math.abs(ritardo)}′`
        liveBadge.append(liveIcon, document.createTextNode(`${real} (${delayText})`))
      } else {
        liveBadge.classList.add('bg-primary')
        liveIcon.classList.add('bi', 'bi-check2-circle')
        liveBadge.append(liveIcon, document.createTextNode(getLabel('onTime')))
      }
      bottomRow.appendChild(liveBadge)

      item.append(topRow, bottomRow)
      list.appendChild(item)
    })

    body.appendChild(list)
  })
}

// =======================
// Events
// =======================
window.addEventListener('pageshow', e => { if (e.persisted) window.location.reload(true) })
window.addEventListener('resize', syncHeaderSpacerHeight)

// =======================
// DOM Ready Init
// =======================
document.addEventListener('DOMContentLoaded', () => {
  const paramStationID = getStationIDFromURL()
  if (paramStationID) stationID = paramStationID

  const paramStationName = getStationNameFromURL()
  if (paramStationName) stationName = paramStationName

  const paramHideBar = getHideBarFromURL()
  if (paramHideBar != null && paramHideBar.toLowerCase() == 'true') {
    hideBar()
  }

  const paramGroupBy = getGroupByFromURL()
  if (paramGroupBy && GROUP_MODES.includes(paramGroupBy.toLowerCase())) {
    groupByMode = paramGroupBy.toLowerCase()
  }

  const searchLink = document.getElementById("text-search")
  searchLink.title = getLabel("search")
  searchLink.setAttribute("aria-label", getLabel("search"))
  initGroupBySelect()
  initGroupFilterInput()
  initFilterToggle()
  syncStateToURL()

  toggleAutoRefresh(true)
  fetchAndDisplayTrainSchedule()
  updateHeadText()

  document.getElementById('versionNumber').textContent = APP_VERSION
  updateDateAndNameStation()
})
