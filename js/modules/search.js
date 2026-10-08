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
    timeout = setTimeout(() => fn(...args), delay)
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
  nameEl.append(icon, ` ${name}`)
  const extraEl = document.createElement('small')
  extraEl.textContent = extra
  link.append(nameEl, extraEl)
  return link
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

async function searchStations(keyword, requestId) {
  const text = await fetchViaProxy(`${API}autocompletaStazione/${encodeURIComponent(keyword)}`, { asJSON: false })
  if (requestId !== latestRequest) return
  const stations = text.split('\n').map(line => line.trim().split('|')).filter(([name, id]) => name && id)
  if (!stations.length) return showMessage(LABELS.noresult, 'result-error')
  $('results').replaceChildren(...stations.map(([name, id]) =>
    resultLink(recentHref(stationRecent(id, name)), name, id, 'bi-geo-alt')))
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
  $('major').replaceChildren(head, ...MAJOR_STATIONS.map(([name, id]) =>
    resultLink(recentHref(stationRecent(id, name)), name, 'station', 'bi-building')))
}

function renderEmpty() {
  latestRequest++
  $('results').replaceChildren()
  $('major').hidden = false
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
    e.type === 'train' ? 'train' : 'station',
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
  form.addEventListener('input', debounce(doSearch, TIME_BETWEEN_REQ_ACCEPTABLE))
  form.addEventListener('submit', doSearch)

  renderMajor()
  setMode('station')
})
