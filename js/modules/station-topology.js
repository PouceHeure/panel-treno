// The track layout of a station, from OpenStreetMap, and what it takes to put trains on it.
// Pure functions (no DOM): the drawing lives in js/modules/station-map.js.
//
// A layout comes from `ways`: [{ id, tags, pts: [[lat, lon], ...] }], the platform and rail ways around the station
// (data/topology/<code>.json, or a live Overpass query). The tracks have no number in OpenStreetMap, the platforms
// do ("12;13" is an island serving tracks 12 and 13), so trains are placed on platforms.

const M_PER_DEG_LAT = 110540
const M_PER_DEG_LON = 111320

function splitRefs(ref) {
  return String(ref || '')
    .split(/[;,/]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
}

// "11", "1 Ovest", "14 TRONCO", "3 EST" -> "11", "1", "14", "3": the number the platform is known by.
function platformToken(label) {
  const match = String(label || '').trim().toUpperCase().match(/^[0-9]+[A-Z]?|^[IVX]+(?![A-Z])/)
  return match ? match[0] : ''
}

// A platform for trains: not a metro, tram or bus platform that happens to be tagged railway=platform too.
function isPlatformWay(way) {
  const t = way.tags || {}
  if (!(t.railway === 'platform' || (t.public_transport === 'platform' && t.railway))) return false
  if (t.train === 'yes') return true
  return !(t.subway === 'yes' || t.tram === 'yes' || t.light_rail === 'yes' || t.bus === 'yes' || t.highway)
}

// "12", "3A", "IV": what a track number looks like. Long numbers are identifiers of something else.
const isTrackRef = ref => /^(\d{1,2}[A-Z]?|[IVX]{1,4})$/.test(ref)

function isRailWay(way) {
  return (way.tags || {}).railway === 'rail'
}

function topologyFromWays(ways) {
  const platforms = []
  const rails = []
  ;(ways || []).forEach(way => {
    if (!way.pts || way.pts.length < 2) return
    const t = way.tags || {}
    if (isPlatformWay(way)) {
      platforms.push({ id: way.id, refs: splitRefs(t.ref || t.local_ref).filter(isTrackRef), name: t.name || '', pts: way.pts })
    } else if (isRailWay(way)) {
      rails.push({ id: way.id, pts: way.pts, tunnel: t.tunnel === 'yes' || Number(t.layer) < 0, siding: !!t.service })
    }
  })
  return { platforms, rails }
}

// Projects lat/lon to meters around (lat0, lon0).
function toMeters(lat, lon, lat0, lon0) {
  return [(lon - lon0) * Math.cos((lat0 * Math.PI) / 180) * M_PER_DEG_LON, (lat - lat0) * M_PER_DEG_LAT]
}

function centroid(points) {
  const n = points.length
  return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n]
}

// The direction the tracks run in (radians), from the rails close to the platforms, length weighted.
function trackAngle(railsMeters) {
  let sxx = 0
  let sxy = 0
  railsMeters.forEach(pts => {
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0]
      const dy = pts[i][1] - pts[i - 1][1]
      const len = Math.hypot(dx, dy)
      if (!len) continue
      // doubled angle, so that a direction and its opposite add up instead of cancelling
      sxx += len * ((dx * dx - dy * dy) / (len * len))
      sxy += len * ((2 * dx * dy) / (len * len))
    }
  })
  return 0.5 * Math.atan2(sxy, sxx)
}

