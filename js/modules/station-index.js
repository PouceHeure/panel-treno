// Station search that runs in the browser, on data/stations.json (code -> [lat, lon, name]): instant, with no
// request per letter and no dependency on the relays. It forgives accents, case, small typos and initials
// ("genova pp" finds Genova Piazza Principe).
let stationIndex = null
let stationIndexLoading = null

function normalizeText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// Resolves with the index, or null when the file cannot be loaded (the caller falls back to the network search).
function loadStationIndex() {
  if (stationIndex) return Promise.resolve(stationIndex)
  if (!stationIndexLoading) {
    stationIndexLoading = fetch('data/stations.json')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(book => {
        stationIndex = Object.entries(book)
          .filter(([, v]) => v && v[2])
          .map(([id, v]) => {
            const norm = normalizeText(v[2])
            return { id, name: v[2], norm, words: norm.split(' ') }
          })
        return stationIndex
      })
      .catch(() => null)
  }
  return stationIndexLoading
}

// Edit distance, only worth computing between short words.
function withinOneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let edits = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    if (++edits > 1) return false
    if (a.length > b.length) i++
    else if (a.length < b.length) j++
    else { i++; j++ }
  }
  return edits + (a.length - i) + (b.length - j) <= 1
}

// How well one query word matches the words of a station that no other query word has used; null: no match.
function scoreToken(token, words, used) {
  let best = null
  words.forEach((word, i) => {
    if (used.has(i)) return
    let score = null
    if (word === token) score = 3
    else if (word.startsWith(token)) score = 2.2
    else if (token.length >= 3 && word.includes(token)) score = 1
    else if (token.length >= 4 && [0, 1, -1].some(d => withinOneEdit(token, word.slice(0, token.length + d)))) score = 0.8 // a typo, a missing or an extra letter
    if (score !== null && (!best || score > best.score)) best = { score, at: [i] }
  })
  // initials of the words still free: "pp" for "piazza principe"
  if (token.length >= 2) {
    const free = words.map((w, i) => [w, i]).filter(([, i]) => !used.has(i))
    for (let from = 0; from + token.length <= free.length; from++) {
      const run = free.slice(from, from + token.length)
      if (run.every(([w], k) => w[0] === token[k]) && (!best || 1.5 > best.score)) best = { score: 1.5, at: run.map(([, i]) => i) }
    }
  }
  return best
}

// boost(id) lets the caller favour favourites and recent stations.
function searchLocalStations(query, { limit = 8, boost = () => 0 } = {}) {
  if (!stationIndex) return []
  const norm = normalizeText(query)
  if (!norm) return []
  const tokens = norm.split(' ')
  const results = []
  stationIndex.forEach(station => {
    const used = new Set()
    let total = 0
    for (const token of tokens) {
      const m = scoreToken(token, station.words, used)
      if (!m) return
      total += m.score
      m.at.forEach(i => used.add(i))
    }
    if (station.norm.startsWith(norm)) total += 3
    total += boost(station.id) - station.norm.length * 0.01
    results.push({ id: station.id, name: station.name, score: total })
  })
  return results.sort((a, b) => b.score - a.score).slice(0, limit)
}

if (typeof module !== 'undefined') {
  module.exports = { normalizeText, searchLocalStations, setStationIndexForTests: book => {
    stationIndex = Object.entries(book).filter(([, v]) => v && v[2]).map(([id, v]) => {
      const norm = normalizeText(v[2])
      return { id, name: v[2], norm, words: norm.split(' ') }
    })
  } }
}
