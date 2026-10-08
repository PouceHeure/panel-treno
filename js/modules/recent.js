// Recently opened stations and trains, kept in this browser only (localStorage).
const RECENT_KEY = 'panelTreno.recent'
const RECENT_MAX = 8

function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function rememberRecent(entry) {
  try {
    const list = loadRecent().filter(e => e.key !== entry.key)
    list.unshift(entry)
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)))
  } catch { /* storage unavailable (private mode, blocked): recents are a convenience only */ }
}

function clearRecent() {
  try { localStorage.removeItem(RECENT_KEY) } catch { /* nothing to clear */ }
}

function stationRecent(id, name) {
  return { key: `s:${id}`, type: 'station', id, name: name || id }
}
function trainRecent(number, from, date, name) {
  return { key: `t:${number}-${date}`, type: 'train', number, from, date, name }
}

function recentHref(entry) {
  if (entry.type === 'train') {
    return `index.html?${new URLSearchParams({ view: 'train', train: entry.number, from: entry.from, date: entry.date })}`
  }
  return `index.html?${new URLSearchParams({ stationID: entry.id, stationName: entry.name })}`
}