// Lays the station out on a width x ? canvas: tracks horizontal, north is not kept. When the platforms are too close
// to hold a label each, the drawing is stretched across the tracks (a schematic, not a survey).
function layoutTopology(topology, { width = 1100, pad = 28, rowGap = 46, trackRowGap = 30, margin = 60, marginY = 14 } = {}) {
  const { rails } = topology
  if (!topology.platforms.length) return null
  let platforms = topology.platforms
  // a platform far from the rest (another station of the same name, a metro tunnel) would stretch the whole drawing
  const med = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]
  const centres0 = platforms.map(p => centroid(p.pts))
  const mLat = med(centres0.map(c => c[0]))
  const mLon = med(centres0.map(c => c[1]))
  const kept = platforms.filter((p, i) => Math.hypot(...toMeters(centres0[i][0], centres0[i][1], mLat, mLon)) <= 320)
  if (!kept.length) return null
  platforms = kept
  const all = platforms.flatMap(p => p.pts)
  const [lat0, lon0] = centroid(all)
  const meters = pts => pts.map(([la, lo]) => toMeters(la, lo, lat0, lon0))
  const platM = platforms.map(p => meters(p.pts))
  // rails near the platforms only: the lines running away to the horizon would decide the angle
  const box = platM.flat().reduce((b, [x, y]) => ({ x0: Math.min(b.x0, x), x1: Math.max(b.x1, x), y0: Math.min(b.y0, y), y1: Math.max(b.y1, y) }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity })
  const near = ([x, y]) => x > box.x0 - margin && x < box.x1 + margin && y > box.y0 - margin && y < box.y1 + margin
  const railM = rails.map(r => ({ r, m: meters(r.pts) })).filter(({ m }) => m.some(near))
  const theta = trackAngle(railM.map(({ m }) => m))
  const cos = Math.cos(-theta)
  const sin = Math.sin(-theta)
  const rot = ([x, y]) => [x * cos - y * sin, x * sin + y * cos]
  const platR = platM.map(pts => pts.map(rot))
  const railR = railM.map(({ r, m }) => ({ ...r, m: m.map(rot) }))

  // the frame: the platforms, plus a margin
  const bb = platR.flat().reduce((b, [x, y]) => ({ x0: Math.min(b.x0, x), x1: Math.max(b.x1, x), y0: Math.min(b.y0, y), y1: Math.max(b.y1, y) }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity })
  const spanX = Math.max(bb.x1 - bb.x0, 30) + 2 * margin
  const scale = (width - 2 * pad) / spanX
  const groups = new Map()
  platforms.forEach((p, i) => {
    const key = p.refs.join('/') || `#${p.id}`
    groups.set(key, (groups.get(key) || []).concat(platR[i]))
  })
  const platformGap = () => {
    const centres = [...groups.values()].map(pts => centroid(pts)[1]).sort((a, b) => a - b)
    let g = Infinity
    for (let i = 1; i < centres.length; i++) if (centres[i] - centres[i - 1] > 2) g = Math.min(g, (centres[i] - centres[i - 1]) * scale)
    return g
  }

  // the drawing for a given stretch across the tracks
  const make = stretch => {
    const px = ([x, y]) => [pad + (x - bb.x0 + margin) * scale, pad + (y - bb.y0 + marginY) * scale * stretch]
    const height = Math.round(pad * 2 + (bb.y1 - bb.y0 + 2 * marginY) * scale * stretch)
    const outPlatforms = platforms.map((p, i) => {
      const pts = platR[i].map(px)
      const c = centroid(pts)
      // its axis: the two points furthest apart
      let a = pts[0]
      let b = pts[pts.length - 1]
      let best = 0
      for (let u = 0; u < pts.length; u++) for (let v = u + 1; v < pts.length; v++) {
        const d = Math.hypot(pts[u][0] - pts[v][0], pts[u][1] - pts[v][1])
        if (d > best) { best = d; a = pts[u]; b = pts[v] }
      }
      return { id: p.id, refs: p.refs, name: p.name, pts, centre: c, length: best, left: a[0] <= b[0] ? a : b, right: a[0] <= b[0] ? b : a }
    })
    const outRails = railR.map(r => ({ id: r.id, tunnel: r.tunnel, siding: r.siding, pts: r.m.map(px) }))
    const layout = { width, height, scale, stretch, platforms: outPlatforms, rails: outRails }
    layout.tracks = assignTracks(layout)
    return layout
  }

  // first at true proportions: the tracks found there tell how far apart they must be drawn to hold a train each
  const first = make(1)
  const trackGaps = Object.values(first.tracks).map(t => t.anchor[1]).sort((u, v) => u - v)
  let minTrackGap = Infinity
  for (let i = 1; i < trackGaps.length; i++) if (trackGaps[i] - trackGaps[i - 1] > 3) minTrackGap = Math.min(minTrackGap, trackGaps[i] - trackGaps[i - 1])
  const need = Number.isFinite(minTrackGap) ? trackRowGap / minTrackGap : rowGap / platformGap()
  const stretch = Number.isFinite(need) ? Math.min(3.2, Math.max(1, need)) : 1
  return stretch === 1 ? first : make(stretch)
}

