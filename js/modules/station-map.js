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
  svg.append(mapNode('title', {}, 'Station layout with the next trains on their tracks'))
  const tracks = layout.tracks || {}
  const numbered = new Set(Object.values(tracks).flatMap(t => t.rails))

  // the platforms first, as quiet strips between the tracks
  layout.platforms.forEach(p => {
    // an island drawn as a closed outline is filled; one drawn as a line is a thick stroke
    const closed = p.pts.length > 3 && Math.hypot(p.pts[0][0] - p.pts[p.pts.length - 1][0], p.pts[0][1] - p.pts[p.pts.length - 1][1]) < 1
    svg.append(mapNode('path', { d: pathOf(p.pts) + (closed ? 'Z' : ''), class: `sm-platform${closed ? ' is-closed' : ''}` }))
  })
  // the rails: the ones that carry a number stand out, the others stay in the background
  layout.rails.filter(r => !numbered.has(r.id)).forEach(r => svg.append(mapNode('path', { d: pathOf(r.pts), class: `sm-rail${r.tunnel ? ' is-tunnel' : ''}${r.siding ? ' is-siding' : ''}` })))
  Object.entries(tracks).forEach(([ref, t]) => {
    const busy = [...placement.slots.values()].some(sl => sl.kind === 'track' && sl.ref === ref)
    t.parts.forEach(pts => svg.append(mapNode('path', { d: pathOf(pts), class: `sm-rail is-track${busy ? ' is-busy' : ''}` })))
    // its number at both ends, so that it can be followed from one side of the station to the other
    const all = t.parts.flat()
    const left = all.reduce((m, q) => (q[0] < m[0] ? q : m), all[0])
    const right = all.reduce((m, q) => (q[0] > m[0] ? q : m), all[0])
    svg.append(mapNode('text', { x: Math.max(6, left[0] - 8), y: left[1] + 4.5, class: `sm-track-no${busy ? ' is-busy' : ''}`, 'text-anchor': left[0] < 24 ? 'start' : 'end' }, ref))
    svg.append(mapNode('text', { x: Math.min(layout.width - 6, right[0] + 8), y: right[1] + 4.5, class: `sm-track-no${busy ? ' is-busy' : ''}`, 'text-anchor': 'start' }, ref))
  })

  // the chips: on their track, nudged down when two would cover each other (a thin line then joins chip and track)
  const items = [...placement.slots.values()].map(slot => {
    const shown = slot.trains.slice(0, CHIPS_PER_PLATFORM)
    const x0 = Math.min(layout.width - (shown.length * (CHIP_W + 8)) - 6, Math.max(6, slot.anchor[0] - (shown.length * (CHIP_W + 8)) / 2 + 4))
    return { slot, shown, x0, x1: x0 + shown.length * (CHIP_W + 8) - 8, y: slot.anchor[1] - CHIP_H / 2, baseY: slot.anchor[1] - CHIP_H / 2 }
  }).sort((a, b) => a.baseY - b.baseY)
  const placed = []
  items.forEach(it => {
    while (placed.some(o => o.x0 < it.x1 + 4 && it.x0 < o.x1 + 4 && Math.abs(o.y - it.y) < CHIP_H + 3)) it.y += CHIP_H + 3
    placed.push(it)
  })
  items.forEach(it => {
    const { slot, shown } = it
    if (Math.abs(it.y - it.baseY) > 4) svg.append(mapNode('line', { x1: slot.anchor[0], y1: slot.anchor[1], x2: slot.anchor[0], y2: it.y + CHIP_H / 2, class: 'sm-leader' }))
    shown.forEach((train, i) => {
      const d = describe(train)
      const x = it.x0 + i * (CHIP_W + 8)
      const y = it.y
      const link = mapNode('a', { href: d.href, class: `sm-chip status-${d.status}${d.atPlatform ? ' is-at' : ''}` })
      link.append(mapNode('title', {}, d.title))
      link.append(mapNode('rect', { x, y, width: CHIP_W, height: CHIP_H, rx: 8, class: 'sm-chip-bg' }))
      link.append(mapNode('rect', { x: x + 4, y: y + 5, width: 3, height: CHIP_H - 10, rx: 1.5, class: 'sm-chip-edge' }))
      link.append(mapNode('text', { x: x + 14, y: y + 18, class: 'sm-chip-time' }, d.time))
      const room = 13
      const dest = d.destination.length > room ? `${d.destination.slice(0, room - 1)}…` : d.destination
      link.append(mapNode('text', { x: x + 58, y: y + 18, class: 'sm-chip-dest' }, dest))
      if (d.delayText) link.append(mapNode('text', { x: x + CHIP_W - 8, y: y + 18, class: 'sm-chip-delay', 'text-anchor': 'end' }, d.delayText))
      svg.append(link)
    })
    if (slot.trains.length > shown.length) {
      svg.append(mapNode('text', { x: Math.min(layout.width - 8, it.x1 + 8), y: it.y + CHIP_H / 2 + 4, class: 'sm-more' }, `+${slot.trains.length - shown.length}`))
    }
  })
  return svg
}
