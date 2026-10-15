// Home page: find a station by name or a train by number.
const TIME_BETWEEN_REQ_ACCEPTABLE = 300 // ms
const API = 'http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno/'

const LABELS = {
  title: 'Panel Treno',
  noresult: 'No result',
  failed: 'Search failed',
  btnsearch: 'Search',
  placeholderStation: 'e.g. Milano Centrale',
  placeholderTrain: 'Train number, e.g. 9431',
  recent: 'Recent',
  major: 'Major stations',
  clear: 'Clear',
  favorites: 'Favorites',
  following: 'Following',
  unfollow: 'Stop following',
  addFavorite: 'Add to favorites',
  removeFavorite: 'Remove from favorites',
  trainHint: 'Type the full train number (REG, FR, IC… prefixes are ignored).'
}

const MAJOR_STATIONS = [
  ['MILANO CENTRALE', 'S01700'],
  ['GENOVA PIAZZA PRINCIPE', 'S04700'],
  ['TORINO PORTA NUOVA', 'S00219'],
  ['ROMA TERMINI', 'S08409']
]

let mode = 'station' // 'station' | 'train'
let latestRequest = 0

const $ = id => document.getElementById(id)

function debounce(fn, delay) {
  let timeout
  return (...args) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => fn(...args), typeof delay === 'function' ? delay() : delay)
  }
}

function showMessage(text, className) {
  const message = document.createElement('p')
  message.className = className
  message.textContent = text
  $('results').replaceChildren(message)
}

// Search results are untrusted text: build nodes with textContent, never innerHTML.
function resultLink(href, name, extra, iconName) {
  const link = document.createElement('a')
  link.className = 'result-item'
  link.href = href
  const nameEl = document.createElement('strong')
  const icon = document.createElement('i')
  icon.className = `bi ${iconName}`
  nameEl.append(icon, ` ${niceName(name)}`)
  const extraEl = document.createElement('small')
  extraEl.textContent = extra
  link.append(nameEl, extraEl)
  return link
}

// A station as a row: the link opens its board, the star keeps it in the favourites.
function stationRow(id, name, extra = '', iconName = 'bi-geo-alt') {
  const row = document.createElement('div')
  row.className = 'result-row'
  const star = document.createElement('button')
  star.type = 'button'
  star.className = 'star-btn'
  const paint = () => {
    const on = isFavorite(id)
    star.classList.toggle('is-on', on)
    star.setAttribute('aria-pressed', String(on))
    star.setAttribute('aria-label', on ? LABELS.removeFavorite : LABELS.addFavorite)
    star.title = star.getAttribute('aria-label')
    star.replaceChildren(Object.assign(document.createElement('i'), { className: `bi ${on ? 'bi-star-fill' : 'bi-star'}` }))
  }
  star.addEventListener('click', () => { toggleFavorite(id, name); paint(); renderFavorites(); renderMajor() })
  paint()
  row.append(resultLink(recentHref(stationRecent(id, name)), name, extra, iconName), star)
  return row
}

function setMode(next) {
  mode = next
  $('tabStation').classList.toggle('is-active', mode === 'station')
  $('tabTrain').classList.toggle('is-active', mode === 'train')
  $('tabStation').setAttribute('aria-selected', String(mode === 'station'))
  $('tabTrain').setAttribute('aria-selected', String(mode === 'train'))
  $('searchInput').placeholder = mode === 'train' ? LABELS.placeholderTrain : LABELS.placeholderStation
  $('searchInput').inputMode = mode === 'train' ? 'numeric' : 'text'
  renderEmpty()
}

// "9431", "FR 9431", "REG12072" -> the digits; null when there is nothing to search.
function trainNumberFrom(text) {
  const match = text.match(/^[A-Za-z]{0,4}\s*(\d{1,6})$/)
  return match ? match[1] : null
}

// The local index answers at once; the network search is the fallback when it is unavailable or finds nothing.
async function searchStations(keyword, requestId) {
  const index = await loadStationIndex()
  if (requestId !== latestRequest) return
  if (index) {
    const favorites = new Set(loadFavorites().map(f => f.id))
    const recents = new Set(loadRecent().filter(e => e.type === 'station').map(e => e.id))
    const found = searchLocalStations(keyword, { boost: id => (favorites.has(id) ? 2 : recents.has(id) ? 1 : 0) })
    if (found.length) return $('results').replaceChildren(...found.map(r => stationRow(r.id, r.name, '')))
  }
  const text = await fetchViaProxy(`${API}autocompletaStazione/${encodeURIComponent(keyword)}`, { asJSON: false })
  if (requestId !== latestRequest) return
  const stations = text.split('\n').map(line => line.trim().split('|')).filter(([name, id]) => name && id)
  if (!stations.length) return showMessage(LABELS.noresult, 'result-error')
  $('results').replaceChildren(...stations.map(([name, id]) => stationRow(id, name, id)))
}

