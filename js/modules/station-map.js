// The station map: loading the layout, and drawing the trains on it. The geometry itself is in station-topology.js.
// Map data (c) OpenStreetMap contributors, ODbL.
// public Overpass servers: often at capacity, so several are tried in turn
const OVERPASS_URLS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']
const TOPOLOGY_CACHE_PREFIX = 'panelTreno.topology.'
const TOPOLOGY_CACHE_DAYS = 30
const TOPOLOGY_CACHE_KEEP = 3 // stations kept in localStorage: a layout is a few tens of KB

// The layout of a station: the file shipped in data/topology/, else what this browser kept, else a live Overpass query.
// Resolves { ways, source }; rejects with a readable message.
async function loadStationWays(code, lat, lon) {
  try {
    const r = await fetch(`data/topology/${code}.json`)
    if (r.ok) return { ways: (await r.json()).ways, source: 'shipped' }
  } catch { /* no file for this station: try the next source */ }
  try {
    const cached = JSON.parse(localStorage.getItem(TOPOLOGY_CACHE_PREFIX + code))
    if (cached && Date.now() - cached.at < TOPOLOGY_CACHE_DAYS * 86400000) return { ways: cached.ways, source: 'cached' }
  } catch { /* unreadable cache: ignore it */ }
  if (typeof lat !== 'number' || typeof lon !== 'number') throw new Error('This station has no coordinates.')
  let last = 'no server answered'
  for (const url of OVERPASS_URLS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 40000)
    try {
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: overpassQuery(lat, lon, 320) }), signal: controller.signal })
      if (!r.ok) { last = `HTTP ${r.status}`; continue }
      const ways = waysFromOverpass((await r.json()).elements)
      rememberTopology(code, ways)
      return { ways, source: 'live' }
    } catch (err) {
      last = err.name === 'AbortError' ? 'too slow' : 'no answer' // a busy server often answers without the headers a browser needs
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`The OpenStreetMap servers are busy (${last}). Try again in a minute, or use the board.`)
}

function rememberTopology(code, ways) {
  try {
    localStorage.setItem(TOPOLOGY_CACHE_PREFIX + code, JSON.stringify({ at: Date.now(), ways }))
    const keys = Object.keys(localStorage).filter(k => k.startsWith(TOPOLOGY_CACHE_PREFIX))
    if (keys.length > TOPOLOGY_CACHE_KEEP) {
      const dated = keys.map(k => [k, (JSON.parse(localStorage.getItem(k)) || {}).at || 0]).sort((a, b) => a[1] - b[1])
      dated.slice(0, keys.length - TOPOLOGY_CACHE_KEEP).forEach(([k]) => localStorage.removeItem(k))
    }
  } catch { /* storage full or unavailable: the layout is simply fetched again next time */ }
}

const MAP_NS = 'http://www.w3.org/2000/svg'
function mapNode(tag, attrs = {}, text) {
  const node = document.createElementNS(MAP_NS, tag)
  Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v))
  if (text !== undefined) node.textContent = text
  return node
}
const pathOf = pts => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')

const CHIP_W = 158
const CHIP_H = 26
const CHIPS_PER_PLATFORM = 3

// describe(train) -> { time, destination, delayText, status: 'ok'|'slight'|'late'|'cancelled', href, atPlatform, title }
function drawStationMap(layout, placement, describe) {
  const svg = mapNode('svg', { viewBox: `0 0 ${layout.width} ${layout.height}`, class: 'sm-svg', role: 'img' })
  svg.append(mapNode('title', {}, 'Station layout with the next trains on their platforms'))

  layout.rails.forEach(r => svg.append(mapNode('path', { d: pathOf(r.pts), class: `sm-rail${r.tunnel ? ' is-tunnel' : ''}${r.siding ? ' is-siding' : ''}` })))

  // one label per platform number, on its longest drawn way
  const labelled = new Set()
  const ordered = [...layout.platforms].sort((a, b) => b.length - a.length)
  layout.platforms.forEach(p => {
    const busy = placement.onPlatform.has(p.id)
    // an island drawn as a closed outline is filled; one drawn as a line is a thick stroke
    const closed = p.pts.length > 3 && Math.hypot(p.pts[0][0] - p.pts[p.pts.length - 1][0], p.pts[0][1] - p.pts[p.pts.length - 1][1]) < 1
    svg.append(mapNode('path', { d: pathOf(p.pts) + (closed ? 'Z' : ''), class: `sm-platform${busy ? ' is-busy' : ''}${closed ? ' is-closed' : ''}` }))
  })
  ordered.forEach(p => {
    const key = p.refs.join('·')
    if (!key || labelled.has(key)) return
    labelled.add(key)
    const x = Math.max(8, p.left[0] - 14)
    svg.append(mapNode('text', { x, y: p.left[1] + 5, class: 'sm-label', 'text-anchor': p.left[0] < 60 ? 'start' : 'end' }, p.refs.join(' · ')))
  })

  const platformById = new Map(layout.platforms.map(p => [p.id, p]))
  placement.onPlatform.forEach((trains, id) => {
    const p = platformById.get(id)
    const shown = trains.slice(0, CHIPS_PER_PLATFORM)
    shown.forEach((train, i) => {
      const d = describe(train)
      const cx = p.centre[0] + (i - (shown.length - 1) / 2) * (CHIP_W + 8)
      const x = Math.min(layout.width - CHIP_W - 6, Math.max(6, cx - CHIP_W / 2))
      const y = p.centre[1] - CHIP_H / 2
      const link = mapNode('a', { href: d.href, class: `sm-chip status-${d.status}${d.atPlatform ? ' is-at' : ''}` })
      link.append(mapNode('title', {}, d.title))
      link.append(mapNode('rect', { x, y, width: CHIP_W, height: CHIP_H, rx: 8, class: 'sm-chip-bg' }))
      link.append(mapNode('rect', { x: x + 4, y: y + 5, width: 3, height: CHIP_H - 10, rx: 1.5, class: 'sm-chip-edge' }))
      link.append(mapNode('text', { x: x + 14, y: y + 18.5, class: 'sm-chip-time' }, d.time))
      const room = 13
      const dest = d.destination.length > room ? `${d.destination.slice(0, room - 1)}…` : d.destination
      link.append(mapNode('text', { x: x + 58, y: y + 18.5, class: 'sm-chip-dest' }, dest))
      if (d.delayText) link.append(mapNode('text', { x: x + CHIP_W - 8, y: y + 18.5, class: 'sm-chip-delay', 'text-anchor': 'end' }, d.delayText))
      svg.append(link)
    })
    if (trains.length > shown.length) {
      svg.append(mapNode('text', { x: Math.min(layout.width - 8, p.centre[0] + ((shown.length) / 2) * (CHIP_W + 8) + 8), y: p.centre[1] + 4, class: 'sm-more' }, `+${trains.length - shown.length}`))
    }
  })
  return svg
}