// y of a polyline at x (the polyline runs roughly left to right); null outside its span
function yAtX(pts, x, nearY) {
  let best = null
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1]
    const [x2, y2] = pts[i]
    if ((x - x1) * (x - x2) > 0 || x1 === x2) continue
    const y = y1 + ((x - x1) / (x2 - x1)) * (y2 - y1)
    if (best === null || Math.abs(y - nearY) < Math.abs(best - nearY)) best = y
  }
  return best
}

const pathLength = pts => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0)

// Numbers the tracks. A platform lists the tracks it serves ("12;13"), and the rail on each of its sides is one of
// them; numbers increase across the station in one direction, found from the platforms themselves.
// Every piece of every platform votes for the rails beside it; a track is kept only when its rail is not claimed by
// another number, so that a train is never put on a wrong track. Trains of the others stay on their platform.
// Returns { '13': { rail, rails: [ids], parts: [polylines], pts, anchor: [x, y], platform } }.
function assignTracks(layout, { reach = 62, minPiece = 40 } = {}) {
  const candidates = layout.rails.filter(r => !r.tunnel && r.pts.length > 1)
  const sideRails = platform => {
    // sample the platform along its length and vote for the closest rail above and below it
    const votes = { up: new Map(), down: new Map() }
    const [x0, x1] = [platform.left[0], platform.right[0]]
    const steps = Math.max(4, Math.round((x1 - x0) / 14))
    for (let i = 0; i <= steps; i++) {
      const x = x0 + ((x1 - x0) * i) / steps
      const y = yAtX(platform.pts, x, platform.centre[1])
      if (y === null) continue
      let up = null
      let down = null
      // the rails at this x; a siding drawn right over another rail is the same track drawn twice
      const here = []
      candidates.forEach(r => {
        const ry = yAtX(r.pts, x, y)
        if (ry !== null) here.push({ id: r.id, ry, siding: r.siding })
      })
      here.filter(r => !r.siding || !here.some(o => !o.siding && Math.abs(o.ry - r.ry) < 10)).forEach(r => {
        const d = r.ry - y
        if (d < -3 && d > -reach && (!up || d > up.d)) up = { id: r.id, d }
        if (d > 3 && d < reach && (!down || d < down.d)) down = { id: r.id, d }
      })
      if (up) votes.up.set(up.id, (votes.up.get(up.id) || 0) + 1)
      if (down) votes.down.set(down.id, (votes.down.get(down.id) || 0) + 1)
    }
    const top = m => [...m.entries()].sort((a, b) => b[1] - a[1])[0]
    const u = top(votes.up)
    const d = top(votes.down)
    return { up: u && u[1] >= 2 ? u[0] : null, down: d && d[1] >= 2 ? d[0] : null }
  }
  const byId = new Map(layout.rails.map(r => [r.id, r]))
  const numeric = ref => parseInt(ref, 10)
  const pieces = layout.platforms.filter(p => p.refs.length && p.length >= minPiece && p.refs.every(r => /^\d+/.test(r)))

  // direction of the numbering across the station: numbers grow downwards on the drawing, or upwards
  const meanRef = pieces.reduce((acc, p) => acc + numeric(p.refs[0]), 0) / (pieces.length || 1)
  const meanY = pieces.reduce((acc, p) => acc + p.centre[1], 0) / (pieces.length || 1)
  const down = pieces.reduce((acc, p) => acc + (numeric(p.refs[0]) - meanRef) * (p.centre[1] - meanY) * p.length, 0) >= 0

  // the votes: ref -> rail -> weight (the length of the platform piece that pointed at it)
  const claims = new Map()
  const claim = (ref, railId, piece) => {
    if (!railId || !byId.has(railId)) return
    if (!claims.has(ref)) claims.set(ref, new Map())
    const m = claims.get(ref)
    const cur = m.get(railId) || { weight: 0, piece: null }
    cur.weight += piece.length
    if (!cur.piece || piece.length > cur.piece.length) cur.piece = piece
    m.set(railId, cur)
  }
  pieces.forEach(p => {
    const sides = sideRails(p)
    const refs = [...p.refs].sort((a, b) => numeric(a) - numeric(b))
    if (refs.length === 2) {
      claim(down ? refs[0] : refs[1], sides.up, p)
      claim(down ? refs[1] : refs[0], sides.down, p)
    } else if (refs.length === 1) {
      // an edge platform serves one track, on the side that has a rail
      claim(refs[0], sides.up && sides.down ? (down ? sides.down : sides.up) : sides.up || sides.down, p)
    }
  })

  // a rail belongs to one number: when two numbers want it, the heavier claim keeps it
  const winners = new Map()
  claims.forEach((rails, ref) => {
    const [railId, c] = [...rails.entries()].sort((a, b) => b[1].weight - a[1].weight)[0]
    const taken = winners.get(railId)
    if (!taken || c.weight > taken.weight) winners.set(railId, { ref, weight: c.weight })
  })
  const tracks = {}
  claims.forEach((rails, ref) => {
    const ranked = [...rails.entries()].sort((a, b) => b[1].weight - a[1].weight)
    const [railId, c] = ranked[0]
    if (winners.get(railId).ref !== ref) return
    // the other rails this number also pointed at are further pieces of the same track
    const parts = ranked.filter(([id, v], i) => !i || (v.weight >= 0.25 * c.weight && (!winners.get(id) || winners.get(id).ref === ref))).map(([id]) => byId.get(id))
    const rail = byId.get(railId)
    const piece = c.piece
    const xs = rail.pts.map(q => q[0])
    const x = Math.min(Math.max(piece.centre[0], Math.min(...xs)), Math.max(...xs))
    const y = yAtX(rail.pts, x, piece.centre[1])
    if (y === null) return
    tracks[ref] = { rail: railId, rails: parts.map(r => r.id), parts: parts.map(r => r.pts), pts: rail.pts, anchor: [x, y], platform: piece.id }
  })
  return tracks
}