async function searchTrains(keyword, requestId) {
  const number = trainNumberFrom(keyword)
  if (!number) return showMessage(LABELS.trainHint, 'result-hint')
  const text = await fetchViaProxy(`${API}cercaNumeroTrenoTrenoAutocomplete/${number}`, { asJSON: false })
  if (requestId !== latestRequest) return
  // "9431 - VENEZIA S.LUCIA - 08/10/26|9431-S02593-1791410400000"
  const trains = text.split('\n').map(line => line.trim()).filter(line => line.includes('|')).map(line => {
    const [label, key] = line.split('|')
    const [num, from, date] = key.split('-')
    const [, origin = '', day = ''] = label.split(' - ')
    return { num, from, date, origin: origin.trim(), day: day.trim() }
  }).filter(t => t.num && t.from && t.date)
  if (!trains.length) return showMessage(LABELS.noresult, 'result-error')
  $('results').replaceChildren(...trains.map(t => {
    const entry = trainRecent(t.num, t.from, t.date, `${t.num} · from ${t.origin}`)
    return resultLink(recentHref(entry), `Train ${t.num} · from ${t.origin}`, t.day, 'bi-train-front')
  }))
}

async function doSearch(e) {
  if (e) e.preventDefault()
  const keyword = $('searchInput').value.trim()
  if (!keyword) return renderEmpty()
  // Typing a train number on the Stations tab switches to Trains by itself.
  if (mode === 'station' && trainNumberFrom(keyword) && /\d{2,}/.test(keyword)) setMode('train')
  $('recent').hidden = true
  $('major').hidden = true
  $('favorites').hidden = true
  $('following').hidden = true
  const requestId = ++latestRequest
  try {
    if (mode === 'train') await searchTrains(keyword, requestId)
    else await searchStations(keyword, requestId)
  } catch (err) {
    if (requestId !== latestRequest) return
    console.error(err)
    showMessage(`${LABELS.failed}: ${describeProxyReport(lastProxyReport) || err.message}`, 'result-error')
  }
}

// With an empty field the page shows what was opened recently.
function renderMajor() {
  const head = document.createElement('div')
  head.className = 'recent-head'
  const title = document.createElement('span')
  title.textContent = LABELS.major
  head.append(title)
  const grid = document.createElement('div')
  grid.className = 'major-grid'
  grid.append(...MAJOR_STATIONS.filter(([, id]) => !isFavorite(id)).map(([name, id]) => stationRow(id, name, '', 'bi-building')))
  head.hidden = !grid.children.length
  $('major').replaceChildren(head, grid)
}

function renderFavorites() {
  const list = loadFavorites()
  const box = $('favorites')
  box.hidden = list.length === 0 || mode !== 'station' || !!$('searchInput').value.trim()
  if (box.hidden) return
  const head = document.createElement('div')
  head.className = 'recent-head'
  const title = document.createElement('span')
  title.textContent = LABELS.favorites
  head.append(title)
  const grid = document.createElement('div')
  grid.className = 'major-grid'
  grid.append(...list.map(f => stationRow(f.id, f.name, '', 'bi-star-fill')))
  box.replaceChildren(head, grid)
}

// The pinned train, with its estimated arrival: what most people open the app for.
function summarizeTrain(d, now) {
  const stops = d.fermate || []
  if (!stops.length) return null
  const lastIndex = stops.length - 1
  const base = { label: `${(d.categoria || '').trim()} ${d.numeroTreno}`.trim(), destination: d.destinazione || stops[lastIndex].stazione, delay: d.ritardo || 0 }
  if (d.provvedimento === 1) return { ...base, state: 'Cancelled' }
  const lastPassed = stops.reduce((last, f, i) => (f.actualFermataType === 1 ? i : last), -1)
  if (d.arrivato || lastPassed >= lastIndex) return { ...base, state: 'Arrived' }
  const here = stops[Math.max(lastPassed, 0)]
  const inStation = lastPassed >= 0 && !here.partenzaReale
  const pred = predictStopTimes(stops, d.ritardo || 0, lastPassed, { inStation, cls: trainClass(d), nowMs: now })
  const nextIndex = Math.max(lastPassed, 0) + 1
  const final = pred.get(lastIndex)
  const next = pred.get(nextIndex)
  return {
    ...base,
    state: lastPassed < 0 ? 'Not departed yet' : inStation ? `In ${niceName(here.stazione)}` : 'Running',
    arrivalMs: final ? final.arrMs : null,
    nextName: stops[nextIndex].stazione,
    nextMs: next ? next.arrMs : null
  }
}

