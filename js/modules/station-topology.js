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
function layoutTopology(topology, { width = 1100, pad = 28, rowGap = 46, margin = 60, marginY = 14 } = {}) {
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
  // rows: one per platform centre across the tracks; spread them when they are tighter than a label
  // (a platform drawn in several pieces counts once)
  const groups = new Map()
  platforms.forEach((p, i) => {
    const key = p.refs.join('/') || `#${p.id}`
    groups.set(key, (groups.get(key) || []).concat(platR[i]))
  })
  const centres = [...groups.values()].map(pts => centroid(pts)[1]).sort((a, b) => a - b)
  let minGap = Infinity
  for (let i = 1; i < centres.length; i++) if (centres[i] - centres[i - 1] > 2) minGap = Math.min(minGap, (centres[i] - centres[i - 1]) * scale)
  const stretch = Number.isFinite(minGap) ? Math.min(3.2, Math.max(1, rowGap / minGap)) : 1
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
  return { width, height, scale: scale * 1, stretch, platforms: outPlatforms, rails: outRails }
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

// Puts trains on the platforms: Map(platform id -> trains), and the trains that could not be placed.
function placeTrains(layout, trains, platformOf) {
  const onPlatform = new Map()
  const unplaced = []
  trains.forEach(train => {
    const platform = findPlatform(layout, platformOf(train))
    if (!platform) { unplaced.push(train); return }
    if (!onPlatform.has(platform.id)) onPlatform.set(platform.id, [])
    onPlatform.get(platform.id).push(train)
  })
  return { onPlatform, unplaced }
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
  module.exports = { splitRefs, platformToken, topologyFromWays, layoutTopology, findPlatform, placeTrains, overpassQuery, waysFromOverpass, trackAngle }
}