// Which platform (a drawn one) a ViaggiaTreno platform label belongs to; several drawn ways can carry the same
// number, the longest one wins.
function findPlatform(layout, label) {
  const token = platformToken(label)
  if (!layout || !token) return null
  const matches = layout.platforms.filter(p => p.refs.includes(token))
  if (!matches.length) return null
  return matches.reduce((best, p) => (p.length > best.length ? p : best))
}

// The track a ViaggiaTreno platform label ("13", "1 Ovest") names, when it was found on the map.
function findTrack(layout, label) {
  const token = platformToken(label)
  return layout && token && layout.tracks && layout.tracks[token] ? { ref: token, ...layout.tracks[token] } : null
}

// Puts trains where they are: on their track when it is known, else on their platform. Returns the slots
// (Map(key -> { key, kind, ref, anchor: [x, y], trains })) and the trains that could not be placed.
function placeTrains(layout, trains, platformOf) {
  const slots = new Map()
  const unplaced = []
  const add = (key, kind, ref, anchor, train) => {
    if (!slots.has(key)) slots.set(key, { key, kind, ref, anchor, trains: [] })
    slots.get(key).trains.push(train)
  }
  trains.forEach(train => {
    const label = platformOf(train)
    const track = findTrack(layout, label)
    if (track) return add(`t${track.ref}`, 'track', track.ref, track.anchor, train)
    const platform = findPlatform(layout, label)
    if (platform) return add(`p${platform.id}`, 'platform', platform.refs.join(' · '), platform.centre, train)
    unplaced.push(train)
  })
  return { slots, unplaced }
}

// The Overpass question for a station; the answer is turned into ways by waysFromOverpass().
function overpassQuery(lat, lon, radius = 320) {
  const around = `(around:${radius},${lat},${lon})`
  return `[out:json][timeout:60];(way${around}[railway=platform];way${around}[public_transport=platform][railway];way${around}[railway=rail];);out geom tags;`
}

function waysFromOverpass(elements) {
  const keep = ['railway', 'public_transport', 'ref', 'local_ref', 'name', 'layer', 'tunnel', 'service']
  return (elements || [])
    .filter(e => e.type === 'way' && e.geometry && e.geometry.length > 1)
    .map(e => ({
      id: e.id,
      tags: Object.fromEntries(Object.entries(e.tags || {}).filter(([k]) => keep.includes(k))),
      pts: e.geometry.map(g => [g.lat, g.lon])
    }))
}

if (typeof module !== 'undefined') {
  module.exports = { splitRefs, platformToken, topologyFromWays, layoutTopology, findPlatform, findTrack, assignTracks, placeTrains, overpassQuery, waysFromOverpass, trackAngle }
}