const clockOf = ms => new Date(ms).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
const minutesUntil = ms => Math.max(0, Math.round((ms - Date.now()) / 60000))
let followingTimer = null

async function renderFollowing() {
  clearInterval(followingTimer)
  const box = $('following')
  const pinned = loadPinned()
  box.hidden = !pinned || mode !== 'station' || !!$('searchInput').value.trim()
  if (!pinned) return
  const head = document.createElement('div')
  head.className = 'recent-head'
  const title = document.createElement('span')
  title.textContent = LABELS.following
  const stop = document.createElement('button')
  stop.type = 'button'
  stop.className = 'recent-clear'
  stop.textContent = LABELS.unfollow
  stop.addEventListener('click', () => { clearPinned(); renderEmpty() })
  head.append(title, stop)
  const card = document.createElement('div')
  card.className = 'follow-card'
  card.textContent = pinned.name || `Train ${pinned.number}`
  box.replaceChildren(head, card)

  const refresh = async () => {
    try {
      const d = await fetchViaProxy(`${API}andamentoTreno/${pinned.from}/${pinned.number}/${pinned.date}`)
      logPredictions(d)
      const sum = summarizeTrain(d, Date.now())
      if (!sum) return
      const href = recentHref(trainRecent(pinned.number, pinned.from, pinned.date, pinned.name))
      const top = document.createElement('div')
      top.className = 'follow-top'
      const name = document.createElement('strong')
      name.textContent = `${sum.label} → ${niceName(sum.destination)}`
      const chip = document.createElement('span')
      chip.className = `follow-chip ${sum.delay >= 5 ? 'is-late' : sum.delay > 0 ? 'is-slight' : 'is-ok'}`
      chip.textContent = sum.delay > 0 ? `+${sum.delay} min` : sum.state === 'Cancelled' ? 'Cancelled' : 'On time'
      top.append(name, chip)
      const big = document.createElement('div')
      big.className = 'follow-big'
      big.textContent = sum.arrivalMs ? `Arrives ${clockOf(sum.arrivalMs)}` : sum.state
      const sub = document.createElement('div')
      sub.className = 'follow-sub'
      sub.textContent = [sum.arrivalMs ? sum.state : '', sum.nextMs ? `next: ${niceName(sum.nextName)} in ${minutesUntil(sum.nextMs)} min` : '', `updated ${clockOf(Date.now())}`].filter(Boolean).join(' · ')
      const links = document.createElement('div')
      links.className = 'follow-links'
      ;[['Now', `${href}&tab=now`], ['Route', `${href}&tab=route`], ['Charts', `${href}&tab=charts`]].forEach(([text, url]) => {
        const a = document.createElement('a')
        a.className = 'route-open'
        a.href = url
        a.textContent = text
        links.append(a)
      })
      card.replaceChildren(top, big, sub, links)
    } catch (err) {
      card.textContent = `${pinned.name || `Train ${pinned.number}`} · ${describeProxyReport(lastProxyReport) || err.message}`
    }
  }
  refresh()
  followingTimer = setInterval(() => { if (!document.hidden && !$('following').hidden) refresh() }, 30000)
}

function renderEmpty() {
  latestRequest++
  $('results').replaceChildren()
  $('major').hidden = false
  $('favorites').hidden = mode !== 'station' || loadFavorites().length === 0
  $('following').hidden = !loadPinned()
  if (!$('favorites').hidden) renderFavorites()
  renderFollowing()
  const recent = $('recent')
  const list = loadRecent()
  recent.hidden = list.length === 0
  if (!list.length) return

  const head = document.createElement('div')
  head.className = 'recent-head'
  const title = document.createElement('span')
  title.textContent = LABELS.recent
  const clear = document.createElement('button')
  clear.type = 'button'
  clear.className = 'recent-clear'
  clear.textContent = LABELS.clear
  clear.addEventListener('click', () => { clearRecent(); renderEmpty() })
  head.append(title, clear)

  const items = list.map(e => resultLink(
    recentHref(e),
    e.name,
    '',
    e.type === 'train' ? 'bi-train-front' : 'bi-geo-alt'
  ))
  recent.replaceChildren(head, ...items)
}

document.addEventListener('DOMContentLoaded', () => {
  $('btn-search').textContent = LABELS.btnsearch
  $('title').textContent = LABELS.title
  $('tabStation').addEventListener('click', () => { setMode('station'); doSearch() })
  $('tabTrain').addEventListener('click', () => { setMode('train'); doSearch() })

  const form = $('searchForm')
  // the local station search needs no pause between letters; the network searches do
  form.addEventListener('input', debounce(doSearch, () => (mode === 'station' && stationIndex ? 80 : TIME_BETWEEN_REQ_ACCEPTABLE)))
  form.addEventListener('submit', doSearch)

  loadStationIndex()
  renderMajor()
  setMode('station')
})
